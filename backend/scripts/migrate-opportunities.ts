import { prisma } from "../src/lib/prisma";
import { createBackup } from "../src/lib/backup";
import { migrateCustomersToOpportunities, currentOpportunity } from "../src/lib/opportunities";
import { getClinicMode, stagesFor } from "../src/lib/stages";

/**
 * Lô 8 · P6: chuyển dữ liệu sang pipeline theo cơ hội.
 *
 *   npx tsx scripts/migrate-opportunities.ts          xem trước, không ghi gì
 *   npx tsx scripts/migrate-opportunities.ts --yes    chuyển thật (tự sao lưu trước, kiểu truoc-migrate)
 *   thêm --no-backup                                  bỏ sao lưu (chỉ dùng trên bản sao CSDL)
 *
 * Mỗi khách chưa có cơ hội thành ĐÚNG MỘT cơ hội mang bước hiện tại, gắn toàn bộ
 * lịch sử bước cũ. Customer.stage không đổi nên báo cáo, lương, tự động hoá ra
 * cùng kết quả. Chạy lại bao nhiêu lần cũng được. Hồ sơ đã gộp vào hồ sơ khác bỏ qua.
 *
 * Khách còn bước của bộ bước cũ (phẫu thuật) khi đang ở chế độ tiêm: script dừng,
 * chạy scripts/migrate-stages.ts --yes trước (thêm --force để bỏ qua).
 *
 * Chạy trên BẢN SAO trước: DATABASE_URL="file:/đường/dẫn/ban-sao.db" npx tsx scripts/migrate-opportunities.ts --yes --no-backup
 */
async function main() {
  const apply = process.argv.includes("--yes");
  const mode = await getClinicMode();
  // Khách còn bước của bộ bước khác (ví dụ bộ phẫu thuật cũ khi đang ở chế độ tiêm):
  // trạng thái thắng/mất của cơ hội sẽ tính sai. Chạy scripts/migrate-stages.ts trước.
  const validKeys = stagesFor(mode).map((s) => s.key);
  const foreign = await prisma.customer.groupBy({ by: ["stage"], where: { mergedIntoId: null, stage: { notIn: validKeys } }, _count: true });
  if (foreign.length) {
    console.log(`CẢNH BÁO: ${foreign.reduce((s, r) => s + r._count, 0)} khách đang ở bước không thuộc chế độ ${mode}: ${foreign.map((r) => `${r.stage} (${r._count})`).join(", ")}.`);
    console.log("  Chạy trước: npx tsx scripts/migrate-stages.ts --yes (chuyển bộ bước), rồi chạy lại script này.");
    if (apply && !process.argv.includes("--force")) {
      console.log("  Dừng, không ghi gì. Thêm --force nếu chắc chắn muốn tạo cơ hội với bước cũ.");
      process.exitCode = 3;
      return;
    }
  }
  const stageCountsBefore = await prisma.customer.groupBy({ by: ["stage"], _count: true });

  if (apply && !process.argv.includes("--no-backup")) {
    const b = await createBackup({ kind: "truoc-migrate", keep: 10, includeKey: false, includeStorage: false });
    console.log(`Đã sao lưu CSDL vào ${b.folder}`);
  }

  const plan = await migrateCustomersToOpportunities({ apply, mode });
  console.log(`Chế độ phòng khám: ${mode}`);
  console.log(`Khách trong CSDL: ${plan.customers}`);
  console.log(`  Đã có cơ hội (bỏ qua): ${plan.alreadyHave}`);
  console.log(`  Hồ sơ đã gộp (bỏ qua): ${plan.skippedMerged}`);
  console.log(`  ${apply ? "Đã tạo" : "Sẽ tạo"} cơ hội: ${apply ? plan.created : plan.toCreate}`);
  console.log(`  Dòng lịch sử bước ${apply ? "đã" : "sẽ"} gắn vào cơ hội: ${plan.historyRowsToAttach}`);
  console.log("  Theo bước:");
  for (const [k, v] of Object.entries(plan.byStage)) console.log(`    ${k}: ${v}`);
  console.log("  Theo trạng thái cơ hội:");
  for (const [k, v] of Object.entries(plan.byStatus)) console.log(`    ${k}: ${v}`);

  if (!apply) {
    console.log("Chạy lại với --yes để ghi thật.");
    return;
  }

  // Kiểm tra sau khi chuyển: bước khách không đổi, mọi khách (chưa gộp) có cơ hội, bước khách = cơ hội hiện tại.
  const stageCountsAfter = await prisma.customer.groupBy({ by: ["stage"], _count: true });
  const key = (rows: Array<{ stage: string; _count: number }>) => JSON.stringify([...rows].sort((a, b) => a.stage.localeCompare(b.stage)));
  const sameStages = key(stageCountsBefore) === key(stageCountsAfter);
  const without = await prisma.customer.count({ where: { mergedIntoId: null, opportunities: { none: {} } } });
  const sample = await prisma.customer.findMany({ where: { mergedIntoId: null }, select: { id: true, stage: true }, take: 5000 });
  let mismatch = 0;
  for (const c of sample) {
    const o = await currentOpportunity(c.id);
    if (o && o.stage !== c.stage) mismatch++;
  }
  console.log(`Kiểm tra: số khách theo bước ${sameStages ? "KHÔNG ĐỔI" : "BỊ ĐỔI (cần xem lại)"}; khách chưa có cơ hội: ${without}; lệch bước (5.000 khách đầu): ${mismatch}`);
  if (!sameStages || without || mismatch) process.exitCode = 2;
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
