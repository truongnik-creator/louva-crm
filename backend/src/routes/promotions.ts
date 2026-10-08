import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { asyncHandler, HttpError } from "../middleware/errorHandler";
import { requireAuth, currentUser } from "../middleware/auth";
import { notFound, requireAnyPermission, requirePermission } from "../middleware/rbac";
import { writeAudit } from "../lib/audit";
import { promotionAppliesTo, promotionState, type PromotionRow } from "../lib/pricing";
import { AuditAction, PromotionKind } from "../types/enums";

// F13: ĐỢT ƯU ĐÃI. Sale chỉ được giảm qua đợt đang chạy (hoặc khi quản lý duyệt).

const router = Router();
router.use(requireAuth);

const include = { services: { select: { serviceId: true, service: { select: { id: true, name: true, code: true } } } } } as const;

const promoSchema = z
  .object({
    code: z.string().trim().min(2).max(40).regex(/^[A-Z0-9_-]+$/i, "Mã chỉ gồm chữ không dấu, số, gạch"),
    name: z.string().trim().min(2).max(120),
    kind: z.nativeEnum(PromotionKind),
    value: z.number().int().positive(),
    maxSlots: z.number().int().positive().nullable().optional(),
    startAt: z.coerce.date(),
    endAt: z.coerce.date(),
    branchId: z.string().uuid().nullable().optional(),
    serviceIds: z.array(z.string().uuid()).max(100).default([]),
    active: z.boolean().optional(),
    note: z.string().trim().max(500).optional().nullable(),
  })
  .refine((p) => p.endAt > p.startAt, { message: "Ngày kết thúc phải sau ngày bắt đầu", path: ["endAt"] })
  .refine((p) => p.kind !== PromotionKind.PERCENT || p.value <= 100, { message: "Giảm theo % tối đa 100", path: ["value"] });

function view<T extends PromotionRow>(p: T) {
  return {
    ...p,
    state: promotionState(p),
    slotsLeft: p.maxSlots != null ? Math.max(0, p.maxSlots - p.usedSlots) : null,
  };
}

/** GET /api/promotions?active=1&serviceId=&branchId= — danh sách (active=1: chỉ đợt đang chạy, cho màn báo giá). */
router.get(
  "/",
  requireAnyPermission("sales_order.read", "promotion.manage", "service.read"),
  asyncHandler(async (req, res) => {
    const rows = await prisma.promotion.findMany({ orderBy: [{ active: "desc" }, { endAt: "desc" }], include, take: 500 });
    let out = rows.map(view);
    if (req.query.active === "1") {
      const branchId = (req.query.branchId as string) || currentUser(req).activeBranchId || "";
      const serviceId = (req.query.serviceId as string) || null;
      out = out.filter((p) => p.state === "ACTIVE" && (!serviceId || promotionAppliesTo(p, serviceId, branchId)) && (!p.branchId || p.branchId === branchId));
    }
    res.json(out);
  })
);

router.post(
  "/",
  requirePermission("promotion.manage"),
  asyncHandler(async (req, res) => {
    const body = promoSchema.parse(req.body);
    const exists = await prisma.promotion.findUnique({ where: { code: body.code.toUpperCase() } });
    if (exists) throw new HttpError(409, `Mã ưu đãi ${body.code} đã có`);
    const p = await prisma.promotion.create({
      data: {
        code: body.code.toUpperCase(),
        name: body.name,
        kind: body.kind,
        value: body.value,
        maxSlots: body.maxSlots ?? null,
        startAt: body.startAt,
        endAt: body.endAt,
        branchId: body.branchId ?? null,
        active: body.active ?? true,
        note: body.note ?? null,
        createdById: currentUser(req).id,
        services: { create: body.serviceIds.map((serviceId) => ({ serviceId })) },
      },
      include,
    });
    await writeAudit({
      req,
      action: AuditAction.CREATE,
      entity: "Promotion",
      entityId: p.id,
      summary: `Tạo đợt ưu đãi ${p.code} "${p.name}": ${p.kind === "PERCENT" ? `${p.value}%` : `${p.value.toLocaleString("vi-VN")}đ`}, ${p.maxSlots ?? "không giới hạn"} suất`,
    });
    res.status(201).json(view(p));
  })
);

router.patch(
  "/:id",
  requirePermission("promotion.manage"),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        name: z.string().trim().min(2).max(120).optional(),
        maxSlots: z.number().int().positive().nullable().optional(),
        endAt: z.coerce.date().optional(),
        active: z.boolean().optional(),
        note: z.string().trim().max(500).nullable().optional(),
      })
      .parse(req.body);
    const before = await prisma.promotion.findUnique({ where: { id: req.params.id } });
    if (!before) throw notFound();
    if (body.maxSlots != null && body.maxSlots < before.usedSlots) {
      throw new HttpError(400, `Đã dùng ${before.usedSlots} suất, không đặt số suất thấp hơn được`);
    }
    const maxSlots = body.maxSlots === undefined ? before.maxSlots : body.maxSlots;
    const full = maxSlots != null && before.usedSlots >= maxSlots;
    const p = await prisma.promotion.update({
      where: { id: before.id },
      data: { ...body, lockedAt: full ? (before.lockedAt ?? new Date()) : null },
      include,
    });
    await writeAudit({
      req,
      action: AuditAction.UPDATE,
      entity: "Promotion",
      entityId: p.id,
      summary: `Sửa đợt ưu đãi ${p.code}`,
      changes: Object.fromEntries(
        Object.keys(body).map((k) => [k, [(before as Record<string, unknown>)[k] ?? null, (body as Record<string, unknown>)[k] ?? null]])
      ) as Record<string, [unknown, unknown]>,
    });
    res.json(view(p));
  })
);

export default router;
