// Định dạng ngày giờ và tiền phía server theo múi giờ nghiệp vụ (T5).
//
// `Date#toLocaleString("vi-VN")` dùng múi giờ của MÁY CHỦ: chạy trên VPS đặt
// UTC là nhật ký ghi "02:00" cho lịch hẹn 9h sáng. Mọi chuỗi ngày giờ sinh ra
// ở server (nội dung Activity, AuditLog, thông báo lỗi) phải đi qua đây.

export const BUSINESS_TZ = process.env.BUSINESS_TZ ?? "Asia/Ho_Chi_Minh";

const dateTimeFmt = new Intl.DateTimeFormat("vi-VN", {
  timeZone: BUSINESS_TZ,
  hour: "2-digit",
  minute: "2-digit",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour12: false,
});
const dateFmt = new Intl.DateTimeFormat("vi-VN", {
  timeZone: BUSINESS_TZ,
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
});
const timeFmt = new Intl.DateTimeFormat("vi-VN", {
  timeZone: BUSINESS_TZ,
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
const vndFmt = new Intl.NumberFormat("vi-VN");

type DateInput = Date | string | number;
const toDate = (d: DateInput) => (d instanceof Date ? d : new Date(d));

/** "09:30 15/09/2026" theo giờ Việt Nam. */
export function formatDateTimeVN(d: DateInput, timeZone = BUSINESS_TZ): string {
  const fmt =
    timeZone === BUSINESS_TZ
      ? dateTimeFmt
      : new Intl.DateTimeFormat("vi-VN", { timeZone, hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit", year: "numeric", hour12: false });
  return fmt.format(toDate(d));
}

/** "15/09/2026" theo giờ Việt Nam. */
export function formatDateVN(d: DateInput): string {
  return dateFmt.format(toDate(d));
}

/** "09:30" theo giờ Việt Nam. */
export function formatTimeVN(d: DateInput): string {
  return timeFmt.format(toDate(d));
}

/** 12000000 -> "12.000.000" (không kèm "đ" để câu gọi tự thêm đơn vị). */
export function formatVnd(amount: number): string {
  return vndFmt.format(amount);
}

/** Khoá ngày "YYYY-MM-DD" theo giờ Việt Nam — dùng để gom số liệu theo ngày. */
export function vnDayKey(d: DateInput, timeZone = BUSINESS_TZ): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(toDate(d));
  return parts; // en-CA cho sẵn dạng YYYY-MM-DD
}

/** Độ lệch (phút) của múi giờ so với UTC tại thời điểm d. */
function tzOffsetMinutes(d: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(d);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return Math.round((asUtc - d.getTime()) / 60000);
}

/** 00:00 giờ Việt Nam của ngày chứa d, trả về dạng Date (UTC tuyệt đối). */
export function startOfVnDay(d: DateInput = new Date(), timeZone = BUSINESS_TZ): Date {
  const date = toDate(d);
  const [y, m, day] = vnDayKey(date, timeZone).split("-").map(Number);
  const guess = new Date(Date.UTC(y, m - 1, day));
  return new Date(guess.getTime() - tzOffsetMinutes(guess, timeZone) * 60000);
}

/** 00:00 giờ Việt Nam ngày mùng 1 của tháng chứa d. */
export function startOfVnMonth(d: DateInput = new Date(), timeZone = BUSINESS_TZ): Date {
  const [y, m] = vnDayKey(toDate(d), timeZone).split("-").map(Number);
  const guess = new Date(Date.UTC(y, m - 1, 1));
  return new Date(guess.getTime() - tzOffsetMinutes(guess, timeZone) * 60000);
}
