import ExcelJS from "exceljs";
import { prisma } from "./prisma";
import { getSettingNumber, getSettingRaw } from "./settings-catalog";
import { HttpError } from "../middleware/errorHandler";
import { formatDateTimeVN } from "./datetime";
import {
  allocate,
  collectedPayments,
  isAdsCustomer,
  responsibleSaleOf,
  settingList,
  showupsBySale,
  vnMonthRange,
} from "./metrics";
import { adsBonusFor, baseSalaryFor, parseTiers, percentOf, salesBonusFor, type Tier } from "./tiers";
import { CloseType, PayrollStatus, UserStatus } from "../types/enums";

// F17: LƯƠNG VÀ THƯỞNG THEO BIÊN BẢN COACHING, trên PayrollPeriod / PayrollLine.
//
// Mỗi kỳ = một tháng (giờ VN) của một cơ sở. "Tính" chạy lại được nhiều lần cho
// tới khi "Khoá kỳ"; khoá rồi thì mọi thao tác tính lại, sửa dòng đều bị từ chối.
// Phụ cấp, khấu trừ, lương cứng của vai ngoài bảng bậc (nhập tay) được GIỮ khi
// tính lại; các khoản còn lại tính mới từ số liệu.
//
// Căn cứ (tất cả chỉ trên tiền ĐÃ THU trong kỳ, xem lib/metrics.ts):
//   lương cứng   theo số khách đến trong tháng của sale (bậc "vượt ngưỡng")
//   thưởng DS    doanh thu tính cho sale: hợp đồng FULL x % full, PARTIAL x % bán phần
//   bác sĩ chốt  phần còn lại của hợp đồng PARTIAL x % thưởng bác sĩ chốt (ghi vào commission)
//   upsale       tiền thu phân bổ cho dòng hợp đồng có upsellById x % upsale
//   % ads        doanh thu quảng cáo Facebook của cơ sở x % bậc, chia đều người chạy ads

export interface PayrollParams {
  salesRoles: string[];
  adsRoles: string[];
  adsChannelKeys: string[];
  baseSalaryDefault: number;
  baseTiers: Tier[];
  bonusScheme: string;
  milestones: Tier[];
  percentTiers: Tier[];
  unitVnd: number;
  fullSalePercent: number;
  partialSalePercent: number;
  doctorCloseBonusPercent: number;
  upsellPercent: number;
  adsTiers: Tier[];
}

export async function loadPayrollParams(): Promise<PayrollParams> {
  return {
    salesRoles: await settingList("payroll.salesRoles"),
    adsRoles: await settingList("payroll.adsRoles"),
    adsChannelKeys: (await settingList("payroll.adsChannelKeys")).map((k) => k.toLowerCase()),
    baseSalaryDefault: await getSettingNumber("payroll.baseSalaryDefault"),
    baseTiers: parseTiers(await getSettingRaw("payroll.baseSalaryTiers")),
    bonusScheme: await getSettingRaw("payroll.bonusScheme"),
    milestones: parseTiers(await getSettingRaw("payroll.bonusMilestones")),
    percentTiers: parseTiers(await getSettingRaw("payroll.bonusPercentTiers")),
    unitVnd: Math.max(1, await getSettingNumber("payroll.revenueUnitVnd")),
    fullSalePercent: await getSettingNumber("payroll.fullSalePercent"),
    partialSalePercent: await getSettingNumber("payroll.partialSalePercent"),
    doctorCloseBonusPercent: await getSettingNumber("payroll.doctorCloseBonusPercent"),
    upsellPercent: await getSettingNumber("payroll.upsellPercent"),
    adsTiers: parseTiers(await getSettingRaw("payroll.adsPercentTiers")),
  };
}

interface Contribution {
  paymentCode: string;
  paidAt: string;
  customer: string;
  contract: string | null;
  kind: "SALE_FULL" | "SALE_PARTIAL" | "DOCTOR_CLOSE" | "UPSELL";
  amount: number;
  credited: number;
}

interface Acc {
  saleRevenue: number;
  doctorRevenue: number;
  upsellRevenue: number;
  contributions: Contribution[];
}

const MAX_CONTRIBUTIONS = 500;

function accOf(map: Map<string, Acc>, userId: string): Acc {
  let a = map.get(userId);
  if (!a) {
    a = { saleRevenue: 0, doctorRevenue: 0, upsellRevenue: 0, contributions: [] };
    map.set(userId, a);
  }
  return a;
}

