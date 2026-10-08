import { Router, type Request } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { asyncHandler, HttpError } from "../middleware/errorHandler";
import { requireAuth, currentUser } from "../middleware/auth";
import {
  assertBranchAccess,
  hasPermission,
  maskCustomerPhonesInResponse,
  notFound,
  phoneFor,
  requireCrossPersonPermission,
  requirePermission,
  scopeOf,
  scopedWhere,
} from "../middleware/rbac";
import { writeAudit } from "../lib/audit";
import { parsePagination } from "../lib/pagination";
import { formatVnd, startOfVnDay } from "../lib/datetime";
import { getClinicMode, stagesFor } from "../lib/stages";
import { withCode, CodePrefix } from "../lib/codes";
import { discountCapPercent, evaluatePricing, initialApprovalStatus, lineData } from "../lib/pricing";
import { notifyUsers, usersWithPermission } from "../lib/notify";
import {
  CUSTOMER_SCOPE,
  assertCustomerAccess,
  canSeeMoney,
  computeMetrics,
  conversionFromHistory,
  loadPipelineParams,
  parseInterest,
  type CustomerMetrics,
} from "../lib/crm360";
import { buildCustomer360 } from "../lib/customer360";
import { currentOpportunityId, loadSubStages, loadWipLimits, subStageOf } from "../lib/opportunities";
import { suggestUpsells, upsellStats } from "../lib/upsell";
import { PACKAGE_REASON, TIER_LABEL, buildQuoteOptions } from "../lib/quote-options";
import {
  ActivityType,
  AuditAction,
  Heat,
  OpportunityStatus,
  PermissionScope,
  QuotationStatus,
  QuoteTier,
  StageAgeLevel,
  UpsellContext,
  UpsellOfferStatus,
  VisitStatus,
} from "../types/enums";

// Lô 7 · CRM 360 LÔ A.
//
//   /api/customers/pipeline          P1 + P2 + P3 bảng bước khối (Kanban, phễu, bảng)
//   /api/customers/pipeline/prefs    P3 lựa chọn kiểu xem và bộ lọc nhanh của từng người
//   /api/customers/:id/360           C1 + J1 thanh 360, dải hành trình
//   /api/crm360/upsell-*             V2 luật gợi ý bán kèm, ghi nhận nhận / từ chối
//   /api/crm360/quote-options/*      V1 báo giá 3 phương án
//   /api/crm360/counter              V5 màn chốt tại quầy (khách đã check-in hôm nay)
//
// Thiết kế cho Lô B (P6 pipeline theo cơ hội): toàn bộ luật tính nằm ở
// lib/crm360.ts và nhận vào một danh sách "đơn vị trên bảng" (MetricCustomer có
// id, bước, mốc vào bước). Khi chuyển sang Opportunity chỉ cần đổi nguồn dữ
// liệu ở loadBoardUnits(); thẻ, đầu cột, phễu, bộ lọc giữ nguyên.

export const customer360Router = Router();
customer360Router.use(requireAuth);
customer360Router.use(maskCustomerPhonesInResponse);

const router = Router();
router.use(requireAuth);
router.use(maskCustomerPhonesInResponse);
export default router;

// ================================================================ P3 BỘ LỌC

const filterSchema = z.object({
  mine: z.coerce.boolean().optional(),
  hot: z.coerce.boolean().optional(),
  overdue: z.coerce.boolean().optional(),
  branchId: z.string().uuid().optional(),
  serviceId: z.string().uuid().optional(),
  channelId: z.string().uuid().optional(),
  campaignId: z.string().uuid().optional(),
});

const prefsSchema = z.object({
  view: z.enum(["kanban", "funnel", "table"]).default("kanban"),
  filters: filterSchema.default({}),
});

const boolish = z
  .union([z.literal("1"), z.literal("0"), z.literal("true"), z.literal("false"), z.boolean()])
  .optional()
  .transform((v) => v === true || v === "1" || v === "true");

const pipelineQuery = z.object({
  perStage: z.coerce.number().int().min(1).max(200).default(30),
  q: z.string().trim().max(100).optional(),
  mine: boolish,
  hot: boolish,
  overdue: boolish,
  branchId: z.string().uuid().optional(),
  serviceId: z.string().uuid().optional(),
  channelId: z.string().uuid().optional(),
  campaignId: z.string().uuid().optional(),
});

customer360Router.get(
  "/pipeline/prefs",
  requirePermission("customer.read"),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const u = await prisma.user.findUnique({ where: { id: me.id }, select: { boardPrefs: true } });
    let prefs = prefsSchema.parse({});
    try {
      if (u?.boardPrefs) prefs = prefsSchema.parse(JSON.parse(u.boardPrefs));
    } catch {
      // Lựa chọn cũ hỏng định dạng: dùng mặc định.
    }
    res.json(prefs);
  })
);

