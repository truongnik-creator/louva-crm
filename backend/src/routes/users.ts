import { Router } from "express";
import bcrypt from "bcrypt";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { asyncHandler, HttpError } from "../middleware/errorHandler";
import { requireAuth, currentUser } from "../middleware/auth";
import { requirePermission, scopeOf, notFound } from "../middleware/rbac";
import { writeAudit, diffFields } from "../lib/audit";
import { revokeAllSessions } from "../lib/session";
import { AuditAction, PermissionScope, UserStatus } from "../types/enums";
import { PERMISSIONS } from "../lib/rbac-catalog";

// Người dùng, vai trò, phân quyền, bàn giao khách — màn "Người dùng & Phân quyền".

const router = Router();
router.use(requireAuth);

const userSelect = {
  id: true,
  email: true,
  name: true,
  phone: true,
  title: true,
  status: true,
  lastLoginAt: true,
  createdAt: true,
  department: { select: { id: true, name: true } },
  roleLinks: { select: { role: { select: { id: true, code: true, name: true } } } },
  branches: { select: { isPrimary: true, branch: { select: { id: true, code: true, name: true } } } },
} as const;

type RawUser = Awaited<ReturnType<typeof prisma.user.findFirstOrThrow<{ select: typeof userSelect }>>>;

function shapeUser(u: RawUser) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    phone: u.phone,
    title: u.title,
    status: u.status,
    lastLoginAt: u.lastLoginAt,
    createdAt: u.createdAt,
    department: u.department,
    roles: u.roleLinks.map((l) => l.role),
    branches: u.branches.map((b) => ({ ...b.branch, isPrimary: b.isPrimary })),
  };
}

// GET /api/users — quản lý cơ sở chỉ thấy người trong cơ sở mình
router.get(
  "/",
  requirePermission("hr.read"),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const scope = scopeOf(req, "hr.read");
    const q = (req.query.q as string) ?? "";

    const where: Record<string, unknown> = {};
    if (scope !== PermissionScope.ALL) {
      where.branches = { some: { branchId: { in: me.branchIds } } };
    }
    if (scope === PermissionScope.OWN) where.id = me.id;
    if (q) where.OR = [{ name: { contains: q } }, { email: { contains: q } }];
    if (req.query.status) where.status = String(req.query.status);
    if (req.query.roleCode) where.roleLinks = { some: { role: { code: String(req.query.roleCode) } } };

    const users = await prisma.user.findMany({ where, select: userSelect, orderBy: { name: "asc" } });
    res.json(users.map(shapeUser));
  })
);

const createUserSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().min(2),
  phone: z.string().optional(),
  title: z.string().optional(),
  departmentId: z.string().uuid().nullable().optional(),
  roleIds: z.array(z.string().uuid()).min(1),
  branchIds: z.array(z.string().uuid()).min(1),
  primaryBranchId: z.string().uuid().optional(),
});

router.post(
  "/",
  requirePermission("hr.create"),
  asyncHandler(async (req, res) => {
    const body = createUserSchema.parse(req.body);
    const me = currentUser(req);

    // Không cho tạo người dùng ở cơ sở mình không quản lý.
    if (scopeOf(req, "hr.create") !== PermissionScope.ALL) {
      const outside = body.branchIds.filter((b) => !me.branchIds.includes(b));
      if (outside.length) throw new HttpError(403, "Không thể gán người dùng vào cơ sở ngoài phạm vi");
    }

    if (await prisma.user.findUnique({ where: { email: body.email }, select: { id: true } })) {
      throw new HttpError(409, "Email đã được sử dụng");
    }

    const primary = body.primaryBranchId ?? body.branchIds[0];
    const user = await prisma.user.create({
      data: {
        email: body.email,
        passwordHash: await bcrypt.hash(body.password, 10),
        name: body.name,
        phone: body.phone,
        title: body.title,
        departmentId: body.departmentId ?? null,
        mustChangePassword: true,
        roleLinks: { create: body.roleIds.map((roleId) => ({ roleId })) },
        branches: {
          create: body.branchIds.map((branchId) => ({ branchId, isPrimary: branchId === primary })),
        },
      },
      select: userSelect,
    });

    await writeAudit({
      req,
      action: AuditAction.CREATE,
      entity: "User",
      entityId: user.id,
      summary: `Tạo tài khoản ${user.name} (${user.email})`,
    });
    res.status(201).json(shapeUser(user));
  })
);

const updateUserSchema = z.object({
  name: z.string().min(2).optional(),
  phone: z.string().nullable().optional(),
  title: z.string().nullable().optional(),
  departmentId: z.string().uuid().nullable().optional(),
  status: z.nativeEnum(UserStatus).optional(),
  roleIds: z.array(z.string().uuid()).optional(),
  branchIds: z.array(z.string().uuid()).optional(),
  primaryBranchId: z.string().uuid().optional(),
});

