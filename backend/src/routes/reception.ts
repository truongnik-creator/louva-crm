import { Router } from "express";
import { noteShowUp, refreshFirstPurchaseAt, safely } from "../lib/lead-funnel";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { formatTimeVN, formatDateTimeVN, startOfVnDay } from "../lib/datetime";
import { pageQuery } from "../lib/pagination";
import { asyncHandler, HttpError } from "../middleware/errorHandler";
import { requireAuth, currentUser } from "../middleware/auth";
import { requirePermission, scopedWhere, assertInScope, notFound, maskCustomerPhonesInResponse, maskCustomerPhonesForBroadcast } from "../middleware/rbac";
import { writeAudit, diffFields } from "../lib/audit";
import { emitTo, roomFor } from "../socket";
import { applyStageEventSafe } from "../lib/stages";
import { withCode, CodePrefix } from "../lib/codes";
import { depositQr, ensureAppointmentCode } from "../lib/deposit";
import { formatVnd } from "../lib/datetime";
import {
  AuditAction,
  ActivityType,
  AppointmentStatus,
  AppointmentType,
  DepositStatus,
  PaymentMethod,
  PaymentType,
  StageEvent,
  VisitStatus,
  VISIT_FLOW,
} from "../types/enums";

// Lễ tân: Lịch hẹn + Check-in (hàng đợi). Hai màn "Lễ tân · Lịch hẹn" và
// "Lễ tân · Khách đã đến" trong prototype.

const router = Router();
router.use(requireAuth);
// Che SĐT khách lồng trong mọi phản hồi của router này cho vai không có customer.view_phone.
router.use(maskCustomerPhonesInResponse);

const APPT_SCOPE = { ownerFields: ["createdById", "doctorId"], branchField: "branchId" };

const appointmentInclude = {
  customer: { select: { id: true, name: true, phone: true, code: true, stage: true } },
  doctor: { select: { id: true, name: true, title: true } },
  room: { select: { id: true, name: true, code: true, type: true } },
  service: { select: { id: true, name: true, durationMin: true } },
  createdBy: { select: { id: true, name: true } },
  visit: { select: { id: true, status: true, queueNumber: true } },
} as const;

/** Một ngày theo giờ Việt Nam; "2026-09-15" là ngày 15/09 giờ VN, không phải giờ máy chủ. */
function dayRange(dateStr: string | undefined): { gte: Date; lt: Date } {
  const base = dateStr && /^\d{4}-\d{2}-\d{2}$/.test(dateStr) ? new Date(`${dateStr}T12:00:00Z`) : dateStr ? new Date(dateStr) : new Date();
  const start = startOfVnDay(base);
  return { gte: start, lt: new Date(start.getTime() + 86_400_000) };
}

// GET /api/appointments?date=&doctorId=&roomId=&status=
router.get(
  "/appointments",
  requirePermission("appointment.read"),
  asyncHandler(async (req, res) => {
    const { where } = scopedWhere(req, "appointment.read", APPT_SCOPE);
    const filters: Record<string, unknown> = { ...where };

    if (req.query.from || req.query.to) {
      filters.startAt = {
        ...(req.query.from ? { gte: new Date(String(req.query.from)) } : {}),
        ...(req.query.to ? { lt: new Date(String(req.query.to)) } : {}),
      };
    } else {
      filters.startAt = dayRange(req.query.date as string | undefined);
    }
    if (req.query.branchId) filters.branchId = String(req.query.branchId);
    if (req.query.doctorId) filters.doctorId = String(req.query.doctorId);
    if (req.query.roomId) filters.roomId = String(req.query.roomId);
    if (req.query.status) filters.status = String(req.query.status);
    if (req.query.customerId) filters.customerId = String(req.query.customerId);

    const items = await prisma.appointment.findMany({
      ...pageQuery(req.query, { defaultLimit: 500, maxLimit: 1000 }),
      where: filters,
      orderBy: { startAt: "asc" },
      include: appointmentInclude,
    });

    // Đếm theo trạng thái cho dải "chip" phía trên lịch (prototype).
    const counts = items.reduce<Record<string, number>>((acc, a) => {
      acc[a.status] = (acc[a.status] ?? 0) + 1;
      return acc;
    }, {});

    res.json({ items, counts, total: items.length });
  })
);

