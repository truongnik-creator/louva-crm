import { prisma } from "./prisma";
import { getSettingNumber } from "./settings-catalog";
import { startOfVnDay, vnDayKey } from "./datetime";
import { currentListPrice } from "./pricing";
import { REAL_MONEY, nullableBranchWhere, type BranchScope } from "./report-scope";
import {
  DAY_MS,
  allocate,
  collectedPayments,
  isAdsCustomer,
  isAdsLead,
  previousPeriodKey,
  responsibleSaleOf,
  settingList,
  startOfVnWeek,
  vnMonthRange,
  vnPeriodKey,
  vnWeekKey,
  type Range,
} from "./metrics";
import {
  AppointmentStatus,
  ContractStatus,
  ConversationKind,
  MessageDirection,
  ProcedureStatus,
  TaskStatus,
  UserStatus,
} from "../types/enums";

// SỐ LIỆU ĐỢT 3: F15 chỉ số tuần, F16 họp cuối ngày, F22 lãi gộp, F23 quay lại,
// F31 tốc độ trả lời, F32 doanh thu trọn đời, F34 dự báo. Route mỏng ở
// routes/analytics.ts; các hàm ở đây nhận phạm vi cơ sở đã kiểm quyền.

const round1 = (n: number) => Math.round(n * 10) / 10;
const ratio = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);
const perUnit = (cost: number, n: number) => (n > 0 ? Math.round(cost / n) : null);

// ============================================================ F15 CHỈ SỐ TUẦN

export interface FunnelMetrics {
  cost: number;
  newMessages: number;
  phones: number;
  costPerPhone: number | null;
  depositBookings: number;
  costPerDeposit: number | null;
  showups: number;
  costPerShowup: number | null;
  revenue: number;
  roas: number | null;
}

type RawMetrics = Pick<FunnelMetrics, "cost" | "newMessages" | "phones" | "depositBookings" | "showups" | "revenue">;

const emptyRaw = (): RawMetrics => ({ cost: 0, newMessages: 0, phones: 0, depositBookings: 0, showups: 0, revenue: 0 });

export function finishMetrics(r: RawMetrics): FunnelMetrics {
  return {
    ...r,
    costPerPhone: perUnit(r.cost, r.phones),
    costPerDeposit: perUnit(r.cost, r.depositBookings),
    costPerShowup: perUnit(r.cost, r.showups),
    roas: r.cost > 0 ? round1(r.revenue / r.cost) : null,
  };
}

interface Attribution {
  campaignId: string | null;
  channelId: string | null;
  ads: boolean;
}

type CustomerSrc = {
  campaignId: string | null;
  channelId: string | null;
  leadOrigin: { campaignId: string | null; channelId: string | null; adId: string | null; adPostId: string | null; adCampaign: string | null } | null;
};

const CUSTOMER_SRC = {
  campaignId: true,
  channelId: true,
  leadOrigin: { select: { campaignId: true, channelId: true, adId: true, adPostId: true, adCampaign: true } },
} as const;

function customerAttribution(c: CustomerSrc, campaignChannel: Map<string, string | null>): Attribution {
  const campaignId = c.campaignId ?? c.leadOrigin?.campaignId ?? null;
  return {
    campaignId,
    channelId: c.channelId ?? c.leadOrigin?.channelId ?? (campaignId ? (campaignChannel.get(campaignId) ?? null) : null),
    ads: isAdsCustomer(c),
  };
}

export interface WeeklyRow {
  weekKey: string;
  from: Date;
  to: Date;
  total: FunnelMetrics;
  ads: FunnelMetrics;
  organic: FunnelMetrics;
  byChannel: Array<{ channelId: string | null; name: string } & FunnelMetrics>;
  byCampaign: Array<{ campaignId: string; code: string; name: string; channel: string } & FunnelMetrics>;
}

/**
 * Chỉ số tuần theo chiến dịch và kênh, tách quảng cáo và tự nhiên.
 *   cost            chi phí nhập theo ngày (CampaignCost)
 *   newMessages     lead mới + hội thoại khách mới không mang lead (tự nhiên)
 *   phones          lead có mốc hasPhoneAt trong tuần + khách tạo trong tuần có SĐT, có hội thoại, không có lead
 *   depositBookings lịch được xác nhận cọc trong tuần
 *   showups         khách đến LẦN ĐẦU trong tuần
 *   revenue         tiền đã thu trong tuần (không gồm voucher)
 */
