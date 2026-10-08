import { Router } from "express";
import { safely, syncLeadsForCustomer } from "../lib/lead-funnel";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { pageQuery, parsePagination, CATALOG_PAGE } from "../lib/pagination";
import { asyncHandler, HttpError } from "../middleware/errorHandler";
import { requireAuth, currentUser } from "../middleware/auth";
import {
  requirePermission,
  scopedWhere,
  assertInScope,
  notFound,
  phoneFor,
  hasPermission,
} from "../middleware/rbac";
import { writeAudit, writeAccessLog } from "../lib/audit";
import { getDecrypted, putEncrypted } from "../lib/storage";
import { sniffFileKind } from "../lib/upload";
import {
  TEMPLATE_VARIABLES,
  hasUnresolvedPlaceholder,
  renderTemplate,
  unknownVariables,
} from "../lib/quick-reply-vars";
import { emitTo, roomFor } from "../socket";
import { sendToChannel, channelOf } from "../services/outbound";
import { applyStageEventSafe } from "../lib/stages";
import { ingestConversationOnLink } from "../lib/chat-media";
import { extractFromConversation } from "../lib/extract";
import { buildLocationMessage, buildPriceMessage } from "../lib/canned-messages";
import { normalizeVnPhone } from "../lib/phone";
import { logger } from "../lib/logger";
import { autoAssignConversation, noteOutbound, salesOnShift } from "../lib/inbox-routing";
import { latestSummary, recordSuggestionSent, suggestReply, summarizeConversation } from "../lib/ai-assist";
import {
  AuditAction,
  AccessResourceType,
  ActivityType,
  ConversationKind,
  PhotoStage,
  MessageDirection,
  MessageStatus,
  MessageType,
  StageEvent,
} from "../types/enums";

// HỘP THƯ ZALO TẬP TRUNG — màn hình lõi (mục 6 Giai đoạn 1).
// Ba cột của prototype: danh sách hội thoại | khung chat | hồ sơ khách.

const router = Router();
router.use(requireAuth);

const CONV_SCOPE = { ownerFields: ["assignedToId"], branchField: "branchId" };

/** Trường tệp đính kèm được trả cho giao diện: không lộ khoá kho, IV, đường dẫn gốc. */
export const ATTACHMENT_PUBLIC = {
  id: true,
  kind: true,
  fileName: true,
  mimeType: true,
  size: true,
  savedPhotoSetId: true,
} as const;

/** F26: nhóm kênh cho bộ lọc và huy hiệu (Pancake lưu tên nền tảng, Zalo OA lưu mã riêng). */
const CHANNEL_GROUPS: Record<string, string[]> = {
  FB: ["FACEBOOK", "facebook", "INSTAGRAM", "instagram", "MESSENGER", "messenger"],
  ZALO: ["ZALO_OA", "ZALO_GROUP", "ZALO", "zalo"],
  TIKTOK: ["TIKTOK", "tiktok"],
};

