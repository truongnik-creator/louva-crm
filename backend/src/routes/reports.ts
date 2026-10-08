import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { formatVnd, vnDayKey } from "../lib/datetime";
import { env } from "../lib/env";
import { asyncHandler, HttpError } from "../middleware/errorHandler";
import { requireAuth, currentUser } from "../middleware/auth";
import {
  requirePermission,
  requireAnyPermission,
  requireCrossPersonPermission,
  scopedWhere,
  phoneFor,
} from "../middleware/rbac";
import { writeAccessLog } from "../lib/audit";
import { getSettingNumber } from "../lib/settings-catalog";
import { buildDepartments } from "../lib/department-scorecard";
import { getClinicMode, stagesFor } from "../lib/stages";
import {
  resolvePeriod,
  reportBranchScope,
  nullableBranchWhere,
  customerBranchWhere,
  countedContractWhere,
  collectedByConsultant,
  collectedByChannel,
  signedByChannel,
  topServices,
  debtBalanceAt,
  REAL_MONEY,
  procedureMinutes,
  occupiesRoom,
  daysInPeriod,
} from "../lib/report-scope";
import {
  AccessResourceType,
  AccessSeverity,
  AppointmentStatus,
  DepositStatus,
  InvoiceStatus,
  ProcedureStatus,
  RoomType,
  VisitStatus,
} from "../types/enums";

// Báo cáo doanh thu, phễu lead, hiệu suất telesale + Dashboard chủ đầu tư.
//
// Tất cả đều gộp bằng truy vấn tổng hợp (groupBy/aggregate) chứ không nạp bản
// ghi về rồi cộng trong JS — bản cũ làm thế và sẽ sập khi dữ liệu lớn dần.

const router = Router();
router.use(requireAuth);

function delta(current: number, previous: number): { value: number; pct: number | null; up: boolean } {
  const diff = current - previous;
  return {
    value: diff,
    pct: previous === 0 ? null : Math.round((diff / previous) * 1000) / 10,
    up: diff >= 0,
  };
}

/**
 * GET /api/reports/dashboard — số liệu cho màn "Dashboard chủ đầu tư".
 * Trả đúng những khối prototype cần: 6 KPI, phễu, doanh thu theo ngày, top
 * dịch vụ, top tư vấn viên, cảnh báo.
 */