export async function weeklyMetrics(opts: { weeks: number; to: Date; scope: BranchScope }): Promise<WeeklyRow[]> {
  const lastStart = startOfVnWeek(opts.to);
  const firstStart = new Date(lastStart.getTime() - (opts.weeks - 1) * 7 * DAY_MS);
  const range: Range = { gte: firstStart, lt: new Date(lastStart.getTime() + 7 * DAY_MS) };
  const branchIds = opts.scope.ids;

  const [campaigns, channels, costs, leads, convs, phoneLeads, phoneCustomers, deposits, visits, payments] = await Promise.all([
    prisma.campaign.findMany({ select: { id: true, code: true, name: true, channelId: true, channel: { select: { name: true } } } }),
    prisma.channel.findMany({ select: { id: true, name: true } }),
    prisma.campaignCost.findMany({
      where: { date: range, campaign: nullableBranchWhere("branchId", opts.scope) },
      select: { campaignId: true, date: true, amount: true },
    }),
    prisma.lead.findMany({
      where: { createdAt: range, ...nullableBranchWhere("branchId", opts.scope) },
      select: { createdAt: true, campaignId: true, channelId: true, adId: true, adPostId: true, adCampaign: true },
    }),
    prisma.conversation.findMany({
      where: { createdAt: range, kind: ConversationKind.CUSTOMER, leadId: null, ...nullableBranchWhere("branchId", opts.scope) },
      select: { createdAt: true, pancakePage: { select: { channelId: true } }, customer: { select: CUSTOMER_SRC } },
    }),
    prisma.lead.findMany({
      where: { hasPhoneAt: range, ...nullableBranchWhere("branchId", opts.scope) },
      select: { hasPhoneAt: true, campaignId: true, channelId: true, adId: true, adPostId: true, adCampaign: true },
    }),
    prisma.customer.findMany({
      where: {
        createdAt: range,
        phone: { not: null },
        leadOrigin: null,
        conversations: { some: { leadId: null } },
        branchLinks: { some: { branchId: { in: branchIds } } },
      },
      select: { createdAt: true, ...CUSTOMER_SRC },
    }),
    prisma.appointment.findMany({
      where: { branchId: { in: branchIds }, depositConfirmedAt: range },
      select: { depositConfirmedAt: true, customer: { select: CUSTOMER_SRC } },
    }),
    prisma.visit.findMany({
      where: { branchId: { in: branchIds }, checkedInAt: range },
      select: { customerId: true, checkedInAt: true, customer: { select: CUSTOMER_SRC } },
    }),
    prisma.payment.findMany({
      where: { branchId: { in: branchIds }, paidAt: range, ...REAL_MONEY },
      select: { paidAt: true, amount: true, customer: { select: CUSTOMER_SRC } },
    }),
  ]);

  // Khách đến LẦN ĐẦU: lần check-in sớm nhất mọi thời điểm rơi vào kỳ.
  const firstVisit = await prisma.visit.groupBy({
    by: ["customerId"],
    _min: { checkedInAt: true },
    where: { customerId: { in: [...new Set(visits.map((v) => v.customerId))] } },
  });
  const firstOf = new Map(firstVisit.map((f) => [f.customerId, f._min.checkedInAt?.getTime() ?? 0]));

  const campaignChannel = new Map(campaigns.map((c) => [c.id, c.channelId]));
  const channelName = new Map(channels.map((c) => [c.id, c.name]));

  type Bucket = { total: RawMetrics; ads: RawMetrics; organic: RawMetrics; channel: Map<string, RawMetrics>; campaign: Map<string, RawMetrics> };
  const weeks = new Map<number, Bucket>();
  for (let i = 0; i < opts.weeks; i++) {
    weeks.set(firstStart.getTime() + i * 7 * DAY_MS, { total: emptyRaw(), ads: emptyRaw(), organic: emptyRaw(), channel: new Map(), campaign: new Map() });
  }
  const bump = (at: Date, a: Attribution, field: keyof RawMetrics, n: number) => {
    const b = weeks.get(startOfVnWeek(at).getTime());
    if (!b) return;
    b.total[field] += n;
    (a.ads ? b.ads : b.organic)[field] += n;
    const ch = a.channelId ?? "_none";
    if (!b.channel.has(ch)) b.channel.set(ch, emptyRaw());
    b.channel.get(ch)![field] += n;
    if (a.campaignId) {
      if (!b.campaign.has(a.campaignId)) b.campaign.set(a.campaignId, emptyRaw());
      b.campaign.get(a.campaignId)![field] += n;
    }
  };
  const leadAttr = (l: { campaignId: string | null; channelId: string | null; adId: string | null; adPostId: string | null; adCampaign: string | null }): Attribution => ({
    campaignId: l.campaignId,
    channelId: l.channelId ?? (l.campaignId ? (campaignChannel.get(l.campaignId) ?? null) : null),
    ads: isAdsLead(l),
  });

  for (const c of costs) bump(c.date, { campaignId: c.campaignId, channelId: campaignChannel.get(c.campaignId) ?? null, ads: true }, "cost", c.amount);
  for (const l of leads) bump(l.createdAt, leadAttr(l), "newMessages", 1);
  for (const c of convs) {
    const a: Attribution = c.customer ? customerAttribution(c.customer, campaignChannel) : { campaignId: null, channelId: null, ads: false };
    if (!a.channelId) a.channelId = c.pancakePage?.channelId ?? null;
    bump(c.createdAt, a, "newMessages", 1);
  }
  for (const l of phoneLeads) bump(l.hasPhoneAt!, leadAttr(l), "phones", 1);
  for (const c of phoneCustomers) bump(c.createdAt, customerAttribution(c, campaignChannel), "phones", 1);
  for (const d of deposits) bump(d.depositConfirmedAt!, customerAttribution(d.customer, campaignChannel), "depositBookings", 1);
  const seenFirst = new Set<string>();
  for (const v of visits) {
    if (firstOf.get(v.customerId) !== v.checkedInAt.getTime() || seenFirst.has(v.customerId)) continue;
    seenFirst.add(v.customerId);
    bump(v.checkedInAt, customerAttribution(v.customer, campaignChannel), "showups", 1);
  }
  for (const p of payments) bump(p.paidAt, customerAttribution(p.customer, campaignChannel), "revenue", p.amount);

  const campaignById = new Map(campaigns.map((c) => [c.id, c]));
  return [...weeks.entries()].map(([start, b]) => ({
    weekKey: vnWeekKey(new Date(start + 12 * 3_600_000)),
    from: new Date(start),
    to: new Date(start + 7 * DAY_MS),
    total: finishMetrics(b.total),
    ads: finishMetrics(b.ads),
    organic: finishMetrics(b.organic),
    byChannel: [...b.channel.entries()]
      .map(([id, m]) => ({ channelId: id === "_none" ? null : id, name: id === "_none" ? "Không rõ kênh" : (channelName.get(id) ?? "Kênh đã xoá"), ...finishMetrics(m) }))
      .sort((x, y) => y.revenue - x.revenue || y.cost - x.cost),
    byCampaign: [...b.campaign.entries()]
      .map(([id, m]) => {
        const c = campaignById.get(id);
        return { campaignId: id, code: c?.code ?? "", name: c?.name ?? "Chiến dịch đã xoá", channel: c?.channel?.name ?? "Không rõ", ...finishMetrics(m) };
      })
      .sort((x, y) => y.cost - x.cost || y.revenue - x.revenue),
  }));
}

