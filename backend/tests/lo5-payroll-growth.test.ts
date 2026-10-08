import crypto from "node:crypto";
import ExcelJS from "exceljs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestContext, uniquePhone, prisma, type TestContext, type TestUser } from "./helpers";
import { invalidateSettingsCache } from "../src/lib/settings-catalog";
import { adsBonusFor, baseSalaryFor, parseTiers, salesBonusFor } from "../src/lib/tiers";
import { PAYROLL_XLSX_HEADERS } from "../src/lib/payroll";
import { grantReferralReward, ruleBirthday } from "../src/lib/growth";
import { vnMonthRange } from "../src/lib/metrics";

// Lô 5: F17 lương thưởng theo biên bản coaching, F18 thi đua, F19 giới thiệu,
// F20 voucher và sinh nhật.

const uid = () => crypto.randomBytes(4).toString("hex");
const TR = 1_000_000;

let ctx: TestContext;
let manager: TestUser;
let sale: TestUser;
let doctor: TestUser;
let nurse: TestUser;
let ads: TestUser;
let receptionist: TestUser;

async function setSetting(key: string, value: string) {
  await prisma.systemSetting.upsert({ where: { key }, create: { key, value }, update: { value } });
  invalidateSettingsCache();
}
async function resetSetting(key: string) {
  await prisma.systemSetting.deleteMany({ where: { key } });
  invalidateSettingsCache();
}

let seq = 0;
async function contract(opts: {
  customerId: string;
  consultantId: string;
  items: Array<{ name: string; amount: number; upsellById?: string }>;
  closeType?: "FULL" | "PARTIAL";
  closingDoctorId?: string;
}) {
  const total = opts.items.reduce((s, i) => s + i.amount, 0);
  return prisma.contract.create({
    data: {
      code: `DH-L5-${uid()}`,
      branchId: ctx.branchId,
      customerId: opts.customerId,
      consultantId: opts.consultantId,
      status: "SIGNED",
      signedAt: new Date(),
      subtotal: total,
      total,
      closeType: opts.closeType ?? "FULL",
      closingDoctorId: opts.closingDoctorId ?? null,
      items: {
        create: opts.items.map((i) => ({ name: i.name, unitPrice: i.amount, amount: i.amount, upsellById: i.upsellById ?? null })),
      },
    },
  });
}

async function payment(opts: { customerId: string; contractId?: string | null; amount: number; paidAt: Date; method?: string }) {
  return prisma.payment.create({
    data: {
      code: `PT-L5-${uid()}-${++seq}`,
      branchId: ctx.branchId,
      customerId: opts.customerId,
      contractId: opts.contractId ?? null,
      amount: opts.amount,
      method: opts.method ?? "CASH",
      paidAt: opts.paidAt,
    },
  });
}

let queue = 9000;
async function visit(customerId: string, at: Date) {
  return prisma.visit.create({ data: { branchId: ctx.branchId, customerId, queueNumber: ++queue, checkedInAt: at, status: "DONE" } });
}

beforeAll(async () => {
  ctx = await setupTestContext("lo5pay");
  manager = await ctx.createUser("QUAN_LY_CO_SO");
  sale = await ctx.createUser("TELESALE");
  doctor = await ctx.createUser("BAC_SI");
  nurse = await ctx.createUser("DIEU_DUONG");
  ads = await ctx.createUser("MARKETING");
  receptionist = await ctx.createUser("LE_TAN");
  await ctx.createUser("GIAM_DOC");
});

afterAll(async () => {
  for (const k of ["payroll.bonusScheme", "payroll.doctorCloseBonusPercent", "contest.monthlyShowupTarget", "referral.rewardKind"]) await resetSetting(k);
});

