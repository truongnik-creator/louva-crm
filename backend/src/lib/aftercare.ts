import { prisma } from "./prisma";
import { getSettingRaw } from "./settings-catalog";
import { formatDateVN, startOfVnDay } from "./datetime";
import { markOnce } from "./jobs";
import { ActivityType, ProcedureStatus, TaskKind, TaskPriority, TaskStatus } from "../types/enums";

// F10: CHĂM SÓC SAU ĐIỀU TRỊ.
//
// Hoàn tất một lần thực hiện thì sinh một việc gọi chăm sóc cho mỗi mốc (mặc
// định D0, D1, D3, D7, D14, D30, đổi ở Cài đặt aftercare.milestones) và tính
// mốc tái tiêm = ngày làm + số ngày tái tiêm (của lần làm nếu bác sĩ chỉnh,
// không thì của dịch vụ). Quy tắc 8 (F9) đọc mốc tái tiêm để tạo cơ hội bán.

const DAY_MS = 86_400_000;
/** Giờ gọi chăm sóc trong ngày (17:00 giờ VN). */
const CALL_HOUR_VN = 17;

export function parseMilestones(raw: string): number[] {
  const days = raw
    .split(/[,;\s]+/)
    .map((x) => Number(x.replace(/^d/i, "")))
    .filter((n) => Number.isInteger(n) && n >= 0 && n <= 365);
  return [...new Set(days)].sort((a, b) => a - b);
}

export async function aftercareMilestones(): Promise<number[]> {
  const parsed = parseMilestones(await getSettingRaw("aftercare.milestones"));
  return parsed.length ? parsed : [0, 1, 3, 7, 14, 30];
}

/** Hạn gọi của mốc Dn: 17:00 giờ VN ngày làm + n; D0 làm muộn thì hạn là 1 giờ sau khi làm xong. */
export function milestoneDueAt(base: Date, days: number): Date {
  const due = new Date(startOfVnDay(base).getTime() + days * DAY_MS + CALL_HOUR_VN * 3_600_000);
  if (due.getTime() <= base.getTime()) return new Date(base.getTime() + 3_600_000);
  return due;
}

export function retreatDueFrom(base: Date, days: number | null | undefined): Date | null {
  return days && days > 0 ? new Date(base.getTime() + days * DAY_MS) : null;
}

/**
 * Sinh việc chăm sóc cho một lần thực hiện đã hoàn tất. Idempotent: chạy lại
 * (bấm hoàn tất hai lần, job quét bù) không sinh trùng.
 */
export async function generateAftercare(
  procedureId: string,
  opts: { now?: Date; actor?: { id: string; name: string } | null } = {}
): Promise<{ created: number; retreatDueAt: Date | null }> {
  const now = opts.now ?? new Date();
  const proc = await prisma.procedureRecord.findUnique({
    where: { id: procedureId },
    include: {
      service: { select: { name: true, retreatDays: true } },
      customer: { select: { id: true, name: true, assignedToId: true, telesaleId: true, mergedIntoId: true } },
    },
  });
  if (!proc || proc.status !== ProcedureStatus.COMPLETED || proc.aftercareGeneratedAt) {
    return { created: 0, retreatDueAt: proc?.retreatDueAt ?? null };
  }
  if (!(await markOnce("aftercare", proc.id))) return { created: 0, retreatDueAt: proc.retreatDueAt };

  const base = proc.finishedAt ?? now;
  const days = await aftercareMilestones();
  const assigneeId = proc.customer.assignedToId ?? proc.customer.telesaleId ?? proc.nurseId ?? proc.surgeonId ?? null;
  const serviceName = proc.service?.name ?? proc.title;

  await prisma.task.createMany({
    data: days.map((d) => ({
      branchId: proc.branchId,
      customerId: proc.customerId,
      title: `Chăm sóc D${d}: ${serviceName}`,
      description: `Gọi hỏi thăm khách sau ${d === 0 ? "buổi làm hôm nay" : `${d} ngày`} (${proc.code}). Có dấu hiệu bất thường thì chọn "Có vấn đề" để báo bác sĩ.`,
      status: TaskStatus.OPEN,
      priority: d <= 1 ? TaskPriority.HIGH : TaskPriority.NORMAL,
      dueAt: milestoneDueAt(base, d),
      assigneeId,
      createdById: opts.actor?.id ?? null,
      kind: TaskKind.AFTERCARE,
      source: "aftercare",
      procedureId: proc.id,
      milestone: `D${d}`,
    })),
  });

  const retreatDueAt = retreatDueFrom(base, proc.retreatDays ?? proc.service?.retreatDays);
  await prisma.procedureRecord.update({
    where: { id: proc.id },
    data: { aftercareGeneratedAt: now, retreatDueAt },
  });
  await prisma.activity.create({
    data: {
      customerId: proc.customerId,
      type: ActivityType.AFTERCARE,
      content: `Sinh ${days.length} việc chăm sóc sau điều trị (${days.map((d) => `D${d}`).join(", ")}) cho ${serviceName}${
        retreatDueAt ? `. Mốc tái tiêm: ${formatDateVN(retreatDueAt)}` : ""
      }`,
      userId: opts.actor?.id ?? null,
      userName: opts.actor?.name ?? "Hệ thống",
    },
  });
  return { created: days.length, retreatDueAt };
}

/** Bác sĩ đổi số ngày tái tiêm của một lần làm: tính lại mốc, dời việc tái tiêm chưa làm. */
export async function setProcedureRetreatDays(procedureId: string, retreatDays: number | null): Promise<Date | null> {
  const proc = await prisma.procedureRecord.findUniqueOrThrow({
    where: { id: procedureId },
    include: { service: { select: { retreatDays: true } } },
  });
  const base = proc.finishedAt ?? proc.scheduledAt;
  const retreatDueAt = proc.status === ProcedureStatus.COMPLETED ? retreatDueFrom(base, retreatDays ?? proc.service?.retreatDays) : null;
  await prisma.procedureRecord.update({ where: { id: proc.id }, data: { retreatDays, retreatDueAt } });
  if (retreatDueAt) {
    await prisma.task.updateMany({
      where: { procedureId: proc.id, kind: TaskKind.RETREAT, status: { in: [TaskStatus.OPEN, TaskStatus.IN_PROGRESS] } },
      data: { dueAt: retreatDueAt },
    });
  }
  return retreatDueAt;
}