const appointmentSchema = z.object({
  customerId: z.string().uuid(),
  branchId: z.string().uuid().optional(),
  type: z.nativeEnum(AppointmentType).optional(),
  title: z.string().min(2),
  serviceId: z.string().uuid().optional().nullable(),
  doctorId: z.string().uuid().optional().nullable(),
  roomId: z.string().uuid().optional().nullable(),
  startAt: z.coerce.date(),
  endAt: z.coerce.date().optional(),
  note: z.string().optional().nullable(),
  /** F25: tiền cọc yêu cầu (đồng). 0 = không yêu cầu cọc. */
  depositAmount: z.number().int().min(0).max(1_000_000_000).optional(),
});

function depositFields(amount: number | undefined, current?: { depositStatus: string | null }) {
  if (amount === undefined) return {};
  if (current?.depositStatus === DepositStatus.DA_COC || current?.depositStatus === DepositStatus.HOAN_COC) {
    throw new HttpError(409, "Lịch đã nhận hoặc đã hoàn cọc, không sửa số tiền cọc được nữa");
  }
  return { depositAmount: amount, depositStatus: amount > 0 ? DepositStatus.CHO_COC : null };
}

/**
 * Kiểm tra trùng lịch: một bác sĩ hoặc một phòng không thể có hai lịch chồng
 * nhau. Lịch đã huỷ / vắng mặt không tính.
 */
async function assertNoOverlap(params: {
  doctorId?: string | null;
  roomId?: string | null;
  startAt: Date;
  endAt: Date;
  excludeId?: string;
}) {
  const conflictWhere = {
    id: params.excludeId ? { not: params.excludeId } : undefined,
    status: { notIn: [AppointmentStatus.CANCELLED, AppointmentStatus.NO_SHOW] },
    startAt: { lt: params.endAt },
    endAt: { gt: params.startAt },
  };

  if (params.doctorId) {
    const clash = await prisma.appointment.findFirst({
      where: { ...conflictWhere, doctorId: params.doctorId },
      include: { doctor: { select: { name: true } } },
    });
    if (clash) {
      throw new HttpError(
        409,
        `Bác sĩ ${clash.doctor?.name} đã có lịch lúc ${formatTimeVN(clash.startAt)}`
      );
    }
  }

  if (params.roomId) {
    const clash = await prisma.appointment.findFirst({
      where: { ...conflictWhere, roomId: params.roomId },
      include: { room: { select: { name: true } } },
    });
    if (clash) {
      throw new HttpError(409, `${clash.room?.name} đã có lịch trong khung giờ này`);
    }
  }
}

router.post(
  "/appointments",
  requirePermission("appointment.create"),
  asyncHandler(async (req, res) => {
    const body = appointmentSchema.parse(req.body);
    const me = currentUser(req);
    const branchId = body.branchId ?? me.activeBranchId;
    if (!branchId) throw new HttpError(400, "Chưa xác định được cơ sở");
    if (!me.branchIds.includes(branchId)) throw notFound();

    // Thời lượng lấy theo dịch vụ nếu không truyền endAt.
    let endAt = body.endAt;
    if (!endAt) {
      const service = body.serviceId
        ? await prisma.service.findUnique({ where: { id: body.serviceId } })
        : null;
      endAt = new Date(body.startAt.getTime() + (service?.durationMin ?? 30) * 60000);
    }
    if (endAt <= body.startAt) throw new HttpError(400, "Giờ kết thúc phải sau giờ bắt đầu");

    await assertNoOverlap({ doctorId: body.doctorId, roomId: body.roomId, startAt: body.startAt, endAt });

    const { depositAmount, ...rest } = body;
    const appointment = await withCode(CodePrefix.APPOINTMENT, (code) =>
      prisma.appointment.create({
        data: { ...rest, ...depositFields(depositAmount), code, branchId, endAt, createdById: me.id },
        include: appointmentInclude,
      })
    );

    await prisma.activity.create({
      data: {
        customerId: body.customerId,
        type: ActivityType.APPOINTMENT,
        content: `${me.name} đặt lịch "${body.title}" lúc ${formatDateTimeVN(body.startAt)}${
          depositAmount ? `, cọc ${formatVnd(depositAmount)}đ` : ""
        }`,
        userId: me.id,
        userName: me.name,
      },
    });
    // F1: phẫu thuật = "Đã hẹn"; phòng khám tiêm chỉ lên bước khi đã cọc.
    await applyStageEventSafe(body.customerId, StageEvent.APPOINTMENT_BOOKED, { actor: { id: me.id, name: me.name } });

    await writeAudit({
      req,
      action: AuditAction.CREATE,
      entity: "Appointment",
      entityId: appointment.id,
      branchId,
      summary: `Đặt lịch ${appointment.title} cho ${appointment.customer.name}`,
    });

    emitTo(roomFor.branch(branchId), "appointment:created", maskCustomerPhonesForBroadcast(appointment));
    res.status(201).json(appointment);
  })
);

