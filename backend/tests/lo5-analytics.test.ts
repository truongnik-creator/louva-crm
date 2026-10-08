import crypto from "node:crypto";
import ExcelJS from "exceljs";
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { setupTestContext, uniquePhone, prisma, type TestContext, type TestUser } from "./helpers";
import { bucketOf, computeRetention, forecast, forecastMath, monthProgress, usageCost } from "../src/lib/analytics";
import { parseAdCostCsv, parseCostAmount, importAdCosts } from "../src/lib/ad-costs";
import { RECEIPT_COLUMNS, LEDGER_COLUMNS } from "../src/lib/accounting-export";
import { startOfVnWeek, vnMonthRange, vnWeekKey } from "../src/lib/metrics";
import { scoreConversations } from "../src/lib/conversation-scoring";
import { setAiClientForTests, AI_MODELS, type AiClient, type AiRequest } from "../src/lib/ai";

// Lô 5: F15 chỉ số tuần + nhập chi phí, F22 lãi gộp, F23 quay lại, F31 tốc độ
// trả lời, F33 xuất kế toán, F34 dự báo, F29 trang chủ theo vai, AI4 chấm hội thoại.

const uid = () => crypto.randomBytes(4).toString("hex");
const TR = 1_000_000;
const DAY = 86_400_000;
const MIN = 60_000;

let ctx: TestContext;
let manager: TestUser;
let director: TestUser;
let marketing: TestUser;
let accountant: TestUser;
let sale: TestUser;

let q = 20000;
const visit = (customerId: string, at: Date) =>
  prisma.visit.create({ data: { branchId: ctx.branchId, customerId, queueNumber: ++q, checkedInAt: at, status: "DONE" } });
const pay = (customerId: string, amount: number, paidAt: Date, contractId: string | null = null, method = "CASH") =>
  prisma.payment.create({ data: { code: `PT-L5A-${uid()}`, branchId: ctx.branchId, customerId, contractId, amount, paidAt, method } });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function binary(res: any, cb: (err: Error | null, body: Buffer) => void) {
  const chunks: Buffer[] = [];
  res.on("data", (c: Buffer) => chunks.push(c));
  res.on("end", () => cb(null, Buffer.concat(chunks)));
}

beforeAll(async () => {
  ctx = await setupTestContext("lo5ana");
  manager = await ctx.createUser("QUAN_LY_CO_SO");
  director = await ctx.createUser("GIAM_DOC");
  marketing = await ctx.createUser("MARKETING");
  accountant = await ctx.createUser("KE_TOAN");
  sale = await ctx.createUser("TELESALE");
  await ctx.createUser("LE_TAN");
  await ctx.createUser("BAC_SI");
  await ctx.createUser("DIEU_DUONG");
});

afterEach(() => setAiClientForTests(undefined));

