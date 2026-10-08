import type { Request } from "express";
import { prisma } from "./prisma";
import { writeAudit } from "./audit";
import { AI_MODELS, aiGate, callAiLogged, parseJsonFromText } from "./ai";
import { findMedicalKeywords, medicalKeywords, redactMedical } from "./medical-keywords";
import { activePromotions, type PromotionRow } from "./pricing";
import { ActivityType, AiSuggestionStatus, AuditAction, MessageDirection, PromotionKind } from "../types/enums";

// AI2: GỢI Ý CÂU TRẢ LỜI THEO KỊCH BẢN, AI3: TÓM TẮT HỘI THOẠI.
//
// Hàng rào hai lớp của AI2:
//   Lớp 1 (trước khi gọi AI, không tốn tiền, không gửi dữ liệu ra ngoài): tin
//   khách gần đây có từ khoá y khoa thì KHÔNG sinh, trả câu đề nghị chuyển bác sĩ.
//   Lớp 2 (sau khi AI viết): kiểm bằng luật (từ khoá y khoa, hứa kết quả, nói
//   giảm giá khi không có đợt ưu đãi) + một lượt AI tự kiểm. Trượt thì không trả
//   câu gợi ý cho sale.
// Mọi gợi ý đều do sale sửa rồi TỰ BẤM GỬI; câu gợi ý và câu thực gửi đều ghi
// AiSuggestion + AuditLog để đối chiếu.

export const TRANSFER_TO_DOCTOR_TEXT =
  "Dạ, câu hỏi này liên quan đến sức khoẻ nên em xin phép chuyển bác sĩ phụ trách tư vấn trực tiếp cho mình để chính xác nhất ạ. Mình chờ em ít phút nhé.";

const SUGGEST_RULES = `Bạn là trợ lý viết câu trả lời cho nhân viên tư vấn (sale) của phòng khám thẩm mỹ nội khoa (tiêm filler, botox, meso, HIFU, tan mỡ...). Nhân viên sẽ đọc, sửa rồi tự gửi cho khách.
Luật bắt buộc:
- Viết đúng giọng và các bước của KỊCH BẢN CHUẨN bên dưới, tiếng Việt, xưng "em", gọi khách theo cách khách đang được gọi trong hội thoại.
- KHÔNG đưa lời khuyên y khoa, chẩn đoán, thuốc, chống chỉ định. Câu hỏi sức khoẻ thì mời khách trao đổi với bác sĩ.
- KHÔNG hứa hẹn kết quả (không "cam kết", "đảm bảo", "100%", "vĩnh viễn", "không đau").
- KHÔNG nói giảm giá, khuyến mãi, quà tặng nào ngoài các đợt ưu đãi đang chạy được liệt kê trong tin nhắn cuối. Không có đợt nào thì không nhắc giảm giá.
- Không bịa giá, địa chỉ, lịch trống. Chưa biết thì hỏi lại khách hoặc hẹn kiểm tra.
- Chỉ trả về đúng nội dung câu trả lời, không giải thích, không đánh dấu.`;

const CHECK_SYSTEM = `Bạn là bộ KIỂM TRA câu trả lời của nhân viên tư vấn phòng khám thẩm mỹ trước khi gửi khách.
Trả về DUY NHẤT một đối tượng JSON: {"ok": boolean, "violations": string[]}
Vi phạm gồm: (1) có lời khuyên y khoa, chẩn đoán, nói về thuốc hay biến chứng; (2) hứa hẹn kết quả; (3) nói giảm giá, khuyến mãi, quà tặng không nằm trong danh sách đợt ưu đãi đang chạy được cung cấp.
Không vi phạm thì {"ok": true, "violations": []}. Mỗi vi phạm ghi ngắn gọn bằng tiếng Việt.`;

const PROMISE_RE =
  /(cam kết|đảm bảo|bảo đảm|100\s*%|vĩnh viễn|trọn đời|chắc chắn (sẽ|hết|đẹp|lên)|không (hề )?đau|không (có )?biến chứng|không sưng|hiệu quả (ngay|tức thì|tuyệt đối))/iu;
const DISCOUNT_RE = /(giảm giá|giảm\s*\d|khuyến mãi|khuyến mại|ưu đãi|chiết khấu|voucher|tặng|miễn phí|free|sale off|\d+\s*%)/iu;

function describePromotion(p: PromotionRow): string {
  const v = p.kind === PromotionKind.PERCENT ? `giảm ${p.value}%` : `giảm ${p.value.toLocaleString("vi-VN")}đ mỗi đơn vị`;
  const slots = p.maxSlots != null ? `, còn ${Math.max(0, p.maxSlots - p.usedSlots)} suất` : "";
  return `${p.name} (${v}${slots}, đến ${p.endAt.toISOString().slice(0, 10)})`;
}