describe("F17: bảng bậc (hàm thuần, giá trị mặc định trong Cài đặt)", () => {
  const baseTiers = parseTiers("100:8000000,150:10000000,200:13000000");
  it("lương cứng theo số khách đến: biên 100/101/150/151/200/201", () => {
    const at = (n: number) => baseSalaryFor(n, 7 * TR, baseTiers);
    expect(at(0)).toBe(7 * TR);
    expect(at(100)).toBe(7 * TR);
    expect(at(101)).toBe(8 * TR);
    expect(at(150)).toBe(8 * TR);
    expect(at(151)).toBe(10 * TR);
    expect(at(200)).toBe(10 * TR);
    expect(at(201)).toBe(13 * TR);
  });

  it("thưởng doanh số phương án mốc: đạt mốc cao nhất, không cộng dồn", () => {
    const ms = parseTiers("300:1000000,500:3000000,1000:10000000");
    const pt = parseTiers("100:1,200:1.5,300:3,500:4");
    const b = (rev: number) => salesBonusFor(rev, "MILESTONE", ms, pt, TR).bonus;
    expect(b(299 * TR)).toBe(0);
    expect(b(300 * TR)).toBe(1 * TR);
    expect(b(499 * TR)).toBe(1 * TR);
    expect(b(500 * TR)).toBe(3 * TR);
    expect(b(1000 * TR)).toBe(10 * TR);
    expect(b(5000 * TR)).toBe(10 * TR);
  });

  it("thưởng doanh số phương án % bậc: % của bậc đạt được nhân toàn bộ doanh thu", () => {
    const ms = parseTiers("300:1000000,500:3000000,1000:10000000");
    const pt = parseTiers("100:1,200:1.5,300:3,500:4");
    const b = (rev: number) => salesBonusFor(rev, "PERCENT_TIER", ms, pt, TR).bonus;
    expect(b(99 * TR)).toBe(0);
    expect(b(100 * TR)).toBe(1 * TR);
    expect(b(200 * TR)).toBe(3 * TR);
    expect(b(300 * TR)).toBe(9 * TR);
    expect(b(500 * TR)).toBe(20 * TR);
  });

  it("% cho người chạy ads theo doanh thu quảng cáo Facebook", () => {
    const tiers = parseTiers("1000:0.5,1500:0.8,2500:1,5000:1.2,7000:1.5,10000:1.8");
    const b = (rev: number) => adsBonusFor(rev, tiers, TR).bonus;
    expect(b(999 * TR)).toBe(0);
    expect(b(1000 * TR)).toBe(5 * TR);
    expect(b(1500 * TR)).toBe(12 * TR);
    expect(b(2500 * TR)).toBe(25 * TR);
    expect(b(5000 * TR)).toBe(60 * TR);
    expect(b(7000 * TR)).toBe(105 * TR);
    expect(b(10_000 * TR)).toBe(180 * TR);
  });

  it("Cài đặt từ chối bảng bậc sai dạng", async () => {
    const admin = await ctx.createUser("QUAN_LY_HE_THONG");
    const bad = await ctx.as(admin).put("/api/settings").send({ values: { "payroll.baseSalaryTiers": "150:8000000,100:10000000" } });
    expect(bad.status).toBe(400);
    const bad2 = await ctx.as(admin).put("/api/settings").send({ values: { "payroll.bonusMilestones": "300=1tr" } });
    expect(bad2.status).toBe(400);
  });
});

