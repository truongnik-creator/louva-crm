import type { Request } from "express";
import { prisma } from "./prisma";
import { currentUser } from "../middleware/auth";
import { hasPermission, notFound, phoneFor, scopeOf } from "../middleware/rbac";
import { writeAccessLog } from "./audit";
import { REAL_MONEY } from "./report-scope";
import { getClinicMode, stageLabel, stagesFor } from "./stages";
import { currentOpportunity } from "./opportunities";
import { vnDayKey } from "./datetime";
import { anonymLabelOf } from "../routes/cases";
import {
  assertCustomerAccess,
  buildJourney,
  canSeeMedical,
  canSeeMoney,
  computeMetrics,
  loadPipelineParams,
  type MilestoneInput,
} from "./crm360";
import {
  AccessResourceType,
  ClinicMode,
  ContractStatus,
  MessageDirection,
  PermissionScope,
  PhotoStage,
  ProcedureStatus,
  TaskKind,
  TaskStatus,
} from "../types/enums";

// Lô 7 · C1 + J1: THANH 360 và DẢI HÀNH TRÌNH của một khách (GET /api/customers/:id/360).
//
// Một endpoint gom mọi con số đầu hồ sơ để giao diện không phải gọi 8 API.
// Tiền chỉ trả cho vai xem được tiền (canSeeMoney, Quyết định 3); cờ y khoa chỉ
// trả cho vai có medical.read và chỉ đọc bệnh án trong cơ sở được phép.

