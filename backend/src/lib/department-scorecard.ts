import { prisma } from "./prisma";
import { getSettingNumber } from "./settings-catalog";
import { AppointmentStatus, ProcedureStatus, VisitStatus } from "../types/enums";

/* BẢNG ĐIỂM THEO BỘ PHẬN — nguồn số liệu cho màn Tổng quan kiểu analytics.
 *
 * Ý đồ: chủ đầu tư mở một màn là biết bộ phận nào đang đuối và AI trong bộ phận
 * đó đang kéo lùi, không phải mở bảy báo cáo rồi tự ghép.
 *
 * Ba nguyên tắc khi thêm cột mới vào đây:
 *
 *  1. MỖI CỘT PHẢI QUY ĐƯỢC VỀ MỘT NGƯỜI. Số liệu không gắn được với ai thì
 *     đưa lên `headline` của bộ phận, tuyệt đối không bịa cách chia đều.
 *  2. ĐIỂM LÀ TƯƠNG ĐỐI TRONG BỘ PHẬN, không phải điểm tuyệt đối. Người dẫn
 *     đầu mỗi cột được 100. Không có mốc chuẩn ngành nào được cài cứng ở đây —
 *     muốn mốc tuyệt đối thì phải khai KpiTarget rồi tính riêng.
 *  3. KHÔNG SO NGƯỜI KHÁC BỘ PHẬN. Một bác sĩ và một telesale không có thang
 *     chung; gộp lại chỉ ra con số vô nghĩa.
 */

export interface ScoreColumn {
  key: string;
  label: string;
  /** đ = tiền, % = tỉ lệ, phút, giờ, số */
  unit?: "đ" | "%" | "phút" | "giờ" | "số";
  /** Cao hơn là tốt hơn? (ca huỷ, phút chờ thì ngược lại) */
  goodHigh: boolean;
  /** Trọng số khi tính điểm. Bỏ trống = cột chỉ để xem, không tính điểm. */
  weight?: number;
  /**
   * Chỉ dùng cho cột "càng thấp càng tốt". Mặc định số 0 nghĩa là TỐT NHẤT
   * (0 sự cố, 0 ca huỷ, 0 phút đi muộn). Đặt true khi số 0 thực ra là KHÔNG CÓ
   * DỮ LIỆU — ví dụ "phút phản hồi = 0" nghĩa là người đó chưa trả lời tin nào,
   * chứ không phải trả lời tức thì.
   */
  zeroMeansNoData?: boolean;
  hint?: string;
}

export interface ScoreRow {
  key: string;
  name: string;
  sub?: string;
  metrics: Record<string, number>;
  /** 0–100 so với người dẫn đầu bộ phận; null khi bộ phận chưa có số liệu. */
  score?: number | null;
}

export interface HeadlineStat {
  label: string;
  value: number;
  unit?: "đ" | "%" | "phút" | "giờ" | "số";
  tone?: "good" | "bad" | "neutral";
  hint?: string;
}

export interface Department {
  key: string;
  name: string;
  icon: string;
  subtitle: string;
  /** Nhãn cột đầu tiên: "Nhân sự" hoặc "Kênh". */
  entityLabel: string;
  headline: HeadlineStat[];
  columns: ScoreColumn[];
  rows: ScoreRow[];
  /** Cảnh báo riêng của bộ phận — thứ cần xử lý ngay. */
  alerts: Array<{ level: "ok" | "wr" | "dg"; text: string }>;
  /** Câu giải thích khi bộ phận chưa đo được (thiếu dữ liệu, chưa khai báo). */
  note?: string;
}

interface Ctx {
  from: Date;
  to: Date;
  branchIds: string[];
}

/**
 * Chấm điểm tương đối trong nội bộ một bộ phận.
 *
 * Với cột "càng cao càng tốt": điểm = giá trị / giá trị lớn nhất.
 * Với cột "càng thấp càng tốt": điểm = giá trị nhỏ nhất / giá trị.
 * Người chưa phát sinh gì ở cột đó được 0 cho cột đó — không phải 100. Nếu cho
 * 100 thì người ngồi im sẽ đứng đầu bảng "phút phản hồi thấp nhất".
 */
function scoreRows(rows: ScoreRow[], columns: ScoreColumn[], activityKeys: string[]): void {
  const weighted = columns.filter((c) => c.weight && c.weight > 0);

  // Người chưa phát sinh việc nào trong kỳ KHÔNG được chấm điểm.
  //
  // Nếu chấm, họ sẽ ăn trọn điểm ở mọi cột "càng thấp càng tốt" (0 ca huỷ, 0
  // phút đi muộn, 0 lần điều chỉnh kho) và leo lên đầu bảng mà không làm gì —
  // đúng cái kết luận sai mà bảng này sinh ra để tránh.
  const active = rows.filter((r) => activityKeys.some((k) => (r.metrics[k] ?? 0) > 0));
  rows.filter((r) => !active.includes(r)).forEach((r) => (r.score = null));

  if (!weighted.length || !active.length) {
    active.forEach((r) => (r.score = null));
  } else {
    const totalWeight = weighted.reduce((s, c) => s + (c.weight ?? 0), 0);

    for (const row of active) {
      let acc = 0;
      for (const col of weighted) {
        const all = active.map((r) => r.metrics[col.key] ?? 0);
        const v = row.metrics[col.key] ?? 0;
        let norm = 0;

        if (col.goodHigh) {
          // Dẫn đầu được 1, phần còn lại theo tỉ lệ với người dẫn đầu.
          const max = Math.max(...all);
          norm = max > 0 ? v / max : 0;
        } else if (col.zeroMeansNoData) {
          // 0 = chưa có số liệu, không phải điểm tuyệt đối.
          const positives = all.filter((x) => x > 0);
          const min = positives.length ? Math.min(...positives) : 0;
          norm = v > 0 && min > 0 ? min / v : 0;
        } else {
          // 0 = tốt nhất. Tuyến tính: người tệ nhất được 0, người 0 lỗi được 1.
          const max = Math.max(...all);
          norm = max > 0 ? 1 - v / max : 1;
        }

        acc += Math.max(0, Math.min(1, norm)) * (col.weight ?? 0);
      }
      row.score = Math.round((acc / totalWeight) * 100);
    }
  }

  // Người chưa phát sinh xếp cuối, không xen giữa bảng.
  rows.sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
}

