import { prisma } from "../src/lib/prisma";
import { migrateLegacyStages } from "../src/lib/stage-migration";
import { getClinicMode } from "../src/lib/stages";

/**
 * F1: chuyển bước khách từ bộ cũ (MOI, LIENHE, HEN, DEN, CHOT, PT, HAUPHAU,
 * HOANTAT, TAIMUA, MAT) sang bộ 7 bước phòng khám tiêm.
 *
 *   npx tsx scripts/migrate-stages.ts          xem trước, không ghi gì
 *   npx tsx scripts/migrate-stages.ts --yes    chuyển thật (ghi StageHistory nguồn MIGRATION)
 *
 * Chỉ chạy khi Cài đặt clinic.mode = INJECTION (thêm --force để bỏ qua kiểm tra).
 * Nên sao lưu trước: npm run backup.
 */
async function main() {
  const apply = process.argv.includes("--yes");
  const force = process.argv.includes("--force");
  const mode = await getClinicMode();
  if (mode !== "INJECTION" && !force) {
    console.error(`Chế độ phòng khám đang là ${mode}. Bộ bước phẫu thuật giữ nguyên, không chuyển. Thêm --force nếu chắc chắn.`);
    process.exitCode = 1;
    return;
  }
  const result = await migrateLegacyStages({ apply });
  console.log(`${apply ? "Đã chuyển" : "Sẽ chuyển"} ${result.total} khách:`);
  for (const [k, v] of Object.entries(result.byMapping)) console.log(`  ${k}: ${v}`);
  if (!apply) console.log("Chạy lại với --yes để ghi thật.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
