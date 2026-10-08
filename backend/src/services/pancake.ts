import { prisma } from "../lib/prisma";
import { decryptNullable, encryptNullable } from "../lib/crypto";
import { logger } from "../lib/logger";

// Tích hợp Pancake (pancake.vn / pages.fm) — gom Facebook, Instagram, TikTok,
// Zalo về một hộp thư duy nhất trong CRM.
//
// ĐÃ ĐỐI CHIẾU VỚI TÀI KHOẢN THẬT (08/10/2026, 4 trang Facebook). SÁU CHỖ TÀI
// LIỆU developer.pancake.biz NÓI KHÁC API THẬT — mã nguồn đi theo API thật:
//
//   1. GET /pages trả `categorized.activated`, KHÔNG phải `categorized_pages`.
//   2. Mỗi trang trong GET /pages mang sẵn `settings.page_access_token`, nên
//      KHÔNG cần gọi generate_page_access_token (lệnh đó VÔ HIỆU token cũ, có
//      thể làm sập tích hợp khác của phòng khám).
//   3. `average_response_time` của API thống kê tính bằng GIÂY, không phải
//      miligiây (dữ liệu thật: trung vị 437 -> 7,3 phút; nếu là ms thì thành
//      0,44 giây, vô lý với người trả lời thật).
//   4. `hour` của API thống kê là GIỜ ĐỊA PHƯƠNG CỦA TRANG (UTC+7), không phải
//      UTC. Trường `hour_in_integer` mới là UTC (206/206 ô lệch đúng 7 giờ).
//   5. GET messages trả tin CŨ TRƯỚC (12/12 hội thoại), tài liệu nói mới trước.
//   6. Trường `message` là HTML (`<div>`, `<br key='n_0' />`); `original_message`
//      mới là văn bản sạch.
//
// Những điều tài liệu nói ĐÚNG và đã kiểm chứng:
//
//   · HAI loại token, cả hai truyền bằng THAM SỐ URL, KHÔNG có header
//     Authorization:
//       - access_token       (token người dùng) chỉ dùng cho API cấp tài khoản
//         ở https://pages.fm/api/v1 — liệt kê trang và sinh token trang.
//       - page_access_token  (token trang) dùng cho MỌI API cấp trang ở
//         https://pages.fm/api/public_api/v1 và /v2 — hội thoại, tin nhắn,
//         thống kê, khách, nhân viên.
//   · Token trang không hết hạn; token người dùng sống tối đa 90 ngày.
//   · Giới hạn 5 lượt gọi / trang / giây -> gọi tuần tự theo trang, có nghỉ.
//   · Mọi mốc thời gian API trả về là UTC+0. Ngoại lệ: tham số `date_range` của
//     API thống kê tính theo giờ địa phương của trang (UTC+7 với trang VN).
//
// Toàn bộ chỗ phụ thuộc hình dạng phản hồi gom vào `normalize*` / `fetch*` bên
// dưới, nên khi Pancake đổi thì chỉ sửa một chỗ.

/** API cấp tài khoản (access_token). */
const USER_BASE = process.env.PANCAKE_API_BASE ?? "https://pages.fm/api/v1";
/** API cấp trang v1 (page_access_token): tin nhắn, thống kê, nhân viên. */
const PAGE_BASE_V1 = process.env.PANCAKE_PAGE_API_BASE ?? "https://pages.fm/api/public_api/v1";
/** API cấp trang v2 (page_access_token): danh sách hội thoại. */
const PAGE_BASE_V2 = process.env.PANCAKE_PAGE_API_V2_BASE ?? "https://pages.fm/api/public_api/v2";

/**
 * Cách gửi token. Tài liệu Pancake nói CHỈ nhận tham số URL, nên mặc định là
 * "query". Giữ lại "header" làm cửa thoát nếu một bản API nội bộ nào đó yêu cầu
 * khác (đặt PANCAKE_TOKEN_MODE=header).
 */
const TOKEN_MODE = (process.env.PANCAKE_TOKEN_MODE ?? "query").toLowerCase() === "header" ? "header" : "query";

