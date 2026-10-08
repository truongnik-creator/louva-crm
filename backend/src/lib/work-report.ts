import { startOfVnDay, vnDayKey } from "./datetime";
import { WorkPostRating, WorkTaskStatus } from "../types/enums";

// F36: ĐỌC MỘT SHEET THÁNG trong trang tính báo cáo công việc.
//
// Mẫu trang tính (xem docs/BAO-CAO-CONG-VIEC-TRANG-TINH.md):
//
//   A: 🕒Time            01/01/2026     <- gộp ô, chỉ điền ở dòng đầu mỗi ngày
//   B: (thứ)             Thứ 5
//   C: 🟠Kênh triển khai TikTok | Fanpage | Khác | NGHỈ
//   D: 🔴Tên công việc   Dựng clip tư vấn...
//   E: ▶️Tiến độ          Hoàn thành
//   F: 🔄️Trạng thái      Hoàn thành
//   G: 📶Đánh giá bài đăng Chưa tốt | Trung bình | Tốt | Xuất sắc
//   H: ✅Link hoàn thành  (ô có siêu liên kết, chữ hiện ra là "Link")
//   I: 🆙Take Note
//   J: Tổng Kết
//   K: Công/ngày         24             <- số công tích luỹ, chỉ ở dòng đầu ngày
//
// Hai điều khiến không thể đọc theo chỉ số cột cứng:
//   1. Mỗi nhân viên có thể thêm/bớt cột — nên cột được DÒ THEO TIÊU ĐỀ, chỉ
//      rơi về vị trí mặc định khi không dò ra.
//   2. Tiêu đề nằm trên HAI dòng (dòng 1 "🔰Tên đầu việc", dòng 2 "🟠Kênh triển
//      khai") nên phải ghép các dòng tiêu đề lại rồi mới dò.

/** Bỏ dấu, bỏ emoji, gom khoảng trắng — để so khớp tiêu đề và giá trị người gõ tay. */
export function norm(value: unknown): string {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/gi, "d")
    .toLowerCase()
    .replace(/[^a-z0-9/]+/g, " ")
    .trim();
}

/** Trích ID trang tính từ URL hoặc trả lại chính nó nếu đã là ID. */
export function parseSpreadsheetId(input: string): string | null {
  const s = input.trim();
  if (!s) return null;
  const m = s.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]{20,})/);
  if (m) return m[1];
  return /^[a-zA-Z0-9-_]{20,}$/.test(s) ? s : null;
}

export function spreadsheetUrl(spreadsheetId: string, gid?: string | null): string {
  const base = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`;
  return gid ? `${base}#gid=${gid}` : base;
}

/**
 * "T1".."T12" -> 1..12. Nhận cả "Tháng 1", "T 01", "01". Sheet phụ như
 * "Quy trình Media" trả null và được bỏ qua khi đồng bộ.
 */
export function monthFromTabName(name: string): number | null {
  const n = norm(name);
  const m = n.match(/^(?:t|thang)\s*(\d{1,2})$/) ?? n.match(/^(\d{1,2})$/);
  if (!m) return null;
  const month = Number(m[1]);
  return month >= 1 && month <= 12 ? month : null;
}

export type WorkReportColumn =
  | "date"
  | "weekday"
  | "channel"
  | "task"
  | "progress"
  | "status"
  | "rating"
  | "link"
  | "note"
  | "summary"
  | "dayCredit";

export type ColumnMap = Partial<Record<WorkReportColumn, number>>;

/** Dò theo thứ tự này: mục nào khớp trước giữ cột đó, nên mẫu hẹp phải đứng trước. */
const HEADER_PATTERNS: Array<[WorkReportColumn, string[]]> = [
  ["dayCredit", ["cong/ngay", "cong ngay", "so cong"]],
  ["channel", ["kenh trien khai", "kenh"]],
  ["task", ["ten cong viec", "ten dau viec", "noi dung cong viec", "cong viec"]],
  ["progress", ["tien do"]],
  ["status", ["trang thai"]],
  ["rating", ["danh gia bai dang", "danh gia"]],
  ["link", ["link hoan thanh", "link ket qua", "link"]],
  ["note", ["take note", "ghi chu", "luu y"]],
  ["summary", ["tong ket", "tong hop"]],
  ["date", ["time", "ngay", "thoi gian"]],
];

