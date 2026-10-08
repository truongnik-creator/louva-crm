import crypto from "node:crypto";
import { describe, it, expect, beforeAll } from "vitest";
import { setupTestContext, prisma, type TestContext, type TestUser } from "./helpers";
import { resolvePeriod } from "../src/lib/report-scope";
import { vnDayKey } from "../src/lib/datetime";

// Lô 2: B1, B2, B4, B5, B8 (+ B6, B7 gián tiếp). Mỗi nhóm test dùng MỘT cơ sở
// riêng tạo trong test và gọi báo cáo với ?branchId=, nên dữ liệu các tệp test
// khác trong cùng CSDL không lẫn vào con số.

const DAY = 86_400_000;
const uid = () => crypto.randomBytes(4).toString("hex");

let ctx: TestContext;
let boss: TestUser;

async function makeBranch(): Promise<string> {
  const code = `RP_${uid()}`.toUpperCase();
  const b = await prisma.branch.create({ data: { code, name: `Cơ sở ${code}` } });
  await prisma.userBranch.create({ data: { userId: boss.id, branchId: b.id } });
  return b.id;
}

async function customerIn(branchId: string, data: { channelId?: string; createdAt?: Date } = {}) {
  return prisma.customer.create({
    data: {
      code: `KH-RP-${uid()}`,
      name: `Khách báo cáo ${uid()}`,
      channelId: data.channelId ?? null,
      ...(data.createdAt ? { createdAt: data.createdAt } : {}),
      branchLinks: { create: { branchId, isPrimary: true } },
    },
  });
}

async function contract(
  branchId: string,
  customerId: string,
  total: number,
  opts: { status?: string; signedAt?: Date } = {}
) {
  return prisma.contract.create({
    data: {
      code: `DH-RP-${uid()}`,
      branchId,
      customerId,
      status: opts.status ?? "SIGNED",
      subtotal: total,
      total,
      signedAt: opts.signedAt ?? new Date(),
    },
  });
}

async function payment(branchId: string, customerId: string, amount: number, paidAt = new Date(), contractId?: string) {
  return prisma.payment.create({
    data: { code: `PT-RP-${uid()}`, branchId, customerId, amount, paidAt, contractId: contractId ?? null },
  });
}

/** Khoảng ±2 ngày quanh hiện tại, viết dạng ngày để đi qua nhánh parseBoundary (giờ VN). */
function around() {
  return { from: vnDayKey(new Date(Date.now() - 2 * DAY)), to: vnDayKey(new Date(Date.now() + 2 * DAY)) };
}

beforeAll(async () => {
  ctx = await setupTestContext("reports");
  boss = await ctx.createUser("GIAM_DOC");
});

describe("B4: kỳ báo cáo và gom ngày theo giờ Việt Nam", () => {
  it("resolvePeriod lấy mốc đầu ngày, đầu tháng theo UTC+7", () => {
    // 18:30 UTC ngày 10/03 = 01:30 sáng 11/03 giờ Việt Nam.
    const now = new Date("2026-03-10T18:30:00Z");
    const today = resolvePeriod({ period: "today" }, now);
    expect(today.from.toISOString()).toBe("2026-03-10T17:00:00.000Z");
    expect(today.to.toISOString()).toBe("2026-03-11T17:00:00.000Z");

    // 20:00 UTC ngày 31/03 = 03:00 ngày 01/04 giờ VN: tháng này là tháng 4.
    const month = resolvePeriod({ period: "month" }, new Date("2026-03-31T20:00:00Z"));
    expect(month.from.toISOString()).toBe("2026-03-31T17:00:00.000Z");

    const custom = resolvePeriod({ from: "2026-03-01", to: "2026-03-08" });
    expect(custom.from.toISOString()).toBe("2026-02-28T17:00:00.000Z");
    expect(custom.prevTo.toISOString()).toBe(custom.from.toISOString());
  });

  it("tiền thu lúc 01:30 sáng giờ VN rơi vào đúng ngày VN, không lùi về hôm trước", async () => {
    const branchId = await makeBranch();
    const c = await customerIn(branchId);
    await payment(branchId, c.id, 1_500_000, new Date("2026-03-10T18:30:00Z"));

    const res = await ctx
      .as(boss)
      .get("/api/reports/dashboard")
      .query({ branchId, from: "2026-03-10", to: "2026-03-12" });
    expect(res.status).toBe(200);
    expect(res.body.daily).toEqual([{ date: "2026-03-11", signed: 0, collected: 1_500_000 }]);
  });
});

