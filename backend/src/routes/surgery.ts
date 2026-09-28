import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { asyncHandler, HttpError } from "../middleware/errorHandler";
import { requireAuth, currentUser } from "../middleware/auth";
import { requirePermission, notFound } from "../middleware/rbac";
import { writeAudit } from "../lib/audit";
import { withCode, CodePrefix } from "../lib/codes";
import { emitTo, roomFor } from "../socket";
import { getSettingNumber } from "../lib/settings-catalog";
import { consumeServiceMaterials } from "../lib/material-consumption";
import {
  AuditAction,
  ActivityType,
  AnesthesiaType,
  AppointmentType,
  ConsentStatus,
  ContractStatus,
  CustomerStatus,
  FunnelStage,
  PhotoStage,
  PRE_OP_CHECKLIST,
  ProcedureStatus,
} from "../types/enums";

// Lịch phòng mổ — màn "Phòng mổ · Lịch mổ".
//
// Điểm nghiệp vụ quan trọng: KHÔNG xác nhận được ca mổ khi checklist tiền phẫu
// chưa đủ. Bảy mục checklist được TÍNH TỰ ĐỘNG từ dữ liệu thật (đã cọc bao
// nhiêu, đã ký cam kết chưa, đã chụp ảnh trước mổ chưa) chứ không phải để nhân
// viên tự tích — tự tích thì checklist chỉ là hình thức.

const router = Router();
router.use(requireAuth);

/**
 * Tỉ lệ cọc tối thiểu để được xác nhận ca. Đọc từ Cài đặt hệ thống thay vì
 * hằng số, vì đây là chính sách kinh doanh — chủ đầu tư đổi được mà không cần
 * lập trình viên.
 */
async function minDepositRatio(): Promise<number> {
  return (await getSettingNumber("surgery.minDepositPercent")) / 100;
}

const procedureInclude = {
  customer: { select: { id: true, name: true, code: true, phone: true } },
  surgeon: { select: { id: true, name: true, title: true } },
  room: { select: { id: true, name: true, code: true } },
  service: { select: { id: true, name: true } },
  contract: { select: { id: true, code: true, total: true, paidAmount: true, status: true } },
} as const;

export interface ChecklistResult {
  items: Array<{ label: string; ok: boolean; detail?: string }>;
  missing: number;
  ready: boolean;
}

/**
 * Chấm 7 mục checklist tiền phẫu từ dữ liệu thật.
 * Ba mục cuối chưa có nguồn dữ liệu tự động ở Giai đoạn 1 (xét nghiệm tiền
 * phẫu, khám tiền mê, vật tư theo lô thuộc Giai đoạn 2) nên lấy từ cột
 * `checklist` do bác sĩ tự xác nhận, và ghi rõ điều đó trong `detail`.
 */
