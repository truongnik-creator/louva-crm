import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { asyncHandler, HttpError } from "../middleware/errorHandler";
import { requireAuth, currentUser } from "../middleware/auth";
import { requirePermission, notFound } from "../middleware/rbac";
import { encryptNullable } from "../lib/crypto";
import { writeAudit } from "../lib/audit";
import { emitTo, roomFor } from "../socket";
import {
  fetchConversations,
  fetchMessages,
  fetchPages,
  normalizePlatform,
  resolveToken,
} from "../services/pancake";
import {
  AuditAction,
  ConversationKind,
  MessageDirection,
  MessageStatus,
  MessageType,
} from "../types/enums";

// Cấu hình và đồng bộ Pancake.
//
// Đồng bộ theo kiểu KÉO (pull) chứ không chỉ dựa vào webhook: webhook có thể
// rớt, và phòng khám cần chắc chắn không sót tin của khách. Mỗi lần đồng bộ đều
// idempotent theo pancakeConversationId / externalId của tin nhắn.

const router = Router();
router.use(requireAuth);

router.get(
  "/configs",
  requirePermission("settings.read"),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const rows = await prisma.pancakeConfig.findMany({
      where: { OR: [{ branchId: null }, { branchId: { in: me.branchIds } }] },
      include: {
        branch: { select: { id: true, name: true } },
        pages: {
          include: { channel: { select: { id: true, name: true } } },
          orderBy: { name: "asc" },
        },
      },
    });

    // Không bao giờ trả token ra ngoài, kể cả dạng mã hoá.
    res.json(
      rows.map((r) => ({
        id: r.id,
        label: r.label,
        branch: r.branch,
        active: r.active,
        connected: Boolean(r.accessTokenEnc),
        lastSyncAt: r.lastSyncAt,
        lastSyncNote: r.lastSyncNote,
        pages: r.pages,
      }))
    );
  })
);

router.put(
  "/configs",
  requirePermission("settings.update"),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        id: z.string().uuid().optional(),
        label: z.string().min(1),
        accessToken: z.string().min(10).optional(),
        webhookSecret: z.string().optional(),
        branchId: z.string().uuid().nullable().optional(),
        active: z.boolean().optional(),
      })
      .parse(req.body);

    if (!body.id && !body.accessToken) {
      throw new HttpError(400, "Cần API token Pancake khi thêm mới");
    }

    const data = {
      label: body.label,
      branchId: body.branchId ?? null,
      active: body.active ?? true,
      ...(body.accessToken ? { accessTokenEnc: encryptNullable(body.accessToken)! } : {}),
      ...(body.webhookSecret !== undefined
        ? { webhookSecretEnc: encryptNullable(body.webhookSecret) }
        : {}),
    };

    const config = body.id
      ? await prisma.pancakeConfig.update({ where: { id: body.id }, data })
      : await prisma.pancakeConfig.create({
          data: { ...data, accessTokenEnc: encryptNullable(body.accessToken!)! },
        });

    await writeAudit({
      req,
      action: body.id ? AuditAction.UPDATE : AuditAction.CREATE,
      entity: "PancakeConfig",
      entityId: config.id,
      summary: `${body.id ? "Cập nhật" : "Thêm"} kết nối Pancake "${config.label}"`,
    });

    res.json({ id: config.id, ok: true });
  })
);

/** POST /api/pancake/:id/discover-pages — hỏi Pancake xem tài khoản có trang nào. */
router.post(
  "/:id/discover-pages",
  requirePermission("settings.update"),
  asyncHandler(async (req, res) => {
    const token = await resolveToken(req.params.id);
    if (!token) throw new HttpError(400, "Kết nối Pancake chưa có token hoặc đã tắt");

    const pages = await fetchPages(token);
    let created = 0;

    for (const p of pages) {
      const platform = normalizePlatform(p.platform);
      const existing = await prisma.pancakePage.findUnique({ where: { pageId: String(p.id) } });
      if (existing) {
        await prisma.pancakePage.update({
          where: { id: existing.id },
          data: { name: p.name, platform },
        });
        continue;
      }
      await prisma.pancakePage.create({
        data: { configId: req.params.id, pageId: String(p.id), name: p.name, platform },
      });
      created++;
    }

    await writeAudit({
      req,
      action: AuditAction.UPDATE,
      entity: "PancakeConfig",
      entityId: req.params.id,
      summary: `Dò trang Pancake: tìm thấy ${pages.length}, thêm mới ${created}`,
    });

    res.json({ found: pages.length, created });
  })
);

