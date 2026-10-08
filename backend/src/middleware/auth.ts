import { Request, Response, NextFunction } from "express";
import { prisma } from "../lib/prisma";
import { verifyAccessToken, loadEffectivePermissions } from "../lib/session";
import { UserStatus } from "../types/enums";
import type { AuthUser } from "../types/express";

/**
 * Cổng 0 — xác thực. Access token phải còn hạn VÀ phiên tương ứng phải còn
 * sống: đó là điểm khác biệt với JWT thuần, nhờ đó vô hiệu hoá tài khoản là
 * cắt quyền ngay lập tức chứ không phải chờ token hết hạn.
 *
 * Cơ sở đang thao tác lấy từ header `X-Branch-Id`; nếu không gửi hoặc gửi cơ
 * sở người dùng không thuộc thì rơi về cơ sở chính.
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Thiếu hoặc sai header Authorization" });
  }

  let payload: { sub: string; sid: string };
  try {
    payload = verifyAccessToken(header.slice("Bearer ".length));
  } catch {
    return res.status(401).json({ error: "Token không hợp lệ hoặc đã hết hạn" });
  }

  const session = await prisma.authSession.findUnique({
    where: { id: payload.sid },
    select: { id: true, userId: true, revokedAt: true, expiresAt: true },
  });
  if (!session || session.revokedAt || session.expiresAt.getTime() < Date.now()) {
    return res.status(401).json({ error: "Phiên làm việc đã bị thu hồi hoặc hết hạn" });
  }

  const user = await prisma.user.findUnique({
    where: { id: payload.sub },
    select: {
      id: true,
      email: true,
      name: true,
      status: true,
      mustChangePassword: true,
      roleLinks: { select: { role: { select: { code: true } } } },
      branches: { select: { branchId: true, isPrimary: true } },
    },
  });
  if (!user) return res.status(401).json({ error: "Tài khoản không tồn tại" });
  if (user.status !== UserStatus.ACTIVE) {
    return res.status(403).json({ error: "Tài khoản đã bị khoá hoặc đã nghỉ việc" });
  }

  // S1: tài khoản dùng mật khẩu tạm (seed, quản trị cấp) phải đổi mật khẩu
  // trước khi làm bất cứ việc gì. Chỉ mở các đường /api/auth/* (xem hồ sơ,
  // đổi mật khẩu, đăng xuất).
  if (user.mustChangePassword && !req.originalUrl.startsWith("/api/auth/")) {
    return res.status(403).json({
      error: "Bắt buộc đổi mật khẩu trước khi tiếp tục làm việc.",
      code: "MUST_CHANGE_PASSWORD",
    });
  }

  const branchIds = user.branches.map((b) => b.branchId);
  const primaryBranch = user.branches.find((b) => b.isPrimary)?.branchId ?? branchIds[0] ?? null;
  const requested = req.header("X-Branch-Id");

  const authUser: AuthUser = {
    id: user.id,
    email: user.email,
    name: user.name,
    roles: user.roleLinks.map((l) => l.role.code),
    branchIds,
    activeBranchId: requested && branchIds.includes(requested) ? requested : primaryBranch,
    permissions: await loadEffectivePermissions(user.id),
    sessionId: session.id,
  };

  req.user = authUser;

  // Cập nhật mốc dùng gần nhất, không chặn luồng trả lời.
  prisma.authSession
    .update({ where: { id: session.id }, data: { lastUsedAt: new Date() } })
    .catch(() => undefined);

  return next();
}

/** Lối tắt cho các handler đã chắc chắn đi sau requireAuth. */
export function currentUser(req: Request): AuthUser {
  if (!req.user) throw new Error("currentUser() gọi khi chưa qua requireAuth");
  return req.user;
}
