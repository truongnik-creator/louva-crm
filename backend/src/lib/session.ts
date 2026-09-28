import jwt from "jsonwebtoken";
import { prisma } from "./prisma";
import { env } from "./env";
import { hashToken, randomToken } from "./crypto";
import { PermissionScope } from "../types/enums";
import type { EffectivePermissions } from "../types/express";

// Phiên làm việc thu hồi được (mục 3 Giai đoạn 1):
//   - access token JWT sống 15 phút, mang theo sessionId;
//   - refresh token ngẫu nhiên 7 ngày, CHỈ lưu hash, XOAY VÒNG mỗi lần refresh;
//   - dùng lại một refresh token đã bị thay thế => thu hồi cả chuỗi phiên đó
//     (dấu hiệu token bị đánh cắp).

export interface AccessTokenPayload {
  sub: string; // userId
  sid: string; // sessionId
}

export function signAccessToken(userId: string, sessionId: string): string {
  return jwt.sign({ sub: userId, sid: sessionId } satisfies AccessTokenPayload, env.jwtSecret, {
    expiresIn: env.accessTokenTtl,
  } as jwt.SignOptions);
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  return jwt.verify(token, env.jwtSecret) as AccessTokenPayload;
}

export interface IssuedSession {
  accessToken: string;
  refreshToken: string;
  sessionId: string;
  expiresAt: Date;
}

export async function issueSession(
  userId: string,
  meta: { userAgent?: string | null; ipAddress?: string | null } = {}
): Promise<IssuedSession> {
  const refreshToken = randomToken();
  const expiresAt = new Date(Date.now() + env.refreshTokenDays * 24 * 60 * 60 * 1000);

  const session = await prisma.authSession.create({
    data: {
      userId,
      refreshTokenHash: hashToken(refreshToken),
      userAgent: meta.userAgent ?? null,
      ipAddress: meta.ipAddress ?? null,
      expiresAt,
    },
  });

  return {
    accessToken: signAccessToken(userId, session.id),
    refreshToken,
    sessionId: session.id,
    expiresAt,
  };
}

export class SessionError extends Error {}

/**
 * Đổi refresh token lấy cặp token mới. Phát hiện tái sử dụng: nếu token gửi
 * lên thuộc một phiên đã có `replacedById`, nghĩa là ai đó đang dùng lại token
 * cũ — thu hồi toàn bộ phiên của người dùng đó.
 */
export async function rotateSession(
  refreshToken: string,
  meta: { userAgent?: string | null; ipAddress?: string | null } = {}
): Promise<IssuedSession> {
  const session = await prisma.authSession.findUnique({
    where: { refreshTokenHash: hashToken(refreshToken) },
  });

  if (!session) throw new SessionError("Refresh token không hợp lệ");

  if (session.replacedById) {
    await revokeAllSessions(session.userId, "Phát hiện tái sử dụng refresh token");
    throw new SessionError("Refresh token đã bị dùng lại — mọi phiên đã bị thu hồi");
  }
  if (session.revokedAt) throw new SessionError("Phiên đã bị thu hồi");
  if (session.expiresAt.getTime() < Date.now()) throw new SessionError("Phiên đã hết hạn");

  const next = await issueSession(session.userId, meta);
  await prisma.authSession.update({
    where: { id: session.id },
    data: { replacedById: next.sessionId, revokedAt: new Date(), revokedReason: "Xoay vòng" },
  });
  return next;
}

export async function revokeSession(sessionId: string, reason: string): Promise<void> {
  await prisma.authSession.updateMany({
    where: { id: sessionId, revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: reason },
  });
}

/** Dùng khi nhân viên nghỉ việc hoặc phát hiện token bị lộ. */
export async function revokeAllSessions(userId: string, reason: string): Promise<number> {
  const result = await prisma.authSession.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: reason },
  });
  return result.count;
}

const SCOPE_RANK: Record<string, number> = {
  [PermissionScope.OWN]: 1,
  [PermissionScope.BRANCH]: 2,
  [PermissionScope.ALL]: 3,
};

/**
 * Gộp quyền từ mọi vai trò của người dùng. Khi hai vai trò cùng cấp một quyền
 * với phạm vi khác nhau, giữ phạm vi RỘNG hơn.
 */
export async function loadEffectivePermissions(userId: string): Promise<EffectivePermissions> {
  const links = await prisma.userRoleLink.findMany({
    where: { userId },
    select: {
      role: {
        select: {
          permissions: { select: { scope: true, permission: { select: { code: true } } } },
        },
      },
    },
  });

  const effective: EffectivePermissions = {};
  for (const link of links) {
    for (const rp of link.role.permissions) {
      const code = rp.permission.code;
      const current = effective[code];
      if (!current || SCOPE_RANK[rp.scope] > SCOPE_RANK[current]) {
        effective[code] = rp.scope as PermissionScope;
      }
    }
  }
  return effective;
}
