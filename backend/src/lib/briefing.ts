import { prisma } from "./prisma";
import { logger } from "./logger";
import { getSettingBool, getSettingNumber } from "./settings-catalog";
import { AI_MODELS, callAiLogged, getAiClient } from "./ai";
import { registerJob } from "./jobs";
import { notifyUsers, usersWithRoles } from "./notify";
import { formatVnd, startOfVnDay, vnDayKey } from "./datetime";
import { DAY_MS, totalShowups, vnPeriodKey } from "./metrics";
import { endOfDay, forecast } from "./analytics";
import { REAL_MONEY } from "./report-scope";
import { RoleCode } from "./rbac-catalog";
import {
  AppointmentStatus,
  ApprovalStatus,
  BriefingSource,
  ReengageDraftStatus,
  TaskStatus,
} from "../types/enums";

// AI6: BẢN TIN SÁNG CHO QUẢN LÝ.
//
// Từ giờ ai.briefingHour (mặc định 7h00 giờ VN), mỗi ngày một lần cho mỗi phạm
// vi (toàn hệ thống + từng cơ sở):
//   1. Gom SỐ LIỆU TỔNG của hôm qua và tháng này (lib/analytics endOfDay, forecast,
//      lib/metrics). Chỉ là con số: không tên khách, không SĐT, không nội dung chat.
//   2. Có AI thì model CHEAP viết đoạn tóm tắt từ đúng các con số đó; AI chưa cấu
//      hình hoặc lỗi thì dùng bản số liệu thuần (không bao giờ bỏ trống).
//   3. Lưu ManagerBriefing, hiện ở trang chủ giám đốc, quản lý, và gửi thông báo.

export const BRIEFING_JOB = "ai6-manager-briefing";
export const ALL_SCOPE = "ALL";

const BRIEFING_SYSTEM = `Bạn là trợ lý điều hành của một phòng khám thẩm mỹ nội khoa. Viết BẢN TIN SÁNG ngắn cho giám đốc, quản lý từ bảng số liệu JSON.
Luật:
- Tiếng Việt, tối đa 6 câu hoặc gạch đầu dòng ngắn, không dùng gạch ngang dài.
- Chỉ dùng đúng các con số được cung cấp, không bịa thêm số, không suy diễn nguyên nhân chắc chắn.
- Nêu 2 đến 3 điểm đáng chú ý (tốt và cần xử lý) và 1 đến 2 việc nên làm hôm nay.
- Tiền viết dạng 12.500.000đ. Không nêu tên người.`;

export interface BriefingMetrics {
  scope: string;
  day: string;
  newMessages: number;
  phones: number;
  depositBookings: number;
  showups: number;
  collected: number;
  payments: number;
  noShows: number;
  appointmentsToday: number;
  overdueTasks: number;
  pendingDiscountApprovals: number;
  pendingReengageDrafts: number;
  medicalFlags24h: number;
  month: {
    periodKey: string;
    actual: number;
    forecast: number;
    target: number | null;
    progressPercent: number | null;
    vsPrevPercent: number | null;
  };
}

/** Số liệu tổng của một phạm vi. Không có trường nào chứa tên, SĐT hay nội dung của khách. */
export async function collectBriefingMetrics(opts: { now: Date; branchIds: string[]; scopeLabel: string }): Promise<BriefingMetrics> {
  const { now, branchIds } = opts;
  const todayStart = startOfVnDay(now);
  const yStart = new Date(todayStart.getTime() - DAY_MS);
  const yesterday = { gte: yStart, lt: todayStart };
  const today = { gte: todayStart, lt: new Date(todayStart.getTime() + DAY_MS) };
  const inBranch = { branchId: { in: branchIds } };

  const [eod, showups, paid, noShows, apptsToday, overdueTasks, discounts, drafts, medical, f] = await Promise.all([
    endOfDay({ date: yStart, branchIds, now }),
    totalShowups(yesterday, branchIds),
    prisma.payment.aggregate({ where: { ...inBranch, paidAt: yesterday, ...REAL_MONEY }, _sum: { amount: true }, _count: true }),
    prisma.appointment.count({ where: { ...inBranch, startAt: yesterday, status: AppointmentStatus.NO_SHOW } }),
    prisma.appointment.count({ where: { ...inBranch, startAt: today, status: { notIn: [AppointmentStatus.CANCELLED] } } }),
    prisma.task.count({ where: { ...inBranch, status: { in: [TaskStatus.OPEN, TaskStatus.IN_PROGRESS] }, dueAt: { lt: todayStart } } }),
    prisma.quotation.count({ where: { ...inBranch, approvalStatus: ApprovalStatus.PENDING } }),
    prisma.reengageDraft.count({ where: { ...inBranch, status: ReengageDraftStatus.PENDING } }),
    prisma.conversation.count({ where: { ...inBranch, medicalFlag: true, medicalFlagAt: { gte: new Date(now.getTime() - DAY_MS) } } }),
    forecast({ periodKey: vnPeriodKey(now), branchIds, now }),
  ]);
  const sum = (k: "newMessages" | "phones" | "depositBookings") => eod.reduce((s, r) => s + r[k], 0);
  return {
    scope: opts.scopeLabel,
    day: vnDayKey(yStart),
    newMessages: sum("newMessages"),
    phones: sum("phones"),
    depositBookings: sum("depositBookings"),
    showups,
    collected: paid._sum.amount ?? 0,
    payments: paid._count,
    noShows,
    appointmentsToday: apptsToday,
    overdueTasks,
    pendingDiscountApprovals: discounts,
    pendingReengageDrafts: drafts,
    medicalFlags24h: medical,
    month: {
      periodKey: f.periodKey,
      actual: f.actual,
      forecast: f.forecast,
      target: f.target,
      progressPercent: f.progressPercent,
      vsPrevPercent: f.vsPrevPercent,
    },
  };
}