function channelGroupOf(channel: string): string {
  for (const [group, list] of Object.entries(CHANNEL_GROUPS)) if (list.includes(channel)) return group;
  return "OTHER";
}

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
    // F26: bộ lọc của tôi, chưa phân công, theo kênh, đang chờ trả lời.
    if (req.query.mine === "1") filters.assignedToId = currentUser(req).id;
    if (req.query.unassigned === "1") filters.assignedToId = null;
    if (req.query.channel) {
      const group = CHANNEL_GROUPS[String(req.query.channel).toUpperCase()];
      filters.channel = { in: group ?? [String(req.query.channel)] };
    }
    if (req.query.waiting === "1") filters.waitingSince = { not: null };
    if (req.query.medical === "1") filters.medicalFlag = true;
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
      ...pageQuery(req.query, { defaultLimit: 100, maxLimit: 300 }),
      include: {
        customer: { select: { id: true, name: true, phone: true, stage: true, code: true } },
        assignedTo: { select: { id: true, name: true } },
        branch: { select: { id: true, code: true, shortName: true } },
        tags: { select: { tag: { select: { id: true, name: true, color: true } } } },
      },
    });

    const now = Date.now();
    res.json(
      conversations.map((c) => ({
        ...c,
        customer: c.customer ? { ...c.customer, phone: phoneFor(req, c.customer.phone) } : null,
        tags: c.tags.map((t) => t.tag),
        channelGroup: channelGroupOf(c.channel),
        waitingMinutes: c.waitingSince ? Math.max(0, Math.floor((now - c.waitingSince.getTime()) / 60_000)) : null,
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

    const pg = parsePagination(req.query, { defaultLimit: 50, maxLimit: 200 });
    const limit = pg.limit;
    const cursor = pg.cursor?.id;

    const messages = await prisma.chatMessage.findMany({
      where: { conversationId: req.params.id },
      orderBy: { createdAt: "desc" },
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      include: { attachments: { select: ATTACHMENT_PUBLIC } },
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

type LoadedConversation = Awaited<ReturnType<typeof loadConversation>>;

/**
 * Ghi tin vào CSDL trước rồi mới gọi kênh: nếu kênh lỗi, tin vẫn còn với trạng
 * thái FAILED để nhân viên thấy và gửi lại, thay vì biến mất. Kênh chọn theo
 * NGUỒN hội thoại (F5): Pancake trả lời qua Pancake, Zalo OA qua Zalo.
 */
async function deliverMessage(
  req: Parameters<typeof requireAuth>[0],
  conv: LoadedConversation,
  content: string,
  type: MessageType = MessageType.TEXT
) {
  // B12: không bao giờ để khách nhận "Chào {{ten_khach}}".
  if (hasUnresolvedPlaceholder(content)) {
    throw new HttpError(400, "Tin nhắn còn biến chưa điền dạng {{...}}. Sửa hoặc xoá phần đó trước khi gửi.");
  }
  const me = currentUser(req);
  const message = await prisma.chatMessage.create({
    data: {
      conversationId: conv.id,
      direction: MessageDirection.OUT,
      type,
      content,
      senderUserId: me.id,
      senderName: me.name,
      status: MessageStatus.PENDING,
    },
  });

  const result = await sendToChannel(conv, content, { senderUserId: me.id });

  const saved = await prisma.chatMessage.update({
    where: { id: message.id },
    data: {
      status: result.ok ? MessageStatus.SENT : MessageStatus.FAILED,
      // Id tin phía kênh có thể đã được đồng bộ về trước: không để trùng khoá làm mất tin.
      externalId: result.externalId
        ? ((await prisma.chatMessage.findUnique({ where: { externalId: result.externalId }, select: { id: true } }))
            ? null
            : result.externalId)
        : null,
      errorMessage: result.ok ? null : result.error,
    },
    include: { attachments: { select: ATTACHMENT_PUBLIC } },
  });

  await prisma.conversation.update({
    where: { id: conv.id },
    data: { lastMessageAt: saved.createdAt, lastMessagePreview: content.slice(0, 160) },
  });
  // F26: đã trả lời thì khách hết chờ (đồng hồ chờ, quy tắc 1).
  if (result.ok) await noteOutbound(conv.id, saved.createdAt);

  if (conv.customerId) {
    await prisma.customer.update({ where: { id: conv.customerId }, data: { lastContactAt: new Date() } });
    // F1: đã nhắn tin với khách thì khách ít nhất ở bước Nhắn tin (chỉ tiến).
    if (result.ok) await applyStageEventSafe(conv.customerId, StageEvent.MESSAGE, { actor: { id: me.id, name: me.name } });
  }

  emitTo(roomFor.conversation(conv.id), "message:new", saved);
  if (conv.branchId) emitTo(roomFor.branch(conv.branchId), "conversation:updated", { id: conv.id });
  return { ...saved, channel: channelOf(conv) };
}

/** POST /api/conversations/:id/messages — gửi tin. */
router.post(
  "/:id/messages",
  requirePermission("inbox.update"),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        content: z.string().min(1).max(4000),
        type: z.nativeEnum(MessageType).optional(),
        /** AI2: tin này sửa từ gợi ý nào (ghi đối chiếu câu gợi ý và câu thực gửi). */
        suggestionId: z.string().uuid().optional(),
      })
      .parse(req.body);
    if (hasUnresolvedPlaceholder(body.content)) {
      throw new HttpError(400, "Tin nhắn còn biến chưa điền dạng {{...}}. Sửa hoặc xoá phần đó trước khi gửi.");
    }
    const conv = await loadConversation(req, req.params.id);
    const sent = await deliverMessage(req, conv, body.content, body.type ?? MessageType.TEXT);
    if (body.suggestionId) {
      await recordSuggestionSent({
        req,
        suggestionId: body.suggestionId,
        conversationId: conv.id,
        messageId: sent.id,
        sentText: body.content,
        branchId: conv.branchId,
      });
    }
    res.status(201).json(sent);
  })
);

// ------------------------------------------------ GỬI VỊ TRÍ, BẢNG GIÁ (F24)

const cannedKind = z.enum(["location", "price"]);

async function buildCanned(conv: LoadedConversation, kind: "location" | "price", serviceIds: string[] | undefined, fallbackBranchId: string | null) {
  const branchId = conv.branchId ?? fallbackBranchId;
  return kind === "location"
    ? { ...(await buildLocationMessage(branchId)), services: [] }
    : await buildPriceMessage({ branchId, serviceIds, customerInterest: conv.customer?.interest ?? null });
}

/** GET /api/conversations/:id/canned/:kind?serviceIds=a,b — xem trước tin mẫu. */
router.get(
  "/:id/canned/:kind",
  requirePermission("inbox.read"),
  asyncHandler(async (req, res) => {
    const kind = cannedKind.parse(req.params.kind);
    const serviceIds = typeof req.query.serviceIds === "string" && req.query.serviceIds
      ? z.array(z.string().uuid()).max(20).parse(req.query.serviceIds.split(","))
      : undefined;
    const conv = await loadConversation(req, req.params.id);
    res.json(await buildCanned(conv, kind, serviceIds, currentUser(req).activeBranchId));
  })
);

/** POST /api/conversations/:id/canned/:kind — gửi tin vị trí / bảng giá chuẩn (người bấm gửi). */
router.post(
  "/:id/canned/:kind",
  requirePermission("inbox.update"),
  asyncHandler(async (req, res) => {
    const kind = cannedKind.parse(req.params.kind);
    const body = z.object({ serviceIds: z.array(z.string().uuid()).max(20).optional() }).parse(req.body ?? {});
    const conv = await loadConversation(req, req.params.id);
    const built = await buildCanned(conv, kind, body.serviceIds, currentUser(req).activeBranchId);
    if (!built.content) {
      throw new HttpError(400, `Chưa đủ dữ liệu để gửi: thiếu ${built.missing.join(", ")}. Quản lý bổ sung ở Cài đặt.`);
    }
    const sent = await deliverMessage(req, conv, built.content, kind === "location" ? MessageType.LOCATION : MessageType.TEXT);
    res.status(201).json(sent);
  })
);

// ---------------------------------------------------- AI1: TÁCH THÔNG TIN

/**
 * POST /api/conversations/:id/extract — gợi ý SĐT, tên, nhu cầu, khu vực từ tin
 * khách. Regex SĐT luôn chạy; AI chỉ chạy khi đã cấu hình và khách đã đồng ý.
 * KHÔNG ghi gì vào hồ sơ.
 */
router.post(
  "/:id/extract",
  requirePermission("inbox.read"),
  asyncHandler(async (req, res) => {
    const conv = await loadConversation(req, req.params.id);
    if (conv.kind === ConversationKind.GROUP) throw new HttpError(400, "Hội thoại nhóm nội bộ không tách thông tin khách");
    const result = await extractFromConversation({
      req,
      conversationId: conv.id,
      customerId: conv.customerId,
      branchId: conv.branchId,
    });
    res.json({
      ...result,
      suggestion: { ...result.suggestion, phone: phoneFor(req, result.suggestion.phone) },
      regex: { phones: result.regex.phones.map((p) => phoneFor(req, p)) },
    });
  })
);

/**
 * POST /api/conversations/:id/extract/apply — người bấm "Áp dụng" thì mới ghi
 * vào hồ sơ đã gắn. Trùng SĐT với khách khác: trả 409 kèm hồ sơ trùng, không gộp.
 */
router.post(
  "/:id/extract/apply",
  requirePermission("customer.update"),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        phone: z.string().trim().max(30).optional().nullable(),
        name: z.string().trim().min(2).max(100).optional().nullable(),
        interest: z.string().trim().max(200).optional().nullable(),
        area: z.string().trim().max(100).optional().nullable(),
      })
      .parse(req.body);
    const conv = await loadConversation(req, req.params.id);
    if (!conv.customerId || !conv.customer) {
      throw new HttpError(400, "Hội thoại chưa gắn hồ sơ khách. Dùng Tạo nhanh để lập hồ sơ với thông tin gợi ý.");
    }
    const customer = conv.customer;
    const data: Record<string, unknown> = {};
    const changed: string[] = [];

    if (body.phone) {
      if (!hasPermission(req, "customer.view_phone")) throw new HttpError(403, "Không có quyền ghi số điện thoại khách");
      const normalized = normalizeVnPhone(body.phone);
      if (!normalized) throw new HttpError(400, "Số điện thoại không hợp lệ");
      const dup = await prisma.customer.findFirst({
        where: { phoneNormalized: normalized, mergedIntoId: null, id: { not: customer.id } },
        select: { id: true, code: true, name: true },
      });
      if (dup) {
        return res.status(409).json({
          error: `Số điện thoại đã có ở khách ${dup.name} (${dup.code}). Không tự gộp: kiểm tra rồi gộp ở màn Gộp hồ sơ trùng.`,
          duplicate: dup,
        });
      }
      if (customer.phoneNormalized !== normalized) {
        data.phone = body.phone;
        changed.push("SĐT");
      }
    }
    if (body.name && body.name !== customer.name) {
      data.name = body.name;
      changed.push("tên");
    }
    if (body.area && body.area !== customer.city) {
      data.city = body.area;
      changed.push("khu vực");
    }
    if (body.interest) {
      const current = parseInterest(customer.interest);
      if (!current.includes(body.interest)) {
        data.interest = JSON.stringify([...current, body.interest]);
        changed.push("dịch vụ quan tâm");
      }
    }
    if (!changed.length) return res.json({ ok: true, changed: [] });

    const me = currentUser(req);
    await prisma.customer.update({
      where: { id: customer.id },
      data: {
        ...data,
        activities: {
          create: {
            type: ActivityType.NOTE,
            content: `${me.name} áp dụng gợi ý tách từ tin nhắn: ${changed.join(", ")}`,
            userId: me.id,
            userName: me.name,
          },
        },
      },
    });
    await writeAudit({
      req,
      action: AuditAction.UPDATE,
      entity: "Customer",
      entityId: customer.id,
      summary: `Áp dụng gợi ý từ hộp thư cho khách ${customer.code}: ${changed.join(", ")}`,
      changes: Object.fromEntries(
        Object.keys(data).map((k) => [k, [k === "phone" ? "(ẩn)" : (customer as Record<string, unknown>)[k] ?? null, k === "phone" ? "(ẩn)" : data[k]]])
      ) as Record<string, [unknown, unknown]>,
    });
    res.json({ ok: true, changed });
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
      data: { assignedToId: userId, assignedAt: userId ? new Date() : null },
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

    // F15: lead của hội thoại (Pancake từ quảng cáo) thành khách: WON, mốc có SĐT, nguồn chiến dịch.
    await safely("đồng bộ lead khi gắn hội thoại", () => syncLeadsForCustomer(customerId, { leadId: conv.leadId }));

    // Hội thoại đã có tin khách nhắn: khách ít nhất ở bước Nhắn tin (F1).
    const me = currentUser(req);
    const hasInbound = await prisma.chatMessage.count({ where: { conversationId: conv.id, direction: MessageDirection.IN } });
    if (hasInbound) await applyStageEventSafe(customerId, StageEvent.MESSAGE, { actor: { id: me.id, name: me.name } });
    // F2: ảnh "chờ gắn hồ sơ" của hội thoại vào bộ ảnh CHAT của khách, chạy nền.
    void ingestConversationOnLink(conv.id, { id: me.id, name: me.name }).catch((err) =>
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, "[inbox] lưu ảnh chờ gắn lỗi")
    );
    res.json(updated);
  })
);

