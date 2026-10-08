import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { parsePagination } from "../lib/pagination";
import { asyncHandler, HttpError } from "../middleware/errorHandler";
import { requireAuth, currentUser } from "../middleware/auth";
import { assertInScope, notFound, phoneFor, requirePermission, scopeOf } from "../middleware/rbac";
import { writeAudit } from "../lib/audit";
import { unknownVariables } from "../lib/quick-reply-vars";
import { MAX_RECIPIENTS, parseSegmentFilter, resolveSegment, segmentFilterSchema, type SegmentFilter } from "../lib/broadcast";
import { ActivityType, AuditAction, BroadcastStatus, PermissionScope, RecipientStatus } from "../types/enums";

// F11: NHÓM KHÁCH VÀ GỬI TIN THEO KỊCH BẢN (/api/outreach).

const router = Router();
router.use(requireAuth);

function branchScope(req: Parameters<typeof requireAuth>[0]): string[] | null {
  return scopeOf(req, "inbox.broadcast") === PermissionScope.ALL ? null : currentUser(req).branchIds;
}

function assertBranchAllowed(req: Parameters<typeof requireAuth>[0], filter: SegmentFilter): void {
  const allowed = branchScope(req);
  if (filter.branchId && allowed && !allowed.includes(filter.branchId)) throw notFound();
}

// ------------------------------------------------------------ NHÓM KHÁCH

router.get(
  "/segments",
  requirePermission("inbox.broadcast"),
  asyncHandler(async (_req, res) => {
    const rows = await prisma.customerSegment.findMany({ orderBy: { createdAt: "desc" }, take: 200 });
    res.json(rows.map((r) => ({ ...r, filter: parseSegmentFilter(r.filter) })));
  })
);

router.post(
  "/segments",
  requirePermission("inbox.broadcast"),
  asyncHandler(async (req, res) => {
    const body = z.object({ name: z.string().trim().min(2).max(120), filter: segmentFilterSchema }).parse(req.body);
    assertBranchAllowed(req, body.filter);
    const row = await prisma.customerSegment.create({
      data: { name: body.name, filter: JSON.stringify(body.filter), createdById: currentUser(req).id },
    });
    await writeAudit({ req, action: AuditAction.CREATE, entity: "CustomerSegment", entityId: row.id, summary: `Lưu nhóm khách "${row.name}"` });
    res.status(201).json({ ...row, filter: body.filter });
  })
);

router.delete(
  "/segments/:id",
  requirePermission("inbox.broadcast"),
  asyncHandler(async (req, res) => {
    const row = await prisma.customerSegment.findUnique({ where: { id: req.params.id } });
    if (!row) throw notFound();
    await prisma.customerSegment.delete({ where: { id: row.id } });
    await writeAudit({ req, action: AuditAction.DELETE, entity: "CustomerSegment", entityId: row.id, summary: `Xoá nhóm khách "${row.name}"` });
    res.json({ ok: true });
  })
);

/** POST /api/outreach/segments/preview { filter } — đếm và xem trước 20 khách của nhóm. */
router.post(
  "/segments/preview",
  requirePermission("inbox.broadcast"),
  asyncHandler(async (req, res) => {
    const { filter } = z.object({ filter: segmentFilterSchema }).parse(req.body);
    assertBranchAllowed(req, filter);
    const members = await resolveSegment(filter, { branchIds: branchScope(req) });
    const optOut = members.filter((m) => m.optOut).length;
    res.json({
      total: members.length,
      optOut,
      willSend: members.length - optOut,
      capped: members.length >= MAX_RECIPIENTS,
      sample: members.slice(0, 20).map((m) => ({ ...m, phone: phoneFor(req, m.phone) })),
    });
  })
);

// ---------------------------------------------------------- ĐỢT GỬI TIN

router.get(
  "/broadcasts",
  requirePermission("inbox.broadcast"),
  asyncHandler(async (req, res) => {
    const page = parsePagination(req.query, { defaultLimit: 50, maxLimit: 200 });
    const rows = await prisma.broadcast.findMany({ orderBy: { createdAt: "desc" }, take: page.take, skip: page.skip });
    const counts = await prisma.broadcastRecipient.groupBy({
      by: ["broadcastId", "status"],
      where: { broadcastId: { in: rows.map((r) => r.id) } },
      _count: { _all: true },
    });
    res.json(
      rows.map((b) => ({
        ...b,
        filter: parseSegmentFilter(b.filter),
        counts: Object.fromEntries(counts.filter((c) => c.broadcastId === b.id).map((c) => [c.status, c._count._all])),
      }))
    );
  })
);

/**
 * POST /api/outreach/broadcasts { name, template, filter | segmentId }
 * Chụp danh sách khách của nhóm vào hàng đợi. Tác vụ nền "broadcast-send" gửi
 * dần theo giới hạn mỗi giờ; khách từ chối nhận tin ghi SKIPPED_OPT_OUT ngay.
 */
