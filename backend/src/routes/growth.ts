import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { asyncHandler, HttpError } from "../middleware/errorHandler";
import { requireAuth, currentUser } from "../middleware/auth";
import {
  requirePermission,
  requireAnyPermission,
  requireCrossPersonPermission,
  assertInScope,
  notFound,
} from "../middleware/rbac";
import { writeAudit } from "../lib/audit";
import { formatVnd, startOfVnDay } from "../lib/datetime";
import { resolvePeriod, REAL_MONEY } from "../lib/report-scope";
import { isPeriodKey, vnPeriodKey } from "../lib/metrics";
import { createVoucher, ensureReferralCode, redeemVoucher, setReferrer, voucherState } from "../lib/growth";
import { refreshFirstPurchaseAt, safely } from "../lib/lead-funnel";
import { AuditAction, ReferralRewardStatus, VoucherSource, VoucherStatus } from "../types/enums";

// ĐỢT 3 · TĂNG TRƯỞNG: giới thiệu (F19), voucher và quà (F20), cờ vi phạm
// chuyên môn cho thi đua (F18).

const router = Router();
router.use(requireAuth);

const CUSTOMER_SCOPE = { ownerFields: ["assignedToId", "telesaleId"], branchField: null };

async function loadCustomer(req: Parameters<typeof currentUser>[0], id: string, code: string) {
  const c = await prisma.customer.findUnique({ where: { id } });
  assertInScope(req, code, c as unknown as Record<string, unknown>, CUSTOMER_SCOPE);
  return c!;
}

// ------------------------------------------------------------ F19 GIỚI THIỆU

router.get(
  "/customers/:id/referral",
  requirePermission("customer.read"),
  asyncHandler(async (req, res) => {
    const c = await loadCustomer(req, req.params.id, "customer.read");
    const [referrer, referees, reward, rewards] = await Promise.all([
      c.referredById ? prisma.customer.findUnique({ where: { id: c.referredById }, select: { id: true, code: true, name: true } }) : null,
      prisma.customer.findMany({ where: { referredById: c.id }, select: { id: true, code: true, name: true, referredAt: true }, orderBy: { referredAt: "desc" }, take: 200 }),
      prisma.referralReward.findUnique({ where: { customerId: c.id } }),
      prisma.referralReward.findMany({ where: { referrerId: c.id }, orderBy: { createdAt: "desc" } }),
    ]);
    const rewardedIds = new Set(rewards.map((r) => r.customerId));
    res.json({
      referralCode: c.referralCode,
      referrer,
      referredAt: c.referredAt,
      rewardForThisCustomer: reward,
      referees: referees.map((r) => ({ ...r, rewarded: rewardedIds.has(r.id) })),
      rewards,
    });
  })
);

router.post(
  "/customers/:id/referral-code",
  requirePermission("customer.update"),
  asyncHandler(async (req, res) => {
    const c = await loadCustomer(req, req.params.id, "customer.update");
    const code = await ensureReferralCode(c.id);
    res.json({ referralCode: code });
  })
);

router.post(
  "/customers/:id/referrer",
  requirePermission("customer.update"),
  asyncHandler(async (req, res) => {
    const body = z
      .object({ code: z.string().trim().min(3).max(20).optional(), referrerId: z.string().uuid().optional() })
      .refine((b) => b.code || b.referrerId, "Nhập mã giới thiệu hoặc chọn người giới thiệu")
      .parse(req.body);
    const c = await loadCustomer(req, req.params.id, "customer.update");
    const referrer = await setReferrer(c.id, body);
    await writeAudit({
      req,
      action: AuditAction.UPDATE,
      entity: "Customer",
      entityId: c.id,
      summary: `Ghi nhận ${c.name} (${c.code}) do ${referrer.name} (${referrer.code}) giới thiệu`,
    });
    res.json({ referrer: { id: referrer.id, code: referrer.code, name: referrer.name } });
  })
);

