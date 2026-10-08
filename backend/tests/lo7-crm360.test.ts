import crypto from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestContext, uniquePhone, prisma, type TestContext, type TestUser } from "./helpers";
import { invalidateSettingsCache } from "../src/lib/settings-catalog";
import { buildJourney, conversionFromHistory, heatOf, stageAge, vnDaysBetween } from "../src/lib/crm360";
import { ClinicMode } from "../src/types/enums";

// Lô 7 · CRM 360 Lô A: luật tính (số ngày ở bước, nhiệt độ, tỉ lệ chuyển, hành
// trình), bảng bước khối, quyền ẩn tiền với Telesale/Tư vấn viên, endpoint 360,
// báo giá 3 phương án tôn trọng trần giảm, luật bán kèm và ghi nhận nhận/từ chối.

const uid = () => crypto.randomBytes(4).toString("hex");
const DAY = 86_400_000;
const TAG = `L7${uid()}`; // tên khách chứa TAG để lọc bảng bước chỉ thấy khách của tệp này

let ctx: TestContext;
let manager: TestUser;
let telesale: TestUser;
let consultant: TestUser;
let accountant: TestUser;
let doctor: TestUser;
let director: TestUser;

async function setSetting(key: string, value: string) {
  await prisma.systemSetting.upsert({ where: { key }, create: { key, value }, update: { value } });
  invalidateSettingsCache();
}
async function clearSetting(key: string) {
  await prisma.systemSetting.deleteMany({ where: { key } });
  invalidateSettingsCache();
}

async function service(name: string, price: number) {
  const s = await prisma.service.create({ data: { code: `L7-${uid()}`, name: `${name} ${uid()}`, kind: "INJECTION" } });
  await prisma.servicePrice.create({ data: { serviceId: s.id, branchId: ctx.branchId, price, validFrom: new Date(Date.now() - DAY) } });
  return s;
}

async function customer(name: string, opts: { assignedToId?: string | null; stage?: string; daysInStage?: number } = {}) {
  const c = await ctx.createCustomer({ name: `${TAG} ${name}`, phone: uniquePhone(), assignedToId: opts.assignedToId ?? null });
  if (opts.stage) {
    const at = new Date(Date.now() - (opts.daysInStage ?? 0) * DAY);
    await prisma.customer.update({ where: { id: c.id }, data: { stage: opts.stage, stageChangedAt: at } });
    await prisma.stageHistory.create({ data: { customerId: c.id, fromStage: "TIEP_CAN", toStage: opts.stage, createdAt: at } });
  }
  return c;
}

beforeAll(async () => {
  ctx = await setupTestContext("lo7crm");
  manager = await ctx.createUser("QUAN_LY_CO_SO");
  telesale = await ctx.createUser("TELESALE");
  consultant = await ctx.createUser("TU_VAN_VIEN");
  accountant = await ctx.createUser("KE_TOAN");
  doctor = await ctx.createUser("BAC_SI");
  director = await ctx.createUser("GIAM_DOC");
  // Đợt ưu đãi áp mọi dịch vụ do tệp test khác để lại sẽ chen vào giá: tắt đi cho phép tính rõ ràng.
  await prisma.promotion.updateMany({ where: { services: { none: {} } }, data: { active: false } });
});

afterAll(async () => {
  await clearSetting("quote.packageDiscountPercent");
  await clearSetting("discount.capPercent.QUAN_LY_CO_SO");
  await clearSetting("discount.capPercent.TU_VAN_VIEN");
});

// ======================================================== LUẬT TÍNH THUẦN