describe("F17: kỳ lương (tính, chỉ tiền đã thu trong kỳ, full và bán phần, upsale, ads, khoá, Excel)", () => {
  const PERIOD = "2034-05";
  const range = vnMonthRange(PERIOD);
  const inPeriod = new Date(range.gte.getTime() + 10 * 86_400_000);
  let lineOf: (userId: string) => Promise<Record<string, any>>;

  beforeAll(async () => {
    const fb = await prisma.channel.upsert({ where: { key: "facebook" }, create: { key: "facebook", name: "Facebook", kind: "FACEBOOK" }, update: {} });
    const camp = await prisma.campaign.create({ data: { code: `L5-${uid()}`, name: "Filler tháng 5", channelId: fb.id } });
    const a = await ctx.createCustomer({ name: "Khách full", phone: uniquePhone(), assignedToId: sale.id });
    await prisma.customer.update({ where: { id: a.id }, data: { channelId: fb.id, campaignId: camp.id } });
    const b = await ctx.createCustomer({ name: "Khách bán phần", phone: uniquePhone(), assignedToId: sale.id });

    const ca = await contract({
      customerId: a.id,
      consultantId: sale.id,
      items: [
        { name: "Combo full face", amount: 960 * TR },
        { name: "Botox thêm (upsale)", amount: 240 * TR, upsellById: nurse.id },
      ],
    });
    const cb = await contract({ customerId: b.id, consultantId: sale.id, items: [{ name: "HIFU", amount: 60 * TR }], closeType: "PARTIAL", closingDoctorId: doctor.id });

    await payment({ customerId: a.id, contractId: ca.id, amount: 1200 * TR, paidAt: inPeriod });
    await payment({ customerId: b.id, contractId: cb.id, amount: 60 * TR, paidAt: inPeriod });
    // Không được tính: tiền thu tháng trước, trừ voucher (không phải tiền thật).
    await payment({ customerId: a.id, contractId: ca.id, amount: 77 * TR, paidAt: new Date(range.gte.getTime() - 86_400_000) });
    await payment({ customerId: b.id, contractId: cb.id, amount: 5 * TR, paidAt: inPeriod, method: "VOUCHER" });
    // Khách đến: 2 lượt cùng ngày của một khách tính 1, khách kia 1 lượt -> 2.
    await visit(a.id, inPeriod);
    await visit(a.id, new Date(inPeriod.getTime() + 3_600_000));
    await visit(b.id, new Date(inPeriod.getTime() + 86_400_000));

    lineOf = async (userId: string) => {
      const res = await ctx.as(manager).get(`/api/payroll/${PERIOD}`);
      expect(res.status).toBe(200);
      return res.body.lines.find((l: { userId: string }) => l.userId === userId);
    };
  });

  it("tính kỳ: doanh thu tính thưởng chỉ gồm tiền đã thu trong kỳ, bán phần chia theo tỉ lệ", async () => {
    const r = await ctx.as(manager).post(`/api/payroll/${PERIOD}/compute`).send({});
    expect(r.status).toBe(200);
    const s = await lineOf(sale.id);
    // 1.200tr (full, 100%) + 60tr x 50% (bán phần) = 1.230tr; không có 77tr tháng trước, 5tr voucher.
    expect(s.revenue).toBe(1230 * TR);
    expect(s.showups).toBe(2);
    expect(s.baseSalary).toBe(7 * TR);
    expect(s.salesBonus).toBe(10 * TR); // mốc 1000 triệu
    expect(s.detail.contributions.some((c: { kind: string }) => c.kind === "SALE_PARTIAL")).toBe(true);

    const d = await lineOf(doctor.id);
    expect(d.detail.doctorRevenue).toBe(30 * TR);
    expect(d.commission).toBe(0); // mặc định 0% chờ chủ đầu tư chốt

    const n = await lineOf(nurse.id);
    expect(n.detail.upsellRevenue).toBe(240 * TR);
    expect(n.upsellBonus).toBe(Math.round(240 * TR * 0.03));

    const m = await lineOf(ads.id);
    expect(m.detail.adsRevenue).toBe(1200 * TR);
    expect(m.adsBonus).toBe(Math.round((1200 * TR * 0.005) / m.detail.adsStaffCount));
    expect(s.total).toBe(s.baseSalary + s.salesBonus + s.commission + s.upsellBonus + s.adsBonus + s.allowance - s.deduction);
  });

  it("đổi phương án thưởng sang % bậc và % bác sĩ chốt: tính lại theo Cài đặt", async () => {
    await setSetting("payroll.bonusScheme", "PERCENT_TIER");
    await setSetting("payroll.doctorCloseBonusPercent", "10");
    await ctx.as(manager).post(`/api/payroll/${PERIOD}/compute`).send({}).expect(200);
    expect((await lineOf(sale.id)).salesBonus).toBe(Math.round(1230 * TR * 0.04));
    expect((await lineOf(doctor.id)).commission).toBe(3 * TR);
    await resetSetting("payroll.bonusScheme");
    await resetSetting("payroll.doctorCloseBonusPercent");
  });

  it("phụ cấp nhập tay được giữ khi tính lại; khoá kỳ thì không tính lại, không sửa được", async () => {
    const s = await lineOf(sale.id);
    const p = await ctx.as(manager).patch(`/api/payroll/lines/${s.id}`).send({ allowance: 500_000 });
    expect(p.status).toBe(200);
    expect(p.body.total).toBe(s.total + 500_000);
    await ctx.as(manager).post(`/api/payroll/${PERIOD}/compute`).send({}).expect(200);
    expect((await lineOf(sale.id)).allowance).toBe(500_000);

    const denied = await ctx.as(sale).post(`/api/payroll/${PERIOD}/lock`).send({});
    expect(denied.status).toBe(403);
    await ctx.as(manager).post(`/api/payroll/${PERIOD}/lock`).send({}).expect(200);
    const again = await ctx.as(manager).post(`/api/payroll/${PERIOD}/compute`).send({});
    expect(again.status).toBe(409);
    const edit = await ctx.as(manager).patch(`/api/payroll/lines/${s.id}`).send({ deduction: 1 });
    expect(edit.status).toBe(409);
  });

  it("xuất Excel có đủ cột", async () => {
    const res = await ctx
      .as(manager)
      .get(`/api/payroll/${PERIOD}/export`)
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on("data", (c: Buffer) => chunks.push(c));
        r.on("end", () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body as unknown as ArrayBuffer);
    const ws = wb.getWorksheet("Bảng lương")!;
    const headers = (ws.getRow(1).values as unknown[]).slice(1);
    expect(headers).toEqual(PAYROLL_XLSX_HEADERS);
    expect(wb.getWorksheet("Chi tiết")).toBeTruthy();
  });

  it("sale (phạm vi của tôi) chỉ thấy dòng lương của mình", async () => {
    const res = await ctx.as(sale).get(`/api/payroll/${PERIOD}`);
    expect(res.status).toBe(200);
    expect(res.body.lines.every((l: { userId: string }) => l.userId === sale.id)).toBe(true);
  });
});

