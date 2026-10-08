import { prisma } from "./prisma";
import { HttpError } from "../middleware/errorHandler";
import { getSettingNumber } from "./settings-catalog";
import { formatDateVN, startOfVnDay } from "./datetime";
import { markOnce, registerJob } from "./jobs";
import {
  ActivityType,
  AppointmentStatus,
  ContractStatus,
  PackageStatus,
  TaskKind,
  TaskPriority,
  TaskStatus,
} from "../types/enums";

// Lô 8 · V3: GÓI LIỆU TRÌNH NHIỀU BUỔI TRẢ TRƯỚC.
//
// KẾ TOÁN (giữ nguyên chuẩn hiện có, không tự đổi):
//   - Gói bán qua HỢP ĐỒNG như mọi dịch vụ. Báo cáo doanh số hiện tại ghi theo
//     hợp đồng đã ký (signedAt, loại hợp đồng huỷ), nên giá trị cả gói vào doanh
//     số ngày ký, y như trước Lô 8.
//   - Tiền khách trả trước ghi THỰC THU khi thu (Payment.paidAt), y như trước.
//   - Hệ thống KHÔNG có khái niệm "doanh thu ghi nhận theo buổi thực hiện" trong
//     báo cáo tài chính. Gói chỉ theo dõi thêm "giá trị buổi đã dùng" và "phần trả
//     trước chưa thực hiện" để kế toán tham khảo, không đưa vào báo cáo doanh thu.
//
// Giá trị một buổi = giá gói chia đều cho số buổi, buổi cuối nhận phần dư, để
// tổng giá trị các buổi đúng bằng giá gói (tiền là số nguyên đồng).

export function sessionValue(price: number, totalSessions: number, sessionNo: number): number {
  const base = Math.floor(price / totalSessions);
  return sessionNo === totalSessions ? price - base * (totalSessions - 1) : base;
}

export function packageStats(p: { price: number; totalSessions: number; usedSessions: number }) {
  let used = 0;
  for (let i = 1; i <= p.usedSessions; i++) used += sessionValue(p.price, p.totalSessions, i);
  return { remainingSessions: p.totalSessions - p.usedSessions, usedValue: used, remainingValue: p.price - used };
}

export async function createPackage(input: {
  contractItemId: string;
  sessions?: number | null;
  intervalDays?: number | null;
  expiresAt?: Date | null;
  actor: { id: string; name: string };
}) {
  const item = await prisma.contractItem.findUnique({
    where: { id: input.contractItemId },
    include: { contract: { select: { id: true, status: true, customerId: true, branchId: true, code: true } } },
  });
  if (!item) throw new HttpError(404, "Không tìm thấy dòng hợp đồng");
  if (item.contract.status === ContractStatus.CANCELLED) throw new HttpError(409, "Hợp đồng đã huỷ, không lập gói được");
  const exists = await prisma.treatmentPackage.findUnique({ where: { contractItemId: item.id } });
  if (exists) throw new HttpError(409, "Dòng hợp đồng này đã có gói liệu trình");
  const total = input.sessions ?? item.quantity;
  if (!Number.isInteger(total) || total < 2) throw new HttpError(400, "Gói liệu trình phải có từ 2 buổi");
  let expiresAt = input.expiresAt ?? null;
  if (input.expiresAt === undefined) {
    const days = await getSettingNumber("package.defaultValidDays");
    expiresAt = days > 0 ? new Date(startOfVnDay(new Date()).getTime() + (days + 1) * 86_400_000 - 1000) : null;
  }
  const pkg = await prisma.treatmentPackage.create({
    data: {
      customerId: item.contract.customerId,
      branchId: item.contract.branchId,
      contractId: item.contract.id,
      contractItemId: item.id,
      serviceId: item.serviceId,
      name: item.name,
      totalSessions: total,
      price: item.amount,
      intervalDays: input.intervalDays ?? null,
      expiresAt,
      createdById: input.actor.id,
    },
  });
  await prisma.activity.create({
    data: {
      customerId: pkg.customerId,
      type: ActivityType.PACKAGE,
      content: `${input.actor.name} lập gói liệu trình "${pkg.name}" ${total} buổi từ hợp đồng ${item.contract.code}${expiresAt ? `, hạn dùng ${formatDateVN(expiresAt)}` : ""}`,
      userId: input.actor.id,
      userName: input.actor.name,
    },
  });
  return pkg;
}