// ------------------------------------------------ F26: CHIA VÒNG, NHÃN, GHI CHÚ

/** POST /api/conversations/auto-assign — chia các hội thoại chưa phân công của cơ sở cho sale trong ca. */
router.post(
  "/auto-assign",
  requirePermission("inbox.manage_templates"),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const branchId = (req.body?.branchId as string | undefined) ?? me.activeBranchId;
    if (!branchId || !me.branchIds.includes(branchId)) throw notFound();
    const convs = await prisma.conversation.findMany({
      where: { branchId, assignedToId: null, kind: ConversationKind.CUSTOMER },
      orderBy: [{ waitingSince: "asc" }, { lastMessageAt: "desc" }],
      take: 200,
      select: { id: true },
    });
    let assigned = 0;
    for (const c of convs) if (await autoAssignConversation(c.id)) assigned++;
    await writeAudit({
      req,
      action: AuditAction.UPDATE,
      entity: "Conversation",
      branchId,
      summary: `Chia xoay vòng ${assigned}/${convs.length} hội thoại chưa phân công cho sale trong ca`,
    });
    res.json({ assigned, total: convs.length });
  })
);

/** GET /api/conversations/shift/on-duty — sale đang trong ca ở cơ sở đang làm việc. */
router.get(
  "/shift/on-duty",
  requirePermission("inbox.read"),
  asyncHandler(async (req, res) => {
    const branchId = (req.query.branchId as string) || currentUser(req).activeBranchId;
    if (!branchId) return res.json([]);
    res.json(await salesOnShift(branchId));
  })
);