export interface ComputedLine {
  userId: string;
  roleCode: string | null;
  showups: number;
  revenue: number;
  baseSalary: number | null; // null = giữ lương cứng nhập tay
  salesBonus: number;
  commission: number;
  upsellBonus: number;
  adsBonus: number;
  detail: Record<string, unknown>;
}

/** Tính số (không ghi CSDL). Tách riêng để test và để màn "xem trước". */
export async function computePayrollLines(branchId: string, periodKey: string, params: PayrollParams): Promise<ComputedLine[]> {
  const range = vnMonthRange(periodKey);
  const [users, showups, payments] = await Promise.all([
    prisma.user.findMany({
      where: { status: UserStatus.ACTIVE, branches: { some: { branchId } } },
      select: { id: true, name: true, roleLinks: { select: { role: { select: { code: true } } } } },
    }),
    showupsBySale(range, [branchId]),
    collectedPayments(range, [branchId]),
  ]);

  const acc = new Map<string, Acc>();
  let adsRevenue = 0;

  for (const p of payments) {
    const base = {
      paymentCode: p.code,
      paidAt: formatDateTimeVN(p.paidAt),
      customer: `${p.customer.code} ${p.customer.name}`,
      contract: p.contract?.code ?? null,
      amount: p.amount,
    };
    const push = (userId: string, c: Contribution) => {
      const a = accOf(acc, userId);
      if (a.contributions.length < MAX_CONTRIBUTIONS) a.contributions.push(c);
    };

    // 1. Doanh thu tính thưởng cho sale (và phần bác sĩ chốt khi bán phần).
    const saleId = p.contract?.consultantId ?? responsibleSaleOf(p.customer);
    const partial = p.contract?.closeType === CloseType.PARTIAL;
    const salePct = partial ? params.partialSalePercent : params.fullSalePercent;
    if (saleId) {
      const credited = percentOf(p.amount, salePct);
      accOf(acc, saleId).saleRevenue += credited;
      push(saleId, { ...base, kind: partial ? "SALE_PARTIAL" : "SALE_FULL", credited });
    }
    if (partial && p.contract?.closingDoctorId) {
      const credited = p.amount - percentOf(p.amount, salePct);
      accOf(acc, p.contract.closingDoctorId).doctorRevenue += credited;
      push(p.contract.closingDoctorId, { ...base, kind: "DOCTOR_CLOSE", credited });
    }

    // 2. Upsale: tiền thu phân bổ theo giá trị dòng hợp đồng.
    const items = p.contract?.items ?? [];
    if (items.some((i) => i.upsellById)) {
      for (const part of allocate(p.amount, items.map((i) => ({ ...i, weight: i.amount })))) {
        if (!part.upsellById || !part.share) continue;
        accOf(acc, part.upsellById).upsellRevenue += part.share;
        push(part.upsellById, { ...base, kind: "UPSELL", credited: part.share });
      }
    }

    // 3. Doanh thu từ quảng cáo Facebook của cơ sở.
    const key = p.customer.channel?.key?.toLowerCase() ?? "";
    if (params.adsChannelKeys.includes(key) && isAdsCustomer(p.customer)) adsRevenue += p.amount;
  }

  const adsStaff = users.filter((u) => u.roleLinks.some((l) => params.adsRoles.includes(l.role.code)));
  const ads = adsBonusFor(adsRevenue, params.adsTiers, params.unitVnd);
  const adsEach = adsStaff.length ? Math.round(ads.bonus / adsStaff.length) : 0;

  const lines: ComputedLine[] = [];
  for (const u of users) {
    const roles = u.roleLinks.map((l) => l.role.code);
    const isSales = roles.some((r) => params.salesRoles.includes(r));
    const isAds = roles.some((r) => params.adsRoles.includes(r));
    const a = acc.get(u.id) ?? { saleRevenue: 0, doctorRevenue: 0, upsellRevenue: 0, contributions: [] };
    const myShowups = showups.get(u.id) ?? 0;
    if (!isSales && !isAds && !a.saleRevenue && !a.doctorRevenue && !a.upsellRevenue) continue;

    const sales = isSales
      ? salesBonusFor(a.saleRevenue, params.bonusScheme, params.milestones, params.percentTiers, params.unitVnd)
      : { bonus: 0, tier: null };
    lines.push({
      userId: u.id,
      roleCode: roles.find((r) => params.salesRoles.includes(r)) ?? roles.find((r) => params.adsRoles.includes(r)) ?? roles[0] ?? null,
      showups: myShowups,
      revenue: a.saleRevenue,
      baseSalary: isSales ? baseSalaryFor(myShowups, params.baseSalaryDefault, params.baseTiers) : null,
      salesBonus: sales.bonus,
      commission: percentOf(a.doctorRevenue, params.doctorCloseBonusPercent),
      upsellBonus: percentOf(a.upsellRevenue, params.upsellPercent),
      adsBonus: isAds ? adsEach : 0,
      detail: {
        isSales,
        isAds,
        bonusScheme: params.bonusScheme,
        bonusTier: sales.tier,
        saleRevenue: a.saleRevenue,
        doctorRevenue: a.doctorRevenue,
        upsellRevenue: a.upsellRevenue,
        adsRevenue: isAds ? adsRevenue : 0,
        adsTier: isAds ? ads.tier : null,
        adsStaffCount: isAds ? adsStaff.length : 0,
        contributions: a.contributions,
        contributionsTruncated: a.contributions.length >= MAX_CONTRIBUTIONS,
      },
    });
  }
  return lines;
}