// ======================================================= F16 HỌP CUỐI NGÀY

export interface EodRow {
  userId: string;
  name: string;
  newMessages: number;
  phones: number;
  depositBookings: number;
  showups: number;
  overdueTasks: number;
  noPhoneConversations: number;
  noPhoneList: Array<{ id: string; title: string; lastMessageAt: Date | null }>;
}

/** Một màn cho một ngày (giờ VN), theo từng sale. `onlyUserId` = sale chỉ xem dòng của mình. */
export async function endOfDay(opts: { date: Date; branchIds: string[]; now: Date; onlyUserId?: string | null }): Promise<EodRow[]> {
  const start = startOfVnDay(opts.date);
  const day: Range = { gte: start, lt: new Date(start.getTime() + DAY_MS) };
  const overdueBefore = opts.now < day.lt ? opts.now : day.lt;
  const salesRoles = await settingList("payroll.salesRoles");
  const users = await prisma.user.findMany({
    where: {
      status: UserStatus.ACTIVE,
      branches: { some: { branchId: { in: opts.branchIds } } },
      ...(opts.onlyUserId ? { id: opts.onlyUserId } : { roleLinks: { some: { role: { code: { in: salesRoles } } } } }),
    },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });
  const ids = users.map((u) => u.id);
  const inBranch = { branchId: { in: opts.branchIds } };

  const [convNew, leadNew, leadPhone, custPhone, deposits, visits, overdue, noPhone] = await Promise.all([
    prisma.conversation.groupBy({ by: ["assignedToId"], _count: true, where: { ...inBranch, kind: ConversationKind.CUSTOMER, createdAt: day, assignedToId: { in: ids }, leadId: null } }),
    prisma.lead.groupBy({ by: ["assignedToId"], _count: true, where: { createdAt: day, assignedToId: { in: ids } } }),
    prisma.lead.groupBy({ by: ["assignedToId"], _count: true, where: { hasPhoneAt: day, assignedToId: { in: ids } } }),
    prisma.customer.findMany({
      where: { createdAt: day, phone: { not: null }, leadOrigin: null, OR: [{ assignedToId: { in: ids } }, { telesaleId: { in: ids } }] },
      select: { assignedToId: true, telesaleId: true },
    }),
    prisma.appointment.findMany({
      where: { ...inBranch, depositConfirmedAt: day },
      select: { customer: { select: { assignedToId: true, telesaleId: true } } },
    }),
    prisma.visit.findMany({
      where: { ...inBranch, checkedInAt: day },
      select: { customerId: true, customer: { select: { assignedToId: true, telesaleId: true } } },
    }),
    prisma.task.groupBy({
      by: ["assigneeId"],
      _count: true,
      where: { assigneeId: { in: ids }, status: { in: [TaskStatus.OPEN, TaskStatus.IN_PROGRESS] }, dueAt: { lt: overdueBefore } },
    }),
    prisma.conversation.findMany({
      where: {
        ...inBranch,
        kind: ConversationKind.CUSTOMER,
        assignedToId: { in: ids },
        lastMessageAt: { gte: new Date(day.lt.getTime() - 7 * DAY_MS), lt: day.lt },
        OR: [{ customerId: null }, { customer: { phone: null } }],
      },
      select: { id: true, title: true, lastMessageAt: true, assignedToId: true, leadId: true },
      orderBy: { lastMessageAt: "desc" },
    }),
  ]);
  // Hội thoại chưa có hồ sơ nhưng lead đã có SĐT thì không tính "chưa có SĐT".
  const leadIds = noPhone.map((c) => c.leadId).filter((x): x is string => Boolean(x));
  const leadsWithPhone = new Set(
    (await prisma.lead.findMany({ where: { id: { in: leadIds }, phone: { not: null } }, select: { id: true } })).map((l) => l.id)
  );

  const count = (rows: Array<{ _count: number } & Record<string, unknown>>, key: string, id: string) =>
    rows.find((r) => r[key] === id)?._count ?? 0;
  return users.map((u) => {
    const noPhoneMine = noPhone.filter((c) => c.assignedToId === u.id && !(c.leadId && leadsWithPhone.has(c.leadId)));
    return {
      userId: u.id,
      name: u.name,
      newMessages: count(convNew, "assignedToId", u.id) + count(leadNew, "assignedToId", u.id),
      phones: count(leadPhone, "assignedToId", u.id) + custPhone.filter((c) => responsibleSaleOf(c) === u.id).length,
      depositBookings: deposits.filter((d) => responsibleSaleOf(d.customer) === u.id).length,
      showups: new Set(visits.filter((v) => responsibleSaleOf(v.customer) === u.id).map((v) => v.customerId)).size,
      overdueTasks: count(overdue, "assigneeId", u.id),
      noPhoneConversations: noPhoneMine.length,
      noPhoneList: noPhoneMine.slice(0, 20).map((c) => ({ id: c.id, title: c.title, lastMessageAt: c.lastMessageAt })),
    };
  });
}

