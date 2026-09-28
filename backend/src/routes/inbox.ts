import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { asyncHandler, HttpError } from "../middleware/errorHandler";
import { requireAuth, currentUser } from "../middleware/auth";
import { requirePermission, scopedWhere, assertInScope, notFound, phoneFor } from "../middleware/rbac";
import { writeAudit } from "../lib/audit";
import { emitTo, roomFor } from "../socket";
import { sendZaloMessage } from "../services/zalo";
import {
  AuditAction,
  ActivityType,
  ConversationKind,
  MessageDirection,
  MessageStatus,
  MessageType,
  FunnelStage,
} from "../types/enums";

// HỘP THƯ ZALO TẬP TRUNG — màn hình lõi (mục 6 Giai đoạn 1).
// Ba cột của prototype: danh sách hội thoại | khung chat | hồ sơ khách.

const router = Router();
router.use(requireAuth);

const CONV_SCOPE = { ownerFields: ["assignedToId"], branchField: "branchId" };

/**
 * Customer.interest lưu dạng chuỗi JSON (SQLite không có cột mảng). Mọi
 * endpoint trả khách ra ngoài đều phải bung về mảng thật, nếu không tầng giao
 * diện nhận được chuỗi và `.map` sẽ nổ.
 */
function parseInterest(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

// GET /api/conversations?kind=CUSTOMER|GROUP&q=&unread=1
router.get(
  "/",
  requirePermission("inbox.read"),
  asyncHandler(async (req, res) => {
    const { where } = scopedWhere(req, "inbox.read", CONV_SCOPE);
    const filters: Record<string, unknown> = { ...where };

    if (req.query.kind) filters.kind = String(req.query.kind);
    if (req.query.unread === "1") filters.unreadCount = { gt: 0 };
    if (req.query.assignedToId) filters.assignedToId = String(req.query.assignedToId);
    if (req.query.q) {
      const q = String(req.query.q).trim();
      filters.OR = [
        { title: { contains: q } },
        { customer: { phone: { contains: q.replace(/\s/g, "") } } },
        { customer: { name: { contains: q } } },
      ];
    }

    const conversations = await prisma.conversation.findMany({
      where: filters,
      orderBy: [{ lastMessageAt: "desc" }, { updatedAt: "desc" }],
      take: Math.min(Number(req.query.limit ?? 100), 300),
      include: {
        customer: { select: { id: true, name: true, phone: true, stage: true, code: true } },
        assignedTo: { select: { id: true, name: true } },
        branch: { select: { id: true, code: true, shortName: true } },
      },
    });

    res.json(
      conversations.map((c) => ({
        ...c,
        customer: c.customer ? { ...c.customer, phone: phoneFor(req, c.customer.phone) } : null,
      }))
    );
  })
);

async function loadConversation(req: Parameters<typeof requireAuth>[0], id: string) {
  const conv = await prisma.conversation.findUnique({
    where: { id },
    include: {
      customer: {
        include: {
          assignedTo: { select: { id: true, name: true } },
          telesale: { select: { id: true, name: true } },
          channel: { select: { id: true, name: true } },
        },
      },
      assignedTo: { select: { id: true, name: true } },
      branch: { select: { id: true, code: true, name: true, shortName: true } },
    },
  });
  assertInScope(req, "inbox.read", conv as unknown as Record<string, unknown>, CONV_SCOPE);
  return conv!;
}

// GET /api/conversations/:id — kèm dữ liệu cột 3 (hồ sơ khách)
router.get(
  "/:id",
  requirePermission("inbox.read"),
  asyncHandler(async (req, res) => {
    const conv = await loadConversation(req, req.params.id);

    let sidebar: Record<string, unknown> = {};
    if (conv.customerId) {
      const [nextAppointment, debtAgg, paidAgg] = await Promise.all([
        prisma.appointment.findFirst({
          where: {
            customerId: conv.customerId,
            startAt: { gte: new Date() },
            status: { notIn: ["CANCELLED", "NO_SHOW"] },
          },
          orderBy: { startAt: "asc" },
          include: { doctor: { select: { name: true } }, room: { select: { name: true } } },
        }),
        prisma.invoice.aggregate({
          where: {
            customerId: conv.customerId,
            status: { in: ["ISSUED", "PARTIAL", "OVERDUE"] },
          },
          _sum: { amount: true, paidAmount: true },
          _min: { dueDate: true },
        }),
        prisma.payment.aggregate({
          where: { customerId: conv.customerId },
          _sum: { amount: true },
        }),
      ]);

      sidebar = {
        nextAppointment,
        debt: (debtAgg._sum.amount ?? 0) - (debtAgg._sum.paidAmount ?? 0),
        debtDueDate: debtAgg._min.dueDate,
        totalPaid: paidAgg._sum.amount ?? 0,
      };
    }

    res.json({
      ...conv,
      customer: conv.customer
        ? {
            ...conv.customer,
            phone: phoneFor(req, conv.customer.phone),
            interest: parseInterest(conv.customer.interest),
          }
        : null,
      ...sidebar,
    });
  })
);

// GET /api/conversations/:id/messages?cursor=&limit=
router.get(
  "/:id/messages",
  requirePermission("inbox.read"),
  asyncHandler(async (req, res) => {
    await loadConversation(req, req.params.id);

    const limit = Math.min(Number(req.query.limit ?? 50), 200);
    const cursor = req.query.cursor as string | undefined;

    const messages = await prisma.chatMessage.findMany({
      where: { conversationId: req.params.id },
      orderBy: { createdAt: "desc" },
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      include: { attachments: true },
    });

    const hasMore = messages.length > limit;
    const page = hasMore ? messages.slice(0, limit) : messages;

    res.json({
      // Trả về theo thứ tự thời gian tăng dần cho khung chat.
      items: page.reverse(),
      nextCursor: hasMore ? page[0]?.id : null,
    });
  })
);

/**
 * POST /api/conversations/:id/messages
 * Gửi tin. Ghi vào CSDL trước rồi mới gọi Zalo: nếu Zalo lỗi, tin vẫn còn với
 * trạng thái FAILED để nhân viên thấy và gửi lại, thay vì biến mất.
 */
router.post(
  "/:id/messages",
  requirePermission("inbox.update"),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        content: z.string().min(1).max(4000),
        type: z.nativeEnum(MessageType).optional(),
      })
      .parse(req.body);

    const conv = await loadConversation(req, req.params.id);
    const me = currentUser(req);

    const message = await prisma.chatMessage.create({
      data: {
        conversationId: conv.id,
        direction: MessageDirection.OUT,
        type: body.type ?? MessageType.TEXT,
        content: body.content,
        senderUserId: me.id,
        senderName: me.name,
        status: MessageStatus.PENDING,
      },
    });

    const result = await sendZaloMessage(conv, body.content);

    const saved = await prisma.chatMessage.update({
      where: { id: message.id },
      data: {
        status: result.ok ? MessageStatus.SENT : MessageStatus.FAILED,
        externalId: result.externalId ?? null,
        errorMessage: result.ok ? null : result.error,
      },
      include: { attachments: true },
    });

    await prisma.conversation.update({
      where: { id: conv.id },
      data: {
        lastMessageAt: saved.createdAt,
        lastMessagePreview: body.content.slice(0, 160),
      },
    });

    // Khách "Mới" mà mình vừa nhắn thì tự chuyển sang "Đã liên hệ" — hành vi
    // này có trong prototype (hàm send()).
    if (conv.customerId && conv.customer?.stage === FunnelStage.MOI) {
      await prisma.customer.update({
        where: { id: conv.customerId },
        data: {
          stage: FunnelStage.LIENHE,
          lastContactAt: new Date(),
          activities: {
            create: {
              type: ActivityType.STAGE_CHANGE,
              content: `${me.name} nhắn tin Zalo — giai đoạn: Mới → Đã liên hệ`,
              userId: me.id,
              userName: me.name,
            },
          },
        },
      });
    } else if (conv.customerId) {
      await prisma.customer.update({
        where: { id: conv.customerId },
        data: { lastContactAt: new Date() },
      });
    }

    emitTo(roomFor.conversation(conv.id), "message:new", saved);
    if (conv.branchId) emitTo(roomFor.branch(conv.branchId), "conversation:updated", { id: conv.id });

    res.status(201).json(saved);
  })
);

