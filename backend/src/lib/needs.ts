import type { Request } from "express";
import { z } from "zod";
import { prisma } from "./prisma";
import { getSettingList } from "./settings-catalog";
import { AI_MODELS, aiGate, callAiLogged, parseJsonFromText, type AiGateStatus } from "./ai";
import { FaceArea, MessageDirection } from "../types/enums";

// Lô 8 · C3: HỒ SƠ NHU CẦU CHỌN NHANH.
//
// Sáu ô bấm chọn: vùng muốn làm, ngân sách, nỗi sợ, người quyết định, dịp, nơi
// đang so sánh. Danh sách lựa chọn (trừ vùng mặt) là tham số Cài đặt. AI1 gợi ý
// điền từ tin khách nhắn (chỉ khi AI bật và khách đã đồng ý xử lý dữ liệu bằng
// AI); gợi ý không bao giờ tự ghi, người bấm "Áp dụng" mới lưu.

export const AREA_LABEL: Record<string, string> = {
  TRAN: "Trán",
  THAI_DUONG: "Thái dương",
  HOC_MAT: "Hốc mắt",
  MUI: "Mũi",
  MA: "Má",
  RANH_MUI_MA: "Rãnh mũi má",
  MOI: "Môi",
  CAM: "Cằm",
  HAM: "Hàm",
  NONG_CAM: "Nọng cằm",
  CO: "Cổ",
  TOAN_MAT: "Toàn mặt",
};

export interface NeedsOptions {
  areas: Array<{ key: string; label: string }>;
  budgets: string[];
  fears: string[];
  decisionMakers: string[];
  occasions: string[];
}

export async function loadNeedsOptions(): Promise<NeedsOptions> {
  return {
    areas: Object.values(FaceArea).map((k) => ({ key: k, label: AREA_LABEL[k] ?? k })),
    budgets: await getSettingList("needs.budgetOptions"),
    fears: await getSettingList("needs.fearOptions"),
    decisionMakers: await getSettingList("needs.decisionMakerOptions"),
    occasions: await getSettingList("needs.occasionOptions"),
  };
}

export const needsSchema = z.object({
  areas: z.array(z.nativeEnum(FaceArea)).max(12).default([]),
  budget: z.string().trim().max(60).nullable().default(null),
  fears: z.array(z.string().trim().max(60)).max(10).default([]),
  decisionMaker: z.string().trim().max(60).nullable().default(null),
  occasion: z.string().trim().max(60).nullable().default(null),
  occasionDate: z.string().trim().max(20).nullable().default(null),
  comparing: z.array(z.string().trim().min(1).max(80)).max(10).default([]),
  // Chuỗi rỗng (xoá ghi chú trên giao diện) lưu là null.
  note: z
    .string()
    .trim()
    .max(500)
    .nullable()
    .default(null)
    .transform((v) => v || null),
});
export type NeedsProfile = z.infer<typeof needsSchema>;

export const EMPTY_NEEDS: NeedsProfile = needsSchema.parse({});

export function parseNeeds(raw: string | null | undefined): NeedsProfile & { updatedAt?: string; updatedBy?: string } {
  if (!raw) return { ...EMPTY_NEEDS };
  try {
    const v = JSON.parse(raw);
    return { ...needsSchema.parse(v), updatedAt: v.updatedAt, updatedBy: v.updatedBy };
  } catch {
    return { ...EMPTY_NEEDS };
  }
}

/** Lựa chọn phải nằm trong danh sách tham số (nơi so sánh, ghi chú là chữ tự do). */
export function assertNeedsInOptions(n: NeedsProfile, o: NeedsOptions): string | null {
  if (n.budget && !o.budgets.includes(n.budget)) return `Ngân sách "${n.budget}" không có trong danh sách`;
  const badFear = n.fears.find((f) => !o.fears.includes(f));
  if (badFear) return `Nỗi sợ "${badFear}" không có trong danh sách`;
  if (n.decisionMaker && !o.decisionMakers.includes(n.decisionMaker)) return `Người quyết định "${n.decisionMaker}" không có trong danh sách`;
  if (n.occasion && !o.occasions.includes(n.occasion)) return `Dịp "${n.occasion}" không có trong danh sách`;
  return null;
}