/** Báo cáo giới thiệu: người giới thiệu, số khách mới, đã thưởng, doanh thu từ khách được giới thiệu. */
router.get(
  "/referrals/report",
  requireCrossPersonPermission("customer.read", "accounting.read", "lead.read"),
  asyncHandler(async (req, res) => {
    const period = resolvePeriod(req.query as Record<string, unknown>);
    const range = { gte: period.from, lt: period.to };
    const referees = await prisma.customer.findMany({
      where: { referredById: { not: null }, referredAt: range, mergedIntoId: null },
      select: { id: true, referredById: true },
    });
    const refereeIds = referees.map((r) => r.id);
    const [rewards, paid, pendingCash] = await Promise.all([
      prisma.referralReward.findMany({ where: { customerId: { in: refereeIds } } }),
      prisma.payment.groupBy({ by: ["customerId"], _sum: { amount: true }, where: { customerId: { in: refereeIds }, ...REAL_MONEY } }),
      prisma.referralReward.findMany({ where: { status: ReferralRewardStatus.PENDING_PAYOUT }, orderBy: { createdAt: "asc" }, take: 200 }),
    ]);
    const paidOf = new Map(paid.map((p) => [p.customerId, p._sum.amount ?? 0]));
    const rewardOf = new Map(rewards.map((r) => [r.customerId, r]));
    const byReferrer = new Map<string, { referrerId: string; referees: number; rewarded: number; rewardTotal: number; refereeRevenue: number }>();
    for (const r of referees) {
      const g = byReferrer.get(r.referredById!) ?? { referrerId: r.referredById!, referees: 0, rewarded: 0, rewardTotal: 0, refereeRevenue: 0 };
      g.referees++;
      const rw = rewardOf.get(r.id);
      if (rw) {
        g.rewarded++;
        g.rewardTotal += rw.amount;
      }
      g.refereeRevenue += paidOf.get(r.id) ?? 0;
      byReferrer.set(r.referredById!, g);
    }
    const people = await prisma.customer.findMany({
      where: { id: { in: [...byReferrer.keys(), ...pendingCash.flatMap((p) => [p.referrerId, p.customerId])] } },
      select: { id: true, code: true, name: true },
    });
    const who = new Map(people.map((p) => [p.id, p]));
    const rows = [...byReferrer.values()]
      .map((g) => ({ ...g, referrer: who.get(g.referrerId) ?? null }))
      .sort((a, b) => b.referees - a.referees || b.refereeRevenue - a.refereeRevenue);
    res.json({
      from: period.from,
      to: period.to,
      totals: {
        referees: referees.length,
        rewarded: rewards.length,
        rewardTotal: rewards.reduce((s, r) => s + r.amount, 0),
        refereeRevenue: rows.reduce((s, r) => s + r.refereeRevenue, 0),
      },
      rows,
      pendingCash: pendingCash.map((p) => ({ ...p, referrer: who.get(p.referrerId) ?? null, referee: who.get(p.customerId) ?? null })),
    });
  })
);

router.post(
  "/referral-rewards/:id/paid",
  requirePermission("finance.approve"),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const r = await prisma.referralReward.findUnique({ where: { id: req.params.id } });
    if (!r) throw notFound("Không tìm thấy khoản thưởng");
    if (r.status !== ReferralRewardStatus.PENDING_PAYOUT) throw new HttpError(409, "Khoản thưởng không ở trạng thái chờ chi");
    const updated = await prisma.referralReward.update({
      where: { id: r.id },
      data: { status: ReferralRewardStatus.PAID, paidAt: new Date(), paidById: me.id },
    });
    await writeAudit({ req, action: AuditAction.APPROVE, entity: "ReferralReward", entityId: r.id, summary: `Đã chi thưởng giới thiệu ${formatVnd(r.amount)}đ` });
    res.json(updated);
  })
);

// ------------------------------------------------------------- F20 VOUCHER