/**
 * Nạp nhân sự của một bộ phận.
 *
 * Lấy theo vai trò, NHƯNG cộng thêm những người thực sự có phát sinh trong kỳ
 * dù không mang vai trò đó — thực tế phòng khám nhỏ luôn có người kiêm nhiệm
 * (quản lý cơ sở trả lời hộp thư, kiêm thủ kho). Nếu chỉ lọc theo vai trò thì
 * bảng hiệu suất báo 0 trong khi việc vẫn chạy, và đó là kiểu sai nguy hiểm
 * nhất: nhìn vào tưởng bộ phận chết, thực ra là đo sai người.
 */
async function staffByRole(roleCodes: string[], branchIds: string[], alsoActive: Iterable<string> = []) {
  const extra = [...alsoActive].filter(Boolean);
  return prisma.user.findMany({
    where: {
      status: "ACTIVE",
      branches: { some: { branchId: { in: branchIds } } },
      OR: [
        { roleLinks: { some: { role: { code: { in: roleCodes } } } } },
        ...(extra.length ? [{ id: { in: extra } }] : []),
      ],
    },
    select: {
      id: true,
      name: true,
      roleLinks: { select: { role: { select: { name: true } } } },
    },
  });
}

const pct = (part: number, whole: number): number =>
  whole ? Math.round((part / whole) * 1000) / 10 : 0;

/* ------------------------------------------------------------- MARKETING */

async function marketing(ctx: Ctx): Promise<Department> {
  const [channels, costs, customers, contracts, leadCounts] = await Promise.all([
    prisma.channel.findMany(),
    prisma.campaignCost.findMany({
      where: { date: { gte: ctx.from, lt: ctx.to } },
      include: { campaign: { select: { channelId: true } } },
    }),
    prisma.customer.findMany({
      where: { channelId: { not: null } },
      select: { id: true, channelId: true },
    }),
    prisma.contract.groupBy({
      by: ["customerId"],
      _sum: { total: true, paidAmount: true },
      where: { signedAt: { gte: ctx.from, lt: ctx.to } },
    }),
    prisma.lead.groupBy({
      by: ["channelId"],
      _count: true,
      where: { createdAt: { gte: ctx.from, lt: ctx.to } },
    }),
  ]);

  const chOfCustomer = new Map(customers.map((c) => [c.id, c.channelId]));
  const spent = new Map<string, number>();
  for (const c of costs) {
    const ch = c.campaign?.channelId;
    if (ch) spent.set(ch, (spent.get(ch) ?? 0) + c.amount);
  }
  const collected = new Map<string, number>();
  for (const row of contracts) {
    const ch = chOfCustomer.get(row.customerId);
    if (ch) collected.set(ch, (collected.get(ch) ?? 0) + (row._sum.paidAmount ?? 0));
  }

  const rows: ScoreRow[] = channels
    .map((ch) => {
      const s = spent.get(ch.id) ?? 0;
      const c = collected.get(ch.id) ?? 0;
      const leads = leadCounts.find((l) => l.channelId === ch.id)?._count ?? 0;
      return {
        key: ch.id,
        name: ch.name,
        sub: ch.kind,
        metrics: {
          leads,
          spent: s,
          cpl: leads ? Math.round(s / leads) : 0,
          collected: c,
          roas: s ? Math.round((c / s) * 10) / 10 : 0,
        },
      };
    })
    .filter((r) => r.metrics.leads > 0 || r.metrics.spent > 0 || r.metrics.collected > 0);

  const columns: ScoreColumn[] = [
    { key: "leads", label: "Lead", unit: "số", goodHigh: true, weight: 1 },
    { key: "spent", label: "Chi phí", unit: "đ", goodHigh: false },
    { key: "cpl", label: "Giá / lead", unit: "đ", goodHigh: false, weight: 2, zeroMeansNoData: true },
    { key: "collected", label: "Thực thu", unit: "đ", goodHigh: true, weight: 2 },
    { key: "roas", label: "ROAS", goodHigh: true, weight: 3, hint: "Thực thu ÷ chi phí" },
  ];
  // Kênh không tốn đồng quảng cáo nào (khách cũ giới thiệu) không có CPL lẫn
  // ROAS — chấm điểm chung với kênh chạy ads sẽ dìm oan nó xuống đáy bảng.
  const paid = rows.filter((r) => r.metrics.spent > 0);
  scoreRows(paid, columns, ["leads", "spent", "collected"]);
  rows.filter((r) => r.metrics.spent === 0).forEach((r) => (r.score = null));
  rows.sort((a, b) => (b.score ?? -1) - (a.score ?? -1));

  const totalSpent = [...spent.values()].reduce((s, v) => s + v, 0);
  const totalCollected = [...collected.values()].reduce((s, v) => s + v, 0);
  const totalLeads = leadCounts.reduce((s, l) => s + l._count, 0);

  const alerts: Department["alerts"] = [];
  for (const r of rows) {
    if (r.metrics.spent > 0 && r.metrics.roas < 1) {
      alerts.push({ level: "dg", text: `${r.name}: ROAS ${r.metrics.roas}x — đang lỗ tiền quảng cáo` });
    }
  }
  if (rows.some((r) => r.metrics.leads > 0 && r.metrics.spent === 0)) {
    alerts.push({
      level: "wr",
      text: "Có kênh chưa nhập chi phí quảng cáo — ROAS của kênh đó chưa tính được",
    });
  }

  return {
    key: "MARKETING",
    name: "Marketing",
    icon: "📣",
    subtitle: "Đồng quảng cáo nào đẻ ra tiền",
    entityLabel: "Kênh",
    headline: [
      { label: "Chi phí quảng cáo", value: totalSpent, unit: "đ" },
      { label: "Lead thu về", value: totalLeads, unit: "số" },
      {
        label: "Giá mỗi lead",
        value: totalLeads ? Math.round(totalSpent / totalLeads) : 0,
        unit: "đ",
      },
      {
        label: "ROAS toàn kênh",
        value: totalSpent ? Math.round((totalCollected / totalSpent) * 10) / 10 : 0,
        tone: totalSpent && totalCollected / totalSpent >= 3 ? "good" : totalSpent ? "bad" : "neutral",
        hint: "Tính trên tiền THỰC THU, không phải doanh số ký",
      },
    ],
    columns,
    rows,
    alerts,
    note: rows.length ? undefined : "Chưa có lead hay chi phí nào trong kỳ.",
  };
}

