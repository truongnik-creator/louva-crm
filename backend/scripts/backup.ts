/**
 * Sao lưu CSDL + kho tệp mã hoá + khoá mã hoá (T1).
 *
 *   cd backend && npx tsx scripts/backup.ts                 bản hằng ngày, giữ 14 bản
 *   cd backend && npx tsx scripts/backup.ts --kind thu-cong  bản thủ công (giữ riêng)
 *   cd backend && npx tsx scripts/backup.ts --no-key         không chép khoá (khoá sao lưu riêng)
 *
 * Biến môi trường: BACKUP_DIR (mặc định backend/backups), BACKUP_KEEP (mặc định 14).
 * Chạy được khi server đang mở: dùng VACUUM INTO nên bản chụp luôn nhất quán.
 * Lịch hằng ngày: xem mục "Sao lưu và khôi phục" trong README.
 */
import { createBackup, type BackupKind } from "../src/lib/backup";
import { prisma } from "../src/lib/prisma";
import { env } from "../src/lib/env";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const kind = (arg("kind") ?? "hang-ngay") as BackupKind;
  if (!["hang-ngay", "thu-cong", "truoc-migrate"].includes(kind)) {
    throw new Error(`--kind phải là hang-ngay | thu-cong | truoc-migrate`);
  }
  const keep = Number(arg("keep") ?? env.backupKeep);
  const result = await createBackup({
    kind,
    keep,
    includeKey: !process.argv.includes("--no-key"),
    includeStorage: !process.argv.includes("--no-storage"),
  });
  console.log(`Đã sao lưu vào ${result.folder}`);
  console.log(`  Thành phần: ${result.files.join(", ")}`);
  if (result.pruned.length) console.log(`  Đã xoá ${result.pruned.length} bản cũ (giữ ${keep} bản ${kind})`);
}

main()
  .catch((err) => {
    console.error("Sao lưu thất bại:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
