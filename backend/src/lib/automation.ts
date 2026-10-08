import { prisma } from "./prisma";
import { getSettingNumber } from "./settings-catalog";
import { formatDateVN, formatTimeVN, startOfVnDay, vnDayKey } from "./datetime";
import { markOnce, registerJob } from "./jobs";
import { notifyUsers, usersWithRoles } from "./notify";
import { findMedicalKeywords, medicalKeywords } from "./medical-keywords";
import { generateAftercare } from "./aftercare";
import { processBroadcastQueue } from "./broadcast";
import { RoleCode } from "./rbac-catalog";
import {
  ActivityType,
  AppointmentStatus,
  ConversationKind,
  DepositStatus,
  InjectionStage,
  MessageDirection,
  ProcedureStatus,
  TaskKind,
  TaskPriority,
  TaskStatus,
} from "../types/enums";

// F9: TÁM QUY TẮC TỰ ĐỘNG. Mỗi quy tắc là một tác vụ nền (lib/jobs.ts) bật tắt
// riêng trong Cài đặt nhóm "Tự động hoá", ngưỡng cũng ở đó. Mỗi quy tắc đánh
// dấu đối tượng đã xử lý (AutomationMark) nên chạy lại bao nhiêu lần cũng không
// sinh việc hay thông báo trùng.
//
// "Trưởng nhóm" (quy tắc 1) và "quản lý" (quy tắc 3) = người có vai Quản lý cơ sở
// ở cơ sở đó. Bác sĩ phụ trách cơ sở (quy tắc 2) = người có vai Bác sĩ ở cơ sở đó.

const DAY_MS = 86_400_000;
const MIN_MS = 60_000;

export const RULE_KEYS = {
  UNANSWERED: "rule-1-unanswered",
  MEDICAL: "rule-2-medical-keyword",
  PRICE: "rule-3-price-deviation",
  STUCK_PHOTO: "rule-4-stuck-photo",
  TOMORROW: "rule-5-tomorrow-reminder",
  NO_SHOW: "rule-6-no-show",
  AFTERCARE: "rule-7-aftercare",
  RETREAT: "rule-8-retreat",
  BROADCAST: "broadcast-send",
} as const;

async function managersOf(branchId: string | null | undefined) {
  return usersWithRoles([RoleCode.QUAN_LY_CO_SO], branchId);
}

async function primaryBranchOf(customerId: string): Promise<string | null> {
  const links = await prisma.customerBranchLink.findMany({
    where: { customerId },
    select: { branchId: true, isPrimary: true },
    orderBy: { firstSeenAt: "asc" },
  });
  return (links.find((l) => l.isPrimary) ?? links[0])?.branchId ?? null;
}

// ------------------------------------------------ 1. TIN CHƯA TRẢ LỜI QUÁ N PHÚT

export async function ruleUnanswered(now: Date): Promise<{ created: number }> {
  const minutes = await getSettingNumber("automation.unanswered.minutes");
  const convs = await prisma.conversation.findMany({
    where: {
      kind: ConversationKind.CUSTOMER,
      waitingSince: { lte: new Date(now.getTime() - minutes * MIN_MS), gte: new Date(now.getTime() - 3 * DAY_MS) },
    },
    select: { id: true, title: true, branchId: true, assignedToId: true, waitingSince: true },
    take: 500,
  });
  let created = 0;
  for (const c of convs) {
    if (!(await markOnce(RULE_KEYS.UNANSWERED, `${c.id}:${c.waitingSince!.toISOString()}`))) continue;
    const waited = Math.round((now.getTime() - c.waitingSince!.getTime()) / MIN_MS);
    const managers = await managersOf(c.branchId);
    created += await notifyUsers([...managers.map((m) => m.id), c.assignedToId], {
      title: `Khách "${c.title}" chờ trả lời ${waited} phút`,
      body: `Tin khách từ ${formatTimeVN(c.waitingSince!)} chưa ai trả lời (ngưỡng ${minutes} phút).`,
      level: "WARN",
      link: `/hop-thu?c=${c.id}`,
    });
  }
  return { created };
}