customer360Router.put(
  "/pipeline/prefs",
  requirePermission("customer.read"),
  asyncHandler(async (req, res) => {
    const prefs = prefsSchema.parse(req.body);
    const me = currentUser(req);
    await prisma.user.update({ where: { id: me.id }, data: { boardPrefs: JSON.stringify(prefs) } });
    res.json(prefs);
  })
);

// ================================================================ P1 P2 P3 BẢNG

interface BoardUnit {
  /** Khoá đơn vị: id cơ hội, hoặc id khách khi khách chưa có cơ hội nào. */
  key: string;
  /** Id khách (giữ tên "id" như Lô A để giao diện, test cũ mở đúng hồ sơ). */
  id: string;
  opportunityId: string | null;
  opportunityTitle: string | null;
  opportunityCount: number;
  primaryUnit: boolean;
  storedSubStage: string | null;
  fixedValue: number | null;
  oppServiceId: string | null;
  ownerId: string | null;
  code: string;
  name: string;
  phone: string | null;
  stage: string;
  lostReason: string | null;
  interest: string | null;
  createdAt: Date;
  stageChangedAt: Date | null;
  lastContactAt: Date | null;
  assignedTo: { id: string; name: string } | null;
  telesale: { id: string; name: string } | null;
  channel: { id: string; name: string } | null;
  campaign: { id: string; name: string } | null;
  branchLinks: Array<{ isPrimary: boolean; branch: { id: string; code: string; shortName: string | null } }>;
}

/**
 * Lô 8 · P6: nguồn "đơn vị trên bảng" là CƠ HỘI. Mỗi khách góp: mọi cơ hội đang
 * mở; không có cơ hội mở thì cơ hội gần nhất (đã thắng hoặc mất, để cột Làm dịch
 * vụ, Quay lại, Mất khách vẫn đủ khách); chưa có cơ hội nào (dữ liệu chưa chuyển)
 * thì chính khách, y như Lô A. Phạm vi xem vẫn theo khách (customer.read).
 */
async function loadBoardUnits(req: Request, q: z.infer<typeof pipelineQuery>): Promise<{ units: BoardUnit[]; baseWhere: Record<string, unknown> }> {
  const { where } = scopedWhere(req, "customer.read", CUSTOMER_SCOPE);
  const me = currentUser(req);
  const and: Record<string, unknown>[] = [where, { hidden: false, mergedIntoId: null }];
  if (q.mine) and.push({ OR: [{ assignedToId: me.id }, { telesaleId: me.id }, { opportunities: { some: { ownerId: me.id, status: OpportunityStatus.OPEN } } }] });
  if (q.branchId) and.push({ branchLinks: { some: { branchId: q.branchId } } });
  if (q.channelId) and.push({ channelId: q.channelId });
  if (q.campaignId) and.push({ OR: [{ campaignId: q.campaignId }, { leadOrigin: { is: { campaignId: q.campaignId } } }] });
  if (q.q) and.push({ OR: [{ name: { contains: q.q } }, { code: { contains: q.q } }, { phone: { contains: q.q.replace(/\s/g, "") } }] });
  const baseWhere = { AND: and };
  const customers = await prisma.customer.findMany({
    where: baseWhere,
    select: {
      id: true,
      code: true,
      name: true,
      phone: true,
      stage: true,
      lostReason: true,
      interest: true,
      createdAt: true,
      stageChangedAt: true,
      lastContactAt: true,
      assignedToId: true,
      telesaleId: true,
      assignedTo: { select: { id: true, name: true } },
      telesale: { select: { id: true, name: true } },
      channel: { select: { id: true, name: true } },
      campaign: { select: { id: true, name: true } },
      branchLinks: { select: { isPrimary: true, branch: { select: { id: true, code: true, shortName: true } } } },
      opportunities: {
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        select: {
          id: true,
          title: true,
          stage: true,
          subStage: true,
          status: true,
          stageChangedAt: true,
          createdAt: true,
          lostReason: true,
          expectedValue: true,
          serviceId: true,
          ownerId: true,
        },
      },
    },
  });
  const units: BoardUnit[] = [];
  for (const c of customers) {
    const { opportunities, assignedToId, telesaleId, ...base } = c;
    const open = opportunities.filter((o) => o.status === OpportunityStatus.OPEN);
    const picked = open.length ? open : opportunities.slice(0, 1);
    if (!picked.length) {
      units.push({ ...base, key: c.id, opportunityId: null, opportunityTitle: null, opportunityCount: 0, primaryUnit: true, storedSubStage: null, fixedValue: null, oppServiceId: null, ownerId: assignedToId ?? telesaleId });
      continue;
    }
    picked.forEach((o, i) => {
      units.push({
        ...base,
        key: o.id,
        opportunityId: o.id,
        opportunityTitle: o.title,
        opportunityCount: opportunities.length,
        primaryUnit: i === 0,
        storedSubStage: o.subStage,
        fixedValue: o.expectedValue,
        oppServiceId: o.serviceId,
        ownerId: o.ownerId ?? assignedToId ?? telesaleId,
        stage: o.stage,
        lostReason: o.lostReason,
        stageChangedAt: o.stageChangedAt,
        createdAt: o.createdAt,
      });
    });
  }
  const mineOk = (u: BoardUnit) => !q.mine || u.ownerId === me.id || u.assignedTo?.id === me.id || u.telesale?.id === me.id;
  return { units: units.filter(mineOk), baseWhere };
}