describe("F22: lãi gộp", () => {
  it("giá vốn lượng dùng lẻ: costAtUse, dữ liệu cũ thì đơn giá lô x lượng 0,1", () => {
    expect(usageCost({ costAtUse: 750_000, quantity: 1, quantityTenths: 5, lot: { unitCost: 1_500_000 } })).toBe(750_000);
    expect(usageCost({ costAtUse: null, quantity: 1, quantityTenths: 3, lot: { unitCost: 1_000_000 } })).toBe(300_000);
    expect(usageCost({ costAtUse: null, quantity: 2, quantityTenths: null, lot: { unitCost: 100_000 } })).toBe(200_000);
  });

  it("doanh thu một lần làm, giá vốn, hoa hồng phân bổ, lãi gộp theo dịch vụ", async () => {
    const range = vnMonthRange("2034-07");
    const at = new Date(range.gte.getTime() + 3 * DAY);
    const svc = await prisma.service.create({ data: { code: `SVL5${uid()}`.toUpperCase(), name: `Filler L5 ${uid()}`, kind: "INJECTION" } });
    const c = await ctx.createCustomer({ name: "Khách lãi gộp" });
    const ct = await prisma.contract.create({
      data: {
        code: `DH-L5A-${uid()}`, branchId: ctx.branchId, customerId: c.id, status: "SIGNED", signedAt: at, total: 10 * TR, subtotal: 10 * TR,
        items: { create: [{ serviceId: svc.id, name: "Filler 2 lần", quantity: 2, unitPrice: 5 * TR, amount: 10 * TR }] },
      },
    });
    await prisma.commissionEntry.create({ data: { userId: sale.id, branchId: ctx.branchId, contractId: ct.id, periodKey: "2034-07", amount: 1 * TR } });
    const proc = await prisma.procedureRecord.create({
      data: { code: `PM-L5-${uid()}`, branchId: ctx.branchId, customerId: c.id, serviceId: svc.id, contractId: ct.id, title: "Filler", status: "COMPLETED", scheduledAt: at, finishedAt: at },
    });
    const product = await prisma.product.create({ data: { code: `VT${uid()}`, name: "Filler ống" } });
    await prisma.productUsage.createMany({
      data: [
        { productId: product.id, procedureId: proc.id, customerId: c.id, branchId: ctx.branchId, quantity: 1, quantityTenths: 5, costAtUse: 750_000 },
        { productId: product.id, procedureId: proc.id, customerId: c.id, branchId: ctx.branchId, quantity: 1, quantityTenths: 3, costAtUse: 300_000 },
      ],
    });
    const res = await ctx.as(director).get("/api/analytics/margin?from=2034-07-01&to=2034-08-01&groupBy=service");
    expect(res.status).toBe(200);
    const row = res.body.rows.find((r: { key: string }) => r.key === svc.id);
    expect(row).toMatchObject({ count: 1, revenue: 5 * TR, cost: 1_050_000, commission: 500_000, grossMargin: 3_450_000, marginPercent: 69 });
    expect((await ctx.as(sale).get("/api/analytics/margin")).status).toBe(403);
  });
});

describe("F23: tỉ lệ quay lại theo nhóm tháng", () => {
  const t0 = new Date("2033-01-10T03:00:00Z");
  const d = (days: number, base = t0) => new Date(base.getTime() + days * DAY);
  const done = [
    { customerId: "c1", serviceId: "s1", at: t0 },
    { customerId: "c1", serviceId: "s1", at: d(60) },
    { customerId: "c2", serviceId: "s1", at: t0 },
    { customerId: "c2", serviceId: "s1", at: d(150) },
    { customerId: "c3", serviceId: "s1", at: t0 },
    { customerId: "c3", serviceId: "s1", at: d(300) },
    { customerId: "c4", serviceId: "s1", at: t0 },
    // Hai lần cùng ngày không phải "quay lại".
    { customerId: "c5", serviceId: "s1", at: d(10) },
    { customerId: "c5", serviceId: "s1", at: new Date(d(10).getTime() + 2 * 3_600_000) },
  ];
  it("đủ ngày: 90 ngày 20%, 180 ngày 40%, 365 ngày 60%", () => {
    const [row] = computeRetention(done, new Date("2034-06-01T00:00:00Z"));
    expect(row.cohort).toBe("2033-01");
    expect(row.customers).toBe(5);
    expect(row.d90).toEqual({ eligible: 5, returned: 1, rate: 20 });
    expect(row.d180).toEqual({ eligible: 5, returned: 2, rate: 40 });
    expect(row.d365).toEqual({ eligible: 5, returned: 3, rate: 60 });
  });
  it("chưa đủ N ngày thì không đưa vào mẫu số", () => {
    const [row] = computeRetention(done, new Date("2033-05-01T00:00:00Z"));
    expect(row.d90.eligible).toBe(5);
    expect(row.d180).toEqual({ eligible: 0, returned: 0, rate: null });
  });
});