router.get(
  "/:id/notes",
  requirePermission("inbox.read"),
  asyncHandler(async (req, res) => {
    const conv = await loadConversation(req, req.params.id);
    const [notes, tags] = await Promise.all([
      prisma.conversationNote.findMany({ where: { conversationId: conv.id }, orderBy: { createdAt: "desc" }, take: 100 }),
      prisma.conversationTag.findMany({ where: { conversationId: conv.id }, include: { tag: true } }),
    ]);
    res.json({ notes, tags: tags.map((t) => t.tag), medicalFlag: conv.medicalFlag });
  })
);

/** POST /api/conversations/:id/notes { content } — ghi chú nội bộ (khách không thấy). */
router.post(
  "/:id/notes",
  requirePermission("inbox.update"),
  asyncHandler(async (req, res) => {
    const { content } = z.object({ content: z.string().trim().min(1).max(2000) }).parse(req.body);
    const conv = await loadConversation(req, req.params.id);
    const me = currentUser(req);
    const note = await prisma.conversationNote.create({
      data: { conversationId: conv.id, userId: me.id, userName: me.name, content },
    });
    res.status(201).json(note);
  })
);

/** POST /api/conversations/:id/tags { name } — gắn nhãn (tạo nhãn mới nếu chưa có). */
router.post(
  "/:id/tags",
  requirePermission("inbox.update"),
  asyncHandler(async (req, res) => {
    const body = z
      .object({ name: z.string().trim().min(1).max(40), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional() })
      .parse(req.body);
    const conv = await loadConversation(req, req.params.id);
    const tag = await prisma.tag.upsert({
      where: { name: body.name },
      create: { name: body.name, ...(body.color ? { color: body.color } : {}) },
      update: {},
    });
    await prisma.conversationTag.upsert({
      where: { conversationId_tagId: { conversationId: conv.id, tagId: tag.id } },
      create: { conversationId: conv.id, tagId: tag.id },
      update: {},
    });
    res.status(201).json(tag);
  })
);

