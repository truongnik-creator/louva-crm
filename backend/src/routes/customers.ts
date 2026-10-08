import { Router } from "express";
import { refreshFirstPurchaseAt, safely, syncLeadsForCustomer } from "../lib/lead-funnel";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { asyncHandler, HttpError } from "../middleware/errorHandler";
import { requireAuth, currentUser } from "../middleware/auth";
import { requirePermission, scopedWhere, assertInScope, notFound, phoneFor, hasPermission, scopeOf } from "../middleware/rbac";
import { writeAudit, writeAccessLog, diffFields } from "../lib/audit";
import { withCode, CodePrefix } from "../lib/codes";
import { parsePagination, pageQuery, CATALOG_PAGE } from "../lib/pagination";
import { normalizeVnPhone } from "../lib/phone";
import { normalizeName, isSimilarName } from "../lib/text";
import { formatDateTimeVN, formatVnd, startOfVnDay } from "../lib/datetime";
import { mergeCustomers } from "../lib/customer-merge";
import { assertStageRequirements, ensureCurrentOpportunity } from "../lib/opportunities";
import {
  changeStage,
  getClinicMode,
  initialStageFor,
  isValidStage,
  lostStageFor,
  stageLabel,
  stageRank,
  stagesFor,
} from "../lib/stages";
import {
  AuditAction,
  ActivityType,
  AccessResourceType,
  CustomerStatus,
  Gender,
  LostReason,
  StageSource,
  TaskPriority,
  TaskStatus,
} from "../types/enums";

// Khách hàng — LIÊN THÔNG TOÀN CÔNG TY (mục 4.2). Vì vậy scopedWhere dùng
// branchField: null: không lọc theo cơ sở, chỉ lọc theo người phụ trách khi
// phạm vi là OWN. Bệnh án của khách thì ngược lại — cách ly, xem routes/medical.ts.

const router = Router();
router.use(requireAuth);

const OWNER_FIELDS = ["assignedToId", "telesaleId"];
const CUSTOMER_SCOPE = { ownerFields: OWNER_FIELDS, branchField: null };

const listSelect = {
  id: true,
  code: true,
  name: true,
  phone: true,
  status: true,
  stage: true,
  lostReason: true,
  interest: true,
  lastContactAt: true,
  createdAt: true,
  assignedTo: { select: { id: true, name: true } },
  telesale: { select: { id: true, name: true } },
  channel: { select: { id: true, name: true, kind: true } },
  branchLinks: { select: { branch: { select: { id: true, code: true, shortName: true } } } },
} as const;

