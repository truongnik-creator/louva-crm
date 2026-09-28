import crypto from "node:crypto";
import { env } from "./env";

// AES-256-GCM cho hai loại dữ liệu nhạy cảm:
//   1. Secret của Zalo OA (app secret, access/refresh token, webhook secret)
//      -> encryptString / decryptString, lưu thành một chuỗi duy nhất.
//   2. Ảnh trước-sau -> encryptBuffer / decryptBuffer, IV và auth tag lưu
//      thành cột riêng trong PhotoAsset để đọc lại từng tệp mà không phải
//      nạp cả nội dung.
//
// Khoá lấy từ env.encryptionKey (32 byte). Ở production khoá này phải nằm
// trong KMS/Vault, không nằm cạnh CSDL — xem mục 6.2 tài liệu kiến trúc.

const ALGO = "aes-256-gcm";
const IV_LEN = 12;

function key(): Buffer {
  return env.encryptionKey;
}

/** Trả về "iv.tag.ciphertext", tất cả base64. */
export function encryptString(plain: string): string {
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [iv.toString("base64"), cipher.getAuthTag().toString("base64"), enc.toString("base64")].join(".");
}

export function decryptString(payload: string): string {
  const [ivB64, tagB64, dataB64] = payload.split(".");
  if (!ivB64 || !tagB64 || !dataB64) {
    throw new Error("Chuỗi mã hoá không đúng định dạng iv.tag.ciphertext");
  }
  const decipher = crypto.createDecipheriv(ALGO, key(), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]).toString("utf8");
}

/** Mã hoá nếu có giá trị; giữ null/undefined nguyên trạng để cột nullable dễ dùng. */
export function encryptNullable(plain: string | null | undefined): string | null {
  return plain == null || plain === "" ? null : encryptString(plain);
}

export function decryptNullable(payload: string | null | undefined): string | null {
  if (payload == null || payload === "") return null;
  try {
    return decryptString(payload);
  } catch {
    // Khoá đổi hoặc dữ liệu hỏng — không làm sập luồng gọi, để tầng trên
    // báo "cần kết nối lại OA".
    return null;
  }
}

export interface EncryptedBlob {
  data: Buffer;
  iv: string; // base64
  tag: string; // base64
}

export function encryptBuffer(plain: Buffer): EncryptedBlob {
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key(), iv);
  const data = Buffer.concat([cipher.update(plain), cipher.final()]);
  return { data, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64") };
}

export function decryptBuffer(blob: EncryptedBlob): Buffer {
  const decipher = crypto.createDecipheriv(ALGO, key(), Buffer.from(blob.iv, "base64"));
  decipher.setAuthTag(Buffer.from(blob.tag, "base64"));
  return Buffer.concat([decipher.update(blob.data), decipher.final()]);
}

/** Hash refresh token trước khi lưu — CSDL không bao giờ giữ token gốc. */
export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function randomToken(bytes = 48): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

/**
 * So khớp chữ ký HMAC của webhook trên RAW body, dùng so sánh hằng thời gian.
 * Zalo gửi chữ ký dạng hex của SHA-256 HMAC.
 */
export function verifyHmac(rawBody: Buffer | string, signature: string, secret: string): boolean {
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature.replace(/^sha256=/, ""));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
