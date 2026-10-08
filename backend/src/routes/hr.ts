import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { formatVnd } from "../lib/datetime";
import { pageQuery, CATALOG_PAGE } from "../lib/pagination";
import { asyncHandler, HttpError } from "../middleware/errorHandler";
import { requireAuth, currentUser } from "../middleware/auth";
import { requirePermission, scopeOf, notFound } from "../middleware/rbac";
import { writeAudit } from "../lib/audit";
import {
  AttendanceStatus,
  AuditAction,
  CommissionBasis,
  CommissionStatus,
  KpiGroup,
  LeaveStatus,
  LeaveType,
  PermissionScope,
} from "../types/enums";

// CHẤM CÔNG · HOA HỒNG · KPI.
//
// Nguyên tắc lấy từ tài liệu vận hành, cài cứng vào mã:
//   1. Hoa hồng tính trên TIỀN THỰC THU, không phải doanh số ký.
//   2. KPI điều dưỡng/bác sĩ TÁCH khỏi doanh số — gắn tiền vào tay người chỉ
//      định chuyên môn là mô hình tự huỷ.
//   3. Chốt kỳ rồi thì không tính lại được, để bảng lương có căn cứ cố định.

const router = Router();
router.use(requireAuth);

/** "2026-08" — khoá kỳ dùng chung cho hoa hồng, KPI, bảng lương. */
function periodKeyOf(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function periodRange(key: string): { gte: Date; lt: Date } {
  const [y, m] = key.split("-").map(Number);
  return { gte: new Date(y, m - 1, 1), lt: new Date(y, m, 1) };
}

/* ------------------------------------------------------------- CHẤM CÔNG */

router.get(
  "/attendances",
  requirePermission("hr.read"),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const scope = scopeOf(req, "hr.read");
    const key = String(req.query.period ?? periodKeyOf());
    const range = periodRange(key);

    const rows = await prisma.attendance.findMany({
      ...pageQuery(req.query, { defaultLimit: 500, maxLimit: 2000 }),
      where: {
        branchId: { in: me.branchIds },
        date: range,
        ...(scope === PermissionScope.OWN ? { userId: me.id } : {}),
        ...(req.query.userId ? { userId: String(req.query.userId) } : {}),
      },
      orderBy: [{ date: "desc" }],
      include: { user: { select: { id: true, name: true, title: true } } },
    });

    res.json({
      period: key,
      items: rows,
      stats: {
        present: rows.filter((r) => r.status === AttendanceStatus.PRESENT).length,
        late: rows.filter((r) => r.lateMinutes > 0).length,
        absent: rows.filter((r) => r.status === AttendanceStatus.ABSENT).length,
        onLeave: rows.filter((r) => r.status === AttendanceStatus.ON_LEAVE).length,
      },
    });
  })
);

/**
 * POST /api/hr/attendances/check-in
 * Đối chiếu với ca đã xếp để tính đi muộn. Không có ca thì vẫn chấm được nhưng
 * ghi rõ là ngoài ca — quản lý tự xử lý.
 */
router.post(
  "/attendances/check-in",
  requirePermission("hr.create"),
  asyncHandler(async (req, res) => {
    const body = z
      .object({ userId: z.string().uuid().optional(), note: z.string().optional() })
      .parse(req.body);

    const me = currentUser(req);
    const userId = body.userId ?? me.id;
    if (!me.activeBranchId) throw new HttpError(400, "Chưa xác định được cơ sở");

    const now = new Date();
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    const shift = await prisma.shiftAssignment.findFirst({
      where: { userId, date: day },
      include: { template: true },
    });

    let lateMinutes = 0;
    if (shift?.template) {
      const [h, m] = shift.template.startTime.split(":").map(Number);
      const expected = new Date(day);
      expected.setHours(h, m, 0, 0);
      lateMinutes = Math.max(0, Math.round((now.getTime() - expected.getTime()) / 60000));
    }

    const record = await prisma.attendance.upsert({
      where: { userId_date: { userId, date: day } },
      create: {
        userId,
        branchId: me.activeBranchId,
        shiftId: shift?.id,
        date: day,
        checkInAt: now,
        lateMinutes,
        status: lateMinutes > 0 ? AttendanceStatus.LATE : AttendanceStatus.PRESENT,
        note: body.note,
      },
      update: {},
      include: { user: { select: { id: true, name: true } } },
    });

    res.status(201).json({ ...record, hadShift: Boolean(shift) });
  })
);