router.patch(
  "/appointments/:id",
  requirePermission("appointment.update"),
  asyncHandler(async (req, res) => {
    const body = appointmentSchema.partial().omit({ customerId: true, branchId: true }).parse(req.body);
    const before = await prisma.appointment.findUnique({ where: { id: req.params.id } });
    assertInScope(req, "appointment.update", before as unknown as Record<string, unknown>, APPT_SCOPE);

    const startAt = body.startAt ?? before!.startAt;
    const endAt = body.endAt ?? before!.endAt;
    await assertNoOverlap({
      doctorId: body.doctorId ?? before!.doctorId,
      roomId: body.roomId ?? before!.roomId,
      startAt,
      endAt,
      excludeId: before!.id,
    });

    const { depositAmount, ...rest } = body;
    const appointment = await prisma.appointment.update({
      where: { id: req.params.id },
      data: { ...rest, ...depositFields(depositAmount, before!) },
      include: appointmentInclude,
    });

    await writeAudit({
      req,
      action: AuditAction.UPDATE,
      entity: "Appointment",
      entityId: appointment.id,
      branchId: appointment.branchId,
      summary: `Sửa lịch hẹn ${appointment.title}`,
      changes: diffFields(before as unknown as Record<string, unknown>, body),
    });

    emitTo(roomFor.branch(appointment.branchId), "appointment:updated", maskCustomerPhonesForBroadcast(appointment));
    res.json(appointment);
  })
);

// POST /api/appointments/:id/status — confirm | cancel | no-show
router.post(
  "/appointments/:id/status",
  requirePermission("appointment.update"),
  asyncHandler(async (req, res) => {
    const body = z
      .object({ status: z.nativeEnum(AppointmentStatus), reason: z.string().optional() })
      .parse(req.body);

    const before = await prisma.appointment.findUnique({ where: { id: req.params.id } });
    assertInScope(req, "appointment.update", before as unknown as Record<string, unknown>, APPT_SCOPE);

    if (body.status === AppointmentStatus.CANCELLED && !body.reason) {
      throw new HttpError(400, "Huỷ hẹn bắt buộc chọn lý do");
    }

    const appointment = await prisma.appointment.update({
      where: { id: req.params.id },
      data: { status: body.status, cancelReason: body.reason ?? null },
      include: appointmentInclude,
    });

    await writeAudit({
      req,
      action: AuditAction.UPDATE,
      entity: "Appointment",
      entityId: appointment.id,
      branchId: appointment.branchId,
      summary: `Lịch ${appointment.title}: ${before!.status} → ${body.status}${body.reason ? ` (${body.reason})` : ""}`,
    });

    emitTo(roomFor.branch(appointment.branchId), "appointment:updated", maskCustomerPhonesForBroadcast(appointment));
    res.json(appointment);
  })
);

// ------------------------------------------------------------ CỌC (F25 + F12)

/** GET /api/reception/appointments/:id/deposit-qr — ảnh VietQR, nội dung = mã lịch. */
router.get(
  "/appointments/:id/deposit-qr",
  requirePermission("appointment.read"),
  asyncHandler(async (req, res) => {
    const appt = await prisma.appointment.findUnique({ where: { id: req.params.id } });
    assertInScope(req, "appointment.read", appt as unknown as Record<string, unknown>, APPT_SCOPE);
    res.json(await depositQr(appt!.id));
  })
);

/**
 * POST /api/reception/appointments/:id/deposit/confirm — lễ tân bấm một nút
 * "Đã nhận cọc": sinh phiếu thu loại DEPOSIT gắn lịch, lịch sang DA_COC, khách
 * sang bước Lịch cọc.
 */
