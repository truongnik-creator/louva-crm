import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { asyncHandler, HttpError } from "../middleware/errorHandler";
import { requireAuth, currentUser } from "../middleware/auth";
import {
  requirePermission,
  requireAnyPermission,
  requireCrossPersonPermission,
  scopeOf,
  maskCustomerPhones,
} from "../middleware/rbac";
import { writeAudit, writeAccessLog } from "../lib/audit";
import { resolvePeriod, reportBranchScope } from "../lib/report-scope";
import { startOfVnDay, vnDayKey } from "../lib/datetime";
import { isPeriodKey, vnPeriodKey } from "../lib/metrics";
import {
  endOfDay,
  forecast,
  grossMargin,
  lifetimeValue,
  newVsReturning,
  responseBuckets,
  retention,
  retreatDue,
  targetScopeKey,
  weeklyMetrics,
} from "../lib/analytics";
import { importAdCosts } from "../lib/ad-costs";
import { countAccountingRows, writeAccountingWorkbook } from "../lib/accounting-export";
import { leaderboard } from "../lib/growth";
import { runJob } from "../lib/jobs";
import { SCORING_JOB } from "../lib/conversation-scoring";
import { isAiConfigured } from "../lib/ai";
import { AccessResourceType, AccessSeverity, AuditAction, CostSource, JobTrigger, PermissionScope } from "../types/enums";

// ĐỢT 3 · ĐO LƯỜNG: chỉ số tuần Sales và MKT (F15), họp cuối ngày (F16), thi
// đua (F18), lãi gộp (F22), quay lại (F23), tốc độ trả lời (F31), trọn đời
// (F32), xuất kế toán (F33), chỉ tiêu và dự báo (F34), chấm hội thoại (AI4).

const router = Router();
router.use(requireAuth);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const vnDate = (s: string) => startOfVnDay(new Date(`${s}T12:00:00+07:00`));

function periodKeyParam(v: unknown): string {
  const s = typeof v === "string" && v ? v : vnPeriodKey();
  if (!isPeriodKey(s)) throw new HttpError(400, "Kỳ phải có dạng YYYY-MM");
  return s;
}

// ------------------------------------------------------------ F15 CHỈ SỐ TUẦN

router.get(
  "/weekly",
  requireCrossPersonPermission("lead.read", "accounting.read"),
  asyncHandler(async (req, res) => {
    const q = z
      .object({ weeks: z.coerce.number().int().min(1).max(26).default(8), to: z.string().regex(DATE_RE).optional() })
      .parse(req.query);
    const scope = reportBranchScope(req);
    const to = q.to ? vnDate(q.to) : new Date();
    res.json({ weeks: await weeklyMetrics({ weeks: q.weeks, to, scope }) });
  })
);

router.get(
  "/ad-costs",
  requirePermission("lead.read"),
  asyncHandler(async (req, res) => {
    const q = z
      .object({ from: z.string().regex(DATE_RE).optional(), to: z.string().regex(DATE_RE).optional(), campaignId: z.string().uuid().optional() })
      .parse(req.query);
    const me = currentUser(req);
    const from = q.from ? vnDate(q.from) : new Date(startOfVnDay().getTime() - 30 * 86_400_000);
    const to = q.to ? new Date(vnDate(q.to).getTime() + 86_400_000) : new Date(startOfVnDay().getTime() + 86_400_000);
    const rows = await prisma.campaignCost.findMany({
      where: {
        date: { gte: from, lt: to },
        ...(q.campaignId ? { campaignId: q.campaignId } : {}),
        campaign: { OR: [{ branchId: null }, { branchId: { in: me.branchIds } }] },
      },
      orderBy: [{ date: "desc" }],
      take: 2000,
      include: { campaign: { select: { id: true, code: true, name: true, channel: { select: { name: true } } } } },
    });
    res.json(rows.map((r) => ({ ...r, day: vnDayKey(r.date) })));
  })
);

/** PUT /api/analytics/ad-costs: nhập tay chi phí một ngày của một chiến dịch (ghi đè). */
router.put(
  "/ad-costs",
  requirePermission("lead.update"),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        campaignId: z.string().uuid(),
        date: z.string().regex(DATE_RE),
        amount: z.number().int().min(0).max(10_000_000_000),
        note: z.string().trim().max(300).optional(),
      })
      .parse(req.body);
    const campaign = await prisma.campaign.findUnique({ where: { id: body.campaignId } });
    if (!campaign) throw new HttpError(404, "Không tìm thấy chiến dịch");
    const date = vnDate(body.date);
    const row = await prisma.campaignCost.upsert({
      where: { campaignId_date: { campaignId: campaign.id, date } },
      create: { campaignId: campaign.id, date, amount: body.amount, note: body.note, source: CostSource.MANUAL },
      update: { amount: body.amount, note: body.note, source: CostSource.MANUAL },
    });
    await writeAudit({
      req,
      action: AuditAction.UPDATE,
      entity: "CampaignCost",
      entityId: row.id,
      branchId: campaign.branchId,
      summary: `Nhập chi phí ${campaign.name} ngày ${body.date}: ${body.amount.toLocaleString("vi-VN")}đ`,
    });
    res.json(row);
  })
);