const DEFAULT_COLUMNS: ColumnMap = {
  date: 0,
  weekday: 1,
  channel: 2,
  task: 3,
  progress: 4,
  status: 5,
  rating: 6,
  link: 7,
  note: 8,
  summary: 9,
  dayCredit: 10,
};

export interface HeaderInfo {
  /** Số dòng đầu là tiêu đề, cần bỏ qua. */
  headerRows: number;
  columns: ColumnMap;
  /** true khi không dò ra tiêu đề và đã rơi về vị trí cột mặc định. */
  fallback: boolean;
}

/**
 * Dò khối tiêu đề trong tối đa 6 dòng đầu. Khối tiêu đề kết thúc ở dòng cuối
 * cùng còn chứa từ khoá tiêu đề; mọi dòng tiêu đề được ghép theo cột trước khi
 * so khớp (vì "Kênh triển khai" nằm dòng dưới "Tên đầu việc").
 */
export function detectHeader(rows: string[][]): HeaderInfo {
  const scan = rows.slice(0, 6);
  let lastHeaderRow = -1;
  for (let r = 0; r < scan.length; r++) {
    const joined = norm(scan[r].join(" "));
    if (/tien do|trang thai|cong viec|kenh trien khai|take note/.test(joined)) lastHeaderRow = r;
  }
  if (lastHeaderRow < 0) return { headerRows: 0, columns: { ...DEFAULT_COLUMNS }, fallback: true };

  const width = Math.max(...scan.slice(0, lastHeaderRow + 1).map((r) => r.length), 0);
  const merged: string[] = [];
  for (let c = 0; c < width; c++) {
    merged[c] = norm(
      scan
        .slice(0, lastHeaderRow + 1)
        .map((r) => r[c] ?? "")
        .join(" ")
    );
  }

  const columns: ColumnMap = {};
  const taken = new Set<number>();
  for (const [key, patterns] of HEADER_PATTERNS) {
    for (let c = 0; c < width; c++) {
      if (taken.has(c) || !merged[c]) continue;
      if (patterns.some((p) => merged[c].includes(p))) {
        columns[key] = c;
        taken.add(c);
        break;
      }
    }
  }

  // Cột thứ nằm ngay sau cột ngày và không có tiêu đề riêng.
  if (columns.date !== undefined && columns.weekday === undefined) {
    const next = columns.date + 1;
    if (!taken.has(next)) columns.weekday = next;
  }

  // Thiếu cột việc thì coi như dò thất bại — thà dùng vị trí mặc định còn hơn
  // nhận bừa một cột khác làm tên công việc.
  if (columns.task === undefined) return { headerRows: lastHeaderRow + 1, columns: { ...DEFAULT_COLUMNS }, fallback: true };

  return { headerRows: lastHeaderRow + 1, columns, fallback: false };
}

/** "01/01/2026", "1/1/2026", "2026-01-01" -> 00:00 giờ Việt Nam. */
export function parseWorkDate(value: string, fallbackYear?: number, fallbackMonth?: number): Date | null {
  const s = String(value ?? "").trim();
  if (!s) return null;

  const dmy = s.match(/^(\d{1,2})[/\-.](\d{1,2})(?:[/\-.](\d{2,4}))?$/);
  if (dmy) {
    const day = Number(dmy[1]);
    const month = Number(dmy[2]);
    let year = dmy[3] ? Number(dmy[3]) : (fallbackYear ?? new Date().getFullYear());
    if (year < 100) year += 2000;
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    // Giữa trưa UTC rồi quy về 00:00 giờ VN — tránh lệch ngày do múi giờ.
    return startOfVnDay(new Date(Date.UTC(year, month - 1, day, 12)));
  }

  const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) return startOfVnDay(new Date(Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]), 12)));

  // Ô chỉ ghi số ngày ("15") trong sheet đã biết tháng.
  const dayOnly = s.match(/^(\d{1,2})$/);
  if (dayOnly && fallbackYear && fallbackMonth) {
    const day = Number(dayOnly[1]);
    if (day >= 1 && day <= 31) return startOfVnDay(new Date(Date.UTC(fallbackYear, fallbackMonth - 1, day, 12)));
  }

  const parsed = new Date(s);
  return Number.isNaN(parsed.getTime()) ? null : startOfVnDay(parsed);
}