router.get(
  "/dashboard",
  requireAnyPermission("accounting.read", "finance.read"),
  asyncHandler(async (req, res) => {
    const period = resolvePeriod(req.query as Record<string, unknown>);
    const scope = reportBranchScope(req);
    const branch = { in: scope.ids };
    const now = new Date();
    const cur = { gte: period.from, lt: period.to };
    const prev = { gte: period.prevFrom, lt: period.prevTo };

    const [
      signedNow,
      signedPrev,
      collectedNow,
      collectedPrev,
      newCustomersNow,
      newCustomersPrev,
      surgeriesNow,
      surgeriesPrev,
      debt,
      debtPrev,
    ] = await Promise.all([
      prisma.contract.aggregate({ where: countedContractWhere(cur, scope.ids), _sum: { total: true }, _count: true }),
      prisma.contract.aggregate({ where: countedContractWhere(prev, scope.ids), _sum: { total: true }, _count: true }),
      prisma.payment.aggregate({ where: { branchId: branch, paidAt: cur, ...REAL_MONEY }, _sum: { amount: true } }),
      prisma.payment.aggregate({ where: { branchId: branch, paidAt: prev, ...REAL_MONEY }, _sum: { amount: true } }),
      // B5: khách mới của CƠ SỞ đang xem, qua liên kết khách và cơ sở.
      prisma.customer.count({ where: { createdAt: cur, mergedIntoId: null, ...customerBranchWhere(scope) } }),
      prisma.customer.count({ where: { createdAt: prev, mergedIntoId: null, ...customerBranchWhere(scope) } }),
      prisma.procedureRecord.count({
        where: { branchId: branch, status: ProcedureStatus.COMPLETED, finishedAt: cur },
      }),
      prisma.procedureRecord.count({
        where: { branchId: branch, status: ProcedureStatus.COMPLETED, finishedAt: prev },
      }),
      // B7: công nợ cuối kỳ (hoặc hiện tại nếu kỳ chưa hết) so với số dư ĐẦU KỲ.
      debtBalanceAt(period.to < now ? period.to : now, scope.ids),
      debtBalanceAt(period.from, scope.ids),
    ]);

    const signed = signedNow._sum.total ?? 0;
    const collected = collectedNow._sum.amount ?? 0;
    const avgOrder = signedNow._count > 0 ? Math.round(signed / signedNow._count) : 0;
    const avgOrderPrev = signedPrev._count > 0 ? Math.round((signedPrev._sum.total ?? 0) / signedPrev._count) : 0;

    // Phễu: đếm khách theo giai đoạn đang ở, cộng dồn ngược để ra hình phễu.
    const stageCounts = await prisma.customer.groupBy({
      by: ["stage"],
      _count: true,
      where: { createdAt: cur, hidden: false, mergedIntoId: null, ...customerBranchWhere(scope) },
    });
    const stageMap = new Map(stageCounts.map((s) => [s.stage, s._count]));
    // F1/F6: phễu theo bộ bước của chế độ phòng khám (bỏ bước mất khách).
    const FUNNEL_VIEW = stagesFor(await getClinicMode())
      .filter((st) => !st.lost)
      .map((st) => ({ key: st.key, label: st.label }));
    // Khách đang ở giai đoạn sau thì chắc chắn đã đi qua giai đoạn trước.
    const funnel = FUNNEL_VIEW.map((step, idx) => ({
      stage: step.key,
      label: step.label,
      count: FUNNEL_VIEW.slice(idx).reduce((s, later) => s + (stageMap.get(later.key) ?? 0), 0),
    }));

    // Doanh thu theo ngày GIỜ VIỆT NAM (B4): ký (contract) và thực thu (payment).
    const [contracts, payments] = await Promise.all([
      prisma.contract.findMany({
        where: countedContractWhere(cur, scope.ids),
        select: { signedAt: true, total: true },
      }),
      prisma.payment.findMany({
        where: { branchId: branch, paidAt: cur, ...REAL_MONEY },
        select: { paidAt: true, amount: true },
      }),
    ]);
    const byDay = new Map<string, { signed: number; collected: number }>();
    for (const c of contracts) {
      if (!c.signedAt) continue;
      const k = vnDayKey(c.signedAt);
      const row = byDay.get(k) ?? { signed: 0, collected: 0 };
      row.signed += c.total;
      byDay.set(k, row);
    }
    for (const p of payments) {
      const k = vnDayKey(p.paidAt);
      const row = byDay.get(k) ?? { signed: 0, collected: 0 };
      row.collected += p.amount;
      byDay.set(k, row);
    }
    const daily = [...byDay.entries()].sort().map(([date, v]) => ({ date, ...v }));

    const services = await topServices(cur, scope.ids, 5);

    // Top tư vấn viên theo TIỀN THỰC THU TRONG KỲ (B6), kèm doanh số ký trong kỳ.
    const [collectedBy, signedBy] = await Promise.all([
      collectedByConsultant(cur, scope.ids),
      prisma.contract.groupBy({
        by: ["consultantId"],
        _sum: { total: true },
        _count: true,
        where: countedContractWhere(cur, scope.ids),
      }),
    ]);
    const consultantIds = new Set<string | null>([...collectedBy.keys(), ...signedBy.map((r) => r.consultantId)]);
    const consultantNames = await prisma.user.findMany({
      where: { id: { in: [...consultantIds].filter(Boolean) as string[] } },
      select: { id: true, name: true },
    });
    const nameById = new Map(consultantNames.map((u) => [u.id, u.name]));
    const topConsultants = [...consultantIds]
      .map((id) => {
        const s = signedBy.find((r) => r.consultantId === id);
        return {
          userId: id,
          name: id ? (nameById.get(id) ?? "Không rõ") : "Chưa gán",
          collected: collectedBy.get(id) ?? 0,
          signed: s?._sum.total ?? 0,
          contracts: s?._count ?? 0,
        };
      })
      .sort((a, b) => b.collected - a.collected || b.signed - a.signed)
      .slice(0, 5);

    // Cảnh báo cần xử lý ngay.
    const [overdueInvoices, staleConversations, notReadyProcedures] = await Promise.all([
      prisma.invoice.findMany({
        where: {
          branchId: branch,
          status: { in: [InvoiceStatus.ISSUED, InvoiceStatus.PARTIAL, InvoiceStatus.OVERDUE] },
          dueDate: { lt: new Date(now.getTime() - 7 * 86400000) },
        },
        select: { amount: true, paidAmount: true },
      }),
      prisma.conversation.count({
        where: {
          branchId: branch,
          unreadCount: { gt: 0 },
          lastMessageAt: { lt: new Date(now.getTime() - 60 * 60000) },
        },
      }),
      prisma.procedureRecord.count({
        where: {
          branchId: branch,
          status: ProcedureStatus.SCHEDULED,
          scheduledAt: { gte: now, lt: new Date(now.getTime() + 3 * 86400000) },
        },
      }),
    ]);

    const alerts: Array<{ level: "dg" | "wr"; text: string }> = [];
    if (overdueInvoices.length) {
      const amount = overdueInvoices.reduce((s, i) => s + (i.amount - i.paidAmount), 0);
      alerts.push({
        level: "dg",
        text: `${overdueInvoices.length} đơn công nợ quá hạn trên 7 ngày, tổng ${formatVnd(amount)}đ`,
      });
    }
    if (staleConversations) {
      alerts.push({ level: "wr", text: `${staleConversations} tin nhắn Zalo chưa trả lời quá 60 phút` });
    }
    if (notReadyProcedures) {
      alerts.push({
        level: "wr",
        text: `${notReadyProcedures} ca mổ trong 3 ngày tới chưa xác nhận đủ điều kiện tiền phẫu`,
      });
    }

    res.json({
      period: { from: period.from, to: period.to },
      kpis: [
        { label: "Doanh số ký", value: signed, unit: "đ", delta: delta(signed, signedPrev._sum.total ?? 0) },
        { label: "Tiền thực thu", value: collected, unit: "đ", delta: delta(collected, collectedPrev._sum.amount ?? 0) },
        { label: "Công nợ còn lại", value: debt, unit: "đ", delta: delta(debt, debtPrev), invert: true },
        { label: "Khách mới", value: newCustomersNow, unit: "", delta: delta(newCustomersNow, newCustomersPrev) },
        { label: "Số ca mổ", value: surgeriesNow, unit: "", delta: delta(surgeriesNow, surgeriesPrev) },
        { label: "Giá trị đơn trung bình", value: avgOrder, unit: "đ", delta: delta(avgOrder, avgOrderPrev) },
      ],
      funnel,
      daily,
      topServices: services.map((s) => ({ serviceId: s.serviceId, name: s.name, count: s.count, revenue: s.revenue })),
      topConsultants,
      alerts,
    });
  })
);

