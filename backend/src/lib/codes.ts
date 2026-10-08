import { prisma } from "./prisma";

// Sinh mã nghiệp vụ dạng <TIỀN TỐ>-YYMM-NNNN, đúng định dạng đang dùng trong
// prototype: KH-2606-0187, BG-2608-0143, DH-2608-0142, PT-2608-0091.
//
// Số thứ tự đếm theo tháng và theo từng loại. Dùng transaction + đếm bản ghi
// đã có trong tháng nên an toàn với SQLite (một writer tại một thời điểm).

export const CodePrefix = {
  CUSTOMER: "KH",
  LEAD: "LD",
  QUOTATION: "BG",
  CONTRACT: "DH",
  INVOICE: "HD",
  PAYMENT: "PT",
  MEDICAL_RECORD: "BA",
  PROCEDURE: "PM",
  TRANSFER: "PC", // phiếu chuyển kho
  APPOINTMENT: "LH", // lịch hẹn (F25: nội dung chuyển khoản cọc)
} as const;
export type CodePrefix = (typeof CodePrefix)[keyof typeof CodePrefix];

function yymm(d = new Date()): string {
  return `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, "0")}`;
}

type Counter = (prefixWithPeriod: string) => Promise<number>;

const counters: Record<CodePrefix, Counter> = {
  KH: (p) => prisma.customer.count({ where: { code: { startsWith: p } } }),
  LD: async () => 0, // Lead không có cột code riêng; giữ chỗ cho Giai đoạn 2
  BG: (p) => prisma.quotation.count({ where: { code: { startsWith: p } } }),
  DH: (p) => prisma.contract.count({ where: { code: { startsWith: p } } }),
  HD: (p) => prisma.invoice.count({ where: { code: { startsWith: p } } }),
  PT: (p) => prisma.payment.count({ where: { code: { startsWith: p } } }),
  BA: (p) => prisma.medicalRecord.count({ where: { code: { startsWith: p } } }),
  PM: (p) => prisma.procedureRecord.count({ where: { code: { startsWith: p } } }),
  PC: (p) => prisma.stockTransfer.count({ where: { code: { startsWith: p } } }),
  LH: (p) => prisma.appointment.count({ where: { code: { startsWith: p } } }),
};

/**
 * Trả về mã tiếp theo. Có vòng lặp thử lại vì `count` không khoá bảng: nếu
 * hai yêu cầu cùng lúc sinh trùng mã thì lần ghi thứ hai sẽ vi phạm ràng buộc
 * unique và gọi lại hàm này.
 */
export async function nextCode(prefix: CodePrefix, when = new Date()): Promise<string> {
  const period = `${prefix}-${yymm(when)}`;
  const used = await counters[prefix](period);
  return `${period}-${String(used + 1).padStart(4, "0")}`;
}

/** Bọc một thao tác tạo bản ghi cần mã duy nhất, thử lại khi trùng mã. */
export async function withCode<T>(
  prefix: CodePrefix,
  create: (code: string) => Promise<T>,
  attempts = 5
): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    const code = await nextCode(prefix);
    try {
      return await create(code);
    } catch (err: unknown) {
      const e = err as { code?: string; meta?: { target?: string[] } };
      const isDuplicateCode =
        e?.code === "P2002" && (e.meta?.target ?? []).some((t) => t.includes("code"));
      if (!isDuplicateCode) throw err;
      lastError = err;
    }
  }
  throw lastError;
}
