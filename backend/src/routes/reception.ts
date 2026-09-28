import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { asyncHandler, HttpError } from "../middleware/errorHandler";
import { requireAuth, currentUser } from "../middleware/auth";
import { requirePermission, scopedWhere, assertInScope, notFound } from "../middleware/rbac";
import { writeAudit, diffFields } from "../lib/audit";
import { emitTo, roomFor } from "../socket";
import {
  AuditAction,
  ActivityType,
  AppointmentStatus,
  AppointmentType,
  FunnelStage,
  VisitStatus,
  VISIT_FLOW,
} from "../types/enums";

// Lễ tân: Lịch hẹn + Check-in (hàng đợi). Hai màn "Lễ tân · Lịch hẹn" và
// "Lễ tân · Khách đã đến" trong prototype.

const router = Router();
router.use(requireAuth);

const APPT_SCOPE = { ownerFields: ["createdById", "doctorId"], branchField: "branchId" };

const appointmentInclude = {
  customer: { select: { id: true, name: true, phone: true, code: true, stage: true } },
  doctor: { select: { id: true, name: true, title: true } },
  room: { select: { id: true, name: true, code: true, type: true } },
  service: { select: { id: true, name: true, durationMin: true } },
  createdBy: { select: { id: true, name: true } },
  visit: { select: { id: true, status: true, queueNumber: true } },
} as const;

function dayRange(dateStr: string | undefined): { gte: Date; lt: Date } {
  const base = dateStr ? new Date(dateStr) : new Date();
  const start = new Date(base.getFullYear(), base.getMonth(), base.getDate());
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { gte: start, lt: end };
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
});

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
        `Bác sĩ ${clash.doctor?.name} đã có lịch lúc ${clash.startAt.toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" })}`
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

    const appointment = await prisma.appointment.create({
      data: { ...body, branchId, endAt, createdById: me.id },
      include: appointmentInclude,
    });

    // Đặt được lịch thì khách tiến sang giai đoạn "Đã hẹn".
    await prisma.customer.update({
      where: { id: body.customerId },
      data: {
        stage: FunnelStage.HEN,
        activities: {
          create: {
            type: ActivityType.APPOINTMENT,
            content: `${me.name} đặt lịch "${body.title}" lúc ${body.startAt.toLocaleString("vi-VN")}`,
            userId: me.id,
            userName: me.name,
          },
        },
      },
    });

    await writeAudit({
      req,
      action: AuditAction.CREATE,
      entity: "Appointment",
      entityId: appointment.id,
      branchId,
      summary: `Đặt lịch ${appointment.title} cho ${appointment.customer.name}`,
    });

    emitTo(roomFor.branch(branchId), "appointment:created", appointment);
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

    const appointment = await prisma.appointment.update({
      where: { id: req.params.id },
      data: body,
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

    emitTo(roomFor.branch(appointment.branchId), "appointment:updated", appointment);
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

    emitTo(roomFor.branch(appointment.branchId), "appointment:updated", appointment);
    res.json(appointment);
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
          stage: FunnelStage.DEN,
          lastContactAt: new Date(),
          activities: {
            create: {
              type: ActivityType.CHECK_IN,
              content: `Lễ tân ${me.name} check-in — số thứ tự ${visit.queueNumber}. Giai đoạn: Đã hẹn → Đã đến`,
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

    await writeAudit({
      req,
      action: AuditAction.CREATE,
      entity: "Visit",
      entityId: visit.id,
      branchId,
      summary: `Check-in ${visit.customer.name} — STT ${visit.queueNumber}`,
    });

    emitTo(roomFor.branch(branchId), "visit:checked-in", visit);
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

    emitTo(roomFor.branch(visit.branchId), "queue:updated", { branchId: visit.branchId });
    res.json(visit);
  })
);

export default router;
