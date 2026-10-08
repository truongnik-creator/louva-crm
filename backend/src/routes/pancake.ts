import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { pageQuery, CATALOG_PAGE } from "../lib/pagination";
import { asyncHandler, HttpError } from "../middleware/errorHandler";
import { requireAuth, currentUser } from "../middleware/auth";
import { requirePermission, notFound } from "../middleware/rbac";
import crypto from "node:crypto";
import { decryptNullable, encryptNullable, verifyHmac } from "../lib/crypto";
import { logger } from "../lib/logger";
import { writeAudit } from "../lib/audit";
import {
  resolveToken,
  type PancakeConversationRaw,
  type PancakeMessageRaw,
} from "../services/pancake";
import { ingestPancakeConversation, isSyncRunning, syncPancakeConfig } from "../services/pancake-sync";
import {
  discoverAgents,
  discoverPagesAndAgents,
  isStatsSyncRunning,
  syncConfigStats,
} from "../services/pancake-stats";
import { AuditAction } from "../types/enums";

// Cấu hình và đồng bộ Pancake.
//
// Đồng bộ theo kiểu KÉO (pull) chứ không chỉ dựa vào webhook: webhook có thể
// rớt, và phòng khám cần chắc chắn không sót tin của khách. Mỗi lần đồng bộ đều
// idempotent theo pancakeConversationId / externalId của tin nhắn.

const router = Router();
const publicRouter = Router();
router.use(requireAuth);

// ------------------------------------------------------------------ WEBHOOK (F5)
//
// Pancake đẩy tin thời gian thực vào đây. Xác thực bằng MỘT trong hai cách:
//   · header X-Pancake-Signature = hex(HMAC-SHA256(raw body, secret)), hoặc
//   · header X-Webhook-Secret = secret (bí mật chung).
// secret lấy từ kết nối Pancake (ô "Bí mật webhook") hoặc biến PANCAKE_WEBHOOK_SECRET.
// TODO-VERIFY: đối chiếu tài liệu webhook Pancake thật: tên header chữ ký, thuật
// toán, và hình dạng payload (normalizeWebhook bên dưới).

interface PancakeWebhookBody {
  page_id?: string | number;
  event_type?: string;
  data?: {
    page_id?: string | number;
    conversation?: PancakeConversationRaw;
    message?: PancakeMessageRaw;
    messages?: PancakeMessageRaw[];
  };
  conversation?: PancakeConversationRaw;
  message?: PancakeMessageRaw;
}

/** TODO-VERIFY: gom mọi biến thể payload về { pageId, conversation, messages }. */
export function normalizeWebhook(body: PancakeWebhookBody) {
  const data = body.data ?? {};
  const conversation = data.conversation ?? body.conversation;
  const messages = data.messages ?? (data.message ? [data.message] : body.message ? [body.message] : []);
  const pageId = body.page_id ?? data.page_id ?? conversation?.page_id;
  return { pageId: pageId != null ? String(pageId) : null, conversation, messages };
}

function secretMatches(provided: string, secret: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(secret);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

publicRouter.post(
  "/webhook",
  asyncHandler(async (req, res) => {
    const raw = req.rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));
    const { pageId, conversation, messages } = normalizeWebhook((req.body ?? {}) as PancakeWebhookBody);
    if (!pageId || !conversation?.id) return res.status(400).json({ error: "Payload webhook không có page_id hoặc hội thoại" });

    const page = await prisma.pancakePage.findUnique({ where: { pageId }, include: { config: true } });
    // Trang lạ: trả 200 để Pancake không gửi lại vô hạn, nhưng không xử lý.
    if (!page || !page.active || !page.config.active) {
      logger.warn({ pageId }, "[pancake] webhook cho trang chưa đăng ký");
      return res.json({ ok: true, ignored: true });
    }

    const secret = decryptNullable(page.config.webhookSecretEnc) ?? process.env.PANCAKE_WEBHOOK_SECRET ?? null;
    if (!secret) return res.status(503).json({ error: "Chưa cấu hình bí mật webhook Pancake" });
    const signature = req.headers["x-pancake-signature"];
    const shared = req.headers["x-webhook-secret"];
    const ok =
      (typeof signature === "string" && verifyHmac(raw, signature, secret)) ||
      (typeof shared === "string" && secretMatches(shared, secret));
    if (!ok) {
      logger.warn({ pageId }, "[pancake] webhook sai chữ ký, từ chối");
      return res.status(401).json({ error: "Sai chữ ký webhook" });
    }

    const result = await ingestPancakeConversation({
      page: { ...page, configId: page.configId },
      configBranchId: page.config.branchId,
      conversation,
      messages,
      incremental: true,
    });
    res.json({ ok: true, created: result.created });
  })
);