function parseJsonArray(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

// GET /api/customers
router.get(
  "/",
  requirePermission("customer.read"),
  asyncHandler(async (req, res) => {
    const { where } = scopedWhere(req, "customer.read", CUSTOMER_SCOPE);
    const q = (req.query.q as string)?.trim();

    const filters: Record<string, unknown> = { ...where, hidden: false };
    if (q) {
      const qPhone = normalizeVnPhone(q);
      const qName = normalizeName(q);
      filters.OR = [
        { name: { contains: q } },
        // Tìm không dấu: gõ "lan anh" vẫn ra "Lan Anh".
        ...(qName ? [{ nameNormalized: { contains: qName } }] : []),
        { phone: { contains: q.replace(/\s/g, "") } },
        ...(qPhone ? [{ phoneNormalized: { contains: qPhone } }] : []),
        { code: { contains: q } },
      ];
    }
    if (req.query.status) filters.status = String(req.query.status);
    if (req.query.stage) filters.stage = String(req.query.stage);
    if (req.query.assignedToId) filters.assignedToId = String(req.query.assignedToId);
    if (req.query.branchId) filters.branchLinks = { some: { branchId: String(req.query.branchId) } };
    if (req.query.tagId) filters.tags = { some: { tagId: String(req.query.tagId) } };

    const page = parsePagination(req.query, { defaultLimit: 100, maxLimit: 500 });
    const [rows, total] = await Promise.all([
      prisma.customer.findMany({
        where: filters,
        select: listSelect,
        orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
        take: page.take,
        skip: page.skip,
      }),
      prisma.customer.count({ where: filters }),
    ]);

    // Marketing thấy danh sách nhưng SĐT bị che (mục 4.4).
    res.json({
      total,
      offset: page.offset,
      limit: page.limit,
      nextOffset: page.offset + rows.length < total ? page.offset + rows.length : null,
      items: rows.map((c) => ({
        ...c,
        phone: phoneFor(req, c.phone),
        interest: parseJsonArray(c.interest),
        branches: c.branchLinks.map((b) => b.branch),
        branchLinks: undefined,
      })),
    });
  })
);

// ------------------------------------------------------------ BẢNG KANBAN (F3)

/**
 * GET /api/customers/board?perStage=40&q=&assignedToId= — bảng kéo thả theo bộ
 * bước của chế độ phòng khám. Mỗi cột trả số đếm thật + tối đa perStage thẻ.
 */
router.get(
  "/board",
  requirePermission("customer.read"),
  asyncHandler(async (req, res) => {
    const q = z
      .object({
        perStage: z.coerce.number().int().min(1).max(200).default(40),
        assignedToId: z.string().uuid().optional(),
        branchId: z.string().uuid().optional(),
      })
      .parse(req.query);
    const { where } = scopedWhere(req, "customer.read", CUSTOMER_SCOPE);
    const base: Record<string, unknown> = { ...where, hidden: false, mergedIntoId: null };
    if (q.assignedToId) base.assignedToId = q.assignedToId;
    if (q.branchId) base.branchLinks = { some: { branchId: q.branchId } };
    const mode = await getClinicMode();
    const columns = await Promise.all(
      stagesFor(mode).map(async (st) => {
        const filter = { ...base, stage: st.key };
        const [count, items] = await Promise.all([
          prisma.customer.count({ where: filter }),
          prisma.customer.findMany({
            where: filter,
            select: listSelect,
            orderBy: [{ stageChangedAt: "desc" }, { updatedAt: "desc" }],
            take: q.perStage,
          }),
        ]);
        return {
          ...st,
          count,
          items: items.map((c) => ({
            ...c,
            phone: phoneFor(req, c.phone),
            interest: parseJsonArray(c.interest),
            branches: c.branchLinks.map((b) => b.branch),
            branchLinks: undefined,
          })),
        };
      })
    );
    res.json({ mode, columns });
  })
);

// ------------------------------------------------------------ TRÙNG HỒ SƠ (B17)

function maskedRef(req: Parameters<typeof phoneFor>[0], c: { id: string; code: string; name: string; phone: string | null }) {
  return { id: c.id, code: c.code, name: c.name, phone: phoneFor(req, c.phone) };
}

/**
 * GET /api/customers/duplicates/check?name=&phone=&excludeId=
 * Cảnh báo khi đang nhập khách mới: trùng SĐT (chuẩn hoá) và tên gần giống
 * (bỏ dấu, lệch 1-2 ký tự) để sale không tạo hồ sơ thứ hai cho cùng một người.
 */
router.get(
  "/duplicates/check",
  requirePermission("customer.read"),
  asyncHandler(async (req, res) => {
    const q = z
      .object({
        name: z.string().max(200).optional(),
        phone: z.string().max(40).optional(),
        excludeId: z.string().uuid().optional(),
      })
      .parse(req.query);

    const exclude = q.excludeId ? { id: { not: q.excludeId } } : {};
    const phoneNormalized = normalizeVnPhone(q.phone);
    const phoneMatches = phoneNormalized
      ? await prisma.customer.findMany({
          where: { phoneNormalized, mergedIntoId: null, ...exclude },
          select: { id: true, code: true, name: true, phone: true },
          take: 10,
        })
      : [];

    const nameNorm = normalizeName(q.name);
    let similarNames: Array<{ id: string; code: string; name: string; phone: string | null }> = [];
    if (nameNorm && nameNorm.length >= 3) {
      // Tên riêng tiếng Việt là từ cuối; lọc ứng viên bằng cột có index rồi
      // mới so khoảng cách chỉnh sửa trong bộ nhớ.
      const tokens = nameNorm.split(" ");
      const given = tokens[tokens.length - 1];
      const candidates = await prisma.customer.findMany({
        where: {
          mergedIntoId: null,
          ...exclude,
          OR: [{ nameNormalized: { contains: given } }, { nameNormalized: { contains: tokens[0] } }],
        },
        select: { id: true, code: true, name: true, phone: true, nameNormalized: true },
        take: 500,
      });
      similarNames = candidates
        .filter((c) => c.nameNormalized && isSimilarName(nameNorm, c.nameNormalized))
        .filter((c) => !phoneMatches.some((p) => p.id === c.id))
        .slice(0, 10);
    }

    res.json({
      phoneMatches: phoneMatches.map((c) => maskedRef(req, c)),
      similarNames: similarNames.map((c) => maskedRef(req, c)),
    });
  })
);

/**
 * GET /api/customers/duplicates — các nhóm hồ sơ cùng SĐT chuẩn hoá, cho màn
 * Gộp hồ sơ trùng. Mỗi nhóm kèm số lịch hẹn/hợp đồng để chọn hồ sơ giữ lại.
 */
router.get(
  "/duplicates",
  requirePermission("customer.merge"),
  asyncHandler(async (req, res) => {
    const page = parsePagination(req.query, { defaultLimit: 50, maxLimit: 200 });
    const groups = await prisma.customer.groupBy({
      by: ["phoneNormalized"],
      where: { phoneNormalized: { not: null }, mergedIntoId: null },
      _count: { _all: true },
      having: { phoneNormalized: { _count: { gt: 1 } } },
      orderBy: { phoneNormalized: "asc" },
      take: page.take,
      skip: page.skip,
    });
    const phones = groups.map((g) => g.phoneNormalized!).filter(Boolean);
    const customers = phones.length
      ? await prisma.customer.findMany({
          where: { phoneNormalized: { in: phones }, mergedIntoId: null },
          orderBy: { createdAt: "asc" },
          select: {
            id: true,
            code: true,
            name: true,
            phone: true,
            phoneNormalized: true,
            stage: true,
            status: true,
            hidden: true,
            createdAt: true,
            assignedTo: { select: { id: true, name: true } },
            _count: { select: { appointments: true, contracts: true, conversations: true, payments: true } },
          },
        })
      : [];

    res.json({
      groups: phones.map((p) => ({
        key: phoneFor(req, p),
        customers: customers
          .filter((c) => c.phoneNormalized === p)
          .map(({ phoneNormalized: _n, ...c }) => ({ ...c, phone: phoneFor(req, c.phone) })),
      })),
      nextOffset: groups.length === page.limit ? page.offset + groups.length : null,
    });
  })
);

/**
 * POST /api/customers/merge — gộp hồ sơ trùng vào hồ sơ giữ lại. Không xoá gì:
 * bản ghi con chuyển sang, hồ sơ trùng bị ẩn và đánh dấu đã gộp. Ghi AuditLog.
 */
router.post(
  "/merge",
  requirePermission("customer.merge"),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        primaryId: z.string().uuid(),
        duplicateIds: z.array(z.string().uuid()).min(1).max(20),
        reason: z.string().trim().min(5, "Lý do gộp tối thiểu 5 ký tự"),
      })
      .parse(req.body);
    const me = currentUser(req);

    const all = await prisma.customer.findMany({
      where: { id: { in: [body.primaryId, ...body.duplicateIds] } },
    });
    for (const c of all) {
      assertInScope(req, "customer.update", c as unknown as Record<string, unknown>, CUSTOMER_SCOPE);
    }
    const primary = all.find((c) => c.id === body.primaryId);
    if (!primary) throw notFound("Không tìm thấy hồ sơ giữ lại");

    const results = [];
    for (const duplicateId of body.duplicateIds) {
      const dup = all.find((c) => c.id === duplicateId);
      if (!dup) throw notFound("Không tìm thấy hồ sơ cần gộp");
      const result = await mergeCustomers({
        primaryId: primary.id,
        duplicateId,
        reason: body.reason,
        actor: { id: me.id, name: me.name },
      });
      results.push(result);
      await safely("mốc mua đầu sau gộp", () => refreshFirstPurchaseAt(primary.id));
      await writeAudit({
        req,
        action: AuditAction.MERGE,
        entity: "Customer",
        entityId: primary.id,
        summary: `Gộp hồ sơ ${dup.code} (${dup.name}) vào ${primary.code} (${primary.name}). Lý do: ${body.reason}`,
        changes: {
          mergedFrom: [dup.id, null],
          moved: [null, result.moved],
          filledFields: [null, result.filledFields],
        },
      });
    }

    res.json({ ok: true, primaryId: primary.id, results });
  })
);

