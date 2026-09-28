import { prisma } from "../src/lib/prisma";

/**
 * Bổ sung dữ liệu DEMO cho các bộ phận mà bảng hiệu suất chưa đo được:
 * chấm công, KPI điều dưỡng, và lễ tân đã tiếp đón lượt nào.
 *
 *   npx tsx scripts/seed-hieu-suat.ts
 *
 * Chạy được nhiều lần: mọi thứ đều upsert theo khoá tự nhiên. Script CHỈ đụng
 * vào bảng chấm công / KPI / cột receptionist của phiếu tiếp đón — không chạm
 * tới bệnh án, hợp đồng hay sổ kho.
 */

const NURSING_KPIS = [
  { code: "ND_CHAM_SOC_HAU_PHAU", name: "Lượt chăm sóc hậu phẫu", unit: "số", higherIsBetter: true },
  { code: "ND_TAI_KHAM_DUNG_HEN", name: "Tái khám đúng hẹn", unit: "%", higherIsBetter: true },
  { code: "ND_SU_CO_VO_KHUAN", name: "Sự cố vô khuẩn", unit: "số", higherIsBetter: false },
  { code: "ND_HAI_LONG", name: "Điểm hài lòng khách", unit: "số", higherIsBetter: true },
];

/** Giá trị demo cho từng điều dưỡng, theo thứ tự NURSING_KPIS. */
const NURSE_VALUES = [
  [42, 93, 0, 92],
  [31, 78, 2, 84],
];

function workingDaysBack(count: number): Date[] {
  const days: Date[] = [];
  const cur = new Date();
  cur.setHours(0, 0, 0, 0);
  while (days.length < count) {
    cur.setDate(cur.getDate() - 1);
    if (cur.getDay() !== 0) days.push(new Date(cur));
  }
  return days;
}

async function main() {
  const branch = await prisma.branch.findFirst();
  if (!branch) throw new Error("Chưa có cơ sở nào — chạy seed chính trước.");

  /* --- 1. Lễ tân: gán người tiếp đón cho các phiếu tạo trước bản cập nhật --- */
  const receptionists = await prisma.user.findMany({
    where: { status: "ACTIVE", roleLinks: { some: { role: { code: "LE_TAN" } } } },
    select: { id: true, name: true },
  });
  let assignedVisits = 0;
  if (receptionists.length) {
    const orphan = await prisma.visit.findMany({
      where: { receptionistId: null },
      select: { id: true },
    });
    for (let i = 0; i < orphan.length; i++) {
      await prisma.visit.update({
        where: { id: orphan[i].id },
        data: { receptionistId: receptionists[i % receptionists.length].id },
      });
      assignedVisits++;
    }
  }

  /* --- 2. Chấm công 20 ngày gần nhất cho nhân sự vận hành --- */
  const staff = await prisma.user.findMany({
    where: {
      status: "ACTIVE",
      roleLinks: {
        some: { role: { code: { in: ["DIEU_DUONG", "BAC_SI", "LE_TAN", "KHO"] } } },
      },
    },
    select: { id: true, name: true },
  });
  const days = workingDaysBack(20);

  let attendances = 0;
  for (const [si, u] of staff.entries()) {
    for (const [di, date] of days.entries()) {
      // Nghỉ rải rác và đi muộn rải rác để bảng hiệu suất có chênh lệch thật,
      // không phải ai cũng một con số giống nhau.
      const absent = (si * 7 + di * 3) % 19 === 0;
      const late = (si * 5 + di * 2) % 11 === 0 ? ((si + di) % 3) * 6 + 5 : 0;
      const worked = absent ? 0 : 8 * 60 - late;

      await prisma.attendance.upsert({
        where: { userId_date: { userId: u.id, date } },
        update: {},
        create: {
          userId: u.id,
          branchId: branch.id,
          date,
          status: absent ? "ABSENT" : late ? "LATE" : "PRESENT",
          checkInAt: absent ? null : new Date(date.getTime() + (8 * 60 + late) * 60000),
          checkOutAt: absent ? null : new Date(date.getTime() + 17 * 60 * 60000),
          lateMinutes: late,
          workedMinutes: worked,
        },
      });
      attendances++;
    }
  }

  /* --- 3. Chỉ tiêu KPI nhóm điều dưỡng + số thực hiện tháng này --- */
  const now = new Date();
  const periodKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

  const defs = [];
  for (const k of NURSING_KPIS) {
    defs.push(
      await prisma.kpiDefinition.upsert({
        where: { code: k.code },
        update: { name: k.name, group: "NURSING", unit: k.unit, higherIsBetter: k.higherIsBetter },
        create: { ...k, group: "NURSING" },
      })
    );
  }

  const nurses = await prisma.user.findMany({
    where: { status: "ACTIVE", roleLinks: { some: { role: { code: "DIEU_DUONG" } } } },
    select: { id: true, name: true },
  });

  let actuals = 0;
  for (const [ni, nurse] of nurses.entries()) {
    const values = NURSE_VALUES[ni % NURSE_VALUES.length];
    for (const [ki, def] of defs.entries()) {
      await prisma.kpiActual.upsert({
        where: { definitionId_userId_periodKey: { definitionId: def.id, userId: nurse.id, periodKey } },
        update: { actualValue: values[ki] },
        create: {
          definitionId: def.id,
          userId: nurse.id,
          branchId: branch.id,
          periodKey,
          actualValue: values[ki],
        },
      });
      actuals++;
    }
  }

  /* --- 4. Lead: đánh dấu lần liên hệ đầu cho một phần, để có chênh lệch --- */
  const leads = await prisma.lead.findMany({
    where: { firstContactAt: null, assignedToId: { not: null } },
    select: { id: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });
  let contacted = 0;
  for (const [i, l] of leads.entries()) {
    if (i % 3 === 2) continue; // cố ý bỏ sót 1/3 để cảnh báo "chưa liên hệ" còn tác dụng
    await prisma.lead.update({
      where: { id: l.id },
      data: { firstContactAt: new Date(l.createdAt.getTime() + (i % 5) * 45 * 60000 + 12 * 60000) },
    });
    contacted++;
  }

  console.log("=================================================");
  console.log(`Phiếu tiếp đón được gán lễ tân : ${assignedVisits}`);
  console.log(`Bản ghi chấm công              : ${attendances} (${staff.length} người × ${days.length} ngày)`);
  console.log(`Chỉ tiêu KPI điều dưỡng        : ${defs.length}`);
  console.log(`Số thực hiện KPI kỳ ${periodKey}   : ${actuals}`);
  console.log(`Lead được đánh dấu đã liên hệ  : ${contacted}/${leads.length}`);
  console.log("=================================================");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