const TIMEOUT_MS = 20_000;

function authorize(url: URL, headers: Record<string, string>, token: string, param: "access_token" | "page_access_token"): void {
  if (TOKEN_MODE === "header") {
    headers.Authorization = `Bearer ${token}`;
    return;
  }
  url.searchParams.set(param, token);
}

/** Một nhân viên của trang, theo GET /pages (không cần token trang). */
export interface PancakePageUserRaw {
  user_id?: string;
  name?: string;
  fb_id?: string;
  /** active | removed | deactivated | no_permission */
  status?: string;
}

export interface PancakePageRaw {
  id: string;
  name: string;
  /** API thật trả chữ thường: "facebook". */
  platform?: string;
  /** Lệch giờ của trang so với UTC, API thật trả 7.0 với trang Việt Nam. */
  timezone?: number;
  /** Token riêng của trang nằm sẵn ở đây — khỏi phải sinh token mới. */
  settings?: { page_access_token?: string };
  users?: PancakePageUserRaw[];
}

/** Token trang lấy từ chính phản hồi GET /pages. */
export function pageTokenOf(p: PancakePageRaw): string | null {
  const t = p.settings?.page_access_token;
  return t ? String(t) : null;
}

export interface PancakeConversationRaw {
  id: string;
  page_id?: string;
  /** INBOX | COMMENT | LIVESTREAM | POST */
  type?: string;
  customer_name?: string;
  customer_phone?: string;
  /** API thật: SĐT bắt được từ nội dung chat nằm ở đây, không ở customer_phone. */
  recent_phone_numbers?: Array<{ phone_number?: string; captured?: string }>;
  ad_ids?: Array<string | number>;
  snippet?: string;
  unread_count?: number;
  /** v2 dùng `seen`; chưa xem thì coi như 1 tin chưa đọc. */
  seen?: boolean;
  updated_at?: string;
  assignee_name?: string;
  /** v2: bên mở hội thoại (thường là khách). */
  from?: { id?: string; name?: string };
  /**
   * Nguồn quảng cáo khi khách nhắn từ quảng cáo Facebook (click-to-message).
   */
  ad_id?: string | number;
  post_id?: string;
  ads?: Array<{ ad_id?: string | number; campaign_name?: string; campaign_id?: string | number; post_id?: string }>;
  campaign_name?: string;
}

export interface AdSource {
  adId: string | null;
  adPostId: string | null;
  adCampaign: string | null;
}

/** SĐT khách của một hội thoại. API thật để ở recent_phone_numbers. */
export function conversationPhone(c: PancakeConversationRaw): string | null {
  if (c.customer_phone?.trim()) return c.customer_phone.trim();
  for (const p of c.recent_phone_numbers ?? []) {
    const v = (p.phone_number ?? p.captured)?.trim();
    if (v) return v;
  }
  return null;
}

/** Bóc nguồn quảng cáo (nếu có) từ bản ghi hội thoại Pancake. */
export function extractAdSource(c: PancakeConversationRaw): AdSource {
  const ad = Array.isArray(c.ads) ? c.ads[0] : undefined;
  const adId = c.ad_id ?? ad?.ad_id ?? (Array.isArray(c.ad_ids) ? c.ad_ids[0] : undefined);
  const post = c.post_id ?? ad?.post_id;
  const campaign = c.campaign_name ?? ad?.campaign_name ?? (ad?.campaign_id != null ? String(ad.campaign_id) : undefined);
  return {
    adId: adId != null && String(adId).trim() ? String(adId).slice(0, 100) : null,
    adPostId: post ? String(post).slice(0, 100) : null,
    adCampaign: campaign ? String(campaign).slice(0, 200) : null,
  };
}