/** Chuẩn hoá cột Tiến độ / Trạng thái người gõ tay về WorkTaskStatus. */
export function normalizeStatus(progress: string, status: string, channel: string): WorkTaskStatus {
  const text = norm(`${progress} ${status}`);
  const chan = norm(channel);

  if (/^nghi|ngay nghi|off/.test(chan) || /^nghi/.test(text)) return WorkTaskStatus.DAY_OFF;
  if (!text) return WorkTaskStatus.UNKNOWN;
  if (/huy|khong lam|bo qua|cancel/.test(text)) return WorkTaskStatus.CANCELLED;
  if (/tre|qua han|cham deadline|muon|late/.test(text)) return WorkTaskStatus.LATE;
  if (/hoan thanh|xong|done|da dang|da xong/.test(text)) return WorkTaskStatus.DONE;
  if (/dang lam|dang thuc hien|dang xu ly|doing|in progress|dang dung|dang quay/.test(text)) {
    return WorkTaskStatus.IN_PROGRESS;
  }
  if (/chua lam|chua bat dau|chua|moi|pending|to do|todo/.test(text)) return WorkTaskStatus.PENDING;
  return WorkTaskStatus.UNKNOWN;
}

/** Chuẩn hoá cột Đánh giá bài đăng về bậc view. "Xuất sắc" phải xét trước "Tốt". */
export function normalizeRating(value: string): WorkPostRating | null {
  const text = norm(value);
  if (!text) return null;
  if (/xuat sac|excellent/.test(text)) return WorkPostRating.EXCELLENT;
  if (/chua tot|kem|bad/.test(text)) return WorkPostRating.BAD;
  if (/trung binh|tam|average/.test(text)) return WorkPostRating.AVERAGE;
  if (/tot|good/.test(text)) return WorkPostRating.GOOD;
  return null;
}

