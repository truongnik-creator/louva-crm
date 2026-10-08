import { prisma } from "./prisma";
import { HttpError } from "../middleware/errorHandler";
import { getSettingBool, getSettingNumber } from "./settings-catalog";
import { formatVnd } from "./datetime";
import { ApprovalStatus, PromotionKind } from "../types/enums";

// F13 + F21: GIÁ NIÊM YẾT, ĐỢT ƯU ĐÃI, TRẦN GIẢM THEO VAI.
//
// Luật giảm giá (thay luật "giá sàn = giá niêm yết" của Lô 3, khiến không giảm
// được gì):
//   1. Giá niêm yết lấy từ bảng giá của cơ sở (hoặc bảng giá chung nếu bật
//      pricing.singlePriceList).
//   2. Giảm so với niêm yết chỉ hợp lệ khi:
//      - nằm trong một ĐỢT ƯU ĐÃI đang chạy (đúng dịch vụ, đúng cơ sở, còn suất), hoặc
//      - phần vượt ưu đãi nằm trong TRẦN của vai người lập (Cài đặt, mặc định 0%
//        với sale), có ghi lý do; vượt trần thì báo giá CHỜ QUẢN LÝ DUYỆT.
//   3. Giá sàn cứng (ServicePrice.minPrice) chỉ còn là mốc tuyệt đối khi nhỏ
//      hơn giá niêm yết: không ai (kể cả được duyệt) bán thấp hơn. minPrice bằng
//      giá niêm yết (dữ liệu seed cũ) không còn nghĩa là cấm giảm.

const DAY_MS = 86_400_000;

export interface ListPrice {
  price: number;
  minPrice: number | null;
}

async function referenceBranchId(): Promise<string | null> {
  const b = await prisma.branch.findFirst({ orderBy: { createdAt: "asc" }, select: { id: true } });
  return b?.id ?? null;
}

/** Cơ sở có bảng giá được dùng cho `branchId` (bảng giá chung thì là cơ sở gốc). */
export async function priceBranchFor(branchId: string | null | undefined): Promise<string | null> {
  if (await getSettingBool("pricing.singlePriceList")) return (await referenceBranchId()) ?? branchId ?? null;
  return branchId ?? null;
}

/** Giá niêm yết hiện hành của một dịch vụ tại một cơ sở. */
export async function currentListPrice(
  serviceId: string,
  branchId: string | null | undefined,
  at: Date = new Date()
): Promise<ListPrice | null> {
  const pb = await priceBranchFor(branchId);
  if (!pb) return null;
  const row = await prisma.servicePrice.findFirst({
    where: { serviceId, branchId: pb, validFrom: { lte: at }, OR: [{ validTo: null }, { validTo: { gt: at } }] },
    orderBy: { validFrom: "desc" },
    select: { price: true, minPrice: true },
  });
  return row ? { price: row.price, minPrice: row.minPrice } : null;
}

// ---------------------------------------------------------------- ĐỢT ƯU ĐÃI

export interface PromotionRow {
  id: string;
  code: string;
  name: string;
  kind: string;
  value: number;
  maxSlots: number | null;
  usedSlots: number;
  startAt: Date;
  endAt: Date;
  branchId: string | null;
  active: boolean;
  lockedAt: Date | null;
  services: Array<{ serviceId: string }>;
}

export type PromotionState = "ACTIVE" | "UPCOMING" | "ENDED" | "FULL" | "PAUSED";

export function promotionState(p: PromotionRow, at: Date = new Date()): PromotionState {
  if (!p.active) return "PAUSED";
  if (p.lockedAt || (p.maxSlots != null && p.usedSlots >= p.maxSlots)) return "FULL";
  if (at < p.startAt) return "UPCOMING";
  if (at >= p.endAt) return "ENDED";
  return "ACTIVE";
}

export function promotionAppliesTo(p: PromotionRow, serviceId: string | null | undefined, branchId: string): boolean {
  if (p.branchId && p.branchId !== branchId) return false;
  if (!p.services.length) return true;
  return Boolean(serviceId && p.services.some((s) => s.serviceId === serviceId));
}

/** Số tiền giảm tối đa đợt ưu đãi cho một dòng. */
export function promotionAllowance(p: { kind: string; value: number }, listTotal: number, quantity: number): number {
  if (p.kind === PromotionKind.AMOUNT) return Math.min(listTotal, p.value * quantity);
  return Math.min(listTotal, Math.round((listTotal * p.value) / 100));
}

