import { prisma } from "../lib/prisma";
import { logger } from "../lib/logger";
import { normalizeName } from "../lib/text";
import { startOfVnDay, vnDayKey, BUSINESS_TZ } from "../lib/datetime";
import { UserStatus } from "../types/enums";
import {
  fetchPageUsers,
  fetchUserStatistics,
  parsePancakeTime,
  resolvePageToken,
  type PancakeUserStatBucket,
} from "./pancake";

// F35: KÉO THỐNG KÊ NHÂN VIÊN TỪ PANCAKE (mỗi 10 phút).
//
// VÌ SAO KHÔNG TỰ ĐẾM TRONG CRM: nhân viên trả lời khách ngay trong app Pancake
// (điện thoại, trình duyệt), CRM chỉ có bản sao tin nhắn và KHÔNG biết ai bấm
// gửi. Pancake thì biết — nên số tin đã xử lý và tốc độ phản hồi lấy thẳng từ
// GET /pages/{page_id}/statistics/users, còn CRM chỉ lưu lại và gom báo cáo.
//
// Ba điều phải nhớ khi sửa tệp này:
//
//   1. GHI BẰNG UPSERT theo (trang, nhân viên, mốc giờ). Kéo lại cùng khoảng
//      thời gian phải RA CÙNG MỘT CON SỐ, không được cộng dồn — mỗi 10 phút
//      chạy một lần thì cùng một giờ sẽ được kéo lại nhiều lần.
//   2. CỬA SỔ KÉO phủ cả hôm qua: chạy lúc 00h05 mà chỉ kéo "hôm nay" thì
//      những giờ cuối của hôm qua sẽ chốt bằng số dở dang.
//   3. `date_range` tính theo GIỜ VIỆT NAM (giờ địa phương của trang), nhưng mốc
//      `hour` Pancake trả về là UTC+0. Đừng trộn hai thứ.

/** Số ngày trước hôm nay cũng kéo lại để chốt số (mặc định 1 = gồm hôm qua). */
const LOOKBACK_DAYS = Math.max(0, Number(process.env.PANCAKE_STATS_LOOKBACK_DAYS ?? 1));
/** Giới hạn Pancake 5 lượt/trang/giây — nghỉ giữa các trang cho chắc. */
const PACE_MS = Number(process.env.PANCAKE_PACE_MS ?? 220);
const DAY_MS = 86_400_000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const rangeFmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: BUSINESS_TZ,
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

/** Một mốc thời gian -> "08/10/2026 14:30:00" theo giờ Việt Nam. */
function vnStamp(d: Date): string {
  const parts = rangeFmt.formatToParts(d);
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? "00";
  return `${get("day")}/${get("month")}/${get("year")} ${get("hour")}:${get("minute")}:${get("second")}`;
}

/**
 * Chuỗi `date_range` Pancake đòi: "DD/MM/YYYY HH:MM:SS - DD/MM/YYYY HH:MM:SS",
 * tính theo giờ Việt Nam. Khoảng đóng ở hai đầu, nên mốc cuối là 23:59:59.
 */
export function pancakeDateRange(fromDay: Date, toDay: Date): string {
  const start = startOfVnDay(fromDay);
  const end = new Date(startOfVnDay(toDay).getTime() + DAY_MS - 1000);
  return `${vnStamp(start)} - ${vnStamp(end)}`;
}

/** Cửa sổ kéo mặc định: từ LOOKBACK_DAYS ngày trước tới hết hôm nay (giờ VN). */
export function defaultStatsWindow(now: Date = new Date()): { from: Date; to: Date; dateRange: string } {
  const to = startOfVnDay(now);
  const from = new Date(to.getTime() - LOOKBACK_DAYS * DAY_MS);
  return { from, to, dateRange: pancakeDateRange(from, to) };
}

interface StatFields {
  inboxCount: number;
  commentCount: number;
  uniqueInboxCount: number;
  uniqueCommentCount: number;
  privateReplyCount: number;
  phoneNumberCount: number;
  avgResponseMs: number;
}

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
};

function fieldsOf(b: PancakeUserStatBucket): StatFields {
  return {
    inboxCount: num(b.inbox_count),
    commentCount: num(b.comment_count),
    uniqueInboxCount: num(b.unique_inbox_count),
    uniqueCommentCount: num(b.unique_comment_count),
    privateReplyCount: num(b.private_reply_count),
    phoneNumberCount: num(b.phone_number_count),
    avgResponseMs: num(b.average_response_time),
  };
}

const isEmpty = (f: StatFields): boolean =>
  f.inboxCount === 0 &&
  f.commentCount === 0 &&
  f.uniqueInboxCount === 0 &&
  f.uniqueCommentCount === 0 &&
  f.privateReplyCount === 0 &&
  f.phoneNumberCount === 0 &&
  f.avgResponseMs === 0;

