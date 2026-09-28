import crypto from "node:crypto";
import { prisma } from "../lib/prisma";
import { encryptNullable, decryptNullable } from "../lib/crypto";

// Tích hợp Zalo Official Account.
//
// Khác bản cũ ở hai điểm bắt buộc của Giai đoạn 1:
//   1. NHIỀU OA — mỗi cơ sở một OA (bảng ZaloOAConfig có branchId), thay vì
//      một hàng cấu hình duy nhất.
//   2. MỌI SECRET ĐỀU MÃ HOÁ khi nghỉ (cột *Enc), giải mã ngay trước khi gọi.
//
// LƯU Ý TRIỂN KHAI: đường dẫn/phiên bản endpoint và công thức MAC của Zalo có
// thay đổi giữa các bản tài liệu. Đối chiếu lại với
// https://developers.zalo.me/docs/official-account trước khi chạy thật.

const ZALO_OPENAPI_BASE = "https://openapi.zalo.me";
const ZALO_OAUTH_BASE = "https://oauth.zaloapp.com";

export interface SendResult {
  ok: boolean;
  externalId?: string;
  error?: string;
}

interface ZaloTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: string | number;
  [key: string]: unknown;
}

/** Cấu hình OA đã giải mã, sẵn sàng dùng. */
export interface ResolvedOAConfig {
  id: string;
  branchId: string | null;
  oaId: string;
  appId: string;
  appSecret: string;
  accessToken: string | null;
  refreshToken: string | null;
  webhookSecret: string | null;
  tokenExpiresAt: Date | null;
}

export async function resolveOAConfig(id: string): Promise<ResolvedOAConfig | null> {
  const row = await prisma.zaloOAConfig.findUnique({ where: { id } });
  if (!row) return null;
  return {
    id: row.id,
    branchId: row.branchId,
    oaId: row.oaId,
    appId: row.appId,
    appSecret: decryptNullable(row.appSecretEnc) ?? "",
    accessToken: decryptNullable(row.accessTokenEnc),
    refreshToken: decryptNullable(row.refreshTokenEnc),
    webhookSecret: decryptNullable(row.webhookSecretEnc),
    tokenExpiresAt: row.tokenExpiresAt,
  };
}

export async function findOAConfigByOaId(oaId: string): Promise<ResolvedOAConfig | null> {
  const row = await prisma.zaloOAConfig.findFirst({ where: { oaId, active: true } });
  return row ? resolveOAConfig(row.id) : null;
}

export async function saveOATokens(
  configId: string,
  tokens: { accessToken: string; refreshToken?: string | null; expiresInSec?: number }
): Promise<void> {
  await prisma.zaloOAConfig.update({
    where: { id: configId },
    data: {
      accessTokenEnc: encryptNullable(tokens.accessToken),
      ...(tokens.refreshToken ? { refreshTokenEnc: encryptNullable(tokens.refreshToken) } : {}),
      tokenExpiresAt: tokens.expiresInSec
        ? new Date(Date.now() + tokens.expiresInSec * 1000)
        : null,
    },
  });
}

/**
 * Trả về access token còn hạn, tự làm mới nếu cần. Trả null khi OA chưa được
 * kết nối — tầng gọi phải xử lý được trường hợp này chứ không được ném lỗi,
 * vì hệ thống phải chạy bình thường khi chưa cấu hình Zalo.
 */
export async function getValidAccessToken(configId: string): Promise<string | null> {
  const config = await resolveOAConfig(configId);
  if (!config?.accessToken) return null;

  const expired = config.tokenExpiresAt !== null && config.tokenExpiresAt.getTime() < Date.now();
  if (!expired) return config.accessToken;
  if (!config.refreshToken) return config.accessToken; // để lệnh gửi tự báo lỗi

  try {
    const refreshed = await refreshAccessToken(config.appId, config.appSecret, config.refreshToken);
    await saveOATokens(config.id, {
      accessToken: refreshed.access_token,
      refreshToken: refreshed.refresh_token ?? config.refreshToken,
      expiresInSec: Number(refreshed.expires_in) || undefined,
    });
    return refreshed.access_token;
  } catch (err) {
    console.error("[zalo] không làm mới được access token:", err);
    return config.accessToken;
  }
}