// GET /api/customers/:id
router.get(
  "/:id",
  requirePermission("customer.read"),
  asyncHandler(async (req, res) => {
    const customer = await prisma.customer.findUnique({
      where: { id: req.params.id },
      include: {
        assignedTo: { select: { id: true, name: true } },
        telesale: { select: { id: true, name: true } },
        channel: true,
        campaign: { select: { id: true, name: true, code: true } },
        tags: { include: { tag: true } },
        branchLinks: { include: { branch: { select: { id: true, code: true, name: true, shortName: true } } } },
      },
    });
    assertInScope(req, "customer.read", customer as unknown as Record<string, unknown>, CUSTOMER_SCOPE);

    // Xem hồ sơ khách có kèm SĐT là hành vi cần ghi vết (mục 4.4).
    if (hasPermission(req, "customer.view_phone") && customer!.phone) {
      await writeAccessLog({
        req,
        customerId: customer!.id,
        resourceType: AccessResourceType.CUSTOMER_PHONE,
        resourceId: customer!.id,
      });
    }

    const [totalPaid, debt] = await Promise.all([
      prisma.payment.aggregate({ where: { customerId: customer!.id }, _sum: { amount: true } }),
      prisma.invoice.aggregate({
        where: { customerId: customer!.id, status: { in: ["ISSUED", "PARTIAL", "OVERDUE"] } },
        _sum: { amount: true, paidAmount: true },
      }),
    ]);

    res.json({
      ...customer,
      phone: phoneFor(req, customer!.phone),
      interest: parseJsonArray(customer!.interest),
      tags: customer!.tags.map((t) => t.tag),
      branches: customer!.branchLinks.map((b) => ({ ...b.branch, isPrimary: b.isPrimary })),
      branchLinks: undefined,
      totalPaid: totalPaid._sum.amount ?? 0,
      debt: (debt._sum.amount ?? 0) - (debt._sum.paidAmount ?? 0),
    });
  })
);