// GET /api/reports/revenue?groupBy=service|consultant|branch|channel
router.get(
  "/revenue",
  requirePermission("accounting.read"),
  asyncHandler(async (req, res) => {
    const period = resolvePeriod(req.query as Record<string, unknown>);
    const scope = reportBranchScope(req);
    const cur = { gte: period.from, lt: period.to };
    const groupBy = z.enum(["service", "consultant", "branch", "channel"]).catch("service").parse(req.query.groupBy);

    if (groupBy === "service") {
      const rows = await topServices(cur, scope.ids);
      return res.json(rows.map((r) => ({ key: r.name, serviceId: r.serviceId, revenue: r.revenue, count: r.count })));
    }

    if (groupBy === "branch") {
      const [rows, paid] = await Promise.all([
        prisma.contract.groupBy({
          by: ["branchId"],
          _sum: { total: true },
          _count: true,
          where: countedContractWhere(cur, scope.ids),
        }),
        prisma.payment.groupBy({
          by: ["branchId"],
          _sum: { amount: true },
          where: { branchId: { in: scope.ids }, paidAt: cur, ...REAL_MONEY },
        }),
      ]);
      const branches = await prisma.branch.findMany({ select: { id: true, name: true } });
      const byId = new Map(branches.map((b) => [b.id, b.name]));
      const ids = new Set([...rows.map((r) => r.branchId), ...paid.map((p) => p.branchId)]);
      return res.json(
        [...ids].map((id) => {
          const r = rows.find((x) => x.branchId === id);
          return {
            key: byId.get(id) ?? id,
            revenue: r?._sum.total ?? 0,
            collected: paid.find((p) => p.branchId === id)?._sum.amount ?? 0,
            count: r?._count ?? 0,
          };
        })
      );
    }

    if (groupBy === "channel") {
      // B2: gom theo KÊNH nguồn của khách, không rơi sang nhánh tư vấn viên.
      const [signed, collected, channels] = await Promise.all([
        signedByChannel(cur, scope.ids),
        collectedByChannel(cur, scope.ids),
        prisma.channel.findMany({ select: { id: true, name: true } }),
      ]);
      const nameOf = new Map(channels.map((c) => [c.id, c.name]));
      const keys = new Set<string | null>([...signed.keys(), ...collected.keys()]);
      return res.json(
        [...keys]
          .map((k) => ({
            key: k ? (nameOf.get(k) ?? "Kênh đã xoá") : "Không rõ nguồn",
            channelId: k,
            revenue: signed.get(k)?.total ?? 0,
            collected: collected.get(k) ?? 0,
            count: signed.get(k)?.count ?? 0,
          }))
          .sort((a, b) => b.revenue - a.revenue)
      );
    }

    // consultant
    const [rows, collectedBy] = await Promise.all([
      prisma.contract.groupBy({
        by: ["consultantId"],
        _sum: { total: true },
        _count: true,
        where: countedContractWhere(cur, scope.ids),
      }),
      collectedByConsultant(cur, scope.ids),
    ]);
    const ids = new Set<string | null>([...rows.map((r) => r.consultantId), ...collectedBy.keys()]);
    const users = await prisma.user.findMany({
      where: { id: { in: [...ids].filter(Boolean) as string[] } },
      select: { id: true, name: true },
    });
    const nameById = new Map(users.map((u) => [u.id, u.name]));
    res.json(
      [...ids]
        .map((id) => {
          const r = rows.find((x) => x.consultantId === id);
          return {
            key: id ? (nameById.get(id) ?? "Không rõ") : "Chưa gán",
            revenue: r?._sum.total ?? 0,
            collected: collectedBy.get(id) ?? 0,
            count: r?._count ?? 0,
          };
        })
        .sort((a, b) => b.collected - a.collected || b.revenue - a.revenue)
    );
  })
);