const same = (a: StatFields, b: StatFields): boolean =>
  a.inboxCount === b.inboxCount &&
  a.commentCount === b.commentCount &&
  a.uniqueInboxCount === b.uniqueInboxCount &&
  a.uniqueCommentCount === b.uniqueCommentCount &&
  a.privateReplyCount === b.privateReplyCount &&
  a.phoneNumberCount === b.phoneNumberCount &&
  a.avgResponseMs === b.avgResponseMs;

export interface PageRef {
  id: string;
  pageId: string;
  name: string;
  configId: string;
  pageAccessTokenEnc: string | null;
}

export interface StatsSyncResult {
  pages: number;
  buckets: number;
  agents: number;
  errors: string[];
}

/**
 * Kéo thống kê nhân viên của MỘT trang và ghi vào CSDL.
 *
 * Chỉ ghi những ô ĐÃ ĐỔI: sau lần đầu, trong cửa sổ hai ngày thường chỉ giờ
 * hiện tại còn thay đổi, nên mỗi 10 phút chỉ còn một hai câu UPDATE thay vì
 * hàng nghìn (SQLite chỉ một luồng ghi).
 */
export async function syncPageAgentStats(
  page: PageRef,
  opts: { dateRange: string; from: Date; to: Date }
): Promise<{ buckets: number; agentNames: Map<string, string> }> {
  const token = await resolvePageToken(page);
  if (!token) throw new Error("Chưa lấy được token trang");

  const stats = await fetchUserStatistics(token, page.pageId, opts.dateRange);

  // Tên nhân viên Pancake trả kèm — dùng để cập nhật danh sách nhân viên.
  const agentNames = new Map<string, string>();
  for (const [uid, u] of Object.entries(stats.users)) {
    if (u?.user_name) agentNames.set(uid, String(u.user_name));
  }

  const windowFrom = opts.from;
  const windowTo = new Date(startOfVnDay(opts.to).getTime() + DAY_MS);
  const existing = await prisma.pancakeAgentStat.findMany({
    where: { pageId: page.id, hour: { gte: windowFrom, lt: windowTo } },
    select: {
      id: true,
      pancakeUserId: true,
      hour: true,
      inboxCount: true,
      commentCount: true,
      uniqueInboxCount: true,
      uniqueCommentCount: true,
      privateReplyCount: true,
      phoneNumberCount: true,
      avgResponseMs: true,
    },
  });
  const keyOf = (uid: string, hour: Date): string => `${uid}|${hour.getTime()}`;
  const known = new Map(existing.map((r) => [keyOf(r.pancakeUserId, r.hour), r]));

  const toCreate: Array<StatFields & { pageId: string; pancakeUserId: string; hour: Date; dayKey: string }> = [];
  const toUpdate: Array<{ id: string; data: StatFields }> = [];

  for (const [uid, buckets] of Object.entries(stats.statistics)) {
    if (!Array.isArray(buckets)) continue;
    for (const b of buckets) {
      if (!b?.hour) continue;
      const hour = parsePancakeTime(b.hour);
      if (hour < windowFrom || hour >= windowTo) continue;
      const f = fieldsOf(b);
      const prev = known.get(keyOf(uid, hour));
      if (prev) {
        if (!same(prev, f)) toUpdate.push({ id: prev.id, data: f });
        continue;
      }
      // Ô rỗng chưa có trong CSDL thì không cần lưu: báo cáo coi thiếu là 0.
      if (isEmpty(f)) continue;
      toCreate.push({ pageId: page.id, pancakeUserId: uid, hour, dayKey: vnDayKey(hour), ...f });
    }
  }

  if (toCreate.length) await prisma.pancakeAgentStat.createMany({ data: toCreate });
  for (const u of toUpdate) await prisma.pancakeAgentStat.update({ where: { id: u.id }, data: u.data });
  await prisma.pancakePage.update({ where: { id: page.id }, data: { statsSyncAt: new Date() } });

  return { buckets: toCreate.length + toUpdate.length, agentNames };
}

/**
 * Cập nhật danh sách nhân viên Pancake của một kết nối và TỰ GẮN với tài khoản
 * CRM khi tên khớp duy nhất (bỏ dấu, không phân biệt hoa thường).
 *
 * Không tự gắn khi tên trùng hai người trở lên trong CRM: gắn sai thì số của
 * người này nhảy sang bảng lương của người kia, nên để quản trị chọn tay.
 * Người đã gắn tay thì KHÔNG bao giờ bị ghi đè.
 */