/** Luật cứng của lớp 2 (không cần AI). Trả danh sách vi phạm. */
export function ruleCheckReply(text: string, promos: PromotionRow[], keywords: string[]): string[] {
  const violations: string[] = [];
  const medical = findMedicalKeywords(text, keywords);
  if (medical.length) violations.push(`Có nội dung y khoa (${medical.join(", ")})`);
  if (PROMISE_RE.test(text)) violations.push("Có câu hứa hẹn kết quả");
  if (DISCOUNT_RE.test(text)) {
    if (!promos.length) violations.push("Nhắc giảm giá, khuyến mãi khi không có đợt ưu đãi đang chạy");
    else {
      const allowedPct = new Set(promos.filter((p) => p.kind === PromotionKind.PERCENT).map((p) => p.value));
      for (const m of text.matchAll(/(\d+)\s*%/g)) {
        if (!allowedPct.has(Number(m[1]))) violations.push(`Mức giảm ${m[1]}% không thuộc đợt ưu đãi đang chạy`);
      }
    }
  }
  return violations;
}

async function transcript(conversationId: string, take: number): Promise<{ lines: string[]; recentInbound: string[] }> {
  const rows = await prisma.chatMessage.findMany({
    where: { conversationId },
    orderBy: { createdAt: "desc" },
    take,
    select: { direction: true, content: true },
  });
  rows.reverse();
  const lines = rows
    .filter((m) => m.content && !m.content.startsWith("["))
    .map((m) => `${m.direction === MessageDirection.IN ? "Khách" : "Nhân viên"}: ${m.content}`);
  const recentInbound = rows
    .filter((m) => m.direction === MessageDirection.IN)
    .slice(-3)
    .map((m) => m.content);
  return { lines, recentInbound };
}

export interface SuggestResult {
  id: string;
  status: AiSuggestionStatus;
  suggestion: string | null;
  reason: string | null;
  violations?: string[];
  scriptVersion?: number | null;
}