router.patch(
  "/:id",
  requirePermission("hr.update"),
  asyncHandler(async (req, res) => {
    const body = updateUserSchema.parse(req.body);
    const before = await prisma.user.findUnique({ where: { id: req.params.id }, select: userSelect });
    if (!before) throw notFound("Không tìm thấy người dùng");

    const me = currentUser(req);
    if (scopeOf(req, "hr.update") !== PermissionScope.ALL) {
      const shares = before.branches.some((b) => me.branchIds.includes(b.branch.id));
      if (!shares) throw notFound();
    }

    const { roleIds, branchIds, primaryBranchId, ...scalar } = body;

    const user = await prisma.$transaction(async (tx) => {
      if (roleIds) {
        await tx.userRoleLink.deleteMany({ where: { userId: req.params.id } });
        await tx.userRoleLink.createMany({
          data: roleIds.map((roleId) => ({ userId: req.params.id, roleId })),
        });
      }
      if (branchIds) {
        const primary = primaryBranchId ?? branchIds[0];
        await tx.userBranch.deleteMany({ where: { userId: req.params.id } });
        await tx.userBranch.createMany({
          data: branchIds.map((branchId) => ({
            userId: req.params.id,
            branchId,
            isPrimary: branchId === primary,
          })),
        });
      }
      return tx.user.update({ where: { id: req.params.id }, data: scalar, select: userSelect });
    });

    // Đổi vai trò / cơ sở / trạng thái phải có hiệu lực NGAY, không chờ token
    // hết hạn — đây là điểm mấu chốt của yêu cầu "cắt quyền ngay" (mục 6.5).
    if (roleIds || branchIds || scalar.status) {
      await revokeAllSessions(req.params.id, "Thay đổi quyền hoặc trạng thái tài khoản");
    }

    await writeAudit({
      req,
      action: AuditAction.UPDATE,
      entity: "User",
      entityId: user.id,
      summary: `Sửa tài khoản ${user.name}`,
      changes: diffFields(before as unknown as Record<string, unknown>, scalar),
    });
    res.json(shapeUser(user));
  })
);

/**
 * POST /api/users/:id/deactivate
 * Nghỉ việc: khoá tài khoản, thu hồi mọi phiên, và bàn giao toàn bộ khách
 * đang phụ trách sang người khác — chống rò rỉ dữ liệu khách (mục 6.5).
 */
router.post(
  "/:id/deactivate",
  requirePermission("hr.update"),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        reason: z.string().min(3),
        handoverToUserId: z.string().uuid().optional(),
        status: z.enum([UserStatus.SUSPENDED, UserStatus.RESIGNED]).default(UserStatus.RESIGNED),
      })
      .parse(req.body);

    const target = await prisma.user.findUnique({
      where: { id: req.params.id },
      select: { id: true, name: true },
    });
    if (!target) throw notFound("Không tìm thấy người dùng");
    if (target.id === currentUser(req).id) {
      throw new HttpError(400, "Không thể tự vô hiệu hoá tài khoản của chính mình");
    }

    let handedOver = 0;
    await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: target.id },
        data: {
          status: body.status,
          resignedAt: body.status === UserStatus.RESIGNED ? new Date() : null,
        },
      });

      if (body.handoverToUserId) {
        const asConsultant = await tx.customer.updateMany({
          where: { assignedToId: target.id },
          data: { assignedToId: body.handoverToUserId },
        });
        const asTelesale = await tx.customer.updateMany({
          where: { telesaleId: target.id },
          data: { telesaleId: body.handoverToUserId },
        });
        await tx.conversation.updateMany({
          where: { assignedToId: target.id },
          data: { assignedToId: body.handoverToUserId },
        });
        await tx.lead.updateMany({
          where: { assignedToId: target.id, convertedCustomerId: null },
          data: { assignedToId: body.handoverToUserId },
        });
        handedOver = asConsultant.count + asTelesale.count;

        await tx.customerHandover.create({
          data: {
            fromUserId: target.id,
            toUserId: body.handoverToUserId,
            reason: body.reason,
            customerCount: handedOver,
          },
        });
      }
    });

    const revoked = await revokeAllSessions(target.id, `Vô hiệu hoá tài khoản: ${body.reason}`);

    await writeAudit({
      req,
      action: AuditAction.UPDATE,
      entity: "User",
      entityId: target.id,
      summary: `Vô hiệu hoá ${target.name} (${body.status}) — thu hồi ${revoked} phiên, bàn giao ${handedOver} khách. Lý do: ${body.reason}`,
    });

    res.json({ ok: true, revokedSessions: revoked, handedOverCustomers: handedOver });
  })
);