router.post(
  "/attendances/check-out",
  requirePermission("hr.update"),
  asyncHandler(async (req, res) => {
    const body = z.object({ userId: z.string().uuid().optional() }).parse(req.body);
    const me = currentUser(req);
    const userId = body.userId ?? me.id;
    const now = new Date();
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    const existing = await prisma.attendance.findUnique({
      where: { userId_date: { userId, date: day } },
      include: { shift: { include: { template: true } } },
    });
    if (!existing) throw new HttpError(400, "Chưa có bản ghi chấm công vào hôm nay");

    let earlyMinutes = 0;
    if (existing.shift?.template) {
      const [h, m] = existing.shift.template.endTime.split(":").map(Number);
      const expected = new Date(day);
      expected.setHours(h, m, 0, 0);
      earlyMinutes = Math.max(0, Math.round((expected.getTime() - now.getTime()) / 60000));
    }

    const workedMinutes = existing.checkInAt
      ? Math.max(0, Math.round((now.getTime() - existing.checkInAt.getTime()) / 60000))
      : 0;

    res.json(
      await prisma.attendance.update({
        where: { id: existing.id },
        data: { checkOutAt: now, earlyMinutes, workedMinutes },
      })
    );
  })
);

/* ------------------------------------------------------------- NGHỈ PHÉP */

router.get(
  "/leaves",
  requirePermission("hr.read"),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const scope = scopeOf(req, "hr.read");
    res.json(
      await prisma.leaveRequest.findMany({
        where: {
          branchId: { in: me.branchIds },
          ...(scope === PermissionScope.OWN ? { userId: me.id } : {}),
          ...(req.query.status ? { status: String(req.query.status) } : {}),
        },
        orderBy: { createdAt: "desc" },
        ...pageQuery(req.query, { defaultLimit: 200, maxLimit: 500 }),
        include: {
          user: { select: { id: true, name: true } },
          approver: { select: { id: true, name: true } },
        },
      })
    );
  })
);

router.post(
  "/leaves",
  requirePermission("hr.create"),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        type: z.nativeEnum(LeaveType).optional(),
        fromDate: z.coerce.date(),
        toDate: z.coerce.date(),
        reason: z.string().min(3),
        userId: z.string().uuid().optional(),
      })
      .parse(req.body);

    const me = currentUser(req);
    if (!me.activeBranchId) throw new HttpError(400, "Chưa xác định được cơ sở");
    if (body.toDate < body.fromDate) throw new HttpError(400, "Ngày kết thúc phải sau ngày bắt đầu");

    const days = Math.max(
      1,
      Math.round((body.toDate.getTime() - body.fromDate.getTime()) / 86400000) + 1
    );

    const leave = await prisma.leaveRequest.create({
      data: {
        userId: body.userId ?? me.id,
        branchId: me.activeBranchId,
        type: body.type ?? LeaveType.ANNUAL,
        fromDate: body.fromDate,
        toDate: body.toDate,
        days,
        reason: body.reason,
      },
      include: { user: { select: { id: true, name: true } } },
    });

    res.status(201).json(leave);
  })
);