describe("B1: hợp đồng đã huỷ không vào doanh số", () => {
  it("dashboard, doanh thu theo cơ sở và top dịch vụ bỏ hợp đồng huỷ", async () => {
    const branchId = await makeBranch();
    const c = await customerIn(branchId);
    const ok = await contract(branchId, c.id, 10_000_000);
    const cancelled = await contract(branchId, c.id, 5_000_000, { status: "CANCELLED" });
    await prisma.contractItem.createMany({
      data: [
        { contractId: ok.id, name: "Filler cằm", unitPrice: 10_000_000, amount: 10_000_000 },
        { contractId: cancelled.id, name: "Botox", unitPrice: 5_000_000, amount: 5_000_000 },
      ],
    });

    const dash = await ctx.as(boss).get("/api/reports/dashboard").query({ branchId, ...around() });
    expect(dash.status).toBe(200);
    const signed = dash.body.kpis.find((k: { label: string }) => k.label === "Doanh số ký");
    expect(signed.value).toBe(10_000_000);
    expect(dash.body.topServices.map((s: { name: string }) => s.name)).toEqual(["Filler cằm"]);

    const byBranch = await ctx.as(boss).get("/api/reports/revenue").query({ branchId, groupBy: "branch", ...around() });
    expect(byBranch.body).toHaveLength(1);
    expect(byBranch.body[0].revenue).toBe(10_000_000);
    expect(byBranch.body[0].count).toBe(1);
  });

  it("top dịch vụ gom theo serviceId dù tên dòng khác nhau", async () => {
    const branchId = await makeBranch();
    const c = await customerIn(branchId);
    const svc = await prisma.service.create({ data: { code: `SV-${uid()}`, name: "Filler (danh mục)" } });
    const k1 = await contract(branchId, c.id, 3_000_000);
    const k2 = await contract(branchId, c.id, 4_000_000);
    await prisma.contractItem.createMany({
      data: [
        { contractId: k1.id, serviceId: svc.id, name: "filler môi", unitPrice: 3_000_000, amount: 3_000_000 },
        { contractId: k2.id, serviceId: svc.id, name: "Filler Môi (KM)", unitPrice: 4_000_000, amount: 4_000_000 },
      ],
    });
    const res = await ctx.as(boss).get("/api/reports/revenue").query({ branchId, groupBy: "service", ...around() });
    expect(res.body).toEqual([{ key: "Filler (danh mục)", serviceId: svc.id, revenue: 7_000_000, count: 2 }]);
  });
});

describe("B2 + B6: doanh thu theo kênh", () => {
  it("groupBy=channel gom theo kênh nguồn của khách, thực thu là tiền thu trong kỳ", async () => {
    const branchId = await makeBranch();
    const ch = await prisma.channel.create({ data: { key: `tt-${uid()}`, name: `TikTok ${uid()}`, kind: "TIKTOK" } });
    const fromTiktok = await customerIn(branchId, { channelId: ch.id });
    const unknown = await customerIn(branchId);
    const k = await contract(branchId, fromTiktok.id, 12_000_000);
    await contract(branchId, unknown.id, 3_000_000);
    // Thu 4 triệu trong kỳ + 2 triệu từ 40 ngày trước (ngoài kỳ, không được tính).
    await payment(branchId, fromTiktok.id, 4_000_000, new Date(), k.id);
    await payment(branchId, fromTiktok.id, 2_000_000, new Date(Date.now() - 40 * DAY), k.id);

    const res = await ctx.as(boss).get("/api/reports/revenue").query({ branchId, groupBy: "channel", ...around() });
    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      { key: ch.name, channelId: ch.id, revenue: 12_000_000, collected: 4_000_000, count: 1 },
      { key: "Không rõ nguồn", channelId: null, revenue: 3_000_000, collected: 0, count: 1 },
    ]);
  });
});

