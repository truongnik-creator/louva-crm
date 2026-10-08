import { prisma } from "../lib/prisma";
import { logger } from "../lib/logger";
import { normalizeName } from "../lib/text";
import { startOfVnDay, vnDayKey, BUSINESS_TZ } from "../lib/datetime";
import { MessageDirection, UserStatus } from "../types/enums";
import { encryptNullable } from "../lib/crypto";
import {
  fetchAllPageBuckets,
  fetchPages,
  fetchUserStatistics,
  normalizePlatform,
  pageTokenOf,
  parseStatHour,
  resolvePageToken,
  resolveToken,
  type PancakePageRaw,
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
//   3. `date_range` GỬI ĐI tính theo giờ Việt Nam (giờ địa phương của trang).
//      Mốc giờ NHẬN VỀ đọc bằng parseStatHour: Pancake trả `hour` theo giờ địa
//      phương và `hour_in_integer` theo UTC. Đừng trộn hai thứ.
//   4. `average_response_time` là GIÂY (tài liệu ghi miligiây là sai).

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

export interface StatsWindow {
  from: Date;
  to: Date;
  dateRange: string;
}

/** Cửa sổ [hôm nay - daysBack, hết hôm nay] theo giờ Việt Nam. */
export function statsWindow(now: Date, daysBack: number): StatsWindow {
  const to = startOfVnDay(now);
  const from = new Date(to.getTime() - Math.max(0, daysBack) * DAY_MS);
  return { from, to, dateRange: pancakeDateRange(from, to) };
}

/** Cửa sổ kéo mặc định mỗi 10 phút: hôm qua + hôm nay. */
export function defaultStatsWindow(now: Date = new Date()): StatsWindow {
  return statsWindow(now, LOOKBACK_DAYS);
}

/**
 * Chia một khoảng dài thành nhiều cửa sổ ngắn, mới nhất trước.
 *
 * Nạp lại 90 ngày bằng MỘT lượt gọi thì phản hồi có thể lên hàng chục nghìn ô
 * cho mỗi trang; chia theo tuần vừa nhẹ bộ nhớ, vừa cho phép nạp dở mà phần đã
 * nạp vẫn dùng được.
 */
export function backfillWindows(now: Date, days: number, chunkDays = 7): StatsWindow[] {
  const out: StatsWindow[] = [];
  const today = startOfVnDay(now);
  for (let offset = 0; offset < Math.max(1, days); offset += chunkDays) {
    const to = new Date(today.getTime() - offset * DAY_MS);
    const span = Math.min(chunkDays - 1, Math.max(0, days - offset - 1));
    const from = new Date(to.getTime() - span * DAY_MS);
    out.push({ from, to, dateRange: pancakeDateRange(from, to) });
  }
  return out;
}

interface StatFields {
  inboxCount: number;
  commentCount: number;
  uniqueInboxCount: number;
  uniqueCommentCount: number;
  privateReplyCount: number;
  phoneNumberCount: number;
  avgResponseSeconds: number;
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
    // Pancake trả GIÂY, không phải miligiây — xem chú thích services/pancake.ts.
    avgResponseSeconds: num(b.average_response_time),
  };
}

const isEmpty = (f: StatFields): boolean =>
  f.inboxCount === 0 &&
  f.commentCount === 0 &&
  f.uniqueInboxCount === 0 &&
  f.uniqueCommentCount === 0 &&
  f.privateReplyCount === 0 &&
  f.phoneNumberCount === 0 &&
  f.avgResponseSeconds === 0;

const same = (a: StatFields, b: StatFields): boolean =>
  a.inboxCount === b.inboxCount &&
  a.commentCount === b.commentCount &&
  a.uniqueInboxCount === b.uniqueInboxCount &&
  a.uniqueCommentCount === b.uniqueCommentCount &&
  a.privateReplyCount === b.privateReplyCount &&
  a.phoneNumberCount === b.phoneNumberCount &&
  a.avgResponseSeconds === b.avgResponseSeconds;