router.post(
  "/leaves/:id/decide",
  requirePermission("shift.approve"),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        status: z.enum([LeaveStatus.APPROVED, LeaveStatus.REJECTED]),
        note: z.string().optional(),
      })
      .parse(req.body);

    const me = currentUser(req);
    const leave = await prisma.leaveRequest.findUnique({
      where: { id: req.params.id },
      include: { user: { select: { name: true } } },
    });
    if (!leave || !me.branchIds.includes(leave.branchId)) throw notFound();
    if (leave.status !== LeaveStatus.PENDING) {
      throw new HttpError(400, "Đơn nghỉ đã được xử lý");
    }

    const updated = await prisma.leaveRequest.update({
      where: { id: leave.id },
      data: {
        status: body.status,
        approverId: me.id,
        decidedAt: new Date(),
        decisionNote: body.note,
      },
    });

    await writeAudit({
      req,
      action: body.status === LeaveStatus.APPROVED ? AuditAction.APPROVE : AuditAction.REJECT,
      entity: "LeaveRequest",
      entityId: leave.id,
      branchId: leave.branchId,
      summary: `${body.status === LeaveStatus.APPROVED ? "Duyệt" : "Từ chối"} đơn nghỉ của ${leave.user.name}`,
    });

    res.json(updated);
  })
);

/* -------------------------------------------------------------- HOA HỒNG */

router.get(
  "/commission-rules",
  requirePermission("hr.read"),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    res.json(
      await prisma.commissionRule.findMany({
        ...pageQuery(req.query, CATALOG_PAGE),
        where: { OR: [{ branchId: null }, { branchId: { in: me.branchIds } }] },
        orderBy: { createdAt: "desc" },
        include: { service: { select: { id: true, name: true } } },
      })
    );
  })
);

router.post(
  "/commission-rules",
  requirePermission("hr.create"),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        name: z.string().min(2),
        roleCode: z.string().min(2),
        basis: z.nativeEnum(CommissionBasis).optional(),
        percent: z.number().int().min(0).max(1000), // ‰
        serviceId: z.string().uuid().optional(),
        minAmount: z.number().int().nonnegative().optional(),
      })
      .parse(req.body);

    const me = currentUser(req);
    const rule = await prisma.commissionRule.create({
      data: { ...body, branchId: me.activeBranchId },
    });
    await writeAudit({
      req,
      action: AuditAction.CREATE,
      entity: "CommissionRule",
      entityId: rule.id,
      summary: `Tạo quy tắc hoa hồng "${rule.name}" — ${rule.percent / 10}% trên ${rule.basis === CommissionBasis.COLLECTED ? "tiền thực thu" : "doanh số ký"}`,
    });
    res.status(201).json(rule);
  })
);

/**
 * POST /api/hr/commissions/calculate
 * Tính lại hoa hồng cho một kỳ. Chạy lại được nhiều lần: xoá các dòng PENDING
 * của kỳ rồi tính mới, KHÔNG đụng vào dòng đã APPROVED/PAID để bảng lương đã
 * chốt không bị đổi số dưới chân.
 */