describe("F31: tốc độ trả lời đầu tiên so với tỉ lệ có SĐT, đến, chốt", () => {
  it("biên nhóm: dưới 5 phút, 5 đến 30, trên 30, chưa trả lời", () => {
    expect(bucketOf(4, 5, 30)).toBe("FAST");
    expect(bucketOf(5, 5, 30)).toBe("MID");
    expect(bucketOf(30, 5, 30)).toBe("MID");
    expect(bucketOf(31, 5, 30)).toBe("SLOW");
    expect(bucketOf(null, 5, 30)).toBe("NO_REPLY");
  });

  it("gom hội thoại theo nhóm và tính tỉ lệ kết quả", async () => {
    const start = new Date(vnMonthRange("2034-08").gte.getTime() + 2 * DAY + 3 * 3_600_000);
    const mk = async (replyMin: number | null, withOutcome: boolean) => {
      const c = withOutcome ? await ctx.createCustomer({ name: "Khách chốt nhanh", phone: uniquePhone() }) : null;
      const conv = await prisma.conversation.create({
        data: { branchId: ctx.branchId, title: `Hội thoại ${uid()}`, customerId: c?.id ?? null, createdAt: start, channel: "FACEBOOK" },
      });
      await prisma.chatMessage.create({ data: { conversationId: conv.id, direction: "IN", content: "Chào shop", createdAt: start } });
      if (replyMin !== null) {
        await prisma.chatMessage.create({ data: { conversationId: conv.id, direction: "OUT", content: "Dạ em chào chị", createdAt: new Date(start.getTime() + replyMin * MIN) } });
      }
      if (c) {
        await visit(c.id, new Date(start.getTime() + DAY));
        await prisma.contract.create({ data: { code: `DH-L5B-${uid()}`, branchId: ctx.branchId, customerId: c.id, status: "SIGNED", signedAt: new Date(start.getTime() + DAY), total: TR } });
      }
    };
    await mk(2, true);
    await mk(3, false);
    await mk(10, false);
    await mk(45, false);
    await mk(null, false);
    const res = await ctx.as(manager).get("/api/analytics/response-buckets?from=2034-08-01&to=2034-08-31");
    expect(res.status).toBe(200);
    const by = (b: string) => res.body.rows.find((r: { bucket: string }) => r.bucket === b);
    expect(by("FAST")).toMatchObject({ conversations: 2, phoneRate: 50, showRate: 50, closeRate: 50 });
    expect(by("MID")).toMatchObject({ conversations: 1, avgMinutes: 10, closeRate: 0 });
    expect(by("SLOW")).toMatchObject({ conversations: 1, avgMinutes: 45 });
    expect(by("NO_REPLY").conversations).toBe(1);
  });
});

