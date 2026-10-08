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

const nodeEnv = process.env.NODE_ENV ?? "development";
const isProduction = nodeEnv === "production";

const databaseUrl = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;

/**
 * S2: production mà thiếu JWT_SECRET (hoặc để đúng khoá phát triển công khai
 * trong mã nguồn, hoặc quá ngắn) thì TỪ CHỐI khởi động. Khoá mặc định nằm
 * trong repo, ai đọc được mã nguồn cũng ký được token đăng nhập hợp lệ.
 */
function resolveJwtSecret(): string {
  const fromEnv = process.env.JWT_SECRET;
  if (isProduction) {
    if (!fromEnv || fromEnv === DEFAULT_JWT_SECRET || fromEnv.length < 32) {
      throw new Error(
        "[env] NODE_ENV=production nhưng JWT_SECRET chưa đặt, trùng khoá mặc định hoặc ngắn hơn 32 ký tự. Từ chối khởi động. Sinh khoá bằng: node -e \"console.log(require('crypto').randomBytes(48).toString('base64'))\""
      );
    }
    return fromEnv;
  }
  if (!fromEnv) {
    console.warn(
      "[env] JWT_SECRET chưa đặt: đang dùng khoá phát triển cố định. Bắt buộc đặt JWT_SECRET trước khi mở server ra Internet."
    );
  }
  return fromEnv ?? DEFAULT_JWT_SECRET;
}

const jwtSecret = resolveJwtSecret();

function parseKey(raw: string, source: string): Buffer {
  const trimmed = raw.trim();
  const buf = /^[0-9a-fA-F]{64}$/.test(trimmed) ? Buffer.from(trimmed, "hex") : Buffer.from(trimmed, "base64");
  if (buf.length !== 32) {
    throw new Error(`${source} phải là 32 byte (64 ký tự hex hoặc 44 ký tự base64).`);
  }
  return buf;
}

/** Đường dẫn tệp khoá mã hoá đang dùng (null khi khoá lấy từ biến ENCRYPTION_KEY). */
export function encryptionKeyFilePath(): string | null {
  if (process.env.ENCRYPTION_KEY) return null;
  return process.env.ENCRYPTION_KEY_FILE
    ? path.resolve(process.env.ENCRYPTION_KEY_FILE)
    : path.join(DATA_DIR, ".enc-key");
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
  if (fromEnv) return parseKey(fromEnv, "ENCRYPTION_KEY");

  // S3: ENCRYPTION_KEY_FILE cho phép đặt khoá NGOÀI thư mục data (ổ khác,
  // thư mục chỉ root đọc được, ổ mã hoá...). Lộ bản sao thư mục data mà không
  // lộ tệp khoá thì ảnh và token vẫn an toàn.
  const keyFile = encryptionKeyFilePath()!;
  const custom = Boolean(process.env.ENCRYPTION_KEY_FILE);

  if (fs.existsSync(keyFile)) {
    return parseKey(fs.readFileSync(keyFile, "utf8"), keyFile);
  }
  if (custom && isProduction) {
    // Production trỏ tới tệp khoá mà tệp không tồn tại: gần như chắc chắn là
    // mount hỏng. Sinh khoá mới lúc này = mất khả năng đọc toàn bộ dữ liệu cũ.
    throw new Error(`[env] ENCRYPTION_KEY_FILE=${keyFile} không tồn tại. Từ chối khởi động để không sinh khoá mới đè lên dữ liệu đã mã hoá.`);
  }

  fs.mkdirSync(path.dirname(keyFile), { recursive: true });
  const generated = crypto.randomBytes(32);
  fs.writeFileSync(keyFile, generated.toString("hex"), { mode: 0o600 });
  console.warn(
    `[env] Đã sinh khoá mã hoá mới tại ${keyFile}. Sao lưu tệp này RIÊNG với CSDL, mất khoá là mất ảnh và token Zalo.`
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

/**
 * "trust proxy" của Express. Mặc định chỉ tin proxy chạy trên chính máy này
 * (cloudflared, nginx cục bộ): tin mọi X-Forwarded-For như trước thì ai cũng
 * giả được IP, vừa lách giới hạn đăng nhập vừa làm sai nhật ký kiểm toán.
 */
function resolveTrustProxy(): boolean | number | string {
  const raw = process.env.TRUST_PROXY;
  if (raw === undefined || raw === "") return "loopback";
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (/^\d+$/.test(raw)) return Number(raw);
  return raw;
}

export const env = {
  nodeEnv,
  isProduction,
  trustProxy: resolveTrustProxy(),
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
  /** S6: số lần gọi /api/auth/login tối đa mỗi IP trong một cửa sổ. */
  loginRateLimitMax: Number(process.env.LOGIN_RATE_LIMIT_MAX ?? 10),
  loginRateLimitWindowMs: Number(process.env.LOGIN_RATE_LIMIT_WINDOW_MS ?? 15 * 60 * 1000),
  /** Thư mục chứa bản sao lưu (T1). Mặc định backend/backups, ngoài thư mục data. */
  backupDir: process.env.BACKUP_DIR ?? path.join(BACKEND_ROOT, "backups"),
  backupKeep: Number(process.env.BACKUP_KEEP ?? 14),
};
