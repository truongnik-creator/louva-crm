import type { Request } from "express";
import { logger } from "./logger";
import { prisma } from "./prisma";
import { AuditAction, AccessResourceType, AccessSeverity } from "../types/enums";

// Hai sổ tách bạch (mục 6.6 tài liệu kiến trúc):
//   - AuditLog      ghi MỌI THAY ĐỔI dữ liệu và sự kiện đăng nhập.
//   - DataAccessLog ghi HÀNH VI ĐỌC dữ liệu nhạy cảm: bệnh án, ảnh, số điện
//                   thoại, cam kết, và mọi lần xuất dữ liệu.
//
// Cả hai đều "ghi không chặn": lỗi ghi log không được làm hỏng nghiệp vụ,
// nhưng phải in ra để giám sát nhận biết.

function clientInfo(req?: Request) {
  return {
    ipAddress: req?.ip ?? null,
    userAgent: req?.headers["user-agent"] ?? null,
  };
}

export interface AuditInput {
  req?: Request;
  action: AuditAction;
  entity: string;
  entityId?: string | null;
  summary: string;
  branchId?: string | null;
  changes?: Record<string, [unknown, unknown]> | null;
  /** Ghi đè actor khi hành động không đến từ một phiên đăng nhập (webhook, job). */
  actorId?: string | null;
  actorName?: string | null;
}

export async function writeAudit(input: AuditInput): Promise<void> {
  const { ipAddress, userAgent } = clientInfo(input.req);
  try {
    await prisma.auditLog.create({
      data: {
        actorId: input.actorId ?? input.req?.user?.id ?? null,
        actorName: input.actorName ?? input.req?.user?.name ?? null,
        branchId: input.branchId ?? input.req?.user?.activeBranchId ?? null,
        action: input.action,
        entity: input.entity,
        entityId: input.entityId ?? null,
        summary: input.summary,
        changes: input.changes ? JSON.stringify(input.changes) : null,
        ipAddress,
        userAgent: typeof userAgent === "string" ? userAgent : null,
      },
    });
  } catch (err) {
    logger.error({ err }, "[audit] không ghi được AuditLog:");
  }
}

export interface AccessInput {
  req?: Request;
  customerId?: string | null;
  resourceType: AccessResourceType;
  resourceId?: string | null;
  severity?: AccessSeverity;
  reason?: string | null;
  rowCount?: number | null;
  branchId?: string | null;
}

export async function writeAccessLog(input: AccessInput): Promise<void> {
  try {
    await prisma.dataAccessLog.create({
      data: {
        actorId: input.req?.user?.id ?? null,
        actorName: input.req?.user?.name ?? null,
        branchId: input.branchId ?? input.req?.user?.activeBranchId ?? null,
        customerId: input.customerId ?? null,
        resourceType: input.resourceType,
        resourceId: input.resourceId ?? null,
        severity: input.severity ?? AccessSeverity.NORMAL,
        reason: input.reason ?? null,
        rowCount: input.rowCount ?? null,
        ipAddress: input.req?.ip ?? null,
      },
    });
  } catch (err) {
    logger.error({ err }, "[audit] không ghi được DataAccessLog:");
  }
}

/**
 * So sánh bản ghi trước/sau, chỉ giữ những trường thực sự đổi — để AuditLog
 * đọc được thay vì chép nguyên hai bản ghi.
 */
export function diffFields<T extends Record<string, unknown>>(
  before: T,
  after: Partial<T>
): Record<string, [unknown, unknown]> | null {
  const changes: Record<string, [unknown, unknown]> = {};
  for (const [k, v] of Object.entries(after)) {
    const prev = before[k];
    const same =
      prev instanceof Date && v instanceof Date ? prev.getTime() === v.getTime() : prev === v;
    if (!same) changes[k] = [prev ?? null, v ?? null];
  }
  return Object.keys(changes).length ? changes : null;
}
