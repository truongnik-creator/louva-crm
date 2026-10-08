import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { asyncHandler, HttpError } from "../middleware/errorHandler";
import { requireAuth, currentUser } from "../middleware/auth";
import { requirePermission, scopeOf, notFound } from "../middleware/rbac";
import { writeAudit, writeAccessLog } from "../lib/audit";
import { formatVnd } from "../lib/datetime";
import { isPeriodKey, vnPeriodKey } from "../lib/metrics";
import { computePayrollPeriod, getOrCreatePeriod, payrollWorkbook, updatePayrollLine } from "../lib/payroll";
import { AccessResourceType, AccessSeverity, AuditAction, PayrollStatus, PermissionScope } from "../types/enums";

// F17: KỲ LƯƠNG (tính, xem chi tiết, sửa phụ cấp và khấu trừ, khoá kỳ, xuất Excel).
// Mọi tham số lương thưởng nằm trong Cài đặt nhóm "Lương thưởng".

const router = Router();
router.use(requireAuth);

function branchOf(req: Parameters<typeof currentUser>[0], raw: unknown): string {
  const me = currentUser(req);
  const branchId = typeof raw === "string" && raw ? raw : me.activeBranchId;
  if (!branchId || !me.branchIds.includes(branchId)) throw notFound("Không tìm thấy cơ sở");
  return branchId;
}

function periodParam(v: unknown): string {
  const s = typeof v === "string" && v ? v : vnPeriodKey();
  if (!isPeriodKey(s)) throw new HttpError(400, "Kỳ lương phải có dạng YYYY-MM");
  return s;
}

router.get(
  "/periods",
  requirePermission("hr.read"),
  asyncHandler(async (req, res) => {
    const branchId = branchOf(req, req.query.branchId);
    res.json(
      await prisma.payrollPeriod.findMany({
        where: { branchId },
        orderBy: { periodKey: "desc" },
        take: 36,
        select: { id: true, periodKey: true, status: true, computedAt: true, closedAt: true, closedBy: { select: { name: true } } },
      })
    );
  })
);

/** GET /api/payroll/:period?branchId=: kỳ lương và các dòng. Người phạm vi "của tôi" chỉ thấy dòng mình. */
router.get(
  "/:period",
  requirePermission("hr.read"),
  asyncHandler(async (req, res) => {
    const periodKey = periodParam(req.params.period);
    const branchId = branchOf(req, req.query.branchId);
    const me = currentUser(req);
    const own = scopeOf(req, "hr.read") === PermissionScope.OWN;
    const period = await prisma.payrollPeriod.findUnique({
      where: { branchId_periodKey: { branchId, periodKey } },
      include: {
        closedBy: { select: { name: true } },
        lines: {
          where: own ? { userId: me.id } : {},
          include: { user: { select: { id: true, name: true } } },
          orderBy: { total: "desc" },
        },
      },
    });
    if (!period) return res.json({ periodKey, branchId, status: PayrollStatus.OPEN, computedAt: null, lines: [], params: null });
    res.json({
      ...period,
      params: period.paramsJson ? JSON.parse(period.paramsJson) : null,
      paramsJson: undefined,
      lines: period.lines.map((l) => ({ ...l, detail: l.detailJson ? JSON.parse(l.detailJson) : null, detailJson: undefined })),
    });
  })
);

router.post(
  "/:period/compute",
  requirePermission("hr.update"),
  asyncHandler(async (req, res) => {
    const periodKey = periodParam(req.params.period);
    const branchId = branchOf(req, req.body?.branchId);
    const result = await computePayrollPeriod(branchId, periodKey);
    await writeAudit({
      req,
      action: AuditAction.UPDATE,
      entity: "PayrollPeriod",
      entityId: result.periodId,
      branchId,
      summary: `Tính kỳ lương ${periodKey}: ${result.lines} dòng`,
    });
    res.json(result);
  })
);

router.post(
  "/:period/lock",
  requirePermission("hr.update"),
  asyncHandler(async (req, res) => {
    const periodKey = periodParam(req.params.period);
    const branchId = branchOf(req, req.body?.branchId);
    const me = currentUser(req);
    const period = await getOrCreatePeriod(branchId, periodKey);
    if (period.status === PayrollStatus.CLOSED) throw new HttpError(409, "Kỳ lương đã khoá");
    if (!period.computedAt) throw new HttpError(400, "Chưa tính kỳ lương, bấm Tính trước khi khoá");
    const updated = await prisma.payrollPeriod.update({
      where: { id: period.id },
      data: { status: PayrollStatus.CLOSED, closedAt: new Date(), closedById: me.id },
    });
    const total = await prisma.payrollLine.aggregate({ where: { periodId: period.id }, _sum: { total: true } });
    await writeAudit({
      req,
      action: AuditAction.APPROVE,
      entity: "PayrollPeriod",
      entityId: period.id,
      branchId,
      summary: `Khoá kỳ lương ${periodKey}, tổng ${formatVnd(total._sum.total ?? 0)}đ`,
    });
    res.json(updated);
  })
);

router.patch(
  "/lines/:id",
  requirePermission("hr.update"),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        allowance: z.number().int().min(0).max(1_000_000_000).optional(),
        deduction: z.number().int().min(0).max(1_000_000_000).optional(),
        baseSalary: z.number().int().min(0).max(1_000_000_000).optional(),
        note: z.string().trim().max(300).nullable().optional(),
      })
      .parse(req.body);
    const me = currentUser(req);
    const before = await prisma.payrollLine.findUnique({ where: { id: req.params.id }, include: { period: true, user: { select: { name: true } } } });
    if (!before || !me.branchIds.includes(before.period.branchId)) throw notFound("Không tìm thấy dòng lương");
    const line = await updatePayrollLine(before.id, body);
    await writeAudit({
      req,
      action: AuditAction.UPDATE,
      entity: "PayrollLine",
      entityId: line.id,
      branchId: before.period.branchId,
      summary: `Sửa dòng lương ${before.user.name} kỳ ${before.period.periodKey}`,
      changes: {
        allowance: [before.allowance, line.allowance],
        deduction: [before.deduction, line.deduction],
        baseSalary: [before.baseSalary, line.baseSalary],
        total: [before.total, line.total],
      },
    });
    res.json(line);
  })
);

router.get(
  "/:period/export",
  requirePermission("hr.update"),
  asyncHandler(async (req, res) => {
    const periodKey = periodParam(req.params.period);
    const branchId = branchOf(req, req.query.branchId);
    const period = await prisma.payrollPeriod.findUnique({ where: { branchId_periodKey: { branchId, periodKey } } });
    if (!period) throw notFound("Kỳ lương chưa được tính");
    const wb = await payrollWorkbook(period.id);
    const lines = await prisma.payrollLine.count({ where: { periodId: period.id } });
    await writeAccessLog({
      req,
      resourceType: AccessResourceType.REPORT_EXPORT,
      severity: AccessSeverity.ELEVATED,
      reason: `Xuất Excel kỳ lương ${periodKey}`,
      rowCount: lines,
      branchId,
    });
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="ky-luong_${periodKey}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  })
);

export default router;
