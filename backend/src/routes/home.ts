import { Router } from "express";
import { prisma } from "../lib/prisma";
import { startOfVnDay } from "../lib/datetime";
import { asyncHandler } from "../middleware/errorHandler";
import { requireAuth, currentUser } from "../middleware/auth";
import { hasPermission, scopeOf, scopedWhere, maskCustomerPhones } from "../middleware/rbac";
import { AppointmentStatus, DepositStatus, InvoiceStatus, PermissionScope, ProcedureStatus, ReferralRewardStatus, TaskKind, TaskStatus, VisitStatus } from "../types/enums";
import { RoleCode } from "../lib/rbac-catalog";
import { REAL_MONEY } from "../lib/report-scope";
import { settingList, vnPeriodKey } from "../lib/metrics";
import { leaderboard } from "../lib/growth";
import { endOfDay, forecast, weeklyMetrics } from "../lib/analytics";
import { ALL_SCOPE } from "../lib/briefing";
import { vnDayKey } from "../lib/datetime";

// TRANG CHỦ THEO VAI (B15, bản tối thiểu).
//
// Vai không có finance.read (bác sĩ, điều dưỡng, lễ tân, marketing, telesale)
// trước đây mở app là gặp màn trống. Endpoint này trả các "khối việc hôm nay"
// mà vai đó được phép xem, mỗi khối gắn với đúng một quyền:
//
//   appointments  appointment.read        lịch hẹn hôm nay
//   queue         visit.read              khách đang chờ tại quầy
//   procedures    surgery_schedule.read   ca thủ thuật hôm nay
//   leads         lead.read               lead mới hôm nay
//   conversations inbox.read              hội thoại tôi phụ trách
//
// F29 (trang chủ đầy đủ từng vai) thêm các khối theo vai, cùng khuôn kiểm quyền:
//   myTasks       mọi người            việc quá hạn, việc hôm nay của tôi
//   teamTarget    sale, quản lý        thanh tiến độ mục tiêu khách đến tháng + hạng của tôi
//   myDay         sale                 số của tôi hôm nay (như màn họp cuối ngày)
//   medicalFlags  bác sĩ               hội thoại có từ khoá y khoa chờ bác sĩ
//   aftercare     điều dưỡng, bác sĩ   việc chăm sóc sau điều trị đến hạn hôm nay
//   deposits      lễ tân               lịch hôm nay còn chờ cọc
//   marketing     marketing            chi phí, SĐT, chi phí/SĐT tuần này
//   accounting    kế toán              thu hôm nay, hoá đơn quá hạn, thưởng giới thiệu chờ chi
//   director      giám đốc, quản lý    dự báo cuối tháng so chỉ tiêu
//   briefing      giám đốc, quản lý    AI6 bản tin sáng (số liệu tổng, không thông tin khách)
//   reengage      sale, quản lý        AI5 số nháp tin chăm lại chờ duyệt
// `financeView` = có quyền xem Dashboard tài chính (giao diện mở thành tab thứ hai,
// không còn đẩy lễ tân vào màn tài chính ngay khi đăng nhập).

const router = Router();
router.use(requireAuth);

