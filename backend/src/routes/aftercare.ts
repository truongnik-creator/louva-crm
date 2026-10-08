import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { parsePagination } from "../lib/pagination";
import { asyncHandler, HttpError } from "../middleware/errorHandler";
import { requireAuth, currentUser } from "../middleware/auth";
import { hasPermission, notFound, phoneFor, requirePermission, scopeOf } from "../middleware/rbac";
import { writeAudit } from "../lib/audit";
import { getSettingNumber } from "../lib/settings-catalog";
import { startOfVnDay, formatDateVN } from "../lib/datetime";
import { setProcedureRetreatDays } from "../lib/aftercare";
import { notifyUsers, usersWithRoles } from "../lib/notify";
import { RoleCode } from "../lib/rbac-catalog";
import {
  ActivityType,
  AftercareResult,
  AuditAction,
  PermissionScope,
  TaskKind,
  TaskStatus,
} from "../types/enums";

// F10: MÀN CHĂM SÓC SAU ĐIỀU TRỊ, lọc PHÍA MÁY CHỦ (thay FollowUp.tsx tự lọc
// 300 khách ở trình duyệt). Việc chăm sóc là Task loại AFTERCARE (mốc D0...D30)
// và RETREAT (mốc tái tiêm). Quá hạn = quá hạn gọi hơn followup.overdueDays ngày.

const router = Router();
router.use(requireAuth);

const DAY_MS = 86_400_000;
const OPEN = [TaskStatus.OPEN, TaskStatus.IN_PROGRESS];
const CARE_KINDS = [TaskKind.AFTERCARE, TaskKind.RETREAT];

function scopeWhere(req: Parameters<typeof requireAuth>[0]): Record<string, unknown> {
  const me = currentUser(req);
  const scope = scopeOf(req, "followup.read");
  if (scope === PermissionScope.ALL) return {};
  if (scope === PermissionScope.BRANCH) return { OR: [{ branchId: { in: me.branchIds } }, { assigneeId: me.id }] };
  return { assigneeId: me.id };
}

/**
 * GET /api/aftercare?view=due|overdue|upcoming|done|all&kind=AFTERCARE|RETREAT&milestone=D1&mine=1
 * due = hạn tới hết hôm nay (kể cả quá hạn), upcoming = từ mai, done = đã liên hệ.
 */
router.get(
  "/",
  requirePermission("followup.read"),
  asyncHandler(async (req, res) => {
    const q = z
      .object({
        view: z.enum(["due", "overdue", "upcoming", "done", "all"]).default("due"),
        kind: z.enum([TaskKind.AFTERCARE, TaskKind.RETREAT]).optional(),
        milestone: z.string().max(10).optional(),
        mine: z.enum(["1", "0"]).optional(),
        branchId: z.string().uuid().optional(),
        /** Lô 7 · C2: tab chăm sóc sau tiêm trong hồ sơ một khách. */
        customerId: z.string().uuid().optional(),
      })
      .parse({ ...req.query, kind: req.query.kind || undefined, milestone: req.query.milestone || undefined });
    const me = currentUser(req);
    const now = new Date();
    const overdueDays = await getSettingNumber("followup.overdueDays");
    const endOfToday = new Date(startOfVnDay(now).getTime() + DAY_MS);
    const overdueCutoff = new Date(now.getTime() - overdueDays * DAY_MS);

    const base: Record<string, unknown> = {
      AND: [
        scopeWhere(req),
        { kind: q.kind ? q.kind : { in: CARE_KINDS } },
        ...(q.milestone ? [{ milestone: q.milestone }] : []),
        ...(q.mine === "1" ? [{ assigneeId: me.id }] : []),
        ...(q.branchId ? [{ branchId: q.branchId }] : []),
        ...(q.customerId ? [{ customerId: q.customerId }] : []),
      ],
    };
    const byView: Record<string, Record<string, unknown>> = {
      due: { status: { in: OPEN }, dueAt: { lt: endOfToday } },
      overdue: { status: { in: OPEN }, dueAt: { lt: overdueCutoff } },
      upcoming: { status: { in: OPEN }, dueAt: { gte: endOfToday } },
      done: { status: TaskStatus.DONE },
      all: {},
    };
    const where = { ...base, ...byView[q.view] };
    const page = parsePagination(req.query, { defaultLimit: 100, maxLimit: 300 });
    const [rows, total, counts] = await Promise.all([
      prisma.task.findMany({
        where,
        orderBy: q.view === "done" ? [{ contactedAt: "desc" }, { completedAt: "desc" }] : [{ dueAt: "asc" }, { id: "asc" }],
        take: page.take,
        skip: page.skip,
        include: {
          customer: { select: { id: true, code: true, name: true, phone: true, stage: true } },
          assignee: { select: { id: true, name: true } },
        },
      }),
      prisma.task.count({ where }),
      Promise.all(
        (["due", "overdue", "upcoming"] as const).map((v) => prisma.task.count({ where: { ...base, ...byView[v] } }))
      ),
    ]);
    const procIds = [...new Set(rows.map((r) => r.procedureId).filter((x): x is string => Boolean(x)))];
    const procs = procIds.length
      ? await prisma.procedureRecord.findMany({
          where: { id: { in: procIds } },
          select: {
            id: true, code: true, title: true, finishedAt: true, retreatDays: true, retreatDueAt: true,
            injectionArea: true, volumeTenthCc: true, service: { select: { name: true, retreatDays: true } },
          },
        })
      : [];
    const procOf = new Map(procs.map((p) => [p.id, p]));
    res.json({
      total,
      overdueDays,
      counts: { due: counts[0], overdue: counts[1], upcoming: counts[2] },
      items: rows.map((t) => ({
        ...t,
        customer: t.customer ? { ...t.customer, phone: phoneFor(req, t.customer.phone) } : null,
        procedure: t.procedureId ? (procOf.get(t.procedureId) ?? null) : null,
        overdue: Boolean(OPEN.includes(t.status as TaskStatus) && t.dueAt && t.dueAt < overdueCutoff),
        dueToday: Boolean(OPEN.includes(t.status as TaskStatus) && t.dueAt && t.dueAt < endOfToday),
      })),
    });
  })
);