export async function suggestReply(opts: {
  req: Request;
  conversation: { id: string; customerId: string | null; branchId: string | null };
  user: { id: string; name: string };
}): Promise<SuggestResult> {
  const { conversation: conv, user } = opts;
  const keywords = await medicalKeywords();
  const { lines, recentInbound } = await transcript(conv.id, 30);

  const save = async (data: {
    status: AiSuggestionStatus;
    reason?: string | null;
    suggestion?: string | null;
    scriptId?: string | null;
    model?: string | null;
    checkResult?: unknown;
  }) => {
    const row = await prisma.aiSuggestion.create({
      data: {
        conversationId: conv.id,
        customerId: conv.customerId,
        userId: user.id,
        userName: user.name,
        status: data.status,
        reason: data.reason ?? null,
        suggestion: data.suggestion ?? null,
        scriptId: data.scriptId ?? null,
        model: data.model ?? null,
        checkResult: data.checkResult === undefined ? null : JSON.stringify(data.checkResult),
      },
    });
    await writeAudit({
      req: opts.req,
      action: AuditAction.CREATE,
      entity: "AiSuggestion",
      entityId: row.id,
      branchId: conv.branchId,
      summary: `AI gợi ý trả lời (${data.status}): ${(data.suggestion ?? data.reason ?? "").slice(0, 300)}`,
    });
    return row;
  };

  // LỚP 1: từ khoá y khoa trong tin khách gần đây: không gọi AI.
  const hits = [...new Set(recentInbound.flatMap((t) => findMedicalKeywords(t, keywords)))];
  if (hits.length) {
    const reason = `Khách hỏi vấn đề sức khoẻ (${hits.join(", ")}): chuyển bác sĩ, sale không tư vấn y khoa`;
    const row = await save({ status: AiSuggestionStatus.BLOCKED_MEDICAL, reason, suggestion: TRANSFER_TO_DOCTOR_TEXT });
    return { id: row.id, status: AiSuggestionStatus.BLOCKED_MEDICAL, suggestion: TRANSFER_TO_DOCTOR_TEXT, reason };
  }

  const gate = await aiGate({ customerId: conv.customerId, settingKey: "ai.suggestEnabled" });
  if (gate !== "OK") {
    const reason =
      gate === "NOT_CONFIGURED"
        ? "AI chưa cấu hình trên máy chủ"
        : gate === "DISABLED"
          ? "Gợi ý trả lời đang tắt trong Cài đặt"
          : "Khách chưa đồng ý cho xử lý dữ liệu bằng AI (Nghị định 13/2023)";
    const row = await save({ status: gate as AiSuggestionStatus, reason });
    return { id: row.id, status: gate as AiSuggestionStatus, suggestion: null, reason };
  }
  if (!lines.length) {
    const row = await save({ status: AiSuggestionStatus.ERROR, reason: "Hội thoại chưa có tin nhắn chữ" });
    return { id: row.id, status: AiSuggestionStatus.ERROR, suggestion: null, reason: "Hội thoại chưa có tin nhắn chữ" };
  }

  const script = await prisma.salesScript.findFirst({ where: { key: "default", isActive: true }, orderBy: { version: "desc" } });
  const promos = await activePromotions(conv.branchId);
  const promoText = promos.length
    ? `Đợt ưu đãi đang chạy (chỉ được nhắc các đợt này):\n${promos.map((p) => `- ${describePromotion(p)}`).join("\n")}`
    : "Hiện KHÔNG có đợt ưu đãi nào: không nhắc giảm giá, khuyến mãi, quà tặng.";

  let suggestion: string;
  try {
    const res = await callAiLogged({
      req: opts.req,
      customerId: conv.customerId,
      branchId: conv.branchId,
      purpose: "AI2 gợi ý câu trả lời theo kịch bản",
      request: {
        model: AI_MODELS.SMART,
        maxTokens: 1024,
        // Tiền tố ổn định (luật + kịch bản) đặt trước và gắn cache: các lần gợi ý
        // sau chỉ trả phí phần hội thoại.
        system: [
          { text: SUGGEST_RULES },
          {
            text: script
              ? `KỊCH BẢN CHUẨN (phiên bản ${script.version}: ${script.title}):\n${script.content}`
              : "KỊCH BẢN CHUẨN: chưa có, trả lời lịch sự, ngắn gọn, mời khách để lại SĐT hoặc đặt lịch tư vấn.",
            cache: true,
          },
        ],
        messages: [
          {
            role: "user",
            content: `${promoText}\n\nHội thoại gần nhất:\n${lines.join("\n").slice(-6000)}\n\nViết MỘT câu trả lời tiếp theo để nhân viên gửi khách.`,
          },
        ],
      },
    });
    suggestion = res.text.trim();
  } catch {
    const row = await save({ status: AiSuggestionStatus.ERROR, reason: "Không gọi được AI, thử lại sau", scriptId: script?.id });
    return { id: row.id, status: AiSuggestionStatus.ERROR, suggestion: null, reason: "Không gọi được AI, thử lại sau" };
  }

  // LỚP 2a: luật cứng.
  const violations = ruleCheckReply(suggestion, promos, keywords);
  // LỚP 2b: AI tự kiểm (chỉ khi luật cứng chưa bắt được gì).
  let check: { ok: boolean; violations: string[] } = { ok: violations.length === 0, violations };
  if (!violations.length) {
    try {
      const res = await callAiLogged({
        req: opts.req,
        customerId: conv.customerId,
        branchId: conv.branchId,
        purpose: "AI2 tự kiểm câu gợi ý",
        request: {
          model: AI_MODELS.CHEAP,
          maxTokens: 300,
          system: CHECK_SYSTEM,
          messages: [{ role: "user", content: `${promoText}\n\nCâu trả lời cần kiểm:\n${suggestion}` }],
        },
      });
      const parsed = parseJsonFromText<{ ok?: unknown; violations?: unknown }>(res.text);
      if (!parsed || typeof parsed.ok !== "boolean") check = { ok: false, violations: ["Không tự kiểm được câu trả lời"] };
      else
        check = {
          ok: parsed.ok,
          violations: Array.isArray(parsed.violations) ? parsed.violations.map(String).slice(0, 5) : [],
        };
    } catch {
      check = { ok: false, violations: ["Không tự kiểm được câu trả lời"] };
    }
  }

  if (!check.ok) {
    const reason = `Câu gợi ý không qua tự kiểm: ${check.violations.join("; ") || "vi phạm luật trả lời"}`;
    const row = await save({
      status: AiSuggestionStatus.REJECTED_CHECK,
      reason,
      suggestion,
      scriptId: script?.id,
      model: AI_MODELS.SMART,
      checkResult: check,
    });
    return { id: row.id, status: AiSuggestionStatus.REJECTED_CHECK, suggestion: null, reason, violations: check.violations };
  }

  const row = await save({
    status: AiSuggestionStatus.OK,
    suggestion,
    scriptId: script?.id,
    model: AI_MODELS.SMART,
    checkResult: check,
  });
  return { id: row.id, status: AiSuggestionStatus.OK, suggestion, reason: null, scriptVersion: script?.version ?? null };
}