describe("F34: chỉ tiêu và dự báo cuối tháng", () => {
  it("công thức: nhịp hiện tại cộng lịch đã hẹn", () => {
    expect(forecastMath({ actual: 30 * TR, elapsedDays: 10, daysInMonth: 30, bookedValue: 5 * TR })).toEqual({
      runRatePerDay: 3 * TR,
      runRateForecast: 90 * TR,
      forecast: 95 * TR,
    });
    const now = new Date("2034-09-10T03:00:00Z");
    expect(monthProgress("2034-09", now)).toMatchObject({ daysInMonth: 30, elapsedDays: 10 });
    expect(monthProgress("2034-08", now).elapsedDays).toBe(31);
    expect(monthProgress("2034-10", now).elapsedDays).toBe(0);
  });

  it("dự báo từ dữ liệu, so cùng số ngày tháng trước, tiến độ chỉ tiêu", async () => {
    const sep = vnMonthRange("2034-09").gte;
    const aug = vnMonthRange("2034-08").gte;
    const c = await ctx.createCustomer({ name: "Khách dự báo" });
    await pay(c.id, 10 * TR, new Date(sep.getTime() + 1 * DAY));
    await pay(c.id, 20 * TR, new Date(sep.getTime() + 8 * DAY));
    await pay(c.id, 7 * TR, new Date(sep.getTime() + 8 * DAY), null, "VOUCHER"); // không tính
    await pay(c.id, 10 * TR, new Date(aug.getTime() + 4 * DAY));
    await pay(c.id, 99 * TR, new Date(aug.getTime() + 20 * DAY)); // ngoài 10 ngày đầu
    const svc = await prisma.service.create({ data: { code: `SVF${uid()}`.toUpperCase(), name: "Botox dự báo", kind: "INJECTION" } });
    await prisma.servicePrice.create({ data: { serviceId: svc.id, branchId: ctx.branchId, price: 5 * TR, validFrom: new Date("2020-01-01") } });
    await prisma.appointment.create({
      data: {
        branchId: ctx.branchId, customerId: c.id, title: "Botox", serviceId: svc.id, status: "CONFIRMED",
        startAt: new Date(sep.getTime() + 20 * DAY), endAt: new Date(sep.getTime() + 20 * DAY + 3_600_000),
        depositAmount: 1 * TR, depositStatus: "DA_COC",
      },
    });
    const put = await ctx.as(director).put("/api/analytics/targets").send({ periodKey: "2034-09", branchId: ctx.branchId, targetRevenue: 100 * TR });
    expect(put.status).toBe(200);
    expect((await ctx.as(sale).put("/api/analytics/targets").send({ periodKey: "2034-09", targetRevenue: 1 })).status).toBe(403);

    const f = await forecast({ periodKey: "2034-09", branchIds: [ctx.branchId], now: new Date("2034-09-10T03:00:00Z") });
    expect(f.actual).toBe(30 * TR);
    expect(f.bookedValue).toBe(4 * TR);
    expect(f.runRateForecast).toBe(90 * TR);
    expect(f.forecast).toBe(94 * TR);
    expect(f.prevSameDays).toBe(10 * TR);
    expect(f.vsPrevPercent).toBe(200);
    expect(f.target).toBe(100 * TR);
    expect(f.progressPercent).toBe(30);
  });
});

describe("F33: xuất Excel cho kế toán", () => {
  it("tệp có trang Phiếu thu và Sổ doanh thu với đủ cột, giờ Việt Nam", async () => {
    const res = await ctx.as(accountant).get("/api/analytics/accounting-export?from=2034-09-01&to=2034-09-30").buffer(true).parse(binary);
    expect(res.status).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body as unknown as ArrayBuffer);
    const receipts = wb.getWorksheet("Phiếu thu")!;
    expect((receipts.getRow(1).values as unknown[]).slice(1)).toEqual(RECEIPT_COLUMNS.map((c) => c.header));
    expect(receipts.rowCount).toBe(1 + 3); // 3 phiếu tháng 9 (kể cả voucher)
    expect(String(receipts.getRow(2).getCell(2).value)).toMatch(/^\d{2}:\d{2} \d{2}\/09\/2034$/);
    const ledger = wb.getWorksheet("Sổ doanh thu theo dịch vụ")!;
    expect((ledger.getRow(1).values as unknown[]).slice(1)).toEqual(LEDGER_COLUMNS.map((c) => c.header));
    expect(ledger.rowCount).toBe(1 + 2); // voucher không vào sổ doanh thu
    expect((await ctx.as(sale).get("/api/analytics/accounting-export?from=2034-09-01&to=2034-09-30")).status).toBe(403);
  });
});

