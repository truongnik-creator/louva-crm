import { monthFromTabName, parseSpreadsheetId } from "../lib/work-report";
import { logger } from "../lib/logger";

// F36 · CHẾ ĐỘ KÉO (PULL) — chỉ dùng được khi trang tính chia sẻ "bất kỳ ai có
// liên kết đều xem được".
//
// Trang tính ẨN thì KHÔNG đọc được bằng cách này, và đó là trường hợp mặc định
// của phòng khám: báo cáo nhân sự không nên công khai. Vì vậy đường chính là
// chế độ ĐẨY — Apps Script chạy bằng quyền của chính chủ trang tính, POST dữ
// liệu về /api/work-reports/ingest (xem lib/work-report-appsscript.ts).
//
// Chế độ kéo giữ lại vì nó đáng giá cho hai việc: xem thử trang tính MẪU trước
// khi phát cho nhân viên, và cứu những trang tính đã cố tình để công khai.
//
// Hai endpoint công khai của Google được dùng:
//   · /htmlview                      -> danh sách sheet (tên + gid)
//   · /gviz/tq?tqx=out:csv&headers=0 -> toàn bộ ô của một sheet, dạng CSV thô
//
// Cả hai KHÔNG phải API có hợp đồng ổn định. Mọi lỗi phân tích được bọc lại
// thành WorksheetError với lời nhắc chuyển sang chế độ đẩy.

export class WorksheetError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown
  ) {
    super(message);
  }
}

const PRIVATE_HINT =
  "Trang tính không đọc được bằng liên kết công khai. Hãy dùng chế độ ĐẨY: mở trang tính › Tiện ích mở rộng › Apps Script, dán đoạn mã CRM cấp rồi chạy setup().";

const FETCH_TIMEOUT_MS = 20_000;

async function fetchText(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: { "User-Agent": "Louva-CRM/1.0 (+work-report-sync)" },
    });
    const body = await res.text();
    if (!res.ok) throw new WorksheetError(`Google trả về HTTP ${res.status}. ${PRIVATE_HINT}`);
    // Trang tính ẩn trả về trang đăng nhập (HTTP 200) chứ không phải lỗi.
    if (/<title>[^<]*(Sign in|Đăng nhập)/i.test(body) || body.includes("ServiceLogin")) {
      throw new WorksheetError(PRIVATE_HINT);
    }
    return body;
  } catch (err) {
    if (err instanceof WorksheetError) throw err;
    if ((err as Error)?.name === "AbortError") {
      throw new WorksheetError("Hết thời gian chờ khi đọc trang tính (20 giây).", err);
    }
    throw new WorksheetError(`Không đọc được trang tính: ${(err as Error)?.message ?? err}`, err);
  } finally {
    clearTimeout(timer);
  }
}

export interface WorksheetTab {
  gid: string;
  name: string;
  month: number | null;
}

export interface WorksheetInfo {
  spreadsheetId: string;
  title: string | null;
  tabs: WorksheetTab[];
}

/**
 * Liệt kê sheet của trang tính công khai. /htmlview nhúng danh sách sheet dưới
 * dạng lời gọi JS `items.push({name: "T1", ..., gid: "959368949"})`.
 */
export async function listPublicTabs(urlOrId: string): Promise<WorksheetInfo> {
  const spreadsheetId = parseSpreadsheetId(urlOrId);
  if (!spreadsheetId) throw new WorksheetError("Liên kết không phải trang tính Google hợp lệ.");

  const html = await fetchText(`https://docs.google.com/spreadsheets/d/${spreadsheetId}/htmlview`);

  const tabs: WorksheetTab[] = [];
  const seen = new Set<string>();
  const re = /items\.push\(\{\s*name:\s*"((?:[^"\\]|\\.)*)"[\s\S]{0,400}?gid:\s*"(\d+)"/g;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    const name = m[1].replace(/\\x([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))).replace(/\\(.)/g, "$1");
    const gid = m[2];
    if (seen.has(gid)) continue;
    seen.add(gid);
    tabs.push({ gid, name, month: monthFromTabName(name) });
  }

  if (!tabs.length) throw new WorksheetError(`Không tìm thấy sheet nào trong trang tính. ${PRIVATE_HINT}`);

  const titleMatch = html.match(/<title>([^<]*)<\/title>/);
  const title = titleMatch ? titleMatch[1].replace(/ - Google (Drive|Sheets|Trang tính).*$/, "").trim() || null : null;

  return { spreadsheetId, title, tabs };
}

/** Tách một dòng CSV theo RFC 4180 (ô có dấu phẩy, xuống dòng, nháy kép lồng). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (ch !== "\r") cell += ch;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

/**
 * Đọc toàn bộ ô của một sheet công khai. `headers=0` để Google KHÔNG tự đoán
 * dòng tiêu đề — mẫu có hai dòng tiêu đề nên để Google đoán là mất dòng.
 *
 * Hạn chế đã biết: CSV chỉ trả CHỮ HIỆN RA của ô, nên ô "Link hoàn thành" về
 * đến đây chỉ còn chữ "Link", mất URL. Chế độ đẩy không mất (Apps Script đọc
 * được getRichTextValues).
 */
export async function fetchPublicSheet(spreadsheetId: string, gid: string): Promise<string[][]> {
  const url =
    `https://docs.google.com/spreadsheets/d/${spreadsheetId}/gviz/tq` +
    `?tqx=out:csv&headers=0&gid=${encodeURIComponent(gid)}`;
  const csv = await fetchText(url);
  if (csv.trimStart().startsWith("<")) throw new WorksheetError(PRIVATE_HINT);
  return parseCsv(csv);
}

/** Thử đọc nhanh một trang tính để xem thử trước khi gắn cho nhân viên. */
export async function previewPublicWorksheet(
  urlOrId: string,
  opts: { maxRows?: number } = {}
): Promise<WorksheetInfo & { sample: { gid: string; name: string; rows: string[][] } | null }> {
  const info = await listPublicTabs(urlOrId);
  const monthly = info.tabs.filter((t) => t.month !== null);
  const target = monthly[0] ?? info.tabs[0] ?? null;
  if (!target) return { ...info, sample: null };

  try {
    const rows = await fetchPublicSheet(info.spreadsheetId, target.gid);
    return { ...info, sample: { gid: target.gid, name: target.name, rows: rows.slice(0, opts.maxRows ?? 40) } };
  } catch (err) {
    logger.warn({ err, spreadsheetId: info.spreadsheetId }, "[work-report] xem thử sheet thất bại");
    return { ...info, sample: null };
  }
}