router.post(
  "/broadcasts",
  requirePermission("inbox.broadcast"),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        name: z.string().trim().min(2).max(120),
        template: z.string().trim().min(2).max(2000),
        filter: segmentFilterSchema.optional(),
        segmentId: z.string().uuid().optional(),
      })
      .parse(req.body);
    const unknown = unknownVariables(body.template);
    if (unknown.length) throw new HttpError(400, `Biến không có trong danh mục: ${unknown.map((u) => `{{${u}}}`).join(", ")}`);
    let filter = body.filter;
    if (!filter && body.segmentId) {
      const seg = await prisma.customerSegment.findUnique({ where: { id: body.segmentId } });
      if (!seg) throw notFound("Không tìm thấy nhóm khách");
      filter = parseSegmentFilter(seg.filter);
    }
    if (!filter) throw new HttpError(400, "Chọn nhóm khách hoặc bộ lọc");
    assertBranchAllowed(req, filter);
    const me = currentUser(req);
    const members = await resolveSegment(filter, { branchIds: branchScope(req) });
    if (!members.length) throw new HttpError(400, "Nhóm khách không có ai");

    const broadcast = await prisma.broadcast.create({
      data: {
        name: body.name,
        branchId: filter.branchId ?? me.activeBranchId,
        segmentId: body.segmentId ?? null,
        filter: JSON.stringify(filter),
        template: body.template,
        total: members.length,
        createdById: me.id,
        createdByName: me.name,
      },
    });
    await prisma.broadcastRecipient.createMany({
      data: members.map((m) => ({
        broadcastId: broadcast.id,
        customerId: m.id,
        status: m.optOut ? RecipientStatus.SKIPPED_OPT_OUT : RecipientStatus.PENDING,
      })),
    });
    const optOut = members.filter((m) => m.optOut).length;
    await writeAudit({
      req,
      action: AuditAction.CREATE,
      entity: "Broadcast",
      entityId: broadcast.id,
      summary: `Tạo đợt gửi "${broadcast.name}" cho ${members.length} khách (${optOut} từ chối nhận tin)`,
    });
    res.status(201).json({ ...broadcast, queued: members.length - optOut, optOut });
  })
);

router.get(
  "/broadcasts/:id/recipients",
  requirePermission("inbox.broadcast"),
  asyncHandler(async (req, res) => {
    const b = await prisma.broadcast.findUnique({ where: { id: req.params.id } });
    if (!b) throw notFound();
    const page = parsePagination(req.query, { defaultLimit: 100, maxLimit: 500 });
    const where = { broadcastId: b.id, ...(req.query.status ? { status: String(req.query.status) } : {}) };
    const [rows, total] = await Promise.all([
      prisma.broadcastRecipient.findMany({ where, orderBy: { createdAt: "asc" }, take: page.take, skip: page.skip }),
      prisma.broadcastRecipient.count({ where }),
    ]);
    const customers = await prisma.customer.findMany({
      where: { id: { in: rows.map((r) => r.customerId) } },
      select: { id: true, code: true, name: true, phone: true },
    });
    const byId = new Map(customers.map((c) => [c.id, { ...c, phone: phoneFor(req, c.phone) }]));
    res.json({ total, items: rows.map((r) => ({ ...r, customer: byId.get(r.customerId) ?? null })) });
  })
);

router.post(
  "/broadcasts/:id/cancel",
  requirePermission("inbox.broadcast"),
  asyncHandler(async (req, res) => {
    const b = await prisma.broadcast.findUnique({ where: { id: req.params.id } });
    if (!b) throw notFound();
    if (b.status === BroadcastStatus.DONE || b.status === BroadcastStatus.CANCELLED) throw new HttpError(409, "Đợt gửi đã kết thúc");
    const r = await prisma.broadcastRecipient.updateMany({
      where: { broadcastId: b.id, status: RecipientStatus.PENDING },
      data: { status: RecipientStatus.CANCELLED },
    });
    await prisma.broadcast.update({ where: { id: b.id }, data: { status: BroadcastStatus.CANCELLED, finishedAt: new Date() } });
    await writeAudit({ req, action: AuditAction.UPDATE, entity: "Broadcast", entityId: b.id, summary: `Dừng đợt gửi "${b.name}", huỷ ${r.count} tin chưa gửi` });
    res.json({ ok: true, cancelled: r.count });
  })
);

// ------------------------------------------------------- KHÁCH TỪ CHỐI NHẬN TIN

/** POST /api/outreach/customers/:id/opt-out { optOut, reason } */
router.post(
  "/customers/:id/opt-out",
  requirePermission("customer.update"),
  asyncHandler(async (req, res) => {
    const body = z.object({ optOut: z.boolean(), reason: z.string().trim().max(300).optional() }).parse(req.body);
    const before = await prisma.customer.findUnique({ where: { id: req.params.id } });
    assertInScope(req, "customer.update", before as unknown as Record<string, unknown>, {
      ownerFields: ["assignedToId", "telesaleId"],
      branchField: null,
    });
    const me = currentUser(req);
    const c = await prisma.customer.update({
      where: { id: before!.id },
      data: {
        optOut: body.optOut,
        optOutAt: body.optOut ? new Date() : null,
        optOutReason: body.optOut ? (body.reason ?? null) : null,
        activities: {
          create: {
            type: ActivityType.SYSTEM,
            content: `${me.name} ghi nhận khách ${body.optOut ? "TỪ CHỐI" : "đồng ý lại"} nhận tin gửi theo nhóm${body.reason ? `: ${body.reason}` : ""}`,
            userId: me.id,
            userName: me.name,
          },
        },
      },
    });
    // Khách từ chối: bỏ luôn các tin đang chờ gửi.
    if (body.optOut) {
      await prisma.broadcastRecipient.updateMany({
        where: { customerId: c.id, status: RecipientStatus.PENDING },
        data: { status: RecipientStatus.SKIPPED_OPT_OUT },
      });
    }
    await writeAudit({
      req,
      action: AuditAction.UPDATE,
      entity: "Customer",
      entityId: c.id,
      summary: `Khách ${c.code} ${body.optOut ? "từ chối" : "đồng ý lại"} nhận tin theo nhóm`,
      changes: { optOut: [before!.optOut, body.optOut] },
    });
    res.json({ id: c.id, optOut: c.optOut, optOutAt: c.optOutAt });
  })
);

export default router;
