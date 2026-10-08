import type { Request } from "express";
import { prisma } from "./prisma";
import { getSettingBool, getSettingNumber } from "./settings-catalog";
import { startOfVnDay } from "./datetime";
import { stageRank, stagesFor } from "./stages";
import { currentUser } from "../middleware/auth";
import { assertInScope, scopeOf } from "../middleware/rbac";
import { HttpError } from "../middleware/errorHandler";
import {
  AppointmentStatus,
  ApprovalStatus,
  ClinicMode,
  Heat,
  PermissionScope,
  QuotationStatus,
  StageAgeLevel,
  TaskStatus,
  TreatmentPlanStatus,
} from "../types/enums";

// Lô 7 · CRM 360 LÔ A: LUẬT TÍNH CHUNG cho bảng bước khách khối (P1, P2, P3),
// thanh 360 (C1) và dải hành trình (J1).
//
// Mọi ngưỡng đọc từ Cài đặt hệ thống (Quyết định 4). Hàm thuần (stageAge,
// heatOf, conversionFromHistory, buildJourney) tách riêng để test được không cần CSDL.

const DAY_MS = 86_400_000;

export const CUSTOMER_SCOPE = { ownerFields: ["assignedToId", "telesaleId"], branchField: null };

// ------------------------------------------------------------ QUYỀN XEM TIỀN

/**
 * Quyết định 3: số tiền trên thẻ khách và thanh 360 chỉ cho vai có `finance.read`
 * ở phạm vi cơ sở hoặc toàn hệ thống (Quản lý cơ sở, Giám đốc, Quản trị, Kế
 * toán). Telesale có finance.read phạm vi OWN (chỉ hợp đồng của mình), Tư vấn
 * viên cũng vậy: không tính là được xem tiền ở đây.
 */
export function canSeeMoney(req: Request): boolean {
  const s = scopeOf(req, "finance.read");
  return s === PermissionScope.ALL || s === PermissionScope.BRANCH;
}

/** Cờ y khoa chỉ hiện với `medical.read` (Quyết định 3). */
export function canSeeMedical(req: Request): boolean {
  return Boolean(scopeOf(req, "medical.read"));
}

/**
 * Quyền mở khách: phạm vi customer.read như mọi màn khách, CỘNG ngoại lệ màn chốt
 * tại quầy (V5): tư vấn viên được lễ tân giao tiếp khách vừa check-in hôm nay ở
 * cơ sở của mình thì mở được khách đó dù khách không thuộc mình phụ trách.
 */
export async function assertCustomerAccess(
  req: Request,
  customer: Record<string, unknown> | null,
  code = "customer.read"
): Promise<void> {
  try {
    assertInScope(req, code, customer, CUSTOMER_SCOPE);
  } catch (err) {
    if (!(err instanceof HttpError) || err.status !== 404 || !customer) throw err;
    const me = currentUser(req);
    const visit = await prisma.visit.findFirst({
      where: {
        customerId: customer.id as string,
        consultantId: me.id,
        branchId: { in: me.branchIds },
        checkedInAt: { gte: startOfVnDay(new Date()) },
      },
      select: { id: true },
    });
    if (!visit) throw err;
  }
}

// ------------------------------------------------------------ THAM SỐ

export interface PipelineParams {
  maxDays: Record<string, number>;
  defaultMaxDays: number;
  warnPercent: number;
  conversionDays: number;
  heat: { recentDays: number; recent: number; photo: number; appointment: number; quote: number; hotMin: number; warmMin: number };
}

const STAGE_KEYS_WITH_PARAM = ["TIEP_CAN", "NHAN_TIN", "CO_ANH", "LICH_COC", "DEN_CO_SO", "LAM_DICH_VU", "QUAY_LAI"];