const customerSchema = z.object({
  name: z.string().min(2),
  phone: z.string().min(8).optional().nullable(),
  email: z.string().email().optional().nullable(),
  zaloUserId: z.string().optional().nullable(),
  dob: z.coerce.date().optional().nullable(),
  gender: z.nativeEnum(Gender).optional().nullable(),
  address: z.string().optional().nullable(),
  city: z.string().optional().nullable(),
  status: z.nativeEnum(CustomerStatus).optional(),
  stage: z.string().max(30).optional(),
  channelId: z.string().uuid().optional().nullable(),
  campaignId: z.string().uuid().optional().nullable(),
  interest: z.array(z.string()).optional(),
  budgetNote: z.string().optional().nullable(),
  note: z.string().optional().nullable(),
  assignedToId: z.string().uuid().optional().nullable(),
  telesaleId: z.string().uuid().optional().nullable(),
  branchId: z.string().uuid().optional(),
});

// POST /api/customers
router.post(
  "/",
  requirePermission("customer.create"),
  asyncHandler(async (req, res) => {
    const body = customerSchema.parse(req.body);
    const me = currentUser(req);
    const branchId = body.branchId ?? me.activeBranchId;
    const mode = await getClinicMode();
    if (body.stage && (!isValidStage(mode, body.stage) || body.stage === lostStageFor(mode))) {
      throw new HttpError(400, "Bước khách không hợp lệ với chế độ phòng khám hiện tại");
    }

    // B17: so trùng theo SĐT CHUẨN HOÁ ("+84 912..." = "0912...").
    const phoneNormalized = normalizeVnPhone(body.phone);
    if (phoneNormalized) {
      const dup = await prisma.customer.findFirst({
        where: { phoneNormalized, mergedIntoId: null },
        select: { id: true, name: true, code: true },
      });
      if (dup) {
        return res.status(409).json({
          error: `Số điện thoại đã tồn tại ở khách ${dup.name} (${dup.code})`,
          duplicate: { type: "customer", id: dup.id, code: dup.code, name: dup.name },
        });
      }
    }

    const customer = await withCode(CodePrefix.CUSTOMER, (code) =>
      prisma.customer.create({
        data: {
          code,
          name: body.name,
          phone: body.phone ?? null,
          email: body.email ?? null,
          zaloUserId: body.zaloUserId ?? null,
          dob: body.dob ?? null,
          gender: body.gender ?? null,
          address: body.address ?? null,
          city: body.city ?? null,
          status: body.status ?? CustomerStatus.LEAD,
          stage: body.stage ?? initialStageFor(mode),
          stageChangedAt: new Date(),
          channelId: body.channelId ?? null,
          campaignId: body.campaignId ?? null,
          interest: body.interest ? JSON.stringify(body.interest) : null,
          budgetNote: body.budgetNote ?? null,
          note: body.note ?? null,
          assignedToId: body.assignedToId ?? me.id,
          telesaleId: body.telesaleId ?? null,
          ...(branchId ? { branchLinks: { create: { branchId, isPrimary: true } } } : {}),
          activities: {
            create: {
              type: ActivityType.SYSTEM,
              content: `Tạo hồ sơ khách bởi ${me.name}`,
              userId: me.id,
              userName: me.name,
            },
          },
        },
      })
    );

    await writeAudit({
      req,
      action: AuditAction.CREATE,
      entity: "Customer",
      entityId: customer.id,
      branchId,
      summary: `Tạo khách ${customer.name} (${customer.code})`,
    });
    res.status(201).json(customer);
  })
);