router.patch(
  "/pages/:id",
  requirePermission("settings.update"),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        channelId: z.string().uuid().nullable().optional(),
        branchId: z.string().uuid().nullable().optional(),
        active: z.boolean().optional(),
      })
      .parse(req.body);
    res.json(await prisma.pancakePage.update({ where: { id: req.params.id }, data: body }));
  })
);

/**
 * POST /api/pancake/:id/sync — kéo hội thoại và tin nhắn về CRM.
 *
 * Idempotent: hội thoại khử trùng theo pancakeConversationId, tin nhắn khử
 * trùng theo externalId. Chạy lại nhiều lần không nhân bản dữ liệu.
 */
router.post(
  "/:id/sync",
  requirePermission("inbox.update"),
  asyncHandler(async (req, res) => {
    const token = await resolveToken(req.params.id);
    if (!token) throw new HttpError(400, "Kết nối Pancake chưa có token hoặc đã tắt");

    const config = await prisma.pancakeConfig.findUniqueOrThrow({
      where: { id: req.params.id },
      include: { pages: { where: { active: true } } },
    });
    if (!config.pages.length) {
      throw new HttpError(400, 'Chưa có trang nào. Bấm "Dò trang" trước.');
    }

    let convCount = 0;
    let msgCount = 0;
    const errors: string[] = [];

    for (const page of config.pages) {
      try {
        const conversations = await fetchConversations(token, page.pageId);

        for (const c of conversations) {
          const title = c.customer_name?.trim() || `Khách ${page.platform}`;

          // Tìm khách theo số điện thoại để hội thoại tự gắn vào hồ sơ sẵn có.
          const phone = c.customer_phone?.replace(/\D/g, "");
          const customer = phone
            ? await prisma.customer.findFirst({ where: { phone: { contains: phone.slice(-9) } } })
            : null;

          const conv = await prisma.conversation.upsert({
            where: { pancakeConversationId: String(c.id) },
            create: {
              pancakeConversationId: String(c.id),
              pancakePageId: page.id,
              branchId: page.branchId ?? config.branchId,
              kind: ConversationKind.CUSTOMER,
              channel: page.platform,
              title,
              customerId: customer?.id ?? null,
              unreadCount: c.unread_count ?? 0,
              lastMessageAt: c.updated_at ? new Date(c.updated_at) : new Date(),
              lastMessagePreview: c.snippet?.slice(0, 160),
            },
            update: {
              title,
              unreadCount: c.unread_count ?? 0,
              lastMessageAt: c.updated_at ? new Date(c.updated_at) : new Date(),
              lastMessagePreview: c.snippet?.slice(0, 160),
              ...(customer && { customerId: customer.id }),
            },
          });
          convCount++;

          const messages = await fetchMessages(token, page.pageId, String(c.id));
          for (const m of messages) {
            const externalId = String(m.id);
            const exists = await prisma.chatMessage.findFirst({ where: { externalId } });
            if (exists) continue;

            await prisma.chatMessage.create({
              data: {
                conversationId: conv.id,
                externalId,
                direction: m.from_customer ? MessageDirection.IN : MessageDirection.OUT,
                type: MessageType.TEXT,
                content: m.message ?? "[Nội dung không đọc được]",
                senderName: m.sender_name ?? (m.from_customer ? title : null),
                status: MessageStatus.DELIVERED,
                createdAt: m.inserted_at ? new Date(m.inserted_at) : new Date(),
              },
            });
            msgCount++;
          }

          if (conv.branchId) {
            emitTo(roomFor.branch(conv.branchId), "conversation:updated", { id: conv.id });
          }
        }

        await prisma.pancakePage.update({
          where: { id: page.id },
          data: { lastSyncAt: new Date() },
        });
      } catch (err) {
        errors.push(`${page.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const note = errors.length
      ? `${convCount} hội thoại, ${msgCount} tin mới. Lỗi: ${errors.join(" | ")}`
      : `${convCount} hội thoại, ${msgCount} tin mới`;

    await prisma.pancakeConfig.update({
      where: { id: config.id },
      data: { lastSyncAt: new Date(), lastSyncNote: note },
    });

    await writeAudit({
      req,
      action: AuditAction.UPDATE,
      entity: "PancakeConfig",
      entityId: config.id,
      summary: `Đồng bộ Pancake: ${note}`,
    });

    res.json({ conversations: convCount, messages: msgCount, errors });
  })
);

export default router;
