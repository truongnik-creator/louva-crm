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
}

export interface PancakeMessageRaw {
  id: string;
  conversation_id?: string;
  message?: string;
  from_customer?: boolean;
  inserted_at?: string;
  sender_name?: string;
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
  url.searchParams.set("access_token", token);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const res = await fetch(url.toString(), { headers: { Accept: "application/json" } });
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
): Promise<{ ok: boolean; error?: string }> {
  try {
    const url = new URL(`${PANCAKE_BASE}/pages/${pageId}/conversations/${conversationId}/messages`);
    url.searchParams.set("access_token", token);

    const res = await fetch(url.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
    });
    if (!res.ok) return { ok: false, error: `Pancake trả về HTTP ${res.status}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Lỗi mạng khi gọi Pancake" };
  }
}