export async function evaluateChecklist(procedureId: string): Promise<ChecklistResult> {
  const proc = await prisma.procedureRecord.findUnique({
    where: { id: procedureId },
    include: { contract: true },
  });
  if (!proc) throw notFound("Không tìm thấy ca mổ");

  const manual: boolean[] = (() => {
    try {
      const parsed = JSON.parse(proc.checklist ?? "[]");
      return Array.isArray(parsed) ? parsed.map(Boolean) : [];
    } catch {
      return [];
    }
  })();

  const [consent, photoSet] = await Promise.all([
    prisma.consentForm.findFirst({
      where: {
        customerId: proc.customerId,
        branchId: proc.branchId,
        status: ConsentStatus.SIGNED,
        OR: [{ procedureId: proc.id }, { procedureId: null }],
      },
    }),
    prisma.photoSet.findFirst({
      where: { customerId: proc.customerId, branchId: proc.branchId, stage: PhotoStage.PRE_OP },
    }),
  ]);

  const ratio = await minDepositRatio();
  const depositOk = proc.contract
    ? proc.contract.paidAmount >= Math.ceil(proc.contract.total * ratio)
    : false;

  const items = [
    {
      label: PRE_OP_CHECKLIST[0],
      ok: depositOk,
      detail: proc.contract
        ? `Đã thu ${proc.contract.paidAmount.toLocaleString("vi-VN")}đ / cần tối thiểu ${Math.ceil(proc.contract.total * ratio).toLocaleString("vi-VN")}đ`
        : "Ca mổ chưa gắn hợp đồng",
    },
    { label: PRE_OP_CHECKLIST[1], ok: Boolean(consent), detail: consent ? undefined : "Chưa có cam kết đã ký" },
    { label: PRE_OP_CHECKLIST[2], ok: manual[2] ?? false, detail: "Bác sĩ xác nhận thủ công (Giai đoạn 2 nối tự động)" },
    {
      label: PRE_OP_CHECKLIST[3],
      ok: proc.anesthesia === AnesthesiaType.GENERAL ? (manual[3] ?? false) : true,
      detail: proc.anesthesia === AnesthesiaType.GENERAL ? undefined : "Không mê toàn thân — không bắt buộc",
    },
    { label: PRE_OP_CHECKLIST[4], ok: Boolean(photoSet), detail: photoSet ? undefined : "Chưa có bộ ảnh trước mổ" },
    { label: PRE_OP_CHECKLIST[5], ok: manual[5] ?? false, detail: "Điều dưỡng xác nhận đã dặn khách" },
    { label: PRE_OP_CHECKLIST[6], ok: manual[6] ?? false, detail: "Kho xác nhận thủ công (Giai đoạn 2 nối tồn kho theo lô)" },
  ];

  const missing = items.filter((i) => !i.ok).length;
  return { items, missing, ready: missing === 0 };
}

// GET /api/procedures?date=&roomId=&surgeonId=
router.get(
  "/",
  requirePermission("surgery_schedule.read"),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const from = req.query.from ? new Date(String(req.query.from)) : new Date();
    const start = new Date(from.getFullYear(), from.getMonth(), from.getDate());
    const end = req.query.to
      ? new Date(String(req.query.to))
      : new Date(start.getTime() + 24 * 3600 * 1000);

    const procedures = await prisma.procedureRecord.findMany({
      where: {
        branchId: { in: me.branchIds },
        scheduledAt: { gte: start, lt: end },
        ...(req.query.roomId ? { roomId: String(req.query.roomId) } : {}),
        ...(req.query.surgeonId ? { surgeonId: String(req.query.surgeonId) } : {}),
        ...(req.query.customerId ? { customerId: String(req.query.customerId) } : {}),
      },
      orderBy: { scheduledAt: "asc" },
      include: procedureInclude,
    });

    // Checklist chấm cho từng ca để lưới lịch tô đúng màu "đủ / thiếu điều kiện".
    const withChecklist = await Promise.all(
      procedures.map(async (p) => {
        const checklist = await evaluateChecklist(p.id);
        return { ...p, checklistMissing: checklist.missing, checklistReady: checklist.ready };
      })
    );

    const totalMinutes = procedures.reduce((s, p) => s + p.durationMin, 0);
    res.json({
      items: withChecklist,
      stats: {
        count: procedures.length,
        totalHours: Math.round((totalMinutes / 60) * 10) / 10,
        notReady: withChecklist.filter((p) => !p.checklistReady).length,
      },
    });
  })
);

router.get(
  "/:id/checklist",
  requirePermission("surgery_schedule.read"),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const proc = await prisma.procedureRecord.findUnique({ where: { id: req.params.id } });
    if (!proc || !me.branchIds.includes(proc.branchId)) throw notFound();
    res.json(await evaluateChecklist(proc.id));
  })
);

const procedureSchema = z.object({
  customerId: z.string().uuid(),
  branchId: z.string().uuid().optional(),
  contractId: z.string().uuid().optional(),
  serviceId: z.string().uuid().optional(),
  title: z.string().min(2),
  roomId: z.string().uuid().optional(),
  surgeonId: z.string().uuid().optional(),
  teamNote: z.string().optional(),
  materialNote: z.string().optional(),
  anesthesia: z.nativeEnum(AnesthesiaType).optional(),
  scheduledAt: z.coerce.date(),
  durationMin: z.number().int().positive().optional(),
});

/**
 * POST /api/procedures — xếp ca mổ.
 * Chỉ xếp được cho khách ĐÃ CHỐT và có hợp đồng hiệu lực (quy tắc trong
 * prototype), và phòng mổ phải trống — có chèn 30 phút dọn phòng giữa hai ca.
 */
