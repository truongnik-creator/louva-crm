import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// Chạy MỘT lần trước toàn bộ bộ test: xoá CSDL test cũ và áp mọi migration.
// Dùng đúng Prisma CLI như bootstrap() để phát hiện migration hỏng.
export default function setup() {
  const backendRoot = path.resolve(__dirname, "..");
  const testDir = path.join(backendRoot, "data", "test");
  const dbFile = path.join(testDir, "test.db");
  fs.rmSync(testDir, { recursive: true, force: true });
  fs.mkdirSync(testDir, { recursive: true });

  execFileSync(
    process.execPath,
    [path.join(backendRoot, "node_modules", "prisma", "build", "index.js"), "migrate", "deploy", "--schema", path.join(backendRoot, "prisma", "schema.prisma")],
    { cwd: backendRoot, env: { ...process.env, DATABASE_URL: `file:${dbFile}` }, stdio: "pipe" }
  );
}