// POST /api/conversations/:id/read
router.post(
  "/:id/read",
  requirePermission("inbox.read"),
  asyncHandler(async (req, res) => {
    await loadConversation(req, req.params.id);
    await prisma.conversation.update({ where: { id: req.params.id }, data: { unreadCount: 0 } });
    res.json({ ok: true });
  })
);

// POST /api/conversations/:id/assign — ô "Telesale phụ trách" ở cột 3
router.post(
  "/:id/assign",
  requirePermission("inbox.update"),
  asyncHandler(async (req, res) => {
    const { userId } = z.object({ userId: z.string().uuid().nullable() }).parse(req.body);
    const conv = await loadConversation(req, req.params.id);

    const updated = await prisma.conversation.update({
      where: { id: conv.id },
      data: { assignedToId: userId },
      include: { assignedTo: { select: { id: true, name: true } } },
    });

    await writeAudit({
      req,
      action: AuditAction.UPDATE,
      entity: "Conversation",
      entityId: conv.id,
      branchId: conv.branchId,
      summary: `Gán hội thoại "${conv.title}" cho ${updated.assignedTo?.name ?? "— chưa phân công —"}`,
    });

    emitTo(roomFor.conversation(conv.id), "conversation:assigned", updated);
    res.json(updated);
  })
);