const LEVEL_ORDER: Record<string, number> = { OVERDUE: 0, WARN: 1, OK: 2, NONE: 3 };
const HEAT_ORDER: Record<string, number> = { HOT: 0, WARM: 1, COLD: 2 };

/**
 * GET /api/customers/pipeline: cột theo bộ bước của chế độ phòng khám. Mỗi cột:
 * số khách, tổng giá trị dự kiến (chỉ vai xem được tiền), số quá hạn, sắp quá
 * hạn, tỉ lệ chuyển sang bước sau trong kỳ; tối đa perStage thẻ (quá hạn, nóng lên trước).
 */
customer360Router.get(
  "/pipeline",
  requirePermission("customer.read"),
  asyncHandler(async (req, res) => {
    const q = pipelineQuery.parse(req.query);
    const now = new Date();
    const mode = await getClinicMode();
    const params = await loadPipelineParams();
    const money = canSeeMoney(req);
    const { units, baseWhere } = await loadBoardUnits(req, q);

    const oppServiceIds = [...new Set(units.map((u) => u.oppServiceId).filter((x): x is string => Boolean(x)))];
    const [subDefs, wipLimits, oppServices] = await Promise.all([
      loadSubStages(),
      loadWipLimits(),
      oppServiceIds.length ? prisma.service.findMany({ where: { id: { in: oppServiceIds } }, select: { id: true, name: true } }) : Promise.resolve([]),
    ]);
    const serviceNameOf = new Map(oppServices.map((x) => [x.id, x.name]));
    const metrics = await computeMetrics(
      units.map((u) => ({
        id: u.key,
        customerId: u.id,
        opportunityId: u.opportunityId,
        fixedValue: u.fixedValue,
        oppServiceId: u.oppServiceId,
        primaryUnit: u.primaryUnit,
        stage: u.stage,
        createdAt: u.createdAt,
        stageChangedAt: u.stageChangedAt,
        interest: u.interest,
        primaryBranchId: u.branchLinks.find((b) => b.isPrimary)?.branch.id ?? u.branchLinks[0]?.branch.id ?? null,
      })),
      { mode, params, now }
    );

    const filtered = units.filter((u) => {
      const m = metrics.get(u.key)!;
      if (q.hot && m.heat.heat !== Heat.HOT) return false;
      if (q.overdue && m.age.level !== StageAgeLevel.OVERDUE) return false;
      if (q.serviceId && !m.serviceIds.includes(q.serviceId)) return false;
      return true;
    });

    const from = new Date(now.getTime() - params.conversionDays * 86_400_000);
    const history = await prisma.stageHistory.findMany({
      where: { createdAt: { gte: from }, customer: baseWhere },
      select: { customerId: true, opportunityId: true, toStage: true, createdAt: true },
    });
    // P6: tỉ lệ chuyển đếm theo cơ hội (dòng cũ chưa gắn cơ hội thì theo khách).
    const conversion = conversionFromHistory(
      history.map((h) => ({ customerId: h.opportunityId ?? h.customerId, toStage: h.toStage, createdAt: h.createdAt })),
      mode
    );

    const stages = stagesFor(mode);
    const funnelKeys = stages.filter((s) => !s.lost).slice(0, 6).map((s) => s.key);
    // Gợi ý kèm ở cột Đến cơ sở (cột "đến quầy" của chế độ phẫu thuật là DEN).
    const counterStage = stages.find((s) => s.key === "DEN_CO_SO" || s.key === "DEN")?.key;

    const columns = await Promise.all(
      stages.map(async (st, idx) => {
        const inCol = filtered.filter((u) => u.stage === st.key);
        inCol.sort((a, b) => {
          const ma = metrics.get(a.key)!;
          const mb = metrics.get(b.key)!;
          return (
            LEVEL_ORDER[ma.age.level] - LEVEL_ORDER[mb.age.level] ||
            HEAT_ORDER[ma.heat.heat] - HEAT_ORDER[mb.heat.heat] ||
            mb.age.days - ma.age.days
          );
        });
        const totalValue = inCol.reduce((s, u) => s + (metrics.get(u.key)!.expectedValue ?? 0), 0);
        const items = await Promise.all(
          inCol.slice(0, q.perStage).map(async (u) => {
            const m = metrics.get(u.key)!;
            let upsellHint: string[] | null = null;
            if (st.key === counterStage && m.serviceIds.length) {
              const primary = u.branchLinks.find((b) => b.isPrimary)?.branch.id ?? u.branchLinks[0]?.branch.id ?? null;
              const s = await suggestUpsells(u.id, { branchId: primary, triggerServiceIds: m.serviceIds, limit: 2, now });
              upsellHint = s.length ? s.map((x) => x.suggestServiceName) : null;
            }
            const serviceName = u.oppServiceId ? (serviceNameOf.get(u.oppServiceId) ?? null) : null;
            return cardOf(req, u, m, money, upsellHint, subStageOf(subDefs, u.stage, u.storedSubStage, m.deposit), serviceName);
          })
        );
        const next = stages[idx + 1];
        const conv = st.lost ? null : (conversion.get(st.key) ?? null);
        return {
          key: st.key,
          label: st.label,
          bg: st.bg,
          fg: st.fg,
          lost: Boolean(st.lost),
          inFunnel: funnelKeys.includes(st.key),
          count: inCol.length,
          // Khách đã mất không còn là giá trị dự kiến của phễu.
          totalValue: money && !st.lost ? totalValue : null,
          overdueCount: inCol.filter((u) => metrics.get(u.key)!.age.level === StageAgeLevel.OVERDUE).length,
          warnCount: inCol.filter((u) => metrics.get(u.key)!.age.level === StageAgeLevel.WARN).length,
          maxDays: inCol.length ? metrics.get(inCol[0].key)!.age.maxDays : null,
          // P4: giới hạn số thẻ (cảnh báo, không chặn) và bước con.
          wipLimit: wipLimits.get(st.key) ?? null,
          overWip: wipLimits.has(st.key) ? inCol.length > wipLimits.get(st.key)! : false,
          subStages: (subDefs.get(st.key) ?? []).map((d) => ({
            ...d,
            count: inCol.filter((u) => subStageOf(subDefs, u.stage, u.storedSubStage, metrics.get(u.key)!.deposit) === d.key).length,
          })),
          conversion: next && !next.lost && conv ? conv : null,
          items,
        };
      })
    );

    res.json({ mode, moneyVisible: money, periodDays: params.conversionDays, total: filtered.length, columns });
  })
);

