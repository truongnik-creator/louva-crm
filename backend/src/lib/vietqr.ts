// F25: ảnh mã VietQR theo chuẩn napas "quick link" của img.vietqr.io.
//
//   https://img.vietqr.io/image/<BIN>-<SỐ TK>-<MẪU>.png?amount=&addInfo=&accountName=
//
// Không gọi API nào: ảnh do img.vietqr.io dựng từ chính đường dẫn, khách quét
// bằng app ngân hàng là điền sẵn số tiền và nội dung (mã lịch hẹn).

export interface BankAccount {
  bin: string;
  accountNo: string;
  accountName: string;
}

const TEMPLATES = new Set(["compact", "compact2", "qr_only", "print"]);

export function isBankConfigured(bank: Partial<BankAccount> | null | undefined): bank is BankAccount {
  return Boolean(bank?.bin && /^\d{6}$/.test(bank.bin) && bank.accountNo && /^[0-9A-Za-z]{4,30}$/.test(bank.accountNo));
}

export function buildVietQrUrl(opts: {
  bank: BankAccount;
  amount: number;
  addInfo: string;
  template?: string;
}): string {
  const template = opts.template && TEMPLATES.has(opts.template) ? opts.template : "compact2";
  const base = `https://img.vietqr.io/image/${encodeURIComponent(opts.bank.bin)}-${encodeURIComponent(opts.bank.accountNo)}-${template}.png`;
  const params = new URLSearchParams();
  if (opts.amount > 0) params.set("amount", String(Math.round(opts.amount)));
  params.set("addInfo", opts.addInfo);
  if (opts.bank.accountName) params.set("accountName", opts.bank.accountName);
  return `${base}?${params.toString()}`;
}