export async function loadPipelineParams(): Promise<PipelineParams> {
  const maxDays: Record<string, number> = {};
  for (const k of STAGE_KEYS_WITH_PARAM) maxDays[k] = await getSettingNumber(`pipeline.stageMaxDays.${k}`);
  return {
    maxDays,
    defaultMaxDays: await getSettingNumber("pipeline.stageMaxDays.default"),
    warnPercent: await getSettingNumber("pipeline.warnPercent"),
    conversionDays: await getSettingNumber("pipeline.conversionDays"),
    heat: {
      recentDays: await getSettingNumber("heat.recentDays"),
      recent: await getSettingNumber("heat.weight.recent"),
      photo: await getSettingNumber("heat.weight.photo"),
      appointment: await getSettingNumber("heat.weight.appointment"),
      quote: await getSettingNumber("heat.weight.quote"),
      hotMin: await getSettingNumber("heat.hotMin"),
      warmMin: await getSettingNumber("heat.warmMin"),
    },
  };
}

export function maxDaysFor(params: PipelineParams, stage: string, lost: boolean): number {
  if (lost) return 0;
  return params.maxDays[stage] ?? params.defaultMaxDays;
}

// ------------------------------------------------------------ SỐ NGÀY Ở BƯỚC

/** Số ngày lịch (giờ Việt Nam) từ `since` tới `now`: vào bước hôm qua lúc 23h, sáng nay là 1 ngày. */
export function vnDaysBetween(since: Date, now: Date): number {
  return Math.max(0, Math.round((startOfVnDay(now).getTime() - startOfVnDay(since).getTime()) / DAY_MS));
}

export interface StageAge {
  days: number;
  maxDays: number;
  level: StageAgeLevel;
}

/**
 * P1: số ngày ở bước và mức màu. maxDays <= 0: bước không tính quá hạn (NONE).
 * Quá hạn khi days > maxDays; sắp quá hạn khi days >= ceil(maxDays × warnPercent%).
 */
export function stageAge(since: Date, now: Date, maxDays: number, warnPercent: number): StageAge {
  const days = vnDaysBetween(since, now);
  if (!(maxDays > 0)) return { days, maxDays: 0, level: StageAgeLevel.NONE };
  if (days > maxDays) return { days, maxDays, level: StageAgeLevel.OVERDUE };
  const warnAt = Math.max(1, Math.ceil((maxDays * warnPercent) / 100));
  return { days, maxDays, level: days >= warnAt ? StageAgeLevel.WARN : StageAgeLevel.OK };
}

// ------------------------------------------------------------ NHIỆT ĐỘ

export interface HeatInput {
  lost: boolean;
  lastInteractionAt: Date | null;
  hasPhoto: boolean;
  hasUpcomingAppointment: boolean;
  hasOpenQuote: boolean;
}

export interface HeatResult {
  heat: Heat;
  score: number;
  factors: string[];
}

/** P1: nóng, ấm, lạnh theo tổng điểm các dấu hiệu (trọng số, ngưỡng trong Cài đặt). */
export function heatOf(input: HeatInput, p: PipelineParams["heat"], now: Date): HeatResult {
  if (input.lost) return { heat: Heat.COLD, score: 0, factors: ["Đã mất khách"] };
  let score = 0;
  const factors: string[] = [];
  if (input.lastInteractionAt && now.getTime() - input.lastInteractionAt.getTime() <= p.recentDays * DAY_MS) {
    score += p.recent;
    factors.push(`Tương tác trong ${p.recentDays} ngày`);
  }
  if (input.hasPhoto) {
    score += p.photo;
    factors.push("Có ảnh");
  }
  if (input.hasUpcomingAppointment) {
    score += p.appointment;
    factors.push("Có lịch hẹn");
  }
  if (input.hasOpenQuote) {
    score += p.quote;
    factors.push("Có báo giá mở");
  }
  const heat = score >= p.hotMin ? Heat.HOT : score >= p.warmMin ? Heat.WARM : Heat.COLD;
  return { heat, score, factors };
}