// ================================================ F31 TỐC ĐỘ TRẢ LỜI ĐẦU TIÊN

export type ResponseBucket = "FAST" | "MID" | "SLOW" | "NO_REPLY";

/** Phút phản hồi -> nhóm. fast = dưới N phút, slow = trên M phút. */
export function bucketOf(minutes: number | null, fast: number, slow: number): ResponseBucket {
  if (minutes === null) return "NO_REPLY";
  if (minutes < fast) return "FAST";
  if (minutes <= slow) return "MID";
  return "SLOW";
}

/**
 * Mỗi hội thoại khách mở trong kỳ: phút từ tin khách ĐẦU TIÊN tới tin trả lời
 * đầu tiên; kết quả sau đó: có SĐT, khách đến, chốt (hợp đồng ký không huỷ).
 * Một lượt đọc tin (sắp theo hội thoại, thời gian), không lồng vòng: O(n).
 */
export async function responseBuckets(range: Range, branchIds: string[]) {
  const fast = await getSettingNumber("report.responseFastMinutes");
  const slow = await getSettingNumber("report.responseSlowMinutes");
  const convs = await prisma.conversation.findMany({
    where: { branchId: { in: branchIds }, kind: ConversationKind.CUSTOMER, createdAt: range },
    select: { id: true, customerId: true, leadId: true, customer: { select: { phone: true } } },
  });
  const ids = convs.map((c) => c.id);
  const messages = ids.length
    ? await prisma.chatMessage.findMany({
        where: { conversationId: { in: ids } },
        orderBy: [{ conversationId: "asc" }, { createdAt: "asc" }],
        select: { conversationId: true, direction: true, createdAt: true },
      })
    : [];
  const firstIn = new Map<string, Date>();
  const firstReply = new Map<string, Date>();
  for (const m of messages) {
    if (m.direction === MessageDirection.IN) {
      if (!firstIn.has(m.conversationId)) firstIn.set(m.conversationId, m.createdAt);
    } else if (firstIn.has(m.conversationId) && !firstReply.has(m.conversationId)) {
      firstReply.set(m.conversationId, m.createdAt);
    }
  }

  const customerIds = [...new Set(convs.map((c) => c.customerId).filter((x): x is string => Boolean(x)))];
  const leadIds = convs.map((c) => c.leadId).filter((x): x is string => Boolean(x));
  const [visits, contracts, leads] = await Promise.all([
    prisma.visit.groupBy({ by: ["customerId"], _max: { checkedInAt: true }, where: { customerId: { in: customerIds } } }),
    prisma.contract.groupBy({
      by: ["customerId"],
      _max: { signedAt: true },
      where: { customerId: { in: customerIds }, signedAt: { not: null }, status: { not: ContractStatus.CANCELLED } },
    }),
    prisma.lead.findMany({ where: { id: { in: leadIds } }, select: { id: true, hasPhoneAt: true, phone: true } }),
  ]);
  const lastVisit = new Map(visits.map((v) => [v.customerId, v._max.checkedInAt]));
  const lastSigned = new Map(contracts.map((c) => [c.customerId, c._max.signedAt]));
  const leadById = new Map(leads.map((l) => [l.id, l]));

  const agg = new Map<ResponseBucket, { conversations: number; minutes: number; replied: number; phone: number; showed: number; closed: number }>();
  for (const b of ["FAST", "MID", "SLOW", "NO_REPLY"] as ResponseBucket[]) agg.set(b, { conversations: 0, minutes: 0, replied: 0, phone: 0, showed: 0, closed: 0 });
  for (const c of convs) {
    const start = firstIn.get(c.id);
    if (!start) continue; // chưa có tin khách: không phải hội thoại khách mở
    const reply = firstReply.get(c.id);
    const minutes = reply ? Math.round((reply.getTime() - start.getTime()) / 60000) : null;
    const a = agg.get(bucketOf(minutes, fast, slow))!;
    a.conversations++;
    if (minutes !== null) {
      a.minutes += minutes;
      a.replied++;
    }
    const lead = c.leadId ? leadById.get(c.leadId) : undefined;
    if (c.customer?.phone || lead?.phone || lead?.hasPhoneAt) a.phone++;
    const v = c.customerId ? lastVisit.get(c.customerId) : null;
    if (v && v >= start) a.showed++;
    const s = c.customerId ? lastSigned.get(c.customerId) : null;
    if (s && s >= start) a.closed++;
  }
  const LABEL: Record<ResponseBucket, string> = {
    FAST: `Dưới ${fast} phút`,
    MID: `${fast} đến ${slow} phút`,
    SLOW: `Trên ${slow} phút`,
    NO_REPLY: "Chưa trả lời",
  };
  return {
    fastMinutes: fast,
    slowMinutes: slow,
    rows: [...agg.entries()].map(([bucket, a]) => ({
      bucket,
      label: LABEL[bucket],
      conversations: a.conversations,
      avgMinutes: a.replied ? Math.round(a.minutes / a.replied) : null,
      phoneRate: ratio(a.phone, a.conversations),
      showRate: ratio(a.showed, a.conversations),
      closeRate: ratio(a.closed, a.conversations),
    })),
  };
}

// =========================================================== F22 LÃI GỘP

export type MarginGroup = "service" | "doctor" | "branch" | "month";

/** Giá vốn một lần dùng vật tư: costAtUse (F14); dữ liệu cũ thì đơn giá lô x lượng dùng thật. */
export function usageCost(u: { costAtUse: number | null; quantity: number; quantityTenths: number | null; lot: { unitCost: number } | null }): number {
  if (u.costAtUse != null) return u.costAtUse;
  const tenths = u.quantityTenths ?? u.quantity * 10;
  return Math.round(((u.lot?.unitCost ?? 0) * tenths) / 10);
}