/* -------------------------------------------------------------- TELESALE */

async function telesale(ctx: Ctx): Promise<Department> {
  const slowMinutes = await getSettingNumber("inbox.slowReplyMinutes");

  const [leads, messages] = await Promise.all([
    prisma.lead.findMany({
      where: { createdAt: { gte: ctx.from, lt: ctx.to } },
      select: { assignedToId: true, firstContactAt: true, convertedCustomerId: true },
    }),
    prisma.chatMessage.findMany({
      where: {
        createdAt: { gte: ctx.from, lt: ctx.to },
        conversation: { branchId: { in: ctx.branchIds } },
      },
      orderBy: { createdAt: "asc" },
      select: {
        conversationId: true,
        direction: true,
        senderUserId: true,
        createdAt: true,
      },
    }),
  ]);

  const users = await staffByRole(
    ["TELESALE"],
    ctx.branchIds,
    // Ai đã thực sự trả lời khách hoặc đang giữ lead thì phải có tên trong bảng,
    // kể cả khi vai trò chính của họ không phải telesale.
    [
      ...messages.filter((m) => m.direction === "OUT").map((m) => m.senderUserId ?? ""),
      ...leads.map((l) => l.assignedToId ?? ""),
    ]
  );

  // Ghép tin khách gửi với tin trả lời kế tiếp trong cùng hội thoại — cùng cách
  // tính với /reports/response-time để hai màn không bao giờ lệch nhau.
  const byConv = new Map<string, typeof messages>();
  for (const m of messages) byConv.set(m.conversationId, [...(byConv.get(m.conversationId) ?? []), m]);

  const replyTotal = new Map<string, number>();
  const replyCount = new Map<string, number>();
  const slowCount = new Map<string, number>();
  let unanswered = 0;

  for (const [, list] of byConv) {
    for (let i = 0; i < list.length; i++) {
      if (list[i].direction !== "IN") continue;
      if (i > 0 && list[i - 1].direction === "IN") continue;
      const reply = list.slice(i + 1).find((m) => m.direction === "OUT");
      if (!reply) {
        unanswered++;
        continue;
      }
      const minutes = Math.round((reply.createdAt.getTime() - list[i].createdAt.getTime()) / 60000);
      const u = reply.senderUserId;
      if (!u) continue;
      replyTotal.set(u, (replyTotal.get(u) ?? 0) + minutes);
      replyCount.set(u, (replyCount.get(u) ?? 0) + 1);
      if (minutes > slowMinutes) slowCount.set(u, (slowCount.get(u) ?? 0) + 1);
    }
  }

  const sentCount = new Map<string, number>();
  for (const m of messages) {
    if (m.direction === "OUT" && m.senderUserId) {
      sentCount.set(m.senderUserId, (sentCount.get(m.senderUserId) ?? 0) + 1);
    }
  }

  const rows: ScoreRow[] = users.map((u) => {
    const mine = leads.filter((l) => l.assignedToId === u.id);
    const contacted = mine.filter((l) => l.firstContactAt).length;
    const converted = mine.filter((l) => l.convertedCustomerId).length;
    const rc = replyCount.get(u.id) ?? 0;
    return {
      key: u.id,
      name: u.name,
      sub: u.roleLinks.map((r) => r.role.name).join(" · "),
      metrics: {
        leads: mine.length,
        contacted,
        contactRate: pct(contacted, mine.length),
        replies: rc,
        avgMinutes: rc ? Math.round((replyTotal.get(u.id) ?? 0) / rc) : 0,
        slowReplies: slowCount.get(u.id) ?? 0,
        messages: sentCount.get(u.id) ?? 0,
        converted,
        convRate: pct(converted, mine.length),
      },
    };
  });

  const columns: ScoreColumn[] = [
    { key: "leads", label: "Lead nhận", unit: "số", goodHigh: true },
    { key: "contactRate", label: "Đã liên hệ", unit: "%", goodHigh: true, weight: 2 },
    { key: "replies", label: "Lượt trả lời", unit: "số", goodHigh: true, weight: 1 },
    {
      key: "avgMinutes",
      label: "TB phản hồi",
      unit: "phút",
      goodHigh: false,
      weight: 3,
      zeroMeansNoData: true,
      hint: "Từ lúc khách nhắn tới lúc có người trả lời",
    },
    { key: "slowReplies", label: `Chậm > ${slowMinutes}p`, unit: "số", goodHigh: false, weight: 1 },
    { key: "convRate", label: "Lead → khách", unit: "%", goodHigh: true, weight: 3 },
  ];
  scoreRows(rows, columns, ["leads", "replies", "messages"]);

  const totalReplies = [...replyCount.values()].reduce((s, v) => s + v, 0);
  const totalMinutes = [...replyTotal.values()].reduce((s, v) => s + v, 0);
  const totalSlow = [...slowCount.values()].reduce((s, v) => s + v, 0);

  const alerts: Department["alerts"] = [];
  if (unanswered > 0) {
    alerts.push({ level: "dg", text: `${unanswered} tin khách chưa ai trả lời` });
  }
  const idle = rows.filter((r) => r.metrics.leads > 0 && r.metrics.contacted === 0);
  for (const r of idle) {
    alerts.push({ level: "wr", text: `${r.name} nhận ${r.metrics.leads} lead nhưng chưa liên hệ ai` });
  }

  return {
    key: "TELESALE",
    name: "Telesale · Hộp thư",
    icon: "💬",
    subtitle: "Ai trả lời khách nhanh, ai để khách nguội",
    entityLabel: "Nhân sự",
    headline: [
      { label: "Lượt trả lời", value: totalReplies, unit: "số" },
      {
        label: "TB phản hồi",
        value: totalReplies ? Math.round(totalMinutes / totalReplies) : 0,
        unit: "phút",
        tone: totalReplies && totalMinutes / totalReplies <= 15 ? "good" : totalReplies ? "bad" : "neutral",
      },
      { label: `Trả lời chậm > ${slowMinutes}p`, value: totalSlow, unit: "số", tone: totalSlow ? "bad" : "good" },
      { label: "Chưa ai trả lời", value: unanswered, unit: "số", tone: unanswered ? "bad" : "good" },
    ],
    columns,
    rows,
    alerts,
    note: users.length ? undefined : "Chưa có tài khoản nào mang vai trò Telesale.",
  };
}

