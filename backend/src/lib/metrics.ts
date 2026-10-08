import { prisma } from "./prisma";
import { getSettingRaw } from "./settings-catalog";
import { startOfVnDay, startOfVnMonth, vnDayKey } from "./datetime";
import { REAL_MONEY } from "./report-scope";

// NỀN SỐ LIỆU CHUNG CỦA ĐỢT 3 (F15 đến F34).
//
// Gom ở một chỗ các định nghĩa mà nhiều báo cáo cùng dùng, để "khách đến",
// "doanh thu đã thu", "khách từ quảng cáo" ở bảng lương, bảng thi đua, chỉ số
// tuần và dự báo là MỘT con số:
//   - Khách đến: lượt check-in (Visit), mỗi khách mỗi ngày (giờ VN) tính một lần,
//     quy cho sale phụ trách khách (assignedToId, trống thì telesaleId).
//   - Doanh thu đã thu: phiếu thu trong kỳ, KHÔNG gồm phiếu trừ voucher; phiếu
//     hoàn tiền (số âm) có trừ.
//   - Khách từ quảng cáo: khách có chiến dịch, hoặc lead gốc có chiến dịch hay
//     mã quảng cáo (Pancake).

export const DAY_MS = 86_400_000;

export interface Range {
  gte: Date;
  lt: Date;
}

/** "2026-10" theo giờ Việt Nam. */
export function vnPeriodKey(d: Date = new Date()): string {
  return vnDayKey(d).slice(0, 7);
}

export function isPeriodKey(v: string): boolean {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(v);
}

/** Khoảng [đầu tháng, đầu tháng sau) giờ Việt Nam của "YYYY-MM". */
export function vnMonthRange(periodKey: string): Range {
  const [y, m] = periodKey.split("-").map(Number);
  const gte = startOfVnMonth(new Date(Date.UTC(y, m - 1, 15, 12)));
  const lt = startOfVnMonth(new Date(Date.UTC(y, m, 15, 12)));
  return { gte, lt };
}

export function previousPeriodKey(periodKey: string): string {
  const [y, m] = periodKey.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 2, 15));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Thứ Hai 00:00 giờ VN của tuần chứa d. */
export function startOfVnWeek(d: Date): Date {
  const day = startOfVnDay(d);
  const [y, m, dd] = vnDayKey(d).split("-").map(Number);
  const weekday = new Date(Date.UTC(y, m - 1, dd)).getUTCDay(); // 0 = CN
  const back = (weekday + 6) % 7;
  return new Date(day.getTime() - back * DAY_MS);
}

/** Khoá tuần ISO "2026-W40" (theo ngày giờ VN). */
export function vnWeekKey(d: Date): string {
  const [y, m, dd] = vnDayKey(d).split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, dd));
  const dayNum = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - dayNum + 3); // thứ Năm cùng tuần
  const isoYear = date.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  const week = 1 + Math.round(((date.getTime() - firstThursday.getTime()) / DAY_MS - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return `${isoYear}-W${String(week).padStart(2, "0")}`;
}

/** Sale phụ trách một khách. */
export function responsibleSaleOf(c: { assignedToId: string | null; telesaleId: string | null }): string | null {
  return c.assignedToId ?? c.telesaleId ?? null;
}

/** Danh sách mã (vai trò, kênh) trong Cài đặt dạng "A,B,C". */
export async function settingList(key: string): Promise<string[]> {
  return (await getSettingRaw(key))
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

/** Khách đến theo sale: Map<saleId, số lượt>. Mỗi khách mỗi ngày một lượt. */
export async function showupsBySale(range: Range, branchIds: string[]): Promise<Map<string, number>> {
  const visits = await prisma.visit.findMany({
    where: { branchId: { in: branchIds }, checkedInAt: range },
    select: { customerId: true, checkedInAt: true, customer: { select: { assignedToId: true, telesaleId: true } } },
  });
  const seen = new Set<string>();
  const out = new Map<string, number>();
  for (const v of visits) {
    const key = `${v.customerId}|${vnDayKey(v.checkedInAt)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const sale = responsibleSaleOf(v.customer);
    if (!sale) continue;
    out.set(sale, (out.get(sale) ?? 0) + 1);
  }
  return out;
}

/** Tổng lượt khách đến (mỗi khách mỗi ngày một lần) của các cơ sở. */
export async function totalShowups(range: Range, branchIds: string[]): Promise<number> {
  const visits = await prisma.visit.findMany({
    where: { branchId: { in: branchIds }, checkedInAt: range },
    select: { customerId: true, checkedInAt: true },
  });
  return new Set(visits.map((v) => `${v.customerId}|${vnDayKey(v.checkedInAt)}`)).size;
}

/**
 * Chia một số tiền cho các dòng theo tỉ lệ `weight`, tổng đúng bằng số tiền
 * (phần dư làm tròn dồn vào dòng lớn nhất). Dòng trọng số 0 nhận 0.
 */
export function allocate<T extends { weight: number }>(amount: number, parts: T[]): Array<T & { share: number }> {
  const total = parts.reduce((s, p) => s + Math.max(0, p.weight), 0);
  if (!parts.length) return [];
  if (total <= 0) return parts.map((p, i) => ({ ...p, share: i === 0 ? amount : 0 }));
  const out = parts.map((p) => ({ ...p, share: Math.trunc((amount * Math.max(0, p.weight)) / total) }));
  const diff = amount - out.reduce((s, p) => s + p.share, 0);
  if (diff !== 0) {
    let maxI = 0;
    out.forEach((p, i) => {
      if (p.weight > out[maxI].weight) maxI = i;
    });
    out[maxI].share += diff;
  }
  return out;
}

/** Phiếu thu tiền thật trong kỳ, kèm hợp đồng, dòng hợp đồng và khách: dùng cho lương, doanh thu theo dịch vụ, kênh. */
export async function collectedPayments(range: Range, branchIds: string[]) {
  return prisma.payment.findMany({
    where: { branchId: { in: branchIds }, paidAt: range, ...REAL_MONEY },
    orderBy: { paidAt: "asc" },
    select: {
      id: true,
      code: true,
      amount: true,
      paidAt: true,
      branchId: true,
      customerId: true,
      contract: {
        select: {
          id: true,
          code: true,
          consultantId: true,
          closeType: true,
          closingDoctorId: true,
          items: { select: { id: true, serviceId: true, name: true, amount: true, upsellById: true } },
        },
      },
      customer: {
        select: {
          id: true,
          code: true,
          name: true,
          assignedToId: true,
          telesaleId: true,
          channelId: true,
          campaignId: true,
          channel: { select: { key: true } },
          leadOrigin: { select: { campaignId: true, adId: true, adPostId: true, adCampaign: true } },
        },
      },
    },
  });
}

export type CollectedPayment = Awaited<ReturnType<typeof collectedPayments>>[number];

/** Khách đến từ quảng cáo (có chiến dịch hoặc lead gốc mang mã quảng cáo). */
export function isAdsCustomer(c: {
  campaignId: string | null;
  leadOrigin: { campaignId: string | null; adId: string | null; adPostId: string | null; adCampaign: string | null } | null;
}): boolean {
  if (c.campaignId) return true;
  const l = c.leadOrigin;
  return Boolean(l && (l.campaignId || l.adId || l.adPostId || l.adCampaign));
}

export function isAdsLead(l: { campaignId: string | null; adId: string | null; adPostId: string | null; adCampaign: string | null }): boolean {
  return Boolean(l.campaignId || l.adId || l.adPostId || l.adCampaign);
}
