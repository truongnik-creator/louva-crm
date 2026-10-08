import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { pageQuery, CATALOG_PAGE } from "../lib/pagination";
import { asyncHandler, HttpError } from "../middleware/errorHandler";
import { requireAuth, currentUser } from "../middleware/auth";
import {
  issueSession,
  rotateSession,
  revokeSession,
  revokeAllSessions,
  loadEffectivePermissions,
  SessionError,
} from "../lib/session";
import { writeAudit } from "../lib/audit";
import { AuditAction, UserStatus } from "../types/enums";
import { getSettingNumber } from "../lib/settings-catalog";

const router = Router();

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

async function publicProfile(userId: string) {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      name: true,
      title: true,
      phone: true,
      status: true,
      mustChangePassword: true,
      department: { select: { id: true, name: true } },
      roleLinks: { select: { role: { select: { code: true, name: true } } } },
      branches: {
        select: {
          isPrimary: true,
          branch: { select: { id: true, code: true, name: true, shortName: true } },
        },
      },
    },
  });

  return {
    id: user.id,
    email: user.email,
    name: user.name,
    title: user.title,
    phone: user.phone,
    mustChangePassword: user.mustChangePassword,
    department: user.department,
    roles: user.roleLinks.map((l) => l.role),
    branches: user.branches.map((b) => ({ ...b.branch, isPrimary: b.isPrimary })),
    permissions: await loadEffectivePermissions(user.id),
  };
}

function clientMeta(req: Parameters<typeof requireAuth>[0]) {
  return { userAgent: req.headers["user-agent"] ?? null, ipAddress: req.ip ?? null };
}

// POST /api/auth/login
router.post(
  "/login",
  asyncHandler(async (req, res) => {
    const { email, password } = loginSchema.parse(req.body);

    const user = await prisma.user.findUnique({
      where: { email },
      select: {
        id: true,
        name: true,
        passwordHash: true,
        status: true,
        failedLoginCount: true,
        lockedUntil: true,
      },
    });

    // Cùng một thông báo cho "sai email" và "sai mật khẩu" — không để kẻ tấn
    // công dò xem địa chỉ nào có tài khoản.
    const invalid = new HttpError(401, "Email hoặc mật khẩu không đúng");

    if (!user) {
      await writeAudit({
        req,
        action: AuditAction.LOGIN_FAILED,
        entity: "User",
        summary: `Đăng nhập thất bại: không có tài khoản ${email}`,
        actorName: email,
      });
      throw invalid;
    }

    // S6: tài khoản đang bị khoá tạm thì từ chối TRƯỚC khi so mật khẩu, để kẻ
    // dò mật khẩu không biết được lượt đoán nào là đúng.
    if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
      const minutes = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60000);
      throw new HttpError(
        423,
        `Tài khoản đang tạm khoá do nhập sai mật khẩu nhiều lần. Thử lại sau ${minutes} phút hoặc nhờ quản trị đặt lại mật khẩu.`
      );
    }

    if (!(await bcrypt.compare(password, user.passwordHash))) {
      const maxAttempts = await getSettingNumber("security.loginMaxAttempts");
      const lockMinutes = await getSettingNumber("security.loginLockMinutes");
      const failed = user.failedLoginCount + 1;
      const lock = failed >= maxAttempts;
      await prisma.user.update({
        where: { id: user.id },
        data: lock
          ? { failedLoginCount: 0, lockedUntil: new Date(Date.now() + lockMinutes * 60000) }
          : { failedLoginCount: failed },
      });
      if (lock) {
        await writeAudit({
          req,
          action: AuditAction.ACCOUNT_LOCKED,
          entity: "User",
          entityId: user.id,
          summary: `Khoá tạm ${lockMinutes} phút tài khoản ${email} sau ${failed} lần nhập sai mật khẩu`,
          actorId: user.id,
          actorName: user.name,
        });
      }
      await writeAudit({
        req,
        action: AuditAction.LOGIN_FAILED,
        entity: "User",
        entityId: user.id,
        summary: `Đăng nhập thất bại: sai mật khẩu (${email})`,
        actorId: user.id,
        actorName: user.name,
      });
      throw invalid;
    }

    if (user.status !== UserStatus.ACTIVE) {
      throw new HttpError(403, "Tài khoản đã bị khoá hoặc đã nghỉ việc");
    }

    const session = await issueSession(user.id, clientMeta(req));
    await prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date(), failedLoginCount: 0, lockedUntil: null },
    });
    await writeAudit({
      req,
      action: AuditAction.LOGIN,
      entity: "User",
      entityId: user.id,
      summary: `${user.name} đăng nhập`,
      actorId: user.id,
      actorName: user.name,
    });

    res.json({
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
      user: await publicProfile(user.id),
    });
  })
);