/* ------------------------------------------------------- TƯ VẤN & CHỐT HĐ */

async function sales(ctx: Ctx): Promise<Department> {
  const [users, contracts, assigned] = await Promise.all([
    staffByRole(["TU_VAN_VIEN", "QUAN_LY_CO_SO"], ctx.branchIds),
    prisma.contract.groupBy({
      by: ["consultantId"],
      _sum: { total: true, paidAmount: true },
      _count: true,
      where: { branchId: { in: ctx.branchIds }, signedAt: { gte: ctx.from, lt: ctx.to } },
    }),
    prisma.customer.groupBy({
      by: ["assignedToId"],
      _count: true,
      where: { createdAt: { gte: ctx.from, lt: ctx.to }, hidden: false },
    }),
  ]);

  const rows: ScoreRow[] = users.map((u) => {
    const c = contracts.find((x) => x.consultantId === u.id);
    const won = c?._count ?? 0;
    const mine = assigned.find((x) => x.assignedToId === u.id)?._count ?? 0;
    const signed = c?._sum.total ?? 0;
    const collected = c?._sum.paidAmount ?? 0;
    return {
      key: u.id,
      name: u.name,
      sub: u.roleLinks.map((r) => r.role.name).join(" · "),
      metrics: {
        assigned: mine,
        contracts: won,
        closeRate: pct(won, mine),
        signed,
        collected,
        collectRate: pct(collected, signed),
        avgDeal: won ? Math.round(signed / won) : 0,
      },
    };
  });

  const columns: ScoreColumn[] = [
    { key: "assigned", label: "Khách được giao", unit: "số", goodHigh: true },
    { key: "contracts", label: "Hợp đồng", unit: "số", goodHigh: true, weight: 1 },
    { key: "closeRate", label: "Tỉ lệ chốt", unit: "%", goodHigh: true, weight: 3 },
    { key: "signed", label: "Doanh số ký", unit: "đ", goodHigh: true, weight: 1 },
    { key: "collected", label: "Thực thu", unit: "đ", goodHigh: true, weight: 3 },
    {
      key: "collectRate",
      label: "Đã thu / đã ký",
      unit: "%",
      goodHigh: true,
      weight: 2,
      hint: "Ký nhiều mà không thu được tiền thì chưa phải bán được",
    },
    { key: "avgDeal", label: "TB / hợp đồng", unit: "đ", goodHigh: true },
  ];
  scoreRows(rows, columns, ["assigned", "contracts", "signed"]);

  const totalSigned = contracts.reduce((s, c) => s + (c._sum.total ?? 0), 0);
  const totalCollected = contracts.reduce((s, c) => s + (c._sum.paidAmount ?? 0), 0);
  const totalContracts = contracts.reduce((s, c) => s + c._count, 0);

  const alerts: Department["alerts"] = [];
  const unattributed = contracts.find((c) => !c.consultantId);
  if (unattributed) {
    alerts.push({
      level: "wr",
      text: `${unattributed._count} hợp đồng không ghi tư vấn viên — không tính hoa hồng được`,
    });
  }
  for (const r of rows) {
    if (r.metrics.signed > 0 && r.metrics.collectRate < 30) {
      alerts.push({
        level: "wr",
        text: `${r.name} ký ${Math.round(r.metrics.signed / 1e6)}tr nhưng mới thu ${r.metrics.collectRate}%`,
      });
    }
  }

  return {
    key: "SALES",
    name: "Tư vấn · Chốt hợp đồng",
    icon: "🤝",
    subtitle: "Ai mang tiền thật về, không chỉ ký giấy",
    entityLabel: "Nhân sự",
    headline: [
      { label: "Doanh số ký", value: totalSigned, unit: "đ" },
      { label: "Tiền thực thu", value: totalCollected, unit: "đ", tone: "good" },
      { label: "Hợp đồng", value: totalContracts, unit: "số" },
      {
        label: "Đã thu / đã ký",
        value: pct(totalCollected, totalSigned),
        unit: "%",
        tone: pct(totalCollected, totalSigned) >= 50 ? "good" : "bad",
      },
    ],
    columns,
    rows,
    alerts,
    note: users.length ? undefined : "Chưa có tài khoản nào mang vai trò Tư vấn viên.",
  };
}

