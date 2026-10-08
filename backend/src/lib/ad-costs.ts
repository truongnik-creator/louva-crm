import { prisma } from "./prisma";
import { parseCsv } from "./spreadsheet";
import { startOfVnDay } from "./datetime";
import { findCampaignByAdName } from "./lead-funnel";
import { normalizeName } from "./text";
import { CostSource } from "../types/enums";

// F15: NHẬP CHI PHÍ QUẢNG CÁO THEO NGÀY từ tệp CSV xuất của Meta Ads Manager và
// TikTok Ads Manager (tiếng Anh hoặc tiếng Việt). Chỉ cần ba cột: tên chiến
// dịch, ngày, số tiền đã chi. Dòng tổng cộng bị bỏ qua. Cùng chiến dịch cùng
// ngày trong một tệp thì cộng lại; nhập lại tệp của cùng ngày thì GHI ĐÈ (không
// cộng dồn hai lần).

export type AdPlatform = "META" | "TIKTOK" | "AUTO";

const HEADERS = {
  campaign: ["campaign name", "tên chiến dịch", "campaign", "chiến dịch"],
  date: ["day", "ngày", "date", "by day", "reporting starts", "bắt đầu báo cáo", "stat time day", "time"],
  amount: [
    "amount spent (vnd)",
    "số tiền đã chi tiêu (vnd)",
    "amount spent",
    "số tiền đã chi tiêu",
    "cost",
    "total cost",
    "chi phí",
    "spend",
  ],
};

function findColumn(headers: string[], names: string[]): number {
  const norm = headers.map((h) => h.trim().toLowerCase());
  for (const n of names) {
    const i = norm.indexOf(n);
    if (i >= 0) return i;
  }
  for (const n of names) {
    const i = norm.findIndex((h) => h.startsWith(n));
    if (i >= 0) return i;
  }
  return -1;
}

/** "2026-09-15", "2026/09/15", "15/09/2026" -> "2026-09-15"; sai thì null. */
export function parseCostDate(raw: string): string | null {
  const s = raw.trim();
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  return null;
}

/** "1,234,567" | "1.234.567" | "1234567.40" | "1.234.567,5 ₫" -> số đồng làm tròn. */
export function parseCostAmount(raw: string): number | null {
  let s = raw.replace(/[^\d.,-]/g, "");
  if (!s) return null;
  const lastDot = s.lastIndexOf(".");
  const lastComma = s.lastIndexOf(",");
  const decimalSep = (() => {
    if (lastDot >= 0 && lastComma >= 0) return lastDot > lastComma ? "." : ",";
    const sep = lastDot >= 0 ? "." : lastComma >= 0 ? "," : null;
    if (!sep) return null;
    // Một dấu phân cách duy nhất có đúng 3 chữ số phía sau: coi là dấu nghìn.
    const parts = s.split(sep);
    return parts.length === 2 && parts[1].length !== 3 ? sep : null;
  })();
  if (decimalSep) {
    const thousand = decimalSep === "." ? "," : ".";
    s = s.split(thousand).join("").replace(decimalSep, ".");
  } else {
    s = s.replace(/[.,]/g, "");
  }
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n) : null;
}

export interface ParsedCostRow {
  line: number;
  campaignName: string;
  date: string;
  amount: number;
}

export interface ParseResult {
  platform: "META" | "TIKTOK" | "OTHER";
  rows: ParsedCostRow[];
  errors: Array<{ line: number; message: string }>;
}

