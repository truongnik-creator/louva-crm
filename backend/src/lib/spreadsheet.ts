import ExcelJS from "exceljs";

// Đọc bảng tính khách cũ (F4): .xlsx qua exceljs, .csv bằng bộ đọc riêng (nhận
// dấu phẩy, chấm phẩy, tab; ô có ngoặc kép; BOM UTF-8 của Excel).

export interface SheetData {
  headers: string[];
  rows: string[][];
}

export type SheetKind = "xlsx" | "csv";

export function detectSheetKind(fileName: string, buf: Buffer): SheetKind | null {
  const lower = fileName.toLowerCase();
  const isZip = buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b; // "PK": xlsx là tệp zip
  if (lower.endsWith(".xlsx")) return isZip ? "xlsx" : null;
  if (lower.endsWith(".csv") || lower.endsWith(".txt")) return isZip ? null : "csv";
  return null;
}

function detectDelimiter(firstLine: string): string {
  const counts = [",", ";", "\t"].map((d) => ({ d, n: firstLine.split(d).length }));
  counts.sort((a, b) => b.n - a.n);
  return counts[0].n > 1 ? counts[0].d : ",";
}

export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, "");
  const firstLine = src.split(/\r?\n/, 1)[0] ?? "";
  const delim = detectDelimiter(firstLine);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"' && cell === "") quoted = true;
    else if (ch === delim) {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

function cellText(v: ExcelJS.CellValue): string {
  if (v == null) return "";
  if (v instanceof Date) {
    // Ô ngày của Excel: trả YYYY-MM-DD (exceljs coi ngày Excel là giờ UTC).
    return v.toISOString().slice(0, 10);
  }
  if (typeof v === "object") {
    if ("text" in v && typeof v.text === "string") return v.text;
    if ("result" in v) return cellText((v as { result?: ExcelJS.CellValue }).result ?? null);
    if ("richText" in v && Array.isArray(v.richText)) return v.richText.map((r) => r.text).join("");
    if ("hyperlink" in v) return String((v as { text?: string }).text ?? "");
    return "";
  }
  return String(v);
}

export async function readSheet(fileName: string, buf: Buffer): Promise<SheetData> {
  const kind = detectSheetKind(fileName, buf);
  if (!kind) throw new Error("Chỉ nhận tệp .xlsx hoặc .csv");
  let matrix: string[][];
  if (kind === "csv") {
    matrix = parseCsv(buf.toString("utf8"));
  } else {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    const ws = wb.worksheets[0];
    if (!ws) throw new Error("Tệp Excel không có trang tính nào");
    matrix = [];
    ws.eachRow({ includeEmpty: false }, (row) => {
      const values: string[] = [];
      for (let c = 1; c <= ws.columnCount; c++) values.push(cellText(row.getCell(c).value).trim());
      matrix.push(values);
    });
  }
  const [head = [], ...rows] = matrix;
  const headers = head.map((h, i) => h.trim() || `Cột ${i + 1}`);
  return { headers, rows: rows.map((r) => headers.map((_, i) => (r[i] ?? "").trim())) };
}

/** Tệp CSV (có BOM để Excel mở đúng tiếng Việt) từ bảng giá trị. */
export function toCsv(rows: string[][]): Buffer {
  const esc = (v: string) => (/[",\n\r;]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return Buffer.from("﻿" + rows.map((r) => r.map((c) => esc(c ?? "")).join(",")).join("\r\n"), "utf8");
}
