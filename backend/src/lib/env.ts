import dotenv from "dotenv";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// Loads .env if present. If it's missing (the zero-setup case), this is a
// silent no-op — every value below has a sensible built-in default so the
// app never throws just because there's no .env file.
dotenv.config();

// Backend project root, resolved relative to this file's own location so it
// works identically whether we're running from src/lib (tsx dev) or from
// dist/lib (compiled build) — both sit two directories below the backend root.
export const BACKEND_ROOT = path.resolve(__dirname, "..", "..");

const DATA_DIR = path.join(BACKEND_ROOT, "data");
const DEFAULT_SQLITE_PATH = path.join(DATA_DIR, "crm.db");
// Absolute file: URL so Prisma's relative-path resolution quirks never come
// into play, regardless of process cwd.
const DEFAULT_DATABASE_URL = `file:${DEFAULT_SQLITE_PATH}`;

// Fixed (not random) so JWTs and dev sessions survive a server restart.
// Fine for the "just open the app and use it" zero-setup flow; set JWT_SECRET
// in the environment for anything internet-facing.
const DEFAULT_JWT_SECRET = "dev-insecure-jwt-secret-change-me-in-production";

const databaseUrl = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
const jwtSecret = process.env.JWT_SECRET ?? DEFAULT_JWT_SECRET;

if (!process.env.JWT_SECRET) {
  console.warn(
    "[env] JWT_SECRET chưa đặt — đang dùng khoá phát triển cố định. Bắt buộc đặt JWT_SECRET trước khi mở server ra Internet."
  );
}

/**
 * Khoá mã hoá 32 byte cho secret Zalo và ảnh trước-sau.
 *
 * Thứ tự ưu tiên: biến môi trường ENCRYPTION_KEY (hex/base64 32 byte) ->
 * tệp data/.enc-key sinh ngẫu nhiên lần đầu chạy. Tệp cục bộ chỉ hợp lệ cho
 * bản chạy một máy; lên production khoá phải nằm trong KMS/Vault (mục 6.2).
 *
 * Khoá này KHÔNG được đổi khi đã có dữ liệu: đổi khoá là mất toàn bộ ảnh và
 * token đã mã hoá.
 */
function resolveEncryptionKey(): Buffer {
  const fromEnv = process.env.ENCRYPTION_KEY;
  if (fromEnv) {
    const buf = /^[0-9a-fA-F]{64}$/.test(fromEnv)
      ? Buffer.from(fromEnv, "hex")
      : Buffer.from(fromEnv, "base64");
    if (buf.length !== 32) {
      throw new Error("ENCRYPTION_KEY phải là 32 byte (64 ký tự hex hoặc 44 ký tự base64).");
    }
    return buf;
  }

  const keyFile = path.join(DATA_DIR, ".enc-key");
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(keyFile)) {
    return Buffer.from(fs.readFileSync(keyFile, "utf8").trim(), "hex");
  }
  const generated = crypto.randomBytes(32);
  fs.writeFileSync(keyFile, generated.toString("hex"), { mode: 0o600 });
  console.warn(
    `[env] ENCRYPTION_KEY chưa đặt — đã sinh khoá mới tại ${keyFile}. Sao lưu tệp này cùng CSDL, mất khoá là mất ảnh và token Zalo.`
  );
  return generated;
}

// Make sure anything that reads process.env directly (e.g. Prisma's
// env("DATABASE_URL") reference in schema.prisma, or a CLI subprocess we
// spawn) sees the same resolved values we computed here.
process.env.DATABASE_URL = databaseUrl;
process.env.JWT_SECRET = jwtSecret;

function csv(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const parts = value.split(",").map((s) => s.trim()).filter(Boolean);
  return parts.length ? parts : undefined;
}

export const env = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  port: Number(process.env.PORT ?? 4000),
  databaseUrl,
  dataDir: DATA_DIR,
  /** Kho tệp cục bộ cho ảnh/đính kèm đã mã hoá. S3/R2 khi lên production. */
  storageDir: process.env.STORAGE_DIR ?? path.join(DATA_DIR, "storage"),
  jwtSecret,
  encryptionKey: resolveEncryptionKey(),
  /** Access token ngắn hạn — mục 3 Giai đoạn 1 ("JWT ngắn + AuthSession thu hồi được"). */
  accessTokenTtl: process.env.ACCESS_TOKEN_TTL ?? "15m",
  refreshTokenDays: Number(process.env.REFRESH_TOKEN_DAYS ?? 7),
  /**
   * CORS chặt: mặc định chỉ cho renderer Electron/Vite ở localhost. Đặt
   * CORS_ORIGIN (phân tách bằng dấu phẩy) khi triển khai web thật.
   */
  corsOrigins: csv(process.env.CORS_ORIGIN) ?? [
    "http://localhost:3000",
    "http://localhost:5173",
  ],
  zaloOauthRedirectUri: process.env.ZALO_OAUTH_REDIRECT_URI ?? "",
  /** Hạn mức số dòng cho mỗi lần xuất dữ liệu (mục 4.4). */
  exportRowLimit: Number(process.env.EXPORT_ROW_LIMIT ?? 5000),
  /** Thời hạn của một lượt break-glass, tính bằng phút (mục 4.3). */
  breakGlassMinutes: Number(process.env.BREAK_GLASS_MINUTES ?? 30),
};