export async function buildCustomer360(req: Request, customerId: string, now = new Date()) {
  const customer = await prisma.customer.findUnique({
    where: { id: customerId },
    include: {
      assignedTo: { select: { id: true, name: true } },
      telesale: { select: { id: true, name: true } },
      channel: { select: { id: true, name: true, kind: true } },
      campaign: { select: { id: true, name: true } },
      leadOrigin: { select: { createdAt: true, adCampaign: true, adId: true, campaign: { select: { name: true } }, channel: { select: { name: true } } } },
      branchLinks: { include: { branch: { select: { id: true, code: true, shortName: true } } } },
    },
  });
  if (!customer || customer.mergedIntoId) throw notFound();
  await assertCustomerAccess(req, customer as unknown as Record<string, unknown>);

  const mode = await getClinicMode();
  const params = await loadPipelineParams();
  const primaryBranchId = customer.branchLinks.find((b) => b.isPrimary)?.branchId ?? customer.branchLinks[0]?.branchId ?? null;
  const metrics = (
    await computeMetrics(
      [{ id: customer.id, stage: customer.stage, createdAt: customer.createdAt, stageChangedAt: customer.stageChangedAt, interest: customer.interest, primaryBranchId }],
      { mode, params, now }
    )
  ).get(customer.id)!;
  // Sửa lỗi sau chụp demo Lô 8: giá trị dự kiến của thanh 360 = giá trị của CƠ HỘI HIỆN TẠI
  // (cùng luật với thẻ trên bảng bước), không phải tổng dịch vụ quan tâm cũ của khách.
  const current = await currentOpportunity(customer.id);
  const value = current
    ? (
        await computeMetrics(
          [
            {
              id: current.id,
              customerId: customer.id,
              opportunityId: current.id,
              fixedValue: current.expectedValue,
              oppServiceId: current.serviceId,
              primaryUnit: true,
              stage: current.stage,
              createdAt: current.createdAt,
              stageChangedAt: current.stageChangedAt,
              interest: customer.interest,
              primaryBranchId: current.branchId ?? primaryBranchId,
            },
          ],
          { mode, params, now }
        )
      ).get(current.id)!
    : metrics;
  const money = canSeeMoney(req);
  const lost = stagesFor(mode).find((s) => s.key === customer.stage)?.lost ?? false;

  // Việc mở của khách (mọi người được giao): CÙNG nguồn với "việc kế tiếp" của thanh 360
  // để ô "Việc cần làm với khách này" không báo trống khi thanh 360 còn việc.
  const openTaskRows = await prisma.task.findMany({
    where: { customerId, status: { in: [TaskStatus.OPEN, TaskStatus.IN_PROGRESS] } },
    orderBy: [{ dueAt: "asc" }, { createdAt: "asc" }],
    take: 50,
    select: { id: true, title: true, dueAt: true, kind: true, stageKey: true, opportunityId: true, assignee: { select: { id: true, name: true } } },
  });
  // SQLite xếp NULL lên đầu khi tăng dần: việc có hạn trước, việc không hạn sau (giống nextTask).
  const openTasks = [...openTaskRows.filter((t) => t.dueAt !== null), ...openTaskRows.filter((t) => t.dueAt === null)].map((t) => ({
    ...t,
    overdue: Boolean(t.dueAt && t.dueAt < now),
  }));

  const [procedures, contracts, spend, debtAgg, vouchers, firstInbound, adConv, firstPhoto, firstDeposit, firstVisit, aftercare, nextAppt, score] =
    await Promise.all([
      prisma.procedureRecord.findMany({
        where: { customerId, status: ProcedureStatus.COMPLETED },
        orderBy: { scheduledAt: "asc" },
        select: { id: true, title: true, finishedAt: true, scheduledAt: true, retreatDueAt: true, service: { select: { name: true } } },
      }),
      prisma.contract.findMany({
        where: { customerId, status: { not: ContractStatus.CANCELLED }, signedAt: { not: null } },
        select: { total: true },
      }),
      prisma.payment.aggregate({ where: { customerId, ...REAL_MONEY }, _sum: { amount: true } }),
      prisma.invoice.aggregate({
        where: { customerId, status: { in: ["ISSUED", "PARTIAL", "OVERDUE"] } },
        _sum: { amount: true, paidAmount: true },
      }),
      prisma.voucher.findMany({ where: { customerId, status: "ACTIVE", expiresAt: { gt: now } }, select: { value: true, expiresAt: true } }),
      prisma.chatMessage.findFirst({
        where: { conversation: { customerId }, direction: MessageDirection.IN },
        orderBy: { createdAt: "asc" },
        select: { createdAt: true },
      }),
      prisma.conversation.findFirst({
        where: { customerId, OR: [{ adCampaign: { not: null } }, { adId: { not: null } }] },
        orderBy: { createdAt: "asc" },
        select: { adCampaign: true, adId: true, createdAt: true },
      }),
      prisma.photoSet.findFirst({
        where: { customerId, stage: { in: [PhotoStage.CHAT, PhotoStage.CONSULT] } },
        orderBy: { takenAt: "asc" },
        select: { takenAt: true, stage: true },
      }),
      prisma.appointment.findFirst({
        where: { customerId, depositConfirmedAt: { not: null } },
        orderBy: { depositConfirmedAt: "asc" },
        select: { depositConfirmedAt: true, depositAmount: true },
      }),
      prisma.visit.findFirst({ where: { customerId }, orderBy: { checkedInAt: "asc" }, select: { checkedInAt: true } }),
      prisma.task.findMany({
        where: { customerId, kind: TaskKind.AFTERCARE, procedureId: { not: null } },
        select: { procedureId: true, status: true, contactedAt: true, completedAt: true },
      }),
      prisma.appointment.findFirst({
        where: { customerId, startAt: { gte: now }, status: { notIn: ["CANCELLED", "NO_SHOW", "DONE"] } },
        orderBy: { startAt: "asc" },
        select: { id: true, startAt: true, title: true, depositStatus: true, depositAmount: true, code: true },
      }),
      hasPermission(req, "inbox.manage_scripts")
        ? prisma.conversationScore.findFirst({
            where: { customerId, status: "SCORED" },
            orderBy: { createdAt: "desc" },
            select: { score: true, weekKey: true, summary: true },
          })
        : Promise.resolve(null),
    ]);

  // Số lần làm dịch vụ: các ngày (giờ VN) có lần thực hiện hoàn tất.
  const serviceDays = new Set(procedures.map((p) => vnDayKey(p.finishedAt ?? p.scheduledAt)));
  const lastProc = procedures.length ? procedures[procedures.length - 1] : null;
  const lastServiceAt = customer.lastServiceAt ?? (lastProc ? (lastProc.finishedAt ?? lastProc.scheduledAt) : null);
  const dues = procedures.map((p) => p.retreatDueAt).filter((d): d is Date => Boolean(d));
  const futureDues = dues.filter((d) => d >= now).sort((a, b) => a.getTime() - b.getTime());
  const retreatDueAt = futureDues[0] ?? (dues.length ? dues.sort((a, b) => b.getTime() - a.getTime())[0] : null);
  const debt = (debtAgg._sum.amount ?? 0) - (debtAgg._sum.paidAmount ?? 0);
  const orderTotal = contracts.reduce((s, c) => s + c.total, 0);

  // -------------------------------------------------------- CỜ Y KHOA
  type MedicalFlag = { kind: "ALLERGY" | "CONTRAINDICATION" | "CHAT_KEYWORD"; text: string; blocking: boolean };
  let medical: null | { flags: MedicalFlag[] } = null;
  if (canSeeMedical(req)) {
    const me = currentUser(req);
    const all = scopeOf(req, "medical.read") === PermissionScope.ALL;
    const [records, flagged] = await Promise.all([
      prisma.medicalRecord.findMany({
        where: { customerId, ...(all ? {} : { branchId: { in: me.branchIds } }) },
        select: { id: true, branchId: true, allergies: { select: { substance: true, reaction: true } }, contraindications: { select: { content: true, blocking: true } } },
      }),
      prisma.conversation.count({ where: { customerId, medicalFlag: true } }),
    ]);
    const flags: MedicalFlag[] = [];
    for (const r of records) {
      for (const a of r.allergies) flags.push({ kind: "ALLERGY", text: `Dị ứng: ${a.substance}${a.reaction ? ` (${a.reaction})` : ""}`, blocking: false });
      for (const c of r.contraindications) flags.push({ kind: "CONTRAINDICATION", text: `Chống chỉ định: ${c.content}`, blocking: c.blocking });
    }
    if (flagged) flags.push({ kind: "CHAT_KEYWORD", text: "Tin nhắn có từ khoá y khoa (đã báo bác sĩ)", blocking: false });
    medical = { flags };
    if (records.some((r) => r.allergies.length || r.contraindications.length)) {
      await writeAccessLog({ req, customerId, resourceType: AccessResourceType.MEDICAL_RECORD, resourceId: records[0].id, reason: "Cờ y khoa trên thanh 360" });
    }
  }

  // -------------------------------------------------------- HÀNH TRÌNH (J1)
  const careWord = mode === ClinicMode.INJECTION ? "Chăm sóc sau tiêm" : "Theo dõi hậu phẫu";
  const serviceWord = mode === ClinicMode.INJECTION ? "Làm dịch vụ" : "Phẫu thuật, thủ thuật";
  const firstAd = customer.leadOrigin?.adCampaign ?? adConv?.adCampaign ?? customer.leadOrigin?.campaign?.name ?? customer.campaign?.name ?? (adConv?.adId ? `Quảng cáo ${adConv.adId}` : null);
  // Mốc nguồn luôn đứng đầu: lấy sớm nhất trong ngày tạo hồ sơ, ngày có lead và các mốc
  // khác (dữ liệu nhập lại, gộp hồ sơ có thể có hồ sơ tạo SAU lần đến đầu tiên).
  const earliest = [
    customer.createdAt,
    customer.leadOrigin?.createdAt,
    adConv?.createdAt,
    firstInbound?.createdAt,
    firstPhoto?.takenAt,
    firstDeposit?.depositConfirmedAt,
    firstVisit?.checkedInAt,
    procedures[0] ? (procedures[0].finishedAt ?? procedures[0].scheduledAt) : null,
  ].filter((d): d is Date => Boolean(d));
  const sourceAt = new Date(Math.min(...earliest.map((d) => d.getTime())));
  const channelName = customer.channel?.name ?? customer.leadOrigin?.channel?.name ?? null;
  const events: MilestoneInput[] = [
    { kind: "SOURCE", label: "Nguồn đầu tiên", detail: [channelName ?? "Không rõ kênh", firstAd].filter(Boolean).join(" · "), at: sourceAt },
  ];
  if (firstInbound) events.push({ kind: "FIRST_MESSAGE", label: "Tin nhắn đầu", at: firstInbound.createdAt });
  if (firstPhoto) events.push({ kind: "PHOTO", label: firstPhoto.stage === PhotoStage.CHAT ? "Gửi ảnh" : "Chụp ảnh tư vấn", at: firstPhoto.takenAt });
  if (firstDeposit?.depositConfirmedAt) {
    events.push({ kind: "DEPOSIT", label: "Đặt cọc", detail: money ? `${firstDeposit.depositAmount.toLocaleString("vi-VN")}đ` : null, at: firstDeposit.depositConfirmedAt });
  }
  if (firstVisit) events.push({ kind: "VISIT", label: "Đến cơ sở", at: firstVisit.checkedInAt });
  procedures.forEach((p, i) => {
    events.push({ kind: "SERVICE", label: `${serviceWord} lần ${i + 1}`, detail: p.service?.name ?? p.title, at: p.finishedAt ?? p.scheduledAt });
    const care = aftercare.filter((t) => t.procedureId === p.id);
    const doneCare = care.filter((t) => t.status === TaskStatus.DONE);
    if (doneCare.length) {
      const last = doneCare.map((t) => t.contactedAt ?? t.completedAt).filter((d): d is Date => Boolean(d)).sort((a, b) => b.getTime() - a.getTime())[0];
      if (last) events.push({ kind: "AFTERCARE", label: careWord, detail: `${doneCare.length}/${care.length} mốc đã liên hệ`, at: last });
    }
  });
  if (nextAppt) events.push({ kind: "APPOINTMENT", label: "Lịch hẹn sắp tới", detail: nextAppt.title, at: nextAppt.startAt });
  if (retreatDueAt) events.push({ kind: "RETREAT", label: "Hạn tái tiêm", at: retreatDueAt });
  const journey = buildJourney(events, now);

  return {
    customer: {
      id: customer.id,
      code: customer.code,
      name: customer.name,
      phone: phoneFor(req, customer.phone),
      gender: customer.gender,
      profileLabel: anonymLabelOf({ gender: customer.gender, dob: customer.dob }, now),
      branches: customer.branchLinks.map((b) => ({ ...b.branch, isPrimary: b.isPrimary })),
    },
    stage: {
      key: customer.stage,
      label: stageLabel(customer.stage),
      lost,
      lostReason: customer.lostReason,
      since: metrics.stageSince,
      days: metrics.age.days,
      maxDays: metrics.age.maxDays,
      level: metrics.age.level,
    },
    heat: metrics.heat,
    source: { channel: channelName, firstAd, at: sourceAt },
    sale: { assignedTo: customer.assignedTo, telesale: customer.telesale },
    stats: {
      serviceCount: serviceDays.size,
      lastServiceAt,
      retreatDueAt,
      retreatOverdue: Boolean(retreatDueAt && retreatDueAt < now),
      openQuoteCount: metrics.openQuoteCount,
      voucherCount: vouchers.length,
      nearestVoucherExpiry: vouchers.length ? vouchers.map((v) => v.expiresAt).sort((a, b) => a.getTime() - b.getTime())[0] : null,
      hasDebt: debt > 0,
    },
    moneyVisible: money,
    money: money
      ? {
          lifetimeSpend: spend._sum.amount ?? 0,
          orderCount: contracts.length,
          avgOrderValue: contracts.length ? Math.round(orderTotal / contracts.length) : null,
          openQuoteTotal: metrics.openQuoteTotal,
          debt,
          voucherValue: vouchers.reduce((s, v) => s + v.value, 0),
          expectedValue: value.expectedValue,
          valueSource: value.valueSource,
        }
      : null,
    medicalVisible: medical !== null,
    medical,
    conversationScore: score,
    nextAppointment: nextAppt
      ? { ...nextAppt, depositAmount: money ? nextAppt.depositAmount : null }
      : null,
    nextTask: metrics.nextTask,
    openTasks,
    journey,
  };
}