// ------------------------------------------------------------ TỈ LỆ CHUYỂN

export interface ConversionStat {
  entered: number;
  moved: number;
  /** 0..1; null khi chưa ai vào bước trong kỳ. */
  rate: number | null;
}

/**
 * P2: tỉ lệ chuyển từ mỗi bước sang bước sau, đọc StageHistory trong kỳ.
 * Khách "vào bước S" = có dòng lịch sử toStage = S trong kỳ (đếm mỗi khách một
 * lần, lấy lần vào đầu tiên trong kỳ). "Đã chuyển" = sau lần vào đó có dòng
 * lịch sử tới một bước TIẾN hơn S (không tính mất khách).
 */
export function conversionFromHistory(
  rows: Array<{ customerId: string; toStage: string; createdAt: Date }>,
  mode: ClinicMode
): Map<string, ConversionStat> {
  const sorted = [...rows].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const byCustomer = new Map<string, typeof sorted>();
  for (const r of sorted) {
    const list = byCustomer.get(r.customerId) ?? [];
    list.push(r);
    byCustomer.set(r.customerId, list);
  }
  const out = new Map<string, ConversionStat>();
  for (const st of stagesFor(mode)) {
    if (st.lost) continue;
    const rank = stageRank(mode, st.key);
    let entered = 0;
    let moved = 0;
    for (const list of byCustomer.values()) {
      const idx = list.findIndex((r) => r.toStage === st.key);
      if (idx < 0) continue;
      entered++;
      if (list.slice(idx + 1).some((r) => stageRank(mode, r.toStage) > rank)) moved++;
    }
    out.set(st.key, { entered, moved, rate: entered ? moved / entered : null });
  }
  return out;
}

// ------------------------------------------------------------ HÀNH TRÌNH (J1)

export type MilestoneKind =
  | "SOURCE"
  | "FIRST_MESSAGE"
  | "PHOTO"
  | "DEPOSIT"
  | "VISIT"
  | "SERVICE"
  | "AFTERCARE"
  | "APPOINTMENT"
  | "RETREAT";

export interface MilestoneInput {
  kind: MilestoneKind;
  label: string;
  detail?: string | null;
  at: Date;
}

export interface Milestone extends MilestoneInput {
  future: boolean;
  /** Số ngày (lịch VN) kể từ mốc trước; null ở mốc đầu. */
  gapDays: number | null;
}

/** J1: xếp mốc theo thời gian, đánh dấu mốc tương lai, tính khoảng cách với mốc trước. */
export function buildJourney(events: MilestoneInput[], now: Date): Milestone[] {
  const sorted = [...events].sort((a, b) => a.at.getTime() - b.at.getTime());
  return sorted.map((e, i) => ({
    ...e,
    detail: e.detail ?? null,
    future: e.at.getTime() > now.getTime(),
    gapDays: i === 0 ? null : vnDaysBetween(sorted[i - 1].at, e.at),
  }));
}

// ------------------------------------------------------------ CHỈ SỐ HÀNG LOẠT

export interface MetricCustomer {
  /** Khoá đơn vị trên bảng: id khách (Lô A) hoặc id cơ hội (Lô B). */
  id: string;
  /** Lô 8 · P6: khách của đơn vị (mặc định = id). */
  customerId?: string;
  /** Lô 8 · P6: cơ hội của đơn vị; số ngày ở bước đọc lịch sử của cơ hội. */
  opportunityId?: string | null;
  /** Giá trị dự kiến nhập tay trên cơ hội (ưu tiên nhất). */
  fixedValue?: number | null;
  /** Dịch vụ của cơ hội. */
  oppServiceId?: string | null;
  /** Đơn vị chính của khách (cơ hội hiện tại): được tính dịch vụ quan tâm, việc chưa gắn cơ hội. */
  primaryUnit?: boolean;
  stage: string;
  /** Ngày tạo khách, hoặc ngày mở cơ hội khi có opportunityId. */
  createdAt: Date;
  stageChangedAt: Date | null;
  interest: string | null;
  primaryBranchId: string | null;
}