// GET /api/reports/marketing/funnel — lead→hẹn→đến→chốt, CPL, ROAS
router.get(
  "/marketing/funnel",
  requirePermission("lead.read"),
  asyncHandler(async (req, res) => {
    const period = resolvePeriod(req.query as Record<string, unknown>);
    const scope = reportBranchScope(req);
    const cur = { gte: period.from, lt: period.to };

    const [leadsByCampaign, costsByCampaign, contractsByCustomer] = await Promise.all([
      prisma.lead.groupBy({
        by: ["campaignId", "stage"],
        _count: true,
        where: { createdAt: cur, ...nullableBranchWhere("branchId", scope) },
      }),
      prisma.campaignCost.groupBy({
        by: ["campaignId"],
        _sum: { amount: true },
        where: { date: cur, campaign: nullableBranchWhere("branchId", scope) },
      }),
      prisma.contract.groupBy({
        by: ["customerId"],
        _sum: { total: true },
        where: countedContractWhere(cur, scope.ids),
      }),
    ]);

    const campaigns = await prisma.campaign.findMany({
      select: { id: true, name: true, code: true, channel: { select: { name: true } } },
    });

    // Doanh thu quy về chiến dịch qua khách -> hợp đồng.
    const customerIds = contractsByCustomer.map((c) => c.customerId);
    const customers = await prisma.customer.findMany({
      where: { id: { in: customerIds } },
      select: { id: true, campaignId: true },
    });
    const campaignByCustomer = new Map(customers.map((c) => [c.id, c.campaignId]));
    const revenueByCampaign = new Map<string, number>();
    for (const row of contractsByCustomer) {
      const campaignId = campaignByCustomer.get(row.customerId);
      if (!campaignId) continue;
      revenueByCampaign.set(campaignId, (revenueByCampaign.get(campaignId) ?? 0) + (row._sum.total ?? 0));
    }

    const costMap = new Map(costsByCampaign.map((c) => [c.campaignId, c._sum.amount ?? 0]));

    const result = campaigns
      .map((campaign) => {
        const rows = leadsByCampaign.filter((l) => l.campaignId === campaign.id);
        const leads = rows.reduce((s, r) => s + r._count, 0);
        const won = rows.filter((r) => r.stage === "WON").reduce((s, r) => s + r._count, 0);
        const spent = costMap.get(campaign.id) ?? 0;
        const revenue = revenueByCampaign.get(campaign.id) ?? 0;
        return {
          campaignId: campaign.id,
          name: campaign.name,
          code: campaign.code,
          channel: campaign.channel?.name ?? "Không rõ",
          leads,
          won,
          conversionRate: leads ? Math.round((won / leads) * 1000) / 10 : 0,
          spent,
          revenue,
          cpl: leads ? Math.round(spent / leads) : 0,
          roas: spent ? Math.round((revenue / spent) * 10) / 10 : null,
        };
      })
      .filter((r) => r.leads > 0 || r.spent > 0)
      .sort((a, b) => b.revenue - a.revenue);

    res.json(result);
  })
);


/**
 * GET /api/reports/response-time — CHẤM ĐIỂM TELESALE theo tốc độ phản hồi.
 *
 * Đây là chỉ số mà bảng "hiệu suất" cũ không đo được: một telesale chốt ít
 * nhưng trả lời khách trong 2 phút khác hẳn người chốt nhiều nhờ được chia lead
 * ngon. Đo bằng khoảng cách giữa tin ĐẾN của khách và tin TRẢ LỜI kế tiếp.
 */
router.get(
  "/response-time",
  requireCrossPersonPermission("hr.read", "inbox.read", "accounting.read"),
  asyncHandler(async (req, res) => {
    const period = resolvePeriod(req.query as Record<string, unknown>);
    const me = currentUser(req);

    const messages = await prisma.chatMessage.findMany({
      where: {
        createdAt: { gte: period.from, lt: period.to },
        conversation: { branchId: { in: me.branchIds } },
      },
      orderBy: { createdAt: "asc" },
      select: {
        conversationId: true,
        direction: true,
        senderUserId: true,
        createdAt: true,
        conversation: { select: { channel: true } },
      },
    });

    // Ghép từng tin khách gửi với tin trả lời kế tiếp trong cùng hội thoại.
    // F31: push thay vì trải mảng mỗi lần (O(n²) cũ), và tìm tin trả lời bằng
    // một lượt quét ngược tính sẵn "tin OUT kế tiếp" thay vì slice().find() lồng.
    const byConv = new Map<string, typeof messages>();
    for (const m of messages) {
      const list = byConv.get(m.conversationId);
      if (list) list.push(m);
      else byConv.set(m.conversationId, [m]);
    }

    interface Agg { total: number; count: number; slow: number; unanswered: number }
    const byUser = new Map<string, Agg>();
    const byChannel = new Map<string, Agg>();
    const SLOW_MINUTES = await getSettingNumber("inbox.slowReplyMinutes");

    const bump = (map: Map<string, Agg>, key: string, minutes: number | null) => {
      const a = map.get(key) ?? { total: 0, count: 0, slow: 0, unanswered: 0 };
      if (minutes === null) a.unanswered++;
      else {
        a.total += minutes;
        a.count++;
        if (minutes > SLOW_MINUTES) a.slow++;
      }
      map.set(key, a);
    };

    for (const [, list] of byConv) {
      const nextOut: Array<(typeof list)[number] | undefined> = new Array(list.length);
      let upcoming: (typeof list)[number] | undefined;
      for (let i = list.length - 1; i >= 0; i--) {
        nextOut[i] = upcoming;
        if (list[i].direction === "OUT") upcoming = list[i];
      }
      for (let i = 0; i < list.length; i++) {
        if (list[i].direction !== "IN") continue;
        // Bỏ qua nếu khách nhắn liên tiếp: chỉ tính lần đầu của cụm.
        if (i > 0 && list[i - 1].direction === "IN") continue;

        const reply = nextOut[i];
        const channel = list[i].conversation.channel;

        if (!reply) {
          bump(byChannel, channel, null);
          continue;
        }
        const minutes = Math.round(
          (reply.createdAt.getTime() - list[i].createdAt.getTime()) / 60000
        );
        bump(byChannel, channel, minutes);
        if (reply.senderUserId) bump(byUser, reply.senderUserId, minutes);
      }
    }

    const users = await prisma.user.findMany({
      where: { id: { in: [...byUser.keys()] } },
      select: { id: true, name: true },
    });
    const nameById = new Map(users.map((u) => [u.id, u.name]));

    const shape = (map: Map<string, Agg>, label: (k: string) => string) =>
      [...map.entries()]
        .map(([k, a]) => ({
          key: k,
          label: label(k),
          replies: a.count,
          avgMinutes: a.count ? Math.round(a.total / a.count) : 0,
          slowReplies: a.slow,
          unanswered: a.unanswered,
        }))
        .sort((x, y) => x.avgMinutes - y.avgMinutes);

    res.json({
      period: { from: period.from, to: period.to },
      slowThresholdMinutes: SLOW_MINUTES,
      byUser: shape(byUser, (k) => nameById.get(k) ?? "—"),
      byChannel: shape(byChannel, (k) => k),
    });
  })
);

