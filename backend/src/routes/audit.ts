import { Router } from "express";
import { prisma } from "../lib/prisma";
import { pageQuery, parsePagination } from "../lib/pagination";
import { asyncHandler } from "../middleware/errorHandler";
import { requireAuth, currentUser } from "../middleware/auth";
import { requirePermission, scopeOf } from "../middleware/rbac";
import { PermissionScope } from "../types/enums";

// Nhật ký hệ thống — màn "Nhật ký hệ thống".
//
// Hai sổ tách bạch, và DataAccessLog CHỈ quản trị hệ thống / giám đốc mới đọc
// được (mục 4.3, dòng E4b): nó cho biết ai đã xem bệnh án của ai.

const router = Router();
router.use(requireAuth);

router.get(
  "/logs",
  requirePermission("audit.read"),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const scope = scopeOf(req, "audit.read");

    const where: Record<string, unknown> = {};
    if (scope !== PermissionScope.ALL) where.branchId = { in: me.branchIds };
    if (req.query.entity) where.entity = String(req.query.entity);
    if (req.query.entityId) where.entityId = String(req.query.entityId);
    if (req.query.actorId) where.actorId = String(req.query.actorId);
    if (req.query.action) where.action = String(req.query.action);
    if (req.query.from || req.query.to) {
      where.createdAt = {
        ...(req.query.from ? { gte: new Date(String(req.query.from)) } : {}),
        ...(req.query.to ? { lt: new Date(String(req.query.to)) } : {}),
      };
    }

    const { take, skip } = parsePagination(req.query, { defaultLimit: 100, maxLimit: 500 });
    const [items, total] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take,
        skip,
        include: { branch: { select: { code: true, shortName: true } } },
      }),
      prisma.auditLog.count({ where }),
    ]);

    res.json({
      total,
      items: items.map((i) => ({ ...i, changes: i.changes ? JSON.parse(i.changes) : null })),
    });
  })
);

/**
 * GET /api/audit/data-access — ai đã đọc bệnh án / ảnh / SĐT của ai.
 * Đây là sổ nhạy cảm nhất trong hệ thống nên không dùng chung quyền với
 * AuditLog: phải có `settings.read` phạm vi ALL (quản trị hệ thống, giám đốc).
 */
router.get(
  "/data-access",
  requirePermission("audit.read"),
  asyncHandler(async (req, res) => {
    const scope = scopeOf(req, "audit.read");
    if (scope !== PermissionScope.ALL) {
      return res.status(403).json({ error: "Chỉ quản trị hệ thống và giám đốc đọc được nhật ký truy cập" });
    }

    const where: Record<string, unknown> = {};
    if (req.query.customerId) where.customerId = String(req.query.customerId);
    if (req.query.actorId) where.actorId = String(req.query.actorId);
    if (req.query.severity) where.severity = String(req.query.severity);
    if (req.query.resourceType) where.resourceType = String(req.query.resourceType);
    if (req.query.from || req.query.to) {
      where.createdAt = {
        ...(req.query.from ? { gte: new Date(String(req.query.from)) } : {}),
        ...(req.query.to ? { lt: new Date(String(req.query.to)) } : {}),
      };
    }

    const [items, total] = await Promise.all([
      prisma.dataAccessLog.findMany({
        where,
        orderBy: { createdAt: "desc" },
        ...pageQuery(req.query, { defaultLimit: 100, maxLimit: 500 }),
        include: { customer: { select: { id: true, name: true, code: true } } },
      }),
      prisma.dataAccessLog.count({ where }),
    ]);

    res.json({ total, items });
  })
);

// GET /api/audit/notifications — thông báo của chính mình
router.get(
  "/notifications",
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const items = await prisma.notification.findMany({
      where: { userId: me.id, ...(req.query.unread === "1" ? { readAt: null } : {}) },
      orderBy: { createdAt: "desc" },
      ...pageQuery(req.query, { defaultLimit: 50, maxLimit: 200 }),
    });
    const unread = await prisma.notification.count({ where: { userId: me.id, readAt: null } });
    res.json({ items, unread });
  })
);

router.post(
  "/notifications/read",
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    await prisma.notification.updateMany({
      where: { userId: me.id, readAt: null },
      data: { readAt: new Date() },
    });
    res.json({ ok: true });
  })
);

export default router;