export async function upsertAgents(
  configId: string,
  people: Array<{ pancakeUserId: string; name: string; fbId?: string | null; active?: boolean }>
): Promise<number> {
  if (!people.length) return 0;

  const users = await prisma.user.findMany({
    where: { status: UserStatus.ACTIVE },
    select: { id: true, name: true },
  });
  const byName = new Map<string, string[]>();
  for (const u of users) {
    const k = normalizeName(u.name);
    if (!k) continue;
    byName.set(k, [...(byName.get(k) ?? []), u.id]);
  }

  let touched = 0;
  for (const p of people) {
    const name = p.name?.trim() || "Nhân viên Pancake";
    const existing = await prisma.pancakeAgent.findUnique({
      where: { configId_pancakeUserId: { configId, pancakeUserId: p.pancakeUserId } },
    });
    const matched = byName.get(normalizeName(name) ?? "");
    const autoUserId = matched && matched.length === 1 ? matched[0] : null;

    if (existing) {
      await prisma.pancakeAgent.update({
        where: { id: existing.id },
        data: {
          name,
          ...(p.fbId ? { fbId: String(p.fbId) } : {}),
          ...(p.active !== undefined ? { active: p.active } : {}),
          // Chưa gắn ai thì thử gắn theo tên; đã gắn rồi thì giữ nguyên.
          ...(existing.userId ? {} : autoUserId ? { userId: autoUserId } : {}),
        },
      });
    } else {
      await prisma.pancakeAgent.create({
        data: {
          configId,
          pancakeUserId: p.pancakeUserId,
          name,
          fbId: p.fbId ? String(p.fbId) : null,
          active: p.active ?? true,
          userId: autoUserId,
        },
      });
    }
    touched++;
  }
  return touched;
}

/** Dò nhân viên của mọi trang đang bật trong một kết nối. */
export async function discoverAgents(configId: string): Promise<{ found: number; errors: string[] }> {
  const config = await prisma.pancakeConfig.findUniqueOrThrow({
    where: { id: configId },
    include: { pages: { where: { active: true } } },
  });

  const people = new Map<string, { pancakeUserId: string; name: string; fbId?: string | null; active: boolean }>();
  const errors: string[] = [];
  for (const page of config.pages) {
    try {
      await sleep(PACE_MS);
      const token = await resolvePageToken(page);
      if (!token) throw new Error("Chưa lấy được token trang");
      const { users, disabledUsers } = await fetchPageUsers(token, page.pageId);
      for (const u of users) {
        if (!u?.id) continue;
        people.set(String(u.id), { pancakeUserId: String(u.id), name: u.name ?? "", fbId: u.fb_id ?? null, active: true });
      }
      for (const u of disabledUsers) {
        if (!u?.id || people.has(String(u.id))) continue;
        people.set(String(u.id), { pancakeUserId: String(u.id), name: u.name ?? "", fbId: u.fb_id ?? null, active: false });
      }
    } catch (err) {
      errors.push(`${page.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const found = await upsertAgents(configId, [...people.values()]);
  return { found, errors };
}

/** Khoá chống chạy chồng trong tiến trình (ngoài khoá của bộ chạy tác vụ). */
const running = new Set<string>();

export function isStatsSyncRunning(configId: string): boolean {
  return running.has(configId);
}

/** Kéo thống kê cho MỘT kết nối Pancake. */
export async function syncConfigStats(configId: string, now: Date = new Date()): Promise<StatsSyncResult> {
  if (running.has(configId)) return { pages: 0, buckets: 0, agents: 0, errors: ["Đang kéo số liệu, chờ lượt trước"] };
  running.add(configId);
  try {
    const config = await prisma.pancakeConfig.findUniqueOrThrow({
      where: { id: configId },
      include: { pages: { where: { active: true } } },
    });
    if (!config.active) return { pages: 0, buckets: 0, agents: 0, errors: ["Kết nối đã tắt"] };

    const window = defaultStatsWindow(now);
    const errors: string[] = [];
    const names = new Map<string, string>();
    let buckets = 0;
    let pages = 0;

    for (const page of config.pages) {
      try {
        await sleep(PACE_MS);
        const r = await syncPageAgentStats(page, window);
        buckets += r.buckets;
        pages++;
        for (const [uid, name] of r.agentNames) if (name) names.set(uid, name);
      } catch (err) {
        errors.push(`${page.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Tên nhân viên lấy luôn từ chính phản hồi thống kê: không cần gọi thêm
    // /users mỗi 10 phút, mà bảng nhân viên vẫn đủ tên để báo cáo đọc được.
    const agents = await upsertAgents(
      configId,
      [...names.entries()].map(([pancakeUserId, name]) => ({ pancakeUserId, name }))
    );

    return { pages, buckets, agents, errors };
  } finally {
    running.delete(configId);
  }
}

/** Kéo thống kê cho MỌI kết nối đang bật. Bộ chạy tác vụ nền gọi hàm này. */
export async function syncAllPancakeStats(now: Date = new Date()): Promise<StatsSyncResult> {
  const configs = await prisma.pancakeConfig.findMany({ where: { active: true }, select: { id: true, label: true } });
  const total: StatsSyncResult = { pages: 0, buckets: 0, agents: 0, errors: [] };
  for (const c of configs) {
    try {
      const r = await syncConfigStats(c.id, now);
      total.pages += r.pages;
      total.buckets += r.buckets;
      total.agents += r.agents;
      total.errors.push(...r.errors.map((e) => `${c.label}: ${e}`));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      total.errors.push(`${c.label}: ${message}`);
      logger.warn({ err: message, configId: c.id }, "[pancake] kéo thống kê lỗi");
    }
  }
  return total;
}