/**
 * GET /api/reports/channel-roas — hiệu quả quảng cáo THEO KÊNH.
 *
 * Khác /marketing/funnel (theo chiến dịch): màn dashboard cần nhìn theo KÊNH
 * (Facebook / TikTok / Instagram / Zalo) vì đó là đơn vị chủ đầu tư quyết định
 * tăng giảm ngân sách.
 */
router.get(
  "/channel-roas",
  requirePermission("lead.read"),
  asyncHandler(async (req, res) => {
    const period = resolvePeriod(req.query as Record<string, unknown>);
    const scope = reportBranchScope(req);
    const cur = { gte: period.from, lt: period.to };

    const [channels, costs, signed, collected, leadCounts] = await Promise.all([
      prisma.channel.findMany(),
      prisma.campaignCost.findMany({
        where: { date: cur, campaign: nullableBranchWhere("branchId", scope) },
        include: { campaign: { select: { channelId: true } } },
      }),
      signedByChannel(cur, scope.ids),
      // B6: thực thu = tiền thu TRONG KỲ, không phải paidAmount cộng dồn của HĐ ký trong kỳ.
      collectedByChannel(cur, scope.ids),
      prisma.lead.groupBy({
        by: ["channelId"],
        _count: true,
        where: { createdAt: cur, ...nullableBranchWhere("branchId", scope) },
      }),
    ]);

    const spentByChannel = new Map<string, number>();
    for (const c of costs) {
      const ch = c.campaign?.channelId;
      if (!ch) continue;
      spentByChannel.set(ch, (spentByChannel.get(ch) ?? 0) + c.amount);
    }

    res.json(
      channels
        .map((ch) => {
          const spent = spentByChannel.get(ch.id) ?? 0;
          const revenue = signed.get(ch.id)?.total ?? 0;
          const coll = collected.get(ch.id) ?? 0;
          const leads = leadCounts.find((l) => l.channelId === ch.id)?._count ?? 0;
          return {
            channelId: ch.id,
            name: ch.name,
            kind: ch.kind,
            leads,
            spent,
            revenue,
            collected: coll,
            cpl: leads ? Math.round(spent / leads) : 0,
            // ROAS tính trên TIỀN THỰC THU — doanh số ký chưa thu được thì
            // chưa phải hiệu quả thật của đồng quảng cáo.
            roas: spent ? Math.round((coll / spent) * 10) / 10 : null,
          };
        })
        .filter((r) => r.leads > 0 || r.spent > 0 || r.revenue > 0 || r.collected > 0)
        .sort((a, b) => (b.roas ?? 0) - (a.roas ?? 0))
    );
  })
);

// GET /api/reports/staff-performance — hiệu suất telesale / tư vấn viên
router.get(
  "/staff-performance",
  requireCrossPersonPermission("hr.read", "accounting.read"),
  asyncHandler(async (req, res) => {
    const period = resolvePeriod(req.query as Record<string, unknown>);
    const scope = reportBranchScope(req);
    const cur = { gte: period.from, lt: period.to };

    const [contracts, collectedBy, customersAssigned, messagesSent] = await Promise.all([
      prisma.contract.groupBy({
        by: ["consultantId"],
        _sum: { total: true },
        _count: true,
        where: countedContractWhere(cur, scope.ids),
      }),
      collectedByConsultant(cur, scope.ids),
      prisma.customer.groupBy({
        by: ["assignedToId"],
        _count: true,
        where: { createdAt: cur, hidden: false, mergedIntoId: null, ...customerBranchWhere(scope) },
      }),
      prisma.chatMessage.groupBy({
        by: ["senderUserId"],
        _count: true,
        where: { direction: "OUT", createdAt: cur, conversation: { branchId: { in: scope.ids } } },
      }),
    ]);

    const userIds = new Set<string>();
    contracts.forEach((c) => c.consultantId && userIds.add(c.consultantId));
    collectedBy.forEach((_v, k) => k && userIds.add(k));
    customersAssigned.forEach((c) => c.assignedToId && userIds.add(c.assignedToId));
    messagesSent.forEach((m) => m.senderUserId && userIds.add(m.senderUserId));

    const users = await prisma.user.findMany({
      where: { id: { in: [...userIds] } },
      select: { id: true, name: true, roleLinks: { select: { role: { select: { code: true } } } } },
    });

    res.json(
      users
        .map((u) => {
          const c = contracts.find((x) => x.consultantId === u.id);
          const assigned = customersAssigned.find((x) => x.assignedToId === u.id)?._count ?? 0;
          const won = c?._count ?? 0;
          return {
            userId: u.id,
            name: u.name,
            roles: u.roleLinks.map((l) => l.role.code),
            customersAssigned: assigned,
            contractsWon: won,
            signed: c?._sum.total ?? 0,
            collected: collectedBy.get(u.id) ?? 0,
            messagesSent: messagesSent.find((x) => x.senderUserId === u.id)?._count ?? 0,
            closeRate: assigned ? Math.round((won / assigned) * 1000) / 10 : 0,
          };
        })
        .sort((a, b) => b.collected - a.collected)
    );
  })
);