// ------------------------------------------------------ 2. TỪ KHOÁ Y KHOA

export async function ruleMedicalKeyword(now: Date): Promise<{ created: number }> {
  const keywords = await medicalKeywords();
  if (!keywords.length) return { created: 0 };
  const messages = await prisma.chatMessage.findMany({
    where: {
      direction: MessageDirection.IN,
      createdAt: { gte: new Date(now.getTime() - DAY_MS), lte: now },
      conversation: { kind: ConversationKind.CUSTOMER },
    },
    select: {
      id: true,
      content: true,
      createdAt: true,
      conversation: { select: { id: true, title: true, branchId: true, medicalFlag: true } },
    },
    orderBy: { createdAt: "asc" },
    take: 2000,
  });
  let created = 0;
  for (const m of messages) {
    const hits = findMedicalKeywords(m.content, keywords);
    if (!hits.length) continue;
    if (!(await markOnce(RULE_KEYS.MEDICAL, m.id))) continue;
    const conv = m.conversation;
    if (!conv.medicalFlag) {
      await prisma.conversation.update({ where: { id: conv.id }, data: { medicalFlag: true, medicalFlagAt: now } });
      conv.medicalFlag = true;
    }
    // Báo bác sĩ tối đa một lần mỗi hội thoại mỗi ngày.
    if (!(await markOnce(`${RULE_KEYS.MEDICAL}:notify`, `${conv.id}:${vnDayKey(now)}`))) continue;
    const doctors = await usersWithRoles([RoleCode.BAC_SI], conv.branchId);
    created += await notifyUsers(
      doctors.map((d) => d.id),
      {
        title: `Khách "${conv.title}" hỏi vấn đề y khoa`,
        body: `Tin nhắn có từ khoá: ${hits.join(", ")}. Sale không tư vấn y khoa, bác sĩ vui lòng xem hội thoại.`,
        level: "DANGER",
        link: `/hop-thu?c=${conv.id}`,
      }
    );
  }
  return { created };
}

// ------------------------------------------------- 3. GIÁ BÁO KHÁC NIÊM YẾT

export async function rulePriceDeviation(now: Date): Promise<{ created: number }> {
  const quotations = await prisma.quotation.findMany({
    where: { createdAt: { gte: new Date(now.getTime() - 7 * DAY_MS), lte: now } },
    select: {
      id: true,
      code: true,
      branchId: true,
      createdBy: { select: { name: true } },
      customer: { select: { name: true, code: true } },
      items: { select: { name: true, quantity: true, amount: true, listPrice: true, discountAmount: true, promotionDiscount: true } },
    },
    take: 1000,
  });
  let created = 0;
  for (const q of quotations) {
    const deviations = q.items.filter(
      (i) => i.listPrice != null && (i.amount > i.quantity * i.listPrice || i.discountAmount - i.promotionDiscount > 0)
    );
    if (!deviations.length) continue;
    if (!(await markOnce(RULE_KEYS.PRICE, q.id))) continue;
    const managers = await managersOf(q.branchId);
    created += await notifyUsers(
      managers.map((m) => m.id),
      {
        title: `Báo giá ${q.code} lệch giá niêm yết`,
        body: `${q.createdBy?.name ?? "Nhân viên"} báo giá cho ${q.customer.name} (${q.customer.code}): ${deviations
          .map((d) =>
            d.amount > d.quantity * d.listPrice!
              ? `${d.name} cao hơn niêm yết`
              : `${d.name} giảm ngoài ưu đãi ${(d.discountAmount - d.promotionDiscount).toLocaleString("vi-VN")}đ`
          )
          .join("; ")}`,
        level: "WARN",
        link: `/duyet-giam-gia`,
      }
    );
  }
  return { created };
}

// ----------------------------------------------------- 4. KẸT Ở BƯỚC CÓ ẢNH