router.post(
  "/appointments/:id/deposit/confirm",
  requirePermission("finance.create"),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        amount: z.number().int().positive().optional(),
        method: z
          .nativeEnum(PaymentMethod)
          .refine((m) => m !== PaymentMethod.VOUCHER, "Voucher dùng qua nút Dùng voucher, không chọn như phương thức thu")
          .optional(),
        reference: z.string().max(100).optional(),
      })
      .parse(req.body ?? {});
    const before = await prisma.appointment.findUnique({ where: { id: req.params.id } });
    assertInScope(req, "appointment.update", before as unknown as Record<string, unknown>, APPT_SCOPE);
    const me = currentUser(req);
    if (before!.depositStatus === DepositStatus.DA_COC) throw new HttpError(409, "Lịch này đã xác nhận nhận cọc");
    if (before!.status === AppointmentStatus.CANCELLED) throw new HttpError(400, "Lịch đã huỷ, không nhận cọc");
    const amount = body.amount ?? before!.depositAmount;
    if (!amount || amount <= 0) throw new HttpError(400, "Lịch chưa có số tiền cọc. Nhập số tiền cọc trước.");
    const code = await ensureAppointmentCode(before!.id);

    const payment = await withCode(CodePrefix.PAYMENT, (pcode) =>
      prisma.$transaction(async (tx) => {
        const p = await tx.payment.create({
          data: {
            code: pcode,
            branchId: before!.branchId,
            customerId: before!.customerId,
            appointmentId: before!.id,
            type: PaymentType.DEPOSIT,
            amount,
            method: body.method ?? PaymentMethod.BANK_TRANSFER,
            reference: body.reference ?? code,
            note: `Cọc lịch ${code}`,
            receivedById: me.id,
          },
        });
        await tx.appointment.update({
          where: { id: before!.id },
          data: {
            depositAmount: amount,
            depositStatus: DepositStatus.DA_COC,
            depositConfirmedAt: new Date(),
            depositConfirmedById: me.id,
            ...(before!.status === AppointmentStatus.PENDING ? { status: AppointmentStatus.CONFIRMED } : {}),
          },
        });
        await tx.activity.create({
          data: {
            customerId: before!.customerId,
            type: ActivityType.PAYMENT,
            content: `${me.name} xác nhận nhận cọc ${formatVnd(amount)}đ cho lịch ${code}, phiếu ${pcode}`,
            userId: me.id,
            userName: me.name,
          },
        });
        return p;
      })
    );

    await applyStageEventSafe(before!.customerId, StageEvent.DEPOSIT_CONFIRMED, { actor: { id: me.id, name: me.name } });
    await writeAudit({
      req,
      action: AuditAction.CREATE,
      entity: "Payment",
      entityId: payment.id,
      branchId: before!.branchId,
      summary: `Nhận cọc ${formatVnd(amount)}đ cho lịch ${code}: phiếu ${payment.code}`,
    });
    const appointment = await prisma.appointment.findUniqueOrThrow({ where: { id: before!.id }, include: appointmentInclude });
    emitTo(roomFor.branch(appointment.branchId), "appointment:updated", maskCustomerPhonesForBroadcast(appointment));
    await safely("mốc mua đầu", () => refreshFirstPurchaseAt(before!.customerId));
    res.status(201).json({ appointment, payment });
  })
);