/**
 * GET /api/reports/departments — bảng điểm hiệu suất TỪNG BỘ PHẬN.
 *
 * Một lần gọi trả về cả tám bộ phận, mỗi bộ phận kèm chỉ số đầu bảng, bảng nhân
 * sự có điểm, và cảnh báo riêng. Gộp làm một để màn Tổng quan không phải bắn
 * tám yêu cầu rồi ghép ở trình duyệt.
 */
router.get(
  "/departments",
  requireCrossPersonPermission("hr.read", "accounting.read"),
  asyncHandler(async (req, res) => {
    const period = resolvePeriod(req.query as Record<string, unknown>);
    const scope = reportBranchScope(req);

    res.json({
      period: { from: period.from, to: period.to },
      departments: await buildDepartments({
        from: period.from,
        to: period.to,
        branchIds: scope.ids,
        specificBranch: scope.specific,
      }),
    });
  })
);

// GET /api/reports/clinic-operations — no-show, thời gian chờ, công suất
router.get(
  "/clinic-operations",
  requireAnyPermission("accounting.read", "appointment.read"),
  asyncHandler(async (req, res) => {
    const period = resolvePeriod(req.query as Record<string, unknown>);
    const scope = reportBranchScope(req);
    const branch = { in: scope.ids };
    const cur = { gte: period.from, lt: period.to };
    const now = new Date();
    // B8: chỉ lịch ĐÃ TỚI GIỜ mới có thể "không đến"; lịch tương lai không vào mẫu số.
    const dueUntil = period.to < now ? period.to : now;

    const [appointments, dueAppointments, visits, procedures, capacityHours] = await Promise.all([
      prisma.appointment.groupBy({
        by: ["status"],
        _count: true,
        where: { branchId: branch, startAt: cur },
      }),
      prisma.appointment.groupBy({
        by: ["status"],
        _count: true,
        where: {
          branchId: branch,
          startAt: { gte: period.from, lt: dueUntil },
          status: { not: AppointmentStatus.CANCELLED },
        },
      }),
      prisma.visit.findMany({
        where: { branchId: branch, checkedInAt: cur },
        select: { checkedInAt: true, calledAt: true, finishedAt: true, status: true },
      }),
      prisma.procedureRecord.findMany({
        where: { branchId: branch, scheduledAt: cur },
        select: {
          branchId: true,
          surgeonId: true,
          durationMin: true,
          status: true,
          scheduledAt: true,
          startedAt: true,
          finishedAt: true,
        },
      }),
      getSettingNumber("surgery.capacityHoursPerDay"),
    ]);

    const totalAppointments = appointments.reduce((s, a) => s + a._count, 0);
    const noShowBase = dueAppointments.reduce((s, a) => s + a._count, 0);
    const noShow = dueAppointments.find((a) => a.status === AppointmentStatus.NO_SHOW)?._count ?? 0;

    const waits = visits
      .filter((v) => v.calledAt)
      .map((v) => (v.calledAt!.getTime() - v.checkedInAt.getTime()) / 60000);
    const avgWait = waits.length ? Math.round(waits.reduce((s, w) => s + w, 0) / waits.length) : 0;

    // B9: công suất theo phút thật (bắt đầu, kết thúc thật), theo ngày giờ Việt
    // Nam, theo từng bác sĩ và từng cơ sở.
    const capacityPerDay = capacityHours * 60;
    const days = daysInPeriod(period.from, period.to);
    const byDay = new Map<string, number>();
    const byDoctor = new Map<string | null, { minutes: number; cases: number; days: Set<string> }>();
    const byBranch = new Map<string, number>();
    for (const p of procedures) {
      if (!occupiesRoom(p.status)) continue;
      const minutes = procedureMinutes(p);
      const k = vnDayKey(p.startedAt ?? p.scheduledAt);
      byDay.set(k, (byDay.get(k) ?? 0) + minutes);
      const d = byDoctor.get(p.surgeonId) ?? { minutes: 0, cases: 0, days: new Set<string>() };
      d.minutes += minutes;
      d.cases += 1;
      d.days.add(k);
      byDoctor.set(p.surgeonId, d);
      byBranch.set(p.branchId, (byBranch.get(p.branchId) ?? 0) + minutes);
    }

    const [doctorUsers, branches, roomCounts] = await Promise.all([
      prisma.user.findMany({
        where: { id: { in: [...byDoctor.keys()].filter(Boolean) as string[] } },
        select: { id: true, name: true },
      }),
      prisma.branch.findMany({ where: { id: { in: scope.ids } }, select: { id: true, name: true } }),
      prisma.room.groupBy({
        by: ["branchId"],
        _count: true,
        where: {
          branchId: branch,
          active: true,
          type: { in: [RoomType.OPERATING, RoomType.MINOR_OP] },
        },
      }),
    ]);
    const doctorName = new Map(doctorUsers.map((u) => [u.id, u.name]));
    const pctOf = (minutes: number, capacity: number) =>
      capacity > 0 ? Math.min(100, Math.round((minutes / capacity) * 100)) : 0;

    // Mốc 100% của cả kỳ cho cơ sở = số phòng × số ngày × số giờ mỗi ngày.
    const roomsOf = (branchId: string) =>
      Math.max(1, roomCounts.find((r) => r.branchId === branchId)?._count ?? 0);
    const allRooms = scope.ids.reduce((s, id) => s + roomsOf(id), 0);

    res.json({
      appointments: {
        total: totalAppointments,
        byStatus: appointments,
        noShow,
        /** Mẫu số tỉ lệ vắng: lịch đã tới giờ, không tính lịch đã huỷ. */
        noShowBase,
        noShowRate: noShowBase ? Math.round((noShow / noShowBase) * 1000) / 10 : 0,
      },
      queue: {
        visits: visits.length,
        avgWaitMinutes: avgWait,
        stillWaiting: visits.filter((v) => v.status === VisitStatus.WAITING).length,
      },
      capacityHoursPerDay: capacityHours,
      surgeryCapacity: [...byDay.entries()].sort().map(([date, minutes]) => ({
        date,
        minutes,
        utilization: pctOf(minutes, capacityPerDay * allRooms),
      })),
      capacityByDoctor: [...byDoctor.entries()]
        .map(([id, d]) => ({
          doctorId: id,
          name: id ? (doctorName.get(id) ?? "Không rõ") : "Chưa gán bác sĩ",
          cases: d.cases,
          minutes: d.minutes,
          workDays: d.days.size,
          utilization: pctOf(d.minutes, capacityPerDay * days),
        }))
        .sort((a, b) => b.minutes - a.minutes),
      capacityByBranch: branches.map((b) => {
        const minutes = byBranch.get(b.id) ?? 0;
        return {
          branchId: b.id,
          name: b.name,
          rooms: roomsOf(b.id),
          minutes,
          utilization: pctOf(minutes, capacityPerDay * days * roomsOf(b.id)),
        };
      }),
    });
  })
);

