import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { env } from "../lib/env";
import { asyncHandler, HttpError } from "../middleware/errorHandler";
import { requireAuth, currentUser } from "../middleware/auth";
import {
  requirePermission,
  requireAnyPermission,
  requireCrossPersonPermission,
  scopedWhere,
} from "../middleware/rbac";
import { writeAccessLog } from "../lib/audit";
import { getSettingNumber } from "../lib/settings-catalog";
import { buildDepartments } from "../lib/department-scorecard";
import {
  AccessResourceType,
  AccessSeverity,
  AppointmentStatus,
  ContractStatus,
  FunnelStage,
  InvoiceStatus,
  ProcedureStatus,
  VisitStatus,
} from "../types/enums";

// Báo cáo doanh thu, phễu lead, hiệu suất telesale + Dashboard chủ đầu tư.
//
// Tất cả đều gộp bằng truy vấn tổng hợp (groupBy/aggregate) chứ không nạp bản
// ghi về rồi cộng trong JS — bản cũ làm thế và sẽ sập khi dữ liệu lớn dần.

const router = Router();
router.use(requireAuth);

interface Period {
  from: Date;
  to: Date;
  prevFrom: Date;
  prevTo: Date;
}

/** Quy kỳ báo cáo về khoảng thời gian + khoảng kỳ trước để so sánh. */
function resolvePeriod(query: Record<string, unknown>): Period {
  const now = new Date();
  const preset = String(query.period ?? "month");

  let from: Date;
  let to = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);

  if (query.from) {
    from = new Date(String(query.from));
    if (query.to) to = new Date(String(query.to));
  } else {
    switch (preset) {
      case "today":
        from = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        break;
      case "7d":
        from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6);
        break;
      case "quarter": {
        const q = Math.floor(now.getMonth() / 3);
        from = new Date(now.getFullYear(), q * 3, 1);
        break;
      }
      default:
        from = new Date(now.getFullYear(), now.getMonth(), 1);
    }
  }

  const span = to.getTime() - from.getTime();
  return { from, to, prevFrom: new Date(from.getTime() - span), prevTo: from };
}