/** POST /api/analytics/ad-costs/import: nội dung CSV xuất từ Meta, TikTok. */
router.post(
  "/ad-costs/import",
  requirePermission("lead.update"),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        content: z.string().min(1).max(1_800_000),
        platform: z.enum(["META", "TIKTOK", "AUTO"]).default("AUTO"),
        createMissing: z.boolean().default(false),
        fileName: z.string().max(200).optional(),
      })
      .parse(req.body);
    const me = currentUser(req);
    const result = await importAdCosts({ text: body.content, platform: body.platform, createMissing: body.createMissing, branchId: me.activeBranchId });
    await writeAudit({
      req,
      action: AuditAction.IMPORT,
      entity: "CampaignCost",
      summary: `Nhập chi phí quảng cáo từ tệp ${body.fileName ?? "CSV"} (${result.platform}): ${result.imported} dòng, tạo ${result.createdCampaigns.length} chiến dịch, ${result.unknownCampaigns.length} chiến dịch chưa khớp`,
    });
    res.json(result);
  })
);

// ------------------------------------------------------- F16 HỌP CUỐI NGÀY

router.get(
  "/eod",
  requireAnyPermission("customer.read", "inbox.read"),
  asyncHandler(async (req, res) => {
    const q = z.object({ date: z.string().regex(DATE_RE).optional() }).parse(req.query);
    const me = currentUser(req);
    const scope = reportBranchScope(req);
    // Sale (phạm vi của tôi) chỉ xem dòng của mình; quản lý xem cả đội.
    const s = scopeOf(req, "customer.read");
    const onlyMe = !s || s === PermissionScope.OWN;
    const date = q.date ? vnDate(q.date) : new Date();
    res.json({
      date: vnDayKey(date),
      onlyMe,
      rows: await endOfDay({ date, branchIds: scope.ids, now: new Date(), onlyUserId: onlyMe ? me.id : null }),
    });
  })
);

// ----------------------------------------------------------- F18 THI ĐUA

router.get(
  "/leaderboard",
  requireAnyPermission("customer.read", "hr.read", "inbox.read"),
  asyncHandler(async (req, res) => {
    const period = periodKeyParam(req.query.period);
    const scope = reportBranchScope(req);
    res.json({ period, ...(await leaderboard(period, scope.ids)) });
  })
);

// ---------------------------------------------------- F31 TỐC ĐỘ TRẢ LỜI

router.get(
  "/response-buckets",
  requireCrossPersonPermission("lead.read", "hr.read", "accounting.read"),
  asyncHandler(async (req, res) => {
    const period = resolvePeriod(req.query as Record<string, unknown>);
    const scope = reportBranchScope(req);
    res.json({ from: period.from, to: period.to, ...(await responseBuckets({ gte: period.from, lt: period.to }, scope.ids)) });
  })
);

// ------------------------------------------------------------- F22 LÃI GỘP

router.get(
  "/margin",
  requireCrossPersonPermission("accounting.read"),
  asyncHandler(async (req, res) => {
    const q = z.object({ groupBy: z.enum(["service", "doctor", "branch", "month"]).default("service") }).parse(req.query);
    const period = resolvePeriod(req.query as Record<string, unknown>);
    const scope = reportBranchScope(req);
    res.json({ from: period.from, to: period.to, groupBy: q.groupBy, ...(await grossMargin({ gte: period.from, lt: period.to }, scope.ids, q.groupBy)) });
  })
);

// ---------------------------------------------------------- F23 QUAY LẠI

router.get(
  "/retention",
  requireCrossPersonPermission("accounting.read", "lead.read", "customer.read"),
  asyncHandler(async (req, res) => {
    const q = z
      .object({
        from: z.string().regex(/^\d{4}-\d{2}$/).optional(),
        to: z.string().regex(/^\d{4}-\d{2}$/).optional(),
        serviceId: z.string().uuid().optional(),
      })
      .parse(req.query);
    const scope = reportBranchScope(req);
    res.json({ windows: [90, 180, 365], rows: await retention({ branchIds: scope.ids, now: new Date(), ...q }) });
  })
);

