import { prisma } from "./prisma";
import { logger } from "./logger";
import { getSettingBool, getSettingNumber } from "./settings-catalog";
import { AI_MODELS, aiGate, callAiLogged, isAiConfigured, parseJsonFromText } from "./ai";
import { medicalKeywords, redactMedical } from "./medical-keywords";
import { registerJob } from "./jobs";
import { DAY_MS, startOfVnWeek, vnWeekKey } from "./metrics";
import { ConversationKind, ConversationScoreStatus, MessageDirection } from "../types/enums";

// AI4: CHẤM HỘI THOẠI THEO KỊCH BẢN MỖI TUẦN.
//
// Tác vụ nền theo lô: lấy các hội thoại có nhân viên trả lời trong TUẦN TRƯỚC
// (thứ Hai đến Chủ nhật, giờ VN), chấm bằng model SMART theo rubric là kịch bản
// bán hàng đang dùng (SalesScript isActive), lưu ConversationScore (một dòng mỗi
// hội thoại mỗi tuần, chạy lại không chấm trùng).
//
// Luật:
//   - Tôn trọng aiGate: thiếu khoá, tắt trong Cài đặt, khách chưa đồng ý xử lý
//     dữ liệu thì BỎ QUA hội thoại đó (không gửi gì lên AI).
//   - Câu có nội dung sức khoẻ được che trước khi gửi.
//   - Điểm chỉ để quản lý kèm cặp: KHÔNG có đường nào nối vào lương, thưởng.

export const SCORING_JOB = "ai4-conversation-scoring";

const SCORING_SYSTEM = `Bạn là quản lý kinh doanh phòng khám thẩm mỹ nội khoa, chấm một hội thoại giữa nhân viên tư vấn (sale) và khách theo KỊCH BẢN CHUẨN bên dưới.
Tự rút ra 4 đến 6 tiêu chí từ các bước của kịch bản (ví dụ: chào hỏi, hỏi nhu cầu, xin SĐT, báo giá đúng, mời đặt lịch có cọc, chốt bước tiếp theo). Mỗi tiêu chí chấm từ 0 đến 10.
Trả về DUY NHẤT một đối tượng JSON:
{"score": số nguyên 0-100 (điểm tổng), "criteria": [{"name": string, "score": số 0-10, "comment": string ngắn}], "summary": "tối đa 2 câu nhận xét và 1 gợi ý cải thiện"}
Chỉ chấm cách nhân viên làm theo kịch bản. Không bình luận về sức khoẻ của khách, không nêu thông tin cá nhân của khách.`;

export interface ScoringResult {
  created: number;
  skippedNoConsent: number;
  failed: number;
  message: string;
}

/** Tuần trước của mốc now: [thứ Hai tuần trước, thứ Hai tuần này). */
export function previousWeek(now: Date): { from: Date; to: Date; weekKey: string } {
  const to = startOfVnWeek(now);
  const from = new Date(to.getTime() - 7 * DAY_MS);
  return { from, to, weekKey: vnWeekKey(new Date(from.getTime() + 12 * 3_600_000)) };
}

