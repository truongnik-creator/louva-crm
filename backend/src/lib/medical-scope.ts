import type { Request } from "express";
import { prisma } from "./prisma";
import { env } from "./env";
import { getSettingNumber } from "./settings-catalog";
import { currentUser } from "../middleware/auth";
import { notFound, scopeOf } from "../middleware/rbac";
import { PermissionScope, AccessResourceType, AccessSeverity, AuditAction } from "../types/enums";
import { writeAccessLog, writeAudit } from "./audit";

// Quy tắc quan trọng nhất của mô hình đa cơ sở (mục 4.2):
//
//   Customer      -> LIÊN THÔNG toàn công ty (để bán chéo sản <-> thẩm mỹ)
//   Bệnh án, ảnh, cam kết, phiếu mổ -> CÁCH LY THEO CƠ SỞ, không liên thông.
//
// Muốn xem chéo cơ sở phải "break-glass": nêu lý do, quyền cấp trong 30 phút,
// ghi DataAccessLog mức CRITICAL. Phạm vi ALL KHÔNG tự động mở cửa bệnh án —
// kể cả quản trị hệ thống cũng phải break-glass.

/** Danh sách cơ sở người dùng được đọc bệnh án ngay, không cần break-glass. */
export function medicalBranchIds(req: Request): string[] {
  return currentUser(req).branchIds;
}

export async function hasActiveBreakGlass(userId: string, customerId: string): Promise<boolean> {
  const grant = await prisma.breakGlassGrant.findFirst({
    where: { userId, customerId, expiresAt: { gt: new Date() } },
    select: { id: true },
  });
  return Boolean(grant);
}

/**
 * Cổng truy cập bệnh án. Trả về danh sách branchId hợp lệ cho truy vấn, hoặc
 * ném 404 khi vượt phạm vi. Nếu người dùng đang có lượt break-glass còn hiệu
 * lực với khách này thì mở toàn bộ cơ sở và ghi log mức CRITICAL.
 */
export async function resolveMedicalScope(
  req: Request,
  customerId: string,
  permissionCode = "medical.read"
): Promise<{ branchIds: string[] | null; viaBreakGlass: boolean }> {
  const user = currentUser(req);
  const scope = scopeOf(req, permissionCode);
  if (!scope) throw notFound();

  if (await hasActiveBreakGlass(user.id, customerId)) {
    return { branchIds: null, viaBreakGlass: true };
  }

  // Phạm vi ALL vẫn bị giới hạn ở cơ sở mình thuộc về đối với dữ liệu y khoa.
  const allowed = scope === PermissionScope.ALL ? user.branchIds : user.branchIds;
  if (!allowed.length) throw notFound();
  return { branchIds: allowed, viaBreakGlass: false };
}

/** Nạp bệnh án đúng phạm vi và ghi DataAccessLog — dùng cho mọi route đọc bệnh án. */
export async function loadMedicalRecord(req: Request, customerId: string, branchId?: string) {
  const { branchIds, viaBreakGlass } = await resolveMedicalScope(req, customerId);

  const record = await prisma.medicalRecord.findFirst({
    where: {
      customerId,
      ...(branchId ? { branchId } : {}),
      ...(branchIds ? { branchId: { in: branchIds } } : {}),
    },
  });
  if (!record) throw notFound("Không tìm thấy bệnh án");

  await writeAccessLog({
    req,
    customerId,
    branchId: record.branchId,
    resourceType: AccessResourceType.MEDICAL_RECORD,
    resourceId: record.id,
    severity: viaBreakGlass ? AccessSeverity.CRITICAL : AccessSeverity.NORMAL,
  });

  return record;
}

/**
 * Cấp một lượt break-glass. Ghi cả AuditLog (BREAK_GLASS) lẫn DataAccessLog
 * mức CRITICAL, đồng thời bắn thông báo cho Giám đốc chuyên môn.
 */
export async function grantBreakGlass(req: Request, customerId: string, reason: string) {
  const user = currentUser(req);
  // Thời hạn lấy từ Cài đặt hệ thống; biến môi trường chỉ còn là giá trị dự
  // phòng khi chưa ai đặt tham số.
  const minutes = (await getSettingNumber("security.breakGlassMinutes")) || env.breakGlassMinutes;
  const expiresAt = new Date(Date.now() + minutes * 60 * 1000);

  const grant = await prisma.breakGlassGrant.create({
    data: { userId: user.id, customerId, branchId: user.activeBranchId, reason, expiresAt },
  });

  await writeAudit({
    req,
    action: AuditAction.BREAK_GLASS,
    entity: "MedicalRecord",
    entityId: customerId,
    summary: `${user.name} mở quyền khẩn cấp xem bệnh án tới ${expiresAt.toLocaleString("vi-VN")} — lý do: ${reason}`,
  });
  await writeAccessLog({
    req,
    customerId,
    resourceType: AccessResourceType.MEDICAL_RECORD,
    severity: AccessSeverity.CRITICAL,
    reason,
  });

  // Thông báo ngay cho những người được phép giám sát (mục 4.3, chú thích *).
  const supervisors = await prisma.user.findMany({
    where: {
      status: "ACTIVE",
      roleLinks: { some: { role: { code: { in: ["GIAM_DOC", "QUAN_LY_HE_THONG"] } } } },
      id: { not: user.id },
    },
    select: { id: true },
  });
  if (supervisors.length) {
    const customer = await prisma.customer.findUnique({
      where: { id: customerId },
      select: { name: true, code: true },
    });
    await prisma.notification.createMany({
      data: supervisors.map((s) => ({
        userId: s.id,
        title: "Truy cập bệnh án khẩn cấp (break-glass)",
        body: `${user.name} vừa mở quyền xem bệnh án của ${customer?.name ?? customerId} (${customer?.code ?? ""}). Lý do: ${reason}`,
        level: "DANGER",
        link: `/khach-hang/${customerId}`,
      })),
    });
  }

  return grant;
}
