import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { asyncHandler, HttpError } from "../middleware/errorHandler";
import { requireAuth, currentUser } from "../middleware/auth";
import { requirePermission, notFound } from "../middleware/rbac";
import { writeAudit, diffFields } from "../lib/audit";
import { AuditAction, AnesthesiaType, ServiceKind, ShiftAssignmentStatus, ShiftKind } from "../types/enums";

// Danh mục dịch vụ & bảng giá theo cơ sở, và phân lịch làm việc.
// Hai màn "Danh mục dịch vụ & Bảng giá" và "Phân lịch làm việc".

const router = Router();
router.use(requireAuth);

// ------------------------------------------------------------- DANH MỤC

router.get(
  "/service-categories",
  requirePermission("service.read"),
  asyncHandler(async (_req, res) => {
    res.json(
      await prisma.serviceCategory.findMany({
        orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
        include: { _count: { select: { services: true } } },
      })
    );
  })
);

router.post(
  "/service-categories",
  requirePermission("service.create"),
  asyncHandler(async (req, res) => {
    const body = z
      .object({ code: z.string().min(1), name: z.string().min(2), sortOrder: z.number().int().optional() })
      .parse(req.body);
    res.status(201).json(await prisma.serviceCategory.create({ data: body }));
  })
);

/**
 * GET /api/services — kèm giá hiệu lực tại cơ sở đang làm việc.
 * Giá theo cơ sở và theo thời gian nên phải chọn bản ghi ServicePrice có
 * validFrom gần nhất còn hiệu lực, chứ không phải bản mới nhất theo createdAt.
 */
router.get(
  "/services",
  requirePermission("service.read"),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const branchId = (req.query.branchId as string) ?? me.activeBranchId ?? undefined;
    const now = new Date();

    const services = await prisma.service.findMany({
      where: {
        ...(req.query.categoryId ? { categoryId: String(req.query.categoryId) } : {}),
        ...(req.query.kind ? { kind: String(req.query.kind) } : {}),
        ...(req.query.active === "0" ? {} : { active: true }),
        ...(req.query.q ? { name: { contains: String(req.query.q) } } : {}),
      },
      orderBy: { name: "asc" },
      include: {
        category: { select: { id: true, name: true } },
        prices: {
          where: {
            ...(branchId ? { branchId } : {}),
            validFrom: { lte: now },
            OR: [{ validTo: null }, { validTo: { gt: now } }],
          },
          orderBy: { validFrom: "desc" },
          take: 1,
        },
      },
    });

    res.json(
      services.map((s) => ({
        ...s,
        price: s.prices[0]?.price ?? null,
        minPrice: s.prices[0]?.minPrice ?? null,
        prices: undefined,
      }))
    );
  })
);

const serviceSchema = z.object({
  code: z.string().min(2),
  name: z.string().min(2),
  categoryId: z.string().uuid().optional().nullable(),
  kind: z.nativeEnum(ServiceKind).optional(),
  description: z.string().optional().nullable(),
  durationMin: z.number().int().positive().optional(),
  recoveryDays: z.number().int().nonnegative().optional().nullable(),
  requiresConsent: z.boolean().optional(),
  requiresPreOpLab: z.boolean().optional(),
  anesthesia: z.nativeEnum(AnesthesiaType).optional().nullable(),
  active: z.boolean().optional(),
});

router.post(
  "/services",
  requirePermission("service.create"),
  asyncHandler(async (req, res) => {
    const body = serviceSchema.parse(req.body);
    const service = await prisma.service.create({ data: body });
    await writeAudit({
      req,
      action: AuditAction.CREATE,
      entity: "Service",
      entityId: service.id,
      summary: `Tạo dịch vụ ${service.name}`,
    });
    res.status(201).json(service);
  })
);

router.patch(
  "/services/:id",
  requirePermission("service.update"),
  asyncHandler(async (req, res) => {
    const body = serviceSchema.partial().parse(req.body);
    const before = await prisma.service.findUnique({ where: { id: req.params.id } });
    if (!before) throw notFound("Không tìm thấy dịch vụ");

    const service = await prisma.service.update({ where: { id: req.params.id }, data: body });
    await writeAudit({
      req,
      action: AuditAction.UPDATE,
      entity: "Service",
      entityId: service.id,
      summary: `Sửa dịch vụ ${service.name}`,
      changes: diffFields(before, body),
    });
    res.json(service);
  })
);

/**
 * POST /api/service-prices — đặt giá mới cho một cơ sở.
 * Không sửa đè giá cũ: đóng bản ghi hiện hành (validTo = now) rồi mở bản ghi
 * mới. Giữ được lịch sử giá để đối chiếu hợp đồng đã ký.
 */