function cardOf(req: Request, u: BoardUnit, m: CustomerMetrics, money: boolean, upsellHint: string[] | null, subStage: string | null, serviceName: string | null) {
  return {
    id: u.id,
    opportunityId: u.opportunityId,
    opportunityTitle: u.opportunityTitle,
    /** Dịch vụ của cơ hội (trống: cơ hội cũ không có dịch vụ, giao diện dùng dịch vụ quan tâm). */
    serviceName,
    opportunityCount: u.opportunityCount,
    subStage,
    code: u.code,
    name: u.name,
    phone: phoneFor(req, u.phone),
    stage: u.stage,
    lostReason: u.lostReason,
    interest: parseInterest(u.interest),
    assignedTo: u.assignedTo,
    telesale: u.telesale,
    channel: u.channel,
    campaign: u.campaign,
    branches: u.branchLinks.map((b) => b.branch),
    lastContactAt: u.lastContactAt,
    daysInStage: m.age.days,
    maxDays: m.age.maxDays,
    ageLevel: m.age.level,
    heat: m.heat.heat,
    heatFactors: m.heat.factors,
    expectedValue: money ? m.expectedValue : null,
    valueSource: m.valueSource,
    deposit: m.deposit,
    nextAppointmentAt: m.nextAppointmentAt,
    nextTask: m.nextTask,
    openQuoteCount: m.openQuoteCount,
    upsellHint,
  };
}

// ================================================================ C1 + J1

customer360Router.get(
  "/:id/360",
  requirePermission("customer.read"),
  asyncHandler(async (req, res) => {
    res.json(await buildCustomer360(req, req.params.id));
  })
);

// ================================================================ V2 LUẬT BÁN KÈM