router.get(
  "/configs",
  requirePermission("settings.read"),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const rows = await prisma.pancakeConfig.findMany({
      where: { OR: [{ branchId: null }, { branchId: { in: me.branchIds } }] },
      ...pageQuery(req.query, CATALOG_PAGE),
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
        // Token trang cũng không trả ra ngoài, chỉ trả cờ "đã có".
        pages: r.pages.map(({ pageAccessTokenEnc, ...p }) => ({
          ...p,
          hasPageToken: Boolean(pageAccessTokenEnc),
        })),
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

/**
 * POST /api/pancake/:id/discover-pages — hỏi Pancake xem tài khoản có trang nào.
 *
 * Một lượt gọi GET /pages lấy được cả ba: danh sách trang, token riêng của từng
 * trang, và danh sách nhân viên (F35). Logic ở services/pancake-stats.ts để
 * script vận hành trên máy chủ dùng lại được.
 */
router.post(
  "/:id/discover-pages",
  requirePermission("settings.update"),
  asyncHandler(async (req, res) => {
    const config = await prisma.pancakeConfig.findUniqueOrThrow({ where: { id: req.params.id } });
    if (!config.active) throw new HttpError(400, "Kết nối Pancake đã tắt");

    const r = await discoverPagesAndAgents(config.id);
    if (!r.found && r.errors.length) throw new HttpError(400, r.errors.join(" | "));

    await writeAudit({
      req,
      action: AuditAction.UPDATE,
      entity: "PancakeConfig",
      entityId: config.id,
      summary: `Dò trang Pancake: tìm thấy ${r.found}, thêm mới ${r.created}, lưu ${r.tokens} token trang, ${r.agents} nhân viên`,
    });

    res.json(r);
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
        /**
         * Token riêng của trang, dán tay từ Pancake (Cài đặt trang › Công cụ).
         * Để trống thì hệ thống tự sinh từ API token của kết nối khi cần.
         */
        pageAccessToken: z.string().min(10).nullable().optional(),
      })
      .parse(req.body);

    const { pageAccessToken, ...rest } = body;
    const page = await prisma.pancakePage.update({
      where: { id: req.params.id },
      data: {
        ...rest,
        ...(pageAccessToken !== undefined ? { pageAccessTokenEnc: encryptNullable(pageAccessToken) } : {}),
      },
    });
    const { pageAccessTokenEnc, ...safe } = page;
    res.json({ ...safe, hasPageToken: Boolean(pageAccessTokenEnc) });
  })
);

// ------------------------------------------------- F35 NHÂN VIÊN & THỐNG KÊ

/** GET /api/pancake/:id/agents — nhân viên Pancake của kết nối và tài khoản CRM đã gắn. */
router.get(
  "/:id/agents",
  requirePermission("settings.read"),
  asyncHandler(async (req, res) => {
    const rows = await prisma.pancakeAgent.findMany({
      where: { configId: req.params.id },
      orderBy: [{ active: "desc" }, { name: "asc" }],
      select: {
        id: true,
        pancakeUserId: true,
        name: true,
        active: true,
        userId: true,
        user: { select: { id: true, name: true } },
      },
    });
    res.json(rows);
  })
);

/**
 * POST /api/pancake/:id/discover-agents — hỏi Pancake xem trang có nhân viên nào,
 * và tự gắn với tài khoản CRM khi tên khớp duy nhất.
 */
router.post(
  "/:id/discover-agents",
  requirePermission("settings.update"),
  asyncHandler(async (req, res) => {
    const config = await prisma.pancakeConfig.findUniqueOrThrow({
      where: { id: req.params.id },
      include: { pages: { where: { active: true }, select: { id: true } } },
    });
    if (!config.pages.length) throw new HttpError(400, 'Chưa có trang nào. Bấm "Dò trang" trước.');

    const r = await discoverAgents(config.id);
    await writeAudit({
      req,
      action: AuditAction.UPDATE,
      entity: "PancakeConfig",
      entityId: config.id,
      summary: `Dò nhân viên Pancake "${config.label}": ${r.found} người`,
    });
    res.json(r);
  })
);

/**
 * PATCH /api/pancake/agents/:id — gắn (hoặc bỏ gắn) nhân viên Pancake với một
 * tài khoản CRM. Một tài khoản CRM chỉ gắn được với MỘT nhân viên Pancake trong
 * cùng kết nối: gắn hai người vào một tài khoản thì số tin bị cộng đôi.
 */
router.patch(
  "/agents/:id",
  requirePermission("settings.update"),
  asyncHandler(async (req, res) => {
    const body = z.object({ userId: z.string().uuid().nullable() }).parse(req.body);
    const agent = await prisma.pancakeAgent.findUnique({ where: { id: req.params.id } });
    if (!agent) throw notFound();

    if (body.userId) {
      const clash = await prisma.pancakeAgent.findFirst({
        where: { configId: agent.configId, userId: body.userId, id: { not: agent.id } },
        select: { name: true },
      });
      if (clash) throw new HttpError(400, `Tài khoản này đã gắn với nhân viên Pancake "${clash.name}"`);
    }

    const updated = await prisma.pancakeAgent.update({
      where: { id: agent.id },
      data: { userId: body.userId },
      select: { id: true, name: true, userId: true, user: { select: { id: true, name: true } } },
    });
    await writeAudit({
      req,
      action: AuditAction.UPDATE,
      entity: "PancakeAgent",
      entityId: agent.id,
      summary: body.userId
        ? `Gắn nhân viên Pancake "${agent.name}" với tài khoản ${updated.user?.name ?? body.userId}`
        : `Bỏ gắn nhân viên Pancake "${agent.name}"`,
    });
    res.json(updated);
  })
);

/**
 * POST /api/pancake/:id/sync-stats — kéo thống kê hiệu suất NGAY.
 *
 * Bình thường tác vụ nền tự kéo mỗi 10 phút; nút này để quản trị kiểm tra ngay
 * sau khi vừa cấu hình. `?wait=1` thì chờ xong và trả kết quả.
 */
router.post(
  "/:id/sync-stats",
  requirePermission("settings.update"),
  asyncHandler(async (req, res) => {
    const config = await prisma.pancakeConfig.findUniqueOrThrow({
      where: { id: req.params.id },
      include: { pages: { where: { active: true }, select: { id: true } } },
    });
    if (!config.pages.length) throw new HttpError(400, 'Chưa có trang nào. Bấm "Dò trang" trước.');
    if (isStatsSyncRunning(config.id)) return res.status(202).json({ started: false, running: true });

    if (req.query.wait === "1") return res.json(await syncConfigStats(config.id));
    void syncConfigStats(config.id).catch((err) =>
      logger.warn({ err, configId: config.id }, "[pancake] kéo thống kê lỗi")
    );
    res.status(202).json({ started: true, running: true });
  })
);

/**
 * POST /api/pancake/:id/sync — đồng bộ tay, DỰ PHÒNG cho webhook (F5).
 *
 * Chạy nền: trả 202 ngay, kết quả ghi vào lastSyncNote của kết nối. `?wait=1`
 * thì chờ chạy xong và trả kết quả (dùng cho test, script).
 * Idempotent theo pancakeConversationId và externalId của tin.
 */
router.post(
  "/:id/sync",
  requirePermission("inbox.update"),
  asyncHandler(async (req, res) => {
    const token = await resolveToken(req.params.id);
    if (!token) throw new HttpError(400, "Kết nối Pancake chưa có token hoặc đã tắt");
    const config = await prisma.pancakeConfig.findUniqueOrThrow({
      where: { id: req.params.id },
      include: { pages: { where: { active: true }, select: { id: true } } },
    });
    if (!config.pages.length) throw new HttpError(400, 'Chưa có trang nào. Bấm "Dò trang" trước.');
    if (isSyncRunning(config.id)) return res.status(202).json({ started: false, running: true });

    await writeAudit({
      req,
      action: AuditAction.UPDATE,
      entity: "PancakeConfig",
      entityId: config.id,
      summary: `Chạy đồng bộ tay Pancake "${config.label}"`,
    });

    if (req.query.wait === "1") {
      return res.json(await syncPancakeConfig(config.id));
    }
    void syncPancakeConfig(config.id);
    res.status(202).json({ started: true, running: true });
  })
);

// Webhook công khai (Pancake gọi vào, không có Authorization) mount TRƯỚC router có requireAuth.
const combined = Router();
combined.use("/", publicRouter);
combined.use("/", router);

export default combined;