const DAY_MS = 86_400_000;
const LIST_LIMIT = 12;

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const start = startOfVnDay();
    const today = { gte: start, lt: new Date(start.getTime() + DAY_MS) };
    const branchId = me.activeBranchId && me.branchIds.includes(me.activeBranchId) ? me.activeBranchId : null;
    const branchClause = branchId ? { branchId } : {};
    const sections: Record<string, unknown> = {};

    if (hasPermission(req, "appointment.read")) {
      const { where } = scopedWhere(req, "appointment.read", {
        ownerFields: ["createdById", "doctorId"],
        branchField: "branchId",
      });
      const base = { ...where, ...branchClause, startAt: today };
      const [items, byStatus] = await Promise.all([
        prisma.appointment.findMany({
          where: { ...base, status: { notIn: [AppointmentStatus.CANCELLED] } },
          orderBy: { startAt: "asc" },
          take: LIST_LIMIT,
          select: {
            id: true,
            startAt: true,
            title: true,
            status: true,
            customer: { select: { id: true, name: true, code: true, phone: true } },
            doctor: { select: { id: true, name: true } },
          },
        }),
        prisma.appointment.groupBy({ by: ["status"], _count: true, where: base }),
      ]);
      const count = (s: string) => byStatus.find((b) => b.status === s)?._count ?? 0;
      sections.appointments = {
        total: byStatus.reduce((s, b) => s + (b.status === AppointmentStatus.CANCELLED ? 0 : b._count), 0),
        arrived: count(AppointmentStatus.ARRIVED) + count(AppointmentStatus.DONE),
        pending: count(AppointmentStatus.PENDING) + count(AppointmentStatus.CONFIRMED),
        items,
      };
    }

    if (hasPermission(req, "visit.read")) {
      const { where } = scopedWhere(req, "visit.read", { ownerFields: ["consultantId"], branchField: "branchId" });
      const items = await prisma.visit.findMany({
        where: {
          ...where,
          ...branchClause,
          checkedInAt: today,
          status: { notIn: [VisitStatus.DONE, VisitStatus.LEFT] },
        },
        orderBy: { queueNumber: "asc" },
        take: LIST_LIMIT,
        select: {
          id: true,
          queueNumber: true,
          status: true,
          checkedInAt: true,
          customer: { select: { id: true, name: true, code: true, phone: true } },
        },
      });
      sections.queue = {
        waiting: items.filter((v) => v.status === VisitStatus.WAITING).length,
        inProgress: items.filter((v) => v.status !== VisitStatus.WAITING).length,
        items,
      };
    }

    if (hasPermission(req, "surgery_schedule.read")) {
      const items = await prisma.procedureRecord.findMany({
        where: {
          branchId: branchId ?? { in: me.branchIds },
          scheduledAt: today,
          status: { notIn: [ProcedureStatus.CANCELLED, ProcedureStatus.POSTPONED] },
        },
        orderBy: { scheduledAt: "asc" },
        take: LIST_LIMIT,
        select: {
          id: true,
          code: true,
          title: true,
          status: true,
          scheduledAt: true,
          surgeon: { select: { id: true, name: true } },
          customer: { select: { id: true, name: true, code: true, phone: true } },
        },
      });
      sections.procedures = { total: items.length, mine: items.filter((p) => p.surgeon?.id === me.id).length, items };
    }

    if (hasPermission(req, "lead.read")) {
      const { where } = scopedWhere(req, "lead.read", { ownerFields: ["assignedToId"], branchField: "branchId" });
      const base = { ...where, createdAt: today };
      const [byChannel, total, unassigned] = await Promise.all([
        prisma.lead.groupBy({ by: ["channelId"], _count: true, where: base }),
        prisma.lead.count({ where: base }),
        prisma.lead.count({ where: { ...base, assignedToId: null } }),
      ]);
      const channels = await prisma.channel.findMany({
        where: { id: { in: byChannel.map((b) => b.channelId).filter(Boolean) as string[] } },
        select: { id: true, name: true },
      });
      const nameOf = new Map(channels.map((c) => [c.id, c.name]));
      sections.leads = {
        total,
        unassigned,
        byChannel: byChannel
          .map((b) => ({ channel: b.channelId ? (nameOf.get(b.channelId) ?? "Không rõ") : "Không rõ nguồn", count: b._count }))
          .sort((a, b) => b.count - a.count),
      };
    }

    if (hasPermission(req, "inbox.read")) {
      const mine = { assignedToId: me.id, branchId: { in: me.branchIds } };
      const [items, unread] = await Promise.all([
        prisma.conversation.findMany({
          where: mine,
          orderBy: [{ lastMessageAt: "desc" }],
          take: LIST_LIMIT,
          select: {
            id: true,
            title: true,
            channel: true,
            unreadCount: true,
            lastMessageAt: true,
            lastMessagePreview: true,
          },
        }),
        prisma.conversation.count({ where: { ...mine, unreadCount: { gt: 0 } } }),
      ]);
      sections.conversations = { unread, items };
    }

    // ------------------------------------------------------------ F29 THEO VAI
    const roles = me.roles;
    const branchIds = branchId ? [branchId] : me.branchIds;
    const salesRoles = await settingList("payroll.salesRoles");
    const isSales = roles.some((r) => salesRoles.includes(r));
    const isManager = roles.some((r) => r === RoleCode.GIAM_DOC || r === RoleCode.QUAN_LY_CO_SO || r === RoleCode.QUAN_LY_HE_THONG);
    const now = new Date();

    {
      const mineOpen = { assigneeId: me.id, status: { in: [TaskStatus.OPEN, TaskStatus.IN_PROGRESS] } };
      const [overdue, dueToday] = await Promise.all([
        prisma.task.count({ where: { ...mineOpen, dueAt: { lt: now } } }),
        prisma.task.count({ where: { ...mineOpen, dueAt: { gte: now, lt: today.lt } } }),
      ]);
      sections.myTasks = { overdue, dueToday };
    }

    if (isSales || isManager) {
      const board = await leaderboard(vnPeriodKey(now), branchIds);
      const mine = board.rows.find((r) => r.userId === me.id);
      sections.teamTarget = {
        target: board.target,
        actual: board.actual,
        percent: board.percent,
        myShowups: mine?.showups ?? null,
        myRank: mine?.rank ?? null,
        myDisqualified: mine?.disqualified ?? false,
        top: board.rows.filter((r) => !r.disqualified).slice(0, 5).map((r) => ({ name: r.name, showups: r.showups, rank: r.rank })),
      };
    }

    if (isSales) {
      const [row] = await endOfDay({ date: now, branchIds, now, onlyUserId: me.id });
      if (row) sections.myDay = row;
    }

    if (roles.includes(RoleCode.BAC_SI)) {
      const items = await prisma.conversation.findMany({
        where: { branchId: { in: branchIds }, medicalFlag: true, medicalFlagAt: { gte: new Date(start.getTime() - 3 * DAY_MS) } },
        orderBy: { medicalFlagAt: "desc" },
        take: LIST_LIMIT,
        select: { id: true, title: true, medicalFlagAt: true, lastMessagePreview: true },
      });
      sections.medicalFlags = { total: items.length, items };
    }

    if (roles.includes(RoleCode.DIEU_DUONG) || roles.includes(RoleCode.BAC_SI)) {
      const where = {
        branchId: { in: branchIds },
        kind: TaskKind.AFTERCARE,
        status: { in: [TaskStatus.OPEN, TaskStatus.IN_PROGRESS] },
        dueAt: { lt: today.lt },
      };
      const [total, items] = await Promise.all([
        prisma.task.count({ where }),
        prisma.task.findMany({
          where,
          orderBy: { dueAt: "asc" },
          take: LIST_LIMIT,
          select: { id: true, title: true, dueAt: true, milestone: true, customer: { select: { id: true, name: true, code: true } } },
        }),
      ]);
      sections.aftercare = { total, items };
    }

    if (roles.includes(RoleCode.LE_TAN) && hasPermission(req, "appointment.read")) {
      const items = await prisma.appointment.findMany({
        where: { branchId: { in: branchIds }, startAt: today, depositStatus: DepositStatus.CHO_COC, status: { notIn: [AppointmentStatus.CANCELLED] } },
        orderBy: { startAt: "asc" },
        take: LIST_LIMIT,
        select: { id: true, startAt: true, title: true, depositAmount: true, customer: { select: { id: true, name: true, code: true, phone: true } } },
      });
      sections.deposits = { waiting: items.length, items };
    }

    const leadScope = scopeOf(req, "lead.read");
    if (roles.includes(RoleCode.MARKETING) && leadScope && leadScope !== PermissionScope.OWN) {
      const [week] = await weeklyMetrics({ weeks: 1, to: now, scope: { ids: branchIds, specific: Boolean(branchId) } });
      sections.marketing = { weekKey: week.weekKey, ...week.total, adsCost: week.ads.cost, organicMessages: week.organic.newMessages };
    }

    if (roles.includes(RoleCode.KE_TOAN) && hasPermission(req, "accounting.read")) {
      const [collected, overdueInvoices, pendingRewards] = await Promise.all([
        prisma.payment.aggregate({ where: { branchId: { in: branchIds }, paidAt: today, ...REAL_MONEY }, _sum: { amount: true }, _count: true }),
        prisma.invoice.count({
          where: { branchId: { in: branchIds }, status: { in: [InvoiceStatus.ISSUED, InvoiceStatus.PARTIAL] }, dueDate: { lt: start } },
        }),
        prisma.referralReward.count({ where: { status: ReferralRewardStatus.PENDING_PAYOUT } }),
      ]);
      sections.accounting = {
        collectedToday: collected._sum.amount ?? 0,
        paymentsToday: collected._count,
        overdueInvoices,
        pendingReferralPayouts: pendingRewards,
      };
    }

    const accScope = scopeOf(req, "accounting.read");
    if ((roles.includes(RoleCode.GIAM_DOC) || roles.includes(RoleCode.QUAN_LY_CO_SO)) && accScope && accScope !== PermissionScope.OWN) {
      const f = await forecast({ periodKey: vnPeriodKey(now), branchIds, now });
      sections.director = {
        periodKey: f.periodKey,
        actual: f.actual,
        forecast: f.forecast,
        target: f.target,
        progressPercent: f.progressPercent,
        forecastVsTargetPercent: f.forecastVsTargetPercent,
        vsPrevPercent: f.vsPrevPercent,
      };
    }

    // AI6: bản tin sáng. Quản lý cơ sở đọc bản của cơ sở; giám đốc đọc bản toàn hệ thống.
    if (isManager) {
      const isDirector = roles.includes(RoleCode.GIAM_DOC) || roles.includes(RoleCode.QUAN_LY_HE_THONG);
      const ownBranch = branchId ?? me.branchIds[0] ?? null;
      // Hệ thống một cơ sở chỉ có bản "ALL" (chính là cơ sở đó) nên quản lý cơ sở được đọc.
      const singleBranch = (await prisma.branch.count({ where: { active: true } })) <= 1;
      const scopeKeys = isDirector ? [ALL_SCOPE] : [ownBranch, ...(singleBranch ? [ALL_SCOPE] : [])].filter((x): x is string => Boolean(x));
      let briefing = null;
      for (const scopeKey of scopeKeys) {
        briefing = await prisma.managerBriefing.findFirst({
          where: { scopeKey },
          orderBy: { dayKey: "desc" },
          select: { id: true, dayKey: true, scopeKey: true, source: true, content: true, createdAt: true },
        });
        if (briefing) break;
      }
      sections.briefing = briefing ? { ...briefing, isToday: briefing.dayKey === vnDayKey(now) } : null;
    }

    // AI5: nháp tin chăm lại chờ duyệt.
    const reengageScope = scopeOf(req, "inbox.reengage");
    if (reengageScope) {
      const where =
        reengageScope === PermissionScope.ALL
          ? {}
          : reengageScope === PermissionScope.BRANCH
            ? { OR: [{ branchId: { in: me.branchIds } }, { ownerId: me.id }] }
            : { ownerId: me.id };
      sections.reengage = { pending: await prisma.reengageDraft.count({ where: { ...where, status: "PENDING" } }) };
    }

    res.json(
      maskCustomerPhones(req, {
        date: start,
        roles,
        financeView: hasPermission(req, "accounting.read") || hasPermission(req, "finance.read"),
        sections,
      })
    );
  })
);

export default router;