async function cleanupMinutes(): Promise<number> {
  return getSettingNumber("surgery.cleanupMinutes");
}

router.post(
  "/",
  requirePermission("surgery_schedule.create"),
  asyncHandler(async (req, res) => {
    const body = procedureSchema.parse(req.body);
    const me = currentUser(req);
    const branchId = body.branchId ?? me.activeBranchId;
    if (!branchId || !me.branchIds.includes(branchId)) throw notFound();

    const contract = body.contractId
      ? await prisma.contract.findUnique({ where: { id: body.contractId } })
      : await prisma.contract.findFirst({
          where: {
            customerId: body.customerId,
            status: { in: [ContractStatus.SIGNED, ContractStatus.IN_PROGRESS] },
          },
          orderBy: { createdAt: "desc" },
        });

    if (!contract) {
      throw new HttpError(400, "Chỉ xếp ca mổ cho khách đã có hợp đồng hiệu lực");
    }
    if (contract.status === ContractStatus.CANCELLED) {
      throw new HttpError(400, "Hợp đồng đã bị huỷ");
    }

    const durationMin = body.durationMin ?? 60;
    const cleanup = await cleanupMinutes();
    const endAt = new Date(body.scheduledAt.getTime() + (durationMin + cleanup) * 60000);

    if (body.roomId) {
      // Ca nào bắt đầu trước khi ca mới kết thúc (đã cộng giờ dọn phòng) và
      // kết thúc sau khi ca mới bắt đầu thì bị chồng.
      const sameRoom = await prisma.procedureRecord.findMany({
        where: {
          roomId: body.roomId,
          status: { notIn: [ProcedureStatus.CANCELLED] },
          scheduledAt: { lt: endAt },
        },
      });
      const clash = sameRoom.find(
        (p) =>
          new Date(p.scheduledAt.getTime() + (p.durationMin + cleanup) * 60000) > body.scheduledAt
      );
      if (clash) {
        throw new HttpError(
          409,
          `Phòng đã có ca lúc ${clash.scheduledAt.toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" })} (đã tính ${cleanup} phút dọn phòng)`
        );
      }
    }

    const procedure = await withCode(CodePrefix.PROCEDURE, (code) =>
      prisma.procedureRecord.create({
        data: {
          ...body,
          code,
          branchId,
          contractId: contract.id,
          durationMin,
          anesthesia: body.anesthesia ?? AnesthesiaType.LOCAL,
          checklist: JSON.stringify(new Array(PRE_OP_CHECKLIST.length).fill(false)),
        },
        include: procedureInclude,
      })
    );

    await writeAudit({
      req,
      action: AuditAction.CREATE,
      entity: "ProcedureRecord",
      entityId: procedure.id,
      branchId,
      summary: `Xếp ca mổ ${procedure.code}: ${procedure.title} cho ${procedure.customer.name}`,
    });

    emitTo(roomFor.branch(branchId), "appointment:created", procedure);
    res.status(201).json(procedure);
  })
);

router.patch(
  "/:id",
  requirePermission("surgery_schedule.update"),
  asyncHandler(async (req, res) => {
    const body = procedureSchema
      .partial()
      .omit({ customerId: true, branchId: true })
      .extend({ checklist: z.array(z.boolean()).optional(), report: z.string().optional() })
      .parse(req.body);

    const me = currentUser(req);
    const before = await prisma.procedureRecord.findUnique({ where: { id: req.params.id } });
    if (!before || !me.branchIds.includes(before.branchId)) throw notFound();

    const { checklist, ...rest } = body;
    const procedure = await prisma.procedureRecord.update({
      where: { id: req.params.id },
      data: { ...rest, ...(checklist ? { checklist: JSON.stringify(checklist) } : {}) },
      include: procedureInclude,
    });
    res.json(procedure);
  })
);

/**
 * POST /api/procedures/:id/status
 * CONFIRMED chỉ đi được khi checklist đủ. COMPLETED sẽ tự chuyển khách sang
 * "Đã phẫu thuật" và mở giai đoạn hậu phẫu.
 */
