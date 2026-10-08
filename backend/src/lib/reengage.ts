import type { Request } from "express";
import { prisma } from "./prisma";
import { logger } from "./logger";
import { writeAudit } from "./audit";
import { getSettingBool, getSettingNumber } from "./settings-catalog";
import { AI_MODELS, aiGate, callAiLogged, isAiConfigured } from "./ai";
import { medicalKeywords, redactMedical } from "./medical-keywords";
import { ruleCheckReply } from "./ai-assist";
import { activePromotions } from "./pricing";
import { resolveSegment } from "./broadcast";
import { registerJob } from "./jobs";
import { notifyUsers } from "./notify";
import { vnDayKey } from "./datetime";
import { DAY_MS, responsibleSaleOf } from "./metrics";
import { hasUnresolvedPlaceholder, unknownVariables } from "./quick-reply-vars";
import { HttpError } from "../middleware/errorHandler";
import {
  AuditAction,
  ConversationKind,
  MessageDirection,
  ProcedureStatus,
  RecipientStatus,
  ReengageDraftStatus,
} from "../types/enums";

// AI5: NHÁP TIN CHĂM LẠI KHÁCH IM LẶNG.
//
// Tác vụ nền mỗi ngày:
//   1. Lấy nhóm "im lặng quá N ngày" bằng đúng bộ lọc nhóm khách của F11
//      (lib/broadcast.ts resolveSegment), bỏ khách từ chối nhận tin.
//   2. Mỗi khách qua aiGate: thiếu khoá, tắt trong Cài đặt, khách CHƯA ĐỒNG Ý xử
//      lý dữ liệu thì bỏ qua, không gửi gì lên AI.
//   3. Model CHEAP soạn nháp. KHÔNG gửi tên, SĐT khách lên AI: nháp dùng biến
//      {{ten_khach}}, hệ thống tự điền lúc gửi. Tin chat cũ được che câu y khoa.
//   4. Nháp qua luật cứng của AI2 (không y khoa, không hứa kết quả, không giảm
//      giá ngoài đợt đang chạy); trượt thì bỏ.
//   5. Lưu ReengageDraft trạng thái PENDING, báo sale phụ trách.
// Sale duyệt (có thể sửa) thì nháp mới vào hàng đợi gửi theo nhóm (F11): hàng
// đợi tự loại khách từ chối nhận tin, ngoài cửa sổ 24 giờ Facebook thì tạo việc
// cho sale thay vì gửi. Không có đường nào tự gửi nháp AI cho khách.

export const REENGAGE_JOB = "ai5-reengage-drafts";

const REENGAGE_SYSTEM = `Bạn viết NHÁP tin nhắn chăm sóc lại một khách lâu không liên lạc với phòng khám thẩm mỹ nội khoa (tiêm filler, botox, meso, HIFU, tan mỡ...). Nhân viên sẽ đọc, sửa rồi mới gửi.
Luật bắt buộc:
- Tiếng Việt, xưng "em", gọi khách bằng biến {{ten_khach}} (hệ thống tự điền tên). Không tự đặt tên khách.
- 2 đến 4 câu, thân thiện, hỏi thăm, mời khách nhắn lại hoặc ghé cơ sở. Không dùng gạch ngang dài.
- KHÔNG lời khuyên y khoa, KHÔNG hứa kết quả, KHÔNG nhắc giảm giá, khuyến mãi, quà tặng trừ các đợt ưu đãi đang chạy được liệt kê.
- Không bịa giá, lịch, địa chỉ. Chỉ dùng biến có sẵn nếu cần: {{ten_khach}}, {{co_so}}, {{dia_chi_co_so}}, {{hotline}}, {{nhan_vien}}.
- Chỉ trả về đúng nội dung tin nhắn, không giải thích.`;

export interface ReengageRunResult {
  created: number;
  skippedNoConsent: number;
  skippedRecent: number;
  failed: number;
  message: string;
}

const PHONE_LIKE = /(\+?84|0)(?:[\s.-]?\d){8,10}/g;