/** Các đợt ưu đãi đang chạy (AI2 dùng để biết giảm nào được phép nói với khách). */
export async function activePromotions(branchId: string | null, at: Date = new Date()): Promise<PromotionRow[]> {
  const rows = await prisma.promotion.findMany({
    where: { active: true, lockedAt: null, startAt: { lte: at }, endAt: { gt: at } },
    include: { services: { select: { serviceId: true } } },
    orderBy: { endAt: "asc" },
  });
  return rows.filter((p) => promotionState(p, at) === "ACTIVE" && (!branchId || !p.branchId || p.branchId === branchId));
}

/**
 * Trừ một suất của đợt ưu đãi (khi chốt hợp đồng). Nguyên tử: câu UPDATE có
 * điều kiện "còn suất" nên hai hợp đồng cùng lúc không vượt số suất. Hết suất
 * thì tự khoá đợt.
 */
export async function consumePromotionSlot(promotionId: string): Promise<boolean> {
  const n = await prisma.$executeRaw`UPDATE "promotions" SET "usedSlots" = "usedSlots" + 1 WHERE "id" = ${promotionId} AND "lockedAt" IS NULL AND ("maxSlots" IS NULL OR "usedSlots" < "maxSlots")`;
  if (n !== 1) return false;
  const p = await prisma.promotion.findUniqueOrThrow({ where: { id: promotionId } });
  if (p.maxSlots != null && p.usedSlots >= p.maxSlots && !p.lockedAt) {
    await prisma.promotion.update({ where: { id: p.id }, data: { lockedAt: new Date() } });
  }
  return true;
}

/** Trả lại suất khi hợp đồng bị huỷ; đợt khoá vì hết suất thì mở lại. */
export async function releasePromotionSlot(promotionId: string): Promise<void> {
  const p = await prisma.promotion.findUnique({ where: { id: promotionId } });
  if (!p || p.usedSlots <= 0) return;
  const usedSlots = p.usedSlots - 1;
  await prisma.promotion.update({
    where: { id: p.id },
    data: { usedSlots, ...(p.lockedAt && p.maxSlots != null && usedSlots < p.maxSlots ? { lockedAt: null } : {}) },
  });
}

// ------------------------------------------------------------- TRẦN GIẢM

const CAP_ROLES = ["TELESALE", "TU_VAN_VIEN", "LE_TAN", "QUAN_LY_CO_SO", "GIAM_DOC"];

/** Trần giảm ngoài ưu đãi (%) của một người = trần cao nhất trong các vai của họ. */
export async function discountCapPercent(roles: string[]): Promise<number> {
  let cap = 0;
  for (const r of roles) {
    if (!CAP_ROLES.includes(r)) continue;
    cap = Math.max(cap, await getSettingNumber(`discount.capPercent.${r}`));
  }
  return cap;
}

// ------------------------------------------------------------ ĐÁNH GIÁ DÒNG

export interface LineInput {
  serviceId?: string | null;
  name: string;
  quantity: number;
  unitPrice: number;
  discount: number;
  promotionId?: string | null;
  discountReason?: string | null;
}

export interface PricedLine {
  serviceId: string | null;
  name: string;
  quantity: number;
  unitPrice: number;
  discount: number;
  amount: number;
  listPrice: number | null;
  discountAmount: number;
  promotionDiscount: number;
  discountReason: string | null;
  promotionId: string | null;
  approvedById: string | null;
  /** Phần giảm ngoài ưu đãi, % của giá niêm yết cả dòng. */
  excessPercent: number;
  /** Bán cao hơn niêm yết (quy tắc 3 cũng báo). */
  aboveList: boolean;
}

export interface PricingResult {
  lines: PricedLine[];
  /** Có dòng giảm vượt trần của người lập. */
  needsApproval: boolean;
  maxExcessPercent: number;
  subtotal: number;
  discount: number;
  total: number;
}

/**
 * Đánh giá giá và giảm giá của các dòng báo giá / hợp đồng. Ném 400 khi vi
 * phạm luật cứng (dưới giá sàn tuyệt đối, đợt ưu đãi không hợp lệ, giảm ngoài
 * ưu đãi mà không ghi lý do). Không ném khi vượt trần: trả needsApproval.
 */
