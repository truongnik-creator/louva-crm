import { prisma } from "./prisma";
import { HttpError } from "../middleware/errorHandler";
import { getSettingNumber } from "./settings-catalog";
import { activePromotions, currentListPrice, discountCapPercent, promotionAllowance, promotionAppliesTo } from "./pricing";
import { parseProposals, planItemLabel } from "./consultation";
import { suggestUpsells } from "./upsell";
import { QuoteTier, TreatmentPlanStatus, UpsellOfferStatus } from "../types/enums";

// Lô 7 · V1: BÁO GIÁ 3 PHƯƠNG ÁN (Cơ bản, Khuyên dùng, Trọn gói).
//
// Sinh từ phác đồ (hoặc phiếu tư vấn khi chưa có phác đồ):
//   - Cơ bản      = dịch vụ chính (dòng đầu của phác đồ / đề xuất đầu của phiếu).
//   - Khuyên dùng = toàn bộ phác đồ.
//   - Trọn gói    = toàn bộ phác đồ + dịch vụ gợi ý bán kèm theo luật (V2)
//                   + ưu đãi trọn gói (Cài đặt quote.packageDiscountPercent).
//                   Dịch vụ bán kèm khách đã TỪ CHỐI trong upsell.declineCooldownDays
//                   ngày gần nhất không tự cộng (trả về skippedDeclined để hiện ghi chú).
// Giá: giá niêm yết của cơ sở, tự áp đợt ưu đãi đang chạy có lợi nhất cho từng
// dòng; phần giảm thêm của Trọn gói không bao giờ vượt TRẦN GIẢM THEO VAI của
// người lập (pricing.ts): vượt thì chỉ giảm tới trần và báo capLimited. Chọn một
// phương án thì đi lại đúng evaluatePricing như báo giá thường.

export const TIER_LABEL: Record<QuoteTier, string> = {
  BASIC: "Cơ bản",
  RECOMMENDED: "Khuyên dùng",
  PACKAGE: "Trọn gói",
};

export const PACKAGE_REASON = "Ưu đãi phương án Trọn gói (báo giá 3 phương án)";

interface BaseLine {
  serviceId: string;
  name: string;
  quantity: number;
  upsellRuleId?: string | null;
}

export interface OptionLine extends BaseLine {
  unitPrice: number;
  listPrice: number;
  promotionId: string | null;
  promotionName: string | null;
  promotionDiscount: number;
  extraDiscount: number;
  discount: number;
  amount: number;
}

export interface QuoteOption {
  tier: QuoteTier;
  label: string;
  lines: OptionLine[];
  subtotal: number;
  discount: number;
  total: number;
}

export interface QuoteOptionsResult {
  source: { kind: "PLAN" | "SESSION"; id: string; title: string };
  branchId: string;
  capPercent: number;
  packageDiscountPercent: number;
  appliedPackagePercent: number;
  capLimited: boolean;
  options: QuoteOption[];
  /** Dịch vụ bán kèm KHÔNG tự cộng vào Trọn gói vì khách đã từ chối gần đây (upsell.declineCooldownDays). */
  skippedDeclined: Array<{ serviceId: string; name: string; declinedAt: Date; declineReason: string | null }>;
}

/** Tìm nguồn: phác đồ chỉ định, phiếu chỉ định, hoặc phác đồ / phiếu gần nhất của khách. */
async function loadSource(customerId: string, src: { planId?: string | null; sessionId?: string | null }) {
  if (src.planId) {
    const plan = await prisma.treatmentPlan.findUnique({ where: { id: src.planId }, include: { items: { orderBy: { stepOrder: "asc" } } } });
    if (!plan || plan.customerId !== customerId) throw new HttpError(404, "Không tìm thấy phác đồ của khách");
    return { kind: "PLAN" as const, id: plan.id, title: plan.title, branchId: plan.branchId, lines: planLines(plan.items) };
  }
  if (src.sessionId) {
    const s = await prisma.consultationSession.findUnique({ where: { id: src.sessionId } });
    if (!s || s.customerId !== customerId) throw new HttpError(404, "Không tìm thấy phiếu tư vấn của khách");
    return { kind: "SESSION" as const, id: s.id, title: "Phiếu tư vấn", branchId: s.branchId, lines: sessionLines(s.proposals) };
  }
  const plan = await prisma.treatmentPlan.findFirst({
    where: { customerId, status: { not: TreatmentPlanStatus.REJECTED }, items: { some: { serviceId: { not: null } } } },
    orderBy: { createdAt: "desc" },
    include: { items: { orderBy: { stepOrder: "asc" } } },
  });
  if (plan) return { kind: "PLAN" as const, id: plan.id, title: plan.title, branchId: plan.branchId, lines: planLines(plan.items) };
  const s = await prisma.consultationSession.findFirst({ where: { customerId, proposals: { not: null } }, orderBy: { heldAt: "desc" } });
  if (s && parseProposals(s.proposals).length) {
    return { kind: "SESSION" as const, id: s.id, title: "Phiếu tư vấn", branchId: s.branchId, lines: sessionLines(s.proposals) };
  }
  throw new HttpError(400, "Khách chưa có phác đồ hoặc phiếu tư vấn có dịch vụ để lập báo giá 3 phương án");
}