router.delete(
  "/:id/tags/:tagId",
  requirePermission("inbox.update"),
  asyncHandler(async (req, res) => {
    const conv = await loadConversation(req, req.params.id);
    await prisma.conversationTag.deleteMany({ where: { conversationId: conv.id, tagId: req.params.tagId } });
    res.json({ ok: true });
  })
);

/** POST /api/conversations/:id/medical-flag { flag } — bác sĩ xử lý xong thì gỡ cờ y khoa. */
router.post(
  "/:id/medical-flag",
  requirePermission("inbox.update"),
  asyncHandler(async (req, res) => {
    const { flag } = z.object({ flag: z.boolean() }).parse(req.body);
    const conv = await loadConversation(req, req.params.id);
    const updated = await prisma.conversation.update({
      where: { id: conv.id },
      data: { medicalFlag: flag, medicalFlagAt: flag ? new Date() : null },
    });
    await writeAudit({
      req,
      action: AuditAction.UPDATE,
      entity: "Conversation",
      entityId: conv.id,
      branchId: conv.branchId,
      summary: `${flag ? "Gắn" : "Gỡ"} cờ y khoa hội thoại "${conv.title}"`,
    });
    res.json({ id: updated.id, medicalFlag: updated.medicalFlag });
  })
);

// ------------------------------------------------ AI2 GỢI Ý, AI3 TÓM TẮT

