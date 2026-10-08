import { prisma } from "./prisma";
import { BUSINESS_TZ } from "./datetime";
import type { BranchScope } from "./report-scope";
import { nullableBranchWhere } from "./report-scope";

// F35: BÁO CÁO HIỆU SUẤT NHÂN VIÊN TRÊN PANCAKE.
//
// Đọc các ô số liệu đã kéo về (bảng pancake_agent_stats) và gom thành ba cách
// xem mà phòng khám cần:
//
//   1. THEO NHÂN VIÊN — số tin đã xử lý, tốc độ phản hồi trung bình, số hội
//      thoại, số SĐT lấy được.
//   2. THEO NỀN TẢNG / KÊNH — Facebook, Instagram, TikTok, Zalo và từng trang.
//   3. THEO NGÀY và THEO GIỜ — để thấy ngày nào đuối, giờ nào khách chờ lâu.
//
// MỘT QUY ƯỚC QUAN TRỌNG VỀ TỐC ĐỘ PHẢN HỒI:
//
// Pancake trả về trung bình theo từng ô giờ (miligiây), KHÔNG trả về tổng thời
// gian. Nên trung bình của cả kỳ phải tính CÓ TRỌNG SỐ theo số tin trong ô đó —
// cộng rồi chia đều số ô sẽ cho một giờ chỉ có 1 tin cùng sức nặng với giờ có
// 200 tin. Ô nào Pancake trả 0 thì coi là KHÔNG ĐO ĐƯỢC (không phải trả lời tức
// thì) và bị loại khỏi phép tính trung bình — nhưng số tin của ô đó vẫn được
// cộng vào cột "tin đã xử lý".

export interface AgentRow {
  pancakeUserId: string;
  /** Tên bên Pancake. */
  name: string;
  /** Tài khoản CRM đã gắn (null = chưa gắn, số liệu vẫn hiện theo tên Pancake). */
  userId: string | null;
  userName: string | null;
  /** Tin hộp thư + bình luận đã xử lý. */
  messages: number;
  inboxCount: number;
  commentCount: number;
  /** Số hội thoại riêng biệt đã trả lời. */
  conversations: number;
  privateReplyCount: number;
  phones: number;
  /** Trung bình có trọng số, GIÂY. null = kỳ này Pancake không đo được. */
  avgResponseSeconds: number | null;
}

export interface GroupRow {
  key: string;
  label: string;
  messages: number;
  inboxCount: number;
  commentCount: number;
  conversations: number;
  phones: number;
  avgResponseSeconds: number | null;
  /** Số nhân viên có số liệu trong nhóm. */
  agents: number;
}

export interface DayRow {
  dayKey: string;
  messages: number;
  conversations: number;
  phones: number;
  avgResponseSeconds: number | null;
  agents: number;
}

export interface HourRow {
  /** 0 đến 23, GIỜ VIỆT NAM. */
  hour: number;
  messages: number;
  avgResponseSeconds: number | null;
}

export interface PancakeAgentReport {
  from: string;
  to: string;
  totals: {
    messages: number;
    inboxCount: number;
    commentCount: number;
    conversations: number;
    phones: number;
    avgResponseSeconds: number | null;
    agents: number;
  };
  agents: AgentRow[];
  platforms: GroupRow[];
  pages: GroupRow[];
  days: DayRow[];
  hours: HourRow[];
  /** Nhân viên Pancake có số liệu nhưng chưa gắn tài khoản CRM. */
  unmappedAgents: number;
  /** Lần kéo số liệu gần nhất của các trang trong phạm vi xem. */
  lastSyncAt: string | null;
  /** Trang đang bật nhưng chưa kéo được số liệu lần nào. */
  pagesNeverSynced: string[];
}

/** Bộ tích luỹ: tổng tin + tổng (trung bình × trọng số) để chia lại sau. */
interface Acc {
  messages: number;
  inboxCount: number;
  commentCount: number;
  conversations: number;
  phones: number;
  privateReplyCount: number;
  /** Tổng (avgResponseMs × trọng số) của các ô ĐO ĐƯỢC. */
  responseWeighted: number;
  /** Tổng trọng số của các ô đo được. */
  responseWeight: number;
  agents: Set<string>;
}