/**
 * Lãi gộp theo lần thực hiện HOÀN TẤT trong kỳ:
 *   doanh thu   giá trị dòng hợp đồng của dịch vụ đó chia số lượng (một lần làm)
 *   giá vốn     tổng giá vốn vật tư dùng cho lần đó
 *   hoa hồng    hoa hồng của hợp đồng phân bổ theo tỉ lệ doanh thu lần làm / tổng hợp đồng
 */
export async function grossMargin(range: Range, branchIds: string[], groupBy: MarginGroup) {
  const procs = await prisma.procedureRecord.findMany({
    where: { branchId: { in: branchIds }, status: ProcedureStatus.COMPLETED, finishedAt: range },
    select: {
      id: true,
      finishedAt: true,
      branchId: true,
      serviceId: true,
      contractId: true,
      title: true,
      service: { select: { name: true } },
      surgeon: { select: { id: true, name: true } },
      branch: { select: { name: true } },
      productUsages: { select: { costAtUse: true, quantity: true, quantityTenths: true, lot: { select: { unitCost: true } } } },
    },
  });
  const contractIds = [...new Set(procs.map((p) => p.contractId).filter((x): x is string => Boolean(x)))];
  const [contracts, commissions] = await Promise.all([
    prisma.contract.findMany({
      where: { id: { in: contractIds } },
      select: { id: true, total: true, items: { select: { serviceId: true, amount: true, quantity: true } } },
    }),
    prisma.commissionEntry.groupBy({ by: ["contractId"], _sum: { amount: true }, where: { contractId: { in: contractIds } } }),
  ]);
  const contractById = new Map(contracts.map((c) => [c.id, c]));
  const commissionOf = new Map(commissions.map((c) => [c.contractId!, c._sum.amount ?? 0]));

  const groups = new Map<string, { key: string; label: string; count: number; revenue: number; cost: number; commission: number }>();
  for (const p of procs) {
    const contract = p.contractId ? contractById.get(p.contractId) : undefined;
    const item = contract?.items.find((i) => i.serviceId && i.serviceId === p.serviceId);
    const revenue = item ? Math.round(item.amount / Math.max(1, item.quantity)) : 0;
    const cost = p.productUsages.reduce((s, u) => s + usageCost(u), 0);
    const commission = contract && contract.total > 0 ? Math.round(((commissionOf.get(contract.id) ?? 0) * revenue) / contract.total) : 0;

    const [key, label] =
      groupBy === "doctor"
        ? [p.surgeon?.id ?? "_none", p.surgeon?.name ?? "Chưa ghi bác sĩ"]
        : groupBy === "branch"
          ? [p.branchId, p.branch.name]
          : groupBy === "month"
            ? [vnPeriodKey(p.finishedAt!), vnPeriodKey(p.finishedAt!)]
            : [p.serviceId ?? `_t:${p.title}`, p.service?.name ?? p.title];
    const g = groups.get(key) ?? { key, label, count: 0, revenue: 0, cost: 0, commission: 0 };
    g.count++;
    g.revenue += revenue;
    g.cost += cost;
    g.commission += commission;
    groups.set(key, g);
  }
  const rows = [...groups.values()].map((g) => {
    const grossMargin = g.revenue - g.cost - g.commission;
    return { ...g, grossMargin, marginPercent: ratio(grossMargin, g.revenue) };
  });
  rows.sort((a, b) => (groupBy === "month" ? a.key.localeCompare(b.key) : b.grossMargin - a.grossMargin));
  const total = rows.reduce(
    (s, r) => ({ count: s.count + r.count, revenue: s.revenue + r.revenue, cost: s.cost + r.cost, commission: s.commission + r.commission }),
    { count: 0, revenue: 0, cost: 0, commission: 0 }
  );
  const totalMargin = total.revenue - total.cost - total.commission;
  return { rows, total: { ...total, grossMargin: totalMargin, marginPercent: ratio(totalMargin, total.revenue) } };
}

// ========================================================= F23 QUAY LẠI

export const RETENTION_WINDOWS = [90, 180, 365] as const;

interface DoneProc {
  customerId: string;
  serviceId: string;
  at: Date;
}

/**
 * Tỉ lệ quay lại theo nhóm tháng làm lần đầu và dịch vụ. Một khách vào nhóm của
 * tháng làm dịch vụ đó LẦN ĐẦU; "quay lại sau N ngày" = có lần làm cùng dịch vụ
 * vào ngày khác, trong vòng N ngày. Chỉ tính khách đã đủ N ngày (eligible).
 */