export async function ruleStuckPhoto(now: Date): Promise<{ created: number }> {
  const days = await getSettingNumber("automation.stuckPhoto.days");
  const customers = await prisma.customer.findMany({
    where: {
      stage: InjectionStage.CO_ANH,
      hidden: false,
      mergedIntoId: null,
      stageChangedAt: { lte: new Date(now.getTime() - days * DAY_MS) },
    },
    select: { id: true, name: true, code: true, assignedToId: true, telesaleId: true, stageChangedAt: true },
    take: 1000,
  });
  let created = 0;
  for (const c of customers) {
    if (!(await markOnce(RULE_KEYS.STUCK_PHOTO, `${c.id}:${c.stageChangedAt!.toISOString()}`))) continue;
    await prisma.task.create({
      data: {
        branchId: await primaryBranchOf(c.id),
        customerId: c.id,
        title: `Chăm lại: ${c.name} đã gửi ảnh ${days} ngày chưa chốt lịch`,
        description: `Khách ở bước Có ảnh từ ${formatDateVN(c.stageChangedAt!)}. Gọi hoặc nhắn lại, mời đặt lịch có cọc.`,
        status: TaskStatus.OPEN,
        priority: TaskPriority.HIGH,
        dueAt: now,
        assigneeId: c.assignedToId ?? c.telesaleId,
        kind: TaskKind.CARE_AGAIN,
        source: RULE_KEYS.STUCK_PHOTO,
      },
    });
    created++;
  }
  return { created };
}

// ------------------------------------------------- 5. LỊCH HẸN NGÀY MAI

export async function ruleTomorrowReminder(now: Date): Promise<{ created: number }> {
  const tomorrow = new Date(startOfVnDay(now).getTime() + DAY_MS);
  const appts = await prisma.appointment.findMany({
    where: {
      startAt: { gte: tomorrow, lt: new Date(tomorrow.getTime() + DAY_MS) },
      status: { in: [AppointmentStatus.PENDING, AppointmentStatus.CONFIRMED] },
    },
    select: {
      id: true,
      branchId: true,
      startAt: true,
      title: true,
      depositStatus: true,
      depositAmount: true,
      createdById: true,
      customer: { select: { id: true, name: true, assignedToId: true, telesaleId: true } },
    },
    orderBy: { startAt: "asc" },
  });
  let created = 0;
  const perBranch = new Map<string, number>();
  for (const a of appts) {
    perBranch.set(a.branchId, (perBranch.get(a.branchId) ?? 0) + 1);
    if (!(await markOnce(RULE_KEYS.TOMORROW, a.id))) continue;
    // Tin nhắc lịch: chờ kênh ZNS gửi (Giai đoạn sau nối cổng gửi), lễ tân thấy trong danh sách.
    await prisma.appointmentReminder.create({
      data: { appointmentId: a.id, channel: "ZALO_ZNS", scheduledAt: now, status: "PENDING" },
    });
    created++;
    if (a.depositStatus === DepositStatus.CHO_COC) {
      await prisma.task.create({
        data: {
          branchId: a.branchId,
          customerId: a.customer.id,
          title: `Nhắc cọc: ${a.customer.name} hẹn ${formatTimeVN(a.startAt)} ngày mai`,
          description: `Lịch "${a.title}" chưa nhận cọc${a.depositAmount ? ` ${a.depositAmount.toLocaleString("vi-VN")}đ` : ""}. Gửi mã QR cọc và nhắc khách.`,
          status: TaskStatus.OPEN,
          priority: TaskPriority.HIGH,
          dueAt: new Date(startOfVnDay(now).getTime() + 18 * 3_600_000),
          assigneeId: a.customer.assignedToId ?? a.customer.telesaleId ?? a.createdById,
          kind: TaskKind.DEPOSIT_REMINDER,
          source: RULE_KEYS.TOMORROW,
        },
      });
      created++;
    }
  }
  const dayKey = vnDayKey(tomorrow);
  for (const [branchId, count] of perBranch) {
    if (!(await markOnce(`${RULE_KEYS.TOMORROW}:list`, `${branchId}:${dayKey}`))) continue;
    const receptionists = await usersWithRoles([RoleCode.LE_TAN], branchId);
    created += await notifyUsers(
      receptionists.map((u) => u.id),
      {
        title: `Ngày mai ${formatDateVN(tomorrow)} có ${count} lịch hẹn`,
        body: "Mở Lịch hẹn ngày mai để gọi xác nhận, kiểm tra cọc.",
        link: `/lich-hen?date=${dayKey}`,
      }
    );
  }
  return { created };
}