// PATCH /api/customers/:id
router.patch(
  "/:id",
  requirePermission("customer.update"),
  asyncHandler(async (req, res) => {
    // Đổi bước phải qua POST /:id/stage để có lịch sử và luật mất khách (F1).
    const body = customerSchema.partial().omit({ branchId: true, stage: true }).parse(req.body);
    const before = await prisma.customer.findUnique({ where: { id: req.params.id } });
    assertInScope(req, "customer.update", before as unknown as Record<string, unknown>, CUSTOMER_SCOPE);

    // Người không được xem SĐT chỉ thấy bản che; không để form sửa ghi đè số thật.
    if (!hasPermission(req, "customer.view_phone") && before!.phone && body.phone !== undefined) {
      delete body.phone;
    }
    const phoneNormalized = normalizeVnPhone(body.phone);
    if (phoneNormalized && phoneNormalized !== before!.phoneNormalized) {
      const dup = await prisma.customer.findFirst({
        where: { phoneNormalized, mergedIntoId: null, id: { not: before!.id } },
        select: { id: true, name: true, code: true },
      });
      if (dup) {
        return res.status(409).json({
          error: `Số điện thoại đã tồn tại ở khách ${dup.name} (${dup.code})`,
          duplicate: { type: "customer", id: dup.id, code: dup.code, name: dup.name },
        });
      }
    }

    const { interest, ...rest } = body;
    const data = { ...rest, ...(interest ? { interest: JSON.stringify(interest) } : {}) };

    const customer = await prisma.customer.update({ where: { id: req.params.id }, data });
    // F15: khách có SĐT thì các lead của khách có mốc "có SĐT".
    if (customer.phone && !before!.phone) await safely("mốc có SĐT", () => syncLeadsForCustomer(customer.id));
    await writeAudit({
      req,
      action: AuditAction.UPDATE,
      entity: "Customer",
      entityId: customer.id,
      summary: `Sửa khách ${customer.name} (${customer.code})`,
      changes: diffFields(before as unknown as Record<string, unknown>, data),
    });
    res.json(customer);
  })
);

/**
 * POST /api/customers/:id/stage
 * Chuyển bước bán hàng (F1). Luật:
 *   - bước phải thuộc bộ bước của chế độ phòng khám (tiêm hoặc phẫu thuật);
 *   - sang bước MẤT KHÁCH bắt buộc lostReason trong danh sách;
 *   - LÙI bước bắt buộc ghi lý do (quy tắc trong prototype).
 * Mọi lần đổi ghi StageHistory + Activity + AuditLog.
 */
router.post(
  "/:id/stage",
  requirePermission("customer.update"),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        stage: z.string().max(30),
        lostReason: z.nativeEnum(LostReason).optional(),
        reason: z.string().trim().max(500).optional(),
      })
      .parse(req.body);

    const before = await prisma.customer.findUnique({ where: { id: req.params.id } });
    assertInScope(req, "customer.update", before as unknown as Record<string, unknown>, CUSTOMER_SCOPE);
    const mode = await getClinicMode();
    if (!isValidStage(mode, body.stage)) {
      throw new HttpError(400, `Bước "${body.stage}" không thuộc bộ bước của phòng khám hiện tại`);
    }
    if (body.stage === before!.stage) return res.json(before);

    const lost = lostStageFor(mode);
    if (body.stage === lost && !body.lostReason) {
      throw new HttpError(400, "Chuyển sang Mất khách bắt buộc chọn lý do mất khách");
    }
    const prevRank = stageRank(mode, before!.stage);
    const nextRank = stageRank(mode, body.stage);
    const isRegression = body.stage !== lost && before!.stage !== lost && prevRank >= 0 && nextRank < prevRank;
    if (isRegression && !body.reason) {
      throw new HttpError(400, "Lùi bước bán hàng bắt buộc phải ghi lý do");
    }

    // Lô 8 · P4: điều kiện bắt buộc của bước đích (lịch hẹn, hợp đồng), theo cơ hội hiện tại.
    const opp = await ensureCurrentOpportunity(before!.id, mode);
    await assertStageRequirements(before!.id, opp, mode, body.stage);

    const me = currentUser(req);
    const customer = await changeStage({
      customerId: before!.id,
      fromStage: before!.stage,
      toStage: body.stage,
      opportunityId: opp?.id ?? null,
      source: StageSource.MANUAL,
      lostReason: body.stage === lost ? body.lostReason : null,
      note: body.reason ?? null,
      actor: { id: me.id, name: me.name },
      mode,
    });

    await writeAudit({
      req,
      action: AuditAction.UPDATE,
      entity: "Customer",
      entityId: customer.id,
      summary: `Đổi bước khách ${customer.code}: ${stageLabel(before!.stage)} → ${stageLabel(body.stage)}`,
      changes: {
        stage: [before!.stage, body.stage],
        ...(body.lostReason ? { lostReason: [before!.lostReason, body.lostReason] } : {}),
      },
    });
    res.json({ ...customer, phone: phoneFor(req, customer.phone) });
  })
);