router.get(
  "/vouchers",
  requireAnyPermission("finance.read", "customer.read"),
  asyncHandler(async (req, res) => {
    const q = z
      .object({ customerId: z.string().uuid().optional(), status: z.enum(["ACTIVE", "REDEEMED", "CANCELLED", "EXPIRED"]).optional(), q: z.string().max(40).optional() })
      .parse(req.query);
    if (q.customerId) await loadCustomer(req, q.customerId, "customer.read");
    else if (!req.user!.permissions["finance.read"]) throw new HttpError(403, "Chọn khách để xem voucher");
    const now = new Date();
    const rows = await prisma.voucher.findMany({
      where: {
        ...(q.customerId ? { customerId: q.customerId } : {}),
        ...(q.q ? { code: { contains: q.q.toUpperCase() } } : {}),
        ...(q.status === "EXPIRED"
          ? { status: VoucherStatus.ACTIVE, expiresAt: { lte: now } }
          : q.status === "ACTIVE"
            ? { status: VoucherStatus.ACTIVE, expiresAt: { gt: now } }
            : q.status
              ? { status: q.status }
              : {}),
      },
      orderBy: { createdAt: "desc" },
      take: 500,
    });
    const customers = await prisma.customer.findMany({
      where: { id: { in: rows.map((r) => r.customerId).filter((x): x is string => Boolean(x)) } },
      select: { id: true, code: true, name: true },
    });
    const who = new Map(customers.map((c) => [c.id, c]));
    res.json(rows.map((v) => ({ ...v, state: voucherState(v, now), customer: v.customerId ? (who.get(v.customerId) ?? null) : null })));
  })
);

router.post(
  "/vouchers",
  requirePermission("promotion.manage"),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        customerId: z.string().uuid().nullable().optional(),
        value: z.number().int().positive().max(1_000_000_000),
        expiresAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        source: z.enum([VoucherSource.MANUAL, VoucherSource.BIRTHDAY, VoucherSource.GIFT]).default(VoucherSource.MANUAL),
        note: z.string().trim().max(300).optional(),
      })
      .parse(req.body);
    const me = currentUser(req);
    if (body.customerId) await loadCustomer(req, body.customerId, "customer.read");
    // Hết hạn cuối ngày được chọn (giờ VN).
    const expiresAt = new Date(startOfVnDay(new Date(`${body.expiresAt}T12:00:00+07:00`)).getTime() + 86_400_000);
    if (expiresAt <= new Date()) throw new HttpError(400, "Hạn dùng phải sau hôm nay");
    const v = await createVoucher({ ...body, expiresAt, branchId: me.activeBranchId, createdById: me.id });
    await writeAudit({ req, action: AuditAction.CREATE, entity: "Voucher", entityId: v.id, summary: `Tạo voucher ${v.code} ${formatVnd(v.value)}đ, hạn ${body.expiresAt}` });
    res.status(201).json(v);
  })
);

router.post(
  "/vouchers/:id/cancel",
  requirePermission("promotion.manage"),
  asyncHandler(async (req, res) => {
    const r = await prisma.voucher.updateMany({ where: { id: req.params.id, status: VoucherStatus.ACTIVE }, data: { status: VoucherStatus.CANCELLED } });
    if (!r.count) throw new HttpError(409, "Voucher không còn ở trạng thái dùng được");
    await writeAudit({ req, action: AuditAction.UPDATE, entity: "Voucher", entityId: req.params.id, summary: "Huỷ voucher" });
    res.json({ ok: true });
  })
);

router.get(
  "/vouchers/check",
  requirePermission("finance.read"),
  asyncHandler(async (req, res) => {
    const q = z.object({ code: z.string().trim().min(3).max(20), customerId: z.string().uuid().optional() }).parse(req.query);
    const v = await prisma.voucher.findUnique({ where: { code: q.code.toUpperCase() } });
    if (!v) throw notFound("Không tìm thấy voucher");
    const state = voucherState(v);
    const wrongCustomer = Boolean(q.customerId && v.customerId && v.customerId !== q.customerId);
    res.json({ code: v.code, value: v.value, expiresAt: v.expiresAt, state, usable: state === "ACTIVE" && !wrongCustomer, wrongCustomer });
  })
);