const ruleBody = z.object({
  branchId: z.string().uuid().nullable().optional(),
  triggerServiceId: z.string().uuid(),
  suggestServiceId: z.string().uuid(),
  pitch: z.string().trim().min(5, "Lời gợi ý tối thiểu 5 ký tự").max(500),
  conditionNote: z.string().trim().max(500).nullable().optional(),
  onlyIfNotDone: z.boolean().default(true),
  priority: z.number().int().min(-100).max(100).default(0),
  active: z.boolean().default(true),
});

/** Quản lý cơ sở chỉ khai luật cho cơ sở của mình; luật áp mọi cơ sở cần phạm vi toàn hệ thống. */
function assertRuleBranch(req: Request, branchId: string | null | undefined) {
  if (!branchId) {
    if (scopeOf(req, "upsell.manage") !== PermissionScope.ALL) {
      throw new HttpError(403, "Luật áp cho mọi cơ sở cần quyền toàn hệ thống: chọn cơ sở của bạn");
    }
    return;
  }
  assertBranchAccess(req, branchId, "upsell.manage");
}

const ruleInclude = {
  triggerService: { select: { id: true, name: true } },
  suggestService: { select: { id: true, name: true } },
} as const;

router.get(
  "/upsell-rules",
  requirePermission("customer.read"),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const all = scopeOf(req, "upsell.manage") === PermissionScope.ALL;
    const rows = await prisma.upsellRule.findMany({
      where: all ? {} : { OR: [{ branchId: null }, { branchId: { in: me.branchIds } }] },
      orderBy: [{ active: "desc" }, { priority: "desc" }, { createdAt: "asc" }],
      include: ruleInclude,
    });
    res.json({ items: rows, canManage: hasPermission(req, "upsell.manage"), canReview: hasPermission(req, "upsell.review") });
  })
);

async function assertServices(a: string, b: string) {
  if (a === b) throw new HttpError(400, "Dịch vụ gợi ý phải khác dịch vụ gốc");
  const n = await prisma.service.count({ where: { id: { in: [a, b] }, active: true } });
  if (n !== 2) throw new HttpError(400, "Dịch vụ không có trong bảng giá hoặc đã ngừng");
}

router.post(
  "/upsell-rules",
  requirePermission("upsell.manage"),
  asyncHandler(async (req, res) => {
    const body = ruleBody.parse(req.body);
    assertRuleBranch(req, body.branchId);
    await assertServices(body.triggerServiceId, body.suggestServiceId);
    const me = currentUser(req);
    const rule = await prisma.upsellRule.create({ data: { ...body, branchId: body.branchId ?? null, createdById: me.id }, include: ruleInclude });
    await writeAudit({
      req,
      action: AuditAction.CREATE,
      entity: "UpsellRule",
      entityId: rule.id,
      branchId: rule.branchId,
      summary: `Thêm luật bán kèm: ${rule.triggerService.name} → ${rule.suggestService.name}`,
    });
    res.status(201).json(rule);
  })
);

router.patch(
  "/upsell-rules/:id",
  requirePermission("upsell.manage"),
  asyncHandler(async (req, res) => {
    const body = ruleBody.partial().parse(req.body);
    const before = await prisma.upsellRule.findUnique({ where: { id: req.params.id } });
    if (!before) throw notFound();
    assertRuleBranch(req, before.branchId);
    if (body.branchId !== undefined) assertRuleBranch(req, body.branchId);
    if (body.triggerServiceId || body.suggestServiceId) {
      await assertServices(body.triggerServiceId ?? before.triggerServiceId, body.suggestServiceId ?? before.suggestServiceId);
    }
    // Sửa nội dung chuyên môn (dịch vụ, lời gợi ý, điều kiện) của luật đã duyệt thì luật quay lại chờ bác sĩ duyệt.
    const contentChanged =
      (body.pitch !== undefined && body.pitch !== before.pitch) ||
      (body.conditionNote !== undefined && body.conditionNote !== before.conditionNote) ||
      (body.triggerServiceId !== undefined && body.triggerServiceId !== before.triggerServiceId) ||
      (body.suggestServiceId !== undefined && body.suggestServiceId !== before.suggestServiceId);
    const rule = await prisma.upsellRule.update({
      where: { id: before.id },
      data: { ...body, ...(contentChanged && before.reviewedAt ? { reviewedAt: null, reviewedById: null } : {}) },
      include: ruleInclude,
    });
    await writeAudit({
      req,
      action: AuditAction.UPDATE,
      entity: "UpsellRule",
      entityId: rule.id,
      branchId: rule.branchId,
      summary: `Sửa luật bán kèm: ${rule.triggerService.name} → ${rule.suggestService.name}${body.active === false ? " (tắt)" : ""}`,
    });
    res.json(rule);
  })
);