/** Giữ lại phần gợi ý AI khớp danh sách lựa chọn, bỏ phần đoán ngoài danh sách. */
export function sanitizeSuggestion(raw: Record<string, unknown>, o: NeedsOptions): Partial<NeedsProfile> {
  const pickOne = (v: unknown, list: string[]) => (typeof v === "string" && list.includes(v.trim()) ? v.trim() : null);
  const pickMany = (v: unknown, list: string[]) =>
    Array.isArray(v) ? [...new Set(v.map((x) => String(x).trim()).filter((x) => list.includes(x)))] : [];
  const areaKeys = o.areas.map((a) => a.key);
  const out: Partial<NeedsProfile> = {};
  const areas = pickMany(raw.areas, areaKeys) as NeedsProfile["areas"];
  if (areas.length) out.areas = areas;
  const budget = pickOne(raw.budget, o.budgets);
  if (budget) out.budget = budget;
  const fears = pickMany(raw.fears, o.fears);
  if (fears.length) out.fears = fears;
  const dm = pickOne(raw.decisionMaker, o.decisionMakers);
  if (dm) out.decisionMaker = dm;
  const occ = pickOne(raw.occasion, o.occasions);
  if (occ) out.occasion = occ;
  if (Array.isArray(raw.comparing)) {
    const comp = raw.comparing.map((x) => String(x).trim().slice(0, 80)).filter(Boolean).slice(0, 5);
    if (comp.length) out.comparing = comp;
  }
  return out;
}

export async function suggestNeeds(opts: { req: Request; customerId: string; branchId?: string | null }): Promise<{
  status: AiGateStatus | "NO_MESSAGES" | "ERROR";
  suggestion: Partial<NeedsProfile>;
  message?: string;
}> {
  const gate = await aiGate({ customerId: opts.customerId, settingKey: "ai.extractEnabled" });
  if (gate !== "OK") return { status: gate, suggestion: {} };
  const messages = await prisma.chatMessage.findMany({
    where: { conversation: { customerId: opts.customerId }, direction: MessageDirection.IN },
    orderBy: { createdAt: "desc" },
    take: 40,
    select: { content: true },
  });
  const text = messages
    .reverse()
    .map((m) => m.content)
    .filter((c) => c && !c.startsWith("["))
    .join("\n");
  if (!text.trim()) return { status: "NO_MESSAGES", suggestion: {} };
  const o = await loadNeedsOptions();
  const system = `Bạn đọc tin nhắn khách gửi phòng khám thẩm mỹ nội khoa (tiêm filler, botox, meso, HIFU, tan mỡ) và điền hồ sơ nhu cầu.
Chỉ trả về MỘT đối tượng JSON, không thêm chữ nào khác. CHỈ chọn đúng nguyên văn trong danh sách, không có thông tin thì để null hoặc [].
{"areas": string[] (mã trong: ${o.areas.map((a) => `${a.key}=${a.label}`).join(", ")}),
 "budget": string|null (một trong: ${o.budgets.join(" | ")}),
 "fears": string[] (trong: ${o.fears.join(" | ")}),
 "decisionMaker": string|null (một trong: ${o.decisionMakers.join(" | ")}),
 "occasion": string|null (một trong: ${o.occasions.join(" | ")}),
 "comparing": string[] (tên nơi khác khách nói đang so sánh, nguyên văn)}
Không suy đoán.`;
  try {
    const res = await callAiLogged({
      req: opts.req,
      customerId: opts.customerId,
      branchId: opts.branchId,
      purpose: "AI1 gợi ý hồ sơ nhu cầu từ tin nhắn",
      request: { model: AI_MODELS.CHEAP, system, maxTokens: 400, messages: [{ role: "user", content: `Tin nhắn của khách:\n${text.slice(-4000)}` }] },
    });
    const parsed = parseJsonFromText<Record<string, unknown>>(res.text);
    if (!parsed) return { status: "ERROR", suggestion: {}, message: "AI trả về không đúng định dạng" };
    return { status: "OK", suggestion: sanitizeSuggestion(parsed, o) };
  } catch {
    return { status: "ERROR", suggestion: {}, message: "Không gọi được AI, thử lại sau" };
  }
}
