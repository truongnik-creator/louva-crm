import { prisma } from "../lib/prisma";
import { decryptNullable } from "../lib/crypto";

// Tích hợp Pancake (pancake.vn) — gom Facebook, Instagram, TikTok, Zalo về một
// hộp thư duy nhất trong CRM.
//
// LƯU Ý TRIỂN KHAI: Pancake có thay đổi đường dẫn và tên trường giữa các bản
// API. Toàn bộ chỗ phụ thuộc vào hình dạng phản hồi đều gom vào `normalize*`
// bên dưới, nên khi Pancake đổi thì chỉ sửa một chỗ chứ không phải rải khắp
// mã nguồn. Đối chiếu lại với tài liệu Pancake trước khi chạy thật.

const PANCAKE_BASE = process.env.PANCAKE_API_BASE ?? "https://pages.fm/api/v1";

/**
 * F5: cách gửi token. "header" (mặc định an toàn hơn: token không lọt vào log
 * proxy, lịch sử trình duyệt) hoặc "query" (?access_token=).
 * TODO-VERIFY: đối chiếu tài liệu API Pancake thật xem endpoint có nhận token ở
 * header không. Nếu Pancake chỉ nhận query thì đặt PANCAKE_TOKEN_MODE=query.
 */
const TOKEN_MODE = (process.env.PANCAKE_TOKEN_MODE ?? "header").toLowerCase() === "query" ? "query" : "header";

function authorize(url: URL, headers: Record<string, string>, token: string): void {
  if (TOKEN_MODE === "query") {
    url.searchParams.set("access_token", token);
  } else {
    // TODO-VERIFY: tên header Pancake chấp nhận (Authorization: Bearer hay access_token).
    headers.Authorization = `Bearer ${token}`;
  }
}

export interface PancakePageRaw {
  id: string;
  name: string;
  platform?: string;
}

export interface PancakeConversationRaw {
  id: string;
  page_id?: string;
  customer_name?: string;
  customer_phone?: string;
  snippet?: string;
  unread_count?: number;
  updated_at?: string;
  assignee_name?: string;
  /**
   * F5: nguồn quảng cáo khi khách nhắn từ quảng cáo Facebook (click-to-message).
   * TODO-VERIFY: tên trường thật trong API Pancake (ad_id, post_id, ads[]...).
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

/** Bóc nguồn quảng cáo (nếu có) từ bản ghi hội thoại Pancake. */
export function extractAdSource(c: PancakeConversationRaw): AdSource {
  const ad = Array.isArray(c.ads) ? c.ads[0] : undefined;
  const adId = c.ad_id ?? ad?.ad_id;
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
  message?: string;
  from_customer?: boolean;
  inserted_at?: string;
  sender_name?: string;
  /** Ảnh, tệp khách gửi (B13). Pancake dùng type "photo" | "image" | "file" | "video". */
  attachments?: Array<{ type?: string; url?: string; name?: string; mime_type?: string }>;
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

async function callPancake<T>(
  token: string,
  path: string,
  params: Record<string, string> = {}
): Promise<T> {
  const url = new URL(`${PANCAKE_BASE}${path}`);
  const headers: Record<string, string> = { Accept: "application/json" };
  authorize(url, headers, token);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const res = await fetch(url.toString(), { headers });
  if (!res.ok) {
    throw new Error(`Pancake trả về HTTP ${res.status} cho ${path}`);
  }
  return (await res.json()) as T;
}

export async function fetchPages(token: string): Promise<PancakePageRaw[]> {
  const data = await callPancake<{ categorized_pages?: { activated?: PancakePageRaw[] }; pages?: PancakePageRaw[] }>(
    token,
    "/pages"
  );
  return data.categorized_pages?.activated ?? data.pages ?? [];
}

export async function fetchConversations(
  token: string,
  pageId: string,
  sinceIso?: string
): Promise<PancakeConversationRaw[]> {
  const data = await callPancake<{ conversations?: PancakeConversationRaw[] }>(
    token,
    `/pages/${pageId}/conversations`,
    sinceIso ? { since: sinceIso } : {}
  );
  return data.conversations ?? [];
}

export async function fetchMessages(
  token: string,
  pageId: string,
  conversationId: string
): Promise<PancakeMessageRaw[]> {
  const data = await callPancake<{ messages?: PancakeMessageRaw[] }>(
    token,
    `/pages/${pageId}/conversations/${conversationId}/messages`
  );
  return data.messages ?? [];
}

export async function sendMessage(
  token: string,
  pageId: string,
  conversationId: string,
  message: string
): Promise<{ ok: boolean; error?: string; externalId?: string }> {
  try {
    // TODO-VERIFY: đường dẫn và thân lệnh gửi tin của Pancake (action "reply_inbox", trường message).
    const url = new URL(`${PANCAKE_BASE}/pages/${encodeURIComponent(pageId)}/conversations/${encodeURIComponent(conversationId)}/messages`);
    const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json" };
    authorize(url, headers, token);

    const res = await fetch(url.toString(), {
      method: "POST",
      headers,
      body: JSON.stringify({ action: "reply_inbox", message }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return { ok: false, error: `Pancake trả về HTTP ${res.status}` };
    const data = (await res.json().catch(() => ({}))) as { id?: string | number; message_id?: string | number; data?: { id?: string | number } };
    const id = data.message_id ?? data.id ?? data.data?.id;
    return { ok: true, ...(id != null ? { externalId: String(id) } : {}) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Lỗi mạng khi gọi Pancake" };
  }
}

/**
 * F5: trả lời một hội thoại nguồn Pancake qua chính Pancake (không qua Zalo OA).
 * Trả về cùng dạng với sendZaloMessage để routes/inbox.ts xử lý chung.
 */
export async function sendPancakeReply(
  conversation: { pancakeConversationId: string | null; pancakePageId: string | null },
  text: string
): Promise<{ ok: boolean; error?: string; externalId?: string }> {
  if (!conversation.pancakeConversationId || !conversation.pancakePageId) {
    return { ok: false, error: "Hội thoại chưa gắn trang Pancake" };
  }
  const page = await prisma.pancakePage.findUnique({ where: { id: conversation.pancakePageId } });
  if (!page) return { ok: false, error: "Không tìm thấy trang Pancake của hội thoại" };
  const token = await resolveToken(page.configId);
  if (!token) return { ok: false, error: "Kết nối Pancake chưa có token hoặc đã tắt. Vào Cài đặt, Kết nối" };
  // externalId trả về trùng id tin khi đồng bộ lại, nên lần đồng bộ sau không nhân bản tin.
  return sendMessage(token, page.pageId, conversation.pancakeConversationId, text);
}