/* ---------------------------------------------------------------- LỄ TÂN */

async function reception(ctx: Ctx): Promise<Department> {
  const [users, visits, appointments] = await Promise.all([
    staffByRole(["LE_TAN"], ctx.branchIds),
    prisma.visit.findMany({
      where: { branchId: { in: ctx.branchIds }, checkedInAt: { gte: ctx.from, lt: ctx.to } },
      select: {
        receptionistId: true,
        checkedInAt: true,
        calledAt: true,
        finishedAt: true,
        status: true,
      },
    }),
    prisma.appointment.groupBy({
      by: ["status"],
      _count: true,
      where: { branchId: { in: ctx.branchIds }, startAt: { gte: ctx.from, lt: ctx.to } },
    }),
  ]);

  const rows: ScoreRow[] = users.map((u) => {
    const mine = visits.filter((v) => v.receptionistId === u.id);
    const waits = mine.filter((v) => v.calledAt).map((v) => (v.calledAt!.getTime() - v.checkedInAt.getTime()) / 60000);
    const done = mine.filter((v) => v.status === VisitStatus.DONE).length;
    return {
      key: u.id,
      name: u.name,
      sub: u.roleLinks.map((r) => r.role.name).join(" · "),
      metrics: {
        checkIns: mine.length,
        avgWait: waits.length ? Math.round(waits.reduce((s, w) => s + w, 0) / waits.length) : 0,
        longWaits: waits.filter((w) => w > 30).length,
        done,
        doneRate: pct(done, mine.length),
      },
    };
  });

  const columns: ScoreColumn[] = [
    { key: "checkIns", label: "Lượt tiếp đón", unit: "số", goodHigh: true, weight: 2 },
    { key: "avgWait", label: "Chờ trung bình", unit: "phút", goodHigh: false, weight: 3, zeroMeansNoData: true },
    { key: "longWaits", label: "Chờ > 30 phút", unit: "số", goodHigh: false, weight: 2 },
    { key: "doneRate", label: "Hoàn tất lượt", unit: "%", goodHigh: true, weight: 1 },
  ];
  scoreRows(rows, columns, ["checkIns"]);

  const totalAppt = appointments.reduce((s, a) => s + a._count, 0);
  const noShow = appointments.find((a) => a.status === AppointmentStatus.NO_SHOW)?._count ?? 0;
  const allWaits = visits.filter((v) => v.calledAt).map((v) => (v.calledAt!.getTime() - v.checkedInAt.getTime()) / 60000);
  const waiting = visits.filter((v) => v.status === VisitStatus.WAITING).length;

  const alerts: Department["alerts"] = [];
  if (waiting > 0) alerts.push({ level: "wr", text: `${waiting} khách đang ngồi chờ chưa được gọi` });
  if (pct(noShow, totalAppt) > 15) {
    alerts.push({ level: "dg", text: `Vắng hẹn ${pct(noShow, totalAppt)}% — cần nhắc lịch trước 24h` });
  }
  const orphan = visits.filter((v) => !v.receptionistId).length;
  if (orphan > 0) {
    alerts.push({
      level: "wr",
      text: `${orphan} lượt tiếp đón chưa ghi lễ tân (dữ liệu tạo trước bản cập nhật) — không quy về ai được`,
    });
  }

  return {
    key: "RECEPTION",
    name: "Lễ tân · Tiếp đón",
    icon: "🛎️",
    subtitle: "Khách phải chờ bao lâu trước khi có người gọi",
    entityLabel: "Nhân sự",
    headline: [
      { label: "Lượt tiếp đón", value: visits.length, unit: "số" },
      {
        label: "Chờ trung bình",
        value: allWaits.length ? Math.round(allWaits.reduce((s, w) => s + w, 0) / allWaits.length) : 0,
        unit: "phút",
        tone: allWaits.length && allWaits.reduce((s, w) => s + w, 0) / allWaits.length <= 15 ? "good" : "bad",
      },
      { label: "Đang chờ", value: waiting, unit: "số", tone: waiting ? "bad" : "good" },
      { label: "Vắng hẹn", value: pct(noShow, totalAppt), unit: "%", tone: pct(noShow, totalAppt) > 15 ? "bad" : "good" },
    ],
    columns,
    rows,
    alerts,
  };
}