/** Che SĐT và tên khách trong đoạn chat trước khi gửi AI (tên thay bằng biến {{ten_khach}}). */
export function redactPersonal(text: string, name: string | null): string {
  let out = text.replace(PHONE_LIKE, "[SĐT]");
  const n = name?.trim();
  if (n && n.length >= 2) {
    const esc = n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(esc, "giu"), "{{ten_khach}}");
  }
  return out;
}

/** Ngữ cảnh gửi lên AI: chỉ dịch vụ đã làm, số ngày im lặng, đoạn chat đã che. Không tên, không SĐT. */
export async function buildReengagePrompt(customerId: string, now: Date, silentDays: number): Promise<{ prompt: string; conversationId: string | null; branchId: string | null }> {
  const [procedures, conv, promos, keywords] = await Promise.all([
    prisma.procedureRecord.findMany({
      where: { customerId, status: ProcedureStatus.COMPLETED },
      orderBy: { scheduledAt: "desc" },
      take: 5,
      select: { service: { select: { name: true } }, finishedAt: true, scheduledAt: true },
    }),
    prisma.conversation.findFirst({
      where: { customerId, kind: ConversationKind.CUSTOMER },
      orderBy: [{ lastMessageAt: "desc" }, { createdAt: "desc" }],
      select: { id: true, branchId: true, channel: true },
    }),
    activePromotions(null, now),
    medicalKeywords(),
  ]);
  const customer = await prisma.customer.findUnique({
    where: { id: customerId },
    select: { name: true, lastContactAt: true, createdAt: true, branchLinks: { select: { branchId: true, isPrimary: true } } },
  });
  const last = customer?.lastContactAt ?? customer?.createdAt ?? null;
  const days = last ? Math.floor((now.getTime() - last.getTime()) / DAY_MS) : silentDays;
  let chat: string[] = [];
  if (conv) {
    const rows = await prisma.chatMessage.findMany({
      where: { conversationId: conv.id },
      orderBy: { createdAt: "desc" },
      take: 6,
      select: { direction: true, content: true },
    });
    chat = rows
      .reverse()
      .filter((m) => m.content && !m.content.startsWith("["))
      .map((m) => `${m.direction === MessageDirection.IN ? "Khách" : "Nhân viên"}: ${redactPersonal(redactMedical(m.content, keywords), customer?.name ?? null)}`);
  }
  const services = procedures
    .map((p) => (p.service?.name ? `${p.service.name} (${vnDayKey(p.finishedAt ?? p.scheduledAt)})` : null))
    .filter(Boolean);
  const promoText = promos.length ? promos.map((p) => p.name).join("; ") : "Không có đợt ưu đãi nào đang chạy.";
  const prompt = [
    `Khách im lặng khoảng ${days} ngày.`,
    `Dịch vụ đã làm: ${services.length ? services.join(", ") : "chưa làm dịch vụ nào"}.`,
    `Đợt ưu đãi đang chạy: ${promoText}`,
    chat.length ? `Vài tin gần nhất (đã che nội dung sức khoẻ):\n${chat.join("\n")}` : "Chưa có tin chat.",
  ].join("\n");
  const branchId = conv?.branchId ?? customer?.branchLinks.find((b) => b.isPrimary)?.branchId ?? customer?.branchLinks[0]?.branchId ?? null;
  return { prompt, conversationId: conv?.id ?? null, branchId };
}