describe("F15: chỉ số tuần Sales và MKT, nhập chi phí quảng cáo", () => {
  it("đọc CSV Meta và TikTok (tiếng Anh, tiếng Việt, dấu nghìn), bỏ dòng tổng", () => {
    expect(parseCostAmount("1,234,567")).toBe(1_234_567);
    expect(parseCostAmount("1.234.567")).toBe(1_234_567);
    expect(parseCostAmount("1234567.40")).toBe(1_234_567);
    expect(parseCostAmount("1.234.567,5 ₫")).toBe(1_234_568);
    const meta = parseAdCostCsv("Campaign name,Day,Amount spent (VND)\nFiller T10,2034-10-02,\"1,000,000\"\nTotal,,1000000\n");
    expect(meta.platform).toBe("META");
    expect(meta.rows).toEqual([{ line: 2, campaignName: "Filler T10", date: "2034-10-02", amount: 1_000_000 }]);
    const tiktok = parseAdCostCsv("Campaign name;Date;Cost\nBotox TT;03/10/2034;250000\n");
    expect(tiktok.platform).toBe("TIKTOK");
    expect(tiktok.rows[0]).toMatchObject({ date: "2034-10-03", amount: 250_000 });
    const vi = parseAdCostCsv("Tên chiến dịch,Ngày,Số tiền đã chi tiêu (VND)\nA,2034-10-02,abc\n");
    expect(vi.errors).toHaveLength(1);
  });

  it("chi phí trên SĐT, lịch cọc, khách đến; ROAS; tách quảng cáo và tự nhiên; nhập lại tệp ghi đè", async () => {
    const monday = startOfVnWeek(new Date("2034-10-04T05:00:00Z"));
    const at = (h: number) => new Date(monday.getTime() + h * 3_600_000);
    const fb = await prisma.channel.upsert({ where: { key: "facebook" }, create: { key: "facebook", name: "Facebook", kind: "FACEBOOK" }, update: {} });
    const name = `Filler tuan ${uid()}`;
    const csv = `Campaign name,Day,Amount spent (VND)\n${name},${new Date(monday.getTime() + 12 * 3_600_000).toISOString().slice(0, 10)},1000000\n`;
    const first = await importAdCosts({ text: csv, createMissing: true });
    expect(first).toMatchObject({ platform: "META", imported: 1, createdCampaigns: [name] });
    const camp = await prisma.campaign.findFirstOrThrow({ where: { name } });
    expect(camp.channelId).toBe(fb.id);
    await importAdCosts({ text: csv }); // nhập lại cùng ngày: ghi đè, không cộng dồn
    const day2 = new Date(monday.getTime() + 36 * 3_600_000).toISOString().slice(0, 10);
    const day3 = new Date(monday.getTime() + 60 * 3_600_000).toISOString().slice(0, 10);
    for (const date of [day2, day3]) {
      expect((await ctx.as(marketing).put("/api/analytics/ad-costs").send({ campaignId: camp.id, date, amount: 1_000_000 })).status).toBe(200);
    }
    expect((await ctx.as(sale).put("/api/analytics/ad-costs").send({ campaignId: camp.id, date: day2, amount: 1 })).status).toBe(403);

    for (let i = 0; i < 6; i++) {
      await prisma.lead.create({
        data: { name: `Lead ${i}`, campaignId: camp.id, channelId: fb.id, createdAt: at(10 + i), ...(i < 3 ? { phone: uniquePhone(), hasPhoneAt: at(11 + i) } : {}) },
      });
    }
    // Tự nhiên: một lead không chiến dịch.
    await prisma.lead.create({ data: { name: "Lead tự nhiên", createdAt: at(12), phone: uniquePhone(), hasPhoneAt: at(12) } });
    const c1 = await ctx.createCustomer({ name: "Khách QC 1" });
    const c2 = await ctx.createCustomer({ name: "Khách QC 2" });
    for (const c of [c1, c2]) await prisma.customer.update({ where: { id: c.id }, data: { campaignId: camp.id, channelId: fb.id } });
    await prisma.appointment.create({
      data: { branchId: ctx.branchId, customerId: c1.id, title: "Tư vấn", startAt: at(50), endAt: at(51), depositAmount: 500_000, depositStatus: "DA_COC", depositConfirmedAt: at(20) },
    });
    await visit(c1.id, at(50));
    await visit(c2.id, at(52));
    await visit(c2.id, at(80)); // lần đến thứ hai không tính khách đến mới
    await pay(c1.id, 12 * TR, at(53));

    const res = await ctx.as(marketing).get(`/api/analytics/weekly?weeks=1&to=${new Date(monday.getTime() + 12 * 3_600_000).toISOString().slice(0, 10)}`);
    expect(res.status).toBe(200);
    const [week] = res.body.weeks;
    expect(week.weekKey).toBe(vnWeekKey(monday));
    const row = week.byCampaign.find((r: { campaignId: string }) => r.campaignId === camp.id);
    expect(row).toMatchObject({
      cost: 3 * TR,
      newMessages: 6,
      phones: 3,
      costPerPhone: 1 * TR,
      depositBookings: 1,
      costPerDeposit: 3 * TR,
      showups: 2,
      costPerShowup: 1_500_000,
      revenue: 12 * TR,
      roas: 4,
    });
    expect(week.organic.newMessages).toBeGreaterThanOrEqual(1);
    expect(week.ads.cost).toBeGreaterThanOrEqual(3 * TR);
    expect((await ctx.as(sale).get("/api/analytics/weekly")).status).toBe(403);
  });

  it("lead chuyển thành khách luôn lên WON, kể cả khi khách cũ đã có lead gốc", async () => {
    const phone = uniquePhone();
    const existing = await ctx.createCustomer({ name: "Khách cũ", phone });
    await prisma.lead.create({ data: { name: "Lead gốc", phone, convertedCustomerId: existing.id, stage: "WON" } });
    const admin = await ctx.createUser("QUAN_LY_HE_THONG");
    const again = await ctx.as(admin).post("/api/leads").send({ name: "Khách cũ quay lại", phone });
    expect(again.status).toBe(201);
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: again.body.id } })).hasPhoneAt).not.toBeNull();
    const conv = await ctx.as(admin).post(`/api/leads/${again.body.id}/convert`).send({});
    expect(conv.status).toBe(201);
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: again.body.id } })).stage).toBe("WON");

    // Lead Pancake gắn hội thoại: gắn hồ sơ khách thì lead lên WON, có mốc SĐT, khách mang chiến dịch.
    const camp = await prisma.campaign.create({ data: { code: `L5W-${uid()}`, name: "Chiến dịch WON" } });
    const lead = await prisma.lead.create({ data: { name: "Lead QC", campaignId: camp.id, adId: "ad-1" } });
    const cv = await prisma.conversation.create({ data: { branchId: ctx.branchId, title: "Khách QC", leadId: lead.id, channel: "FACEBOOK" } });
    const cust = await ctx.createCustomer({ name: "Khách từ QC", phone: uniquePhone() });
    expect((await ctx.as(manager).post(`/api/conversations/${cv.id}/link-customer`).send({ customerId: cust.id })).status).toBe(200);
    const after = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(after.stage).toBe("WON");
    expect(after.hasPhoneAt).not.toBeNull();
    expect(after.convertedCustomerId).toBe(cust.id);
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: cust.id } })).campaignId).toBe(camp.id);
  });
});

