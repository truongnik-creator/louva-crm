import fs from "node:fs";
import path from "node:path";
import { prisma } from "./prisma";
import { env, BACKEND_ROOT, encryptionKeyFilePath } from "./env";
import { logger } from "./logger";

// Sao lưu CSDL SQLite + kho tệp mã hoá + khoá mã hoá (T1).
//
// Dùng `VACUUM INTO` thay vì chép tệp .db: chép tệp khi server đang ghi (WAL)
// cho ra bản hỏng; VACUUM INTO chụp một ảnh nhất quán ngay trong giao dịch đọc
// và nén luôn trang trống. Chạy được khi server vẫn đang phục vụ.

export function sqliteFilePath(url = env.databaseUrl): string | null {
  if (!url.startsWith("file:")) return null;
  const raw = url.slice("file:".length).split("?")[0];
  return path.isAbsolute(raw) ? raw : path.resolve(BACKEND_ROOT, "prisma", raw);
}

export function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** Chụp CSDL ra một tệp .db độc lập (không được tồn tại trước). */
export async function snapshotDatabase(target: string): Promise<void> {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (fs.existsSync(target)) fs.unlinkSync(target);
  const escaped = target.replace(/'/g, "''");
  await prisma.$executeRawUnsafe(`VACUUM INTO '${escaped}'`);
}

export type BackupKind = "hang-ngay" | "truoc-migrate" | "thu-cong";

export interface BackupOptions {
  kind: BackupKind;
  dir?: string;
  includeStorage?: boolean;
  includeKey?: boolean;
  keep?: number;
}

export interface BackupResult {
  folder: string;
  files: string[];
  pruned: string[];
}

/**
 * Tạo một bản sao lưu dạng thư mục `louva-<kind>-<YYYYMMDD-HHmmss>/`:
 *   crm.db           ảnh CSDL nhất quán
 *   storage/         ảnh, chữ ký đã mã hoá (chép nguyên, vẫn là bản mã)
 *   enc-key          khoá mã hoá (nếu khoá nằm trong tệp)
 *   manifest.json    thông tin để khôi phục
 * Sau đó xoá bớt bản cũ cùng loại, giữ lại `keep` bản mới nhất.
 */
export async function createBackup(opts: BackupOptions): Promise<BackupResult> {
  const dir = path.resolve(opts.dir ?? env.backupDir);
  const includeStorage = opts.includeStorage ?? true;
  const includeKey = opts.includeKey ?? true;
  const keep = opts.keep ?? env.backupKeep;

  // Hai lần chạy trong cùng một giây không được ghi đè lên nhau.
  let folder = path.join(dir, `louva-${opts.kind}-${stamp()}`);
  for (let i = 2; fs.existsSync(folder); i++) folder = path.join(dir, `louva-${opts.kind}-${stamp()}-${i}`);
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  const files: string[] = [];

  await snapshotDatabase(path.join(folder, "crm.db"));
  files.push("crm.db");

  if (includeStorage && fs.existsSync(env.storageDir)) {
    fs.cpSync(env.storageDir, path.join(folder, "storage"), { recursive: true });
    files.push("storage/");
  }

  const keyFile = encryptionKeyFilePath();
  let keySource = "ENCRYPTION_KEY (biến môi trường, KHÔNG nằm trong bản sao lưu)";
  if (keyFile) {
    keySource = keyFile;
    if (includeKey && fs.existsSync(keyFile)) {
      fs.copyFileSync(keyFile, path.join(folder, "enc-key"));
      fs.chmodSync(path.join(folder, "enc-key"), 0o600);
      files.push("enc-key");
    }
  }

  fs.writeFileSync(
    path.join(folder, "manifest.json"),
    JSON.stringify(
      {
        createdAt: new Date().toISOString(),
        kind: opts.kind,
        databaseFile: sqliteFilePath(),
        storageDir: env.storageDir,
        keySource,
        files,
      },
      null,
      2
    )
  );

  const pruned = pruneBackups(dir, opts.kind, keep);
  return { folder, files, pruned };
}

/** Xoá bản sao lưu cũ cùng loại, giữ `keep` bản mới nhất (tên có dấu thời gian nên sắp xếp chữ là đủ). */
export function pruneBackups(dir: string, kind: BackupKind, keep: number): string[] {
  if (!fs.existsSync(dir) || keep < 1) return [];
  const prefix = `louva-${kind}-`;
  const all = fs
    .readdirSync(dir)
    .filter((n) => n.startsWith(prefix) && fs.statSync(path.join(dir, n)).isDirectory())
    .sort();
  const toRemove = all.slice(0, Math.max(0, all.length - keep));
  for (const name of toRemove) fs.rmSync(path.join(dir, name), { recursive: true, force: true });
  return toRemove;
}

/**
 * Có migration nào CHƯA áp vào CSDL hiện có không. CSDL mới tinh (chưa có tệp
 * hoặc chưa có bảng _prisma_migrations) trả false: không có gì để mất.
 */
export async function hasPendingMigrations(migrationsDir: string): Promise<boolean> {
  const dbFile = sqliteFilePath();
  if (!dbFile || !fs.existsSync(dbFile) || fs.statSync(dbFile).size === 0) return false;
  const available = fs
    .readdirSync(migrationsDir)
    .filter((n) => fs.statSync(path.join(migrationsDir, n)).isDirectory());
  try {
    const rows = await prisma.$queryRawUnsafe<Array<{ migration_name: string }>>(
      `SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`
    );
    const applied = new Set(rows.map((r) => r.migration_name));
    return available.some((n) => !applied.has(n));
  } catch {
    return false; // chưa có bảng _prisma_migrations: CSDL rỗng
  }
}

/** T1: gọi trong bootstrap ngay trước `migrate deploy`. */
export async function backupBeforeMigrate(migrationsDir: string): Promise<string | null> {
  if (process.env.SKIP_PREMIGRATE_BACKUP === "1") return null;
  if (!(await hasPendingMigrations(migrationsDir))) return null;
  const result = await createBackup({ kind: "truoc-migrate", includeStorage: false, keep: 5 });
  logger.warn({ folder: result.folder }, "Có migration mới: đã sao lưu CSDL trước khi áp");
  return result.folder;
}
