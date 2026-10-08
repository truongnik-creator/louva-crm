import { prisma } from "../lib/prisma";
import { logger } from "../lib/logger";
import { normalizeVnPhone } from "../lib/phone";
import { emitTo, roomFor } from "../socket";
import { applyStageEventSafe } from "../lib/stages";
import { scheduleMediaIngest } from "../lib/chat-media";
import { autoAssignConversation, noteMessageBatch } from "../lib/inbox-routing";
import {
  conversationPhone,
  extractAdSource,
  fetchConversations,
  fetchMessages,
  isFromCustomer,
  messageText,
  parsePancakeTime,
  resolvePageToken,
  staffUidOf,
  type PancakeConversationRaw,
  type PancakeMessageRaw,
} from "./pancake";
import { findCampaignByAdName } from "../lib/lead-funnel";
import {
  ConversationKind,
  LeadStage,
  MessageDirection,
  MessageStatus,
  MessageType,
  StageEvent,
} from "../types/enums";

// F5: ghi hội thoại + tin nhắn Pancake vào CRM. Dùng chung cho đồng bộ tay
// (kéo) và webhook (đẩy): cả hai đều idempotent theo pancakeConversationId và
// externalId của tin, nên webhook trùng hay đồng bộ chồng lên nhau không nhân bản.

interface PageRef {
  id: string;
  pageId: string;
  platform: string;
  branchId: string | null;
  channelId: string | null;
  configId: string;
}

/**
 * UUID nhân viên Pancake -> id tài khoản CRM (F35). Nhờ bảng này, tin nhân viên
 * trả lời NGAY TRONG app Pancake vẫn quy được về người thật trong CRM, nên báo
 * cáo tốc độ trả lời của CRM không còn trống khi phòng khám chat bên Pancake.
 */
export async function agentUserMap(configId: string): Promise<Map<string, string>> {
  const rows = await prisma.pancakeAgent.findMany({
    where: { configId, userId: { not: null } },
    select: { pancakeUserId: true, userId: true },
  });
  return new Map(rows.map((r) => [r.pancakeUserId, r.userId!]));
}

export interface IngestResult {
  conversationId: string;
  created: number;
  leadId: string | null;
}

function isImage(f: { type?: string; mime_type?: string }): boolean {
  return f.type === "photo" || f.type === "image" || Boolean(f.mime_type?.startsWith("image/"));
}

/**
 * Số tin chưa đọc Pancake báo. Bản cũ có `unread_count`; API v2 chỉ có cờ
 * `seen`, lúc đó "chưa xem" quy về 1 tin chưa đọc để huy hiệu hộp thư vẫn sáng.
 * null = Pancake không nói gì, giữ nguyên số cũ của CRM.
 */
function unreadFromPancake(c: PancakeConversationRaw): number | null {
  if (typeof c.unread_count === "number") return c.unread_count;
  if (typeof c.seen === "boolean") return c.seen ? 0 : 1;
  return null;
}