function branchFilter(req: Parameters<typeof requireAuth>[0]): { in: string[] } | string {
  const me = currentUser(req);
  const requested = req.query.branchId as string | undefined;
  if (requested && me.branchIds.includes(requested)) return requested;
  return { in: me.branchIds };
}

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
    const branch = branchFilter(req);

    const [
      signedNow,
      signedPrev,
      collectedNow,
      collectedPrev,
      newCustomersNow,
      newCustomersPrev,
      surgeriesNow,
      surgeriesPrev,
      debtAgg,
      debtPrevAgg,
    ] = await Promise.all([
      prisma.contract.aggregate({
        where: { branchId: branch, signedAt: { gte: period.from, lt: period.to } },
        _sum: { total: true },
        _count: true,
      }),
      prisma.contract.aggregate({
        where: { branchId: branch, signedAt: { gte: period.prevFrom, lt: period.prevTo } },
        _sum: { total: true },
        _count: true,
      }),
      prisma.payment.aggregate({
        where: { branchId: branch, paidAt: { gte: period.from, lt: period.to } },
        _sum: { amount: true },
      }),
      prisma.payment.aggregate({
        where: { branchId: branch, paidAt: { gte: period.prevFrom, lt: period.prevTo } },
        _sum: { amount: true },
      }),
      prisma.customer.count({ where: { createdAt: { gte: period.from, lt: period.to } } }),
      prisma.customer.count({ where: { createdAt: { gte: period.prevFrom, lt: period.prevTo } } }),
      prisma.procedureRecord.count({
        where: {
          branchId: branch,
          status: ProcedureStatus.COMPLETED,
          finishedAt: { gte: period.from, lt: period.to },
        },
      }),
      prisma.procedureRecord.count({
        where: {
          branchId: branch,
          status: ProcedureStatus.COMPLETED,
          finishedAt: { gte: period.prevFrom, lt: period.prevTo },
        },
      }),
      prisma.invoice.aggregate({
        where: {
          branchId: branch,
          status: { in: [InvoiceStatus.ISSUED, InvoiceStatus.PARTIAL, InvoiceStatus.OVERDUE] },
        },
        _sum: { amount: true, paidAmount: true },
      }),
      prisma.invoice.aggregate({
        where: {
          branchId: branch,
          status: { in: [InvoiceStatus.ISSUED, InvoiceStatus.PARTIAL, InvoiceStatus.OVERDUE] },
          createdAt: { lt: period.from },
        },
        _sum: { amount: true, paidAmount: true },
      }),
    ]);

    const signed = signedNow._sum.total ?? 0;
    const collected = collectedNow._sum.amount ?? 0;
    const debt = (debtAgg._sum.amount ?? 0) - (debtAgg._sum.paidAmount ?? 0);
    const debtPrev = (debtPrevAgg._sum.amount ?? 0) - (debtPrevAgg._sum.paidAmount ?? 0);
    const avgOrder = signedNow._count > 0 ? Math.round(signed / signedNow._count) : 0;
    const avgOrderPrev = signedPrev._count > 0 ? Math.round((signedPrev._sum.total ?? 0) / signedPrev._count) : 0;

    // Phễu: đếm khách theo giai đoạn đang ở, cộng dồn ngược để ra hình phễu.
    const stageCounts = await prisma.customer.groupBy({
      by: ["stage"],
      _count: true,
      where: { createdAt: { gte: period.from, lt: period.to }, hidden: false },
    });
    const stageMap = new Map(stageCounts.map((s) => [s.stage, s._count]));
    const FUNNEL_VIEW: Array<{ key: FunnelStage; label: string }> = [
      { key: FunnelStage.MOI, label: "Mới" },
      { key: FunnelStage.LIENHE, label: "Đã liên hệ" },
      { key: FunnelStage.HEN, label: "Đã hẹn" },
      { key: FunnelStage.DEN, label: "Đã đến" },
      { key: FunnelStage.CHOT, label: "Đã chốt" },
      { key: FunnelStage.PT, label: "Đã phẫu thuật" },
    ];
    // Khách đang ở giai đoạn sau thì chắc chắn đã đi qua giai đoạn trước.
    const funnel = FUNNEL_VIEW.map((step, idx) => ({
      stage: step.key,
      label: step.label,
      count: FUNNEL_VIEW.slice(idx).reduce((s, later) => s + (stageMap.get(later.key) ?? 0), 0),
    }));

    // Doanh thu theo ngày: ký (contract) và thực thu (payment).
    const [contracts, payments] = await Promise.all([
      prisma.contract.findMany({
        where: { branchId: branch, signedAt: { gte: period.from, lt: period.to } },
        select: { signedAt: true, total: true },
      }),
      prisma.payment.findMany({
        where: { branchId: branch, paidAt: { gte: period.from, lt: period.to } },
        select: { paidAt: true, amount: true },
      }),
    ]);
    const byDay = new Map<string, { signed: number; collected: number }>();
    const dayKey = (d: Date) => d.toISOString().slice(0, 10);
    for (const c of contracts) {
      if (!c.signedAt) continue;
      const k = dayKey(c.signedAt);
      const row = byDay.get(k) ?? { signed: 0, collected: 0 };
      row.signed += c.total;
      byDay.set(k, row);
    }
    for (const p of payments) {
      const k = dayKey(p.paidAt);
      const row = byDay.get(k) ?? { signed: 0, collected: 0 };
      row.collected += p.amount;
      byDay.set(k, row);
    }
    const daily = [...byDay.entries()].sort().map(([date, v]) => ({ date, ...v }));

    // Top dịch vụ theo doanh thu.
    const topServices = await prisma.contractItem.groupBy({
      by: ["name"],
      _sum: { amount: true },
      _count: true,
      where: { contract: { branchId: branch, signedAt: { gte: period.from, lt: period.to } } },
      orderBy: { _sum: { amount: "desc" } },
      take: 5,
    });

    // Top tư vấn viên theo TIỀN THỰC THU (không phải tiền ký) — tiền vào tài
    // khoản mới là hiệu suất thật.
    const consultantRows = await prisma.contract.groupBy({
      by: ["consultantId"],
      _sum: { paidAmount: true, total: true },
      _count: true,
      where: { branchId: branch, signedAt: { gte: period.from, lt: period.to } },
      orderBy: { _sum: { paidAmount: "desc" } },
      take: 5,
    });
    const consultantNames = await prisma.user.findMany({
      where: { id: { in: consultantRows.map((r) => r.consultantId).filter(Boolean) as string[] } },
      select: { id: true, name: true },
    });
    const nameById = new Map(consultantNames.map((u) => [u.id, u.name]));

    // Cảnh báo cần xử lý ngay.
    const now = new Date();
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
        text: `${overdueInvoices.length} đơn công nợ quá hạn trên 7 ngày — tổng ${amount.toLocaleString("vi-VN")}đ`,
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
      topServices: topServices.map((s) => ({
        name: s.name,
        count: s._count,
        revenue: s._sum.amount ?? 0,
      })),
      topConsultants: consultantRows.map((r) => ({
        userId: r.consultantId,
        name: r.consultantId ? (nameById.get(r.consultantId) ?? "—") : "— chưa gán —",
        collected: r._sum.paidAmount ?? 0,
        signed: r._sum.total ?? 0,
        contracts: r._count,
      })),
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
    const branch = branchFilter(req);
    const groupBy = String(req.query.groupBy ?? "service");

    if (groupBy === "service") {
      const rows = await prisma.contractItem.groupBy({
        by: ["name"],
        _sum: { amount: true },
        _count: true,
        where: { contract: { branchId: branch, signedAt: { gte: period.from, lt: period.to } } },
        orderBy: { _sum: { amount: "desc" } },
      });
      return res.json(rows.map((r) => ({ key: r.name, revenue: r._sum.amount ?? 0, count: r._count })));
    }

    if (groupBy === "branch") {
      const rows = await prisma.contract.groupBy({
        by: ["branchId"],
        _sum: { total: true, paidAmount: true },
        _count: true,
        where: { branchId: branch, signedAt: { gte: period.from, lt: period.to } },
      });
      const branches = await prisma.branch.findMany({ select: { id: true, name: true } });
      const byId = new Map(branches.map((b) => [b.id, b.name]));
      return res.json(
        rows.map((r) => ({
          key: byId.get(r.branchId) ?? r.branchId,
          revenue: r._sum.total ?? 0,
          collected: r._sum.paidAmount ?? 0,
          count: r._count,
        }))
      );
    }

    // consultant
    const rows = await prisma.contract.groupBy({
      by: ["consultantId"],
      _sum: { total: true, paidAmount: true },
      _count: true,
      where: { branchId: branch, signedAt: { gte: period.from, lt: period.to } },
      orderBy: { _sum: { paidAmount: "desc" } },
    });
    const users = await prisma.user.findMany({
      where: { id: { in: rows.map((r) => r.consultantId).filter(Boolean) as string[] } },
      select: { id: true, name: true },
    });
    const nameById = new Map(users.map((u) => [u.id, u.name]));
    res.json(
      rows.map((r) => ({
        key: r.consultantId ? (nameById.get(r.consultantId) ?? "—") : "— chưa gán —",
        revenue: r._sum.total ?? 0,
        collected: r._sum.paidAmount ?? 0,
        count: r._count,
      }))
    );
  })
);