function planLines(items: Array<{ serviceId: string | null; name: string; quantity: number; faceArea: string | null; doseTenths: number | null; productName: string | null }>): BaseLine[] {
  return items.filter((i) => i.serviceId).map((i) => ({ serviceId: i.serviceId!, name: planItemLabel(i), quantity: i.quantity }));
}

function sessionLines(raw: string | null): BaseLine[] {
  return parseProposals(raw).map((p) => ({
    serviceId: p.serviceId,
    name: planItemLabel({ name: p.serviceName, faceArea: p.faceArea, doseTenths: p.doseTenths, productName: p.productName }),
    quantity: p.quantity || 1,
  }));
}

/** Thành tiền một phương án: giá niêm yết, ưu đãi đang chạy tốt nhất, giảm thêm (đã kẹp trần). */
export async function priceOption(
  tier: QuoteTier,
  base: BaseLine[],
  opts: { branchId: string; extraPercent: number; now: Date }
): Promise<QuoteOption> {
  const promos = await activePromotions(opts.branchId, opts.now);
  const lines: OptionLine[] = [];
  for (const b of base) {
    const price = await currentListPrice(b.serviceId, opts.branchId, opts.now);
    if (!price) throw new HttpError(400, `"${b.name}" chưa có giá niêm yết tại cơ sở này`);
    const listTotal = price.price * b.quantity;
    let best: { id: string; name: string; amount: number } | null = null;
    for (const p of promos) {
      if (!promotionAppliesTo(p, b.serviceId, opts.branchId)) continue;
      const amount = promotionAllowance(p, listTotal, b.quantity);
      if (!best || amount > best.amount) best = { id: p.id, name: p.name, amount };
    }
    const promotionDiscount = best?.amount ?? 0;
    // Phần giảm thêm tính trên giá niêm yết (đúng cách tính trần ở evaluatePricing), không vượt phần còn lại.
    const extraDiscount = Math.min(listTotal - promotionDiscount, Math.floor((listTotal * opts.extraPercent) / 100));
    const discount = promotionDiscount + extraDiscount;
    lines.push({
      ...b,
      unitPrice: price.price,
      listPrice: price.price,
      promotionId: best && best.amount > 0 ? best.id : null,
      promotionName: best && best.amount > 0 ? best.name : null,
      promotionDiscount,
      extraDiscount,
      discount,
      amount: listTotal - discount,
    });
  }
  const subtotal = lines.reduce((s, l) => s + l.unitPrice * l.quantity, 0);
  const discount = lines.reduce((s, l) => s + l.discount, 0);
  return { tier, label: TIER_LABEL[tier], lines, subtotal, discount, total: subtotal - discount };
}

export async function buildQuoteOptions(input: {
  customerId: string;
  planId?: string | null;
  sessionId?: string | null;
  branchId?: string | null;
  roles: string[];
  now?: Date;
}): Promise<QuoteOptionsResult> {
  const now = input.now ?? new Date();
  const src = await loadSource(input.customerId, input);
  if (!src.lines.length) throw new HttpError(400, "Phác đồ / phiếu tư vấn không có dịch vụ để báo giá");
  const branchId = input.branchId ?? src.branchId;
  const capPercent = await discountCapPercent(input.roles);
  const packageDiscountPercent = await getSettingNumber("quote.packageDiscountPercent");
  const appliedPackagePercent = Math.max(0, Math.min(packageDiscountPercent, capPercent));

  const triggerIds = [...new Set(src.lines.map((l) => l.serviceId))];
  const upsells = await suggestUpsells(input.customerId, { branchId, triggerServiceIds: triggerIds, now });
  const cooldownDays = await getSettingNumber("upsell.declineCooldownDays");
  const declinedRecently = (u: (typeof upsells)[number]) =>
    cooldownDays > 0 && u.lastOffer?.status === UpsellOfferStatus.DECLINED && now.getTime() - u.lastOffer.at.getTime() <= cooldownDays * 86_400_000;
  const skippedDeclined = upsells
    .filter(declinedRecently)
    .map((u) => ({ serviceId: u.suggestServiceId, name: u.suggestServiceName, declinedAt: u.lastOffer!.at, declineReason: u.lastOffer!.declineReason }));
  const packageLines: BaseLine[] = [
    ...src.lines,
    ...upsells.filter((u) => u.listPrice != null && !declinedRecently(u)).map((u) => ({ serviceId: u.suggestServiceId, name: u.suggestServiceName, quantity: 1, upsellRuleId: u.ruleId })),
  ];

  const options = [
    await priceOption(QuoteTier.BASIC, src.lines.slice(0, 1), { branchId, extraPercent: 0, now }),
    await priceOption(QuoteTier.RECOMMENDED, src.lines, { branchId, extraPercent: 0, now }),
    await priceOption(QuoteTier.PACKAGE, packageLines, { branchId, extraPercent: appliedPackagePercent, now }),
  ];
  return {
    source: { kind: src.kind, id: src.id, title: src.title },
    branchId,
    capPercent,
    packageDiscountPercent,
    appliedPackagePercent,
    capLimited: packageDiscountPercent > capPercent,
    options,
    skippedDeclined,
  };
}