// POST /api/conversations/:id/link-customer — gắn hội thoại vào hồ sơ khách
router.post(
  "/:id/link-customer",
  requirePermission("inbox.update"),
  asyncHandler(async (req, res) => {
    const { customerId } = z.object({ customerId: z.string().uuid() }).parse(req.body);
    const conv = await loadConversation(req, req.params.id);

    const customer = await prisma.customer.findUnique({ where: { id: customerId } });
    if (!customer) throw notFound("Không tìm thấy khách");
    if (conv.kind === ConversationKind.GROUP) {
      throw new HttpError(400, "Hội thoại nhóm nội bộ không gắn được vào hồ sơ khách");
    }

    const updated = await prisma.conversation.update({
      where: { id: conv.id },
      data: { customerId, title: customer.name },
    });

    // Hội thoại Zalo mang theo zaloUserId — ghi ngược vào hồ sơ khách để lần
    // sau webhook tự tìm đúng khách.
    if (conv.externalId && !customer.zaloUserId) {
      await prisma.customer.update({
        where: { id: customerId },
        data: { zaloUserId: conv.externalId },
      }).catch(() => undefined); // zaloUserId unique — bỏ qua nếu đã thuộc khách khác
    }

    await writeAudit({
      req,
      action: AuditAction.UPDATE,
      entity: "Conversation",
      entityId: conv.id,
      summary: `Gắn hội thoại "${conv.title}" vào hồ sơ khách ${customer.code}`,
    });
    res.json(updated);
  })
);

// --------------------------------------------------------------- QUICK REPLY

router.get(
  "/quick-replies/all",
  requirePermission("inbox.read"),
  asyncHandler(async (_req, res) => {
    res.json(await prisma.quickReply.findMany({ where: { active: true }, orderBy: { title: "asc" } }));
  })
);

router.post(
  "/quick-replies",
  requirePermission("inbox.create"),
  asyncHandler(async (req, res) => {
    const body = z
      .object({ title: z.string().min(2), content: z.string().min(2), category: z.string().optional() })
      .parse(req.body);
    res.status(201).json(await prisma.quickReply.create({ data: body }));
  })
);

router.delete(
  "/quick-replies/:id",
  requirePermission("inbox.delete"),
  asyncHandler(async (req, res) => {
    await prisma.quickReply.update({ where: { id: req.params.id }, data: { active: false } });
    res.json({ ok: true });
  })
);

export default router;