/** GET /api/customers/:id/stage-history — lịch sử đổi bước (F1). */
router.get(
  "/:id/stage-history",
  requirePermission("customer.read"),
  asyncHandler(async (req, res) => {
    const customer = await prisma.customer.findUnique({ where: { id: req.params.id } });
    assertInScope(req, "customer.read", customer as unknown as Record<string, unknown>, CUSTOMER_SCOPE);
    res.json(
      await prisma.stageHistory.findMany({
        where: { customerId: customer!.id },
        orderBy: { createdAt: "desc" },
        ...pageQuery(req.query, { defaultLimit: 100, maxLimit: 500 }),
      })
    );
  })
);

/**
 * POST /api/customers/:id/ai-consent — ghi nhận khách đồng ý (hoặc rút lại) cho
 * xử lý dữ liệu bằng AI theo Nghị định 13/2023. Chưa đồng ý thì không gửi
 * nội dung chat của khách lên AI.
 */
router.post(
  "/:id/ai-consent",
  requirePermission("customer.update"),
  asyncHandler(async (req, res) => {
    const body = z
      .object({ consent: z.boolean(), note: z.string().trim().max(500).optional() })
      .parse(req.body);
    const before = await prisma.customer.findUnique({ where: { id: req.params.id } });
    assertInScope(req, "customer.update", before as unknown as Record<string, unknown>, CUSTOMER_SCOPE);
    const me = currentUser(req);
    const customer = await prisma.customer.update({
      where: { id: before!.id },
      data: {
        aiDataConsent: body.consent,
        aiDataConsentAt: new Date(),
        aiDataConsentById: me.id,
        activities: {
          create: {
            type: ActivityType.SYSTEM,
            content: `${me.name} ghi nhận khách ${body.consent ? "ĐỒNG Ý" : "KHÔNG đồng ý / rút lại"} cho xử lý dữ liệu bằng AI${
              body.note ? `. Ghi chú: ${body.note}` : ""
            }`,
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
      summary: `Đồng ý xử lý dữ liệu bằng AI của khách ${customer.code}: ${body.consent ? "có" : "không"}`,
      changes: { aiDataConsent: [before!.aiDataConsent, body.consent] },
    });
    res.json({ id: customer.id, aiDataConsent: customer.aiDataConsent, aiDataConsentAt: customer.aiDataConsentAt });
  })
);

// POST /api/customers/:id/assign — đổi người phụ trách
router.post(
  "/:id/assign",
  requirePermission("customer.update"),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        assignedToId: z.string().uuid().nullable().optional(),
        telesaleId: z.string().uuid().nullable().optional(),
        reason: z.string().min(3),
      })
      .parse(req.body);

    const before = await prisma.customer.findUnique({ where: { id: req.params.id } });
    assertInScope(req, "customer.update", before as unknown as Record<string, unknown>, CUSTOMER_SCOPE);

    const me = currentUser(req);
    const data: Record<string, unknown> = {};
    if (body.assignedToId !== undefined) data.assignedToId = body.assignedToId;
    if (body.telesaleId !== undefined) data.telesaleId = body.telesaleId;

    const customer = await prisma.customer.update({
      where: { id: req.params.id },
      data: {
        ...data,
        activities: {
          create: {
            type: ActivityType.ASSIGNED,
            content: `${me.name} đổi người phụ trách — lý do: ${body.reason}`,
            userId: me.id,
            userName: me.name,
            meta: JSON.stringify(data),
          },
        },
      },
      include: {
        assignedTo: { select: { id: true, name: true } },
        telesale: { select: { id: true, name: true } },
      },
    });

    await writeAudit({
      req,
      action: AuditAction.UPDATE,
      entity: "Customer",
      entityId: customer.id,
      summary: `Đổi phụ trách khách ${customer.code}. Lý do: ${body.reason}`,
      changes: diffFields(before as unknown as Record<string, unknown>, data),
    });
    res.json(customer);
  })
);

/**
 * POST /api/customers/:id/hide
 * Không có xoá khách. Chỉ ẩn, bắt buộc lý do — quy tắc trong prototype
 * ("Không xoá được khách. Chỉ Quản lý/Chủ đầu tư được Ẩn kèm lý do").
 */
router.post(
  "/:id/hide",
  requirePermission("customer.delete"),
  asyncHandler(async (req, res) => {
    const { reason } = z.object({ reason: z.string().min(5) }).parse(req.body);
    const before = await prisma.customer.findUnique({ where: { id: req.params.id } });
    assertInScope(req, "customer.delete", before as unknown as Record<string, unknown>, CUSTOMER_SCOPE);

    const customer = await prisma.customer.update({
      where: { id: req.params.id },
      data: { hidden: true, hiddenReason: reason },
    });
    await writeAudit({
      req,
      action: AuditAction.DELETE,
      entity: "Customer",
      entityId: customer.id,
      summary: `Ẩn hồ sơ khách ${customer.code}. Lý do: ${reason}`,
    });
    res.json({ ok: true });
  })
);