router.post(
  "/:id/status",
  requirePermission("surgery_schedule.update"),
  asyncHandler(async (req, res) => {
    const body = z
      .object({ status: z.nativeEnum(ProcedureStatus), report: z.string().optional(), reason: z.string().optional() })
      .parse(req.body);

    const me = currentUser(req);
    const before = await prisma.procedureRecord.findUnique({ where: { id: req.params.id } });
    if (!before || !me.branchIds.includes(before.branchId)) throw notFound();

    if (body.status === ProcedureStatus.CONFIRMED) {
      const checklist = await evaluateChecklist(before.id);
      if (!checklist.ready) {
        throw new HttpError(
          400,
          `Còn ${checklist.missing} mục checklist tiền phẫu chưa đạt — chưa xác nhận được ca mổ`
        );
      }
    }

    if (body.status === ProcedureStatus.COMPLETED && !body.report) {
      throw new HttpError(400, "Kết thúc mổ bắt buộc ghi tường trình phẫu thuật");
    }
    if (
      (body.status === ProcedureStatus.CANCELLED || body.status === ProcedureStatus.POSTPONED) &&
      !body.reason
    ) {
      throw new HttpError(400, "Huỷ hoặc dời ca bắt buộc ghi lý do");
    }

    const procedure = await prisma.procedureRecord.update({
      where: { id: before.id },
      data: {
        status: body.status,
        ...(body.report ? { report: body.report } : {}),
        ...(body.status === ProcedureStatus.IN_PROGRESS ? { startedAt: new Date() } : {}),
        ...(body.status === ProcedureStatus.COMPLETED ? { finishedAt: new Date() } : {}),
      },
      include: procedureInclude,
    });

    if (body.status === ProcedureStatus.COMPLETED) {
      // TỰ ĐỘNG TRỪ VẬT TƯ theo định mức của dịch vụ. Làm ở đây thay vì bắt
      // điều dưỡng nhập tay: nhập tay là chỗ sai số lớn nhất, và bỏ sót thì
      // vừa lệch tồn kho vừa mất dấu truy vết lô.
      const consumed = await consumeServiceMaterials({
        procedureId: procedure.id,
        serviceId: procedure.service?.id ?? null,
        customerId: procedure.customerId,
        branchId: procedure.branchId,
        actorId: me.id,
      });

      await prisma.customer.update({
        where: { id: procedure.customerId },
        data: {
          stage: FunnelStage.PT,
          status: CustomerStatus.POST_OP,
          activities: {
            create: {
              type: ActivityType.PROCEDURE,
              content: `Kết thúc ca mổ ${procedure.code} — ${procedure.title}. Giai đoạn: Đã chốt → Đã phẫu thuật`,
              userId: me.id,
              userName: me.name,
            },
          },
        },
      });

      // Sinh lịch tái khám N1 / N7 / T1 / T3 ngay khi mổ xong.
      const followUps: Array<{ label: string; days: number }> = [
        { label: "Tái khám N1", days: 1 },
        { label: "Tái khám N7 (cắt chỉ)", days: 7 },
        { label: "Tái khám T1", days: 30 },
        { label: "Tái khám T3", days: 90 },
      ];
      for (const f of followUps) {
        const startAt = new Date(Date.now() + f.days * 86400000);
        startAt.setHours(9, 0, 0, 0);
        await prisma.appointment.create({
          data: {
            branchId: procedure.branchId,
            customerId: procedure.customerId,
            type: AppointmentType.FOLLOW_UP,
            title: `${f.label} — ${procedure.title}`,
            doctorId: procedure.surgeonId,
            startAt,
            endAt: new Date(startAt.getTime() + 30 * 60000),
            createdById: me.id,
          },
        });
      }
    }

    await writeAudit({
      req,
      action: AuditAction.UPDATE,
      entity: "ProcedureRecord",
      entityId: procedure.id,
      branchId: procedure.branchId,
      summary: `Ca mổ ${procedure.code}: ${before.status} → ${body.status}${body.reason ? ` (${body.reason})` : ""}`,
    });

    emitTo(roomFor.branch(procedure.branchId), "appointment:updated", procedure);
    res.json(procedure);
  })
);

export default router;
