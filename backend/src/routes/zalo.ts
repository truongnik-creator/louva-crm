import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { env } from "../lib/env";
import { asyncHandler, HttpError } from "../middleware/errorHandler";
import { requireAuth, currentUser } from "../middleware/auth";
import { requirePermission, notFound } from "../middleware/rbac";
import { encryptNullable } from "../lib/crypto";
import { writeAudit } from "../lib/audit";
import { emitTo, roomFor } from "../socket";
import {
  buildAuthorizeUrl,
  exchangeCodeForToken,
  findOAConfigByOaId,
  resolveOAConfig,
  saveOATokens,
  verifyWebhookSignature,
} from "../services/zalo";
import {
  AuditAction,
  ConversationChannel,
  ConversationKind,
  MessageDirection,
  MessageStatus,
  MessageType,
} from "../types/enums";

// Cấu hình nhiều Official Account (mỗi cơ sở một OA) + webhook.
//
// Webhook là điểm vào CÔNG KHAI nên có ba lớp bảo vệ bắt buộc:
//   1. Xác thực HMAC trên RAW body.
//   2. Idempotent: mỗi event_id chỉ xử lý đúng một lần (bảng ZaloWebhookEvent).
//   3. Không bao giờ trả lỗi 5xx cho Zalo khi lỗi nằm ở phía ta — nếu không
//      Zalo sẽ gửi lại liên tục.

const router = Router();

// ------------------------------------------------------------- CẤU HÌNH OA
// (các route quản trị, cần đăng nhập)

const adminRouter = Router();
adminRouter.use(requireAuth);

adminRouter.get(
  "/oa-configs",
  requirePermission("settings.read"),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const rows = await prisma.zaloOAConfig.findMany({
      where: { OR: [{ branchId: null }, { branchId: { in: me.branchIds } }] },
      include: { branch: { select: { id: true, code: true, name: true } } },
      orderBy: { label: "asc" },
    });

    // KHÔNG trả secret ra ngoài, kể cả dạng mã hoá. Chỉ báo đã cấu hình hay chưa.
    res.json(
      rows.map((r) => ({
        id: r.id,
        label: r.label,
        oaId: r.oaId,
        appId: r.appId,
        branch: r.branch,
        active: r.active,
        connected: Boolean(r.accessTokenEnc),
        tokenExpiresAt: r.tokenExpiresAt,
        hasWebhookSecret: Boolean(r.webhookSecretEnc),
        updatedAt: r.updatedAt,
      }))
    );
  })
);

adminRouter.put(
  "/oa-configs",
  requirePermission("settings.update"),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        id: z.string().uuid().optional(),
        label: z.string().min(1),
        oaId: z.string().min(1),
        appId: z.string().min(1),
        appSecret: z.string().min(1).optional(),
        webhookSecret: z.string().optional(),
        branchId: z.string().uuid().nullable().optional(),
        active: z.boolean().optional(),
      })
      .parse(req.body);

    const data = {
      label: body.label,
      oaId: body.oaId,
      appId: body.appId,
      branchId: body.branchId ?? null,
      active: body.active ?? true,
      ...(body.appSecret ? { appSecretEnc: encryptNullable(body.appSecret)! } : {}),
      ...(body.webhookSecret !== undefined
        ? { webhookSecretEnc: encryptNullable(body.webhookSecret) }
        : {}),
    };

    const config = body.id
      ? await prisma.zaloOAConfig.update({ where: { id: body.id }, data })
      : await prisma.zaloOAConfig.create({
          data: { ...data, appSecretEnc: data.appSecretEnc ?? encryptNullable(body.appSecret ?? "")! },
        });

    await writeAudit({
      req,
      action: body.id ? AuditAction.UPDATE : AuditAction.CREATE,
      entity: "ZaloOAConfig",
      entityId: config.id,
      branchId: config.branchId,
      summary: `${body.id ? "Cập nhật" : "Thêm"} Official Account ${config.label} (${config.oaId})`,
    });

    res.json({ id: config.id, ok: true });
  })
);

adminRouter.get(
  "/oauth/authorize-url",
  requirePermission("settings.update"),
  asyncHandler(async (req, res) => {
    const configId = z.string().uuid().parse(req.query.configId);
    const config = await resolveOAConfig(configId);
    if (!config) throw notFound("Không tìm thấy cấu hình OA");
    if (!env.zaloOauthRedirectUri) {
      throw new HttpError(400, "Chưa đặt ZALO_OAUTH_REDIRECT_URI trong cấu hình máy chủ");
    }
    res.json({ url: buildAuthorizeUrl(config.appId, env.zaloOauthRedirectUri, config.id) });
  })
);

// ---------------------------------------------------------- OAUTH CALLBACK
// Zalo gọi về, không có Authorization header — dùng `state` = configId.

router.get(
  "/oauth/callback",
  asyncHandler(async (req, res) => {
    const code = req.query.code as string | undefined;
    const state = req.query.state as string | undefined;
    if (!code || !state) return res.status(400).send("Thiếu tham số code hoặc state");

    const config = await resolveOAConfig(state);
    if (!config) return res.status(400).send("Cấu hình OA không tồn tại");

    try {
      const tokens = await exchangeCodeForToken(config.appId, config.appSecret, code);
      await saveOATokens(config.id, {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresInSec: Number(tokens.expires_in) || undefined,
      });
      res.send("Đã kết nối Official Account thành công. Bạn có thể đóng cửa sổ này.");
    } catch (err) {
      console.error("[zalo] OAuth callback lỗi:", err);
      res.status(500).send("Kết nối Official Account thất bại. Xem log máy chủ.");
    }
  })
);