/** Ghi một hội thoại Pancake và các tin của nó. */
export async function ingestPancakeConversation(opts: {
  page: PageRef;
  configBranchId: string | null;
  conversation: PancakeConversationRaw;
  messages: PancakeMessageRaw[];
  /** Webhook đẩy từng tin mới: tăng số chưa đọc thay vì lấy số Pancake báo. */
  incremental?: boolean;
  /** id bên mở hội thoại (conv_from.id) — để biết tin nào của khách. */
  convFromId?: string;
  /** UUID nhân viên Pancake -> id tài khoản CRM. Trống thì không quy được. */
  agents?: Map<string, string>;
}): Promise<IngestResult> {
  const { page, conversation: c } = opts;
  const title = c.customer_name?.trim() || c.from?.name?.trim() || `Khách ${page.platform}`;
  const fromCustomer = (m: PancakeMessageRaw): boolean =>
    isFromCustomer(m, { pageId: page.pageId, ...(opts.convFromId ? { convFromId: opts.convFromId } : {}) });
  const agents = opts.agents ?? (await agentUserMap(page.configId));
  const ad = extractAdSource(c);

  // Tìm khách theo SĐT chuẩn hoá (T4/B17), bằng cột có index.
  const phoneNormalized = normalizeVnPhone(conversationPhone(c));
  const customer = phoneNormalized
    ? await prisma.customer.findFirst({
        where: { phoneNormalized, mergedIntoId: null },
        select: { id: true },
        orderBy: { createdAt: "asc" },
      })
    : null;

  const lastAt = parsePancakeTime(c.updated_at);
  const lastIn = [...opts.messages].reverse().find(fromCustomer);
  const lastAny = opts.messages[opts.messages.length - 1];
  const preview = (
    c.snippet ??
    (lastIn ? messageText(lastIn) : null) ??
    (lastAny ? messageText(lastAny) : null) ??
    undefined
  )?.slice(0, 160);
  const existing = await prisma.conversation.findUnique({ where: { pancakeConversationId: String(c.id) } });

  const conv = existing
    ? await prisma.conversation.update({
        where: { id: existing.id },
        data: {
          title: existing.customerId ? existing.title : title,
          unreadCount: opts.incremental
            ? { increment: opts.messages.filter(fromCustomer).length }
            : (unreadFromPancake(c) ?? existing.unreadCount),
          lastMessageAt: lastAt,
          ...(preview ? { lastMessagePreview: preview } : {}),
          ...(customer && !existing.customerId ? { customerId: customer.id } : {}),
          // Nguồn quảng cáo chỉ ghi lần đầu có: tin sau không có ad_id không được xoá mất.
          ...(ad.adId && !existing.adId ? { adId: ad.adId } : {}),
          ...(ad.adPostId && !existing.adPostId ? { adPostId: ad.adPostId } : {}),
          ...(ad.adCampaign && !existing.adCampaign ? { adCampaign: ad.adCampaign } : {}),
        },
      })
    : await prisma.conversation.create({
        data: {
          pancakeConversationId: String(c.id),
          pancakePageId: page.id,
          branchId: page.branchId ?? opts.configBranchId,
          kind: ConversationKind.CUSTOMER,
          channel: page.platform,
          title,
          customerId: customer?.id ?? null,
          unreadCount: opts.incremental ? opts.messages.filter(fromCustomer).length : (unreadFromPancake(c) ?? 0),
          lastMessageAt: lastAt,
          lastMessagePreview: preview,
          adId: ad.adId,
          adPostId: ad.adPostId,
          adCampaign: ad.adCampaign,
        },
      });

  // Khách nhắn từ quảng cáo mà chưa có hồ sơ: tạo lead mang nguồn quảng cáo để
  // đo chi phí trên mỗi SĐT (F15 sẽ đọc). Chống trùng theo externalId.
  let leadId = conv.leadId;
  if (!leadId && !conv.customerId && (ad.adId || ad.adPostId)) {
    const externalId = `pancake:${c.id}`;
    // F15: gắn chiến dịch theo tên chiến dịch quảng cáo (mã, utm hoặc tên) để tính chi phí/SĐT.
    const campaign = await findCampaignByAdName(ad.adCampaign);
    const lead =
      (await prisma.lead.findUnique({ where: { externalId } })) ??
      (await prisma.lead.create({
        data: {
          externalId,
          campaignId: campaign?.id ?? null,
          name: title,
          phone: conversationPhone(c),
          branchId: page.branchId ?? opts.configBranchId,
          channelId: page.channelId,
          stage: LeadStage.NEW,
          adId: ad.adId,
          adPostId: ad.adPostId,
          adCampaign: ad.adCampaign,
          note: `Nhắn từ quảng cáo qua Pancake (${page.platform})`,
          firstContactAt: lastAt,
        },
      }));
    leadId = lead.id;
    await prisma.conversation.update({ where: { id: conv.id }, data: { leadId } });
  }

  // T4: một truy vấn lấy id đã có + một createMany.
  const ids = [...new Set(opts.messages.map((m) => String(m.id)))];
  const known = ids.length
    ? await prisma.chatMessage.findMany({ where: { externalId: { in: ids } }, select: { externalId: true } })
    : [];
  const seen = new Set(known.map((e) => e.externalId));
  const fresh = opts.messages.filter((m) => {
    const id = String(m.id);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });

  let created = 0;
  if (fresh.length) {
    const r = await prisma.chatMessage.createMany({
      data: fresh.map((m) => {
        const files = (m.attachments ?? []).filter((f) => f.url?.startsWith("https://"));
        const mine = !fromCustomer(m);
        const uid = staffUidOf(m);
        return {
          conversationId: conv.id,
          externalId: String(m.id),
          direction: mine ? MessageDirection.OUT : MessageDirection.IN,
          type: files.some(isImage) ? MessageType.IMAGE : files.length ? MessageType.FILE : MessageType.TEXT,
          content: messageText(m) ?? (files.length ? "[Tệp đính kèm]" : "[Nội dung không đọc được]"),
          // F35: tin nhân viên gửi bên Pancake quy về tài khoản CRM đã gắn.
          senderUserId: mine && uid ? (agents.get(uid) ?? null) : null,
          senderName: m.sender_name ?? m.from?.admin_name ?? m.from?.name ?? (mine ? null : title),
          status: MessageStatus.DELIVERED,
          createdAt: parsePancakeTime(m.inserted_at),
        };
      }),
    });
    created = r.count;

    const rows = await prisma.chatMessage.findMany({
      where: { externalId: { in: fresh.map((m) => String(m.id)) } },
      select: { id: true, externalId: true, direction: true },
    });
    const idOf = new Map(rows.map((r) => [r.externalId, r.id]));

    // B13/F2: tệp đính kèm, ảnh khách gửi sẽ được tải về chạy nền.
    const withFiles = fresh.filter((m) => m.attachments?.some((f) => f.url?.startsWith("https://")));
    if (withFiles.length) {
      await prisma.messageAttachment.createMany({
        data: withFiles.flatMap((m) =>
          (m.attachments ?? [])
            .filter((f) => f.url?.startsWith("https://") && idOf.get(String(m.id)))
            .map((f) => ({
              messageId: idOf.get(String(m.id))!,
              kind: isImage(f) ? "IMAGE" : "FILE",
              fileName: (f.name ?? (isImage(f) ? "anh-pancake.jpg" : "tep-pancake")).slice(0, 200),
              mimeType: f.mime_type ?? (isImage(f) ? "image/jpeg" : null),
              url: f.url!,
            }))
        ),
      });
      scheduleMediaIngest(
        withFiles.filter(fromCustomer).map((m) => idOf.get(String(m.id))!).filter(Boolean)
      );
    }

    // F26: mốc khách chờ trả lời, chia xoay vòng khi khách nhắn mà chưa ai phụ trách.
    await noteMessageBatch(
      conv.id,
      fresh.map((m) => ({
        direction: fromCustomer(m) ? ("IN" as const) : ("OUT" as const),
        at: parsePancakeTime(m.inserted_at),
      }))
    );
    if (fresh.some(fromCustomer)) await autoAssignConversation(conv.id);

    if (conv.customerId && fresh.some(fromCustomer)) {
      await prisma.customer.update({ where: { id: conv.customerId }, data: { lastContactAt: new Date() } });
      await applyStageEventSafe(conv.customerId, StageEvent.MESSAGE);
    }
  }

  if (conv.branchId) emitTo(roomFor.branch(conv.branchId), "conversation:updated", { id: conv.id });
  return { conversationId: conv.id, created, leadId };
}