export async function useSession(input: {
  packageId: string;
  procedureId?: string | null;
  visitId?: string | null;
  note?: string | null;
  usedAt?: Date;
  actor: { id: string; name: string };
}) {
  const now = input.usedAt ?? new Date();
  return prisma.$transaction(async (tx) => {
    const pkg = await tx.treatmentPackage.findUnique({ where: { id: input.packageId } });
    if (!pkg) throw new HttpError(404, "Không tìm thấy gói liệu trình");
    if (pkg.status !== PackageStatus.ACTIVE) throw new HttpError(409, pkg.status === PackageStatus.COMPLETED ? "Gói đã dùng hết buổi" : "Gói đã huỷ");
    if (pkg.expiresAt && pkg.expiresAt < now) throw new HttpError(409, `Gói đã hết hạn ngày ${formatDateVN(pkg.expiresAt)}`);
    if (pkg.usedSessions >= pkg.totalSessions) throw new HttpError(409, "Gói đã dùng hết buổi");
    if (input.procedureId) {
      const proc = await tx.procedureRecord.findUnique({ where: { id: input.procedureId }, select: { customerId: true } });
      if (!proc || proc.customerId !== pkg.customerId) throw new HttpError(400, "Lần thực hiện không thuộc khách của gói");
      const dup = await tx.packageSession.findUnique({ where: { procedureId: input.procedureId } });
      if (dup) throw new HttpError(409, "Lần thực hiện này đã trừ buổi gói");
    }
    const sessionNo = pkg.usedSessions + 1;
    // Cập nhật có điều kiện: hai người bấm cùng lúc không trừ hai buổi cho cùng một lượt.
    const r = await tx.treatmentPackage.updateMany({
      where: { id: pkg.id, usedSessions: pkg.usedSessions },
      data: {
        usedSessions: sessionNo,
        lastUsedAt: now,
        status: sessionNo >= pkg.totalSessions ? PackageStatus.COMPLETED : PackageStatus.ACTIVE,
      },
    });
    if (r.count !== 1) throw new HttpError(409, "Gói vừa được cập nhật, tải lại rồi thử lại");
    const session = await tx.packageSession.create({
      data: {
        packageId: pkg.id,
        sessionNo,
        usedAt: now,
        procedureId: input.procedureId ?? null,
        visitId: input.visitId ?? null,
        value: sessionValue(pkg.price, pkg.totalSessions, sessionNo),
        note: input.note ?? null,
        userId: input.actor.id,
        userName: input.actor.name,
      },
    });
    await tx.contractItem.update({ where: { id: pkg.contractItemId }, data: { deliveredQty: { increment: 1 } } });
    await tx.activity.create({
      data: {
        customerId: pkg.customerId,
        type: ActivityType.PACKAGE,
        content: `Dùng buổi ${sessionNo}/${pkg.totalSessions} gói "${pkg.name}"${input.note ? `. Ghi chú: ${input.note}` : ""}`,
        userId: input.actor.id,
        userName: input.actor.name,
      },
    });
    return { session, package: await tx.treatmentPackage.findUniqueOrThrow({ where: { id: pkg.id } }) };
  });
}

// ------------------------------------------------------------ NHẮC ĐẶT BUỔI TIẾP

export const PACKAGE_REMINDER_KEY = "package-reminder";

/**
 * Gói còn buổi, chưa hết hạn, quá số ngày nhắc kể từ buổi gần nhất (chưa dùng buổi
 * nào thì từ ngày lập gói) mà khách không có lịch hẹn sắp tới: tạo việc cho sale.
 * Mỗi gói nhắc một lần cho mỗi số buổi đã dùng (dùng thêm buổi thì nhắc lại được).
 */
export async function rulePackageReminder(now: Date): Promise<{ created: number }> {
  const defaultDays = await getSettingNumber("package.reminderIntervalDays");
  const pkgs = await prisma.treatmentPackage.findMany({
    where: { status: PackageStatus.ACTIVE, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
    select: {
      id: true,
      name: true,
      customerId: true,
      branchId: true,
      totalSessions: true,
      usedSessions: true,
      intervalDays: true,
      lastUsedAt: true,
      createdAt: true,
      customer: { select: { name: true, assignedToId: true, telesaleId: true } },
    },
    take: 2000,
  });
  let created = 0;
  for (const p of pkgs) {
    if (p.usedSessions >= p.totalSessions) continue;
    const since = p.lastUsedAt ?? p.createdAt;
    const days = p.intervalDays ?? defaultDays;
    if (now.getTime() - since.getTime() < days * 86_400_000) continue;
    const upcoming = await prisma.appointment.count({
      where: { customerId: p.customerId, startAt: { gte: now }, status: { notIn: [AppointmentStatus.CANCELLED, AppointmentStatus.NO_SHOW] } },
    });
    if (upcoming) continue;
    if (!(await markOnce(PACKAGE_REMINDER_KEY, `${p.id}:${p.usedSessions}`))) continue;
    await prisma.task.create({
      data: {
        customerId: p.customerId,
        branchId: p.branchId,
        title: `Nhắc ${p.customer.name} đặt buổi ${p.usedSessions + 1}/${p.totalSessions} gói "${p.name}"`,
        description: `Buổi gần nhất ${formatDateVN(since)}, đã quá ${days} ngày chưa có lịch hẹn.`,
        status: TaskStatus.OPEN,
        priority: TaskPriority.NORMAL,
        dueAt: new Date(startOfVnDay(now).getTime() + 86_400_000 - 60_000),
        assigneeId: p.customer.assignedToId ?? p.customer.telesaleId,
        kind: TaskKind.PACKAGE_REMINDER,
        source: PACKAGE_REMINDER_KEY,
      },
    });
    created++;
  }
  return { created };
}

registerJob({
  key: PACKAGE_REMINDER_KEY,
  label: "Gói liệu trình còn buổi: nhắc đặt buổi tiếp",
  intervalMs: 60 * 60_000,
  settingKey: "automation.packageReminder.enabled",
  run: ({ now }) => rulePackageReminder(now),
});