describe("B5: báo cáo lọc theo cơ sở", () => {
  it("khách mới, phễu và ROAS theo kênh chỉ tính cơ sở được chọn", async () => {
    const mine = await makeBranch();
    const other = await makeBranch();
    const ch = await prisma.channel.create({ data: { key: `fb-${uid()}`, name: `Facebook ${uid()}`, kind: "FACEBOOK" } });

    await customerIn(mine);
    await customerIn(mine);
    await customerIn(other);
    await prisma.lead.createMany({
      data: [
        { name: "Lead cơ sở mình", branchId: mine, channelId: ch.id },
        { name: "Lead cơ sở khác", branchId: other, channelId: ch.id },
        { name: "Lead cơ sở khác 2", branchId: other, channelId: ch.id },
      ],
    });

    const dash = await ctx.as(boss).get("/api/reports/dashboard").query({ branchId: mine, ...around() });
    const newCustomers = dash.body.kpis.find((k: { label: string }) => k.label === "Khách mới");
    expect(newCustomers.value).toBe(2);
    expect(dash.body.funnel[0].count).toBe(2);

    const roas = await ctx.as(boss).get("/api/reports/channel-roas").query({ branchId: mine, ...around() });
    const row = roas.body.find((r: { channelId: string }) => r.channelId === ch.id);
    expect(row.leads).toBe(1);

    const roasOther = await ctx.as(boss).get("/api/reports/channel-roas").query({ branchId: other, ...around() });
    expect(roasOther.body.find((r: { channelId: string }) => r.channelId === ch.id).leads).toBe(2);
  });
});

describe("B7: công nợ so với số dư đầu kỳ", () => {
  it("hoá đơn đã trả xong trong kỳ vẫn là nợ ở đầu kỳ", async () => {
    const branchId = await makeBranch();
    const c = await customerIn(branchId);
    const inv = await prisma.invoice.create({
      data: {
        code: `HD-RP-${uid()}`,
        branchId,
        customerId: c.id,
        amount: 8_000_000,
        paidAmount: 8_000_000,
        status: "PAID",
        createdAt: new Date(Date.now() - 30 * DAY),
      },
    });
    await prisma.payment.create({
      data: { code: `PT-RP-${uid()}`, branchId, customerId: c.id, invoiceId: inv.id, amount: 8_000_000 },
    });
    const res = await ctx.as(boss).get("/api/reports/dashboard").query({ branchId, ...around() });
    const debt = res.body.kpis.find((k: { label: string }) => k.label === "Công nợ còn lại");
    expect(debt.value).toBe(0);
    expect(debt.delta.value).toBe(-8_000_000);
  });
});

describe("B8: tỉ lệ không đến", () => {
  it("mẫu số chỉ gồm lịch đã tới giờ và không tính lịch huỷ", async () => {
    const branchId = await makeBranch();
    const c = await customerIn(branchId);
    const at = (h: number) => ({ startAt: new Date(Date.now() + h * 3600_000), endAt: new Date(Date.now() + (h + 1) * 3600_000) });
    await prisma.appointment.createMany({
      data: [
        { branchId, customerId: c.id, title: "Vắng", status: "NO_SHOW", ...at(-5) },
        { branchId, customerId: c.id, title: "Đã làm", status: "DONE", ...at(-4) },
        { branchId, customerId: c.id, title: "Huỷ", status: "CANCELLED", ...at(-3) },
        { branchId, customerId: c.id, title: "Tương lai", status: "PENDING", ...at(20) },
      ],
    });
    const res = await ctx.as(boss).get("/api/reports/clinic-operations").query({ branchId, ...around() });
    expect(res.status).toBe(200);
    expect(res.body.appointments.total).toBe(4);
    expect(res.body.appointments.noShowBase).toBe(2);
    expect(res.body.appointments.noShowRate).toBe(50);
  });

  it("B9: công suất theo bác sĩ dùng giờ bắt đầu, kết thúc thật", async () => {
    const branchId = await makeBranch();
    const c = await customerIn(branchId);
    const start = new Date(Date.now() - 3 * 3600_000);
    await prisma.procedureRecord.create({
      data: {
        code: `PM-RP-${uid()}`,
        branchId,
        customerId: c.id,
        title: "Tiêm filler",
        surgeonId: boss.id,
        status: "COMPLETED",
        scheduledAt: start,
        durationMin: 60,
        startedAt: start,
        finishedAt: new Date(start.getTime() + 90 * 60_000),
      },
    });
    const res = await ctx.as(boss).get("/api/reports/clinic-operations").query({ branchId, ...around() });
    const mine = res.body.capacityByDoctor.find((d: { doctorId: string }) => d.doctorId === boss.id);
    expect(mine.minutes).toBe(90);
    expect(res.body.capacityByBranch[0].minutes).toBe(90);
  });
});