export interface CustomerMetrics {
  stageSince: Date;
  age: StageAge;
  heat: HeatResult;
  lastInteractionAt: Date | null;
  expectedValue: number | null;
  valueSource: "MANUAL" | "QUOTE" | "PLAN" | "INTEREST" | "SERVICE" | null;
  /** Dịch vụ liên quan (báo giá mở, phác đồ, dịch vụ quan tâm) cho lọc theo dịch vụ, gợi ý bán kèm. */
  serviceIds: string[];
  deposit: "PAID" | "UNPAID" | null;
  nextAppointmentAt: Date | null;
  openQuoteCount: number;
  openQuoteTotal: number;
  nextTask: { id: string; title: string; dueAt: Date | null; overdue: boolean } | null;
}

export function parseInterest(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

const CHUNK = 900;
async function chunked<T>(ids: string[], fn: (part: string[]) => Promise<T[]>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += CHUNK) out.push(...(await fn(ids.slice(i, i + CHUNK))));
  return out;
}

/** Báo giá đang mở: nháp, đã gửi, khách đồng ý; chưa thành hợp đồng; không bị từ chối duyệt; chưa hết hạn. */
export function openQuoteWhere(now: Date) {
  return {
    status: { in: [QuotationStatus.DRAFT, QuotationStatus.SENT, QuotationStatus.ACCEPTED] },
    contract: { is: null },
    approvalStatus: { not: ApprovalStatus.REJECTED },
    OR: [{ validUntil: null }, { validUntil: { gte: now } }],
  };
}

/** Giá niêm yết hiện hành theo dịch vụ, cho nhiều dịch vụ và cơ sở một lần. */
async function listPriceIndex(serviceIds: string[], now: Date): Promise<(serviceId: string, branchId: string | null) => number | null> {
  if (!serviceIds.length) return () => null;
  const rows = await prisma.servicePrice.findMany({
    where: { serviceId: { in: serviceIds }, validFrom: { lte: now }, OR: [{ validTo: null }, { validTo: { gt: now } }] },
    orderBy: { validFrom: "desc" },
    select: { serviceId: true, branchId: true, price: true },
  });
  const map = new Map<string, number>();
  for (const r of rows) {
    const k = `${r.serviceId}|${r.branchId}`;
    if (!map.has(k)) map.set(k, r.price);
  }
  const single = await getSettingBool("pricing.singlePriceList");
  const ref = single ? (await prisma.branch.findFirst({ orderBy: { createdAt: "asc" }, select: { id: true } }))?.id ?? null : null;
  return (serviceId, branchId) => {
    const b = ref ?? branchId;
    if (b && map.has(`${serviceId}|${b}`)) return map.get(`${serviceId}|${b}`)!;
    // Khách chưa gắn cơ sở: lấy giá ở bất kỳ cơ sở nào có giá (ước lượng giá trị dự kiến).
    for (const [k, v] of map) if (k.startsWith(`${serviceId}|`)) return v;
    return null;
  };
}

/**
 * P1: tính chỉ số của nhiều khách bằng một nhóm truy vấn cố định (không N+1).
 * Giá trị dự kiến ưu tiên: nhập tay trên cơ hội, rồi báo giá mở mới nhất CỦA
 * ĐƠN VỊ, rồi phác đồ chưa có báo giá CỦA ĐƠN VỊ, rồi giá niêm yết dịch vụ của
 * cơ hội, cuối cùng (chỉ khi cơ hội không có dịch vụ) tổng giá niêm yết các dịch
 * vụ quan tâm (khớp tên dịch vụ).
 *
 * Sửa lỗi sau chụp demo Lô 8: báo giá, phác đồ chưa gắn cơ hội (dữ liệu cũ) thuộc
 * cơ hội mở gần nhất TẠI thời điểm lập (cơ hội mới nhất có createdAt <= ngày lập;
 * lập trước mọi cơ hội thì thuộc cơ hội sớm nhất). Cơ hội mở tay sau đó không
 * "kế thừa" báo giá, phác đồ cũ, và dịch vụ của cơ hội đứng trước dịch vụ quan tâm.
 */