router.post(
  "/service-prices",
  requirePermission("service.update"),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        serviceId: z.string().uuid(),
        branchId: z.string().uuid(),
        price: z.number().int().nonnegative(),
        minPrice: z.number().int().nonnegative().optional(),
        validFrom: z.coerce.date().optional(),
      })
      .parse(req.body);

    if (body.minPrice != null && body.minPrice > body.price) {
      throw new HttpError(400, "Giá sàn không được lớn hơn giá niêm yết");
    }

    const validFrom = body.validFrom ?? new Date();
    const price = await prisma.$transaction(async (tx) => {
      await tx.servicePrice.updateMany({
        where: { serviceId: body.serviceId, branchId: body.branchId, validTo: null },
        data: { validTo: validFrom },
      });
      return tx.servicePrice.create({
        data: {
          serviceId: body.serviceId,
          branchId: body.branchId,
          price: body.price,
          minPrice: body.minPrice,
          validFrom,
        },
      });
    });

    await writeAudit({
      req,
      action: AuditAction.UPDATE,
      entity: "ServicePrice",
      entityId: price.id,
      branchId: body.branchId,
      summary: `Đặt giá ${body.price.toLocaleString("vi-VN")}đ cho dịch vụ`,
    });
    res.status(201).json(price);
  })
);

router.get(
  "/service-prices",
  requirePermission("service.read"),
  asyncHandler(async (req, res) => {
    res.json(
      await prisma.servicePrice.findMany({
        where: {
          ...(req.query.serviceId ? { serviceId: String(req.query.serviceId) } : {}),
          ...(req.query.branchId ? { branchId: String(req.query.branchId) } : {}),
        },
        orderBy: { validFrom: "desc" },
        include: {
          service: { select: { id: true, name: true, code: true } },
          branch: { select: { id: true, code: true, shortName: true } },
        },
      })
    );
  })
);

// ------------------------------------------------------- PHÂN LỊCH LÀM VIỆC

router.get(
  "/shift-templates",
  requirePermission("shift.read"),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    res.json(
      await prisma.shiftTemplate.findMany({
        where: { branchId: { in: me.branchIds }, active: true },
        orderBy: { startTime: "asc" },
      })
    );
  })
);

router.post(
  "/shift-templates",
  requirePermission("shift.create"),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        branchId: z.string().uuid(),
        code: z.string().min(1),
        name: z.string().min(2),
        kind: z.nativeEnum(ShiftKind).optional(),
        startTime: z.string().regex(/^\d{2}:\d{2}$/),
        endTime: z.string().regex(/^\d{2}:\d{2}$/),
        color: z.string().optional(),
      })
      .parse(req.body);
    res.status(201).json(await prisma.shiftTemplate.create({ data: body }));
  })
);

// GET /api/shifts/calendar?from=&to=&branchId= — lưới xếp ca
router.get(
  "/shifts/calendar",
  requirePermission("shift.read"),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const from = req.query.from ? new Date(String(req.query.from)) : new Date();
    const to = req.query.to
      ? new Date(String(req.query.to))
      : new Date(from.getTime() + 7 * 24 * 3600 * 1000);

    const branchId = (req.query.branchId as string) ?? me.activeBranchId ?? undefined;

    res.json(
      await prisma.shiftAssignment.findMany({
        where: {
          branchId: branchId && me.branchIds.includes(branchId) ? branchId : { in: me.branchIds },
          date: { gte: from, lt: to },
          ...(req.query.departmentId ? { user: { departmentId: String(req.query.departmentId) } } : {}),
        },
        orderBy: [{ date: "asc" }],
        include: {
          user: { select: { id: true, name: true, title: true, department: { select: { name: true } } } },
          template: true,
        },
      })
    );
  })
);

// POST /api/shift-assignments/bulk — xếp ca cả tuần trong một lần
router.post(
  "/shift-assignments/bulk",
  requirePermission("shift.create"),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        branchId: z.string().uuid(),
        assignments: z
          .array(
            z.object({
              userId: z.string().uuid(),
              templateId: z.string().uuid(),
              date: z.coerce.date(),
              note: z.string().optional(),
            })
          )
          .min(1)
          .max(500),
      })
      .parse(req.body);

    const me = currentUser(req);
    if (!me.branchIds.includes(body.branchId)) throw notFound();

    // upsert từng dòng: xếp lại tuần không tạo bản trùng.
    let created = 0;
    for (const a of body.assignments) {
      await prisma.shiftAssignment.upsert({
        where: {
          userId_date_templateId: { userId: a.userId, date: a.date, templateId: a.templateId },
        },
        create: { ...a, branchId: body.branchId, status: ShiftAssignmentStatus.PLANNED },
        update: { note: a.note },
      });
      created++;
    }

    await writeAudit({
      req,
      action: AuditAction.CREATE,
      entity: "ShiftAssignment",
      branchId: body.branchId,
      summary: `Xếp ${created} ca làm việc`,
    });
    res.status(201).json({ ok: true, count: created });
  })
);

router.delete(
  "/shift-assignments/:id",
  requirePermission("shift.delete"),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const shift = await prisma.shiftAssignment.findUnique({ where: { id: req.params.id } });
    if (!shift || !me.branchIds.includes(shift.branchId)) throw notFound();

    await prisma.shiftAssignment.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  })
);

export default router;