/** POST /api/crm360/upsell-rules/:id/review: bác sĩ duyệt chuyên môn, gỡ nhãn "mẫu, chờ bác sĩ duyệt". */
router.post(
  "/upsell-rules/:id/review",
  requirePermission("upsell.review"),
  asyncHandler(async (req, res) => {
    const before = await prisma.upsellRule.findUnique({ where: { id: req.params.id } });
    if (!before) throw notFound();
    if (before.branchId) assertBranchAccess(req, before.branchId, "upsell.review");
    const me = currentUser(req);
    const rule = await prisma.upsellRule.update({
      where: { id: before.id },
      data: { isSample: false, reviewedById: me.id, reviewedAt: new Date() },
      include: ruleInclude,
    });
    await writeAudit({
      req,
      action: AuditAction.APPROVE,
      entity: "UpsellRule",
      entityId: rule.id,
      branchId: rule.branchId,
      summary: `Bác sĩ duyệt luật bán kèm: ${rule.triggerService.name} → ${rule.suggestService.name}`,
    });
    res.json(rule);
  })
);

/** GET /api/crm360/customers/:id/upsell: gợi ý bán kèm cho khách (phiếu tư vấn, quầy, hộp thư). */
router.get(
  "/customers/:id/upsell",
  requirePermission("customer.read"),
  asyncHandler(async (req, res) => {
    const customer = await prisma.customer.findUnique({
      where: { id: req.params.id },
      include: { branchLinks: { select: { branchId: true, isPrimary: true } } },
    });
    await assertCustomerAccess(req, customer as unknown as Record<string, unknown>);
    const me = currentUser(req);
    const branchId = me.activeBranchId ?? customer!.branchLinks.find((b) => b.isPrimary)?.branchId ?? null;
    res.json({ items: await suggestUpsells(customer!.id, { branchId }) });
  })
);

/**
 * POST /api/crm360/upsell-offers: ghi nhận đã gợi ý / khách nhận / khách từ chối.
 * Cùng khách, cùng dịch vụ gợi ý, hôm nay đã có dòng "đã gợi ý" thì cập nhật dòng
 * đó (không đếm gợi ý hai lần khi tư vấn viên bấm gợi ý rồi bấm nhận).
 */
router.post(
  "/upsell-offers",
  requirePermission("customer.update"),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        customerId: z.string().uuid(),
        suggestServiceId: z.string().uuid(),
        ruleId: z.string().uuid().nullable().optional(),
        triggerServiceId: z.string().uuid().nullable().optional(),
        context: z.nativeEnum(UpsellContext),
        status: z.nativeEnum(UpsellOfferStatus).default(UpsellOfferStatus.SUGGESTED),
        declineReason: z.string().trim().max(300).nullable().optional(),
        quotationId: z.string().uuid().nullable().optional(),
      })
      .parse(req.body);
    const customer = await prisma.customer.findUnique({ where: { id: body.customerId } });
    await assertCustomerAccess(req, customer as unknown as Record<string, unknown>, "customer.update");
    if (body.ruleId) {
      const rule = await prisma.upsellRule.findUnique({ where: { id: body.ruleId }, select: { suggestServiceId: true } });
      if (!rule || rule.suggestServiceId !== body.suggestServiceId) throw new HttpError(400, "Luật bán kèm không khớp dịch vụ gợi ý");
    }
    const me = currentUser(req);
    const now = new Date();
    const decided = body.status !== UpsellOfferStatus.SUGGESTED;
    const open = await prisma.upsellOffer.findFirst({
      where: {
        customerId: body.customerId,
        suggestServiceId: body.suggestServiceId,
        status: UpsellOfferStatus.SUGGESTED,
        suggestedAt: { gte: startOfVnDay(now) },
      },
      orderBy: { suggestedAt: "desc" },
    });
    const decision = decided
      ? { status: body.status, decidedById: me.id, decidedAt: now, declineReason: body.status === UpsellOfferStatus.DECLINED ? (body.declineReason ?? null) : null }
      : {};
    const offer = open
      ? await prisma.upsellOffer.update({
          where: { id: open.id },
          data: { ...decision, ...(body.quotationId ? { quotationId: body.quotationId } : {}) },
        })
      : await prisma.upsellOffer.create({
          data: {
            customerId: body.customerId,
            suggestServiceId: body.suggestServiceId,
            ruleId: body.ruleId ?? null,
            triggerServiceId: body.triggerServiceId ?? null,
            branchId: me.activeBranchId,
            context: body.context,
            suggestedById: me.id,
            quotationId: body.quotationId ?? null,
            ...decision,
          },
        });
    if (decided) {
      const svc = await prisma.service.findUnique({ where: { id: body.suggestServiceId }, select: { name: true } });
      await prisma.activity.create({
        data: {
          customerId: body.customerId,
          type: ActivityType.NOTE,
          content: `Gợi ý bán kèm "${svc?.name ?? ""}": khách ${body.status === UpsellOfferStatus.ACCEPTED ? "nhận" : "từ chối"}${
            offer.declineReason ? `. Lý do: ${offer.declineReason}` : ""
          }`,
          userId: me.id,
          userName: me.name,
        },
      });
    }
    await writeAudit({
      req,
      action: open ? AuditAction.UPDATE : AuditAction.CREATE,
      entity: "UpsellOffer",
      entityId: offer.id,
      summary: `Bán kèm cho khách ${customer!.code}: ${offer.status}`,
    });
    res.status(open ? 200 : 201).json(offer);
  })
);