describe("F29: trang chủ theo vai", () => {
  it("mỗi vai có khối riêng; lễ tân có tab tài chính nhưng trang chủ là việc hôm nay", async () => {
    const get = async (role: "LE_TAN" | "KE_TOAN" | "BAC_SI" | "DIEU_DUONG" | "MARKETING" | "TELESALE" | "GIAM_DOC") =>
      (await ctx.as(role).get("/api/home").expect(200)).body;
    const reception = await get("LE_TAN");
    expect(reception.sections.deposits).toBeTruthy();
    expect(reception.financeView).toBe(true);
    expect((await get("KE_TOAN")).sections.accounting).toBeTruthy();
    expect((await get("BAC_SI")).sections.medicalFlags).toBeTruthy();
    expect((await get("DIEU_DUONG")).sections.aftercare).toBeTruthy();
    expect((await get("MARKETING")).sections.marketing).toBeTruthy();
    const s = await get("TELESALE");
    expect(s.sections.myDay).toBeTruthy();
    expect(s.sections.teamTarget).toBeTruthy();
    expect(s.financeView).toBe(true);
    expect((await get("GIAM_DOC")).sections.director).toBeTruthy();
  });
});

describe("AI4: chấm hội thoại theo kịch bản mỗi tuần", () => {
  it("chỉ chấm khách đã đồng ý, dùng model SMART, không chấm lại; chưa cấu hình thì bỏ qua", async () => {
    const weekStart = startOfVnWeek(new Date("2034-11-08T05:00:00Z"));
    const now = new Date(weekStart.getTime() + 7 * DAY + 3_600_000);
    if (!(await prisma.salesScript.findFirst({ where: { isActive: true } }))) {
      await prisma.salesScript.create({ data: { key: `lo5${uid()}`, version: 1, title: "Kịch bản", content: "Chào, hỏi nhu cầu, xin SĐT, mời đặt lịch có cọc.", isActive: true } });
    }
    const mk = async (consent: boolean) => {
      const c = await ctx.createCustomer({ name: consent ? "Khách đồng ý AI" : "Khách chưa đồng ý" });
      await prisma.customer.update({ where: { id: c.id }, data: { aiDataConsent: consent } });
      const conv = await prisma.conversation.create({ data: { branchId: ctx.branchId, title: c.id, customerId: c.id, assignedToId: sale.id, lastMessageAt: new Date(weekStart.getTime() + DAY) } });
      await prisma.chatMessage.create({ data: { conversationId: conv.id, direction: "IN", content: "Filler giá bao nhiêu ạ", createdAt: new Date(weekStart.getTime() + DAY) } });
      await prisma.chatMessage.create({ data: { conversationId: conv.id, direction: "OUT", content: "Dạ chị cho em xin SĐT ạ", createdAt: new Date(weekStart.getTime() + DAY + MIN) } });
      return conv;
    };
    const ok = await mk(true);
    const no = await mk(false);

    setAiClientForTests(null);
    expect((await scoreConversations(now)).message).toContain("chưa cấu hình");

    const models: string[] = [];
    const mock: AiClient = {
      async complete(req: AiRequest) {
        models.push(req.model);
        return { text: '```json\n{"score": 78, "criteria": [{"name": "Xin SĐT", "score": 9, "comment": "tốt"}], "summary": "Làm đúng kịch bản"}\n```', model: req.model };
      },
    };
    setAiClientForTests(mock);
    const r1 = await scoreConversations(now);
    expect(r1.created).toBeGreaterThanOrEqual(1);
    expect(models.every((m) => m === AI_MODELS.SMART)).toBe(true);
    const week = vnWeekKey(weekStart);
    const mine = await prisma.conversationScore.findUniqueOrThrow({ where: { conversationId_weekKey: { conversationId: ok.id, weekKey: week } } });
    expect(mine).toMatchObject({ status: "SCORED", score: 78, userId: sale.id });
    expect(await prisma.conversationScore.findFirst({ where: { conversationId: no.id } })).toBeNull();
    const calls = models.length;
    await scoreConversations(now);
    expect(models.length).toBe(calls);

    const screen = await ctx.as(manager).get(`/api/analytics/conversation-scores?week=${week}`);
    expect(screen.status).toBe(200);
    expect(screen.body.rows.find((x: { conversationId: string }) => x.conversationId === ok.id).criteria[0].name).toBe("Xin SĐT");
    expect((await ctx.as(sale).get("/api/analytics/conversation-scores")).status).toBe(403);
  });
});