export async function draftReengagements(now: Date): Promise<ReengageRunResult> {
  const empty = (message: string): ReengageRunResult => ({ created: 0, skippedNoConsent: 0, skippedRecent: 0, failed: 0, message });
  if (!isAiConfigured()) return empty("AI chưa cấu hình, bỏ qua");
  if (!(await getSettingBool("ai.reengageEnabled"))) return empty("Đã tắt trong Cài đặt");

  const silentDays = Math.max(1, Math.round(await getSettingNumber("ai.reengageSilentDays")));
  const limit = Math.max(1, Math.round(await getSettingNumber("ai.reengageDailyLimit")));
  const cooldown = Math.max(1, Math.round(await getSettingNumber("ai.reengageCooldownDays")));
  const dayKey = vnDayKey(now);

  // Hạn mức theo NGÀY: chạy lại trong ngày không soạn vượt số đã đặt.
  const today = await prisma.reengageDraft.count({ where: { dayKey } });
  let budget = limit - today;
  if (budget <= 0) return empty(`Đã đủ ${limit} nháp hôm nay`);

  // Nháp quá cũ chưa ai duyệt thì hết hạn (khách có thể đã quay lại).
  await prisma.reengageDraft.updateMany({
    where: { status: ReengageDraftStatus.PENDING, createdAt: { lt: new Date(now.getTime() - 7 * DAY_MS) } },
    data: { status: ReengageDraftStatus.EXPIRED },
  });

  const members = (await resolveSegment({ silentDays }, { now, branchIds: null })).filter((m) => !m.optOut);
  const recent = new Set(
    (
      await prisma.reengageDraft.findMany({
        where: { customerId: { in: members.map((m) => m.id) }, createdAt: { gte: new Date(now.getTime() - cooldown * DAY_MS) } },
        select: { customerId: true },
      })
    ).map((d) => d.customerId)
  );
  const [promos, keywords] = await Promise.all([activePromotions(null, now), medicalKeywords()]);
  // Lọc trước khách đã đồng ý xử lý dữ liệu bằng một truy vấn (aiGate vẫn kiểm lại từng khách).
  const consenting = new Set(
    (
      await prisma.customer.findMany({
        where: { id: { in: members.map((m) => m.id) }, aiDataConsent: true },
        select: { id: true },
      })
    ).map((c) => c.id)
  );

  let created = 0;
  let skippedNoConsent = 0;
  let skippedRecent = 0;
  let failed = 0;
  const perOwner = new Map<string, number>();
  for (const m of members) {
    if (budget <= 0) break;
    if (recent.has(m.id)) {
      skippedRecent++;
      continue;
    }
    const gate = consenting.has(m.id) ? await aiGate({ customerId: m.id, settingKey: "ai.reengageEnabled" }) : "NO_CONSENT";
    if (gate !== "OK") {
      skippedNoConsent++;
      continue;
    }
    try {
      const ctx = await buildReengagePrompt(m.id, now, silentDays);
      const res = await callAiLogged({
        customerId: m.id,
        branchId: ctx.branchId,
        purpose: "AI5 soạn nháp tin chăm lại khách im lặng",
        request: { model: AI_MODELS.CHEAP, maxTokens: 400, system: REENGAGE_SYSTEM, messages: [{ role: "user", content: ctx.prompt }] },
      });
      const text = res.text.trim().replace(/\s*—\s*/g, ", ").slice(0, 1500);
      const violations = [...ruleCheckReply(text, promos, keywords), ...unknownVariables(text).map((v) => `Biến lạ {{${v}}}`)];
      if (!text || violations.length) {
        failed++;
        logger.info({ customerId: m.id, violations }, "[ai5] nháp không qua kiểm tra, bỏ");
        continue;
      }
      const owner = await prisma.customer.findUnique({ where: { id: m.id }, select: { assignedToId: true, telesaleId: true } });
      const ownerId = owner ? responsibleSaleOf(owner) : null;
      await prisma.reengageDraft.create({
        data: { customerId: m.id, branchId: ctx.branchId, conversationId: ctx.conversationId, ownerId, dayKey, content: text, model: res.model },
      });
      created++;
      budget--;
      if (ownerId) perOwner.set(ownerId, (perOwner.get(ownerId) ?? 0) + 1);
    } catch (err) {
      failed++;
      logger.warn({ err: err instanceof Error ? err.message : String(err), customerId: m.id }, "[ai5] soạn nháp lỗi");
    }
  }
  for (const [ownerId, n] of perOwner) {
    await notifyUsers([ownerId], {
      title: `${n} nháp tin chăm lại khách chờ bạn duyệt`,
      body: "AI đã soạn nháp cho khách im lặng lâu. Duyệt, sửa rồi mới gửi.",
      link: "/cham-lai-khach",
    });
  }
  return {
    created,
    skippedNoConsent,
    skippedRecent,
    failed,
    message: `Soạn ${created} nháp, bỏ qua ${skippedNoConsent} (chưa đồng ý dữ liệu), ${skippedRecent} (đã có nháp gần đây), lỗi hoặc không đạt ${failed}`,
  };
}