/**
 * POST /api/reports/export
 * Xuất dữ liệu là đường rò rỉ số 1 (mục 4.4): cần quyền riêng, có hạn mức số
 * dòng, và MỌI lần xuất đều ghi DataAccessLog mức ELEVATED trở lên.
 */
router.post(
  "/export",
  requirePermission("report.export"),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        dataset: z.enum(["customers", "contracts", "payments", "invoices"]),
        from: z.coerce.date().optional(),
        to: z.coerce.date().optional(),
      })
      .parse(req.body);

    const me = currentUser(req);
    const range = {
      ...(body.from ? { gte: body.from } : {}),
      ...(body.to ? { lt: body.to } : {}),
    };
    const hasRange = Boolean(body.from || body.to);
    const branch = { in: me.branchIds };

    let rows: Record<string, unknown>[] = [];
    switch (body.dataset) {
      case "customers": {
        const { where } = scopedWhere(req, "customer.read", {
          ownerFields: ["assignedToId", "telesaleId"],
          branchField: null,
        });
        rows = await prisma.customer.findMany({
          where: { ...where, hidden: false, ...(hasRange ? { createdAt: range } : {}) },
          take: env.exportRowLimit + 1,
          select: { code: true, name: true, phone: true, status: true, stage: true, createdAt: true },
        });
        // S4: tệp xuất là đường rò rỉ dễ nhất, che SĐT y như trên màn hình.
        rows = rows.map((r) => ({ ...r, phone: phoneFor(req, r.phone as string | null) }));
        break;
      }
      case "contracts":
        rows = await prisma.contract.findMany({
          where: { branchId: branch, ...(hasRange ? { signedAt: range } : {}) },
          take: env.exportRowLimit + 1,
          select: { code: true, total: true, paidAmount: true, status: true, signedAt: true },
        });
        break;
      case "payments":
        rows = await prisma.payment.findMany({
          where: { branchId: branch, ...(hasRange ? { paidAt: range } : {}) },
          take: env.exportRowLimit + 1,
          select: { code: true, amount: true, method: true, paidAt: true },
        });
        break;
      case "invoices":
        rows = await prisma.invoice.findMany({
          where: { branchId: branch, ...(hasRange ? { createdAt: range } : {}) },
          take: env.exportRowLimit + 1,
          select: { code: true, title: true, amount: true, paidAmount: true, status: true, dueDate: true },
        });
        break;
    }

    if (rows.length > env.exportRowLimit) {
      await writeAccessLog({
        req,
        resourceType: AccessResourceType.REPORT_EXPORT,
        severity: AccessSeverity.CRITICAL,
        reason: `Vượt hạn mức xuất: yêu cầu > ${env.exportRowLimit} dòng (${body.dataset})`,
        rowCount: rows.length,
      });
      throw new HttpError(
        413,
        `Vượt hạn mức ${env.exportRowLimit} dòng mỗi lần xuất. Thu hẹp khoảng thời gian rồi xuất lại.`
      );
    }

    await writeAccessLog({
      req,
      resourceType: AccessResourceType.REPORT_EXPORT,
      severity: rows.length > 500 ? AccessSeverity.CRITICAL : AccessSeverity.ELEVATED,
      reason: `Xuất ${body.dataset}`,
      rowCount: rows.length,
    });

    res.json({ dataset: body.dataset, rowCount: rows.length, rows });
  })
);

/**
 * GET /api/reports/deposits?period=&branchId= — F25 + F12: tỉ lệ lịch có cọc và
 * tỉ lệ không đến tách theo có cọc / không cọc. Mẫu số tỉ lệ không đến chỉ gồm
 * lịch đã tới giờ và không bị huỷ (như B8).
 */