// ------------------------------------------------------------------ WEBHOOK

interface ZaloEvent {
  app_id?: string;
  oa_id?: string;
  event_name?: string;
  timestamp?: string;
  message?: { msg_id?: string; text?: string; attachments?: unknown[] };
  sender?: { id?: string };
  recipient?: { id?: string };
  user_id_by_app?: string;
  follower?: { id?: string };
}

router.post(
  "/webhook",
  asyncHandler(async (req, res) => {
    const raw = req.rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));
    const event = req.body as ZaloEvent;

    const oaId = event.oa_id ?? "";
    const config = oaId ? await findOAConfigByOaId(oaId) : null;

    // Không tìm thấy OA hoặc chữ ký sai: trả 200 để Zalo khỏi gửi lại vô hạn,
    // nhưng KHÔNG xử lý gì cả và ghi lại để giám sát.
    if (!config) {
      console.warn(`[zalo] webhook cho OA lạ: ${oaId}`);
      return res.json({ ok: true });
    }

    const mac = (req.headers["x-zevent-signature"] as string | undefined) ?? undefined;
    const signatureOk = verifyWebhookSignature(
      config.appId,
      config.appSecret,
      raw,
      event.timestamp,
      mac
    );
    // Cho phép bỏ qua chữ ký ở môi trường phát triển để test webhook cục bộ,
    // nhưng KHÔNG BAO GIỜ ở production.
    if (!signatureOk && env.nodeEnv === "production") {
      console.warn("[zalo] webhook sai chữ ký, bỏ qua");
      return res.json({ ok: true });
    }

    const eventId = event.message?.msg_id ?? `${oaId}-${event.event_name}-${event.timestamp}`;

    // Idempotent: nếu event này đã ghi rồi thì thôi.
    const existing = await prisma.zaloWebhookEvent.findUnique({ where: { eventId } });
    if (existing) return res.json({ ok: true, duplicate: true });

    const record = await prisma.zaloWebhookEvent.create({
      data: {
        eventId,
        eventName: event.event_name ?? "unknown",
        payload: raw.toString("utf8").slice(0, 20000),
      },
    });

    try {
      await handleZaloEvent(event, config);
      await prisma.zaloWebhookEvent.update({
        where: { id: record.id },
        data: { processedAt: new Date() },
      });
    } catch (err) {
      console.error("[zalo] xử lý webhook lỗi:", err);
      await prisma.zaloWebhookEvent.update({
        where: { id: record.id },
        data: { error: err instanceof Error ? err.message : String(err) },
      });
    }

    res.json({ ok: true });
  })
);

async function handleZaloEvent(
  event: ZaloEvent,
  config: { id: string; branchId: string | null }
): Promise<void> {
  const isUserMessage = event.event_name?.startsWith("user_send");
  if (!isUserMessage) return;

  const senderId = event.sender?.id ?? event.user_id_by_app;
  if (!senderId) return;

  const text = event.message?.text ?? "[Tệp đính kèm]";

  // Tìm khách theo zaloUserId để hội thoại tự gắn vào hồ sơ sẵn có.
  const customer = await prisma.customer.findFirst({ where: { zaloUserId: senderId } });

  const conversation = await prisma.conversation.upsert({
    where: { externalId_oaConfigId: { externalId: senderId, oaConfigId: config.id } },
    create: {
      externalId: senderId,
      oaConfigId: config.id,
      branchId: config.branchId,
      kind: ConversationKind.CUSTOMER,
      channel: ConversationChannel.ZALO_OA,
      title: customer?.name ?? `Khách Zalo ${senderId.slice(-6)}`,
      customerId: customer?.id ?? null,
      unreadCount: 1,
      lastMessageAt: new Date(),
      lastMessagePreview: text.slice(0, 160),
    },
    update: {
      unreadCount: { increment: 1 },
      lastMessageAt: new Date(),
      lastMessagePreview: text.slice(0, 160),
    },
  });

  const message = await prisma.chatMessage.create({
    data: {
      conversationId: conversation.id,
      direction: MessageDirection.IN,
      type: event.message?.attachments?.length ? MessageType.IMAGE : MessageType.TEXT,
      content: text,
      senderName: conversation.title,
      status: MessageStatus.DELIVERED,
      externalId: event.message?.msg_id ?? null,
    },
  });

  if (conversation.customerId) {
    await prisma.customer.update({
      where: { id: conversation.customerId },
      data: { lastContactAt: new Date() },
    });
  }

  emitTo(roomFor.conversation(conversation.id), "message:new", message);
  if (conversation.branchId) {
    emitTo(roomFor.branch(conversation.branchId), "conversation:updated", {
      id: conversation.id,
      unreadCount: conversation.unreadCount,
      lastMessagePreview: conversation.lastMessagePreview,
    });
  }
}

// Mount SAU các route công khai: adminRouter gắn requireAuth cho mọi đường dẫn
// nó nhận, nên nếu mount trước thì webhook và OAuth callback (Zalo gọi vào, đâu
// có Authorization header) sẽ bị chặn 401.
router.use("/", adminRouter);

export default router;