describe("F18: thi đua theo khách đến, hai luật loại", () => {
  it("báo giá dưới niêm yết chưa duyệt và cờ vi phạm chuyên môn thì bị loại khỏi xếp hạng", async () => {
    const PERIOD = "2034-06";
    const at = new Date(vnMonthRange(PERIOD).gte.getTime() + 5 * 86_400_000);
    const s1 = await ctx.createUser("TELESALE", { key: "S1" });
    const s2 = await ctx.createUser("TELESALE", { key: "S2" });
    const s3 = await ctx.createUser("TU_VAN_VIEN", { key: "S3" });
    const mk = async (owner: TestUser, n: number) => {
      for (let i = 0; i < n; i++) {
        const c = await ctx.createCustomer({ name: `Khách thi đua ${i}`, assignedToId: owner.id });
        await visit(c.id, new Date(at.getTime() + i * 86_400_000));
      }
    };
    await mk(s1, 3);
    await mk(s2, 5);
    await mk(s3, 4);
    const cust = await ctx.createCustomer({ name: "Khách báo giá", assignedToId: s2.id });
    const quote = async (by: string, approvalStatus: string) =>
      prisma.quotation.create({
        data: {
          code: `BG-L5-${uid()}`,
          branchId: ctx.branchId,
          customerId: cust.id,
          createdById: by,
          createdAt: at,
          approvalStatus,
          items: { create: [{ name: "Filler", unitPrice: 4 * TR, listPrice: 5 * TR, discountAmount: 1 * TR, amount: 4 * TR }] },
        },
      });
    await quote(s2.id, "PENDING");
    await quote(s1.id, "APPROVED"); // đã duyệt: không bị loại

    await setSetting("contest.monthlyShowupTarget", "20");
    const flag = await ctx.as(manager).post("/api/growth/violations").send({ userId: s3.id, periodKey: PERIOD, reason: "Tư vấn liều thuốc khi chưa có bác sĩ" });
    expect(flag.status).toBe(201);
    const deniedFlag = await ctx.as(sale).post("/api/growth/violations").send({ userId: s3.id, reason: "thử quyền" });
    expect(deniedFlag.status).toBe(403);

    const res = await ctx.as(manager).get(`/api/analytics/leaderboard?period=${PERIOD}`);
    expect(res.status).toBe(200);
    const row = (u: TestUser) => res.body.rows.find((r: { userId: string }) => r.userId === u.id);
    expect(row(s1)).toMatchObject({ showups: 3, rank: 1, disqualified: false });
    expect(row(s2)).toMatchObject({ showups: 5, rank: null, disqualified: true });
    expect(row(s2).reasons[0]).toContain("dưới giá niêm yết");
    expect(row(s3)).toMatchObject({ rank: null, disqualified: true });
    expect(res.body.target).toBe(20);
    expect(res.body.actual).toBeGreaterThanOrEqual(12);

    // Gỡ cờ thì được xếp hạng lại.
    await ctx.as(manager).post(`/api/growth/violations/${flag.body.id}/revoke`).send({}).expect(200);
    const again = await ctx.as(manager).get(`/api/analytics/leaderboard?period=${PERIOD}`);
    expect(again.body.rows.find((r: { userId: string }) => r.userId === s3.id)).toMatchObject({ disqualified: false, rank: 1 });
  });
});

