import { prisma } from "./prisma";
import { getSettingNumber } from "./settings-catalog";
import { currentListPrice } from "./pricing";
import { parseProposals } from "./consultation";
import { openQuoteWhere, parseInterest } from "./crm360";
import { ContractStatus, ProcedureStatus, TreatmentPlanStatus } from "../types/enums";

// Lô 7 · V2: GỢI Ý BÁN KÈM THEO LUẬT.
//
// Luật do quản lý cơ sở, giám đốc khai (dịch vụ A -> gợi ý B, lời gợi ý, điều
// kiện bằng lời). Dịch vụ "A" của khách lấy từ báo giá đang mở, phác đồ, phiếu
// tư vấn gần nhất và dịch vụ quan tâm. Không gợi ý dịch vụ khách đã có trong
// phương án, và (mặc định) dịch vụ khách đã từng làm. Mỗi lần gợi ý, nhận, từ
// chối ghi UpsellOffer để đo tỉ lệ (V4 đọc bảng này ở Lô B).

export interface UpsellSuggestion {
  ruleId: string;
  triggerServiceId: string;
  triggerServiceName: string;
  suggestServiceId: string;
  suggestServiceName: string;
  pitch: string;
  conditionNote: string | null;
  isSample: boolean;
  priority: number;
  listPrice: number | null;
  lastOffer: { id: string; status: string; at: Date; declineReason: string | null } | null;
}

/** Dịch vụ "đang bàn" của khách: báo giá mở, phác đồ chưa từ chối, phiếu tư vấn gần nhất, dịch vụ quan tâm. */
export async function customerTriggerServices(customerId: string, now = new Date()): Promise<string[]> {
  const [quote, plan, session, customer] = await Promise.all([
    prisma.quotation.findFirst({
      where: { customerId, ...openQuoteWhere(now) },
      orderBy: { createdAt: "desc" },
      select: { items: { select: { serviceId: true } } },
    }),
    prisma.treatmentPlan.findFirst({
      where: { customerId, status: { not: TreatmentPlanStatus.REJECTED } },
      orderBy: { createdAt: "desc" },
      select: { items: { select: { serviceId: true } } },
    }),
    prisma.consultationSession.findFirst({ where: { customerId }, orderBy: { heldAt: "desc" }, select: { proposals: true } }),
    prisma.customer.findUnique({ where: { id: customerId }, select: { interest: true } }),
  ]);
  const ids = new Set<string>();
  for (const i of quote?.items ?? []) if (i.serviceId) ids.add(i.serviceId);
  for (const i of plan?.items ?? []) if (i.serviceId) ids.add(i.serviceId);
  for (const p of parseProposals(session?.proposals)) if (p.serviceId) ids.add(p.serviceId);
  const names = parseInterest(customer?.interest ?? null).map((n) => n.trim().toLowerCase());
  if (names.length) {
    const svcs = await prisma.service.findMany({ where: { active: true }, select: { id: true, name: true } });
    for (const s of svcs) if (names.includes(s.name.trim().toLowerCase())) ids.add(s.id);
  }
  return [...ids];
}

/** Dịch vụ khách đã làm: lần thực hiện hoàn tất hoặc dòng hợp đồng chưa huỷ. */
export async function servicesDone(customerId: string): Promise<Set<string>> {
  const [procs, items] = await Promise.all([
    prisma.procedureRecord.findMany({
      where: { customerId, status: ProcedureStatus.COMPLETED, serviceId: { not: null } },
      select: { serviceId: true },
    }),
    prisma.contractItem.findMany({
      where: { serviceId: { not: null }, contract: { customerId, status: { not: ContractStatus.CANCELLED }, signedAt: { not: null } } },
      select: { serviceId: true },
    }),
  ]);
  return new Set([...procs, ...items].map((r) => r.serviceId!).filter(Boolean));
}

/**
 * Gợi ý bán kèm cho một khách. `triggerServiceIds` truyền vào khi đang lập một
 * phương án cụ thể (báo giá 3 phương án); bỏ trống thì đọc từ hồ sơ khách.
 */