router.get(
  "/retreat-due",
  requirePermission("customer.read"),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const scope = reportBranchScope(req);
    const own = scopeOf(req, "customer.read") === PermissionScope.OWN;
    const rows = await retreatDue({ branchIds: scope.ids, now: new Date(), ownerId: own ? me.id : null });
    res.json(maskCustomerPhones(req, { rows }));
  })
);

// ------------------------------------------------------- F32 TRỌN ĐỜI

router.get(
  "/ltv",
  requireCrossPersonPermission("accounting.read", "lead.read"),
  asyncHandler(async (req, res) => {
    const q = z
      .object({
        groupBy: z.enum(["channel", "campaign", "month"]).default("channel"),
        firstFrom: z.string().regex(DATE_RE).optional(),
        firstTo: z.string().regex(DATE_RE).optional(),
      })
      .parse(req.query);
    const period = resolvePeriod(req.query as Record<string, unknown>);
    const scope = reportBranchScope(req);
    const [split, rows] = await Promise.all([
      newVsReturning({ gte: period.from, lt: period.to }, scope.ids),
      lifetimeValue({
        branchIds: scope.ids,
        groupBy: q.groupBy,
        firstFrom: q.firstFrom ? vnDate(q.firstFrom) : undefined,
        firstTo: q.firstTo ? new Date(vnDate(q.firstTo).getTime() + 86_400_000) : undefined,
      }),
    ]);
    res.json({ from: period.from, to: period.to, split, groupBy: q.groupBy, rows });
  })
);

// ------------------------------------------------ F33 XUẤT EXCEL KẾ TOÁN

router.get(
  "/accounting-export",
  requirePermission("report.export"),
  requireAnyPermission("accounting.read"),
  asyncHandler(async (req, res) => {
    const q = z
      .object({ from: z.string().regex(DATE_RE), to: z.string().regex(DATE_RE) })
      .parse(req.query);
    const from = vnDate(q.from);
    const to = new Date(vnDate(q.to).getTime() + 86_400_000);
    if (to <= from) throw new HttpError(400, "Ngày kết thúc phải sau ngày bắt đầu");
    if (to.getTime() - from.getTime() > 400 * 86_400_000) throw new HttpError(400, "Mỗi lần xuất tối đa 400 ngày");
    const scope = reportBranchScope(req);
    const range = { gte: from, lt: to };
    const rowCount = await countAccountingRows(range, scope.ids);
    await writeAccessLog({
      req,
      resourceType: AccessResourceType.REPORT_EXPORT,
      severity: rowCount > 500 ? AccessSeverity.CRITICAL : AccessSeverity.ELEVATED,
      reason: `Xuất Excel kế toán ${q.from} đến ${q.to}`,
      rowCount,
    });
    const fileName = `ke-toan_${q.from}_${q.to}.xlsx`;
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    await writeAccountingWorkbook(res, range, scope.ids, `Kế toán ${q.from} đến ${q.to}`);
    res.end();
  })
);

// ------------------------------------------------ F34 CHỈ TIÊU, DỰ BÁO

router.get(
  "/targets",
  requireCrossPersonPermission("accounting.read", "hr.read"),
  asyncHandler(async (req, res) => {
    const period = periodKeyParam(req.query.period);
    const me = currentUser(req);
    const rows = await prisma.salesTarget.findMany({
      where: { periodKey: period, OR: [{ branchId: null }, { branchId: { in: me.branchIds } }] },
      orderBy: [{ branchId: "asc" }, { serviceId: "asc" }],
    });
    res.json(rows);
  })
);

router.put(
  "/targets",
  requirePermission("finance.approve"),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        periodKey: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
        branchId: z.string().uuid().nullable().optional(),
        serviceId: z.string().uuid().nullable().optional(),
        targetRevenue: z.number().int().min(0).max(1_000_000_000_000),
        targetShowups: z.number().int().min(0).max(1_000_000).nullable().optional(),
      })
      .parse(req.body);
    const me = currentUser(req);
    if (body.branchId && !me.branchIds.includes(body.branchId)) throw new HttpError(404, "Không tìm thấy cơ sở");
    const scopeKey = targetScopeKey(body.periodKey, body.branchId ?? null, body.serviceId ?? null);
    const data = {
      periodKey: body.periodKey,
      branchId: body.branchId ?? null,
      serviceId: body.serviceId ?? null,
      targetRevenue: body.targetRevenue,
      targetShowups: body.targetShowups ?? null,
    };
    const row = await prisma.salesTarget.upsert({
      where: { scopeKey },
      create: { ...data, scopeKey, createdById: me.id },
      update: data,
    });
    await writeAudit({
      req,
      action: AuditAction.UPDATE,
      entity: "SalesTarget",
      entityId: row.id,
      branchId: row.branchId,
      summary: `Đặt chỉ tiêu ${body.periodKey}${body.branchId ? " theo cơ sở" : ""}${body.serviceId ? " theo dịch vụ" : ""}: ${body.targetRevenue.toLocaleString("vi-VN")}đ`,
    });
    res.json(row);
  })
);