/**
 * GET /api/customers/:id/timeline
 * Gộp activity + tin nhắn + lịch hẹn + hợp đồng + phiếu thu thành một dòng
 * thời gian duy nhất — đúng tab "Dòng thời gian" trong prototype.
 */
router.get(
  "/:id/timeline",
  requirePermission("customer.read"),
  asyncHandler(async (req, res) => {
    const customer = await prisma.customer.findUnique({ where: { id: req.params.id } });
    assertInScope(req, "customer.read", customer as unknown as Record<string, unknown>, CUSTOMER_SCOPE);

    const [activities, messages, appointments, contracts, payments] = await Promise.all([
      prisma.activity.findMany({
        where: { customerId: customer!.id },
        orderBy: { createdAt: "desc" },
        take: 100,
      }),
      prisma.chatMessage.findMany({
        where: { conversation: { customerId: customer!.id } },
        orderBy: { createdAt: "desc" },
        take: 30,
        select: { id: true, content: true, direction: true, senderName: true, createdAt: true },
      }),
      prisma.appointment.findMany({
        where: { customerId: customer!.id },
        orderBy: { startAt: "desc" },
        take: 30,
        include: { doctor: { select: { name: true } } },
      }),
      prisma.contract.findMany({
        where: { customerId: customer!.id },
        orderBy: { createdAt: "desc" },
        take: 20,
      }),
      prisma.payment.findMany({
        where: { customerId: customer!.id },
        orderBy: { paidAt: "desc" },
        take: 30,
      }),
    ]);

    const entries = [
      ...activities.map((a) => ({
        at: a.createdAt,
        kind: "activity" as const,
        type: a.type,
        text: a.content,
        by: a.userName,
      })),
      ...messages.map((m) => ({
        at: m.createdAt,
        kind: "message" as const,
        type: m.direction,
        text: m.direction === "IN" ? `Khách nhắn: "${m.content}"` : `Trả lời khách: "${m.content}"`,
        by: m.senderName,
      })),
      ...appointments.map((a) => ({
        at: a.createdAt,
        kind: "appointment" as const,
        type: a.status,
        text: `Lịch ${a.title}: ${formatDateTimeVN(a.startAt)}${a.doctor ? ` với ${a.doctor.name}` : ""}`,
        by: null,
      })),
      ...contracts.map((c) => ({
        at: c.createdAt,
        kind: "contract" as const,
        type: c.status,
        text: `Hợp đồng ${c.code}: ${formatVnd(c.total)}đ`,
        by: null,
      })),
      ...payments.map((p) => ({
        at: p.paidAt,
        kind: "payment" as const,
        type: p.method,
        text: `Thu ${formatVnd(p.amount)}đ, phiếu ${p.code}`,
        by: null,
      })),
    ].sort((a, b) => b.at.getTime() - a.at.getTime());

    res.json(entries.slice(0, 150));
  })
);

// POST /api/customers/:id/activities — ghi chú tay
router.post(
  "/:id/activities",
  requirePermission("customer.update"),
  asyncHandler(async (req, res) => {
    const body = z
      .object({ content: z.string().min(1), type: z.nativeEnum(ActivityType).optional() })
      .parse(req.body);
    const customer = await prisma.customer.findUnique({ where: { id: req.params.id } });
    assertInScope(req, "customer.update", customer as unknown as Record<string, unknown>, CUSTOMER_SCOPE);

    const me = currentUser(req);
    const activity = await prisma.activity.create({
      data: {
        customerId: customer!.id,
        type: body.type ?? ActivityType.NOTE,
        content: body.content,
        userId: me.id,
        userName: me.name,
      },
    });
    await prisma.customer.update({
      where: { id: customer!.id },
      data: { lastContactAt: new Date() },
    });
    res.status(201).json(activity);
  })
);

// ---------------------------------------------------------------- TAGS

router.get(
  "/tags/all",
  requirePermission("customer.read"),
  asyncHandler(async (req, res) => {
    res.json(await prisma.tag.findMany({ orderBy: { name: "asc" }, ...pageQuery(req.query, CATALOG_PAGE) }));
  })
);