export function computeRetention(done: DoneProc[], now: Date, cohortFrom?: string, cohortTo?: string) {
  const byPair = new Map<string, Date[]>();
  for (const d of done) {
    const k = `${d.customerId}|${d.serviceId}`;
    const list = byPair.get(k);
    if (list) list.push(d.at);
    else byPair.set(k, [d.at]);
  }
  const cohorts = new Map<string, { serviceId: string; cohort: string; customers: number; windows: Record<number, { eligible: number; returned: number }> }>();
  for (const [k, times] of byPair) {
    times.sort((a, b) => a.getTime() - b.getTime());
    const first = times[0];
    const cohort = vnPeriodKey(first);
    if ((cohortFrom && cohort < cohortFrom) || (cohortTo && cohort > cohortTo)) continue;
    const serviceId = k.split("|")[1];
    const firstDay = vnDayKey(first);
    const next = times.find((t) => vnDayKey(t) !== firstDay && t > first);
    const key = `${serviceId}|${cohort}`;
    const c = cohorts.get(key) ?? {
      serviceId,
      cohort,
      customers: 0,
      windows: Object.fromEntries(RETENTION_WINDOWS.map((w) => [w, { eligible: 0, returned: 0 }])) as Record<number, { eligible: number; returned: number }>,
    };
    c.customers++;
    for (const w of RETENTION_WINDOWS) {
      if (first.getTime() + w * DAY_MS > now.getTime()) continue; // chưa đủ N ngày
      c.windows[w].eligible++;
      if (next && next.getTime() - first.getTime() <= w * DAY_MS) c.windows[w].returned++;
    }
    cohorts.set(key, c);
  }
  return [...cohorts.values()].map((c) => ({
    serviceId: c.serviceId,
    cohort: c.cohort,
    customers: c.customers,
    ...Object.fromEntries(
      RETENTION_WINDOWS.map((w) => [`d${w}`, { eligible: c.windows[w].eligible, returned: c.windows[w].returned, rate: ratio(c.windows[w].returned, c.windows[w].eligible) }])
    ),
  })) as Array<{
    serviceId: string;
    cohort: string;
    customers: number;
    d90: { eligible: number; returned: number; rate: number | null };
    d180: { eligible: number; returned: number; rate: number | null };
    d365: { eligible: number; returned: number; rate: number | null };
  }>;
}

export async function retention(opts: { branchIds: string[]; now: Date; from?: string; to?: string; serviceId?: string }) {
  const procs = await prisma.procedureRecord.findMany({
    where: {
      branchId: { in: opts.branchIds },
      status: ProcedureStatus.COMPLETED,
      serviceId: opts.serviceId ? opts.serviceId : { not: null },
    },
    select: { customerId: true, serviceId: true, finishedAt: true, scheduledAt: true },
  });
  const rows = computeRetention(
    procs.map((p) => ({ customerId: p.customerId, serviceId: p.serviceId!, at: p.finishedAt ?? p.scheduledAt })),
    opts.now,
    opts.from,
    opts.to
  );
  const services = await prisma.service.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.serviceId))] } }, select: { id: true, name: true } });
  const nameOf = new Map(services.map((s) => [s.id, s.name]));
  return rows
    .map((r) => ({ ...r, serviceName: nameOf.get(r.serviceId) ?? "Dịch vụ đã xoá" }))
    .sort((a, b) => a.serviceName.localeCompare(b.serviceName) || a.cohort.localeCompare(b.cohort));
}

/** Khách đến hạn tái tiêm: lần làm gần nhất của mỗi (khách, dịch vụ) có mốc tái tiêm đã tới hoặc sắp tới. */
export async function retreatDue(opts: { branchIds: string[]; now: Date; ownerId?: string | null }) {
  const soon = Math.max(0, await getSettingNumber("retention.dueSoonDays"));
  const until = new Date(startOfVnDay(opts.now).getTime() + (soon + 1) * DAY_MS);
  const due = await prisma.procedureRecord.findMany({
    where: {
      branchId: { in: opts.branchIds },
      status: ProcedureStatus.COMPLETED,
      retreatDueAt: { not: null, lt: until },
      serviceId: { not: null },
      ...(opts.ownerId ? { customer: { OR: [{ assignedToId: opts.ownerId }, { telesaleId: opts.ownerId }] } } : {}),
    },
    orderBy: { retreatDueAt: "asc" },
    take: 2000,
    select: {
      id: true,
      customerId: true,
      serviceId: true,
      finishedAt: true,
      scheduledAt: true,
      retreatDueAt: true,
      service: { select: { name: true } },
      customer: { select: { id: true, code: true, name: true, phone: true, assignedTo: { select: { id: true, name: true } } } },
    },
  });
  if (!due.length) return [];
  // Đã làm lại cùng dịch vụ sau lần đó thì không còn "đến hạn".
  const later = await prisma.procedureRecord.findMany({
    where: {
      customerId: { in: [...new Set(due.map((d) => d.customerId))] },
      status: { in: [ProcedureStatus.COMPLETED, ProcedureStatus.SCHEDULED, ProcedureStatus.CONFIRMED, ProcedureStatus.IN_PROGRESS] },
      serviceId: { in: [...new Set(due.map((d) => d.serviceId!))] },
    },
    select: { id: true, customerId: true, serviceId: true, scheduledAt: true, finishedAt: true },
  });
  const seen = new Set<string>();
  const out = [];
  for (const d of due) {
    const doneAt = d.finishedAt ?? d.scheduledAt;
    const pair = `${d.customerId}|${d.serviceId}`;
    if (seen.has(pair)) continue;
    const redone = later.some((l) => l.id !== d.id && l.customerId === d.customerId && l.serviceId === d.serviceId && (l.finishedAt ?? l.scheduledAt) > doneAt);
    if (redone) continue;
    seen.add(pair);
    out.push({
      procedureId: d.id,
      customer: d.customer,
      serviceId: d.serviceId,
      serviceName: d.service?.name ?? "",
      lastDoneAt: doneAt,
      retreatDueAt: d.retreatDueAt,
      overdueDays: Math.floor((opts.now.getTime() - d.retreatDueAt!.getTime()) / DAY_MS),
    });
  }
  return out.slice(0, 500);
}

// ======================================================= F32 TRỌN ĐỜI

export type LtvGroup = "channel" | "campaign" | "month";