router.get(
  "/deposits",
  requirePermission("appointment.read"),
  asyncHandler(async (req, res) => {
    const period = resolvePeriod(req.query as Record<string, unknown>);
    const scope = reportBranchScope(req);
    const now = new Date();
    const base = {
      branchId: { in: scope.ids },
      startAt: { gte: period.from, lt: period.to },
      status: { not: AppointmentStatus.CANCELLED },
    };
    const deposited = { depositStatus: { in: [DepositStatus.DA_COC, DepositStatus.HOAN_COC] } };
    const notDeposited = { OR: [{ depositStatus: null }, { depositStatus: DepositStatus.CHO_COC }] };
    const past = { startAt: { gte: period.from, lt: period.to < now ? period.to : now } };

    const [total, withDeposit, pastWith, noShowWith, pastWithout, noShowWithout, depositSum] = await Promise.all([
      prisma.appointment.count({ where: base }),
      prisma.appointment.count({ where: { ...base, ...deposited } }),
      prisma.appointment.count({ where: { ...base, ...deposited, ...past } }),
      prisma.appointment.count({ where: { ...base, ...deposited, ...past, status: AppointmentStatus.NO_SHOW } }),
      prisma.appointment.count({ where: { ...base, ...notDeposited, ...past } }),
      prisma.appointment.count({ where: { ...base, ...notDeposited, ...past, status: AppointmentStatus.NO_SHOW } }),
      prisma.payment.aggregate({
        where: { branchId: { in: scope.ids }, type: "DEPOSIT", paidAt: { gte: period.from, lt: period.to } },
        _sum: { amount: true },
      }),
    ]);
    const rate = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : null);
    res.json({
      from: period.from,
      to: period.to,
      appointments: total,
      withDeposit,
      depositRate: rate(withDeposit, total),
      depositCollected: depositSum._sum.amount ?? 0,
      noShow: {
        withDeposit: { due: pastWith, noShow: noShowWith, rate: rate(noShowWith, pastWith) },
        withoutDeposit: { due: pastWithout, noShow: noShowWithout, rate: rate(noShowWithout, pastWithout) },
      },
    });
  })
);

/**
 * GET /api/reports/discount-leakage?period=&from=&to=&branchId=&groupBy=sales|service|month
 * F21: RÒ RỈ CHIẾT KHẤU = tiền giảm so với giá niêm yết NGOÀI đợt ưu đãi, trên
 * dòng hợp đồng đã ký trong kỳ (không tính hợp đồng huỷ). Tách phần đã được
 * quản lý duyệt để thấy giảm "tự ý" (trong trần) và giảm có duyệt.
 */
router.get(
  "/discount-leakage",
  requireCrossPersonPermission("accounting.read", "sales_order.approve_discount"),
  asyncHandler(async (req, res) => {
    const groupBy = z.enum(["sales", "service", "month"]).default("sales").parse(req.query.groupBy ?? undefined);
    const period = resolvePeriod(req.query as Record<string, unknown>);
    const scope = reportBranchScope(req);
    const items = await prisma.contractItem.findMany({
      where: { contract: countedContractWhere({ gte: period.from, lt: period.to }, scope.ids) },
      select: {
        serviceId: true,
        name: true,
        quantity: true,
        unitPrice: true,
        amount: true,
        listPrice: true,
        discountAmount: true,
        promotionDiscount: true,
        approvedById: true,
        service: { select: { name: true } },
        contract: { select: { signedAt: true, consultantId: true, consultant: { select: { name: true } } } },
      },
    });

    interface Row {
      key: string;
      label: string;
      lines: number;
      listTotal: number;
      netTotal: number;
      discountTotal: number;
      promotionDiscount: number;
      leakage: number;
      approvedLeakage: number;
      leakagePercent: number;
    }
    const rows = new Map<string, Row>();
    const total: Row = {
      key: "TOTAL", label: "Tổng", lines: 0, listTotal: 0, netTotal: 0, discountTotal: 0,
      promotionDiscount: 0, leakage: 0, approvedLeakage: 0, leakagePercent: 0,
    };
    for (const i of items) {
      const [key, label] =
        groupBy === "sales"
          ? [i.contract.consultantId ?? "none", i.contract.consultant?.name ?? "(chưa gán tư vấn)"]
          : groupBy === "service"
            ? [i.serviceId ?? `name:${i.name}`, i.service?.name ?? i.name]
            : [vnDayKey(i.contract.signedAt!).slice(0, 7), vnDayKey(i.contract.signedAt!).slice(0, 7)];
      const row = rows.get(key) ?? {
        key, label, lines: 0, listTotal: 0, netTotal: 0, discountTotal: 0,
        promotionDiscount: 0, leakage: 0, approvedLeakage: 0, leakagePercent: 0,
      };
      const listTotal = (i.listPrice ?? i.unitPrice) * i.quantity;
      const leak = Math.max(0, i.discountAmount - i.promotionDiscount);
      for (const r of [row, total]) {
        r.lines += 1;
        r.listTotal += listTotal;
        r.netTotal += i.amount;
        r.discountTotal += i.discountAmount;
        r.promotionDiscount += i.promotionDiscount;
        r.leakage += leak;
        if (i.approvedById) r.approvedLeakage += leak;
      }
      rows.set(key, row);
    }
    const pct = (r: Row) => (r.listTotal ? Math.round((r.leakage / r.listTotal) * 10000) / 100 : 0);
    const out = [...rows.values()].map((r) => ({ ...r, leakagePercent: pct(r) }));
    out.sort((a, b) => (groupBy === "month" ? a.key.localeCompare(b.key) : b.leakage - a.leakage));
    res.json({ groupBy, from: period.from, to: period.to, rows: out, total: { ...total, leakagePercent: pct(total) } });
  })
);

export default router;