router.post(
  "/:id/tags",
  requirePermission("customer.update"),
  asyncHandler(async (req, res) => {
    const { tagId } = z.object({ tagId: z.string().uuid() }).parse(req.body);
    const customer = await prisma.customer.findUnique({ where: { id: req.params.id } });
    assertInScope(req, "customer.update", customer as unknown as Record<string, unknown>, CUSTOMER_SCOPE);

    await prisma.customerTag.upsert({
      where: { customerId_tagId: { customerId: customer!.id, tagId } },
      create: { customerId: customer!.id, tagId },
      update: {},
    });
    res.status(201).json({ ok: true });
  })
);

router.delete(
  "/:id/tags/:tagId",
  requirePermission("customer.update"),
  asyncHandler(async (req, res) => {
    await prisma.customerTag.deleteMany({
      where: { customerId: req.params.id, tagId: req.params.tagId },
    });
    res.json({ ok: true });
  })
);

// ---------------------------------------------------------------- TASKS

/** F27: việc tới hạn hôm nay (giờ VN) = hạn trước 0h ngày mai, kể cả quá hạn, cộng việc không có hạn. */
function todayWhere(meId: string, now = new Date()) {
  const endOfToday = new Date(startOfVnDay(now).getTime() + 86_400_000);
  return {
    assigneeId: meId,
    status: { in: [TaskStatus.OPEN, TaskStatus.IN_PROGRESS] },
    OR: [{ dueAt: { lt: endOfToday } }, { dueAt: null }],
  };
}

// GET /api/customers/tasks/mine?today=1 — "việc cần làm" (F27: trang Việc của tôi hôm nay), có cảnh báo quá hạn
router.get(
  "/tasks/mine",
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const tasks = await prisma.task.findMany({
      where: {
        ...(req.query.today === "1"
          ? todayWhere(me.id)
          : { assigneeId: me.id, status: { in: [TaskStatus.OPEN, TaskStatus.IN_PROGRESS] } }),
        ...(req.query.customerId ? { customerId: String(req.query.customerId) } : {}),
        ...(req.query.kind ? { kind: String(req.query.kind) } : {}),
      },
      orderBy: [{ dueAt: "asc" }, { createdAt: "asc" }],
      ...pageQuery(req.query, { defaultLimit: 200, maxLimit: 500 }),
      include: { customer: { select: { id: true, name: true, code: true, phone: true, stage: true } } },
    });
    const now = Date.now();
    res.json(
      tasks.map((t) => ({
        ...t,
        customer: t.customer ? { ...t.customer, phone: phoneFor(req, t.customer.phone) } : null,
        overdue: Boolean(t.dueAt && t.dueAt.getTime() < now),
      }))
    );
  })
);

/** GET /api/customers/tasks/mine/count — huy hiệu số việc hôm nay trên menu (F27). */
router.get(
  "/tasks/mine/count",
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const now = new Date();
    const [today, overdue] = await Promise.all([
      prisma.task.count({ where: todayWhere(me.id, now) }),
      prisma.task.count({
        where: { assigneeId: me.id, status: { in: [TaskStatus.OPEN, TaskStatus.IN_PROGRESS] }, dueAt: { lt: now } },
      }),
    ]);
    res.json({ today, overdue });
  })
);

router.post(
  "/tasks",
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        customerId: z.string().uuid().optional(),
        title: z.string().min(2),
        description: z.string().optional(),
        priority: z.nativeEnum(TaskPriority).optional(),
        dueAt: z.coerce.date().optional(),
        assigneeId: z.string().uuid().optional(),
      })
      .parse(req.body);

    const me = currentUser(req);
    const task = await prisma.task.create({
      data: {
        ...body,
        branchId: me.activeBranchId,
        assigneeId: body.assigneeId ?? me.id,
        createdById: me.id,
      },
    });
    res.status(201).json(task);
  })
);

router.patch(
  "/tasks/:id",
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        status: z.nativeEnum(TaskStatus).optional(),
        title: z.string().optional(),
        dueAt: z.coerce.date().nullable().optional(),
        assigneeId: z.string().uuid().nullable().optional(),
      })
      .parse(req.body);

    const task = await prisma.task.findUnique({ where: { id: req.params.id } });
    if (!task) throw notFound("Không tìm thấy công việc");
    // Chỉ người được giao, người tạo, hoặc người có quyền sửa khách trong cơ sở của việc.
    const me = currentUser(req);
    const scope = scopeOf(req, "customer.update");
    const manager = scope === "ALL" || (scope === "BRANCH" && (!task.branchId || me.branchIds.includes(task.branchId)));
    if (task.assigneeId !== me.id && task.createdById !== me.id && !manager) throw notFound("Không tìm thấy công việc");

    const updated = await prisma.task.update({
      where: { id: req.params.id },
      data: {
        ...body,
        ...(body.status === TaskStatus.DONE ? { completedAt: new Date() } : {}),
      },
    });
    res.json(updated);
  })
);

export default router;