/** GET /api/crm360/upsell-offers/stats?days=30: tỉ lệ nhận gợi ý theo luật (chỉ đo, không nối lương). */
router.get(
  "/upsell-offers/stats",
  requireCrossPersonPermission("upsell.manage", "accounting.read"),
  asyncHandler(async (req, res) => {
    const { days } = z.object({ days: z.coerce.number().int().min(1).max(366).default(30) }).parse(req.query);
    const me = currentUser(req);
    const now = new Date();
    const all = scopeOf(req, "upsell.manage") === PermissionScope.ALL || scopeOf(req, "accounting.read") === PermissionScope.ALL;
    res.json({ days, ...(await upsellStats({ gte: new Date(now.getTime() - days * 86_400_000), lt: now }, all ? null : me.branchIds)) });
  })
);

// ================================================================ V1 BÁO GIÁ 3 PHƯƠNG ÁN

const optionsBody = z.object({
  customerId: z.string().uuid(),
  planId: z.string().uuid().optional().nullable(),
  sessionId: z.string().uuid().optional().nullable(),
  branchId: z.string().uuid().optional().nullable(),
});

async function optionsFor(req: Request, body: z.infer<typeof optionsBody>) {
  const customer = await prisma.customer.findUnique({ where: { id: body.customerId } });
  await assertCustomerAccess(req, customer as unknown as Record<string, unknown>);
  const me = currentUser(req);
  if (body.branchId && !me.branchIds.includes(body.branchId)) throw notFound("Không thuộc cơ sở này");
  const result = await buildQuoteOptions({ ...body, branchId: body.branchId ?? null, roles: me.roles });
  if (!me.branchIds.includes(result.branchId) && scopeOf(req, "sales_order.read") !== PermissionScope.ALL) {
    throw notFound("Phác đồ thuộc cơ sở khác");
  }
  return { customer: customer!, result };
}

/** POST /api/crm360/quote-options/preview: ba phương án đặt cạnh nhau (chưa ghi gì). */
router.post(
  "/quote-options/preview",
  requirePermission("sales_order.read"),
  asyncHandler(async (req, res) => {
    const { result } = await optionsFor(req, optionsBody.parse(req.body));
    res.json(result);
  })
);

/**
 * POST /api/crm360/quote-options/choose { tier, accept }: lập báo giá thật từ phương
 * án đã chọn (đi lại evaluatePricing: trần giảm, ưu đãi, giá sàn). accept = true
 * (nút Chốt ở quầy) thì báo giá chuyển "khách đồng ý" luôn. Dòng bán kèm trong
 * phương án Trọn gói ghi UpsellOffer "khách nhận".
 */