/**
 * Sale duyệt nháp: đưa vào hàng đợi gửi theo nhóm (F11) dưới dạng một đợt một
 * khách. Hàng đợi tự kiểm optOut và cửa sổ 24 giờ lúc gửi.
 */
export async function approveDraft(opts: {
  req: Request;
  draft: { id: string; customerId: string; branchId: string | null; content: string; status: string };
  content?: string;
  user: { id: string; name: string; activeBranchId: string | null };
}): Promise<{ broadcastId: string; recipientStatus: string }> {
  const { draft, user } = opts;
  if (draft.status !== ReengageDraftStatus.PENDING) throw new HttpError(409, "Nháp đã được xử lý");
  const finalContent = (opts.content ?? draft.content).trim();
  if (finalContent.length < 2) throw new HttpError(400, "Nội dung trống");
  const unknown = unknownVariables(finalContent);
  if (unknown.length) throw new HttpError(400, `Biến không có trong danh mục: ${unknown.map((u) => `{{${u}}}`).join(", ")}`);
  if (/\{\{[^}]*$/.test(finalContent) || (hasUnresolvedPlaceholder(finalContent) && unknown.length)) {
    throw new HttpError(400, "Nội dung còn biến chưa đóng");
  }
  const customer = await prisma.customer.findUnique({ where: { id: draft.customerId }, select: { id: true, code: true, optOut: true, mergedIntoId: true } });
  if (!customer || customer.mergedIntoId) throw new HttpError(409, "Hồ sơ khách không còn");

  const edited = finalContent !== draft.content.trim();
  const result = await prisma.$transaction(async (tx) => {
    const claimed = await tx.reengageDraft.updateMany({
      where: { id: draft.id, status: ReengageDraftStatus.PENDING },
      data: {
        status: ReengageDraftStatus.QUEUED,
        finalContent,
        edited,
        reviewedById: user.id,
        reviewedByName: user.name,
        reviewedAt: new Date(),
      },
    });
    if (claimed.count !== 1) throw new HttpError(409, "Nháp đã được xử lý");
    const broadcast = await tx.broadcast.create({
      data: {
        name: `Chăm lại khách ${customer.code} (AI5)`,
        branchId: draft.branchId ?? user.activeBranchId,
        filter: JSON.stringify({ reengageDraftId: draft.id }),
        template: finalContent,
        total: 1,
        createdById: user.id,
        createdByName: user.name,
      },
    });
    const recipientStatus = customer.optOut ? RecipientStatus.SKIPPED_OPT_OUT : RecipientStatus.PENDING;
    await tx.broadcastRecipient.create({ data: { broadcastId: broadcast.id, customerId: customer.id, status: recipientStatus } });
    await tx.reengageDraft.update({ where: { id: draft.id }, data: { broadcastId: broadcast.id } });
    return { broadcastId: broadcast.id, recipientStatus };
  });
  // Ghi audit SAU giao dịch: SQLite một luồng ghi, ghi bằng kết nối khác trong giao dịch sẽ chờ khoá.
  await writeAudit({
    req: opts.req,
    action: AuditAction.APPROVE,
    entity: "ReengageDraft",
    entityId: draft.id,
    branchId: draft.branchId,
    summary: `Duyệt nháp tin chăm lại khách ${customer.code}${edited ? " (đã sửa)" : ""}, đưa vào hàng đợi gửi${customer.optOut ? " (khách từ chối nhận tin, sẽ không gửi)" : ""}`,
  });
  return result;
}

let registered = false;
export function registerReengageJob(): void {
  if (registered) return;
  registered = true;
  registerJob({
    key: REENGAGE_JOB,
    label: "AI5: soạn nháp tin chăm lại khách im lặng (chờ sale duyệt)",
    // Chạy mỗi 2 giờ; hạn mức theo ngày nên thực chất mỗi ngày soạn tối đa N nháp.
    intervalMs: 2 * 60 * 60_000,
    lockMs: 60 * 60_000,
    settingKey: "ai.reengageEnabled",
    run: async ({ now }) => {
      const r = await draftReengagements(now);
      return { created: r.created, message: r.message };
    },
  });
}