/** Bản số liệu thuần: dùng khi AI chưa cấu hình, bị tắt hoặc lỗi. */
export function fallbackBriefing(m: BriefingMetrics): string {
  const pct = (v: number | null) => (v == null ? "chưa đặt chỉ tiêu" : `${v}%`);
  return [
    `Bản tin sáng ${m.scope}, số liệu ngày ${m.day.split("-").reverse().join("/")}:`,
    `- Tin nhắn mới ${m.newMessages}, SĐT thu được ${m.phones}, lịch có cọc ${m.depositBookings}, khách đến ${m.showups}, không đến ${m.noShows}.`,
    `- Thực thu ${formatVnd(m.collected)}đ (${m.payments} phiếu).`,
    `- Hôm nay có ${m.appointmentsToday} lịch hẹn. Việc quá hạn ${m.overdueTasks}, báo giá chờ duyệt giảm ${m.pendingDiscountApprovals}, nháp chăm lại chờ duyệt ${m.pendingReengageDrafts}, hội thoại gắn cờ y khoa 24 giờ qua ${m.medicalFlags24h}.`,
    `- Tháng ${m.month.periodKey}: đã thu ${formatVnd(m.month.actual)}đ, dự báo ${formatVnd(m.month.forecast)}đ, tiến độ chỉ tiêu ${pct(m.month.progressPercent)}.`,
  ].join("\n");
}

/** Lời nhắn gửi AI: chỉ JSON số liệu (tách riêng để test kiểm không lộ thông tin cá nhân). */
export function briefingPrompt(m: BriefingMetrics): string {
  return `Số liệu (JSON):\n${JSON.stringify(m)}`;
}

export async function composeBriefing(m: BriefingMetrics, branchId: string | null): Promise<{ content: string; source: BriefingSource; model: string | null }> {
  if (getAiClient() && (await getSettingBool("ai.briefingEnabled"))) {
    try {
      const res = await callAiLogged({
        customerId: null,
        branchId,
        purpose: "AI6 bản tin sáng cho quản lý (chỉ số liệu tổng)",
        request: { model: AI_MODELS.CHEAP, maxTokens: 600, system: BRIEFING_SYSTEM, messages: [{ role: "user", content: briefingPrompt(m) }] },
      });
      const text = res.text.trim().replace(/\s*—\s*/g, ", ");
      if (text) return { content: text.slice(0, 3000), source: BriefingSource.AI, model: res.model };
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, "[ai6] AI lỗi, dùng bản số liệu thuần");
    }
  }
  return { content: fallbackBriefing(m), source: BriefingSource.FALLBACK, model: null };
}

/** Giờ hiện tại theo giờ Việt Nam (0..23). */
export function vnHour(now: Date): number {
  return Math.floor((now.getTime() - startOfVnDay(now).getTime()) / 3_600_000);
}

export async function runMorningBriefing(now: Date, opts: { force?: boolean } = {}): Promise<{ created: number; message: string }> {
  const hour = Math.round(await getSettingNumber("ai.briefingHour"));
  if (!opts.force && vnHour(now) < hour) return { created: 0, message: `Chưa tới ${hour}h00 giờ Việt Nam` };
  const dayKey = vnDayKey(now);
  const branches = await prisma.branch.findMany({ where: { active: true }, select: { id: true, name: true }, orderBy: { createdAt: "asc" } });
  if (!branches.length) return { created: 0, message: "Chưa có cơ sở" };
  const scopes = [
    { scopeKey: ALL_SCOPE, branchId: null as string | null, branchIds: branches.map((b) => b.id), label: "toàn hệ thống" },
    ...(branches.length > 1 ? branches.map((b) => ({ scopeKey: b.id, branchId: b.id as string | null, branchIds: [b.id], label: b.name })) : []),
  ];
  let created = 0;
  const sources: string[] = [];
  for (const s of scopes) {
    const exists = await prisma.managerBriefing.findUnique({ where: { dayKey_scopeKey: { dayKey, scopeKey: s.scopeKey } } });
    if (exists) continue;
    const metrics = await collectBriefingMetrics({ now, branchIds: s.branchIds, scopeLabel: s.label });
    const out = await composeBriefing(metrics, s.branchId);
    try {
      await prisma.managerBriefing.create({
        data: { dayKey, scopeKey: s.scopeKey, branchId: s.branchId, source: out.source, content: out.content, metricsJson: JSON.stringify(metrics), model: out.model },
      });
    } catch {
      continue; // tiến trình khác vừa tạo xong
    }
    created++;
    sources.push(out.source);
    const recipients =
      s.scopeKey === ALL_SCOPE
        ? await usersWithRoles([RoleCode.GIAM_DOC, RoleCode.QUAN_LY_HE_THONG], null)
        : await usersWithRoles([RoleCode.QUAN_LY_CO_SO], s.branchId);
    await notifyUsers(
      recipients.map((u) => u.id),
      { title: `Bản tin sáng ${s.label} ${dayKey.split("-").reverse().join("/")}`, body: out.content, link: "/" }
    );
  }
  return { created, message: created ? `Tạo ${created} bản tin (${sources.join(", ")})` : "Bản tin hôm nay đã có" };
}

let registered = false;
export function registerBriefingJob(): void {
  if (registered) return;
  registered = true;
  registerJob({
    key: BRIEFING_JOB,
    label: "AI6: bản tin sáng cho quản lý (7h00)",
    intervalMs: 10 * 60_000,
    lockMs: 30 * 60_000,
    settingKey: "ai.briefingEnabled",
    run: ({ now }) => runMorningBriefing(now),
  });
}