export async function getOrCreatePeriod(branchId: string, periodKey: string) {
  return prisma.payrollPeriod.upsert({
    where: { branchId_periodKey: { branchId, periodKey } },
    create: { branchId, periodKey, status: PayrollStatus.OPEN },
    update: {},
  });
}

function totalOf(l: { baseSalary: number; salesBonus: number; commission: number; upsellBonus: number; adsBonus: number; allowance: number; deduction: number }): number {
  return l.baseSalary + l.salesBonus + l.commission + l.upsellBonus + l.adsBonus + l.allowance - l.deduction;
}

/** Tính và ghi kỳ lương. Kỳ đã khoá thì từ chối (409). */
export async function computePayrollPeriod(branchId: string, periodKey: string, now = new Date()) {
  const period = await getOrCreatePeriod(branchId, periodKey);
  if (period.status === PayrollStatus.CLOSED) throw new HttpError(409, `Kỳ lương ${periodKey} đã khoá, không tính lại được`);

  const params = await loadPayrollParams();
  const computed = await computePayrollLines(branchId, periodKey, params);
  const existing = await prisma.payrollLine.findMany({ where: { periodId: period.id } });
  const byUser = new Map(existing.map((l) => [l.userId, l]));

  await prisma.$transaction(async (tx) => {
    for (const c of computed) {
      const old = byUser.get(c.userId);
      const data = {
        roleCode: c.roleCode,
        showups: c.showups,
        revenue: c.revenue,
        baseSalary: c.baseSalary ?? old?.baseSalary ?? 0,
        salesBonus: c.salesBonus,
        commission: c.commission,
        upsellBonus: c.upsellBonus,
        adsBonus: c.adsBonus,
        allowance: old?.allowance ?? 0,
        deduction: old?.deduction ?? 0,
        detailJson: JSON.stringify(c.detail),
      };
      const total = totalOf(data);
      if (old) await tx.payrollLine.update({ where: { id: old.id }, data: { ...data, total } });
      else await tx.payrollLine.create({ data: { ...data, total, periodId: period.id, userId: c.userId } });
      byUser.delete(c.userId);
    }
    // Dòng cũ không còn phát sinh: về 0 phần tính tự động, giữ phần nhập tay.
    for (const old of byUser.values()) {
      const data = { showups: 0, revenue: 0, salesBonus: 0, commission: 0, upsellBonus: 0, adsBonus: 0, detailJson: null };
      await tx.payrollLine.update({ where: { id: old.id }, data: { ...data, total: totalOf({ ...old, ...data }) } });
    }
    await tx.payrollPeriod.update({
      where: { id: period.id },
      data: { computedAt: now, paramsJson: JSON.stringify(params) },
    });
  });
  return { periodId: period.id, lines: computed.length };
}

/** Sửa phụ cấp, khấu trừ, lương cứng nhập tay của một dòng (kỳ chưa khoá). */
export async function updatePayrollLine(
  lineId: string,
  patch: { allowance?: number; deduction?: number; baseSalary?: number; note?: string | null }
) {
  const line = await prisma.payrollLine.findUnique({ where: { id: lineId }, include: { period: true } });
  if (!line) throw new HttpError(404, "Không tìm thấy dòng lương");
  if (line.period.status === PayrollStatus.CLOSED) throw new HttpError(409, "Kỳ lương đã khoá, không sửa được");
  const next = { ...line, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) };
  return prisma.payrollLine.update({
    where: { id: lineId },
    data: {
      allowance: next.allowance,
      deduction: next.deduction,
      baseSalary: next.baseSalary,
      note: next.note ?? null,
      total: totalOf(next),
    },
  });
}