// ------------------------------------------ 6. QUÁ GIỜ HẸN CHƯA CHECK-IN

export async function ruleNoShow(now: Date): Promise<{ created: number }> {
  const minutes = await getSettingNumber("automation.noShow.minutes");
  const appts = await prisma.appointment.findMany({
    where: {
      startAt: { gte: new Date(now.getTime() - DAY_MS), lte: new Date(now.getTime() - minutes * MIN_MS) },
      status: { in: [AppointmentStatus.PENDING, AppointmentStatus.CONFIRMED] },
      visit: null,
    },
    select: {
      id: true,
      branchId: true,
      startAt: true,
      title: true,
      createdById: true,
      customer: { select: { id: true, name: true, assignedToId: true, telesaleId: true } },
    },
  });
  let created = 0;
  for (const a of appts) {
    if (!(await markOnce(RULE_KEYS.NO_SHOW, a.id))) continue;
    await prisma.task.create({
      data: {
        branchId: a.branchId,
        customerId: a.customer.id,
        title: `Gọi lại: ${a.customer.name} chưa đến lịch ${formatTimeVN(a.startAt)}`,
        description: `Quá giờ hẹn ${minutes} phút chưa check-in (lịch "${a.title}"). Gọi hỏi khách, dời lịch nếu cần.`,
        status: TaskStatus.OPEN,
        priority: TaskPriority.URGENT,
        dueAt: now,
        assigneeId: a.customer.assignedToId ?? a.customer.telesaleId ?? a.createdById,
        kind: TaskKind.CALLBACK,
        source: RULE_KEYS.NO_SHOW,
      },
    });
    created++;
  }
  return { created };
}

// ------------------------------------ 7. HOÀN TẤT LẦN THỰC HIỆN: CHĂM SÓC

/** Quét bù: lần thực hiện hoàn tất 7 ngày gần đây chưa sinh việc chăm sóc (lúc bấm hoàn tất đang tắt quy tắc...). */
export async function ruleAftercare(now: Date): Promise<{ created: number }> {
  const procs = await prisma.procedureRecord.findMany({
    where: {
      status: ProcedureStatus.COMPLETED,
      aftercareGeneratedAt: null,
      finishedAt: { gte: new Date(now.getTime() - 7 * DAY_MS), lte: now },
    },
    select: { id: true },
    take: 500,
  });
  let created = 0;
  for (const p of procs) created += (await generateAftercare(p.id, { now })).created;
  return { created };
}

// ------------------------------------------------- 8. ĐẾN MỐC TÁI TIÊM

export async function ruleRetreat(now: Date): Promise<{ created: number }> {
  const leadDays = await getSettingNumber("automation.retreat.leadDays");
  const procs = await prisma.procedureRecord.findMany({
    where: {
      status: ProcedureStatus.COMPLETED,
      retreatDueAt: { gte: new Date(now.getTime() - 30 * DAY_MS), lte: new Date(now.getTime() + leadDays * DAY_MS) },
      customer: { mergedIntoId: null, hidden: false },
    },
    select: {
      id: true,
      branchId: true,
      title: true,
      retreatDueAt: true,
      service: { select: { name: true } },
      customer: { select: { id: true, name: true, assignedToId: true, telesaleId: true } },
    },
    take: 1000,
  });
  let created = 0;
  for (const p of procs) {
    if (!(await markOnce(RULE_KEYS.RETREAT, p.id))) continue;
    const serviceName = p.service?.name ?? p.title;
    const assigneeId = p.customer.assignedToId ?? p.customer.telesaleId;
    await prisma.task.create({
      data: {
        branchId: p.branchId,
        customerId: p.customer.id,
        title: `Cơ hội tái tiêm: ${serviceName} (${p.customer.name})`,
        description: `Mốc tái tiêm ${formatDateVN(p.retreatDueAt!)}. Nhắn hỏi thăm kết quả, mời khách đặt lịch tái tiêm.`,
        status: TaskStatus.OPEN,
        priority: TaskPriority.HIGH,
        dueAt: p.retreatDueAt!.getTime() < now.getTime() ? now : p.retreatDueAt,
        assigneeId,
        kind: TaskKind.RETREAT,
        source: RULE_KEYS.RETREAT,
        procedureId: p.id,
      },
    });
    await prisma.activity.create({
      data: {
        customerId: p.customer.id,
        type: ActivityType.SYSTEM,
        content: `Cơ hội bán: đến mốc tái tiêm ${serviceName} ngày ${formatDateVN(p.retreatDueAt!)}`,
        userName: "Hệ thống",
      },
    });
    await notifyUsers([assigneeId], {
      title: `Cơ hội tái tiêm: ${p.customer.name}`,
      body: `${serviceName}, mốc ${formatDateVN(p.retreatDueAt!)}`,
      link: `/khach-hang/${p.customer.id}`,
    });
    created++;
  }
  return { created };
}