export interface PageRef {
  id: string;
  pageId: string;
  name: string;
  configId: string;
  pageAccessTokenEnc: string | null;
}

/** Lệch giờ của trang so với UTC. Trang Việt Nam là 7. */
const PAGE_TZ_HOURS = 7;

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
      avgResponseSeconds: true,
    },
  });
  const keyOf = (uid: string, hour: Date): string => `${uid}|${hour.getTime()}`;
  const known = new Map(existing.map((r) => [keyOf(r.pancakeUserId, r.hour), r]));

  const toCreate: Array<StatFields & { pageId: string; pancakeUserId: string; hour: Date; dayKey: string }> = [];
  const toUpdate: Array<{ id: string; data: StatFields }> = [];

  for (const [uid, buckets] of Object.entries(stats.statistics)) {
    if (!Array.isArray(buckets)) continue;
    for (const b of buckets) {
      const hour = parseStatHour(b, PAGE_TZ_HOURS);
      if (!hour) continue;
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

/** Gom nhân viên của những trang CRM đã đăng ký từ phản hồi GET /pages. */
function agentsFromPages(
  pages: PancakePageRaw[],
  registered: Set<string>
): Array<{ pancakeUserId: string; name: string; fbId?: string | null; active: boolean }> {
  const people = new Map<string, { pancakeUserId: string; name: string; fbId?: string | null; active: boolean }>();
  for (const p of pages) {
    if (!registered.has(String(p.id))) continue;
    for (const u of p.users ?? []) {
      if (!u?.user_id) continue;
      const active = (u.status ?? "active").toLowerCase() === "active";
      const prev = people.get(String(u.user_id));
      // Một người có thể ở nhiều trang: còn hoạt động ở một trang là còn dùng.
      people.set(String(u.user_id), {
        pancakeUserId: String(u.user_id),
        name: u.name?.trim() || prev?.name || "",
        fbId: u.fb_id ?? prev?.fbId ?? null,
        active: active || Boolean(prev?.active),
      });
    }
  }
  return [...people.values()];
}

export interface DiscoverResult {
  found: number;
  created: number;
  /** Số trang vừa lưu được token riêng. */
  tokens: number;
  agents: number;
  errors: string[];
  /**
   * Kênh Pancake biết nhưng CHƯA KÍCH HOẠT, nên CRM không kéo được gì.
   *
   * Pancake chia trang thành `activated` và `inactivated`; nhóm sau không có
   * page_access_token và API thống kê trả rỗng, nên có nhận vào CRM cũng chỉ
   * là một dòng chết. Nhưng PHẢI nói ra: đã mất một lượt hỏi đi hỏi lại vì
   * "tôi nối 5 kênh mà CRM chỉ thấy 4" — kênh thứ năm là một tài khoản TikTok
   * ở trạng thái chưa kích hoạt. Kích hoạt bên Pancake thì lượt kéo sau tự nhận.
   */
  inactive: Array<{ pageId: string; name: string; platform: string }>;
}

/**
 * Dò trang + token trang + nhân viên của một kết nối, bằng MỘT lượt gọi
 * GET /pages.
 *
 * Phản hồi đó mang sẵn cả ba thứ (xem chú thích đầu services/pancake.ts), nên
 * không cần gọi generate_page_access_token — lệnh ấy vô hiệu token cũ và có thể
 * làm đứt tích hợp khác của phòng khám.
 *
 * Để ở service (không nằm trong route) vì cả route và script vận hành trên máy
 * chủ đều cần chạy nó.
 */
export async function discoverPagesAndAgents(configId: string): Promise<DiscoverResult> {
  const token = await resolveToken(configId);
  if (!token) {
    return { found: 0, created: 0, tokens: 0, agents: 0, errors: ["Kết nối chưa có API token hoặc đã tắt"], inactive: [] };
  }

  const { activated: pages, inactive } = await fetchAllPageBuckets(token);
  let created = 0;
  let tokens = 0;

  for (const p of pages) {
    const platform = normalizePlatform(p.platform);
    const pageToken = pageTokenOf(p);
    const existing = await prisma.pancakePage.findUnique({ where: { pageId: String(p.id) } });
    if (existing) {
      // Token dán tay hay đã lưu thì giữ; chỉ ghi khi đang trống.
      const fresh = pageToken && !existing.pageAccessTokenEnc;
      await prisma.pancakePage.update({
        where: { id: existing.id },
        data: { name: p.name, platform, ...(fresh ? { pageAccessTokenEnc: encryptNullable(pageToken) } : {}) },
      });
      if (fresh) tokens++;
      continue;
    }
    await prisma.pancakePage.create({
      data: {
        configId,
        pageId: String(p.id),
        name: p.name,
        platform,
        pageAccessTokenEnc: pageToken ? encryptNullable(pageToken) : null,
      },
    });
    created++;
    if (pageToken) tokens++;
  }

  const registered = new Set(
    (await prisma.pancakePage.findMany({ where: { configId }, select: { pageId: true } })).map((x) => x.pageId)
  );
  const people = agentsFromPages(pages, registered);
  const agents = await upsertAgents(configId, people);

  return {
    found: pages.length,
    created,
    tokens,
    agents,
    errors: people.length ? [] : ["Pancake không trả nhân viên nào cho các trang đã đăng ký"],
    inactive,
  };
}

/** Chỉ dò lại NHÂN VIÊN (không đụng tới danh sách trang). */
export async function discoverAgents(configId: string): Promise<{ found: number; errors: string[] }> {
  const token = await resolveToken(configId);
  if (!token) return { found: 0, errors: ["Kết nối chưa có API token hoặc đã tắt"] };

  let pages: PancakePageRaw[];
  try {
    pages = await fetchPages(token);
  } catch (err) {
    return { found: 0, errors: [err instanceof Error ? err.message : String(err)] };
  }

  const registered = new Set(
    (await prisma.pancakePage.findMany({ where: { configId }, select: { pageId: true } })).map((x) => x.pageId)
  );
  const people = agentsFromPages(pages, registered);
  const found = await upsertAgents(configId, people);
  return { found, errors: people.length ? [] : ["Pancake không trả nhân viên nào cho các trang đã đăng ký"] };
}

/**
 * Quy lại các tin đã đồng bộ về một nhân viên vừa được gắn tài khoản CRM.
 *
 * VÌ SAO CẦN: `senderUserId` chỉ điền được lúc GHI TIN, mà lúc đó nhân viên có
 * thể chưa gắn tài khoản nào. Thực tế chạy thật: 2.814 tin về trước, 19 nhân
 * viên Pancake chưa ai gắn — nếu không quy lại thì mọi báo cáo của CRM (tốc độ
 * trả lời, bảng điểm bộ phận, lương thưởng) vẫn trống với toàn bộ số cũ, và chỉ
 * đếm từ lúc gắn trở đi.
 *
 * Khớp theo hai đường:
 *   · `pancakeAgentUid` — chính xác, dùng cho tin về sau khi đã có cột này.
 *   · `senderName` — cầu nối MỘT LẦN cho tin đã về trước khi có cột uid.
 *     Pancake ghi tên nhân viên vào `from.admin_name`, mình lưu vào senderName,
 *     nên tên khớp nghĩa là cùng người. Chỉ dùng khi uid còn trống.
 *
 * Khi BỎ GẮN thì chỉ xoá những tin khớp bằng uid: tin do chính người đó gửi TỪ
 * CRM cũng mang senderUserId nhưng không có uid, xoá luôn là mất dữ liệu thật.
 */
export async function relinkAgentMessages(agentId: string): Promise<{ linked: number; cleared: number }> {
  const agent = await prisma.pancakeAgent.findUnique({ where: { id: agentId } });
  if (!agent) return { linked: 0, cleared: 0 };

  // Chỉ đụng tới hội thoại của các trang thuộc đúng kết nối này.
  const pages = await prisma.pancakePage.findMany({ where: { configId: agent.configId }, select: { id: true } });
  if (!pages.length) return { linked: 0, cleared: 0 };
  const conversationWhere = { pancakePageId: { in: pages.map((p) => p.id) } };

  if (!agent.userId) {
    const r = await prisma.chatMessage.updateMany({
      where: { conversation: conversationWhere, pancakeAgentUid: agent.pancakeUserId },
      data: { senderUserId: null },
    });
    return { linked: 0, cleared: r.count };
  }

  const byUid = await prisma.chatMessage.updateMany({
    where: { conversation: conversationWhere, pancakeAgentUid: agent.pancakeUserId },
    data: { senderUserId: agent.userId },
  });
  const byName = await prisma.chatMessage.updateMany({
    where: {
      conversation: conversationWhere,
      direction: MessageDirection.OUT,
      pancakeAgentUid: null,
      senderUserId: null,
      senderName: agent.name,
      // Chỉ tin đồng bộ từ Pancake (có externalId); tin gửi từ CRM đã có người.
      externalId: { not: null },
    },
    data: { senderUserId: agent.userId },
  });
  return { linked: byUid.count + byName.count, cleared: 0 };
}

/** Khoá chống chạy chồng trong tiến trình (ngoài khoá của bộ chạy tác vụ). */
const running = new Set<string>();

export function isStatsSyncRunning(configId: string): boolean {
  return running.has(configId);
}

/**
 * Kéo thống kê cho MỘT kết nối Pancake.
 *
 * `days` là số ngày về trước cần kéo. Bỏ trống = cửa sổ mặc định (hôm qua + hôm
 * nay) cho tác vụ 10 phút. Đặt số lớn để NẠP LẠI LỊCH SỬ: báo cáo 7 ngày hay
 * theo tháng cần dữ liệu của những ngày trước khi bật tính năng, mà tác vụ định
 * kỳ không bao giờ chạm tới.
 */
export async function syncConfigStats(
  configId: string,
  now: Date = new Date(),
  opts: { days?: number } = {}
): Promise<StatsSyncResult> {
  if (running.has(configId)) return { pages: 0, buckets: 0, agents: 0, errors: ["Đang kéo số liệu, chờ lượt trước"] };
  running.add(configId);
  try {
    const config = await prisma.pancakeConfig.findUniqueOrThrow({
      where: { id: configId },
      include: { pages: { where: { active: true } } },
    });
    if (!config.active) return { pages: 0, buckets: 0, agents: 0, errors: ["Kết nối đã tắt"] };

    const windows = opts.days && opts.days > LOOKBACK_DAYS + 1
      ? backfillWindows(now, opts.days)
      : [defaultStatsWindow(now)];
    const errors: string[] = [];
    const names = new Map<string, string>();
    let buckets = 0;
    let pages = 0;

    for (const page of config.pages) {
      let pageOk = false;
      for (const window of windows) {
        try {
          await sleep(PACE_MS);
          const r = await syncPageAgentStats(page, window);
          buckets += r.buckets;
          pageOk = true;
          for (const [uid, name] of r.agentNames) if (name) names.set(uid, name);
        } catch (err) {
          errors.push(`${page.name} (${window.dateRange}): ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (pageOk) pages++;
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
export async function syncAllPancakeStats(now: Date = new Date(), opts: { days?: number } = {}): Promise<StatsSyncResult> {
  const configs = await prisma.pancakeConfig.findMany({ where: { active: true }, select: { id: true, label: true } });
  const total: StatsSyncResult = { pages: 0, buckets: 0, agents: 0, errors: [] };
  for (const c of configs) {
    try {
      const r = await syncConfigStats(c.id, now, opts);
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