/* ------------------------------------------------------ BÁC SĨ · PHÒNG MỔ */

async function doctors(ctx: Ctx): Promise<Department> {
  const [users, procedures, appointments] = await Promise.all([
    staffByRole(["BAC_SI"], ctx.branchIds),
    prisma.procedureRecord.findMany({
      where: { branchId: { in: ctx.branchIds }, scheduledAt: { gte: ctx.from, lt: ctx.to } },
      select: { surgeonId: true, status: true, durationMin: true, checklist: true, scheduledAt: true },
    }),
    prisma.appointment.groupBy({
      by: ["doctorId"],
      _count: true,
      where: { branchId: { in: ctx.branchIds }, startAt: { gte: ctx.from, lt: ctx.to } },
    }),
  ]);

  const rows: ScoreRow[] = users.map((u) => {
    const mine = procedures.filter((p) => p.surgeonId === u.id);
    const done = mine.filter((p) => p.status === ProcedureStatus.COMPLETED);
    const cancelled = mine.filter((p) => p.status === ProcedureStatus.CANCELLED).length;
    const minutes = done.reduce((s, p) => s + p.durationMin, 0);
    return {
      key: u.id,
      name: u.name,
      sub: u.roleLinks.map((r) => r.role.name).join(" · "),
      metrics: {
        scheduled: mine.length,
        completed: done.length,
        completeRate: pct(done.length, mine.length),
        cancelled,
        hours: Math.round((minutes / 60) * 10) / 10,
        appointments: appointments.find((a) => a.doctorId === u.id)?._count ?? 0,
      },
    };
  });

  const columns: ScoreColumn[] = [
    { key: "scheduled", label: "Ca được xếp", unit: "số", goodHigh: true },
    { key: "completed", label: "Ca hoàn thành", unit: "số", goodHigh: true, weight: 3 },
    { key: "completeRate", label: "Tỉ lệ hoàn thành", unit: "%", goodHigh: true, weight: 2 },
    { key: "cancelled", label: "Ca huỷ", unit: "số", goodHigh: false, weight: 2 },
    { key: "hours", label: "Giờ phòng mổ", unit: "giờ", goodHigh: true, weight: 1 },
    { key: "appointments", label: "Lịch hẹn phụ trách", unit: "số", goodHigh: true },
  ];
  scoreRows(rows, columns, ["scheduled", "appointments"]);

  const allDone = procedures.filter((p) => p.status === ProcedureStatus.COMPLETED);
  const totalMinutes = allDone.reduce((s, p) => s + p.durationMin, 0);
  // Mốc công suất: 8 giờ mổ/ngày, đúng mốc đang dùng ở /clinic-operations.
  const days = Math.max(1, Math.round((ctx.to.getTime() - ctx.from.getTime()) / 86400000));
  const utilization = Math.min(100, Math.round((totalMinutes / (days * 8 * 60)) * 100));

  const alerts: Department["alerts"] = [];
  const noChecklist = procedures.filter(
    (p) => p.status !== ProcedureStatus.CANCELLED && !p.checklist
  ).length;
  if (noChecklist > 0) {
    alerts.push({ level: "dg", text: `${noChecklist} ca chưa có checklist tiền phẫu` });
  }
  const unassigned = procedures.filter((p) => !p.surgeonId).length;
  if (unassigned > 0) alerts.push({ level: "wr", text: `${unassigned} ca chưa gán bác sĩ mổ` });

  return {
    key: "DOCTORS",
    name: "Bác sĩ · Phòng mổ",
    icon: "🩺",
    subtitle: "Ai mổ nhiều, ai hay bị huỷ ca",
    entityLabel: "Nhân sự",
    headline: [
      { label: "Ca hoàn thành", value: allDone.length, unit: "số" },
      { label: "Giờ phòng mổ", value: Math.round((totalMinutes / 60) * 10) / 10, unit: "giờ" },
      {
        label: "Công suất phòng mổ",
        value: utilization,
        unit: "%",
        tone: utilization >= 60 ? "good" : "neutral",
        hint: "Mốc 8 giờ mổ mỗi ngày = 100%",
      },
      {
        label: "Ca huỷ",
        value: procedures.filter((p) => p.status === ProcedureStatus.CANCELLED).length,
        unit: "số",
        tone: "bad",
      },
    ],
    columns,
    rows,
    alerts,
  };
}

/* ------------------------------------------------------------ ĐIỀU DƯỠNG */