export function parseAdCostCsv(text: string, platform: AdPlatform = "AUTO"): ParseResult {
  const table = parseCsv(text).filter((r) => r.some((c) => c.trim() !== ""));
  if (!table.length) return { platform: "OTHER", rows: [], errors: [{ line: 1, message: "Tệp trống" }] };
  const headers = table[0];
  const ci = findColumn(headers, HEADERS.campaign);
  const di = findColumn(headers, HEADERS.date);
  const ai = findColumn(headers, HEADERS.amount);
  const missing = [ci < 0 && "tên chiến dịch", di < 0 && "ngày", ai < 0 && "số tiền đã chi"].filter(Boolean);
  const detected: ParseResult["platform"] =
    platform === "META" || platform === "TIKTOK"
      ? platform
      : headers.some((h) => /amount spent|số tiền đã chi tiêu/i.test(h))
        ? "META"
        : headers.some((h) => /^\s*(total )?cost\s*$/i.test(h))
          ? "TIKTOK"
          : "OTHER";
  if (missing.length) return { platform: detected, rows: [], errors: [{ line: 1, message: `Thiếu cột: ${missing.join(", ")}` }] };

  const rows: ParsedCostRow[] = [];
  const errors: ParseResult["errors"] = [];
  table.slice(1).forEach((r, idx) => {
    const line = idx + 2;
    const name = (r[ci] ?? "").trim();
    if (!name || /^(total|tổng|tổng cộng|results?)\b/i.test(name)) return;
    const date = parseCostDate(r[di] ?? "");
    const amount = parseCostAmount(r[ai] ?? "");
    if (!date) return void errors.push({ line, message: `Ngày không đọc được: "${r[di] ?? ""}"` });
    if (amount === null || amount < 0) return void errors.push({ line, message: `Số tiền không đọc được: "${r[ai] ?? ""}"` });
    rows.push({ line, campaignName: name, date, amount });
  });
  return { platform: detected, rows, errors };
}

function slugCode(name: string): string {
  return (
    normalizeName(name)
      ?.replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .toUpperCase()
      .slice(0, 40) || "CHIEN-DICH"
  );
}

export interface ImportResult {
  platform: string;
  imported: number;
  createdCampaigns: string[];
  unknownCampaigns: string[];
  errors: Array<{ line: number; message: string }>;
}

/** Ghi chi phí đã đọc vào CampaignCost. createMissing = tự tạo chiến dịch chưa có. */
export async function importAdCosts(opts: {
  text: string;
  platform?: AdPlatform;
  createMissing?: boolean;
  branchId?: string | null;
}): Promise<ImportResult> {
  const parsed = parseAdCostCsv(opts.text, opts.platform ?? "AUTO");
  const source = parsed.platform === "META" ? CostSource.CSV_META : parsed.platform === "TIKTOK" ? CostSource.CSV_TIKTOK : CostSource.CSV_OTHER;
  const channelKey = parsed.platform === "META" ? "facebook" : parsed.platform === "TIKTOK" ? "tiktok" : null;
  const channel = channelKey ? await prisma.channel.findUnique({ where: { key: channelKey }, select: { id: true } }) : null;

  const grouped = new Map<string, { name: string; date: string; amount: number }>();
  for (const r of parsed.rows) {
    const k = `${r.campaignName.toLowerCase()}|${r.date}`;
    const g = grouped.get(k) ?? { name: r.campaignName, date: r.date, amount: 0 };
    g.amount += r.amount;
    grouped.set(k, g);
  }

  const campaignIds = new Map<string, string | null>();
  const created: string[] = [];
  const unknown: string[] = [];
  let imported = 0;
  for (const g of grouped.values()) {
    const key = g.name.toLowerCase();
    if (!campaignIds.has(key)) {
      let found = await findCampaignByAdName(g.name);
      if (!found && opts.createMissing) {
        let code = slugCode(g.name);
        if (await prisma.campaign.findUnique({ where: { code } })) code = `${code}-${Date.now().toString(36).toUpperCase()}`;
        const c = await prisma.campaign.create({
          data: { code, name: g.name, utmCampaign: g.name, channelId: channel?.id ?? null, branchId: opts.branchId ?? null },
        });
        found = { id: c.id, channelId: c.channelId };
        created.push(g.name);
      }
      if (!found) unknown.push(g.name);
      campaignIds.set(key, found?.id ?? null);
    }
    const campaignId = campaignIds.get(key);
    if (!campaignId) continue;
    const date = startOfVnDay(new Date(`${g.date}T12:00:00+07:00`));
    await prisma.campaignCost.upsert({
      where: { campaignId_date: { campaignId, date } },
      create: { campaignId, date, amount: g.amount, source },
      update: { amount: g.amount, source },
    });
    imported++;
  }
  return { platform: parsed.platform, imported, createdCampaigns: created, unknownCampaigns: unknown, errors: parsed.errors };
}