describe("F19: giới thiệu khách", () => {
  it("nhập mã giới thiệu; làm xong dịch vụ thì thưởng người giới thiệu đúng một lần", async () => {
    const referrer = await ctx.createCustomer({ name: "Khách giới thiệu", phone: uniquePhone(), assignedToId: sale.id });
    const fresh = await ctx.createCustomer({ name: "Khách mới được giới thiệu", phone: uniquePhone(), assignedToId: sale.id });
    const code = await ctx.as(sale).post(`/api/growth/customers/${referrer.id}/referral-code`).send({});
    expect(code.status).toBe(200);
    expect(code.body.referralCode).toMatch(/^GT[A-Z0-9]{6}$/);
    const self = await ctx.as(sale).post(`/api/growth/customers/${referrer.id}/referrer`).send({ code: code.body.referralCode });
    expect(self.status).toBe(400);
    const set = await ctx.as(sale).post(`/api/growth/customers/${fresh.id}/referrer`).send({ code: code.body.referralCode.toLowerCase() });
    expect(set.status).toBe(200);

    const first = await grantReferralReward(fresh.id, null);
    expect(first).toBeTruthy();
    const second = await grantReferralReward(fresh.id, null);
    expect(second).toBeNull();
    const rewards = await prisma.referralReward.findMany({ where: { customerId: fresh.id } });
    expect(rewards).toHaveLength(1);
    const v = await prisma.voucher.findUniqueOrThrow({ where: { id: rewards[0].voucherId! } });
    expect(v).toMatchObject({ customerId: referrer.id, value: 500_000, source: "REFERRAL", status: "ACTIVE" });

    // Đã thưởng thì không đổi người giới thiệu được.
    const change = await ctx.as(sale).post(`/api/growth/customers/${fresh.id}/referrer`).send({ referrerId: referrer.id });
    expect(change.status).toBe(409);

    const report = await ctx.as(manager).get("/api/growth/referrals/report?period=month");
    expect(report.status).toBe(200);
    const row = report.body.rows.find((r: { referrerId: string }) => r.referrerId === referrer.id);
    expect(row).toMatchObject({ referees: 1, rewarded: 1, rewardTotal: 500_000 });
  });

  it("thưởng tiền mặt tạo khoản chờ chi, kế toán đánh dấu đã chi", async () => {
    await setSetting("referral.rewardKind", "CASH");
    const referrer = await ctx.createCustomer({ name: "Người giới thiệu tiền", assignedToId: sale.id });
    const fresh = await ctx.createCustomer({ name: "Khách mới 2", assignedToId: sale.id });
    await ctx.as(sale).post(`/api/growth/customers/${fresh.id}/referrer`).send({ referrerId: referrer.id }).expect(200);
    const r = await grantReferralReward(fresh.id, null);
    expect(r?.status).toBe("PENDING_PAYOUT");
    const accountant = await ctx.createUser("KE_TOAN");
    const paid = await ctx.as(accountant).post(`/api/growth/referral-rewards/${r!.id}/paid`).send({});
    expect(paid.status).toBe(200);
    expect(paid.body.status).toBe("PAID");
    await resetSetting("referral.rewardKind");
  });
});

