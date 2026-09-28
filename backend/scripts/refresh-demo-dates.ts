import { prisma } from "../src/lib/prisma";

/**
 * Dời dữ liệu demo sang HÔM NAY.
 *
 * Seed tạo lịch hẹn / ca mổ / check-in theo ngày chạy seed. Sau vài ngày, mở
 * app lên thấy lịch trống — không phải lỗi, nhưng nhìn như hỏng khi demo.
 * Script này dịch toàn bộ mốc thời gian đi đúng số ngày chênh lệch, giữ nguyên
 * giờ trong ngày và giữ nguyên tài khoản người dùng.
 *
 *   npx tsx scripts/refresh-demo-dates.ts
 */

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/**
 * Xếp lại hàng đợi lễ tân theo thời điểm chạy.
 *
 * Dịch nguyên số ngày sẽ giữ lại giờ buổi tối của lần seed và đẩy check-in sang
 * tương lai — màn hàng đợi khi đó hiện "chờ -520 phút". Hàm này đặt lại mốc
 * theo số phút trước HIỆN TẠI, giữ đúng thứ tự vào trước/vào sau.
 */
async function requeueVisits(): Promise<number> {
  const visits = await prisma.visit.findMany({ orderBy: { queueNumber: "asc" } });
  const now = Date.now();

  for (let i = 0; i < visits.length; i++) {
    const v = visits[i];
    // Người vào trước chờ lâu hơn: 95, 55, 18 phút…
    const waited = [95, 55, 18][i] ?? 10 + i * 7;
    const checkedInAt = new Date(now - waited * 60000);
    await prisma.visit.update({
      where: { id: v.id },
      data: {
        checkedInAt,
        calledAt: v.calledAt ? new Date(checkedInAt.getTime() + 12 * 60000) : null,
        finishedAt: v.finishedAt ? new Date(now - 60000) : null,
      },
    });
  }
  return visits.length;
}

async function main() {
  const anchor = await prisma.appointment.findFirst({ orderBy: { startAt: "asc" } });
  if (!anchor) {
    console.log("Không có lịch hẹn nào để dời.");
    return;
  }

  const today = startOfDay(new Date());
  const seedDay = startOfDay(anchor.startAt);
  const shiftMs = today.getTime() - seedDay.getTime();

  // Hàng đợi luôn xếp lại theo thời điểm chạy, kể cả khi không phải dời ngày:
  // nó phải nằm trong quá khứ so với "bây giờ", không phải so với hôm nay.
  const requeued = await requeueVisits();

  if (shiftMs === 0) {
    console.log(`Dữ liệu demo đã ở hôm nay. Đã xếp lại ${requeued} lượt check-in theo giờ hiện tại.`);
    return;
  }

  const days = Math.round(shiftMs / 86400000);
  const shift = (d: Date | null) => (d ? new Date(d.getTime() + shiftMs) : null);

  let counts: Record<string, number> = {};

  const appointments = await prisma.appointment.findMany();
  for (const a of appointments) {
    await prisma.appointment.update({
      where: { id: a.id },
      data: { startAt: shift(a.startAt)!, endAt: shift(a.endAt)! },
    });
  }
  counts["lịch hẹn"] = appointments.length;

  const procedures = await prisma.procedureRecord.findMany();
  for (const p of procedures) {
    await prisma.procedureRecord.update({
      where: { id: p.id },
      data: {
        scheduledAt: shift(p.scheduledAt)!,
        startedAt: shift(p.startedAt),
        finishedAt: shift(p.finishedAt),
      },
    });
  }
  counts["ca mổ"] = procedures.length;

  counts["lượt check-in"] = requeued;

  // Tin nhắn, hợp đồng, phiếu thu dời theo để dashboard và hộp thư vẫn khớp kỳ.
  const messages = await prisma.chatMessage.findMany();
  for (const m of messages) {
    await prisma.chatMessage.update({ where: { id: m.id }, data: { createdAt: shift(m.createdAt)! } });
  }
  counts["tin nhắn"] = messages.length;

  const conversations = await prisma.conversation.findMany();
  for (const c of conversations) {
    await prisma.conversation.update({
      where: { id: c.id },
      data: { lastMessageAt: shift(c.lastMessageAt) },
    });
  }

  const contracts = await prisma.contract.findMany();
  for (const c of contracts) {
    await prisma.contract.update({ where: { id: c.id }, data: { signedAt: shift(c.signedAt) } });
  }
  counts["hợp đồng"] = contracts.length;

  const payments = await prisma.payment.findMany();
  for (const p of payments) {
    await prisma.payment.update({ where: { id: p.id }, data: { paidAt: shift(p.paidAt)! } });
  }
  counts["phiếu thu"] = payments.length;

  const invoices = await prisma.invoice.findMany();
  for (const i of invoices) {
    await prisma.invoice.update({
      where: { id: i.id },
      data: { dueDate: shift(i.dueDate), issuedAt: shift(i.issuedAt) },
    });
  }
  counts["hoá đơn"] = invoices.length;

  const costs = await prisma.campaignCost.findMany();
  for (const c of costs) {
    await prisma.campaignCost.update({ where: { id: c.id }, data: { date: shift(c.date)! } });
  }

  const leads = await prisma.lead.findMany();
  for (const l of leads) {
    await prisma.lead.update({ where: { id: l.id }, data: { createdAt: shift(l.createdAt)! } });
  }

  console.log(`Đã dời dữ liệu demo tiến ${days} ngày về hôm nay:`);
  for (const [k, v] of Object.entries(counts)) console.log(`  ${k}: ${v}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