async function nurses(ctx: Ctx): Promise<Department> {
  const periodKeys = monthKeysBetween(ctx.from, ctx.to);
  const [users, attendance, kpis] = await Promise.all([
    staffByRole(["DIEU_DUONG"], ctx.branchIds),
    prisma.attendance.groupBy({
      by: ["userId"],
      _count: true,
      _sum: { workedMinutes: true, lateMinutes: true },
      where: { branchId: { in: ctx.branchIds }, date: { gte: ctx.from, lt: ctx.to } },
    }),
    prisma.kpiActual.findMany({
      where: { periodKey: { in: periodKeys }, definition: { group: "NURSING" } },
      include: { definition: { select: { code: true, name: true, higherIsBetter: true } } },
    }),
  ]);

  const rows: ScoreRow[] = users.map((u) => {
    const a = attendance.find((x) => x.userId === u.id);
    const mine = kpis.filter((k) => k.userId === u.id);
    const metrics: Record<string, number> = {
      shifts: a?._count ?? 0,
      hours: Math.round(((a?._sum.workedMinutes ?? 0) / 60) * 10) / 10,
      lateMinutes: a?._sum.lateMinutes ?? 0,
    };
    for (const k of mine) metrics[`kpi_${k.definition.code}`] = k.actualValue;
    return { key: u.id, name: u.name, sub: u.roleLinks.map((r) => r.role.name).join(" · "), metrics };
  });

  const kpiCols = [...new Map(kpis.map((k) => [k.definition.code, k.definition])).values()];
  const columns: ScoreColumn[] = [
    { key: "shifts", label: "Ca trực", unit: "số", goodHigh: true, weight: 2 },
    { key: "hours", label: "Giờ công", unit: "giờ", goodHigh: true, weight: 2 },
    { key: "lateMinutes", label: "Phút đi muộn", unit: "phút", goodHigh: false, weight: 1 },
    ...kpiCols.map((d) => ({
      key: `kpi_${d.code}`,
      label: d.name,
      goodHigh: d.higherIsBetter,
      weight: 2,
    })),
  ];
  scoreRows(rows, columns, ["shifts", "hours"]);

  const totalShifts = attendance.reduce((s, a) => s + a._count, 0);
  const alerts: Department["alerts"] = [];
  if (!kpiCols.length) {
    alerts.push({
      level: "wr",
      text: "Chưa khai chỉ tiêu KPI nhóm điều dưỡng — bảng này mới chấm được chuyên cần",
    });
  }

  return {
    key: "NURSES",
    name: "Điều dưỡng",
    icon: "💉",
    subtitle: "Chuyên cần và chỉ tiêu chuyên môn",
    entityLabel: "Nhân sự",
    headline: [
      { label: "Ca trực đã chấm", value: totalShifts, unit: "số" },
      {
        label: "Tổng giờ công",
        value: Math.round((attendance.reduce((s, a) => s + (a._sum.workedMinutes ?? 0), 0) / 60) * 10) / 10,
        unit: "giờ",
      },
      {
        label: "Phút đi muộn",
        value: attendance.reduce((s, a) => s + (a._sum.lateMinutes ?? 0), 0),
        unit: "phút",
        tone: "bad",
      },
      { label: "Chỉ tiêu đang theo dõi", value: kpiCols.length, unit: "số" },
    ],
    columns,
    rows,
    alerts,
    note: totalShifts ? undefined : "Chưa có dữ liệu chấm công trong kỳ.",
  };
}

/* ------------------------------------------------------- KẾ TOÁN · THU NGÂN */

async function finance(ctx: Ctx): Promise<Department> {
  const [payments, debts] = await Promise.all([
    prisma.payment.groupBy({
      by: ["receivedById", "method"],
      _sum: { amount: true },
      _count: true,
      where: { branchId: { in: ctx.branchIds }, paidAt: { gte: ctx.from, lt: ctx.to } },
    }),
    prisma.contract.aggregate({
      _sum: { total: true, paidAmount: true },
      where: { branchId: { in: ctx.branchIds }, status: "ACTIVE" },
    }),
  ]);

  const users = await staffByRole(
    ["KE_TOAN"],
    ctx.branchIds,
    payments.map((p) => p.receivedById ?? "")
  );

  const rows: ScoreRow[] = users.map((u) => {
    const mine = payments.filter((p) => p.receivedById === u.id);
    const cash = mine.filter((p) => p.method === "CASH").reduce((s, p) => s + (p._sum.amount ?? 0), 0);
    return {
      key: u.id,
      name: u.name,
      sub: u.roleLinks.map((r) => r.role.name).join(" · "),
      metrics: {
        receipts: mine.reduce((s, p) => s + p._count, 0),
        collected: mine.reduce((s, p) => s + (p._sum.amount ?? 0), 0),
        cash,
      },
    };
  });

  const columns: ScoreColumn[] = [
    { key: "receipts", label: "Phiếu thu", unit: "số", goodHigh: true, weight: 1 },
    { key: "collected", label: "Tiền đã thu", unit: "đ", goodHigh: true, weight: 3 },
    { key: "cash", label: "Trong đó tiền mặt", unit: "đ", goodHigh: true, hint: "Càng nhiều càng phải đối soát kỹ" },
  ];
  scoreRows(rows, columns, ["receipts", "collected"]);

  const outstanding = (debts._sum.total ?? 0) - (debts._sum.paidAmount ?? 0);
  const alerts: Department["alerts"] = [];
  if (outstanding > 0) {
    alerts.push({ level: "wr", text: `Công nợ hợp đồng đang hiệu lực: ${Math.round(outstanding / 1e6)} triệu` });
  }
  const unattributed = payments.filter((p) => !p.receivedById).reduce((s, p) => s + p._count, 0);
  if (unattributed > 0) {
    alerts.push({ level: "wr", text: `${unattributed} phiếu thu không ghi người thu — không đối soát được` });
  }

  return {
    key: "FINANCE",
    name: "Kế toán · Thu ngân",
    icon: "🧾",
    subtitle: "Tiền vào quỹ và công nợ còn treo",
    entityLabel: "Nhân sự",
    headline: [
      { label: "Tiền đã thu", value: payments.reduce((s, p) => s + (p._sum.amount ?? 0), 0), unit: "đ", tone: "good" },
      { label: "Số phiếu thu", value: payments.reduce((s, p) => s + p._count, 0), unit: "số" },
      { label: "Công nợ còn treo", value: outstanding, unit: "đ", tone: outstanding ? "bad" : "good" },
      {
        label: "Tiền mặt",
        value: payments.filter((p) => p.method === "CASH").reduce((s, p) => s + (p._sum.amount ?? 0), 0),
        unit: "đ",
      },
    ],
    columns,
    rows,
    alerts,
  };
}

