import type { Request } from "express";
import { prisma } from "./prisma";
import { normalizeVnPhone, isValidVnPhone } from "./phone";
import { AI_MODELS, aiGate, callAiLogged, parseJsonFromText, type AiGateStatus } from "./ai";
import { MessageDirection } from "../types/enums";

// AI1: tự tách SĐT, tên, nhu cầu, khu vực từ tin khách gửi.
//
// Lớp 1 (luôn chạy, không cần AI): mẫu số điện thoại Việt Nam.
// Lớp 2 (tuỳ chọn): Claude Haiku trả JSON {phone, name, interest, area}, chỉ
// khi AI đã cấu hình, cài đặt bật và KHÁCH ĐÃ ĐỒNG Ý (Nghị định 13/2023).
// Kết quả luôn là GỢI Ý: người bấm "Áp dụng" mới ghi vào hồ sơ.

// Số VN có thể viết cách bằng dấu cách, chấm, gạch: "0912 345 678", "+84.912.345.678".
const PHONE_CANDIDATE = /(?:\+?84|0)(?:[\s.\-]?\d){8,10}/g;

/** Lấy các SĐT Việt Nam hợp lệ trong đoạn văn, đã chuẩn hoá 0xxxxxxxxx, không trùng. */
export function extractVnPhones(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(PHONE_CANDIDATE)) {
    // Không nhận chuỗi số dính liền chữ số khác (mã đơn, số tài khoản).
    const before = m.index! > 0 ? text[m.index! - 1] : "";
    const after = text[m.index! + m[0].length] ?? "";
    if (/\d/.test(before) || /\d/.test(after)) continue;
    const n = normalizeVnPhone(m[0]);
    if (n && isValidVnPhone(n) && !out.includes(n)) out.push(n);
  }
  return out;
}

const KEYWORDS = [
  "tên", "ten", "em là", "chị là", "anh là", "sđt", "sdt", "số", "zalo", "ở", "quận", "huyện", "tỉnh",
  "hà nội", "hcm", "sài gòn", "filler", "botox", "meso", "hifu", "tan mỡ", "tiêm", "bap", "hốc mắt", "combo",
];

/** Tin có chữ số hoặc từ khoá thì mới đáng gọi AI (tiết kiệm, ít dữ liệu ra ngoài). */
export function worthAiExtraction(text: string): boolean {
  const t = text.toLowerCase();
  return /\d/.test(t) || KEYWORDS.some((k) => t.includes(k));
}

export interface ExtractedInfo {
  phone: string | null;
  name: string | null;
  interest: string | null;
  area: string | null;
}

export interface ExtractionResult {
  regex: { phones: string[] };
  ai: { status: AiGateStatus | "SKIPPED" | "ERROR"; data?: ExtractedInfo; message?: string };
  suggestion: ExtractedInfo;
  duplicate: { id: string; code: string; name: string } | null;
  lastMessageId: string | null;
}

const SYSTEM_PROMPT = `Bạn tách thông tin liên hệ từ tin nhắn của khách gửi phòng khám thẩm mỹ nội khoa (tiêm filler, botox, meso, HIFU, tan mỡ...).
Chỉ trả về MỘT đối tượng JSON, không thêm chữ nào khác:
{"phone": string|null, "name": string|null, "interest": string|null, "area": string|null}
- phone: số điện thoại Việt Nam khách để lại, dạng 0xxxxxxxxx.
- name: tên khách tự xưng (không lấy tên nhân viên, không đoán).
- interest: dịch vụ khách quan tâm, ngắn gọn.
- area: khu vực, tỉnh thành hoặc quận khách nói mình ở.
Không có thông tin thì để null. Không suy đoán.`;

function clean(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s ? s.slice(0, max) : null;
}

/**
 * Tách thông tin từ tối đa `limit` tin khách gửi gần nhất của một hội thoại.
 * Không ghi gì vào hồ sơ khách.
 */
export async function extractFromConversation(opts: {
  req?: Request;
  conversationId: string;
  customerId: string | null;
  branchId?: string | null;
  limit?: number;
}): Promise<ExtractionResult> {
  const messages = await prisma.chatMessage.findMany({
    where: { conversationId: opts.conversationId, direction: MessageDirection.IN },
    orderBy: { createdAt: "desc" },
    take: opts.limit ?? 20,
    select: { id: true, content: true },
  });
  const text = messages
    .reverse()
    .map((m) => m.content)
    .filter((c) => c && !c.startsWith("["))
    .join("\n");
  const phones = extractVnPhones(text);

  let ai: ExtractionResult["ai"] = { status: "SKIPPED" };
  if (text && worthAiExtraction(text)) {
    const gate = await aiGate({ customerId: opts.customerId, settingKey: "ai.extractEnabled" });
    ai = { status: gate };
    if (gate === "OK") {
      try {
        const res = await callAiLogged({
          req: opts.req,
          customerId: opts.customerId,
          branchId: opts.branchId,
          purpose: "AI1 tách SĐT, tên, nhu cầu từ tin nhắn",
          request: {
            model: AI_MODELS.CHEAP,
            system: SYSTEM_PROMPT,
            maxTokens: 300,
            messages: [{ role: "user", content: `Tin nhắn của khách:\n${text.slice(-4000)}` }],
          },
        });
        const parsed = parseJsonFromText<Record<string, unknown>>(res.text);
        if (!parsed) {
          ai = { status: "ERROR", message: "AI trả về không đúng định dạng" };
        } else {
          const aiPhone = normalizeVnPhone(clean(parsed.phone, 30));
          ai = {
            status: "OK",
            data: {
              phone: aiPhone && isValidVnPhone(aiPhone) ? aiPhone : null,
              name: clean(parsed.name, 100),
              interest: clean(parsed.interest, 200),
              area: clean(parsed.area, 100),
            },
          };
        }
      } catch {
        ai = { status: "ERROR", message: "Không gọi được AI, thử lại sau" };
      }
    }
  }

  // Mẫu số chạy trước: số tìm thấy bằng regex được ưu tiên hơn số AI đoán.
  const suggestion: ExtractedInfo = {
    phone: phones[0] ?? ai.data?.phone ?? null,
    name: ai.data?.name ?? null,
    interest: ai.data?.interest ?? null,
    area: ai.data?.area ?? null,
  };

  // Trùng SĐT với hồ sơ KHÁC thì báo, không tự gộp.
  let duplicate: ExtractionResult["duplicate"] = null;
  if (suggestion.phone) {
    const dup = await prisma.customer.findFirst({
      where: {
        phoneNormalized: suggestion.phone,
        mergedIntoId: null,
        ...(opts.customerId ? { id: { not: opts.customerId } } : {}),
      },
      select: { id: true, code: true, name: true },
    });
    duplicate = dup;
  }

  return { regex: { phones }, ai, suggestion, duplicate, lastMessageId: messages[messages.length - 1]?.id ?? null };
}