// --------------------------------------------------------------- ĐĂNG KÝ

let registered = false;

/** Đăng ký 8 quy tắc + hàng đợi gửi tin vào bộ chạy tác vụ nền. Gọi nhiều lần vô hại. */
export function registerAutomationJobs(): void {
  if (registered) return;
  registered = true;
  const MIN = 60_000;
  registerJob({ key: RULE_KEYS.UNANSWERED, label: "1. Tin chưa trả lời quá N phút: báo trưởng nhóm", intervalMs: MIN, settingKey: "automation.unanswered.enabled", run: ({ now }) => ruleUnanswered(now) });
  registerJob({ key: RULE_KEYS.MEDICAL, label: "2. Tin có từ khoá y khoa: gắn cờ, báo bác sĩ", intervalMs: MIN, settingKey: "automation.medicalKeyword.enabled", run: ({ now }) => ruleMedicalKeyword(now) });
  registerJob({ key: RULE_KEYS.PRICE, label: "3. Giá báo khác niêm yết: cảnh báo quản lý", intervalMs: 5 * MIN, settingKey: "automation.priceDeviation.enabled", run: ({ now }) => rulePriceDeviation(now) });
  registerJob({ key: RULE_KEYS.STUCK_PHOTO, label: "4. Kẹt ở bước Có ảnh: việc chăm lại", intervalMs: 60 * MIN, settingKey: "automation.stuckPhoto.enabled", run: ({ now }) => ruleStuckPhoto(now) });
  registerJob({ key: RULE_KEYS.TOMORROW, label: "5. Lịch hẹn ngày mai: tin nhắc, nhắc cọc, danh sách lễ tân", intervalMs: 30 * MIN, settingKey: "automation.tomorrowReminder.enabled", run: ({ now }) => ruleTomorrowReminder(now) });
  registerJob({ key: RULE_KEYS.NO_SHOW, label: "6. Quá giờ hẹn chưa check-in: việc gọi lại", intervalMs: 5 * MIN, settingKey: "automation.noShow.enabled", run: ({ now }) => ruleNoShow(now) });
  registerJob({ key: RULE_KEYS.AFTERCARE, label: "7. Hoàn tất lần thực hiện: việc chăm sóc (quét bù)", intervalMs: 15 * MIN, settingKey: "automation.aftercare.enabled", run: ({ now }) => ruleAftercare(now) });
  registerJob({ key: RULE_KEYS.RETREAT, label: "8. Đến mốc tái tiêm: cơ hội bán, việc cho sale", intervalMs: 60 * MIN, settingKey: "automation.retreat.enabled", run: ({ now }) => ruleRetreat(now) });
  registerJob({ key: RULE_KEYS.BROADCAST, label: "Gửi tin theo nhóm khách (hàng đợi)", intervalMs: MIN, settingKey: "broadcast.enabled", run: ({ now }) => processBroadcastQueue(now) });
}

registerAutomationJobs();