describe("P1: số ngày ở bước theo giờ Việt Nam và mức màu", () => {
  it("đếm ngày lịch giờ VN, không đếm 24 giờ", () => {
    // 23h ngày 1 (VN) tới 08h ngày 2 (VN) là 1 ngày.
    expect(vnDaysBetween(new Date("2026-10-01T16:00:00Z"), new Date("2026-10-02T01:00:00Z"))).toBe(1);
    expect(vnDaysBetween(new Date("2026-10-01T02:00:00Z"), new Date("2026-10-01T15:00:00Z"))).toBe(0);
  });

  it("ngưỡng 3 ngày, cảnh báo 70%: ngày 2 xanh, ngày 3 vàng, ngày 4 đỏ; ngưỡng 0 không tính", () => {
    const now = new Date("2026-10-10T03:00:00Z");
    const ago = (d: number) => new Date(now.getTime() - d * DAY);
    expect(stageAge(ago(2), now, 3, 70)).toEqual({ days: 2, maxDays: 3, level: "OK" });
    expect(stageAge(ago(3), now, 3, 70).level).toBe("WARN");
    expect(stageAge(ago(4), now, 3, 70).level).toBe("OVERDUE");
    expect(stageAge(ago(40), now, 0, 70)).toEqual({ days: 40, maxDays: 0, level: "NONE" });
    // Ngưỡng 1 ngày: hôm nay xanh, ngày 1 vàng, ngày 2 đỏ.
    expect(stageAge(ago(0), now, 1, 70).level).toBe("OK");
    expect(stageAge(ago(1), now, 1, 70).level).toBe("WARN");
    expect(stageAge(ago(2), now, 1, 70).level).toBe("OVERDUE");
  });
});

describe("P1: nhiệt độ nóng, ấm, lạnh theo trọng số tham số hoá", () => {
  const p = { recentDays: 3, recent: 2, photo: 1, appointment: 2, quote: 1, hotMin: 4, warmMin: 2 };
  const now = new Date("2026-10-10T03:00:00Z");
  const base = { lost: false, lastInteractionAt: null, hasPhoto: false, hasUpcomingAppointment: false, hasOpenQuote: false };
  it("cộng điểm đúng từng dấu hiệu", () => {
    expect(heatOf(base, p, now)).toMatchObject({ heat: "COLD", score: 0 });
    expect(heatOf({ ...base, lastInteractionAt: new Date(now.getTime() - DAY) }, p, now)).toMatchObject({ heat: "WARM", score: 2 });
    expect(heatOf({ ...base, lastInteractionAt: new Date(now.getTime() - 5 * DAY), hasPhoto: true }, p, now)).toMatchObject({ heat: "COLD", score: 1 });
    const hot = heatOf({ ...base, lastInteractionAt: now, hasUpcomingAppointment: true }, p, now);
    expect(hot).toMatchObject({ heat: "HOT", score: 4 });
    expect(hot.factors).toHaveLength(2);
  });
  it("khách mất luôn lạnh; đổi ngưỡng thì đổi nhãn", () => {
    expect(heatOf({ ...base, lost: true, hasUpcomingAppointment: true, hasOpenQuote: true }, p, now).heat).toBe("COLD");
    expect(heatOf({ ...base, hasOpenQuote: true }, { ...p, warmMin: 1 }, now).heat).toBe("WARM");
  });
});

describe("P2: tỉ lệ chuyển giữa các bước từ lịch sử bước", () => {
  it("mỗi khách đếm một lần; chỉ tính chuyển TIẾN sau lần vào bước, không tính mất khách", () => {
    const t = (d: number) => new Date(Date.UTC(2026, 9, d));
    const rows = [
      { customerId: "a", toStage: "NHAN_TIN", createdAt: t(1) },
      { customerId: "a", toStage: "CO_ANH", createdAt: t(2) },
      { customerId: "b", toStage: "NHAN_TIN", createdAt: t(1) },
      { customerId: "b", toStage: "MAT_KHACH", createdAt: t(3) },
      { customerId: "c", toStage: "NHAN_TIN", createdAt: t(2) },
      { customerId: "c", toStage: "NHAN_TIN", createdAt: t(4) },
      { customerId: "d", toStage: "CO_ANH", createdAt: t(1) },
      { customerId: "d", toStage: "LICH_COC", createdAt: t(5) },
    ];
    const conv = conversionFromHistory(rows, ClinicMode.INJECTION);
    expect(conv.get("NHAN_TIN")).toEqual({ entered: 3, moved: 1, rate: 1 / 3 });
    expect(conv.get("CO_ANH")).toEqual({ entered: 2, moved: 1, rate: 0.5 });
    expect(conv.get("DEN_CO_SO")).toEqual({ entered: 0, moved: 0, rate: null });
    expect(conv.has("MAT_KHACH")).toBe(false);
  });
});