router.delete(
  "/targets/:id",
  requirePermission("finance.approve"),
  asyncHandler(async (req, res) => {
    const row = await prisma.salesTarget.findUnique({ where: { id: req.params.id } });
    const me = currentUser(req);
    if (!row || (row.branchId && !me.branchIds.includes(row.branchId))) throw new HttpError(404, "Không tìm thấy chỉ tiêu");
    await prisma.salesTarget.delete({ where: { id: row.id } });
    await writeAudit({ req, action: AuditAction.DELETE, entity: "SalesTarget", entityId: row.id, summary: `Xoá chỉ tiêu ${row.scopeKey}` });
    res.json({ ok: true });
  })
);

router.get(
  "/forecast",
  requireCrossPersonPermission("accounting.read"),
  asyncHandler(async (req, res) => {
    const period = periodKeyParam(req.query.period);
    const scope = reportBranchScope(req);
    res.json(await forecast({ periodKey: period, branchIds: scope.ids, now: new Date() }));
  })
);

// ------------------------------------------------ AI4 CHẤM HỘI THOẠI

router.get(
  "/conversation-scores",
  requirePermission("inbox.manage_scripts"),
  asyncHandler(async (req, res) => {
    const q = z
      .object({ week: z.string().regex(/^\d{4}-W\d{2}$/).optional(), userId: z.string().uuid().optional() })
      .parse(req.query);
    const scope = reportBranchScope(req);
    const weeks = await prisma.conversationScore.groupBy({
      by: ["weekKey"],
      where: { OR: [{ branchId: { in: scope.ids } }, { branchId: null }] },
      orderBy: { weekKey: "desc" },
      take: 12,
    });
    const week = q.week ?? weeks[0]?.weekKey ?? null;
    const rows = week
      ? await prisma.conversationScore.findMany({
          where: { weekKey: week, OR: [{ branchId: { in: scope.ids } }, { branchId: null }], ...(q.userId ? { userId: q.userId } : {}) },
          orderBy: [{ score: "asc" }],
          take: 1000,
        })
      : [];
    const [users, convs] = await Promise.all([
      prisma.user.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.userId).filter((x): x is string => Boolean(x)))] } }, select: { id: true, name: true } }),
      prisma.conversation.findMany({ where: { id: { in: rows.map((r) => r.conversationId) } }, select: { id: true, title: true } }),
    ]);
    const nameOf = new Map(users.map((u) => [u.id, u.name]));
    const titleOf = new Map(convs.map((c) => [c.id, c.title]));
    const bySale = new Map<string, { userId: string | null; name: string; count: number; total: number }>();
    for (const r of rows) {
      if (r.score === null) continue;
      const k = r.userId ?? "_none";
      const g = bySale.get(k) ?? { userId: r.userId, name: r.userId ? (nameOf.get(r.userId) ?? "Đã xoá") : "Chưa phân công", count: 0, total: 0 };
      g.count++;
      g.total += r.score;
      bySale.set(k, g);
    }
    res.json({
      aiConfigured: isAiConfigured(),
      weeks: weeks.map((w) => w.weekKey),
      week,
      summary: [...bySale.values()].map((g) => ({ ...g, avgScore: Math.round(g.total / g.count) })).sort((a, b) => b.avgScore - a.avgScore),
      rows: rows.map((r) => ({
        ...r,
        userName: r.userId ? (nameOf.get(r.userId) ?? null) : null,
        conversationTitle: titleOf.get(r.conversationId) ?? null,
        criteria: r.criteriaJson ? JSON.parse(r.criteriaJson) : [],
        criteriaJson: undefined,
      })),
    });
  })
);

router.post(
  "/conversation-scores/run",
  requirePermission("inbox.manage_scripts"),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const r = await runJob(SCORING_JOB, { trigger: JobTrigger.MANUAL, force: true, triggeredById: me.id });
    res.json(r);
  })
);

export default router;