function parseNumber(value: string): number | null {
  const s = String(value ?? "").trim().replace(/\s/g, "").replace(/,/g, ".");
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function clean(value: unknown): string {
  return String(value ?? "").replace(/ /g, " ").trim();
}

export interface ParsedWorkEntry {
  rowIndex: number;
  workDate: Date | null;
  dayKey: string | null;
  weekday: string | null;
  channel: string | null;
  taskName: string | null;
  progress: string | null;
  status: string | null;
  rating: string | null;
  linkText: string | null;
  linkUrl: string | null;
  note: string | null;
  summary: string | null;
  dayCredit: number | null;
  statusCode: WorkTaskStatus;
  ratingCode: WorkPostRating | null;
  isDayOff: boolean;
  raw: string;
}

export interface ParseSheetInput {
  /** Giá trị hiển thị của sheet, mảng 2 chiều theo dòng. */
  rows: string[][];
  /** URL siêu liên kết song song với `rows` (Apps Script đọc bằng getRichTextValues). */
  linkRows?: string[][];
  year: number;
  month: number;
  /** Bỏ qua dò tiêu đề và dùng đúng số dòng tiêu đề này. */
  headerRows?: number;
  /** Dòng đầu tiên của `rows` tương ứng dòng số mấy trong sheet (1-based). */
  startRow?: number;
}

export interface ParseSheetResult {
  entries: ParsedWorkEntry[];
  headerRows: number;
  columns: ColumnMap;
  /** true khi phải dùng vị trí cột mặc định — nên cảnh báo trên giao diện. */
  fallbackColumns: boolean;
  /** Số dòng có nội dung nhưng không gán được ngày (ô ngày trống từ đầu sheet). */
  rowsWithoutDate: number;
}

/**
 * Phân tích một sheet tháng thành danh sách dòng việc.
 *
 * Ô ngày và ô "Công/ngày" trong mẫu là ô GỘP: trang tính trả về giá trị ở dòng
 * đầu và để trống các dòng sau. Vì vậy ngày được ĐIỀN XUÔI xuống các dòng việc
 * tiếp theo, còn "Công/ngày" thì KHÔNG (nó là số công của cả ngày, nhân lên
 * từng dòng sẽ đếm sai).
 */
export function parseSheet(input: ParseSheetInput): ParseSheetResult {
  const { rows, linkRows, year, month, startRow = 1 } = input;
  const header = detectHeader(rows);
  const headerRows = input.headerRows ?? header.headerRows;
  const col = header.columns;

  const at = (row: string[], key: WorkReportColumn): string => {
    const idx = col[key];
    return idx === undefined ? "" : clean(row[idx]);
  };

  const entries: ParsedWorkEntry[] = [];
  let carriedDate: Date | null = null;
  let carriedWeekday: string | null = null;
  let rowsWithoutDate = 0;

  for (let r = headerRows; r < rows.length; r++) {
    const row = rows[r] ?? [];
    const rowIndex = startRow + r;

    const rawDate = at(row, "date");
    const parsedDate = parseWorkDate(rawDate, year, month);
    if (parsedDate) carriedDate = parsedDate;
    const weekday = at(row, "weekday");
    if (rawDate) carriedWeekday = weekday || null;
    else if (weekday) carriedWeekday = weekday;

    const channel = at(row, "channel");
    const taskName = at(row, "task");
    const progress = at(row, "progress");
    const status = at(row, "status");
    const rating = at(row, "rating");
    const linkText = at(row, "link");
    const note = at(row, "note");
    const summary = at(row, "summary");
    const dayCredit = rawDate ? parseNumber(at(row, "dayCredit")) : null;

    const hasContent = Boolean(channel || taskName || progress || status || rating || linkText || note || summary);
    // Dòng trắng hoàn toàn (không ngày, không nội dung) là dòng kẻ sẵn của mẫu.
    if (!hasContent && !rawDate) continue;

    const linkIdx = col.link;
    const linkUrl =
      linkIdx !== undefined && linkRows?.[r]?.[linkIdx] ? clean(linkRows[r][linkIdx]) || null : null;

    const statusCode = hasContent
      ? normalizeStatus(progress, status, channel)
      : // Có ngày nhưng chưa ghi gì: Chủ nhật của mẫu để trắng (ngày nghỉ tuần),
        // còn ngày thường để trắng nghĩa là CHƯA ĐIỀN BÁO CÁO — phải phân biệt.
        /^(cn|chu nhat|sunday)$/.test(norm(weekday))
        ? WorkTaskStatus.DAY_OFF
        : WorkTaskStatus.PENDING;

    const workDate = parsedDate ?? carriedDate;
    if (!workDate) rowsWithoutDate++;

    entries.push({
      rowIndex,
      workDate,
      dayKey: workDate ? vnDayKey(workDate) : null,
      weekday: (rawDate ? weekday : carriedWeekday) || null,
      channel: channel || null,
      taskName: taskName || null,
      progress: progress || null,
      status: status || null,
      rating: rating || null,
      linkText: linkText || null,
      linkUrl,
      note: note || null,
      summary: summary || null,
      dayCredit,
      statusCode,
      ratingCode: normalizeRating(rating),
      isDayOff: statusCode === WorkTaskStatus.DAY_OFF,
      raw: JSON.stringify(row.map(clean)),
    });
  }

  return {
    entries,
    headerRows,
    columns: col,
    fallbackColumns: header.fallback,
    rowsWithoutDate,
  };
}