const XLSX_COLUMNS: Array<{ header: string; key: string; width: number }> = [
  { header: "Nhân viên", key: "name", width: 26 },
  { header: "Vai trò", key: "roleCode", width: 14 },
  { header: "Khách đến", key: "showups", width: 11 },
  { header: "Doanh thu tính thưởng", key: "revenue", width: 20 },
  { header: "Lương cứng", key: "baseSalary", width: 14 },
  { header: "Thưởng doanh số", key: "salesBonus", width: 16 },
  { header: "Thưởng bác sĩ chốt", key: "commission", width: 16 },
  { header: "Thưởng upsale", key: "upsellBonus", width: 14 },
  { header: "% quảng cáo", key: "adsBonus", width: 14 },
  { header: "Phụ cấp", key: "allowance", width: 12 },
  { header: "Khấu trừ", key: "deduction", width: 12 },
  { header: "Tổng", key: "total", width: 16 },
  { header: "Ghi chú", key: "note", width: 24 },
];

export const PAYROLL_XLSX_HEADERS = XLSX_COLUMNS.map((c) => c.header);

/** Tệp Excel kỳ lương: trang Bảng lương + trang Chi tiết doanh thu tính thưởng. */
export async function payrollWorkbook(periodId: string): Promise<ExcelJS.Workbook> {
  const period = await prisma.payrollPeriod.findUniqueOrThrow({
    where: { id: periodId },
    include: {
      branch: { select: { name: true } },
      lines: { include: { user: { select: { name: true } } }, orderBy: { total: "desc" } },
    },
  });
  const wb = new ExcelJS.Workbook();
  wb.creator = "CRM";
  const ws = wb.addWorksheet("Bảng lương");
  ws.columns = XLSX_COLUMNS;
  for (const l of period.lines) ws.addRow({ ...l, name: l.user.name });
  const sum = (k: keyof (typeof period.lines)[number]) => period.lines.reduce((s, l) => s + Number(l[k] ?? 0), 0);
  ws.addRow({
    name: "Tổng cộng",
    baseSalary: sum("baseSalary"),
    salesBonus: sum("salesBonus"),
    commission: sum("commission"),
    upsellBonus: sum("upsellBonus"),
    adsBonus: sum("adsBonus"),
    allowance: sum("allowance"),
    deduction: sum("deduction"),
    total: sum("total"),
  });
  ws.getRow(1).font = { bold: true };
  for (const key of ["revenue", "baseSalary", "salesBonus", "commission", "upsellBonus", "adsBonus", "allowance", "deduction", "total"]) {
    ws.getColumn(key).numFmt = "#,##0";
  }

  const detail = wb.addWorksheet("Chi tiết");
  detail.columns = [
    { header: "Nhân viên", key: "name", width: 24 },
    { header: "Phiếu thu", key: "paymentCode", width: 16 },
    { header: "Ngày giờ", key: "paidAt", width: 18 },
    { header: "Khách", key: "customer", width: 28 },
    { header: "Hợp đồng", key: "contract", width: 16 },
    { header: "Loại", key: "kind", width: 16 },
    { header: "Số tiền phiếu", key: "amount", width: 14 },
    { header: "Phần được tính", key: "credited", width: 14 },
  ];
  const KIND: Record<string, string> = {
    SALE_FULL: "Bán full",
    SALE_PARTIAL: "Bán phần (sale)",
    DOCTOR_CLOSE: "Bác sĩ chốt",
    UPSELL: "Upsale",
  };
  for (const l of period.lines) {
    const d = l.detailJson ? (JSON.parse(l.detailJson) as { contributions?: Contribution[] }) : {};
    for (const c of d.contributions ?? []) detail.addRow({ name: l.user.name, ...c, kind: KIND[c.kind] ?? c.kind });
  }
  detail.getRow(1).font = { bold: true };
  detail.getColumn("amount").numFmt = "#,##0";
  detail.getColumn("credited").numFmt = "#,##0";
  ws.headerFooter.oddHeader = `${period.branch.name} · Kỳ lương ${period.periodKey}`;
  return wb;
}