/** POST /api/reception/appointments/:id/deposit/refund — hoàn cọc (phiếu REFUND số âm), bắt buộc lý do. */
router.post(
  "/appointments/:id/deposit/refund",
  requirePermission("finance.approve"),
  asyncHandler(async (req, res) => {
    const { reason } = z.object({ reason: z.string().trim().min(5, "Lý do hoàn cọc tối thiểu 5 ký tự") }).parse(req.body ?? {});
    const before = await prisma.appointment.findUnique({ where: { id: req.params.id } });
    assertInScope(req, "appointment.update", before as unknown as Record<string, unknown>, APPT_SCOPE);
    if (before!.depositStatus !== DepositStatus.DA_COC) throw new HttpError(400, "Lịch chưa nhận cọc nên không hoàn được");
    const deposit = await prisma.payment.findFirst({
      where: { appointmentId: before!.id, type: PaymentType.DEPOSIT },
      orderBy: { paidAt: "desc" },
    });
    if (!deposit) throw new HttpError(400, "Không tìm thấy phiếu cọc của lịch này");
    if (deposit.depositAppliedAt) throw new HttpError(409, "Tiền cọc đã được trừ vào thanh toán dịch vụ, không hoàn được");
    const me = currentUser(req);
    const code = await ensureAppointmentCode(before!.id);

    const refund = await withCode(CodePrefix.PAYMENT, (pcode) =>
      prisma.$transaction(async (tx) => {
        const r = await tx.payment.create({
          data: {
            code: pcode,
            branchId: before!.branchId,
            customerId: before!.customerId,
            appointmentId: before!.id,
            type: PaymentType.REFUND,
            amount: -deposit.amount,
            method: deposit.method,
            note: `Hoàn cọc lịch ${code}. Lý do: ${reason}`,
            receivedById: me.id,
          },
        });
        await tx.payment.update({ where: { id: deposit.id }, data: { depositAppliedAt: new Date() } });
        await tx.appointment.update({ where: { id: before!.id }, data: { depositStatus: DepositStatus.HOAN_COC } });
        return r;
      })
    );
    await writeAudit({
      req,
      action: AuditAction.UPDATE,
      entity: "Appointment",
      entityId: before!.id,
      branchId: before!.branchId,
      summary: `Hoàn cọc ${formatVnd(deposit.amount)}đ lịch ${code}. Lý do: ${reason}`,
    });
    await safely("mốc mua đầu", () => refreshFirstPurchaseAt(before!.customerId));
    res.status(201).json(refund);
  })
);

// ------------------------------------------------------- CHECK-IN / HÀNG ĐỢI

const visitInclude = {
  customer: { select: { id: true, name: true, phone: true, code: true, stage: true } },
  appointment: {
    select: { id: true, title: true, startAt: true, doctor: { select: { name: true } } },
  },
  consultant: { select: { id: true, name: true } },
} as const;

// GET /api/visits/queue?branchId= — hàng đợi thời gian thực
router.get(
  "/visits/queue",
  requirePermission("visit.read"),
  asyncHandler(async (req, res) => {
    const { where } = scopedWhere(req, "visit.read", {
      ownerFields: ["consultantId"],
      branchField: "branchId",
    });
    const me = currentUser(req);
    const branchId = (req.query.branchId as string) ?? me.activeBranchId ?? undefined;

    const visits = await prisma.visit.findMany({
      ...pageQuery(req.query, { defaultLimit: 200, maxLimit: 500 }),
      where: {
        ...where,
        ...(branchId && me.branchIds.includes(branchId) ? { branchId } : {}),
        checkedInAt: dayRange(req.query.date as string | undefined),
        ...(req.query.includeFinished === "1"
          ? {}
          : { status: { notIn: [VisitStatus.DONE, VisitStatus.LEFT] } }),
      },
      orderBy: [{ status: "asc" }, { queueNumber: "asc" }],
      include: visitInclude,
    });

    const now = Date.now();
    res.json(
      visits.map((v) => ({
        ...v,
        // Kẹp về 0: giờ check-in không bao giờ được nằm ở tương lai, nhưng
        // lệch giờ máy trạm hoặc dữ liệu nhập tay có thể tạo ra mốc như vậy —
        // hiển thị "chờ -520 phút" thì lễ tân mất tin vào cả màn hình.
        waitingMinutes: Math.max(0, Math.round((now - v.checkedInAt.getTime()) / 60000)),
      }))
    );
  })
);