export async function scoreConversations(now: Date, opts: { weekFrom?: Date } = {}): Promise<ScoringResult> {
  if (!isAiConfigured()) return { created: 0, skippedNoConsent: 0, failed: 0, message: "AI chưa cấu hình, bỏ qua" };
  if (!(await getSettingBool("ai.scoringEnabled"))) return { created: 0, skippedNoConsent: 0, failed: 0, message: "Đã tắt trong Cài đặt" };
  const script = await prisma.salesScript.findFirst({ where: { isActive: true }, orderBy: { version: "desc" } });
  if (!script) return { created: 0, skippedNoConsent: 0, failed: 0, message: "Chưa có kịch bản bán hàng đang dùng" };

  const week = opts.weekFrom
    ? { from: startOfVnWeek(opts.weekFrom), to: new Date(startOfVnWeek(opts.weekFrom).getTime() + 7 * DAY_MS), weekKey: vnWeekKey(opts.weekFrom) }
    : previousWeek(now);
  const batch = Math.max(1, Math.round(await getSettingNumber("ai.scoringBatchSize")));

  // Hội thoại đã chấm được trong tuần thì không chấm lại; lần trước lỗi thì chấm lại.
  const already = await prisma.conversationScore.findMany({
    where: { weekKey: week.weekKey, status: ConversationScoreStatus.SCORED },
    select: { conversationId: true },
  });
  const done = new Set(already.map((a) => a.conversationId));
  const candidates = await prisma.conversation.findMany({
    where: {
      kind: ConversationKind.CUSTOMER,
      customerId: { not: null },
      messages: { some: { direction: MessageDirection.OUT, createdAt: { gte: week.from, lt: week.to } } },
    },
    select: { id: true, customerId: true, assignedToId: true, branchId: true },
    orderBy: { lastMessageAt: "desc" },
    take: batch + done.size + 200,
  });

  const keywords = await medicalKeywords();
  let created = 0;
  let skippedNoConsent = 0;
  let failed = 0;
  for (const conv of candidates) {
    if (created + failed >= batch) break;
    if (done.has(conv.id)) continue;
    const gate = await aiGate({ customerId: conv.customerId, settingKey: "ai.scoringEnabled" });
    if (gate !== "OK") {
      skippedNoConsent++;
      continue;
    }
    const msgs = await prisma.chatMessage.findMany({
      where: { conversationId: conv.id, createdAt: { gte: week.from, lt: week.to } },
      orderBy: { createdAt: "asc" },
      take: 200,
      select: { direction: true, content: true },
    });
    const lines = msgs
      .filter((m) => m.content && !m.content.startsWith("["))
      .map((m) => `${m.direction === MessageDirection.IN ? "Khách" : "Nhân viên"}: ${m.content}`);
    if (!lines.length) continue;
    const text = redactMedical(lines.join("\n"), keywords).slice(-12000);

    const base = {
      conversationId: conv.id,
      customerId: conv.customerId,
      userId: conv.assignedToId,
      branchId: conv.branchId,
      weekKey: week.weekKey,
      scriptId: script.id,
      scriptVersion: script.version,
    };
    try {
      const res = await callAiLogged({
        customerId: conv.customerId,
        branchId: conv.branchId,
        purpose: "AI4 chấm hội thoại theo kịch bản",
        request: {
          model: AI_MODELS.SMART,
          maxTokens: 800,
          system: [
            { text: SCORING_SYSTEM },
            { text: `KỊCH BẢN CHUẨN (phiên bản ${script.version}: ${script.title}):\n${script.content}`, cache: true },
          ],
          messages: [{ role: "user", content: `Hội thoại tuần ${week.weekKey}:\n${text}` }],
        },
      });
      const parsed = parseJsonFromText<{ score?: unknown; criteria?: unknown; summary?: unknown }>(res.text);
      const score = typeof parsed?.score === "number" ? Math.max(0, Math.min(100, Math.round(parsed.score))) : null;
      if (score === null) throw new Error("AI trả về không đúng định dạng");
      const criteria = Array.isArray(parsed?.criteria)
        ? (parsed!.criteria as Array<Record<string, unknown>>).slice(0, 10).map((c) => ({
            name: String(c.name ?? "").slice(0, 100),
            score: typeof c.score === "number" ? Math.max(0, Math.min(10, c.score)) : null,
            comment: String(c.comment ?? "").slice(0, 300),
          }))
        : [];
      const data = {
        ...base,
        status: ConversationScoreStatus.SCORED,
        score,
        criteriaJson: JSON.stringify(criteria),
        summary: typeof parsed?.summary === "string" ? parsed.summary.slice(0, 1000) : null,
        model: res.model,
        error: null,
      };
      await prisma.conversationScore.upsert({
        where: { conversationId_weekKey: { conversationId: conv.id, weekKey: week.weekKey } },
        create: data,
        update: data,
      });
      created++;
    } catch (err) {
      failed++;
      const error = err instanceof Error ? err.message : String(err);
      logger.warn({ err: error, conversationId: conv.id }, "[ai4] chấm hội thoại lỗi");
      const data = { ...base, status: ConversationScoreStatus.FAILED, error: error.slice(0, 500), model: AI_MODELS.SMART };
      await prisma.conversationScore
        .upsert({ where: { conversationId_weekKey: { conversationId: conv.id, weekKey: week.weekKey } }, create: data, update: data })
        .catch(() => undefined);
    }
  }
  return {
    created,
    skippedNoConsent,
    failed,
    message: `Tuần ${week.weekKey}: chấm ${created}, bỏ qua ${skippedNoConsent} (chưa đồng ý dữ liệu hoặc AI tắt), lỗi ${failed}`,
  };
}

let registered = false;
export function registerScoringJob(): void {
  if (registered) return;
  registered = true;
  registerJob({
    key: SCORING_JOB,
    label: "AI4: chấm hội thoại tuần trước theo kịch bản",
    // Chạy mỗi 6 giờ; hội thoại đã chấm trong tuần không chấm lại nên thực chất mỗi tuần một lượt theo lô.
    intervalMs: 6 * 60 * 60_000,
    lockMs: 60 * 60_000,
    settingKey: "ai.scoringEnabled",
    run: async ({ now }) => {
      const r = await scoreConversations(now);
      return { created: r.created, message: r.message };
    },
  });
}