describe("J1: dải hành trình", () => {
  it("xếp theo thời gian, khoảng cách ngày với mốc trước, mốc tương lai", () => {
    const now = new Date("2026-10-10T03:00:00Z");
    const j = buildJourney(
      [
        { kind: "VISIT", label: "Đến cơ sở", at: new Date("2026-10-05T03:00:00Z") },
        { kind: "SOURCE", label: "Nguồn", at: new Date("2026-10-01T03:00:00Z") },
        { kind: "RETREAT", label: "Hạn tái tiêm", at: new Date("2027-02-01T03:00:00Z") },
      ],
      now
    );
    expect(j.map((m) => m.kind)).toEqual(["SOURCE", "VISIT", "RETREAT"]);
    expect(j.map((m) => m.gapDays)).toEqual([null, 4, 119]);
    expect(j.map((m) => m.future)).toEqual([false, false, true]);
  });
});

// ======================================================== BẢNG BƯỚC KHỐI

describe("P1 P2 P3: GET /api/customers/pipeline", () => {
  let svc: { id: string; name: string };
  let overdueId: string;
  let freshId: string;
  let hotId: string;

  beforeAll(async () => {
    svc = await service("Filler cằm", 6_000_000);
    const overdue = await customer("Quá hạn", { assignedToId: telesale.id, stage: "NHAN_TIN", daysInStage: 5 });
    overdueId = overdue.id;
    const fresh = await customer("Mới nhắn", { assignedToId: telesale.id, stage: "NHAN_TIN", daysInStage: 0 });
    freshId = fresh.id;
    // Giá trị dự kiến: dịch vụ quan tâm khớp tên bảng giá.
    await prisma.customer.update({ where: { id: freshId }, data: { interest: JSON.stringify([svc.name]) } });
    // Báo giá mở ưu tiên hơn dịch vụ quan tâm.
    await prisma.quotation.create({
      data: { code: `BG-${uid()}`, branchId: ctx.branchId, customerId: overdueId, status: "SENT", total: 9_000_000, subtotal: 9_000_000, items: { create: [{ serviceId: svc.id, name: svc.name, unitPrice: 9_000_000, amount: 9_000_000 }] } },
    });
    // Khách nóng: nhắn hôm nay + có lịch sắp tới + có ảnh.
    const hot = await customer("Nóng", { assignedToId: manager.id, stage: "LICH_COC", daysInStage: 1 });
    hotId = hot.id;
    await prisma.conversation.create({ data: { title: "chat nóng", customerId: hotId, lastInboundAt: new Date() } });
    await prisma.appointment.create({
      data: { branchId: ctx.branchId, customerId: hotId, title: "Hẹn tiêm", startAt: new Date(Date.now() + 2 * DAY), endAt: new Date(Date.now() + 2 * DAY + 3_600_000), depositAmount: 500_000, depositStatus: "DA_COC" },
    });
    await prisma.photoSet.create({ data: { branchId: ctx.branchId, customerId: hotId, stage: "CHAT" } });
    await prisma.task.create({ data: { customerId: hotId, title: "Gọi xác nhận lịch", dueAt: new Date(Date.now() + DAY), assigneeId: manager.id } });
    // Lịch sử chuyển: khách nóng đi từ Nhắn tin sang Có ảnh trong kỳ.
    await prisma.stageHistory.create({ data: { customerId: hotId, fromStage: "TIEP_CAN", toStage: "NHAN_TIN", createdAt: new Date(Date.now() - 6 * DAY) } });
    await prisma.stageHistory.create({ data: { customerId: hotId, fromStage: "NHAN_TIN", toStage: "CO_ANH", createdAt: new Date(Date.now() - 4 * DAY) } });
  });

  it("thẻ có số ngày ở bước, mức quá hạn, nhiệt độ, cọc, việc kế tiếp; đầu cột đếm quá hạn và tỉ lệ chuyển", async () => {
    const res = await ctx.as(manager).get("/api/customers/pipeline").query({ q: TAG });
    expect(res.status).toBe(200);
    expect(res.body.moneyVisible).toBe(true);
    const col = (k: string) => res.body.columns.find((c: { key: string }) => c.key === k);
    const nt = col("NHAN_TIN");
    expect(nt.count).toBe(2);
    expect(nt.overdueCount).toBe(1);
    expect(nt.totalValue).toBe(9_000_000 + 6_000_000);
    // Quá hạn xếp lên đầu cột.
    expect(nt.items[0].id).toBe(overdueId);
    expect(nt.items[0]).toMatchObject({ daysInStage: 5, ageLevel: "OVERDUE", expectedValue: 9_000_000, valueSource: "QUOTE" });
    expect(nt.items[1]).toMatchObject({ daysInStage: 0, ageLevel: "OK", expectedValue: 6_000_000, valueSource: "INTEREST" });
    // 3 khách vào Nhắn tin trong kỳ, 1 khách đã sang bước sau.
    expect(nt.conversion).toEqual({ entered: 3, moved: 1, rate: 1 / 3 });
    const lc = col("LICH_COC");
    expect(lc.items[0]).toMatchObject({ id: hotId, heat: "HOT", deposit: "PAID" });
    expect(lc.items[0].nextTask.title).toBe("Gọi xác nhận lịch");
    expect(col("MAT_KHACH").conversion).toBeNull();
    expect(res.body.columns.filter((c: { inFunnel: boolean }) => c.inFunnel)).toHaveLength(6);
  });

  it("lọc nhanh: nóng, quá hạn, của tôi, dịch vụ", async () => {
    const ids = (body: { columns: Array<{ items: Array<{ id: string }> }> }) => body.columns.flatMap((c) => c.items.map((i) => i.id)).sort();
    expect(ids((await ctx.as(manager).get("/api/customers/pipeline").query({ q: TAG, hot: "1" })).body)).toEqual([hotId]);
    expect(ids((await ctx.as(manager).get("/api/customers/pipeline").query({ q: TAG, overdue: "1" })).body)).toEqual([overdueId]);
    expect(ids((await ctx.as(manager).get("/api/customers/pipeline").query({ q: TAG, mine: "1" })).body)).toEqual([hotId]);
    expect(ids((await ctx.as(manager).get("/api/customers/pipeline").query({ q: TAG, serviceId: svc.id })).body)).toEqual([overdueId, freshId].sort());
  });

  it("Quyết định 3: Telesale chỉ thấy khách của mình và không thấy số tiền", async () => {
    const res = await ctx.as(telesale).get("/api/customers/pipeline").query({ q: TAG });
    expect(res.status).toBe(200);
    expect(res.body.moneyVisible).toBe(false);
    const nt = res.body.columns.find((c: { key: string }) => c.key === "NHAN_TIN");
    expect(nt.count).toBe(2);
    expect(nt.totalValue).toBeNull();
    expect(nt.items.every((i: { expectedValue: unknown; heat: string }) => i.expectedValue === null && Boolean(i.heat))).toBe(true);
    const all = res.body.columns.flatMap((c: { items: Array<{ id: string }> }) => c.items.map((i) => i.id));
    expect(all).not.toContain(hotId);
    const tv = await ctx.as(consultant).get("/api/customers/pipeline").query({ q: TAG });
    expect(tv.body.moneyVisible).toBe(false);
  });

  it("đổi ngưỡng số ngày trong Cài đặt thì đổi mức quá hạn", async () => {
    await setSetting("pipeline.stageMaxDays.NHAN_TIN", "10");
    try {
      const res = await ctx.as(manager).get("/api/customers/pipeline").query({ q: TAG });
      const nt = res.body.columns.find((c: { key: string }) => c.key === "NHAN_TIN");
      expect(nt.overdueCount).toBe(0);
    } finally {
      await clearSetting("pipeline.stageMaxDays.NHAN_TIN");
    }
  });

  it("P3: lưu và đọc lại kiểu xem, bộ lọc của từng người", async () => {
    expect((await ctx.as(telesale).get("/api/customers/pipeline/prefs")).body).toEqual({ view: "kanban", filters: {} });
    const saved = await ctx.as(telesale).put("/api/customers/pipeline/prefs").send({ view: "funnel", filters: { hot: true, mine: true } });
    expect(saved.status).toBe(200);
    expect((await ctx.as(telesale).get("/api/customers/pipeline/prefs")).body).toEqual({ view: "funnel", filters: { hot: true, mine: true } });
    expect((await ctx.as(manager).get("/api/customers/pipeline/prefs")).body.view).toBe("kanban");
    expect((await ctx.as(telesale).put("/api/customers/pipeline/prefs").send({ view: "lung-tung" })).status).toBe(400);
  });
});