/** Doanh thu trong kỳ tách khách mới (mua lần đầu trong kỳ) và khách quay lại. */
export async function newVsReturning(range: Range, branchIds: string[]) {
  const rows = await prisma.payment.groupBy({
    by: ["customerId"],
    _sum: { amount: true },
    where: { branchId: { in: branchIds }, paidAt: range, ...REAL_MONEY },
  });
  const customers = await prisma.customer.findMany({ where: { id: { in: rows.map((r) => r.customerId) } }, select: { id: true, firstPurchaseAt: true } });
  const firstOf = new Map(customers.map((c) => [c.id, c.firstPurchaseAt]));
  const out = { newCustomers: 0, newRevenue: 0, returningCustomers: 0, returningRevenue: 0 };
  for (const r of rows) {
    const f = firstOf.get(r.customerId);
    const isNew = !f || (f >= range.gte && f < range.lt);
    const amt = r._sum.amount ?? 0;
    if (isNew) {
      out.newCustomers++;
      out.newRevenue += amt;
    } else {
      out.returningCustomers++;
      out.returningRevenue += amt;
    }
  }
  return out;
}

/** LTV = tổng tiền đã thu mọi thời điểm / số khách, theo kênh, chiến dịch hoặc tháng mua đầu. */
export async function lifetimeValue(opts: { branchIds: string[]; groupBy: LtvGroup; firstFrom?: Date; firstTo?: Date }) {
  const customers = await prisma.customer.findMany({
    where: {
      firstPurchaseAt: { not: null, ...(opts.firstFrom ? { gte: opts.firstFrom } : {}), ...(opts.firstTo ? { lt: opts.firstTo } : {}) },
      branchLinks: { some: { branchId: { in: opts.branchIds } } },
      mergedIntoId: null,
    },
    select: { id: true, firstPurchaseAt: true, ...CUSTOMER_SRC, channel: { select: { name: true } }, campaign: { select: { name: true, code: true } } },
  });
  const paid = await prisma.payment.groupBy({
    by: ["customerId"],
    _sum: { amount: true },
    where: { customerId: { in: customers.map((c) => c.id) }, ...REAL_MONEY },
  });
  const paidOf = new Map(paid.map((p) => [p.customerId, p._sum.amount ?? 0]));
  const campaigns = await prisma.campaign.findMany({ select: { id: true, name: true } });
  const campaignName = new Map(campaigns.map((c) => [c.id, c.name]));
  const groups = new Map<string, { key: string; label: string; customers: number; revenue: number }>();
  for (const c of customers) {
    const campaignId = c.campaignId ?? c.leadOrigin?.campaignId ?? null;
    const [key, label] =
      opts.groupBy === "campaign"
        ? [campaignId ?? "_none", campaignId ? (campaignName.get(campaignId) ?? "Chiến dịch đã xoá") : "Không có chiến dịch"]
        : opts.groupBy === "month"
          ? [vnPeriodKey(c.firstPurchaseAt!), vnPeriodKey(c.firstPurchaseAt!)]
          : [c.channelId ?? "_none", c.channel?.name ?? "Không rõ kênh"];
    const g = groups.get(key) ?? { key, label, customers: 0, revenue: 0 };
    g.customers++;
    g.revenue += paidOf.get(c.id) ?? 0;
    groups.set(key, g);
  }
  return [...groups.values()]
    .map((g) => ({ ...g, ltv: g.customers ? Math.round(g.revenue / g.customers) : 0 }))
    .sort((a, b) => (opts.groupBy === "month" ? a.key.localeCompare(b.key) : b.revenue - a.revenue));
}

// =================================================== F34 CHỈ TIÊU, DỰ BÁO

export function targetScopeKey(periodKey: string, branchId: string | null, serviceId: string | null): string {
  return `${periodKey}|${branchId ?? "*"}|${serviceId ?? "*"}`;
}

/** Số ngày của tháng, số ngày đã qua (tính cả hôm nay) theo giờ VN. */
export function monthProgress(periodKey: string, now: Date): { daysInMonth: number; elapsedDays: number; range: Range } {
  const range = vnMonthRange(periodKey);
  const daysInMonth = Math.round((range.lt.getTime() - range.gte.getTime()) / DAY_MS);
  let elapsedDays: number;
  if (now >= range.lt) elapsedDays = daysInMonth;
  else if (now < range.gte) elapsedDays = 0;
  else elapsedDays = Math.floor((startOfVnDay(now).getTime() - range.gte.getTime()) / DAY_MS) + 1;
  return { daysInMonth, elapsedDays, range };
}

/**
 * Dự báo cuối tháng = nhịp hiện tại (thực thu / số ngày đã qua x số ngày của
 * tháng) + giá trị lịch đã hẹn từ bây giờ tới cuối tháng (giá niêm yết dịch vụ
 * của lịch, trừ phần cọc đã nhận vì cọc đã nằm trong thực thu).
 */
export function forecastMath(input: { actual: number; elapsedDays: number; daysInMonth: number; bookedValue: number }) {
  const runRatePerDay = input.elapsedDays > 0 ? input.actual / input.elapsedDays : 0;
  const runRateForecast = Math.round(runRatePerDay * input.daysInMonth);
  return {
    runRatePerDay: Math.round(runRatePerDay),
    runRateForecast,
    forecast: runRateForecast + input.bookedValue,
  };
}

/** Doanh thu đã thu phân bổ theo dịch vụ (dòng hợp đồng); phiếu không gắn hợp đồng vào "_none". */
async function revenueByService(range: Range, branchIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (const p of await collectedPayments(range, branchIds)) {
    const items = p.contract?.items ?? [];
    if (!items.length) {
      out.set("_none", (out.get("_none") ?? 0) + p.amount);
      continue;
    }
    for (const part of allocate(p.amount, items.map((i) => ({ ...i, weight: i.amount })))) {
      const k = part.serviceId ?? "_none";
      out.set(k, (out.get(k) ?? 0) + part.share);
    }
  }
  return out;
}