export interface PancakeMessageRaw {
  id: string;
  conversation_id?: string;
  page_id?: string;
  message?: string;
  original_message?: string;
  /** Bản cũ / webhook có cờ sẵn. API v1 thì suy ra từ `from` (xem isFromCustomer). */
  from_customer?: boolean;
  inserted_at?: string;
  sender_name?: string;
  /** API v1: thông tin người gửi. `uid` có giá trị khi tin do NHÂN VIÊN gửi. */
  from?: {
    id?: string;
    name?: string;
    email?: string | null;
    /** UUID nhân viên bên Pancake — khoá quy tin nhắn về người thật (F35). */
    uid?: string | null;
    admin_id?: string | null;
    admin_name?: string | null;
    is_automated?: boolean;
  };
  /**
   * "Đính kèm" của Pancake KHÔNG chỉ là tệp. Đã gặp thật 11 loại:
   *   media   : photo, video, sticker, file, audio
   *   không phải media: ad_click, link, reaction, address, template,
   *                     replied_message, response_feedback, system_message
   * Loại không phải media vẫn có `url` (ad_click trỏ facebook.com) và có `name`
   * (là NGUYÊN BÀI QUẢNG CÁO) — xem classifyAttachments.
   */
  attachments?: PancakeAttachmentRaw[];
}

export interface PancakeAttachmentRaw {
  type?: string;
  url?: string;
  name?: string;
  mime_type?: string;
  /** Video: url ở trên chỉ là ảnh đại diện, tệp thật nằm đây. */
  video_data?: { url?: string; height?: number; width?: number };
  /** reaction: "❤". */
  emoji?: string;
  /** address: "E ở, Phường Long Biên, Hà Nội". */
  full_address?: string;
  ad_id?: string | number;
}

/**
 * Tin này của khách hay của mình?
 *
 * Thứ tự xét: cờ `from_customer` (webhook, bản cũ) -> dấu hiệu nhân viên
 * (`from.uid`, `from.admin_id`) -> người gửi chính là trang -> còn lại là khách.
 * `convFromId` là id bên mở hội thoại (MessagesResponse.conv_from.id): khớp thì
 * chắc chắn là khách.
 */
export function isFromCustomer(m: PancakeMessageRaw, ctx: { pageId?: string; convFromId?: string } = {}): boolean {
  if (typeof m.from_customer === "boolean") return m.from_customer;
  const from = m.from;
  if (from?.uid || from?.admin_id) return false;
  if (from?.id && ctx.pageId && String(from.id) === String(ctx.pageId)) return false;
  if (from?.id && ctx.convFromId) return String(from.id) === String(ctx.convFromId);
  return true;
}

/** UUID nhân viên Pancake đã gửi tin (null khi tin của khách hoặc do máy gửi). */
export function staffUidOf(m: PancakeMessageRaw): string | null {
  const uid = m.from?.uid;
  return uid ? String(uid) : null;
}

/**
 * Đọc mốc thời gian Pancake trả về.
 *
 * Tài liệu: mọi mốc thời gian trong phản hồi là UTC+0, và chuỗi ISO KHÔNG kèm
 * hậu tố múi giờ ("2026-01-15T10:00:00"). JavaScript lại hiểu chuỗi dạng đó là
 * GIỜ MÁY, nên chạy trên máy đặt giờ Việt Nam sẽ lệch 7 tiếng — đủ để tin nhắn
 * rơi sang ngày khác và báo cáo theo ngày sai. Vì vậy chuỗi không có múi giờ
 * thì gắn thêm "Z".
 */