router.post(
  "/commissions/calculate",
  requirePermission("hr.update"),
  asyncHandler(async (req, res) => {
    const { period } = z.object({ period: z.string().optional() }).parse(req.body);
    const key = period ?? periodKeyOf();
    const range = periodRange(key);
    const me = currentUser(req);
    if (!me.activeBranchId) throw new HttpError(400, "Chưa xác định được cơ sở");

    const rules = await prisma.commissionRule.findMany({
      where: { active: true, OR: [{ branchId: null }, { branchId: me.activeBranchId }] },
    });
    if (!rules.length) throw new HttpError(400, "Chưa có quy tắc hoa hồng nào");

    // Chỉ tính trên TIỀN ĐÃ THU trong kỳ.
    const payments = await prisma.payment.findMany({
      where: { branchId: me.activeBranchId, paidAt: range, method: { not: "VOUCHER" } },
      include: {
        contract: {
          select: { id: true, consultantId: true, items: { select: { serviceId: true } } },
        },
      },
    });

    const users = await prisma.user.findMany({
      where: { branches: { some: { branchId: me.activeBranchId } } },
      select: { id: true, roleLinks: { select: { role: { select: { code: true } } } } },
    });
    const rolesByUser = new Map(users.map((u) => [u.id, u.roleLinks.map((l) => l.role.code)]));

    await prisma.commissionEntry.deleteMany({
      where: { branchId: me.activeBranchId, periodKey: key, status: CommissionStatus.PENDING },
    });

    let created = 0;
    let total = 0;

    for (const p of payments) {
      const consultantId = p.contract?.consultantId;
      if (!consultantId) continue;

      const userRoles = rolesByUser.get(consultantId) ?? [];
      const serviceIds = new Set(p.contract?.items.map((i) => i.serviceId).filter(Boolean));

      for (const rule of rules) {
        if (!userRoles.includes(rule.roleCode)) continue;
        if (rule.serviceId && !serviceIds.has(rule.serviceId)) continue;
        if (p.amount < rule.minAmount) continue;

        const amount = Math.round((p.amount * rule.percent) / 1000);
        if (amount <= 0) continue;

        // Không tạo trùng nếu dòng của phiếu thu này đã được duyệt ở lần trước.
        const already = await prisma.commissionEntry.findFirst({
          where: { paymentId: p.id, ruleId: rule.id, userId: consultantId },
        });
        if (already) continue;

        await prisma.commissionEntry.create({
          data: {
            userId: consultantId,
            branchId: me.activeBranchId,
            ruleId: rule.id,
            paymentId: p.id,
            contractId: p.contractId,
            periodKey: key,
            baseAmount: p.amount,
            percent: rule.percent,
            amount,
          },
        });
        created++;
        total += amount;
      }
    }

    await writeAudit({
      req,
      action: AuditAction.UPDATE,
      entity: "CommissionEntry",
      branchId: me.activeBranchId,
      summary: `Tính hoa hồng kỳ ${key}: ${created} dòng, tổng ${formatVnd(total)}đ`,
    });

    res.json({ period: key, created, total });
  })
);

router.get(
  "/commissions",
  requirePermission("hr.read"),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const scope = scopeOf(req, "hr.read");
    const key = String(req.query.period ?? periodKeyOf());

    const entries = await prisma.commissionEntry.findMany({
      ...pageQuery(req.query, { defaultLimit: 500, maxLimit: 2000 }),
      where: {
        branchId: { in: me.branchIds },
        periodKey: key,
        ...(scope === PermissionScope.OWN ? { userId: me.id } : {}),
      },
      orderBy: { amount: "desc" },
      include: {
        user: { select: { id: true, name: true } },
        rule: { select: { id: true, name: true, basis: true } },
        payment: { select: { id: true, code: true, paidAt: true } },
      },
    });

    // Gộp theo người để bảng lương dùng thẳng.
    const byUser = new Map<string, { userId: string; name: string; count: number; total: number }>();
    for (const e of entries) {
      const row = byUser.get(e.userId) ?? { userId: e.userId, name: e.user.name, count: 0, total: 0 };
      row.count++;
      row.total += e.amount;
      byUser.set(e.userId, row);
    }

    res.json({
      period: key,
      entries,
      summary: [...byUser.values()].sort((a, b) => b.total - a.total),
      total: entries.reduce((s, e) => s + e.amount, 0),
    });
  })
);

/** POST /api/hr/commissions/close — chốt kỳ, khoá số. */
router.post(
  "/commissions/close",
  requirePermission("hr.update"),
  asyncHandler(async (req, res) => {
    const { period } = z.object({ period: z.string() }).parse(req.body);
    const me = currentUser(req);
    if (!me.activeBranchId) throw new HttpError(400, "Chưa xác định được cơ sở");

    const result = await prisma.commissionEntry.updateMany({
      where: { branchId: me.activeBranchId, periodKey: period, status: CommissionStatus.PENDING },
      data: { status: CommissionStatus.APPROVED },
    });

    await writeAudit({
      req,
      action: AuditAction.APPROVE,
      entity: "CommissionEntry",
      branchId: me.activeBranchId,
      summary: `Chốt hoa hồng kỳ ${period}: duyệt ${result.count} dòng`,
    });

    res.json({ ok: true, approved: result.count });
  })
);