describe("F20: voucher, quà tặng, sinh nhật", () => {
  it("dùng voucher khi thanh toán: trừ công nợ, không tính doanh thu, dùng một lần, hết hạn thì từ chối", async () => {
    const c = await ctx.createCustomer({ name: "Khách có voucher", assignedToId: sale.id });
    const other = await ctx.createCustomer({ name: "Khách khác" });
    const ct = await contract({ customerId: c.id, consultantId: sale.id, items: [{ name: "Meso", amount: 2 * TR }] });
    const tomorrow = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
    const created = await ctx.as(manager).post("/api/growth/vouchers").send({ customerId: c.id, value: 500_000, expiresAt: tomorrow });
    expect(created.status).toBe(201);
    const code = created.body.code as string;

    const wrong = await ctx.as(receptionist).post("/api/growth/vouchers/redeem").send({ code, customerId: other.id, contractId: ct.id });
    expect(wrong.status).toBe(409);
    const used = await ctx.as(receptionist).post("/api/growth/vouchers/redeem").send({ code, customerId: c.id, contractId: ct.id });
    expect(used.status).toBe(201);
    expect(used.body.amount).toBe(500_000);
    expect(used.body.payment.method).toBe("VOUCHER");
    expect((await prisma.contract.findUniqueOrThrow({ where: { id: ct.id } })).paidAmount).toBe(500_000);
    expect((await prisma.voucher.findUniqueOrThrow({ where: { code } })).status).toBe("REDEEMED");
    const twice = await ctx.as(receptionist).post("/api/growth/vouchers/redeem").send({ code, customerId: c.id, contractId: ct.id });
    expect(twice.status).toBe(409);
    // Voucher không phải tiền thật: mốc mua đầu vẫn trống.
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: c.id } })).firstPurchaseAt).toBeNull();

    const expired = await prisma.voucher.create({ data: { code: `VCX${uid()}`.toUpperCase(), customerId: c.id, value: 100_000, expiresAt: new Date(Date.now() - 1000) } });
    const late = await ctx.as(receptionist).post("/api/growth/vouchers/redeem").send({ code: expired.code, customerId: c.id, contractId: ct.id });
    expect(late.status).toBe(409);
    expect(late.body.error).toContain("hết hạn");
    const list = await ctx.as(receptionist).get(`/api/growth/vouchers?customerId=${c.id}`);
    expect(list.body.find((v: { code: string }) => v.code === expired.code).state).toBe("EXPIRED");

    const manual = await ctx.as(receptionist).post("/api/sales/payments").send({ customerId: c.id, contractId: ct.id, amount: 1000, method: "VOUCHER" });
    expect(manual.status).toBe(400);
  });

  it("danh mục quà và nhật ký tặng quà kèm chi phí", async () => {
    const c = await ctx.createCustomer({ name: "Khách nhận quà" });
    const item = await ctx.as(manager).post("/api/growth/gift-items").send({ name: `Mặt nạ ${uid()}`, cost: 45_000 });
    expect(item.status).toBe(201);
    const log = await ctx.as(receptionist).post("/api/growth/gifts").send({ customerId: c.id, giftItemId: item.body.id, quantity: 2 });
    expect(log.status).toBe(201);
    expect(log.body.totalCost).toBe(90_000);
    const report = await ctx.as(receptionist).get(`/api/growth/gifts?customerId=${c.id}`);
    expect(report.body.totalCost).toBe(90_000);
  });

  it("nhắc sinh nhật: tạo việc cho sale phụ trách, chạy lại không trùng", async () => {
    const now = new Date("2035-04-12T02:00:00Z"); // 09:00 giờ VN
    const c = await ctx.createCustomer({ name: "Khách sinh nhật", assignedToId: sale.id });
    await prisma.customer.update({ where: { id: c.id }, data: { dob: new Date("1995-04-12T00:00:00Z") } });
    await ruleBirthday(now);
    await ruleBirthday(now);
    const tasks = await prisma.task.findMany({ where: { customerId: c.id, kind: "BIRTHDAY" } });
    expect(tasks).toHaveLength(1);
    expect(tasks[0].assigneeId).toBe(sale.id);
  });
});