/** Đồng bộ kéo toàn bộ trang của một kết nối. Có khoá để không chạy chồng. */
const running = new Set<string>();

/** Giới hạn Pancake: 5 lượt/trang/giây. 220ms giữa các lượt là ~4,5 lượt/giây. */
const PACE_MS = Number(process.env.PANCAKE_PACE_MS ?? 220);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function isSyncRunning(configId: string): boolean {
  return running.has(configId);
}

export async function syncPancakeConfig(configId: string): Promise<{ conversations: number; messages: number; errors: string[] }> {
  if (running.has(configId)) return { conversations: 0, messages: 0, errors: ["Đang đồng bộ, chờ lượt trước chạy xong"] };
  running.add(configId);
  try {
    const config = await prisma.pancakeConfig.findUniqueOrThrow({
      where: { id: configId },
      include: { pages: { where: { active: true } } },
    });
    if (!config.active) throw new Error("Kết nối Pancake đã tắt");

    const agents = await agentUserMap(configId);
    let convCount = 0;
    let msgCount = 0;
    const errors: string[] = [];
    for (const page of config.pages) {
      try {
        // API cấp trang chỉ nhận page_access_token; chưa có thì tự sinh và lưu.
        const token = await resolvePageToken(page);
        if (!token) throw new Error("Chưa lấy được token trang (kiểm tra API token của kết nối)");
        const conversations = await fetchConversations(token, page.pageId);
        for (const c of conversations) {
          // Pancake chặn ở 5 lượt/trang/giây: nghỉ giữa các lượt lấy tin.
          await sleep(PACE_MS);
          const fetched = await fetchMessages(token, page.pageId, String(c.id));
          const r = await ingestPancakeConversation({
            page: { ...page, configId },
            configBranchId: config.branchId,
            conversation: c,
            messages: fetched.messages,
            ...(fetched.convFromId ? { convFromId: fetched.convFromId } : {}),
            agents,
          });
          convCount++;
          msgCount += r.created;
        }
        await prisma.pancakePage.update({ where: { id: page.id }, data: { lastSyncAt: new Date() } });
      } catch (err) {
        errors.push(`${page.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const note = errors.length
      ? `${convCount} hội thoại, ${msgCount} tin mới. Lỗi: ${errors.join(" | ")}`
      : `${convCount} hội thoại, ${msgCount} tin mới`;
    await prisma.pancakeConfig.update({ where: { id: configId }, data: { lastSyncAt: new Date(), lastSyncNote: note } });
    return { conversations: convCount, messages: msgCount, errors };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await prisma.pancakeConfig
      .update({ where: { id: configId }, data: { lastSyncNote: `Lỗi đồng bộ: ${message}` } })
      .catch(() => undefined);
    logger.warn({ err: message, configId }, "[pancake] đồng bộ lỗi");
    return { conversations: 0, messages: 0, errors: [message] };
  } finally {
    running.delete(configId);
  }
}
