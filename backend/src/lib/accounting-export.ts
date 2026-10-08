import type { Writable } from "node:stream";
import ExcelJS from "exceljs";
import { prisma } from "./prisma";
import { formatDateTimeVN } from "./datetime";
import { allocate, type Range } from "./metrics";
import { PaymentMethod } from "../types/enums";

// F33: XUẤT EXCEL CHO KẾ TOÁN.
//
// Ghi THẲNG ra luồng trả về (exceljs WorkbookWriter), đọc phiếu thu theo từng
// trang 1.000 dòng bằng con trỏ: không còn trần 5.000 dòng của /reports/export,
// bộ nhớ không phình theo số dòng.
//   Trang 1 "Phiếu thu": mỗi phiếu một dòng, đủ cột cho kế toán đối chiếu Misa.
//   Trang 2 "Sổ doanh thu theo dịch vụ": phiếu tiền thật chia theo dòng dịch vụ
//   của hợp đồng (tỉ lệ giá trị dòng); phiếu voucher không vào sổ doanh thu.

const PAGE = 1000;

export const RECEIPT_COLUMNS = [
  { header: "Mã phiếu", key: "code", width: 16 },
  { header: "Ngày giờ (giờ Việt Nam)", key: "paidAt", width: 20 },
  { header: "Mã khách", key: "customerCode", width: 16 },
  { header: "Khách hàng", key: "customerName", width: 26 },
  { header: "Cơ sở", key: "branch", width: 20 },
  { header: "Dịch vụ", key: "services", width: 34 },
  { header: "Mã hợp đồng", key: "contract", width: 16 },
  { header: "Mã hoá đơn", key: "invoice", width: 16 },
  { header: "Loại phiếu", key: "type", width: 12 },
  { header: "Người thu", key: "receivedBy", width: 20 },
  { header: "Phương thức", key: "method", width: 16 },
  { header: "Số tiền", key: "amount", width: 16 },
  { header: "Số hoá đơn Misa", key: "misaInvoiceNo", width: 18 },
  { header: "Mã giao dịch", key: "reference", width: 18 },
  { header: "Ghi chú", key: "note", width: 30 },
];

export const LEDGER_COLUMNS = [
  { header: "Mã phiếu", key: "code", width: 16 },
  { header: "Ngày giờ (giờ Việt Nam)", key: "paidAt", width: 20 },
  { header: "Mã khách", key: "customerCode", width: 16 },
  { header: "Khách hàng", key: "customerName", width: 26 },
  { header: "Cơ sở", key: "branch", width: 20 },
  { header: "Mã hợp đồng", key: "contract", width: 16 },
  { header: "Dịch vụ", key: "service", width: 30 },
  { header: "Doanh thu phân bổ", key: "amount", width: 18 },
  { header: "Phương thức", key: "method", width: 16 },
  { header: "Số hoá đơn Misa", key: "misaInvoiceNo", width: 18 },
];

const METHOD: Record<string, string> = {
  CASH: "Tiền mặt",
  BANK_TRANSFER: "Chuyển khoản",
  CARD: "Thẻ",
  QR: "QR",
  INSTALLMENT: "Trả góp",
  OTHER: "Khác",
  VOUCHER: "Voucher",
};
const TYPE: Record<string, string> = { DEPOSIT: "Cọc", PAYMENT: "Thanh toán", REFUND: "Hoàn tiền" };

const SELECT = {
  id: true,
  code: true,
  paidAt: true,
  amount: true,
  type: true,
  method: true,
  reference: true,
  note: true,
  misaInvoiceNo: true,
  branch: { select: { name: true } },
  customer: { select: { code: true, name: true } },
  receivedBy: { select: { name: true } },
  invoice: { select: { code: true } },
  contract: { select: { code: true, items: { select: { name: true, amount: true, service: { select: { name: true } } } } } },
} as const;