/**
 * POST /api/aftercare/:taskId/contact { result, note, nextDueAt }
 * Nút "Đã liên hệ". Liên hệ được thì đóng việc; không nghe máy, hẹn gọi lại thì
 * giữ việc và dời hạn; khách có vấn đề thì báo bác sĩ cơ sở.
 */
router.post(
  "/:taskId/contact",
  requirePermission("followup.read"),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        result: z.nativeEnum(AftercareResult),
        note: z.string().trim().max(1000).optional(),
        nextDueAt: z.coerce.date().optional(),
      })
      .parse(req.body);
    const me = currentUser(req);
    const task = await prisma.task.findUnique({ where: { id: req.params.taskId }, include: { customer: { select: { id: true, name: true, code: true } } } });
    if (!task || !CARE_KINDS.includes(task.kind as TaskKind)) throw notFound("Không tìm thấy việc chăm sóc");
    const canAll = hasPermission(req, "followup.update") && scopeOf(req, "followup.update") !== PermissionScope.OWN;
    const inBranch = !task.branchId || me.branchIds.includes(task.branchId);
    if (task.assigneeId !== me.id && !(canAll && inBranch)) throw notFound("Không tìm thấy việc chăm sóc");
    if (!OPEN.includes(task.status as TaskStatus)) throw new HttpError(409, "Việc này đã ghi nhận liên hệ");

    const keepOpen = body.result === AftercareResult.NO_ANSWER || body.result === AftercareResult.CALL_BACK_LATER;
    if (body.result === AftercareResult.CALL_BACK_LATER && !body.nextDueAt) {
      throw new HttpError(400, "Khách hẹn gọi lại: chọn ngày giờ gọi lại");
    }
    const now = new Date();
    const label: Record<string, string> = {
      REACHED_OK: "liên hệ được, khách ổn",
      REACHED_ISSUE: "liên hệ được, khách CÓ VẤN ĐỀ",
      NO_ANSWER: "không liên hệ được",
      CALL_BACK_LATER: "khách hẹn gọi lại",
    };
    const noteLine = `${formatDateVN(now)} ${me.name}: ${label[body.result]}${body.note ? `. ${body.note}` : ""}`;
    const updated = await prisma.task.update({
      where: { id: task.id },
      data: {
        result: body.result,
        resultNote: [task.resultNote, noteLine].filter(Boolean).join("\n").slice(-2000),
        contactedAt: now,
        contactedById: me.id,
        ...(keepOpen
          ? { dueAt: body.nextDueAt ?? new Date(now.getTime() + DAY_MS) }
          : { status: TaskStatus.DONE, completedAt: now }),
      },
    });
    if (task.customerId) {
      await prisma.customer.update({
        where: { id: task.customerId },
        data: {
          lastContactAt: now,
          activities: {
            create: {
              type: ActivityType.AFTERCARE,
              content: `Chăm sóc ${task.milestone ?? (task.kind === TaskKind.RETREAT ? "tái tiêm" : "")}: ${label[body.result]}${body.note ? `. ${body.note}` : ""}`,
              userId: me.id,
              userName: me.name,
            },
          },
        },
      });
    }
    if (body.result === AftercareResult.REACHED_ISSUE) {
      const doctors = await usersWithRoles([RoleCode.BAC_SI], task.branchId);
      await notifyUsers(
        doctors.map((d) => d.id),
        {
          title: `Khách ${task.customer?.name ?? ""} có vấn đề sau điều trị (${task.milestone ?? ""})`,
          body: body.note ?? "Nhân viên chăm sóc báo khách có vấn đề, bác sĩ vui lòng liên hệ.",
          level: "DANGER",
          link: task.customerId ? `/khach-hang/${task.customerId}` : null,
        }
      );
    }
    await writeAudit({
      req,
      action: AuditAction.UPDATE,
      entity: "Task",
      entityId: task.id,
      branchId: task.branchId,
      summary: `Chăm sóc ${task.milestone ?? task.kind} khách ${task.customer?.code ?? ""}: ${label[body.result]}`,
    });
    res.json(updated);
  })
);

/** PATCH /api/aftercare/procedures/:id/retreat { retreatDays } — bác sĩ chỉnh số ngày tái tiêm của lần làm. */
router.patch(
  "/procedures/:id/retreat",
  requirePermission("followup.update"),
  asyncHandler(async (req, res) => {
    const { retreatDays } = z.object({ retreatDays: z.number().int().min(1).max(1095).nullable() }).parse(req.body);
    const me = currentUser(req);
    const proc = await prisma.procedureRecord.findUnique({ where: { id: req.params.id } });
    if (!proc || !me.branchIds.includes(proc.branchId)) throw notFound();
    const retreatDueAt = await setProcedureRetreatDays(proc.id, retreatDays);
    await writeAudit({
      req,
      action: AuditAction.UPDATE,
      entity: "ProcedureRecord",
      entityId: proc.id,
      branchId: proc.branchId,
      summary: `Đổi số ngày tái tiêm ${proc.code}: ${proc.retreatDays ?? "theo dịch vụ"} → ${retreatDays ?? "theo dịch vụ"}`,
    });
    res.json({ id: proc.id, retreatDays, retreatDueAt });
  })
);

export default router;