// ======================================================== THANH 360

describe("C1 + J1: GET /api/customers/:id/360", () => {
  let cid: string;

  beforeAll(async () => {
    const s = await service("Botox gọn hàm", 4_000_000);
    const c = await customer("Ba sáu mươi", { assignedToId: telesale.id, stage: "LAM_DICH_VU", daysInStage: 2 });
    cid = c.id;
    await prisma.customer.update({ where: { id: cid }, data: { gender: "FEMALE", dob: new Date("1993-04-02T00:00:00Z"), createdAt: new Date(Date.now() - 30 * DAY) } });
    await prisma.conversation.create({ data: { title: "chat 360", customerId: cid, adCampaign: "QC Gọn hàm tháng 9", medicalFlag: true } });
    await prisma.visit.create({ data: { branchId: ctx.branchId, customerId: cid, queueNumber: 1, status: "DONE", checkedInAt: new Date(Date.now() - 10 * DAY) } });
    await prisma.procedureRecord.create({
      data: { code: `PM-${uid()}`, branchId: ctx.branchId, customerId: cid, serviceId: s.id, title: "Botox gọn hàm", status: "COMPLETED", scheduledAt: new Date(Date.now() - 10 * DAY), finishedAt: new Date(Date.now() - 10 * DAY), retreatDueAt: new Date(Date.now() + 110 * DAY) },
    });
    const contract = await prisma.contract.create({ data: { code: `DH-${uid()}`, branchId: ctx.branchId, customerId: cid, status: "SIGNED", total: 4_000_000, subtotal: 4_000_000, signedAt: new Date(Date.now() - 10 * DAY) } });
    await prisma.payment.create({ data: { code: `PT-${uid()}`, branchId: ctx.branchId, customerId: cid, contractId: contract.id, amount: 3_000_000, method: "CASH" } });
    // Thanh toán bằng voucher không phải tiền thật: không tính vào chi trọn đời.
    await prisma.payment.create({ data: { code: `PT-${uid()}`, branchId: ctx.branchId, customerId: cid, contractId: contract.id, amount: 1_000_000, method: "VOUCHER" } });
    await prisma.invoice.create({ data: { code: `HD-${uid()}`, branchId: ctx.branchId, customerId: cid, status: "PARTIAL", amount: 4_000_000, paidAmount: 3_000_000 } });
    await prisma.voucher.create({ data: { code: `VC-${uid()}`, customerId: cid, value: 200_000, expiresAt: new Date(Date.now() + 20 * DAY) } });
    const rec = await prisma.medicalRecord.create({ data: { code: `BA-${uid()}`, branchId: ctx.branchId, customerId: cid } });
    await prisma.allergy.create({ data: { recordId: rec.id, substance: "Lidocaine" } });
  });

  it("vai xem được tiền: chi trọn đời bỏ voucher, đơn TB, công nợ, voucher; hành trình có mốc tương lai", async () => {
    const res = await ctx.as(accountant).get(`/api/customers/${cid}/360`);
    expect(res.status).toBe(200);
    expect(res.body.moneyVisible).toBe(true);
    expect(res.body.money).toMatchObject({ lifetimeSpend: 3_000_000, orderCount: 1, avgOrderValue: 4_000_000, debt: 1_000_000, voucherValue: 200_000 });
    expect(res.body.stats).toMatchObject({ serviceCount: 1, voucherCount: 1, hasDebt: true, retreatOverdue: false });
    expect(res.body.stage).toMatchObject({ key: "LAM_DICH_VU", days: 2, level: "NONE" });
    expect(res.body.customer.profileLabel).toMatch(/^Nữ, \d+ đến \d+ tuổi$/);
    expect(res.body.source.firstAd).toBe("QC Gọn hàm tháng 9");
    const kinds = res.body.journey.map((m: { kind: string }) => m.kind);
    expect(kinds).toEqual(["SOURCE", "VISIT", "SERVICE", "RETREAT"]);
    const retreat = res.body.journey[3];
    expect(retreat.future).toBe(true);
    expect(res.body.journey[1].gapDays).toBe(20);
    // Kế toán không có medical.read: không thấy cờ y khoa.
    expect(res.body.medicalVisible).toBe(false);
    expect(res.body.medical).toBeNull();
  });

  it("Telesale, Tư vấn viên không thấy số tiền; cờ y khoa chỉ với medical.read", async () => {
    const t = await ctx.as(telesale).get(`/api/customers/${cid}/360`);
    expect(t.status).toBe(200);
    expect(t.body.moneyVisible).toBe(false);
    expect(t.body.money).toBeNull();
    expect(t.body.stats.hasDebt).toBe(true);
    expect(t.body.medical).toBeNull();
    expect(JSON.stringify(t.body)).not.toContain("3000000");

    // Bác sĩ thấy cờ y khoa (dị ứng + tin có từ khoá), không thấy tiền.
    const d = await ctx.as(doctor).get(`/api/customers/${cid}/360`);
    expect(d.body.money).toBeNull();
    expect(d.body.medical.flags.map((f: { kind: string }) => f.kind).sort()).toEqual(["ALLERGY", "CHAT_KEYWORD"]);
    const log = await prisma.dataAccessLog.findFirst({ where: { customerId: cid, actorId: doctor.id, resourceType: "MEDICAL_RECORD" } });
    expect(log).not.toBeNull();
  });

  it("ngoài phạm vi trả 404; tư vấn viên được giao tiếp khách check-in hôm nay thì mở được (màn chốt tại quầy)", async () => {
    expect((await ctx.as(consultant).get(`/api/customers/${cid}/360`)).status).toBe(404);
    const v = await prisma.visit.create({ data: { branchId: ctx.branchId, customerId: cid, queueNumber: 7, status: "CONSULTING", consultantId: consultant.id } });
    const ok = await ctx.as(consultant).get(`/api/customers/${cid}/360`);
    expect(ok.status).toBe(200);
    expect(ok.body.money).toBeNull();
    const counter = await ctx.as(consultant).get("/api/crm360/counter");
    expect(counter.status).toBe(200);
    expect(counter.body.items.find((i: { id: string }) => i.id === v.id)).toMatchObject({ mine: true });
    await prisma.visit.update({ where: { id: v.id }, data: { status: "DONE", checkedInAt: new Date(Date.now() - 2 * DAY) } });
  });
});

