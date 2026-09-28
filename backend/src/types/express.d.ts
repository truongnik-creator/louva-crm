import type { PermissionScope } from "./enums";

/** Quyền hiệu lực của phiên hiện tại: mã quyền -> phạm vi rộng nhất được cấp. */
export type EffectivePermissions = Record<string, PermissionScope>;

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  /** Mã vai trò đã gán (Role.code), dùng cho hiển thị và vài lối tắt nghiệp vụ. */
  roles: string[];
  /** Cơ sở người dùng thuộc về. */
  branchIds: string[];
  /** Cơ sở đang thao tác — lấy từ header X-Branch-Id, mặc định cơ sở chính. */
  activeBranchId: string | null;
  permissions: EffectivePermissions;
  sessionId: string;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
      /** RAW body của webhook, giữ nguyên byte để xác thực HMAC. */
      rawBody?: Buffer;
    }
  }
}

export {};