export async function suggestUpsells(
  customerId: string,
  opts: { branchId: string | null; triggerServiceIds?: string[]; limit?: number; now?: Date }
): Promise<UpsellSuggestion[]> {
  const now = opts.now ?? new Date();
  const triggers = opts.triggerServiceIds ?? (await customerTriggerServices(customerId, now));
  if (!triggers.length) return [];
  const limit = opts.limit ?? (await getSettingNumber("upsell.maxSuggestions"));
  const rules = await prisma.upsellRule.findMany({
    where: {
      active: true,
      triggerServiceId: { in: triggers },
      OR: [{ branchId: null }, ...(opts.branchId ? [{ branchId: opts.branchId }] : [])],
      suggestService: { active: true },
    },
    orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
    include: { triggerService: { select: { name: true } }, suggestService: { select: { name: true } } },
  });
  const done = rules.some((r) => r.onlyIfNotDone) ? await servicesDone(customerId) : new Set<string>();
  const picked: typeof rules = [];
  const seen = new Set<string>();
  for (const r of rules) {
    if (triggers.includes(r.suggestServiceId)) continue; // đã nằm trong phương án
    if (r.onlyIfNotDone && done.has(r.suggestServiceId)) continue;
    if (seen.has(r.suggestServiceId)) continue;
    seen.add(r.suggestServiceId);
    picked.push(r);
    if (picked.length >= limit) break;
  }
  if (!picked.length) return [];
  const offers = await prisma.upsellOffer.findMany({
    where: { customerId, suggestServiceId: { in: picked.map((r) => r.suggestServiceId) } },
    orderBy: { suggestedAt: "desc" },
    select: { id: true, suggestServiceId: true, status: true, suggestedAt: true, decidedAt: true, declineReason: true },
  });
  const out: UpsellSuggestion[] = [];
  for (const r of picked) {
    const last = offers.find((o) => o.suggestServiceId === r.suggestServiceId);
    const price = opts.branchId ? await currentListPrice(r.suggestServiceId, opts.branchId, now) : null;
    out.push({
      ruleId: r.id,
      triggerServiceId: r.triggerServiceId,
      triggerServiceName: r.triggerService.name,
      suggestServiceId: r.suggestServiceId,
      suggestServiceName: r.suggestService.name,
      pitch: r.pitch,
      conditionNote: r.conditionNote,
      isSample: r.isSample,
      priority: r.priority,
      listPrice: price?.price ?? null,
      lastOffer: last ? { id: last.id, status: last.status, at: last.decidedAt ?? last.suggestedAt, declineReason: last.declineReason } : null,
    });
  }
  return out;
}

/** Tỉ lệ nhận gợi ý theo luật trong kỳ (chỉ đo, không nối lương: Quyết định 2). */
export async function upsellStats(range: { gte: Date; lt: Date }, branchIds: string[] | null) {
  const rows = await prisma.upsellOffer.groupBy({
    by: ["ruleId", "suggestServiceId", "status"],
    where: { suggestedAt: range, ...(branchIds ? { OR: [{ branchId: { in: branchIds } }, { branchId: null }] } : {}) },
    _count: { _all: true },
  });
  const map = new Map<string, { ruleId: string | null; suggestServiceId: string; suggested: number; accepted: number; declined: number }>();
  for (const r of rows) {
    const k = `${r.ruleId ?? "_"}|${r.suggestServiceId}`;
    const g = map.get(k) ?? { ruleId: r.ruleId, suggestServiceId: r.suggestServiceId, suggested: 0, accepted: 0, declined: 0 };
    g.suggested += r._count._all;
    if (r.status === "ACCEPTED") g.accepted += r._count._all;
    if (r.status === "DECLINED") g.declined += r._count._all;
    map.set(k, g);
  }
  const svc = await prisma.service.findMany({
    where: { id: { in: [...new Set([...map.values()].map((g) => g.suggestServiceId))] } },
    select: { id: true, name: true },
  });
  const name = new Map(svc.map((s) => [s.id, s.name]));
  const items = [...map.values()].map((g) => ({
    ...g,
    suggestServiceName: name.get(g.suggestServiceId) ?? "",
    acceptRate: g.suggested ? g.accepted / g.suggested : null,
  }));
  const total = items.reduce(
    (s, g) => ({ suggested: s.suggested + g.suggested, accepted: s.accepted + g.accepted, declined: s.declined + g.declined }),
    { suggested: 0, accepted: 0, declined: 0 }
  );
  return { total: { ...total, acceptRate: total.suggested ? total.accepted / total.suggested : null }, items };
}