// ======================================================== V2 BÁN KÈM

describe("V2: luật gợi ý bán kèm và ghi nhận nhận / từ chối", () => {
  let a: { id: string; name: string };
  let b: { id: string; name: string };
  let doneSvc: { id: string; name: string };
  let ruleId: string;

  beforeAll(async () => {
    a = await service("Gọn hàm A", 4_000_000);
    b = await service("Tan mỡ nọng B", 3_000_000);
    doneSvc = await service("Meso đã làm", 2_000_000);
  });

  it("chỉ quản lý khai luật; quản lý cơ sở không khai luật toàn hệ thống; bác sĩ duyệt gỡ nhãn mẫu", async () => {
    const body = { branchId: ctx.branchId, triggerServiceId: a.id, suggestServiceId: b.id, pitch: "Gợi ý tan mỡ nọng sau khi bác sĩ đánh giá", priority: 5 };
    expect((await ctx.as(telesale).post("/api/crm360/upsell-rules").send(body)).status).toBe(403);
    expect((await ctx.as(manager).post("/api/crm360/upsell-rules").send({ ...body, branchId: null })).status).toBe(403);
    expect((await ctx.as(manager).post("/api/crm360/upsell-rules").send({ ...body, suggestServiceId: a.id })).status).toBe(400);
    const created = await ctx.as(manager).post("/api/crm360/upsell-rules").send(body);
    expect(created.status).toBe(201);
    ruleId = created.body.id;
    await prisma.upsellRule.update({ where: { id: ruleId }, data: { isSample: true } });
    expect((await ctx.as(manager).post(`/api/crm360/upsell-rules/${ruleId}/review`)).status).toBe(403);
    const reviewed = await ctx.as(doctor).post(`/api/crm360/upsell-rules/${ruleId}/review`);
    expect(reviewed.status).toBe(200);
    expect(reviewed.body).toMatchObject({ isSample: false, reviewedById: doctor.id });
    // Luật thứ hai gợi ý dịch vụ khách đã làm: bị loại.
    const second = await ctx.as(director).post("/api/crm360/upsell-rules").send({ branchId: null, triggerServiceId: a.id, suggestServiceId: doneSvc.id, pitch: "Gợi ý meso đi kèm" });
    expect(second.status).toBe(201);
  });

  it("gợi ý theo dịch vụ khách đang bàn, bỏ dịch vụ đã làm; ghi gợi ý rồi nhận cập nhật cùng dòng; từ chối ghi lý do; tỉ lệ", async () => {
    const c = await customer("Bán kèm", { assignedToId: telesale.id, stage: "DEN_CO_SO" });
    await prisma.customer.update({ where: { id: c.id }, data: { interest: JSON.stringify([a.name]) } });
    await prisma.procedureRecord.create({
      data: { code: `PM-${uid()}`, branchId: ctx.branchId, customerId: c.id, serviceId: doneSvc.id, title: "Meso", status: "COMPLETED", scheduledAt: new Date(Date.now() - 40 * DAY) },
    });
    const sug = await ctx.as(telesale).get(`/api/crm360/customers/${c.id}/upsell`);
    expect(sug.status).toBe(200);
    expect(sug.body.items.map((i: { suggestServiceId: string }) => i.suggestServiceId)).toEqual([b.id]);
    expect(sug.body.items[0]).toMatchObject({ ruleId, listPrice: 3_000_000, isSample: false, lastOffer: null });

    // Gợi ý kèm hiện trên thẻ cột Đến cơ sở.
    const board = await ctx.as(manager).get("/api/customers/pipeline").query({ q: TAG });
    const den = board.body.columns.find((x: { key: string }) => x.key === "DEN_CO_SO");
    expect(den.items.find((i: { id: string }) => i.id === c.id).upsellHint).toEqual([b.name]);

    const s1 = await ctx.as(telesale).post("/api/crm360/upsell-offers").send({ customerId: c.id, suggestServiceId: b.id, ruleId, context: "INBOX" });
    expect(s1.status).toBe(201);
    const s2 = await ctx.as(telesale).post("/api/crm360/upsell-offers").send({ customerId: c.id, suggestServiceId: b.id, ruleId, context: "INBOX", status: "ACCEPTED" });
    expect(s2.status).toBe(200);
    expect(s2.body.id).toBe(s1.body.id);
    expect(s2.body.status).toBe("ACCEPTED");
    // Luật sai dịch vụ bị chặn; khách ngoài phạm vi trả 404.
    expect((await ctx.as(telesale).post("/api/crm360/upsell-offers").send({ customerId: c.id, suggestServiceId: a.id, ruleId, context: "INBOX" })).status).toBe(400);
    const other = await customer("Không phải của tôi");
    expect((await ctx.as(telesale).post("/api/crm360/upsell-offers").send({ customerId: other.id, suggestServiceId: b.id, context: "INBOX" })).status).toBe(404);

    const c2 = await customer("Từ chối", { assignedToId: telesale.id });
    const d = await ctx.as(telesale).post("/api/crm360/upsell-offers").send({ customerId: c2.id, suggestServiceId: b.id, ruleId, context: "COUNTER", status: "DECLINED", declineReason: "Chưa đủ ngân sách" });
    expect(d.status).toBe(201);
    expect(d.body).toMatchObject({ status: "DECLINED", declineReason: "Chưa đủ ngân sách" });

    const stats = await ctx.as(manager).get("/api/crm360/upsell-offers/stats").query({ days: 7 });
    expect(stats.status).toBe(200);
    const row = stats.body.items.find((r: { ruleId: string }) => r.ruleId === ruleId);
    expect(row).toMatchObject({ suggested: 2, accepted: 1, declined: 1, acceptRate: 0.5 });
    expect((await ctx.as(telesale).get("/api/crm360/upsell-offers/stats")).status).toBe(403);
  });
});