async function* pages(range: Range, branchIds: string[]) {
  let cursor: string | undefined;
  for (;;) {
    const rows = await prisma.payment.findMany({
      where: { branchId: { in: branchIds }, paidAt: range },
      orderBy: [{ paidAt: "asc" }, { id: "asc" }],
      take: PAGE,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      select: SELECT,
    });
    if (!rows.length) return;
    yield rows;
    if (rows.length < PAGE) return;
    cursor = rows[rows.length - 1].id;
  }
}

export async function countAccountingRows(range: Range, branchIds: string[]): Promise<number> {
  return prisma.payment.count({ where: { branchId: { in: branchIds }, paidAt: range } });
}

/** Ghi tệp xlsx vào `stream` (res của Express). Trả số phiếu đã ghi. */
export async function writeAccountingWorkbook(stream: Writable, range: Range, branchIds: string[], title: string): Promise<number> {
  const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ stream, useStyles: true });
  wb.creator = "CRM";

  const receipts = wb.addWorksheet("Phiếu thu");
  receipts.columns = RECEIPT_COLUMNS;
  receipts.getColumn("amount").numFmt = "#,##0";
  receipts.getRow(1).font = { bold: true };
  receipts.getRow(1).commit();
  let count = 0;
  for await (const rows of pages(range, branchIds)) {
    for (const p of rows) {
      receipts
        .addRow({
          code: p.code,
          paidAt: formatDateTimeVN(p.paidAt),
          customerCode: p.customer.code,
          customerName: p.customer.name,
          branch: p.branch.name,
          services: p.contract?.items.map((i) => i.service?.name ?? i.name).join(", ") ?? "",
          contract: p.contract?.code ?? "",
          invoice: p.invoice?.code ?? "",
          type: TYPE[p.type] ?? p.type,
          receivedBy: p.receivedBy?.name ?? "",
          method: METHOD[p.method] ?? p.method,
          amount: p.amount,
          misaInvoiceNo: p.misaInvoiceNo ?? "",
          reference: p.reference ?? "",
          note: p.note ?? "",
        })
        .commit();
      count++;
    }
  }
  receipts.commit();

  const ledger = wb.addWorksheet("Sổ doanh thu theo dịch vụ");
  ledger.columns = LEDGER_COLUMNS;
  ledger.getColumn("amount").numFmt = "#,##0";
  ledger.getRow(1).font = { bold: true };
  ledger.getRow(1).commit();
  for await (const rows of pages(range, branchIds)) {
    for (const p of rows) {
      if (p.method === PaymentMethod.VOUCHER) continue;
      const base = {
        code: p.code,
        paidAt: formatDateTimeVN(p.paidAt),
        customerCode: p.customer.code,
        customerName: p.customer.name,
        branch: p.branch.name,
        contract: p.contract?.code ?? "",
        method: METHOD[p.method] ?? p.method,
        misaInvoiceNo: p.misaInvoiceNo ?? "",
      };
      const items = p.contract?.items ?? [];
      if (!items.length) {
        ledger.addRow({ ...base, service: p.type === "DEPOSIT" ? "Tiền cọc (chưa gắn dịch vụ)" : "Chưa gắn dịch vụ", amount: p.amount }).commit();
        continue;
      }
      for (const part of allocate(p.amount, items.map((i) => ({ ...i, weight: i.amount })))) {
        ledger.addRow({ ...base, service: part.service?.name ?? part.name, amount: part.share }).commit();
      }
    }
  }
  ledger.commit();

  const info = wb.addWorksheet("Thông tin");
  info.addRow(["Tệp", title]).commit();
  info.addRow(["Số phiếu", count]).commit();
  info.addRow(["Ghi chú", "Ngày giờ theo giờ Việt Nam. Phiếu voucher có ở trang Phiếu thu nhưng không tính vào sổ doanh thu."]).commit();
  info.commit();
  await wb.commit();
  return count;
}