// POST /api/visits — CHECK-IN
router.post(
  "/visits",
  requirePermission("visit.create"),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        customerId: z.string().uuid(),
        appointmentId: z.string().uuid().optional(),
        branchId: z.string().uuid().optional(),
        purpose: z.string().optional(),
        consultantId: z.string().uuid().optional(),
        note: z.string().optional(),
      })
      .parse(req.body);

    const me = currentUser(req);
    const branchId = body.branchId ?? me.activeBranchId;
    if (!branchId) throw new HttpError(400, "Chưa xác định được cơ sở");
    if (!me.branchIds.includes(branchId)) throw notFound();

    if (body.appointmentId) {
      const taken = await prisma.visit.findUnique({ where: { appointmentId: body.appointmentId } });
      if (taken) throw new HttpError(409, "Lịch hẹn này đã được check-in");
    }

    // Số thứ tự đếm lại theo từng ngày, từng cơ sở.
    const today = dayRange(undefined);
    const todayCount = await prisma.visit.count({
      where: { branchId, checkedInAt: today },
    });

    const visit = await prisma.visit.create({
      data: {
        ...body,
        branchId,
        queueNumber: todayCount + 1,
        status: VisitStatus.WAITING,
        receptionistId: me.id,
      },
      include: visitInclude,
    });

    await prisma.$transaction([
      prisma.customer.update({
        where: { id: body.customerId },
        data: {
          lastContactAt: new Date(),
          activities: {
            create: {
              type: ActivityType.CHECK_IN,
              content: `Lễ tân ${me.name} check-in, số thứ tự ${visit.queueNumber}`,
              userId: me.id,
              userName: me.name,
            },
          },
        },
      }),
      ...(body.appointmentId
        ? [
            prisma.appointment.update({
              where: { id: body.appointmentId },
              data: { status: AppointmentStatus.ARRIVED },
            }),
          ]
        : []),
    ]);

    await applyStageEventSafe(body.customerId, StageEvent.CHECK_IN, { actor: { id: me.id, name: me.name }, branchId });
    // F15: mốc khách đến lần đầu của lead.
    await safely("mốc khách đến", () => noteShowUp(body.customerId, visit.checkedInAt));

    await writeAudit({
      req,
      action: AuditAction.CREATE,
      entity: "Visit",
      entityId: visit.id,
      branchId,
      summary: `Check-in ${visit.customer.name} — STT ${visit.queueNumber}`,
    });

    emitTo(roomFor.branch(branchId), "visit:checked-in", maskCustomerPhonesForBroadcast(visit));
    emitTo(roomFor.branch(branchId), "queue:updated", { branchId });
    res.status(201).json(visit);
  })
);

// PATCH /api/visits/:id/status — WAITING→CONSULTING→IN_SERVICE→PAYING→DONE
router.patch(
  "/visits/:id/status",
  requirePermission("visit.update"),
  asyncHandler(async (req, res) => {
    const body = z
      .object({ status: z.nativeEnum(VisitStatus), consultantId: z.string().uuid().optional() })
      .parse(req.body);

    const before = await prisma.visit.findUnique({ where: { id: req.params.id } });
    assertInScope(req, "visit.update", before as unknown as Record<string, unknown>, {
      ownerFields: ["consultantId"],
      branchField: "branchId",
    });

    // Chỉ cho tiến tới hoặc rời hàng đợi — không cho nhảy ngược, vì hàng đợi
    // là bằng chứng thời gian chờ dùng cho báo cáo vận hành.
    const fromIdx = VISIT_FLOW.indexOf(before!.status as VisitStatus);
    const toIdx = VISIT_FLOW.indexOf(body.status);
    if (body.status !== VisitStatus.LEFT && fromIdx >= 0 && toIdx >= 0 && toIdx < fromIdx) {
      throw new HttpError(400, "Không thể lùi trạng thái hàng đợi");
    }

    const visit = await prisma.visit.update({
      where: { id: req.params.id },
      data: {
        status: body.status,
        ...(body.consultantId ? { consultantId: body.consultantId } : {}),
        ...(body.status === VisitStatus.CONSULTING && !before!.calledAt ? { calledAt: new Date() } : {}),
        ...(body.status === VisitStatus.DONE || body.status === VisitStatus.LEFT
          ? { finishedAt: new Date() }
          : {}),
      },
      include: visitInclude,
    });

    // F1: khách rời bước "đang làm dịch vụ" (sang thanh toán hoặc xong) = đã làm dịch vụ.
    if (
      before!.status === VisitStatus.IN_SERVICE &&
      (body.status === VisitStatus.PAYING || body.status === VisitStatus.DONE)
    ) {
      const me = currentUser(req);
      await applyStageEventSafe(visit.customerId, StageEvent.VISIT_SERVICE_DONE, { actor: { id: me.id, name: me.name } });
    }

    emitTo(roomFor.branch(visit.branchId), "queue:updated", { branchId: visit.branchId });
    res.json(visit);
  })
);

export default router;