router.post(
  "/quote-options/choose",
  requirePermission("sales_order.create"),
  asyncHandler(async (req, res) => {
    const body = optionsBody
      .extend({
        tier: z.nativeEnum(QuoteTier),
        accept: z.boolean().default(false),
        context: z.nativeEnum(UpsellContext).default(UpsellContext.QUOTE),
      })
      .parse(req.body);
    const { customer, result } = await optionsFor(req, body);
    const option = result.options.find((o) => o.tier === body.tier)!;
    const me = currentUser(req);
    const capPercent = await discountCapPercent(me.roles);
    const priced = await evaluatePricing(
      option.lines.map((l) => ({
        serviceId: l.serviceId,
        name: l.name,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        discount: l.discount,
        promotionId: l.promotionId,
        discountReason: l.extraDiscount > 0 ? PACKAGE_REASON : null,
      })),
      { branchId: result.branchId, capPercent }
    );
    // Phần giảm thêm đã kẹp trần nên không bao giờ cần duyệt; giữ kiểm tra để không lách được luật.
    if (priced.needsApproval) throw new HttpError(409, "Phương án vượt trần giảm của bạn: lập báo giá để quản lý duyệt");
    const accept = body.accept;
    const oppIdForQuote = await currentOpportunityId(customer.id);
    const quotation = await withCode(CodePrefix.QUOTATION, (code) =>
      prisma.quotation.create({
        data: {
          code,
          branchId: result.branchId,
          customerId: customer.id,
          subtotal: priced.subtotal,
          discount: priced.discount,
          total: priced.total,
          note: `Phương án ${TIER_LABEL[body.tier]} (báo giá 3 phương án, từ ${result.source.kind === "PLAN" ? `phác đồ "${result.source.title}"` : "phiếu tư vấn"})`,
          createdById: me.id,
          optionTier: body.tier,
          opportunityId: oppIdForQuote,
          approvalStatus: initialApprovalStatus(false),
          status: accept ? QuotationStatus.ACCEPTED : QuotationStatus.DRAFT,
          decidedAt: accept ? new Date() : null,
          items: { create: priced.lines.map(lineData) },
        },
        include: { items: true },
      })
    );
    if (result.source.kind === "PLAN") {
      await prisma.treatmentPlan.updateMany({ where: { id: result.source.id, quotationId: null }, data: { quotationId: quotation.id } });
    }
    const upsellLines = option.lines.filter((l) => l.upsellRuleId);
    for (const l of upsellLines) {
      await prisma.upsellOffer.create({
        data: {
          customerId: customer.id,
          ruleId: l.upsellRuleId!,
          suggestServiceId: l.serviceId,
          branchId: result.branchId,
          context: body.context,
          status: UpsellOfferStatus.ACCEPTED,
          quotationId: quotation.id,
          suggestedById: me.id,
          decidedById: me.id,
          decidedAt: new Date(),
        },
      });
    }
    await prisma.activity.create({
      data: {
        customerId: customer.id,
        type: ActivityType.QUOTATION,
        content: `${me.name} ${accept ? "chốt" : "lập"} báo giá ${quotation.code} phương án ${TIER_LABEL[body.tier]}: ${formatVnd(quotation.total)}đ`,
        userId: me.id,
        userName: me.name,
      },
    });
    await writeAudit({
      req,
      action: AuditAction.CREATE,
      entity: "Quotation",
      entityId: quotation.id,
      branchId: result.branchId,
      summary: `Lập báo giá ${quotation.code} phương án ${TIER_LABEL[body.tier]} cho ${customer.code}: ${formatVnd(quotation.total)}đ${accept ? " (khách đồng ý)" : ""}`,
    });
    if (accept) {
      const accountants = await usersWithPermission("finance.create", result.branchId);
      await notifyUsers(
        accountants.map((a) => a.id).filter((id) => id !== me.id).slice(0, 20),
        { title: `Khách ${customer.name} chốt báo giá ${quotation.code}`, body: `${TIER_LABEL[body.tier]}: ${formatVnd(quotation.total)}đ`, level: "INFO", link: `/khach-hang/${customer.id}` }
      ).catch(() => undefined);
    }
    res.status(201).json({ quotation, upsellAccepted: upsellLines.length });
  })
);

// ================================================================ V5 CHỐT TẠI QUẦY

/** GET /api/crm360/counter: khách đã check-in hôm nay ở cơ sở đang chọn, chưa rời quầy. */
router.get(
  "/counter",
  requirePermission("visit.read"),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const branchId = z.string().uuid().optional().parse(req.query.branchId || undefined) ?? me.activeBranchId;
    if (!branchId) throw new HttpError(400, "Chưa chọn cơ sở");
    assertBranchAccess(req, branchId, "visit.read");
    const page = parsePagination(req.query, { defaultLimit: 100, maxLimit: 200 });
    const visits = await prisma.visit.findMany({
      where: {
        branchId,
        checkedInAt: { gte: startOfVnDay(new Date()) },
        status: { notIn: [VisitStatus.DONE, VisitStatus.LEFT] },
        ...(scopeOf(req, "visit.read") === PermissionScope.OWN ? { consultantId: me.id } : {}),
      },
      orderBy: { checkedInAt: "asc" },
      take: page.take,
      skip: page.skip,
      select: {
        id: true,
        queueNumber: true,
        status: true,
        checkedInAt: true,
        purpose: true,
        consultant: { select: { id: true, name: true } },
        customer: { select: { id: true, code: true, name: true, phone: true, stage: true } },
      },
    });
    res.json({ items: visits.map((v) => ({ ...v, mine: v.consultant?.id === me.id })) });
  })
);