/* -------------------------------------------------------------------- KHO */

async function warehouse(ctx: Ctx): Promise<Department> {
  const expiringDays = await getSettingNumber("inventory.expiringSoonDays");
  const [movements, lots, products] = await Promise.all([
    prisma.stockMovement.findMany({
      where: {
        createdAt: { gte: ctx.from, lt: ctx.to },
        warehouse: { branchId: { in: ctx.branchIds } },
      },
      // StockMovement không lưu giá vốn; lấy qua lô để tính giá trị huỷ.
      select: { actorId: true, type: true, quantity: true, lot: { select: { unitCost: true } } },
    }),
    prisma.stockLot.findMany({
      where: { warehouse: { branchId: { in: ctx.branchIds } }, quantity: { gt: 0 } },
      select: { quantity: true, unitCost: true, expiryDate: true },
    }),
    prisma.product.findMany({
      where: { active: true },
      select: { minStock: true, maxStock: true, lots: { select: { quantity: true } } },
    }),
  ]);

  // Quản lý cơ sở kiêm thủ kho ở quy mô đầu — bút toán của họ phải hiện ở đây.
  const users = await staffByRole(
    ["KHO", "QUAN_LY_CO_SO"],
    ctx.branchIds,
    movements.map((m) => m.actorId ?? "")
  );

  const rows: ScoreRow[] = users.map((u) => {
    const mine = movements.filter((m) => m.actorId === u.id);
    return {
      key: u.id,
      name: u.name,
      sub: u.roleLinks.map((r) => r.role.name).join(" · "),
      metrics: {
        moves: mine.length,
        receipts: mine.filter((m) => m.type === "IN").length,
        issues: mine.filter((m) => m.type === "OUT").length,
        adjusts: mine.filter((m) => m.type === "ADJUST").length,
        disposed: mine
          .filter((m) => m.type === "DISPOSE")
          .reduce((s, m) => s + Math.abs(m.quantity) * (m.lot?.unitCost ?? 0), 0),
      },
    };
  });

  const columns: ScoreColumn[] = [
    { key: "moves", label: "Bút toán", unit: "số", goodHigh: true, weight: 1 },
    { key: "receipts", label: "Lượt nhập", unit: "số", goodHigh: true },
    { key: "issues", label: "Lượt xuất", unit: "số", goodHigh: true },
    {
      key: "adjusts",
      label: "Điều chỉnh",
      unit: "số",
      goodHigh: false,
      weight: 2,
      hint: "Điều chỉnh nhiều = đếm sai nhiều lần, không phải làm nhiều",
    },
    { key: "disposed", label: "Giá trị huỷ", unit: "đ", goodHigh: false, weight: 2 },
  ];
  scoreRows(rows, columns, ["moves"]);

  const now = Date.now();
  const expired = lots.filter((l) => l.expiryDate && l.expiryDate.getTime() < now);
  const expiring = lots.filter(
    (l) =>
      l.expiryDate &&
      l.expiryDate.getTime() >= now &&
      l.expiryDate.getTime() - now < expiringDays * 86400000
  );
  const belowMin = products.filter((p) => {
    const onHand = p.lots.reduce((s, l) => s + l.quantity, 0);
    return p.minStock > 0 && onHand < p.minStock;
  }).length;

  const alerts: Department["alerts"] = [];
  if (expired.length) {
    alerts.push({ level: "dg", text: `${expired.length} lô đã hết hạn còn nằm trong kho` });
  }
  if (expiring.length) {
    alerts.push({ level: "wr", text: `${expiring.length} lô sẽ hết hạn trong ${expiringDays} ngày` });
  }
  if (belowMin) alerts.push({ level: "wr", text: `${belowMin} vật tư dưới định mức tối thiểu` });

  return {
    key: "WAREHOUSE",
    name: "Kho vật tư",
    icon: "📦",
    subtitle: "Giá trị tồn và rủi ro hết hạn",
    entityLabel: "Nhân sự",
    headline: [
      { label: "Giá trị tồn", value: lots.reduce((s, l) => s + l.quantity * l.unitCost, 0), unit: "đ" },
      { label: "Dưới định mức", value: belowMin, unit: "số", tone: belowMin ? "bad" : "good" },
      { label: `Cận hạn ${expiringDays} ngày`, value: expiring.length, unit: "số", tone: expiring.length ? "bad" : "good" },
      { label: "Đã hết hạn", value: expired.length, unit: "số", tone: expired.length ? "bad" : "good" },
    ],
    columns,
    rows,
    alerts,
  };
}

/** Danh sách periodKey "YYYY-MM" phủ hết khoảng thời gian của kỳ báo cáo. */
function monthKeysBetween(from: Date, to: Date): string[] {
  const keys: string[] = [];
  const cur = new Date(from.getFullYear(), from.getMonth(), 1);
  while (cur < to) {
    keys.push(`${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, "0")}`);
    cur.setMonth(cur.getMonth() + 1);
  }
  return keys;
}

export async function buildDepartments(ctx: Ctx): Promise<Department[]> {
  return Promise.all([
    marketing(ctx),
    telesale(ctx),
    sales(ctx),
    reception(ctx),
    doctors(ctx),
    nurses(ctx),
    finance(ctx),
    warehouse(ctx),
  ]);
}