/* ------------------------------------------------------------------- KPI */

router.get(
  "/kpi",
  requirePermission("hr.read"),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const key = String(req.query.period ?? periodKeyOf());
    const group = req.query.group ? String(req.query.group) : undefined;

    const definitions = await prisma.kpiDefinition.findMany({
      ...pageQuery(req.query, CATALOG_PAGE),
      where: { active: true, ...(group ? { group } : {}) },
      orderBy: { name: "asc" },
    });

    const [targets, actuals] = await Promise.all([
      prisma.kpiTarget.findMany({
        where: { periodKey: key, definitionId: { in: definitions.map((d) => d.id) } },
        include: { user: { select: { id: true, name: true } } },
      }),
      prisma.kpiActual.findMany({
        where: { periodKey: key, definitionId: { in: definitions.map((d) => d.id) } },
        include: { user: { select: { id: true, name: true } } },
      }),
    ]);

    const rows = targets.map((t) => {
      const actual = actuals.find(
        (a) => a.definitionId === t.definitionId && a.userId === t.userId
      );
      const def = definitions.find((d) => d.id === t.definitionId)!;
      const value = actual?.actualValue ?? 0;
      const pct = t.targetValue > 0 ? Math.round((value / t.targetValue) * 100) : 0;
      return {
        definitionId: t.definitionId,
        code: def.code,
        name: def.name,
        group: def.group,
        unit: def.unit,
        higherIsBetter: def.higherIsBetter,
        userId: t.userId,
        userName: t.user?.name ?? null,
        target: t.targetValue,
        actual: value,
        percent: pct,
        achieved: def.higherIsBetter ? value >= t.targetValue : value <= t.targetValue,
      };
    });

    res.json({ period: key, definitions, rows });
  })
);

router.post(
  "/kpi/definitions",
  requirePermission("nursing_kpi.create"),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        code: z.string().min(2),
        name: z.string().min(2),
        group: z.nativeEnum(KpiGroup).optional(),
        unit: z.string().optional(),
        higherIsBetter: z.boolean().optional(),
        description: z.string().optional(),
      })
      .parse(req.body);
    res.status(201).json(await prisma.kpiDefinition.create({ data: body }));
  })
);

router.put(
  "/kpi/values",
  requirePermission("nursing_kpi.update"),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        definitionId: z.string().uuid(),
        userId: z.string().uuid(),
        periodKey: z.string(),
        target: z.number().int().nonnegative().optional(),
        actual: z.number().int().nonnegative().optional(),
      })
      .parse(req.body);

    const me = currentUser(req);

    if (body.target !== undefined) {
      await prisma.kpiTarget.upsert({
        where: {
          definitionId_userId_periodKey: {
            definitionId: body.definitionId,
            userId: body.userId,
            periodKey: body.periodKey,
          },
        },
        create: {
          definitionId: body.definitionId,
          userId: body.userId,
          periodKey: body.periodKey,
          branchId: me.activeBranchId,
          targetValue: body.target,
        },
        update: { targetValue: body.target },
      });
    }

    if (body.actual !== undefined) {
      await prisma.kpiActual.upsert({
        where: {
          definitionId_userId_periodKey: {
            definitionId: body.definitionId,
            userId: body.userId,
            periodKey: body.periodKey,
          },
        },
        create: {
          definitionId: body.definitionId,
          userId: body.userId,
          periodKey: body.periodKey,
          branchId: me.activeBranchId,
          actualValue: body.actual,
        },
        update: { actualValue: body.actual },
      });
    }

    res.json({ ok: true });
  })
);

export default router;
