import type { Request } from "express";
import { prisma } from "./prisma";
import { currentUser } from "../middleware/auth";
import { startOfVnDay, startOfVnMonth, vnDayKey } from "./datetime";
import { ContractStatus, InvoiceStatus, PaymentMethod, ProcedureStatus } from "../types/enums";

// Nền chung cho mọi báo cáo (reports.ts, department-scorecard.ts).
//
// Gom về một chỗ vì các lỗi B1 đến B9 đều cùng một gốc: mỗi báo cáo tự viết lại
// điều kiện "hợp đồng nào được tính", "ngày nào", "cơ sở nào", mỗi chỗ một kiểu.

const DAY_MS = 86_400_000;

/**
 * F20: phiếu trừ bằng voucher giảm công nợ nhưng KHÔNG phải tiền thật. Mọi báo
 * cáo "đã thu", doanh thu, lương thưởng lọc thêm điều kiện này.
 */
export const REAL_MONEY = { method: { not: PaymentMethod.VOUCHER } } as const;

export interface Period {
  from: Date;
  to: Date;
  prevFrom: Date;
  prevTo: Date;
}

/** "2026-09-15" -> 00:00 giờ Việt Nam của ngày đó; chuỗi có giờ thì giữ nguyên. */
function parseBoundary(value: unknown): Date {
  const s = String(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return startOfVnDay(new Date(`${s}T12:00:00Z`));
  return new Date(s);
}

/**
 * Quy kỳ báo cáo về khoảng [from, to) theo giờ Việt Nam (B4) + kỳ trước liền kề
 * cùng độ dài để so sánh. `to` mặc định là 00:00 ngày mai giờ Việt Nam.
 */
export function resolvePeriod(query: Record<string, unknown>, now = new Date()): Period {
  const preset = String(query.period ?? "month");
  const today = startOfVnDay(now);
  let to = new Date(today.getTime() + DAY_MS);
  let from: Date;

  if (query.from) {
    from = parseBoundary(query.from);
    if (query.to) to = parseBoundary(query.to);
  } else {
    switch (preset) {
      case "today":
        from = today;
        break;
      case "7d":
        from = new Date(today.getTime() - 6 * DAY_MS);
        break;
      case "quarter": {
        const [y, m] = vnDayKey(now).split("-").map(Number);
        const qStartMonth = Math.floor((m - 1) / 3) * 3; // 0-based
        from = startOfVnMonth(new Date(Date.UTC(y, qStartMonth, 1, 12)));
        break;
      }
      default:
        from = startOfVnMonth(now);
    }
  }

  const span = to.getTime() - from.getTime();
  return { from, to, prevFrom: new Date(from.getTime() - span), prevTo: from };
}

/** Phạm vi cơ sở của một báo cáo. `specific` = người xem chọn đúng một cơ sở. */
export interface BranchScope {
  ids: string[];
  specific: boolean;
}

export function reportBranchScope(req: Request): BranchScope {
  const me = currentUser(req);
  const requested = req.query.branchId as string | undefined;
  if (requested && me.branchIds.includes(requested)) return { ids: [requested], specific: true };
  return { ids: me.branchIds, specific: false };
}

/**
 * Bảng có branchId được để trống (Lead, Campaign): bản ghi chưa gán cơ sở là
 * dữ liệu chung, chỉ tính khi người xem đang xem "mọi cơ sở của tôi". Chọn
 * riêng một cơ sở thì chỉ tính bản ghi của đúng cơ sở đó.
 */
export function nullableBranchWhere(field: string, scope: BranchScope): Record<string, unknown> {
  if (scope.specific) return { [field]: { in: scope.ids } };
  return { OR: [{ [field]: { in: scope.ids } }, { [field]: null }] };
}

/** Khách thuộc cơ sở nào: qua bảng liên kết khách và cơ sở (khách liên thông). */
export function customerBranchWhere(scope: BranchScope): Record<string, unknown> {
  return { branchLinks: { some: { branchId: { in: scope.ids } } } };
}

/**
 * B1: điều kiện "hợp đồng được tính doanh số": đã ký trong kỳ và KHÔNG bị huỷ.
 * Huỷ hợp đồng giữ nguyên signedAt (để còn dấu vết) nên mọi báo cáo phải lọc.
 */
export function countedContractWhere(range: { gte: Date; lt: Date }, branchIds?: string[]) {
  return {
    signedAt: range,
    status: { not: ContractStatus.CANCELLED },
    ...(branchIds ? { branchId: { in: branchIds } } : {}),
  };
}

/**
 * B6: tiền THỰC THU trong kỳ quy về tư vấn viên của hợp đồng. Khác với
 * contract.paidAmount (cộng dồn mọi lần thu, kể cả ngoài kỳ).
 */
export async function collectedByConsultant(
  range: { gte: Date; lt: Date },
  branchIds: string[]
): Promise<Map<string | null, number>> {
  const byContract = await prisma.payment.groupBy({
    by: ["contractId"],
    _sum: { amount: true },
    where: { branchId: { in: branchIds }, paidAt: range, contractId: { not: null }, ...REAL_MONEY },
  });
  const contracts = await prisma.contract.findMany({
    where: { id: { in: byContract.map((r) => r.contractId!).filter(Boolean) } },
    select: { id: true, consultantId: true },
  });
  const consultantOf = new Map(contracts.map((c) => [c.id, c.consultantId]));
  const out = new Map<string | null, number>();
  for (const row of byContract) {
    const key = consultantOf.get(row.contractId!) ?? null;
    out.set(key, (out.get(key) ?? 0) + (row._sum.amount ?? 0));
  }
  return out;
}

/** B6: tiền thu trong kỳ theo kênh nguồn của khách (Customer.channelId). */
export async function collectedByChannel(
  range: { gte: Date; lt: Date },
  branchIds: string[]
): Promise<Map<string | null, number>> {
  const byCustomer = await prisma.payment.groupBy({
    by: ["customerId"],
    _sum: { amount: true },
    where: { branchId: { in: branchIds }, paidAt: range, ...REAL_MONEY },
  });
  const customers = await prisma.customer.findMany({
    where: { id: { in: byCustomer.map((r) => r.customerId) } },
    select: { id: true, channelId: true },
  });
  const channelOf = new Map(customers.map((c) => [c.id, c.channelId]));
  const out = new Map<string | null, number>();
  for (const row of byCustomer) {
    const key = channelOf.get(row.customerId) ?? null;
    out.set(key, (out.get(key) ?? 0) + (row._sum.amount ?? 0));
  }
  return out;
}

/** Doanh số ký (hợp đồng được tính) theo kênh nguồn của khách. */
export async function signedByChannel(
  range: { gte: Date; lt: Date },
  branchIds: string[]
): Promise<Map<string | null, { total: number; count: number }>> {
  const byCustomer = await prisma.contract.groupBy({
    by: ["customerId"],
    _sum: { total: true },
    _count: true,
    where: countedContractWhere(range, branchIds),
  });
  const customers = await prisma.customer.findMany({
    where: { id: { in: byCustomer.map((r) => r.customerId) } },
    select: { id: true, channelId: true },
  });
  const channelOf = new Map(customers.map((c) => [c.id, c.channelId]));
  const out = new Map<string | null, { total: number; count: number }>();
  for (const row of byCustomer) {
    const key = channelOf.get(row.customerId) ?? null;
    const cur = out.get(key) ?? { total: 0, count: 0 };
    cur.total += row._sum.total ?? 0;
    cur.count += row._count;
    out.set(key, cur);
  }
  return out;
}

/**
 * Top dịch vụ gom theo serviceId (không theo tên: cùng một dịch vụ bị gõ tên
 * khác nhau trên từng hợp đồng sẽ bị tách thành nhiều dòng). Dòng nhập tay
 * không gắn dịch vụ thì mới gom theo tên.
 */
export async function topServices(
  range: { gte: Date; lt: Date },
  branchIds: string[],
  take?: number
): Promise<Array<{ serviceId: string | null; name: string; count: number; revenue: number }>> {
  const contractWhere = countedContractWhere(range, branchIds);
  const [byService, manual] = await Promise.all([
    prisma.contractItem.groupBy({
      by: ["serviceId"],
      _sum: { amount: true },
      _count: true,
      where: { serviceId: { not: null }, contract: contractWhere },
    }),
    prisma.contractItem.groupBy({
      by: ["name"],
      _sum: { amount: true },
      _count: true,
      where: { serviceId: null, contract: contractWhere },
    }),
  ]);
  const services = await prisma.service.findMany({
    where: { id: { in: byService.map((r) => r.serviceId!) } },
    select: { id: true, name: true },
  });
  const nameOf = new Map(services.map((s) => [s.id, s.name]));
  const rows = [
    ...byService.map((r) => ({
      serviceId: r.serviceId,
      name: nameOf.get(r.serviceId!) ?? "Dịch vụ đã xoá",
      count: r._count,
      revenue: r._sum.amount ?? 0,
    })),
    ...manual.map((r) => ({ serviceId: null, name: r.name, count: r._count, revenue: r._sum.amount ?? 0 })),
  ].sort((a, b) => b.revenue - a.revenue);
  return take ? rows.slice(0, take) : rows;
}

/**
 * B7: số dư công nợ TẠI một thời điểm: hoá đơn đã phát hành trước mốc đó trừ
 * tiền đã thu vào các hoá đơn ấy trước mốc đó. Không dựa vào status/paidAmount
 * hiện tại, vì hoá đơn đã trả xong hôm nay vẫn là nợ ở đầu kỳ.
 */
export async function debtBalanceAt(at: Date, branchIds: string[]): Promise<number> {
  const invoiceWhere = {
    branchId: { in: branchIds },
    status: { notIn: [InvoiceStatus.DRAFT, InvoiceStatus.VOID] },
    createdAt: { lt: at },
  };
  const [issued, paid] = await Promise.all([
    prisma.invoice.aggregate({ where: invoiceWhere, _sum: { amount: true } }),
    prisma.payment.aggregate({
      where: { paidAt: { lt: at }, invoice: invoiceWhere },
      _sum: { amount: true },
    }),
  ]);
  return Math.max(0, (issued._sum.amount ?? 0) - (paid._sum.amount ?? 0));
}

/** Số phút một ca thật sự chiếm phòng (B9): giờ bắt đầu, kết thúc thật; thiếu thì lấy dự kiến. */
export function procedureMinutes(p: {
  startedAt: Date | null;
  finishedAt: Date | null;
  durationMin: number;
}): number {
  if (p.startedAt && p.finishedAt && p.finishedAt > p.startedAt) {
    return Math.round((p.finishedAt.getTime() - p.startedAt.getTime()) / 60000);
  }
  return p.durationMin;
}

/** Ca có chiếm phòng mổ không (bị huỷ, hoãn thì không tính công suất). */
export function occupiesRoom(status: string): boolean {
  return status !== ProcedureStatus.CANCELLED && status !== ProcedureStatus.POSTPONED;
}

/** Số ngày (giờ Việt Nam) trong kỳ, tối thiểu 1. */
export function daysInPeriod(from: Date, to: Date): number {
  return Math.max(1, Math.round((to.getTime() - from.getTime()) / DAY_MS));
}