export async function computeMetrics(
  customers: MetricCustomer[],
  opts: { mode: ClinicMode; params: PipelineParams; now: Date }
): Promise<Map<string, CustomerMetrics>> {
  const { mode, params, now } = opts;
  const out = new Map<string, CustomerMetrics>();
  if (!customers.length) return out;
  const custOf = (c: MetricCustomer) => c.customerId ?? c.id;
  const ids = [...new Set(customers.map(custOf))];
  const oppIds = [...new Set(customers.map((c) => c.opportunityId).filter((x): x is string => Boolean(x)))];
  const stages = stagesFor(mode);
  const lostKey = stages.find((s) => s.lost)?.key;
  const todayStart = startOfVnDay(now);

  const [history, oppHistory, convs, visits, photos, appts, quotes, plans, tasks] = await Promise.all([
    chunked(ids, (part) =>
      prisma.stageHistory.groupBy({ by: ["customerId", "toStage"], where: { customerId: { in: part } }, _max: { createdAt: true } })
    ),
    chunked(oppIds, (part) =>
      prisma.stageHistory.groupBy({ by: ["opportunityId", "toStage"], where: { opportunityId: { in: part } }, _max: { createdAt: true } })
    ),
    chunked(ids, (part) =>
      prisma.conversation.groupBy({ by: ["customerId"], where: { customerId: { in: part } }, _max: { lastInboundAt: true } })
    ),
    chunked(ids, (part) => prisma.visit.groupBy({ by: ["customerId"], where: { customerId: { in: part } }, _max: { checkedInAt: true } })),
    chunked(ids, (part) => prisma.photoSet.groupBy({ by: ["customerId"], where: { customerId: { in: part } }, _count: { _all: true } })),
    chunked(ids, (part) =>
      prisma.appointment.findMany({
        where: {
          customerId: { in: part },
          startAt: { gte: todayStart },
          status: { notIn: [AppointmentStatus.CANCELLED, AppointmentStatus.NO_SHOW, AppointmentStatus.DONE] },
        },
        orderBy: { startAt: "asc" },
        select: { customerId: true, startAt: true, depositStatus: true },
      })
    ),
    chunked(ids, (part) =>
      prisma.quotation.findMany({
        where: { customerId: { in: part }, ...openQuoteWhere(now) },
        orderBy: { createdAt: "desc" },
        select: { customerId: true, total: true, opportunityId: true, createdAt: true, items: { select: { serviceId: true } } },
      })
    ),
    chunked(ids, (part) =>
      prisma.treatmentPlan.findMany({
        where: { customerId: { in: part }, quotationId: null, status: { not: TreatmentPlanStatus.REJECTED } },
        orderBy: { createdAt: "desc" },
        select: { customerId: true, createdAt: true, items: { select: { serviceId: true, listPrice: true, quantity: true } } },
      })
    ),
    chunked(ids, (part) =>
      prisma.task.findMany({
        where: { customerId: { in: part }, status: { in: [TaskStatus.OPEN, TaskStatus.IN_PROGRESS] } },
        orderBy: [{ dueAt: "asc" }, { createdAt: "asc" }],
        select: { id: true, customerId: true, title: true, dueAt: true, opportunityId: true },
      })
    ),
  ]);

  const histOf = new Map(history.map((h) => [`${h.customerId}|${h.toStage}`, h._max.createdAt]));
  const oppHistOf = new Map(oppHistory.map((h) => [`${h.opportunityId}|${h.toStage}`, h._max.createdAt]));
  const inboundOf = new Map(convs.map((c) => [c.customerId!, c._max.lastInboundAt]));
  const visitOf = new Map(visits.map((v) => [v.customerId, v._max.checkedInAt]));
  const photoOf = new Set(photos.filter((p) => p._count._all > 0).map((p) => p.customerId));
  const apptOf = new Map<string, (typeof appts)[number]>();
  for (const a of appts) if (!apptOf.has(a.customerId)) apptOf.set(a.customerId, a);
  const quotesOf = new Map<string, typeof quotes>();
  for (const q of quotes) quotesOf.set(q.customerId, [...(quotesOf.get(q.customerId) ?? []), q]);
  const plansOf = new Map<string, typeof plans>();
  for (const p of plans) plansOf.set(p.customerId, [...(plansOf.get(p.customerId) ?? []), p]);
  // Mọi cơ hội của các khách (kể cả cơ hội không nằm trong danh sách đơn vị) để
  // xác định báo giá, phác đồ chưa gắn cơ hội thuộc cơ hội nào.
  const allOpps = oppIds.length
    ? await chunked(ids, (part) =>
        prisma.opportunity.findMany({
          where: { customerId: { in: part } },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          select: { id: true, customerId: true, createdAt: true },
        })
      )
    : [];
  const oppsOfCustomer = new Map<string, typeof allOpps>();
  for (const o of allOpps) oppsOfCustomer.set(o.customerId, [...(oppsOfCustomer.get(o.customerId) ?? []), o]);
  /** Cơ hội sở hữu một chứng từ chưa gắn cơ hội: cơ hội mới nhất mở trước (hoặc đúng lúc) lập chứng từ. */
  const ownerOpp = (customerId: string, at: Date): string | null => {
    const list = oppsOfCustomer.get(customerId) ?? [];
    if (!list.length) return null;
    let owner = list[0].id;
    for (const o of list) if (o.createdAt.getTime() <= at.getTime()) owner = o.id;
    return owner;
  };
  const tasksOf = new Map<string, typeof tasks>();
  for (const t of tasks) tasksOf.set(t.customerId!, [...(tasksOf.get(t.customerId!) ?? []), t]);
  // SQLite xếp NULL lên đầu khi tăng dần: ưu tiên việc có hạn, việc không hạn để sau.
  const firstTask = (list: typeof tasks) => list.find((t) => t.dueAt !== null) ?? list[0];

  // Dịch vụ quan tâm (chuỗi tên) -> dịch vụ trong bảng giá.
  const interestNames = new Set<string>();
  for (const c of customers) for (const n of parseInterest(c.interest)) interestNames.add(n.trim().toLowerCase());
  const services = interestNames.size
    ? await prisma.service.findMany({ where: { active: true }, select: { id: true, name: true } })
    : [];
  const serviceByName = new Map(services.filter((s) => interestNames.has(s.name.trim().toLowerCase())).map((s) => [s.name.trim().toLowerCase(), s.id]));
  const oppServices = customers.map((c) => c.oppServiceId).filter((x): x is string => Boolean(x));
  const priceOf = await listPriceIndex([...new Set([...serviceByName.values(), ...oppServices])], now);

  for (const c of customers) {
    const cid = custOf(c);
    const primary = c.primaryUnit ?? true;
    const lost = c.stage === lostKey;
    const since =
      (c.opportunityId ? oppHistOf.get(`${c.opportunityId}|${c.stage}`) : undefined) ??
      (c.opportunityId ? undefined : histOf.get(`${cid}|${c.stage}`)) ??
      c.stageChangedAt ??
      c.createdAt;
    const age = stageAge(since, now, maxDaysFor(params, c.stage, lost), params.warnPercent);
    const inbound = inboundOf.get(cid) ?? null;
    const visit = visitOf.get(cid) ?? null;
    const lastInteractionAt = inbound && visit ? (inbound > visit ? inbound : visit) : (inbound ?? visit);
    const appt = apptOf.get(cid) ?? null;
    const allQuotes = quotesOf.get(cid) ?? [];
    // Báo giá gắn đúng cơ hội, cộng báo giá chưa gắn cơ hội mà cơ hội này là chủ (theo ngày lập).
    const cq = c.opportunityId
      ? allQuotes.filter((q) => q.opportunityId === c.opportunityId || (!q.opportunityId && ownerOpp(cid, q.createdAt) === c.opportunityId))
      : allQuotes;
    const heat = heatOf(
      { lost, lastInteractionAt, hasPhoto: photoOf.has(cid), hasUpcomingAppointment: Boolean(appt), hasOpenQuote: cq.length > 0 },
      params.heat,
      now
    );

    let expectedValue: number | null = null;
    let valueSource: CustomerMetrics["valueSource"] = null;
    const serviceIds = new Set<string>();
    const custPlans = plansOf.get(cid) ?? [];
    const plan = c.opportunityId ? custPlans.find((p) => ownerOpp(cid, p.createdAt) === c.opportunityId) : custPlans[0];
    if (c.fixedValue != null) {
      expectedValue = c.fixedValue;
      valueSource = "MANUAL";
    }
    if (cq.length) {
      if (valueSource === null) {
        expectedValue = cq[0].total;
        valueSource = "QUOTE";
      }
      for (const i of cq[0].items) if (i.serviceId) serviceIds.add(i.serviceId);
    } else if (valueSource === null && plan && plan.items.some((i) => i.listPrice != null)) {
      expectedValue = plan.items.reduce((s, i) => s + (i.listPrice ?? 0) * i.quantity, 0);
      valueSource = "PLAN";
    }
    if (plan) for (const i of plan.items) if (i.serviceId) serviceIds.add(i.serviceId);
    if (c.oppServiceId) serviceIds.add(c.oppServiceId);
    let interestValue = 0;
    let interestPriced = false;
    // Dịch vụ quan tâm của khách chỉ tính cho đơn vị chính (không cộng trùng nhiều cơ hội).
    if (primary) {
      for (const n of parseInterest(c.interest)) {
        const sid = serviceByName.get(n.trim().toLowerCase());
        if (!sid) continue;
        serviceIds.add(sid);
        const p = priceOf(sid, c.primaryBranchId);
        if (p != null) {
          interestValue += p;
          interestPriced = true;
        }
      }
    }
    if (valueSource === null && c.oppServiceId) {
      const p = priceOf(c.oppServiceId, c.primaryBranchId);
      if (p != null) {
        expectedValue = p;
        valueSource = "SERVICE";
      }
    }
    // Dịch vụ quan tâm chỉ là nguồn giá trị khi cơ hội KHÔNG có dịch vụ riêng.
    if (valueSource === null && !c.oppServiceId && interestPriced) {
      expectedValue = interestValue;
      valueSource = "INTEREST";
    }

    const ct = tasksOf.get(cid) ?? [];
    const own = c.opportunityId ? ct.filter((t) => t.opportunityId === c.opportunityId || (primary && !t.opportunityId)) : ct;
    const t = own.length ? firstTask(own) : undefined;
    out.set(c.id, {
      stageSince: since,
      age,
      heat,
      lastInteractionAt,
      expectedValue,
      valueSource,
      serviceIds: [...serviceIds],
      deposit: appt ? (appt.depositStatus === "DA_COC" ? "PAID" : "UNPAID") : null,
      nextAppointmentAt: appt?.startAt ?? null,
      openQuoteCount: cq.length,
      openQuoteTotal: cq.reduce((s, q) => s + q.total, 0),
      nextTask: t ? { id: t.id, title: t.title, dueAt: t.dueAt, overdue: Boolean(t.dueAt && t.dueAt < now) } : null,
    });
  }
  return out;
}