// GET /api/reports/marketing/funnel — lead→hẹn→đến→chốt, CPL, ROAS
router.get(
  "/marketing/funnel",
  requirePermission("lead.read"),
  asyncHandler(async (req, res) => {
    const period = resolvePeriod(req.query as Record<string, unknown>);

    const [leadsByCampaign, costsByCampaign, contractsByCampaign] = await Promise.all([
      prisma.lead.groupBy({
        by: ["campaignId", "stage"],
        _count: true,
        where: { createdAt: { gte: period.from, lt: period.to } },
      }),
      prisma.campaignCost.groupBy({
        by: ["campaignId"],
        _sum: { amount: true },
        where: { date: { gte: period.from, lt: period.to } },
      }),
      prisma.contract.groupBy({
        by: ["customerId"],
        _sum: { total: true },
        where: { signedAt: { gte: period.from, lt: period.to } },
      }),
    ]);

    const campaigns = await prisma.campaign.findMany({
      select: { id: true, name: true, code: true, channel: { select: { name: true } } },
    });

    // Doanh thu quy về chiến dịch qua khách -> hợp đồng.
    const customerIds = contractsByCampaign.map((c) => c.customerId);
    const customers = await prisma.customer.findMany({
      where: { id: { in: customerIds } },
      select: { id: true, campaignId: true },
    });
    const campaignByCustomer = new Map(customers.map((c) => [c.id, c.campaignId]));
    const revenueByCampaign = new Map<string, number>();
    for (const row of contractsByCampaign) {
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
          channel: campaign.channel?.name ?? "—",
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
    const byConv = new Map<string, typeof messages>();
    for (const m of messages) {
      byConv.set(m.conversationId, [...(byConv.get(m.conversationId) ?? []), m]);
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
      for (let i = 0; i < list.length; i++) {
        if (list[i].direction !== "IN") continue;
        // Bỏ qua nếu khách nhắn liên tiếp — chỉ tính lần đầu của cụm.
        if (i > 0 && list[i - 1].direction === "IN") continue;

        const reply = list.slice(i + 1).find((m) => m.direction === "OUT");
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

    const [channels, costs, customers] = await Promise.all([
      prisma.channel.findMany(),
      prisma.campaignCost.findMany({
        where: { date: { gte: period.from, lt: period.to } },
        include: { campaign: { select: { channelId: true } } },
      }),
      prisma.customer.findMany({
        where: { channelId: { not: null } },
        select: { id: true, channelId: true },
      }),
    ]);

    const contracts = await prisma.contract.groupBy({
      by: ["customerId"],
      _sum: { total: true, paidAmount: true },
      where: { signedAt: { gte: period.from, lt: period.to } },
    });

    const channelByCustomer = new Map(customers.map((c) => [c.id, c.channelId]));
    const spentByChannel = new Map<string, number>();
    for (const c of costs) {
      const ch = c.campaign?.channelId;
      if (!ch) continue;
      spentByChannel.set(ch, (spentByChannel.get(ch) ?? 0) + c.amount);
    }

    const revenueByChannel = new Map<string, number>();
    const collectedByChannel = new Map<string, number>();
    for (const row of contracts) {
      const ch = channelByCustomer.get(row.customerId);
      if (!ch) continue;
      revenueByChannel.set(ch, (revenueByChannel.get(ch) ?? 0) + (row._sum.total ?? 0));
      collectedByChannel.set(ch, (collectedByChannel.get(ch) ?? 0) + (row._sum.paidAmount ?? 0));
    }

    const leadCounts = await prisma.lead.groupBy({
      by: ["channelId"],
      _count: true,
      where: { createdAt: { gte: period.from, lt: period.to } },
    });

    res.json(
      channels
        .map((ch) => {
          const spent = spentByChannel.get(ch.id) ?? 0;
          const revenue = revenueByChannel.get(ch.id) ?? 0;
          const collected = collectedByChannel.get(ch.id) ?? 0;
          const leads = leadCounts.find((l) => l.channelId === ch.id)?._count ?? 0;
          return {
            channelId: ch.id,
            name: ch.name,
            kind: ch.kind,
            leads,
            spent,
            revenue,
            collected,
            cpl: leads ? Math.round(spent / leads) : 0,
            // ROAS tính trên TIỀN THỰC THU — doanh số ký chưa thu được thì
            // chưa phải hiệu quả thật của đồng quảng cáo.
            roas: spent ? Math.round((collected / spent) * 10) / 10 : null,
          };
        })
        .filter((r) => r.leads > 0 || r.spent > 0 || r.revenue > 0)
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
    const branch = branchFilter(req);

    const [contracts, customersAssigned, messagesSent] = await Promise.all([
      prisma.contract.groupBy({
        by: ["consultantId"],
        _sum: { total: true, paidAmount: true },
        _count: true,
        where: { branchId: branch, signedAt: { gte: period.from, lt: period.to } },
      }),
      prisma.customer.groupBy({
        by: ["assignedToId"],
        _count: true,
        where: { createdAt: { gte: period.from, lt: period.to }, hidden: false },
      }),
      prisma.chatMessage.groupBy({
        by: ["senderUserId"],
        _count: true,
        where: { direction: "OUT", createdAt: { gte: period.from, lt: period.to } },
      }),
    ]);

    const userIds = new Set<string>();
    contracts.forEach((c) => c.consultantId && userIds.add(c.consultantId));
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
            collected: c?._sum.paidAmount ?? 0,
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
    const me = currentUser(req);
    const requested = req.query.branchId as string | undefined;
    const branchIds =
      requested && me.branchIds.includes(requested) ? [requested] : me.branchIds;

    res.json({
      period: { from: period.from, to: period.to },
      departments: await buildDepartments({ from: period.from, to: period.to, branchIds }),
    });
  })
);

// GET /api/reports/clinic-operations — no-show, thời gian chờ, công suất
router.get(
  "/clinic-operations",
  requireAnyPermission("accounting.read", "appointment.read"),
  asyncHandler(async (req, res) => {
    const period = resolvePeriod(req.query as Record<string, unknown>);
    const branch = branchFilter(req);

    const [appointments, visits, procedures] = await Promise.all([
      prisma.appointment.groupBy({
        by: ["status"],
        _count: true,
        where: { branchId: branch, startAt: { gte: period.from, lt: period.to } },
      }),
      prisma.visit.findMany({
        where: { branchId: branch, checkedInAt: { gte: period.from, lt: period.to } },
        select: { checkedInAt: true, calledAt: true, finishedAt: true, status: true },
      }),
      prisma.procedureRecord.findMany({
        where: { branchId: branch, scheduledAt: { gte: period.from, lt: period.to } },
        select: { durationMin: true, status: true, scheduledAt: true },
      }),
    ]);

    const totalAppointments = appointments.reduce((s, a) => s + a._count, 0);
    const noShow = appointments.find((a) => a.status === AppointmentStatus.NO_SHOW)?._count ?? 0;

    const waits = visits
      .filter((v) => v.calledAt)
      .map((v) => (v.calledAt!.getTime() - v.checkedInAt.getTime()) / 60000);
    const avgWait = waits.length ? Math.round(waits.reduce((s, w) => s + w, 0) / waits.length) : 0;

    // Công suất phòng mổ theo ngày, lấy 8 giờ mổ/ngày làm mốc 100%.
    const CAPACITY_MIN_PER_DAY = 8 * 60;
    const byDay = new Map<string, number>();
    for (const p of procedures) {
      if (p.status === ProcedureStatus.CANCELLED) continue;
      const k = p.scheduledAt.toISOString().slice(0, 10);
      byDay.set(k, (byDay.get(k) ?? 0) + p.durationMin);
    }

    res.json({
      appointments: { total: totalAppointments, byStatus: appointments, noShow, noShowRate: totalAppointments ? Math.round((noShow / totalAppointments) * 1000) / 10 : 0 },
      queue: {
        visits: visits.length,
        avgWaitMinutes: avgWait,
        stillWaiting: visits.filter((v) => v.status === VisitStatus.WAITING).length,
      },
      surgeryCapacity: [...byDay.entries()].sort().map(([date, minutes]) => ({
        date,
        minutes,
        utilization: Math.min(100, Math.round((minutes / CAPACITY_MIN_PER_DAY) * 100)),
      })),
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

export default router;
