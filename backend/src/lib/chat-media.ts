import { prisma } from "./prisma";
import { logger } from "./logger";
import { getDecrypted, putEncrypted } from "./storage";
import { sniffFileKind } from "./upload";
import { getSettingBool, getSettingNumber } from "./settings-catalog";
import { applyStageEventSafe } from "./stages";
import { MessageDirection, PhotoStage, StageEvent } from "../types/enums";

// F2: ảnh khách gửi qua chat (Zalo, Pancake) tự tải về, mã hoá, lưu hồ sơ.
//
// Vì sao tải NGAY lúc nhận: đường dẫn ảnh của Zalo/Facebook hết hạn sau vài
// ngày; để đến lúc sale mở ra mới tải thì ảnh mặt của khách đã mất.
//
// Chạy nền (không chặn webhook): lỗi chỉ ghi log, tin nhắn vẫn nằm đó với
// đường dẫn gốc để thử lại lúc gắn hồ sơ.

const DOWNLOAD_TIMEOUT_MS = 15_000;

/** Tải một ảnh https về, kiểm dung lượng và byte đầu. null nếu không hợp lệ. */
export async function downloadImage(url: string, maxBytes: number): Promise<Buffer | null> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  const res = await fetch(parsed, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!res.ok) return null;
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > maxBytes) return null;
  return sniffFileKind(buf) === "image" ? buf : null;
}

function mimeOf(buf: Buffer): string {
  const hex = buf.subarray(0, 4).toString("hex");
  if (hex.startsWith("89504e47")) return "image/png";
  if (hex.startsWith("47494638")) return "image/gif";
  if (buf.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (buf.subarray(4, 8).toString("ascii") === "ftyp") return "image/heic";
  return "image/jpeg";
}

/** Tải các ảnh của một tin khách gửi về kho mã hoá. Trả số ảnh đã lưu. */
export async function downloadMessageImages(messageId: string): Promise<number> {
  const msg = await prisma.chatMessage.findUnique({
    where: { id: messageId },
    include: { attachments: true },
  });
  if (!msg || msg.direction !== MessageDirection.IN) return 0;
  const maxBytes = (await getSettingNumber("chat.maxImageMb")) * 1024 * 1024;
  let stored = 0;
  for (const att of msg.attachments) {
    if (att.kind !== "IMAGE" || att.storageKey || !att.url) continue;
    try {
      const buf = await downloadImage(att.url, maxBytes);
      if (!buf) continue;
      const file = putEncrypted(`chat/${msg.conversationId}`, att.fileName || "anh-chat.jpg", buf);
      await prisma.messageAttachment.update({
        where: { id: att.id },
        data: { storageKey: file.storageKey, encIv: file.iv, encTag: file.tag, size: file.size, mimeType: mimeOf(buf) },
      });
      stored++;
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err), attachmentId: att.id }, "[chat-media] không tải được ảnh");
    }
  }
  return stored;
}

/**
 * Gắn các ảnh đã tải của hội thoại (chưa lưu hồ sơ) vào bộ ảnh CHAT của khách.
 * Mỗi tin nhắn một bộ ảnh. Gọi khi nhận tin (hội thoại đã gắn hồ sơ) và khi
 * vừa gắn hồ sơ cho hội thoại (ảnh "chờ gắn").
 */
export async function attachPendingChatPhotos(conversationId: string, actor?: { id: string; name: string } | null): Promise<number> {
  const conv = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { id: true, customerId: true, branchId: true, channel: true, title: true },
  });
  if (!conv?.customerId) return 0;
  const branchId =
    conv.branchId ??
    (
      await prisma.customerBranchLink.findFirst({
        where: { customerId: conv.customerId },
        orderBy: [{ isPrimary: "desc" }, { firstSeenAt: "asc" }],
      })
    )?.branchId;
  if (!branchId) return 0;

  const pending = await prisma.messageAttachment.findMany({
    where: {
      kind: "IMAGE",
      savedPhotoSetId: null,
      storageKey: { not: null },
      message: { conversationId, direction: MessageDirection.IN },
    },
    include: { message: { select: { id: true, createdAt: true } } },
    orderBy: { createdAt: "asc" },
    take: 200,
  });
  if (!pending.length) return 0;

  const byMessage = new Map<string, typeof pending>();
  for (const a of pending) byMessage.set(a.messageId, [...(byMessage.get(a.messageId) ?? []), a]);

  let saved = 0;
  for (const [messageId, atts] of byMessage) {
    const photos = atts.map((a) => {
      const data = getDecrypted(a.storageKey!, a.encIv!, a.encTag!);
      const copy = putEncrypted(`photos/${conv.customerId}`, a.fileName || "anh-chat.jpg", data);
      return {
        storageKey: copy.storageKey,
        fileName: a.fileName || "anh-chat.jpg",
        mimeType: a.mimeType ?? "image/jpeg",
        size: copy.size,
        encIv: copy.iv,
        encTag: copy.tag,
      };
    });
    const set = await prisma.photoSet.create({
      data: {
        customerId: conv.customerId,
        branchId,
        stage: PhotoStage.CHAT,
        note: `Ảnh khách gửi qua ${conv.channel}`,
        takenAt: atts[0].message.createdAt,
        takenById: actor?.id ?? null,
        sourceMessageId: messageId,
        photos: { create: photos },
      },
    });
    await prisma.messageAttachment.updateMany({
      where: { id: { in: atts.map((a) => a.id) } },
      data: { savedPhotoSetId: set.id },
    });
    saved += photos.length;
  }
  if (saved) await applyStageEventSafe(conv.customerId, StageEvent.PHOTO, { actor });
  return saved;
}

/** Xử lý đầy đủ một tin mới: tải ảnh, rồi lưu hồ sơ nếu đã gắn khách. */
export async function ingestMessageMedia(messageId: string): Promise<void> {
  if (!(await getSettingBool("chat.autoSavePhotos"))) return;
  const stored = await downloadMessageImages(messageId);
  if (!stored) return;
  const msg = await prisma.chatMessage.findUnique({ where: { id: messageId }, select: { conversationId: true } });
  if (msg) await attachPendingChatPhotos(msg.conversationId);
}

/** Chạy nền, không chặn phản hồi webhook. Test gọi thẳng ingestMessageMedia. */
export function scheduleMediaIngest(messageIds: string[]): void {
  if (!messageIds.length) return;
  setImmediate(() => {
    void (async () => {
      for (const id of messageIds) {
        try {
          await ingestMessageMedia(id);
        } catch (err) {
          logger.warn({ err: err instanceof Error ? err.message : String(err), messageId: id }, "[chat-media] lỗi xử lý ảnh");
        }
      }
    })();
  });
}

/** Lúc gắn hồ sơ: tải nốt ảnh chưa tải được rồi lưu vào hồ sơ. */
export async function ingestConversationOnLink(conversationId: string, actor?: { id: string; name: string } | null): Promise<number> {
  if (!(await getSettingBool("chat.autoSavePhotos"))) return 0;
  const msgs = await prisma.chatMessage.findMany({
    where: {
      conversationId,
      direction: MessageDirection.IN,
      attachments: { some: { kind: "IMAGE", storageKey: null, url: { not: null } } },
    },
    select: { id: true },
    take: 50,
  });
  for (const m of msgs) await downloadMessageImages(m.id);
  return attachPendingChatPhotos(conversationId, actor);
}