/** POST /api/conversations/:id/suggest — gợi ý câu trả lời theo kịch bản (sale sửa rồi tự gửi). */
router.post(
  "/:id/suggest",
  requirePermission("inbox.update"),
  asyncHandler(async (req, res) => {
    const conv = await loadConversation(req, req.params.id);
    if (conv.kind === ConversationKind.GROUP) throw new HttpError(400, "Hội thoại nhóm nội bộ không dùng gợi ý trả lời");
    const me = currentUser(req);
    res.json(await suggestReply({ req, conversation: conv, user: { id: me.id, name: me.name } }));
  })
);

/** GET /api/conversations/:id/summary — tóm tắt AI gần nhất của hội thoại. */
router.get(
  "/:id/summary",
  requirePermission("inbox.read"),
  asyncHandler(async (req, res) => {
    const conv = await loadConversation(req, req.params.id);
    res.json(conv.customerId ? await latestSummary(conv.id, conv.customerId) : null);
  })
);

/** POST /api/conversations/:id/summary — AI3 tóm tắt và gợi ý bước tiếp theo, lưu vào lịch sử khách. */
router.post(
  "/:id/summary",
  requirePermission("inbox.read"),
  asyncHandler(async (req, res) => {
    const conv = await loadConversation(req, req.params.id);
    if (!conv.customerId) throw new HttpError(400, "Hội thoại chưa gắn hồ sơ khách: gắn hồ sơ trước khi tóm tắt");
    const me = currentUser(req);
    res.json(
      await summarizeConversation({
        req,
        conversation: { id: conv.id, customerId: conv.customerId, branchId: conv.branchId },
        user: { id: me.id, name: me.name },
      })
    );
  })
);

// --------------------------------------------------------------- QUICK REPLY

const quickReplySchema = z.object({
  title: z.string().trim().min(2, "Tên mẫu tối thiểu 2 ký tự").max(120),
  content: z.string().trim().min(2, "Nội dung mẫu tối thiểu 2 ký tự").max(4000),
  category: z.string().trim().max(60).optional().nullable(),
  active: z.boolean().optional(),
});

function assertKnownVariables(content: string | undefined): void {
  if (!content) return;
  const unknown = unknownVariables(content);
  if (unknown.length) {
    throw new HttpError(
      400,
      `Biến không có trong danh mục: ${unknown.map((u) => `{{${u}}}`).join(", ")}. Xem danh sách biến ở trang Mẫu tin nhanh.`
    );
  }
}

// GET /api/conversations/quick-replies/all?includeInactive=1
router.get(
  "/quick-replies/all",
  requirePermission("inbox.read"),
  asyncHandler(async (req, res) => {
    const includeInactive = req.query.includeInactive === "1" && hasPermission(req, "inbox.manage_templates");
    res.json(
      await prisma.quickReply.findMany({
        where: includeInactive ? {} : { active: true },
        orderBy: [{ category: "asc" }, { title: "asc" }],
        ...pageQuery(req.query, CATALOG_PAGE),
      })
    );
  })
);