// ======================================================== V1 BÁO GIÁ 3 PHƯƠNG ÁN

describe("V1: báo giá 3 phương án tôn trọng trần giảm theo vai", () => {
  let cid: string;
  let main: { id: string; name: string };
  let extra: { id: string; name: string };
  let up: { id: string; name: string };
  let planId: string;

  beforeAll(async () => {
    main = await service("Filler môi", 5_000_000);
    extra = await service("Botox nhăn", 2_000_000);
    up = await service("Meso cấp ẩm", 1_000_000);
    await prisma.upsellRule.create({ data: { triggerServiceId: main.id, suggestServiceId: up.id, pitch: "Gợi ý cấp ẩm sau tiêm", branchId: ctx.branchId } });
    const c = await customer("Ba phương án", { assignedToId: consultant.id, stage: "DEN_CO_SO" });
    await prisma.customer.update({ where: { id: c.id }, data: { telesaleId: manager.id } });
    cid = c.id;
    const plan = await prisma.treatmentPlan.create({
      data: {
        branchId: ctx.branchId,
        customerId: cid,
        title: "Phác đồ môi và nhăn",
        items: {
          create: [
            { serviceId: main.id, name: main.name, quantity: 2, listPrice: 5_000_000, stepOrder: 1, doseTenths: 15 },
            { serviceId: extra.id, name: extra.name, quantity: 1, listPrice: 2_000_000, stepOrder: 2 },
          ],
        },
      },
    });
    planId = plan.id;
    await setSetting("quote.packageDiscountPercent", "15");
    await setSetting("discount.capPercent.QUAN_LY_CO_SO", "10");
    await setSetting("discount.capPercent.TU_VAN_VIEN", "0");
  });

  it("Cơ bản = dịch vụ chính, Khuyên dùng = cả phác đồ, Trọn gói = + bán kèm; tư vấn viên trần 0% nên Trọn gói không giảm thêm", async () => {
    const res = await ctx.as(consultant).post("/api/crm360/quote-options/preview").send({ customerId: cid });
    expect(res.status).toBe(200);
    expect(res.body.source).toMatchObject({ kind: "PLAN", id: planId });
    expect(res.body).toMatchObject({ capPercent: 0, packageDiscountPercent: 15, appliedPackagePercent: 0, capLimited: true });
    const [basic, rec, pack] = res.body.options;
    expect(basic).toMatchObject({ tier: "BASIC", total: 10_000_000 });
    expect(basic.lines).toHaveLength(1);
    expect(basic.lines[0].name).toContain("1,5");
    expect(rec).toMatchObject({ tier: "RECOMMENDED", total: 12_000_000 });
    expect(pack).toMatchObject({ tier: "PACKAGE", subtotal: 13_000_000, discount: 0, total: 13_000_000 });
    expect(pack.lines.find((l: { serviceId: string }) => l.serviceId === up.id).upsellRuleId).toBeTruthy();
  });

  it("quản lý cơ sở trần 10%: Trọn gói giảm thêm đúng 10% (kẹp trần), chọn thì lập báo giá không cần duyệt và ghi bán kèm đã nhận", async () => {
    const res = await ctx.as(manager).post("/api/crm360/quote-options/preview").send({ customerId: cid, planId });
    expect(res.body).toMatchObject({ capPercent: 10, appliedPackagePercent: 10, capLimited: true });
    const pack = res.body.options[2];
    expect(pack.discount).toBe(1_300_000);
    expect(pack.total).toBe(11_700_000);

    const chosen = await ctx.as(manager).post("/api/crm360/quote-options/choose").send({ customerId: cid, planId, tier: "PACKAGE", accept: true, context: "COUNTER" });
    expect(chosen.status).toBe(201);
    expect(chosen.body.quotation).toMatchObject({ optionTier: "PACKAGE", status: "ACCEPTED", approvalStatus: "NOT_REQUIRED", total: 11_700_000 });
    expect(chosen.body.upsellAccepted).toBe(1);
    const items = await prisma.quotationItem.findMany({ where: { quotationId: chosen.body.quotation.id } });
    expect(items.every((i) => i.discountReason && i.discountAmount - i.promotionDiscount <= Math.ceil(i.quantity * i.unitPrice * 0.1))).toBe(true);
    const offer = await prisma.upsellOffer.findFirst({ where: { customerId: cid, suggestServiceId: up.id } });
    expect(offer).toMatchObject({ status: "ACCEPTED", quotationId: chosen.body.quotation.id, context: "COUNTER" });
    const plan = await prisma.treatmentPlan.findUniqueOrThrow({ where: { id: planId } });
    expect(plan.quotationId).toBe(chosen.body.quotation.id);
  });

  it("tư vấn viên chọn Trọn gói: không có giảm thêm, báo giá nháp; telesale không phụ trách thì 404", async () => {
    const chosen = await ctx.as(consultant).post("/api/crm360/quote-options/choose").send({ customerId: cid, planId, tier: "RECOMMENDED" });
    expect(chosen.status).toBe(201);
    expect(chosen.body.quotation).toMatchObject({ optionTier: "RECOMMENDED", status: "DRAFT", discount: 0, total: 12_000_000 });
    expect((await ctx.as(telesale).post("/api/crm360/quote-options/preview").send({ customerId: cid })).status).toBe(404);
  });

  it("khách chưa có phác đồ, phiếu tư vấn: 400", async () => {
    const c = await customer("Chưa tư vấn", { assignedToId: consultant.id });
    expect((await ctx.as(consultant).post("/api/crm360/quote-options/preview").send({ customerId: c.id })).status).toBe(400);
  });
});