// POST /api/auth/refresh — xoay vòng refresh token
router.post(
  "/refresh",
  asyncHandler(async (req, res) => {
    const { refreshToken } = z.object({ refreshToken: z.string().min(1) }).parse(req.body);
    try {
      const session = await rotateSession(refreshToken, clientMeta(req));
      res.json({ accessToken: session.accessToken, refreshToken: session.refreshToken });
    } catch (err) {
      if (err instanceof SessionError) throw new HttpError(401, err.message);
      throw err;
    }
  })
);

// GET /api/auth/me
router.get(
  "/me",
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json(await publicProfile(currentUser(req).id));
  })
);

// POST /api/auth/logout
router.post(
  "/logout",
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    await revokeSession(user.sessionId, "Người dùng đăng xuất");
    await writeAudit({
      req,
      action: AuditAction.LOGOUT,
      entity: "User",
      entityId: user.id,
      summary: `${user.name} đăng xuất`,
    });
    res.json({ ok: true });
  })
);

// POST /api/auth/logout-all — dùng khi nghi ngờ lộ token
router.post(
  "/logout-all",
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const count = await revokeAllSessions(user.id, "Người dùng thu hồi mọi phiên");
    await writeAudit({
      req,
      action: AuditAction.LOGOUT,
      entity: "User",
      entityId: user.id,
      summary: `${user.name} thu hồi toàn bộ ${count} phiên`,
    });
    res.json({ ok: true, revoked: count });
  })
);

// GET /api/auth/sessions — người dùng tự thấy phiên đang mở của mình
router.get(
  "/sessions",
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const sessions = await prisma.authSession.findMany({
      ...pageQuery(req.query, CATALOG_PAGE),
      where: { userId: user.id, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { lastUsedAt: "desc" },
      select: { id: true, userAgent: true, ipAddress: true, createdAt: true, lastUsedAt: true },
    });
    res.json(sessions.map((s) => ({ ...s, current: s.id === user.sessionId })));
  })
);

// POST /api/auth/change-password
router.post(
  "/change-password",
  requireAuth,
  asyncHandler(async (req, res) => {
    const body = z
      .object({ currentPassword: z.string().min(1), newPassword: z.string().min(8) })
      .parse(req.body);

    const me = currentUser(req);
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: me.id },
      select: { passwordHash: true },
    });
    if (!(await bcrypt.compare(body.currentPassword, user.passwordHash))) {
      throw new HttpError(400, "Mật khẩu hiện tại không đúng");
    }

    await prisma.user.update({
      where: { id: me.id },
      data: {
        passwordHash: await bcrypt.hash(body.newPassword, 10),
        mustChangePassword: false,
      },
    });

    // Đổi mật khẩu là cắt mọi phiên khác — phiên hiện tại giữ lại để người
    // dùng không bị đá ra ngay giữa chừng.
    await prisma.authSession.updateMany({
      where: { userId: me.id, revokedAt: null, id: { not: me.sessionId } },
      data: { revokedAt: new Date(), revokedReason: "Đổi mật khẩu" },
    });

    await writeAudit({
      req,
      action: AuditAction.UPDATE,
      entity: "User",
      entityId: me.id,
      summary: `${me.name} đổi mật khẩu`,
    });

    res.json({ ok: true });
  })
);

export default router;