const blank = (): Acc => ({
  messages: 0,
  inboxCount: 0,
  commentCount: 0,
  conversations: 0,
  phones: 0,
  privateReplyCount: 0,
  responseWeighted: 0,
  responseWeight: 0,
  agents: new Set(),
});

interface StatRow {
  pancakeUserId: string;
  inboxCount: number;
  commentCount: number;
  uniqueInboxCount: number;
  uniqueCommentCount: number;
  privateReplyCount: number;
  phoneNumberCount: number;
  avgResponseMs: number;
}

function add(a: Acc, row: StatRow): void {
  const handled = row.inboxCount + row.commentCount;
  a.messages += handled;
  a.inboxCount += row.inboxCount;
  a.commentCount += row.commentCount;
  a.conversations += row.uniqueInboxCount + row.uniqueCommentCount;
  a.privateReplyCount += row.privateReplyCount;
  a.phones += row.phoneNumberCount;
  // Trọng số là số tin đã xử lý trong ô; ô không có tin thì trung bình của nó
  // không đại diện cho gì cả.
  if (row.avgResponseMs > 0 && handled > 0) {
    a.responseWeighted += row.avgResponseMs * handled;
    a.responseWeight += handled;
  }
  a.agents.add(row.pancakeUserId);
}

function bump(map: Map<string, Acc>, key: string, row: StatRow): void {
  const a = map.get(key) ?? blank();
  add(a, row);
  map.set(key, a);
}

/** Trung bình có trọng số, đổi ms sang giây. null = không ô nào đo được. */
function avgSeconds(a: Acc): number | null {
  if (a.responseWeight <= 0) return null;
  return Math.round(a.responseWeighted / a.responseWeight / 1000);
}

function groupRow(key: string, label: string, a: Acc): GroupRow {
  return {
    key,
    label,
    messages: a.messages,
    inboxCount: a.inboxCount,
    commentCount: a.commentCount,
    conversations: a.conversations,
    phones: a.phones,
    avgResponseSeconds: avgSeconds(a),
    agents: a.agents.size,
  };
}

/**
 * Dựng báo cáo cho khoảng [from, to) theo giờ Việt Nam, giới hạn theo cơ sở của
 * người xem (trang Pancake chưa gán cơ sở là dữ liệu chung — xem nullableBranchWhere).
 */