async function sumCollected(range: Range, branchIds: string[]): Promise<number> {
  const agg = await prisma.payment.aggregate({ where: { branchId: { in: branchIds }, paidAt: range, ...REAL_MONEY }, _sum: { amount: true } });
  return agg._sum.amount ?? 0;
}

export async function forecast(opts: { periodKey: string; branchIds: string[]; now: Date }) {
  const { daysInMonth, elapsedDays, range } = monthProgress(opts.periodKey, opts.now);
  const actualRange: Range = { gte: range.gte, lt: opts.now < range.lt ? (opts.now > range.gte ? opts.now : range.gte) : range.lt };
  const actual = await sumCollected(actualRange, opts.branchIds);

  // Lịch đã hẹn từ bây giờ tới cuối tháng.
  const bookedFrom = opts.now > range.gte ? opts.now : range.gte;
  const appts =
    bookedFrom < range.lt
      ? await prisma.appointment.findMany({
          where: {
            branchId: { in: opts.branchIds },
            startAt: { gte: bookedFrom, lt: range.lt },
            status: { in: [AppointmentStatus.PENDING, AppointmentStatus.CONFIRMED] },
            serviceId: { not: null },
          },
          select: { serviceId: true, branchId: true, depositAmount: true, depositStatus: true },
        })
      : [];
  let bookedValue = 0;
  const priceCache = new Map<string, number>();
  for (const a of appts) {
    const k = `${a.serviceId}|${a.branchId}`;
    if (!priceCache.has(k)) priceCache.set(k, (await currentListPrice(a.serviceId!, a.branchId))?.price ?? 0);
    const paidDeposit = a.depositStatus === "DA_COC" ? a.depositAmount : 0;
    bookedValue += Math.max(0, priceCache.get(k)! - paidDeposit);
  }
  const math = forecastMath({ actual, elapsedDays, daysInMonth, bookedValue });

  // So cùng kỳ tháng trước theo cùng số ngày.
  const prev = vnMonthRange(previousPeriodKey(opts.periodKey));
  const prevDays = Math.round((prev.lt.getTime() - prev.gte.getTime()) / DAY_MS);
  const prevSameDays = await sumCollected({ gte: prev.gte, lt: new Date(prev.gte.getTime() + Math.min(elapsedDays, prevDays) * DAY_MS) }, opts.branchIds);

  // Chỉ tiêu theo cơ sở và dịch vụ.
  const targets = await prisma.salesTarget.findMany({ where: { periodKey: opts.periodKey } });
  const [branches, services, byService, byBranchRows] = await Promise.all([
    prisma.branch.findMany({ where: { id: { in: opts.branchIds } }, select: { id: true, name: true } }),
    prisma.service.findMany({ select: { id: true, name: true } }),
    revenueByService(actualRange, opts.branchIds),
    prisma.payment.groupBy({ by: ["branchId"], _sum: { amount: true }, where: { branchId: { in: opts.branchIds }, paidAt: actualRange, ...REAL_MONEY } }),
  ]);
  const serviceName = new Map(services.map((s) => [s.id, s.name]));
  const branchActual = new Map(byBranchRows.map((r) => [r.branchId, r._sum.amount ?? 0]));
  const branchTarget = (id: string) => targets.find((t) => t.branchId === id && !t.serviceId)?.targetRevenue ?? null;
  const allTarget = targets.find((t) => !t.branchId && !t.serviceId)?.targetRevenue ?? null;
  const branchTargets = branches.map((b) => branchTarget(b.id)).filter((x): x is number => x !== null);
  const target = allTarget ?? (branchTargets.length ? branchTargets.reduce((s, n) => s + n, 0) : null);

  const serviceTargets = new Map<string, number>();
  for (const t of targets) {
    if (!t.serviceId || (t.branchId && !opts.branchIds.includes(t.branchId))) continue;
    serviceTargets.set(t.serviceId, (serviceTargets.get(t.serviceId) ?? 0) + t.targetRevenue);
  }
  const serviceKeys = new Set([...serviceTargets.keys(), ...[...byService.keys()].filter((k) => k !== "_none")]);

  return {
    periodKey: opts.periodKey,
    daysInMonth,
    elapsedDays,
    actual,
    ...math,
    bookedValue,
    bookedCount: appts.length,
    prevSameDays,
    vsPrevPercent: prevSameDays > 0 ? round1(((actual - prevSameDays) / prevSameDays) * 100) : null,
    target,
    progressPercent: target ? ratio(actual, target) : null,
    forecastVsTargetPercent: target ? ratio(math.forecast, target) : null,
    byBranch: branches.map((b) => {
      const t = branchTarget(b.id);
      const a = branchActual.get(b.id) ?? 0;
      return { branchId: b.id, name: b.name, target: t, actual: a, progressPercent: t ? ratio(a, t) : null };
    }),
    byService: [...serviceKeys]
      .map((id) => {
        const t = serviceTargets.get(id) ?? null;
        const a = byService.get(id) ?? 0;
        return { serviceId: id, name: serviceName.get(id) ?? "Dịch vụ đã xoá", target: t, actual: a, progressPercent: t ? ratio(a, t) : null };
      })
      .sort((a, b) => (b.target ?? 0) - (a.target ?? 0) || b.actual - a.actual),
    unassignedRevenue: byService.get("_none") ?? 0,
  };
}