/** Ghi câu thực gửi của một gợi ý (sale đã sửa hay chưa) để đối chiếu. */
export async function recordSuggestionSent(opts: {
  req: Request;
  suggestionId: string;
  conversationId: string;
  messageId: string;
  sentText: string;
  branchId: string | null;
}): Promise<void> {
  const s = await prisma.aiSuggestion.findUnique({ where: { id: opts.suggestionId } });
  if (!s || s.conversationId !== opts.conversationId || !s.suggestion || s.sentMessageId) return;
  const edited = s.suggestion.trim() !== opts.sentText.trim();
  await prisma.aiSuggestion.update({
    where: { id: s.id },
    data: { sentMessageId: opts.messageId, sentText: opts.sentText, sentAt: new Date(), edited },
  });
  await writeAudit({
    req: opts.req,
    action: AuditAction.UPDATE,
    entity: "AiSuggestion",
    entityId: s.id,
    branchId: opts.branchId,
    summary: `Gửi câu từ gợi ý AI (${edited ? "đã sửa" : "giữ nguyên"})`,
    changes: { text: [s.suggestion.slice(0, 1000), opts.sentText.slice(0, 1000)] },
  });
}

// ------------------------------------------------------------------ AI3

const SUMMARY_SYSTEM = `Bạn tóm tắt hội thoại giữa khách và nhân viên tư vấn phòng khám thẩm mỹ để nhân viên ca sau nắm nhanh.
Trả về DUY NHẤT một đối tượng JSON: {"summary": string, "nextAction": string}
- summary: tối đa 3 câu tiếng Việt: khách quan tâm gì, đã được báo gì, đang vướng gì.
- nextAction: MỘT việc cụ thể nhân viên nên làm tiếp (ví dụ: gửi bảng giá, mời đặt lịch có cọc, gọi xác nhận lịch).
Không nêu thông tin sức khoẻ, không đưa lời khuyên y khoa, không bịa thông tin không có trong hội thoại.`;

export interface SummaryResult {
  status: "OK" | "NOT_CONFIGURED" | "DISABLED" | "NO_CONSENT" | "ERROR" | "EMPTY";
  summary?: string;
  nextAction?: string;
  activityId?: string;
  message?: string;
}

export async function summarizeConversation(opts: {
  req: Request;
  conversation: { id: string; customerId: string; branchId: string | null };
  user: { id: string; name: string };
}): Promise<SummaryResult> {
  const { conversation: conv } = opts;
  const gate = await aiGate({ customerId: conv.customerId, settingKey: "ai.summaryEnabled" });
  if (gate !== "OK") return { status: gate };
  const keywords = await medicalKeywords();
  const { lines } = await transcript(conv.id, 60);
  if (!lines.length) return { status: "EMPTY", message: "Hội thoại chưa có tin nhắn chữ" };
  // Không nạp dữ liệu y khoa: câu có từ khoá sức khoẻ được che trước khi gửi AI.
  const text = redactMedical(lines.join("\n"), keywords).slice(-8000);
  let parsed: { summary?: unknown; nextAction?: unknown } | null;
  let model: string = AI_MODELS.CHEAP;
  try {
    const res = await callAiLogged({
      req: opts.req,
      customerId: conv.customerId,
      branchId: conv.branchId,
      purpose: "AI3 tóm tắt hội thoại và bước tiếp theo",
      request: { model: AI_MODELS.CHEAP, maxTokens: 500, system: SUMMARY_SYSTEM, messages: [{ role: "user", content: text }] },
    });
    model = res.model;
    parsed = parseJsonFromText(res.text);
  } catch {
    return { status: "ERROR", message: "Không gọi được AI, thử lại sau" };
  }
  const summary = typeof parsed?.summary === "string" ? parsed.summary.trim().slice(0, 1500) : "";
  const nextAction = typeof parsed?.nextAction === "string" ? parsed.nextAction.trim().slice(0, 500) : "";
  if (!summary) return { status: "ERROR", message: "AI trả về không đúng định dạng" };

  const activity = await prisma.activity.create({
    data: {
      customerId: conv.customerId,
      type: ActivityType.AI_SUMMARY,
      content: `Tóm tắt hội thoại (AI): ${summary}${nextAction ? ` Bước tiếp theo: ${nextAction}` : ""}`,
      userId: opts.user.id,
      userName: opts.user.name,
      meta: JSON.stringify({ conversationId: conv.id, summary, nextAction, model }),
    },
  });
  return { status: "OK", summary, nextAction, activityId: activity.id };
}

export async function latestSummary(conversationId: string, customerId: string) {
  const rows = await prisma.activity.findMany({
    where: { customerId, type: ActivityType.AI_SUMMARY },
    orderBy: { createdAt: "desc" },
    take: 20,
  });
  for (const r of rows) {
    try {
      const meta = JSON.parse(r.meta ?? "{}");
      if (meta.conversationId === conversationId) {
        return { summary: meta.summary as string, nextAction: meta.nextAction as string, createdAt: r.createdAt, by: r.userName };
      }
    } catch {
      // bỏ qua meta hỏng
    }
  }
  return null;
}