// GET /api/conversations/quick-replies/variables — danh mục biến {{...}}
router.get(
  "/quick-replies/variables",
  requirePermission("inbox.read"),
  asyncHandler(async (_req, res) => {
    res.json(TEMPLATE_VARIABLES);
  })
);

router.post(
  "/quick-replies",
  requirePermission("inbox.manage_templates"),
  asyncHandler(async (req, res) => {
    const body = quickReplySchema.parse(req.body);
    assertKnownVariables(body.content);
    const row = await prisma.quickReply.create({
      data: { title: body.title, content: body.content, category: body.category ?? null, active: body.active ?? true },
    });
    await writeAudit({
      req,
      action: AuditAction.CREATE,
      entity: "QuickReply",
      entityId: row.id,
      summary: `Thêm mẫu tin nhanh "${row.title}"`,
    });
    res.status(201).json(row);
  })
);

router.patch(
  "/quick-replies/:id",
  requirePermission("inbox.manage_templates"),
  asyncHandler(async (req, res) => {
    const body = quickReplySchema.partial().parse(req.body);
    assertKnownVariables(body.content);
    const before = await prisma.quickReply.findUnique({ where: { id: req.params.id } });
    if (!before) throw notFound("Không tìm thấy mẫu tin");
    const row = await prisma.quickReply.update({ where: { id: before.id }, data: body });
    await writeAudit({
      req,
      action: AuditAction.UPDATE,
      entity: "QuickReply",
      entityId: row.id,
      summary: `Sửa mẫu tin nhanh "${row.title}"`,
    });
    res.json(row);
  })
);

router.delete(
  "/quick-replies/:id",
  requirePermission("inbox.manage_templates"),
  asyncHandler(async (req, res) => {
    const before = await prisma.quickReply.findUnique({ where: { id: req.params.id } });
    if (!before) throw notFound("Không tìm thấy mẫu tin");
    await prisma.quickReply.update({ where: { id: before.id }, data: { active: false } });
    await writeAudit({
      req,
      action: AuditAction.DELETE,
      entity: "QuickReply",
      entityId: before.id,
      summary: `Tắt mẫu tin nhanh "${before.title}"`,
    });
    res.json({ ok: true });
  })
);

/**
 * POST /api/conversations/:id/render-template — điền biến {{...}} từ hồ sơ khách,
 * bảng giá, lịch hẹn của hội thoại này. Không gửi gì; chỉ trả nội dung để nhân
 * viên xem lại rồi tự bấm Gửi.
 */
router.post(
  "/:id/render-template",
  requirePermission("inbox.read"),
  asyncHandler(async (req, res) => {
    const { content } = z.object({ content: z.string().max(4000) }).parse(req.body);
    const conv = await loadConversation(req, req.params.id);
    const me = currentUser(req);
    res.json(
      await renderTemplate(content, {
        conversationId: conv.id,
        staffName: me.name,
        fallbackBranchId: me.activeBranchId,
      })
    );
  })
);

// ------------------------------------------------------------ TỆP ĐÍNH KÈM (B13)

const MAX_REMOTE_FILE = 15 * 1024 * 1024;

async function loadAttachment(req: Parameters<typeof requireAuth>[0], convId: string, attId: string) {
  const conv = await loadConversation(req, convId);
  const att = await prisma.messageAttachment.findUnique({
    where: { id: attId },
    include: { message: { select: { conversationId: true } } },
  });
  if (!att || att.message.conversationId !== conv.id) throw notFound("Không tìm thấy tệp");
  return { conv, att };
}