/** POST /api/growth/vouchers/redeem: dùng voucher khi thanh toán (trừ vào hoá đơn hoặc hợp đồng). */
router.post(
  "/vouchers/redeem",
  requirePermission("finance.create"),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        code: z.string().trim().min(3).max(20),
        customerId: z.string().uuid(),
        invoiceId: z.string().uuid().optional(),
        contractId: z.string().uuid().optional(),
        branchId: z.string().uuid().optional(),
      })
      .parse(req.body);
    const me = currentUser(req);
    const branchId = body.branchId ?? me.activeBranchId;
    if (!branchId || !me.branchIds.includes(branchId)) throw notFound("Không tìm thấy cơ sở");
    const r = await redeemVoucher({ ...body, branchId, actor: { id: me.id, name: me.name } });
    await safely("mốc mua đầu", () => refreshFirstPurchaseAt(body.customerId));
    await writeAudit({
      req,
      action: AuditAction.UPDATE,
      entity: "Voucher",
      entityId: r.voucherId,
      branchId,
      summary: `Dùng voucher ${body.code.toUpperCase()}: trừ ${formatVnd(r.amount)}đ, phiếu ${r.payment.code}`,
    });
    res.status(201).json(r);
  })
);

// -------------------------------------------------------------- F20 QUÀ TẶNG

router.get(
  "/gift-items",
  requireAnyPermission("visit.read", "finance.read", "promotion.manage"),
  asyncHandler(async (req, res) => {
    res.json(await prisma.giftItem.findMany({ where: req.query.all === "1" ? {} : { active: true }, orderBy: { name: "asc" } }));
  })
);

router.post(
  "/gift-items",
  requirePermission("promotion.manage"),
  asyncHandler(async (req, res) => {
    const body = z.object({ name: z.string().trim().min(2).max(120), cost: z.number().int().min(0).max(100_000_000) }).parse(req.body);
    const item = await prisma.giftItem.create({ data: body });
    await writeAudit({ req, action: AuditAction.CREATE, entity: "GiftItem", entityId: item.id, summary: `Thêm quà ${item.name} (${formatVnd(item.cost)}đ)` });
    res.status(201).json(item);
  })
);

router.patch(
  "/gift-items/:id",
  requirePermission("promotion.manage"),
  asyncHandler(async (req, res) => {
    const body = z
      .object({ name: z.string().trim().min(2).max(120).optional(), cost: z.number().int().min(0).max(100_000_000).optional(), active: z.boolean().optional() })
      .parse(req.body);
    const before = await prisma.giftItem.findUnique({ where: { id: req.params.id } });
    if (!before) throw notFound("Không tìm thấy quà");
    const item = await prisma.giftItem.update({ where: { id: before.id }, data: body });
    await writeAudit({ req, action: AuditAction.UPDATE, entity: "GiftItem", entityId: item.id, summary: `Sửa quà ${item.name}` });
    res.json(item);
  })
);

/** POST /api/growth/gifts: ghi nhận tặng quà khi khách ra về. */
router.post(
  "/gifts",
  requirePermission("visit.update"),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        customerId: z.string().uuid(),
        giftItemId: z.string().uuid(),
        quantity: z.number().int().min(1).max(100).default(1),
        visitId: z.string().uuid().optional(),
        note: z.string().trim().max(300).optional(),
      })
      .parse(req.body);
    const me = currentUser(req);
    const branchId = me.activeBranchId;
    if (!branchId) throw new HttpError(400, "Chưa xác định được cơ sở");
    const [customer, item] = await Promise.all([
      prisma.customer.findUnique({ where: { id: body.customerId }, select: { id: true, name: true } }),
      prisma.giftItem.findUnique({ where: { id: body.giftItemId } }),
    ]);
    if (!customer) throw notFound("Không tìm thấy khách");
    if (!item || !item.active) throw notFound("Không tìm thấy quà trong danh mục");
    const log = await prisma.giftLog.create({
      data: {
        customerId: customer.id,
        branchId,
        giftItemId: item.id,
        giftName: item.name,
        quantity: body.quantity,
        unitCost: item.cost,
        totalCost: item.cost * body.quantity,
        visitId: body.visitId ?? null,
        givenById: me.id,
        givenByName: me.name,
        note: body.note ?? null,
      },
    });
    await writeAudit({
      req,
      action: AuditAction.CREATE,
      entity: "GiftLog",
      entityId: log.id,
      branchId,
      summary: `Tặng ${body.quantity} ${item.name} cho ${customer.name} (chi phí ${formatVnd(log.totalCost)}đ)`,
    });
    res.status(201).json(log);
  })
);