export async function buildPancakeAgentReport(
  range: { from: Date; to: Date },
  scope: BranchScope
): Promise<PancakeAgentReport> {
  const pages = await prisma.pancakePage.findMany({
    where: { active: true, ...nullableBranchWhere("branchId", scope) },
    select: { id: true, pageId: true, name: true, platform: true, configId: true, statsSyncAt: true },
  });
  const pageById = new Map(pages.map((p) => [p.id, p]));

  const empty: PancakeAgentReport = {
    from: range.from.toISOString(),
    to: range.to.toISOString(),
    totals: { messages: 0, inboxCount: 0, commentCount: 0, conversations: 0, phones: 0, avgResponseSeconds: null, agents: 0 },
    agents: [],
    platforms: [],
    pages: [],
    days: [],
    hours: [],
    unmappedAgents: 0,
    lastSyncAt: null,
    pagesNeverSynced: pages.filter((p) => !p.statsSyncAt).map((p) => p.name),
  };
  if (!pages.length) return empty;

  const stats = await prisma.pancakeAgentStat.findMany({
    where: { pageId: { in: pages.map((p) => p.id) }, hour: { gte: range.from, lt: range.to } },
    select: {
      pageId: true,
      pancakeUserId: true,
      hour: true,
      dayKey: true,
      inboxCount: true,
      commentCount: true,
      uniqueInboxCount: true,
      uniqueCommentCount: true,
      privateReplyCount: true,
      phoneNumberCount: true,
      avgResponseMs: true,
    },
  });

  const syncTimes = pages.map((p) => p.statsSyncAt).filter((d): d is Date => Boolean(d));
  const lastSyncAt = syncTimes.length ? new Date(Math.max(...syncTimes.map((d) => d.getTime()))).toISOString() : null;
  if (!stats.length) return { ...empty, lastSyncAt };

  const byAgent = new Map<string, Acc>();
  const byPlatform = new Map<string, Acc>();
  const byPage = new Map<string, Acc>();
  const byDay = new Map<string, Acc>();
  const byHour = new Map<string, Acc>();
  const all = blank();

  for (const s of stats) {
    const page = pageById.get(s.pageId);
    if (!page) continue;
    bump(byAgent, s.pancakeUserId, s);
    bump(byPlatform, page.platform, s);
    bump(byPage, s.pageId, s);
    bump(byDay, s.dayKey, s);
    // Giờ trong CSDL là UTC; báo cáo "giờ nào đông khách" phải theo giờ VN.
    bump(byHour, String(vnHourOf(s.hour)), s);
    add(all, s);
  }

  const agentIds = [...byAgent.keys()];
  const agentRows = agentIds.length
    ? await prisma.pancakeAgent.findMany({
        where: { pancakeUserId: { in: agentIds }, configId: { in: [...new Set(pages.map((p) => p.configId))] } },
        select: { pancakeUserId: true, name: true, userId: true, user: { select: { id: true, name: true } } },
      })
    : [];
  const agentById = new Map(agentRows.map((a) => [a.pancakeUserId, a]));

  const agents: AgentRow[] = agentIds
    .map((uid) => {
      const a = byAgent.get(uid)!;
      const meta = agentById.get(uid);
      return {
        pancakeUserId: uid,
        name: meta?.name ?? "Nhân viên chưa dò tên",
        userId: meta?.userId ?? null,
        userName: meta?.user?.name ?? null,
        messages: a.messages,
        inboxCount: a.inboxCount,
        commentCount: a.commentCount,
        conversations: a.conversations,
        privateReplyCount: a.privateReplyCount,
        phones: a.phones,
        avgResponseSeconds: avgSeconds(a),
      };
    })
    .sort((x, y) => y.messages - x.messages || x.name.localeCompare(y.name, "vi"));

  const PLATFORM_LABEL: Record<string, string> = {
    FACEBOOK: "Facebook",
    INSTAGRAM: "Instagram",
    TIKTOK: "TikTok",
    ZALO: "Zalo",
  };

  return {
    from: range.from.toISOString(),
    to: range.to.toISOString(),
    totals: {
      messages: all.messages,
      inboxCount: all.inboxCount,
      commentCount: all.commentCount,
      conversations: all.conversations,
      phones: all.phones,
      avgResponseSeconds: avgSeconds(all),
      agents: all.agents.size,
    },
    agents,
    platforms: [...byPlatform.entries()]
      .map(([k, a]) => groupRow(k, PLATFORM_LABEL[k] ?? k, a))
      .sort((x, y) => y.messages - x.messages),
    pages: [...byPage.entries()]
      .map(([k, a]) => {
        const p = pageById.get(k);
        return groupRow(k, p ? `${p.name} · ${PLATFORM_LABEL[p.platform] ?? p.platform}` : k, a);
      })
      .sort((x, y) => y.messages - x.messages),
    days: [...byDay.entries()]
      .map(([dayKey, a]) => ({
        dayKey,
        messages: a.messages,
        conversations: a.conversations,
        phones: a.phones,
        avgResponseSeconds: avgSeconds(a),
        agents: a.agents.size,
      }))
      .sort((x, y) => x.dayKey.localeCompare(y.dayKey)),
    hours: [...byHour.entries()]
      .map(([h, a]) => ({ hour: Number(h), messages: a.messages, avgResponseSeconds: avgSeconds(a) }))
      .sort((x, y) => x.hour - y.hour),
    unmappedAgents: agents.filter((a) => !a.userId).length,
    lastSyncAt,
    pagesNeverSynced: pages.filter((p) => !p.statsSyncAt).map((p) => p.name),
  };
}

const hourFmt = new Intl.DateTimeFormat("en-GB", { timeZone: BUSINESS_TZ, hour: "2-digit", hour12: false });

/** Giờ trong ngày (0-23) theo giờ nghiệp vụ (Việt Nam) của một mốc UTC. */
function vnHourOf(d: Date): number {
  const h = Number(hourFmt.format(d));
  return Number.isFinite(h) ? h % 24 : 0;
}