export async function evaluatePricing(
  items: LineInput[],
  opts: { branchId: string; capPercent: number; at?: Date }
): Promise<PricingResult> {
  const at = opts.at ?? new Date();
  const promoCache = new Map<string, PromotionRow | null>();
  const lines: PricedLine[] = [];
  let maxExcess = 0;

  for (const item of items) {
    const quantity = item.quantity;
    const gross = quantity * item.unitPrice;
    const amount = gross - item.discount;
    if (amount < 0) throw new HttpError(400, `"${item.name}": tiền giảm lớn hơn thành tiền`);

    const price = item.serviceId ? await currentListPrice(item.serviceId, opts.branchId, at) : null;
    const listPrice = price?.price ?? null;
    // Dòng không có giá niêm yết (nhập tay, dịch vụ chưa có giá): lấy đơn giá làm mốc.
    const listTotal = (listPrice ?? item.unitPrice) * quantity;
    const discountAmount = Math.max(0, listTotal - amount);

    // Giá sàn tuyệt đối: chỉ khi thấp hơn giá niêm yết.
    if (price?.minPrice != null && listPrice != null && price.minPrice < listPrice) {
      const netUnit = Math.round(amount / quantity);
      if (netUnit < price.minPrice) {
        throw new HttpError(
          400,
          `"${item.name}" đang báo ${formatVnd(netUnit)}đ, thấp hơn giá sàn ${formatVnd(price.minPrice)}đ (không duyệt được)`
        );
      }
    }

    let promotionDiscount = 0;
    if (item.promotionId) {
      if (!promoCache.has(item.promotionId)) {
        promoCache.set(
          item.promotionId,
          await prisma.promotion.findUnique({
            where: { id: item.promotionId },
            include: { services: { select: { serviceId: true } } },
          })
        );
      }
      const promo = promoCache.get(item.promotionId);
      if (!promo) throw new HttpError(400, `"${item.name}": không tìm thấy đợt ưu đãi`);
      const state = promotionState(promo, at);
      if (state !== "ACTIVE") {
        const why: Record<string, string> = {
          FULL: "đã hết suất",
          UPCOMING: "chưa bắt đầu",
          ENDED: "đã kết thúc",
          PAUSED: "đang tạm dừng",
        };
        throw new HttpError(400, `Đợt ưu đãi "${promo.name}" ${why[state]}`);
      }
      if (!promotionAppliesTo(promo, item.serviceId, opts.branchId)) {
        throw new HttpError(400, `Đợt ưu đãi "${promo.name}" không áp dụng cho "${item.name}" tại cơ sở này`);
      }
      promotionDiscount = Math.min(discountAmount, promotionAllowance(promo, listTotal, quantity));
    }

    const excess = discountAmount - promotionDiscount;
    const excessPercent = listTotal > 0 ? (excess / listTotal) * 100 : 0;
    const reason = item.discountReason?.trim() || null;
    if (excess > 0 && !reason) {
      throw new HttpError(
        400,
        `"${item.name}" giảm ${formatVnd(excess)}đ ngoài đợt ưu đãi: bắt buộc ghi lý do giảm`
      );
    }
    maxExcess = Math.max(maxExcess, excessPercent);

    lines.push({
      serviceId: item.serviceId ?? null,
      name: item.name,
      quantity,
      unitPrice: item.unitPrice,
      discount: item.discount,
      amount,
      listPrice,
      discountAmount,
      promotionDiscount,
      discountReason: reason,
      promotionId: item.promotionId ?? null,
      approvedById: null,
      excessPercent: Math.round(excessPercent * 100) / 100,
      aboveList: listPrice != null && amount > listTotal,
    });
  }

  const subtotal = lines.reduce((s, l) => s + l.quantity * l.unitPrice, 0);
  const discount = lines.reduce((s, l) => s + l.discount, 0);
  // So sánh có dung sai làm tròn (0,01%) để trần 10% không bị chặn vì 10,0001%.
  const needsApproval = maxExcess > opts.capPercent + 0.01;
  return { lines, needsApproval, maxExcessPercent: Math.round(maxExcess * 100) / 100, subtotal, discount, total: subtotal - discount };
}

/** Dạng ghi vào QuotationItem / ContractItem. */
export function lineData(l: PricedLine) {
  return {
    serviceId: l.serviceId,
    name: l.name,
    quantity: l.quantity,
    unitPrice: l.unitPrice,
    discount: l.discount,
    amount: l.amount,
    listPrice: l.listPrice,
    discountAmount: l.discountAmount,
    promotionDiscount: l.promotionDiscount,
    discountReason: l.discountReason,
    promotionId: l.promotionId,
    approvedById: l.approvedById,
  };
}

export function initialApprovalStatus(needsApproval: boolean): ApprovalStatus {
  return needsApproval ? ApprovalStatus.PENDING : ApprovalStatus.NOT_REQUIRED;
}

export { DAY_MS };