/** Nội dung tệp: từ kho mã hoá của mình, hoặc tải từ máy chủ kênh chat (chỉ https). */
async function readAttachmentBytes(att: {
  storageKey: string | null;
  encIv: string | null;
  encTag: string | null;
  url: string | null;
}): Promise<Buffer> {
  if (att.storageKey && att.encIv && att.encTag) return getDecrypted(att.storageKey, att.encIv, att.encTag);
  if (!att.url) throw new HttpError(404, "Tệp không còn nội dung");
  let parsed: URL;
  try {
    parsed = new URL(att.url);
  } catch {
    throw new HttpError(400, "Đường dẫn tệp không hợp lệ");
  }
  if (parsed.protocol !== "https:") throw new HttpError(400, "Chỉ tải tệp qua https");
  const r = await fetch(parsed, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new HttpError(502, `Máy chủ kênh chat trả lỗi ${r.status} khi tải tệp`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > MAX_REMOTE_FILE) throw new HttpError(413, "Tệp quá lớn (trên 15MB)");
  return buf;
}

// GET /api/conversations/:id/attachments/:attId/content
router.get(
  "/:id/attachments/:attId/content",
  requirePermission("inbox.read"),
  asyncHandler(async (req, res) => {
    const { att } = await loadAttachment(req, req.params.id, req.params.attId);
    const data = await readAttachmentBytes(att);
    const kind = sniffFileKind(data);
    // Chỉ phát ảnh và PDF; loại khác trả dạng tải về để trình duyệt không tự mở.
    const mime = kind === "pdf" ? "application/pdf" : kind === "image" ? (att.mimeType ?? "image/jpeg") : "application/octet-stream";
    res.setHeader("Content-Type", mime);
    res.setHeader("Cache-Control", "no-store, private");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (!kind) res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(att.fileName)}"`);
    res.send(data);
  })
);

/**
 * POST /api/conversations/:id/attachments/:attId/save-to-profile
 * "Lưu ảnh vào hồ sơ": ảnh khách gửi qua chat thành một bộ ảnh trong hồ sơ
 * khách, MÃ HOÁ như ảnh chụp tại phòng khám. Hội thoại phải gắn hồ sơ khách.
 */
router.post(
  "/:id/attachments/:attId/save-to-profile",
  requirePermission("photo.create"),
  asyncHandler(async (req, res) => {
    const body = z
      .object({ stage: z.nativeEnum(PhotoStage).optional(), note: z.string().max(500).optional() })
      .parse(req.body ?? {});
    const { conv, att } = await loadAttachment(req, req.params.id, req.params.attId);
    const me = currentUser(req);
    if (!conv.customerId) throw new HttpError(400, "Hội thoại chưa gắn hồ sơ khách. Gắn hồ sơ trước khi lưu ảnh.");
    if (att.savedPhotoSetId) throw new HttpError(409, "Ảnh này đã được lưu vào hồ sơ");

    const branchId = conv.branchId ?? me.activeBranchId;
    if (!branchId || !me.branchIds.includes(branchId)) throw notFound();

    const data = await readAttachmentBytes(att);
    if (sniffFileKind(data) !== "image") throw new HttpError(415, "Tệp này không phải ảnh, không lưu vào bộ ảnh được");

    const stored = putEncrypted(`photos/${conv.customerId}`, att.fileName || "anh-chat.jpg", data);
    const set = await prisma.photoSet.create({
      data: {
        customerId: conv.customerId,
        branchId,
        stage: body.stage ?? PhotoStage.OTHER,
        note: body.note ?? `Ảnh khách gửi qua ${conv.channel}`,
        takenById: me.id,
        photos: {
          create: {
            storageKey: stored.storageKey,
            fileName: att.fileName || "anh-chat.jpg",
            mimeType: att.mimeType ?? "image/jpeg",
            size: stored.size,
            encIv: stored.iv,
            encTag: stored.tag,
          },
        },
      },
    });
    await prisma.messageAttachment.update({ where: { id: att.id }, data: { savedPhotoSetId: set.id } });

    await writeAudit({
      req,
      action: AuditAction.CREATE,
      entity: "PhotoSet",
      entityId: set.id,
      branchId,
      summary: `Lưu ảnh từ hội thoại "${conv.title}" vào hồ sơ khách`,
    });
    await writeAccessLog({
      req,
      customerId: conv.customerId,
      resourceType: AccessResourceType.PHOTO,
      resourceId: set.id,
      rowCount: 1,
    });

    res.status(201).json({ photoSetId: set.id });
  })
);

export default router;