export function parsePancakeTime(raw: string | number | null | undefined, fallback: Date = new Date()): Date {
  if (raw == null || raw === "") return fallback;
  if (typeof raw === "number") return new Date(raw < 1e12 ? raw * 1000 : raw);
  const s = String(raw).trim();
  const hasZone = /(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(s);
  const d = new Date(hasZone ? s : `${s.replace(" ", "T")}Z`);
  return Number.isNaN(d.getTime()) ? fallback : d;
}

/**
 * Mốc giờ của API THỐNG KÊ.
 *
 * Trái tài liệu: `hour` là giờ ĐỊA PHƯƠNG của trang (UTC+7 với trang Việt Nam),
 * còn `hour_in_integer` ("20261007010000") mới là UTC. Kiểm trên dữ liệu thật:
 * 206/206 ô lệch đúng 7 giờ. Nên ưu tiên `hour_in_integer`; chỉ khi thiếu mới
 * đọc `hour` và trừ lệch giờ của trang.
 */
export function parseStatHour(
  bucket: { hour?: string; hour_in_integer?: string },
  pageTimezoneHours = 7
): Date | null {
  const hi = bucket.hour_in_integer;
  if (hi && /^\d{14}$/.test(hi)) {
    const iso = `${hi.slice(0, 4)}-${hi.slice(4, 6)}-${hi.slice(6, 8)}T${hi.slice(8, 10)}:${hi.slice(10, 12)}:${hi.slice(12, 14)}Z`;
    const d = new Date(iso);
    if (!Number.isNaN(d.getTime())) return d;
  }
  if (!bucket.hour) return null;
  // Giờ địa phương của trang -> UTC. Trang Việt Nam không có giờ mùa hè nên trừ
  // một lệch cố định là đủ.
  const local = new Date(`${bucket.hour.replace(" ", "T")}Z`);
  if (Number.isNaN(local.getTime())) return null;
  return new Date(local.getTime() - pageTimezoneHours * 3_600_000);
}

/**
 * Nội dung tin để lưu vào CRM.
 *
 * `message` là HTML do Pancake dựng ("<div>Dạ em chào chị\r<br key='n_0' />…"),
 * `original_message` là văn bản gốc sạch. Ưu tiên bản sạch; chỉ khi thiếu mới
 * bóc thẻ khỏi HTML — để CRM không hiện "<div>" cho người dùng.
 */
export function messageText(m: PancakeMessageRaw): string | null {
  const raw = m.original_message?.trim();
  if (raw) return raw;
  if (!m.message) return null;
  const text = m.message
    .replace(/<br\b[^>]*\/?>/gi, "\n")
    .replace(/<\/(p|div)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/\r\n?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text || null;
}

/* ------------------------------------------------------------ ĐÍNH KÈM
 *
 * BÀI HỌC TỪ DỮ LIỆU THẬT: lọc đính kèm bằng "có url https" là SAI.
 *
 * Pancake gói rất nhiều thứ vào `attachments`, và mấy thứ KHÔNG phải tệp cũng
 * có `url`: `ad_click` trỏ tới facebook.com/<post_id>, `link` trỏ tới bài viết.
 * Hai loại đó còn mang `name` là NGUYÊN VĂN BÀI QUẢNG CÁO. Hậu quả đo được
 * trên máy chủ thật: 287 "tệp đính kèm" giả, tên tệp dài 200 ký tự là bài
 * quảng cáo, và 385 tin (14%) hiện "[Tệp đính kèm]" thay cho nội dung.
 *
 * Nên ở đây dùng DANH SÁCH CHO PHÉP: chỉ loại nào thật là media mới thành tệp
 * đính kèm. Loại mới của Pancake sẽ bị bỏ qua chứ không lọt vào hồ sơ khách —
 * thà thiếu một loại media mới còn hơn rác vào bệnh án.
 */

const MEDIA_TYPES = new Set(["photo", "image", "video", "audio", "file", "sticker"]);

export interface MediaAttachment {
  kind: "IMAGE" | "FILE";
  fileName: string;
  mimeType: string | null;
  url: string;
}

function isImageType(a: PancakeAttachmentRaw): boolean {
  const t = (a.type ?? "").toLowerCase();
  if (t === "photo" || t === "image" || t === "sticker") return true;
  return Boolean(a.mime_type?.startsWith("image/"));
}

/** Chỉ giữ đính kèm THẬT là media, và lấy đúng đường dẫn tệp. */
export function classifyAttachments(list: PancakeAttachmentRaw[] | undefined): MediaAttachment[] {
  const out: MediaAttachment[] = [];
  for (const a of list ?? []) {
    const type = (a.type ?? "").toLowerCase();
    const isMedia = MEDIA_TYPES.has(type) || Boolean(a.mime_type?.includes("/"));
    if (!isMedia) continue;

    // Video: `url` chỉ là ảnh đại diện (.jpg); tệp thật ở video_data.url.
    const url = type === "video" ? (a.video_data?.url ?? a.url) : a.url;
    if (!url?.startsWith("https://")) continue;

    const image = isImageType(a);
    // KHÔNG dùng a.name làm tên tệp: ở ad_click và link nó là bài quảng cáo.
    const fallbackName = image ? "anh-pancake.jpg" : type === "video" ? "video-pancake.mp4" : "tep-pancake";
    out.push({
      kind: image ? "IMAGE" : "FILE",
      fileName: fallbackName,
      mimeType: a.mime_type ?? (image ? "image/jpeg" : null),
      url,
    });
  }
  return out;
}

/**
 * Chữ để hiện khi tin KHÔNG có nội dung văn bản.
 *
 * Trước đây mọi tin như vậy hiện "[Tệp đính kèm]" hoặc "[Nội dung không đọc
 * được]" — đo thật: 385 + 44 tin. Sale mở hộp thư thấy một dãy "[Tệp đính kèm]"
 * thì không biết khách đã gửi gì, phải mở Pancake ra xem. Nên nói rõ là gì.
 */
export function attachmentLabel(list: PancakeAttachmentRaw[] | undefined): string | null {
  for (const a of list ?? []) {
    const t = (a.type ?? "").toLowerCase();
    if (t === "reaction") return a.emoji ? `Đã bày tỏ cảm xúc ${a.emoji}` : "Đã bày tỏ cảm xúc";
    if (t === "address") return a.full_address ? `Địa chỉ: ${a.full_address}` : "Đã gửi địa chỉ";
    if (t === "sticker") return "[Nhãn dán]";
    if (t === "photo" || t === "image") return "[Hình ảnh]";
    if (t === "video") return "[Video]";
    if (t === "audio") return "[Tin thoại]";
    if (t === "file") return "[Tệp đính kèm]";
    if (t === "ad_click") return "Khách nhắn từ quảng cáo";
    if (t === "link") return "[Chia sẻ liên kết]";
    if (t === "template") return "[Thẻ thông tin]";
    if (t === "response_feedback") return "[Khách đánh giá]";
  }
  return null;
}

/** Nền tảng Pancake trả về không thống nhất hoa/thường — chuẩn hoá một chỗ. */
export function normalizePlatform(raw: string | undefined): string {
  const v = (raw ?? "").toLowerCase();
  if (v.includes("instagram")) return "INSTAGRAM";
  if (v.includes("tiktok")) return "TIKTOK";
  if (v.includes("zalo")) return "ZALO";
  return "FACEBOOK";
}

export async function resolveToken(configId: string): Promise<string | null> {
  const row = await prisma.pancakeConfig.findUnique({ where: { id: configId } });
  if (!row?.active) return null;
  return decryptNullable(row.accessTokenEnc);
}

async function callJson<T>(url: URL, headers: Record<string, string>, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url.toString(), { ...init, headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (res.status === 429) throw new Error("Pancake chặn vì gọi quá nhanh (giới hạn 5 lượt/trang/giây). Thử lại sau.");
  if (!res.ok) throw new Error(`Pancake trả về HTTP ${res.status} cho ${url.pathname}`);
  return (await res.json()) as T;
}

/** API cấp tài khoản: dùng access_token của người dùng. */
async function callUserApi<T>(token: string, path: string, params: Record<string, string> = {}): Promise<T> {
  const url = new URL(`${USER_BASE}${path}`);
  const headers: Record<string, string> = { Accept: "application/json" };
  authorize(url, headers, token, "access_token");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return callJson<T>(url, headers);
}

/** API cấp trang: dùng page_access_token. */
async function callPageApi<T>(
  base: string,
  pageToken: string,
  path: string,
  params: Record<string, string> = {}
): Promise<T> {
  const url = new URL(`${base}${path}`);
  const headers: Record<string, string> = { Accept: "application/json" };
  authorize(url, headers, pageToken, "page_access_token");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return callJson<T>(url, headers);
}

// --------------------------------------------------------------- TOKEN TRANG

export interface PageTokenRef {
  /** id bản ghi PancakePage trong CRM. */
  id: string;
  /** id trang bên Pancake. */
  pageId: string;
  configId: string;
  pageAccessTokenEnc: string | null;
}

/**
 * Token của một trang, theo thứ tự ưu tiên:
 *
 *   1. Token đã lưu trong CSDL — bình thường "Dò trang" đã lấy sẵn từ
 *      `settings.page_access_token` của GET /pages, hoặc quản trị dán tay.
 *   2. CỬA CUỐI: sinh mới bằng token người dùng
 *      (POST /pages/{page_id}/generate_page_access_token).
 *
 * Vì sao bước 2 là cửa cuối chứ không phải đường chính: sinh token mới sẽ VÔ
 * HIỆU token cũ bên Pancake. Nếu phòng khám đang dùng token đó cho một tích hợp
 * khác (chatbot, phần mềm bán hàng) thì tích hợp đó đứt mà không ai biết vì sao.
 * Đường chính là đọc token có sẵn ở bước 1.
 */
export async function resolvePageToken(page: PageTokenRef): Promise<string | null> {
  const saved = decryptNullable(page.pageAccessTokenEnc);
  if (saved) return saved;

  const userToken = await resolveToken(page.configId);
  if (!userToken) return null;
  const generated = await generatePageAccessToken(userToken, page.pageId);
  if (!generated) return null;
  await prisma.pancakePage
    .update({ where: { id: page.id }, data: { pageAccessTokenEnc: encryptNullable(generated) } })
    .catch((err) => logger.warn({ err, pageId: page.pageId }, "[pancake] không lưu được token trang"));
  return generated;
}

/** Sinh (hoặc làm mới) token trang. Trả null khi Pancake không trả token nào. */
export async function generatePageAccessToken(userToken: string, pageId: string): Promise<string | null> {
  const url = new URL(`${USER_BASE}/pages/${encodeURIComponent(pageId)}/generate_page_access_token`);
  const headers: Record<string, string> = { Accept: "application/json" };
  authorize(url, headers, userToken, "access_token");
  url.searchParams.set("page_id", pageId);
  const data = await callJson<{
    page_access_token?: string;
    access_token?: string;
    data?: { page_access_token?: string; access_token?: string };
  }>(url, headers, { method: "POST" });
  const token = data.page_access_token ?? data.access_token ?? data.data?.page_access_token ?? data.data?.access_token;
  return token ? String(token) : null;
}

// --------------------------------------------------------------------- TRANG

interface PagesResponse {
  categorized?: { activated?: PancakePageRaw[]; inactivated?: PancakePageRaw[] };
  categorized_pages?: { activated?: PancakePageRaw[]; inactivated?: PancakePageRaw[] };
  pages?: PancakePageRaw[];
}

export async function fetchPages(token: string): Promise<PancakePageRaw[]> {
  return (await fetchAllPageBuckets(token)).activated;
}

/**
 * Cả hai nhóm trang mà Pancake trả về.
 *
 * `activated` là trang dùng được: có page_access_token, API thống kê có số.
 * `inactivated` là trang Pancake biết nhưng chưa kích hoạt — KHÔNG có token nên
 * CRM không kéo được gì, song vẫn cần kể tên để người dùng hiểu vì sao kênh
 * mình vừa nối chưa thấy trong CRM.
 */
export async function fetchAllPageBuckets(token: string): Promise<{
  activated: PancakePageRaw[];
  inactive: Array<{ pageId: string; name: string; platform: string }>;
}> {
  const data = await callUserApi<PagesResponse>(token, "/pages");
  // API thật dùng `categorized`; `categorized_pages` giữ lại cho bản cũ.
  const bucket = data.categorized ?? data.categorized_pages;
  return {
    activated: bucket?.activated ?? data.pages ?? [],
    inactive: (bucket?.inactivated ?? []).map((p) => ({
      pageId: String(p.id),
      name: p.name || "(không tên)",
      platform: normalizePlatform(p.platform),
    })),
  };
}

// ----------------------------------------------------------------- HỘI THOẠI

export async function fetchConversations(
  pageToken: string,
  pageId: string,
  opts: { sinceIso?: string; lastConversationId?: string } = {}
): Promise<PancakeConversationRaw[]> {
  const params: Record<string, string> = {};
  // v2 nhận `since` là Unix giây.
  if (opts.sinceIso) {
    const t = Date.parse(opts.sinceIso);
    if (!Number.isNaN(t)) params.since = String(Math.floor(t / 1000));
  }
  if (opts.lastConversationId) params.last_conversation_id = opts.lastConversationId;
  const data = await callPageApi<{ conversations?: PancakeConversationRaw[] }>(
    PAGE_BASE_V2,
    pageToken,
    `/pages/${encodeURIComponent(pageId)}/conversations`,
    params
  );
  return data.conversations ?? [];
}

export interface FetchedMessages {
  messages: PancakeMessageRaw[];
  /** id bên mở hội thoại — dùng để biết tin nào của khách. */
  convFromId?: string;
  customerName?: string;
}

export async function fetchMessages(
  pageToken: string,
  pageId: string,
  conversationId: string
): Promise<FetchedMessages> {
  const data = await callPageApi<{
    messages?: PancakeMessageRaw[];
    conv_from?: { id?: string; name?: string };
  }>(
    PAGE_BASE_V1,
    pageToken,
    `/pages/${encodeURIComponent(pageId)}/conversations/${encodeURIComponent(conversationId)}/messages`
  );
  // Tài liệu nói "mới trước", API thật trả "cũ trước" (12/12 hội thoại kiểm
  // thật). Thay vì tin vào thứ tự, XẾP LẠI theo inserted_at — đúng với cả hai
  // và không vỡ nếu Pancake đổi lần nữa.
  const messages = [...(data.messages ?? [])].sort(
    (a, b) => parsePancakeTime(a.inserted_at, new Date(0)).getTime() - parsePancakeTime(b.inserted_at, new Date(0)).getTime()
  );
  return {
    messages,
    ...(data.conv_from?.id ? { convFromId: String(data.conv_from.id) } : {}),
    ...(data.conv_from?.name ? { customerName: String(data.conv_from.name) } : {}),
  };
}

// ---------------------------------------------------------------- GỬI TIN

export async function sendMessage(
  pageToken: string,
  pageId: string,
  conversationId: string,
  message: string,
  opts: { senderId?: string | null } = {}
): Promise<{ ok: boolean; error?: string; externalId?: string }> {
  try {
    const url = new URL(
      `${PAGE_BASE_V1}/pages/${encodeURIComponent(pageId)}/conversations/${encodeURIComponent(conversationId)}/messages`
    );
    const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json" };
    authorize(url, headers, pageToken, "page_access_token");

    const res = await fetch(url.toString(), {
      method: "POST",
      headers,
      // `sender_id` để Pancake quy tin này về đúng nhân viên — nhờ vậy báo cáo
      // hiệu suất (F35) tính cả tin gửi từ CRM, không chỉ tin gửi trong app Pancake.
      body: JSON.stringify({ action: "reply_inbox", message, ...(opts.senderId ? { sender_id: opts.senderId } : {}) }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, error: `Pancake trả về HTTP ${res.status}` };
    const data = (await res.json().catch(() => ({}))) as {
      success?: boolean;
      message_code?: string;
      id?: string | number;
      message_id?: string | number;
      data?: { id?: string | number };
    };
    // Pancake có thể trả HTTP 200 kèm success: false (ví dụ content_id hết hạn).
    if (data.success === false) return { ok: false, error: `Pancake từ chối: ${data.message_code ?? "không rõ lý do"}` };
    const id = data.message_id ?? data.id ?? data.data?.id;
    return { ok: true, ...(id != null ? { externalId: String(id) } : {}) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Lỗi mạng khi gọi Pancake" };
  }
}

/**
 * Trả lời một hội thoại nguồn Pancake qua chính Pancake (không qua Zalo OA).
 * Trả về cùng dạng với sendZaloMessage để routes/inbox.ts xử lý chung.
 */
export async function sendPancakeReply(
  conversation: { pancakeConversationId: string | null; pancakePageId: string | null },
  text: string,
  opts: { senderUserId?: string | null } = {}
): Promise<{ ok: boolean; error?: string; externalId?: string }> {
  if (!conversation.pancakeConversationId || !conversation.pancakePageId) {
    return { ok: false, error: "Hội thoại chưa gắn trang Pancake" };
  }
  const page = await prisma.pancakePage.findUnique({ where: { id: conversation.pancakePageId } });
  if (!page) return { ok: false, error: "Không tìm thấy trang Pancake của hội thoại" };
  const token = await resolvePageToken(page);
  if (!token) return { ok: false, error: "Kết nối Pancake chưa có token hoặc đã tắt. Vào Cài đặt, Kết nối" };

  // Người gửi trong CRM có gắn với một nhân viên Pancake thì gửi kèm sender_id.
  const agent = opts.senderUserId
    ? await prisma.pancakeAgent.findFirst({
        where: { configId: page.configId, userId: opts.senderUserId },
        select: { pancakeUserId: true },
      })
    : null;

  // externalId trả về trùng id tin khi đồng bộ lại, nên lần đồng bộ sau không nhân bản tin.
  return sendMessage(token, page.pageId, conversation.pancakeConversationId, text, {
    senderId: agent?.pancakeUserId ?? null,
  });
}

// ---------------------------------------------- NHÂN VIÊN & THỐNG KÊ (F35)

/* Nhân viên của trang KHÔNG lấy qua /pages/{page_id}/users nữa: phản hồi
 * GET /pages đã mang sẵn `users[]` (user_id, tên, fb_id, trạng thái) cho mọi
 * trang trong một lượt gọi bằng token người dùng — ít lượt hơn, không cần token
 * trang. Xem PancakePageUserRaw ở trên và discoverAgents trong pancake-stats.ts.
 */

/** Một ô số liệu Pancake trả về cho một nhân viên trong một mốc giờ. */
export interface PancakeUserStatBucket {
  /** Giờ ĐỊA PHƯƠNG của trang (xem parseStatHour). */
  hour?: string;
  /** Cùng mốc đó theo UTC, "20261007010000" — đây mới là mốc đáng tin. */
  hour_in_integer?: string;
  page_id?: string;
  inbox_count?: number;
  comment_count?: number;
  unique_inbox_count?: number;
  unique_comment_count?: number;
  private_reply_count?: number;
  phone_number_count?: number;
  order_count?: number;
  /**
   * GIÂY (tài liệu ghi miligiây là SAI — xem khối chú thích đầu tệp).
   * 0 nghĩa là Pancake không đo được giờ đó, không phải trả lời tức thì.
   */
  average_response_time?: number;
}

export interface PancakeUserStats {
  /** UUID nhân viên -> các ô số liệu theo giờ. */
  statistics: Record<string, PancakeUserStatBucket[]>;
  /** UUID nhân viên -> tên và tổng của cả khoảng. */
  users: Record<string, PancakeUserStatBucket & { user_name?: string; user_fb_id?: string }>;
}

/**
 * Thống kê nhân viên của một trang (GET /pages/{page_id}/statistics/users).
 *
 * `dateRange` theo đúng định dạng Pancake đòi: "DD/MM/YYYY HH:MM:SS -
 * DD/MM/YYYY HH:MM:SS", tính theo GIỜ ĐỊA PHƯƠNG CỦA TRANG (trang VN = UTC+7).
 * Mốc giờ trong phản hồi: đọc bằng parseStatHour, đừng tự parse.
 */
export async function fetchUserStatistics(
  pageToken: string,
  pageId: string,
  dateRange: string
): Promise<PancakeUserStats> {
  const data = await callPageApi<{ success?: boolean; data?: PancakeUserStats }>(
    PAGE_BASE_V1,
    pageToken,
    `/pages/${encodeURIComponent(pageId)}/statistics/users`,
    { date_range: dateRange }
  );
  return { statistics: data.data?.statistics ?? {}, users: data.data?.users ?? {} };
}