async function sendTextMessage(
  accessToken: string,
  zaloUserId: string,
  text: string
): Promise<SendResult> {
  try {
    const res = await fetch(`${ZALO_OPENAPI_BASE}/v3.0/oa/message/cs`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "access-token": accessToken },
      body: JSON.stringify({ recipient: { user_id: zaloUserId }, message: { text } }),
    });

    const raw = (await res.json().catch(() => ({}))) as {
      error?: number;
      message?: string;
      data?: { message_id?: string };
    };

    if (!res.ok || raw.error !== 0) {
      return { ok: false, error: raw.message ?? `HTTP ${res.status}` };
    }
    return { ok: true, externalId: raw.data?.message_id };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Lỗi mạng khi gọi Zalo" };
  }
}

/**
 * Gửi tin trong một hội thoại. Nếu hội thoại chưa gắn OA hoặc OA chưa kết nối,
 * trả về ok=false kèm lý do đọc được — tin vẫn được lưu ở trạng thái FAILED để
 * nhân viên biết mà xử lý (xem routes/inbox.ts).
 */
export async function sendZaloMessage(
  conversation: { id: string; externalId: string | null; oaConfigId: string | null },
  text: string
): Promise<SendResult> {
  if (!conversation.oaConfigId) {
    return { ok: false, error: "Hội thoại chưa gắn Official Account nào" };
  }
  if (!conversation.externalId) {
    return { ok: false, error: "Hội thoại chưa có định danh người dùng Zalo" };
  }

  const accessToken = await getValidAccessToken(conversation.oaConfigId);
  if (!accessToken) {
    return { ok: false, error: "Official Account chưa được kết nối — vào Cài đặt › Kết nối Zalo" };
  }

  return sendTextMessage(accessToken, conversation.externalId, text);
}

export function buildAuthorizeUrl(appId: string, redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    app_id: appId,
    redirect_uri: redirectUri,
    state,
  });
  return `${ZALO_OAUTH_BASE}/v4/oa/permission?${params.toString()}`;
}

export async function exchangeCodeForToken(
  appId: string,
  appSecret: string,
  code: string
): Promise<ZaloTokenResponse> {
  const body = new URLSearchParams({ app_id: appId, code, grant_type: "authorization_code" });
  const res = await fetch(`${ZALO_OAUTH_BASE}/v4/oa/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", secret_key: appSecret },
    body: body.toString(),
  });

  const json = (await res.json()) as ZaloTokenResponse;
  if (!res.ok || !json.access_token) {
    throw new Error(`Đổi mã lấy token Zalo thất bại: ${JSON.stringify(json)}`);
  }
  return json;
}

export async function refreshAccessToken(
  appId: string,
  appSecret: string,
  refreshToken: string
): Promise<ZaloTokenResponse> {
  const body = new URLSearchParams({
    app_id: appId,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  const res = await fetch(`${ZALO_OAUTH_BASE}/v4/oa/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", secret_key: appSecret },
    body: body.toString(),
  });

  const json = (await res.json()) as ZaloTokenResponse;
  if (!res.ok || !json.access_token) {
    throw new Error(`Làm mới token Zalo thất bại: ${JSON.stringify(json)}`);
  }
  return json;
}

/**
 * Xác thực chữ ký webhook trên RAW BODY.
 *
 * Bắt buộc dùng đúng chuỗi byte Zalo đã gửi: nếu tính MAC trên kết quả
 * JSON.stringify(req.body) thì chỉ cần Zalo đổi thứ tự khoá hoặc khoảng trắng
 * là chữ ký sai. Xem cách giữ rawBody trong src/index.ts.
 *
 * Công thức theo tài liệu OA: SHA256(appId + rawBody + timestamp + appSecret).
 */
export function verifyWebhookSignature(
  appId: string,
  appSecret: string,
  rawBody: Buffer | string,
  timestamp: string | undefined,
  mac: string | undefined
): boolean {
  if (!mac || !timestamp) return false;

  const expected = crypto
    .createHash("sha256")
    .update(Buffer.concat([
      Buffer.from(appId),
      Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody),
      Buffer.from(String(timestamp)),
      Buffer.from(appSecret),
    ]))
    .digest("hex");

  const a = Buffer.from(expected);
  const b = Buffer.from(mac);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