router.get(
  "/gifts",
  requireAnyPermission("visit.read", "finance.read", "accounting.read"),
  asyncHandler(async (req, res) => {
    const q = z.object({ customerId: z.string().uuid().optional() }).parse(req.query);
    const period = resolvePeriod(req.query as Record<string, unknown>);
    const me = currentUser(req);
    const where = {
      branchId: { in: me.branchIds },
      ...(q.customerId ? { customerId: q.customerId } : { createdAt: { gte: period.from, lt: period.to } }),
    };
    const [rows, byItem] = await Promise.all([
      prisma.giftLog.findMany({ where, orderBy: { createdAt: "desc" }, take: 500 }),
      prisma.giftLog.groupBy({ by: ["giftName"], where, _sum: { quantity: true, totalCost: true } }),
    ]);
    const customers = await prisma.customer.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.customerId))] } }, select: { id: true, code: true, name: true } });
    const who = new Map(customers.map((c) => [c.id, c]));
    res.json({
      rows: rows.map((r) => ({ ...r, customer: who.get(r.customerId) ?? null })),
      byItem: byItem.map((b) => ({ giftName: b.giftName, quantity: b._sum.quantity ?? 0, totalCost: b._sum.totalCost ?? 0 })),
      totalCost: byItem.reduce((s, b) => s + (b._sum.totalCost ?? 0), 0),
    });
  })
);

// ------------------------------------------------- F18 CỜ VI PHẠM CHUYÊN MÔN

router.get(
  "/violations",
  requireCrossPersonPermission("hr.read"),
  asyncHandler(async (req, res) => {
    const period = typeof req.query.period === "string" && isPeriodKey(req.query.period) ? req.query.period : vnPeriodKey();
    const me = currentUser(req);
    const rows = await prisma.staffViolationFlag.findMany({
      where: { periodKey: period, OR: [{ branchId: null }, { branchId: { in: me.branchIds } }] },
      orderBy: { createdAt: "desc" },
    });
    const users = await prisma.user.findMany({ where: { id: { in: rows.map((r) => r.userId) } }, select: { id: true, name: true } });
    const nameOf = new Map(users.map((u) => [u.id, u.name]));
    res.json(rows.map((r) => ({ ...r, userName: nameOf.get(r.userId) ?? null })));
  })
);

router.post(
  "/violations",
  requirePermission("hr.update"),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        userId: z.string().uuid(),
        periodKey: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional(),
        reason: z.string().trim().min(5).max(500),
      })
      .parse(req.body);
    const me = currentUser(req);
    const user = await prisma.user.findFirst({ where: { id: body.userId, branches: { some: { branchId: { in: me.branchIds } } } }, select: { id: true, name: true } });
    if (!user) throw notFound("Không tìm thấy nhân viên");
    const flag = await prisma.staffViolationFlag.create({
      data: {
        userId: user.id,
        branchId: me.activeBranchId,
        periodKey: body.periodKey ?? vnPeriodKey(),
        reason: body.reason,
        flaggedById: me.id,
        flaggedByName: me.name,
      },
    });
    await writeAudit({
      req,
      action: AuditAction.CREATE,
      entity: "StaffViolationFlag",
      entityId: flag.id,
      branchId: me.activeBranchId,
      summary: `Gắn cờ vi phạm chuyên môn cho ${user.name} kỳ ${flag.periodKey}: ${body.reason}`,
    });
    res.status(201).json(flag);
  })
);

router.post(
  "/violations/:id/revoke",
  requirePermission("hr.update"),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const r = await prisma.staffViolationFlag.updateMany({ where: { id: req.params.id, revokedAt: null }, data: { revokedAt: new Date(), revokedById: me.id } });
    if (!r.count) throw new HttpError(409, "Cờ đã được gỡ hoặc không tồn tại");
    await writeAudit({ req, action: AuditAction.UPDATE, entity: "StaffViolationFlag", entityId: req.params.id, summary: "Gỡ cờ vi phạm chuyên môn" });
    res.json({ ok: true });
  })
);

export default router;