// POST /api/users/:id/reset-password — quản lý đặt lại mật khẩu tạm
router.post(
  "/:id/reset-password",
  requirePermission("hr.update"),
  asyncHandler(async (req, res) => {
    const { newPassword } = z.object({ newPassword: z.string().min(8) }).parse(req.body);
    const target = await prisma.user.findUnique({
      where: { id: req.params.id },
      select: { id: true, name: true },
    });
    if (!target) throw notFound("Không tìm thấy người dùng");

    await prisma.user.update({
      where: { id: target.id },
      data: { passwordHash: await bcrypt.hash(newPassword, 10), mustChangePassword: true },
    });
    await revokeAllSessions(target.id, "Quản trị đặt lại mật khẩu");

    await writeAudit({
      req,
      action: AuditAction.UPDATE,
      entity: "User",
      entityId: target.id,
      summary: `Đặt lại mật khẩu cho ${target.name}`,
    });
    res.json({ ok: true });
  })
);

// ------------------------------------------------------------------- ROLES

router.get(
  "/roles/all",
  requirePermission("settings.read"),
  asyncHandler(async (_req, res) => {
    const roles = await prisma.role.findMany({
      orderBy: { name: "asc" },
      include: {
        permissions: { select: { scope: true, permission: { select: { code: true, name: true } } } },
        _count: { select: { userLinks: true } },
      },
    });
    res.json(
      roles.map((r) => ({
        id: r.id,
        code: r.code,
        name: r.name,
        description: r.description,
        isSystem: r.isSystem,
        userCount: r._count.userLinks,
        permissions: r.permissions.map((p) => ({
          code: p.permission.code,
          name: p.permission.name,
          scope: p.scope,
        })),
      }))
    );
  })
);

// GET /api/users/permissions/all — danh mục quyền để dựng bảng phân quyền
router.get(
  "/permissions/all",
  requirePermission("settings.read"),
  asyncHandler(async (_req, res) => {
    const rows = await prisma.permission.findMany({ orderBy: [{ module: "asc" }, { code: "asc" }] });
    res.json({ permissions: rows, catalogSize: PERMISSIONS.length });
  })
);

// PUT /api/users/roles/:id/permissions — gán quyền + phạm vi
router.put(
  "/roles/:id/permissions",
  requirePermission("settings.update"),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        permissions: z.array(
          z.object({ code: z.string(), scope: z.nativeEnum(PermissionScope) })
        ),
      })
      .parse(req.body);

    const role = await prisma.role.findUnique({ where: { id: req.params.id } });
    if (!role) throw notFound("Không tìm thấy vai trò");

    const known = await prisma.permission.findMany({
      where: { code: { in: body.permissions.map((p) => p.code) } },
      select: { id: true, code: true },
    });
    const idByCode = new Map(known.map((k) => [k.code, k.id]));

    await prisma.$transaction(async (tx) => {
      await tx.rolePermission.deleteMany({ where: { roleId: role.id } });
      await tx.rolePermission.createMany({
        data: body.permissions
          .filter((p) => idByCode.has(p.code))
          .map((p) => ({ roleId: role.id, permissionId: idByCode.get(p.code)!, scope: p.scope })),
      });
    });

    // Quyền đổi thì mọi phiên của người mang vai trò này phải nạp lại.
    const holders = await prisma.userRoleLink.findMany({
      where: { roleId: role.id },
      select: { userId: true },
    });
    for (const h of holders) await revokeAllSessions(h.userId, `Vai trò ${role.code} đổi quyền`);

    await writeAudit({
      req,
      action: AuditAction.UPDATE,
      entity: "Role",
      entityId: role.id,
      summary: `Cập nhật quyền vai trò ${role.name}: ${body.permissions.length} quyền, ảnh hưởng ${holders.length} người dùng`,
    });

    res.json({ ok: true, affectedUsers: holders.length });
  })
);

// ---------------------------------------------------------------- HANDOVER

router.get(
  "/handovers/all",
  requirePermission("hr.read"),
  asyncHandler(async (_req, res) => {
    res.json(
      await prisma.customerHandover.findMany({
        orderBy: { createdAt: "desc" },
        take: 100,
        include: {
          fromUser: { select: { id: true, name: true } },
          toUser: { select: { id: true, name: true } },
        },
      })
    );
  })
);

router.post(
  "/handovers",
  requirePermission("customer.update"),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        fromUserId: z.string().uuid(),
        toUserId: z.string().uuid(),
        reason: z.string().min(3),
      })
      .parse(req.body);

    const moved = await prisma.customer.updateMany({
      where: { assignedToId: body.fromUserId },
      data: { assignedToId: body.toUserId },
    });
    const handover = await prisma.customerHandover.create({
      data: { ...body, customerCount: moved.count },
      include: {
        fromUser: { select: { id: true, name: true } },
        toUser: { select: { id: true, name: true } },
      },
    });

    await writeAudit({
      req,
      action: AuditAction.UPDATE,
      entity: "CustomerHandover",
      entityId: handover.id,
      summary: `Bàn giao ${moved.count} khách từ ${handover.fromUser?.name} sang ${handover.toUser.name}. Lý do: ${body.reason}`,
    });
    res.status(201).json(handover);
  })
);

export default router;
