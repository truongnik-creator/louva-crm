import { defineConfig } from "vitest/config";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Bộ test backend chạy trên CSDL SQLite RIÊNG (data/test/test.db), không bao
// giờ đụng data/crm.db. Khoá JWT/mã hoá sinh ngẫu nhiên mỗi lần chạy.
// Các tệp test chạy tuần tự (chung một CSDL): mỗi tệp tự tạo dữ liệu có tiền
// tố riêng qua tests/helpers.ts nên không giẫm chân nhau.

const TEST_DIR = path.resolve(__dirname, "data", "test");

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    globalSetup: ["tests/global-setup.ts"],
    fileParallelism: false,
    pool: "forks",
    testTimeout: 30_000,
    hookTimeout: 120_000,
    env: {
      NODE_ENV: "test",
      // Một kết nối: SQLite chỉ cho một luồng ghi, nhiều kết nối trong pool làm
      // test chập chờn vì SQLITE_BUSY khi có ghi nền (fire-and-forget).
      DATABASE_URL: `file:${path.join(TEST_DIR, "test.db")}?connection_limit=1`,
      STORAGE_DIR: path.join(TEST_DIR, "storage"),
      BACKUP_DIR: path.join(TEST_DIR, "backups"),
      ENCRYPTION_KEY: crypto.randomBytes(32).toString("hex"),
      JWT_SECRET: crypto.randomBytes(48).toString("base64"),
      SKIP_PREMIGRATE_BACKUP: "1",
      LOG_LEVEL: "silent",
      LOGIN_RATE_LIMIT_MAX: "8",
    },
  },
});
