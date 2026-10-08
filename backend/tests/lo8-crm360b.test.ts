import crypto from "node:crypto";
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { setupTestContext, uniquePhone, prisma, type TestContext, type TestUser } from "./helpers";
import { invalidateSettingsCache } from "../src/lib/settings-catalog";
import { applyStageEvent } from "../src/lib/stages";
import { migrateCustomersToOpportunities, parseSubStages, subStageOf } from "../src/lib/opportunities";
import { aovReport, forecastReport, journeySummary, stageProbabilities } from "../src/lib/crm-reports";
import { packageStats, rulePackageReminder, sessionValue } from "../src/lib/packages";
import { sanitizeSuggestion, loadNeedsOptions } from "../src/lib/needs";
import { setAiClientForTests, type AiClient, type AiRequest } from "../src/lib/ai";
import { ClinicMode, StageEvent } from "../src/types/enums";

// Lô 8 · CRM 360 Lô B: P4 bước con + điều kiện, P5 thả thẻ mở form, P6 pipeline
// theo cơ hội (chuyển dữ liệu + hồi quy báo cáo cũ), C3 hồ sơ nhu cầu, C4 dòng
// thời gian đa kênh, J2 báo cáo hành trình, J3 việc theo bước, V3 gói liệu
// trình, V4 giá trị đơn TB, V6 báo giá bị từ chối, V7 dự báo pipeline.

const uid = () => crypto.randomBytes(4).toString("hex");
const DAY = 86_400_000;
const TAG = `L8${uid()}`;

let ctx: TestContext;
let manager: TestUser;
let telesale: TestUser;
let director: TestUser;
let reception: TestUser;

async function setSetting(key: string, value: string) {
  await prisma.systemSetting.upsert({ where: { key }, create: { key, value }, update: { value } });
  invalidateSettingsCache();
}
async function clearSetting(key: string) {
  await prisma.systemSetting.deleteMany({ where: { key } });
  invalidateSettingsCache();
}

async function service(name: string, price: number) {
  const s = await prisma.service.create({ data: { code: `L8-${uid()}`, name: `${name} ${uid()}`, kind: "INJECTION" } });
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

async function contract(customerId: string, total: number, opts: { items?: Array<{ serviceId?: string | null; name: string; quantity: number; amount: number; upsellById?: string | null }>; signedDaysAgo?: number; consultantId?: string | null } = {}) {
  const items = opts.items ?? [{ name: "Dịch vụ", quantity: 1, amount: total }];
  return prisma.contract.create({
    data: {
      code: `DH-${uid()}`,
      branchId: ctx.branchId,
      customerId,
      status: "SIGNED",
      subtotal: total,
      total,
      consultantId: opts.consultantId ?? null,
      signedAt: new Date(Date.now() - (opts.signedDaysAgo ?? 1) * DAY),
      items: { create: items.map((i) => ({ serviceId: i.serviceId ?? null, name: i.name, quantity: i.quantity, unitPrice: Math.round(i.amount / i.quantity), amount: i.amount, upsellById: i.upsellById ?? null })) },
    },
    include: { items: true },
  });
}

async function upcomingAppointment(customerId: string, deposit: "CHO_COC" | "DA_COC" | null) {
  return prisma.appointment.create({
    data: {
      branchId: ctx.branchId,
      customerId,
      title: "Hẹn tiêm",
      startAt: new Date(Date.now() + 2 * DAY),
      endAt: new Date(Date.now() + 2 * DAY + 3_600_000),
      depositAmount: deposit ? 500_000 : 0,
      depositStatus: deposit,
    },
  });
}

beforeAll(async () => {
  ctx = await setupTestContext("lo8crm");
  manager = await ctx.createUser("QUAN_LY_CO_SO");
  telesale = await ctx.createUser("TELESALE");
  director = await ctx.createUser("GIAM_DOC");
  reception = await ctx.createUser("LE_TAN");
  await ctx.createUser("KE_TOAN");
  await ctx.createUser("QUAN_LY_HE_THONG");
  await setSetting("clinic.mode", "INJECTION");
});

afterAll(async () => {
  await prisma.stageChecklistItem.updateMany({ where: { title: { startsWith: TAG } }, data: { active: false } });
  for (const k of ["pipeline.wipLimits", "pipeline.requireContractStages", "forecast.minSamples", "quote.rejectFollowupDays", "opportunity.autoOpenEvents"]) await clearSetting(k);
});

afterEach(() => setAiClientForTests(undefined));

// ======================================================== P6 CHUYỂN DỮ LIỆU + HỒI QUY

/** Bỏ các trường đổi theo từng lần gọi (mốc tạo báo cáo). */
function stable(body: unknown): string {
  return JSON.stringify(body, (k, v) => (["generatedAt", "now", "asOf", "serverTime"].includes(k) ? undefined : v));
}

describe("P6: chuyển mỗi khách thành đúng một cơ hội, báo cáo cũ không đổi", () => {
  const ids: string[] = [];
  let svc: { id: string; name: string };

  beforeAll(async () => {
    svc = await service("Filler môi", 5_000_000);
    const a = await customer("Chuyển A", { assignedToId: telesale.id, stage: "NHAN_TIN", daysInStage: 3 });
    const b = await customer("Chuyển B", { stage: "LICH_COC", daysInStage: 1 });
    const c = await customer("Chuyển C", { stage: "LAM_DICH_VU", daysInStage: 10 });
    const d = await customer("Chuyển D", { stage: "MAT_KHACH", daysInStage: 2 });
    await prisma.customer.update({ where: { id: d.id }, data: { lostReason: "CHE_GIA" } });
    await prisma.customer.update({ where: { id: a.id }, data: { interest: JSON.stringify([svc.name]) } });
    await prisma.stageHistory.create({ data: { customerId: c.id, fromStage: "LAM_DICH_VU", toStage: "LAM_DICH_VU", createdAt: new Date(Date.now() - 5 * DAY) } });
    await contract(c.id, 7_000_000, { consultantId: manager.id });
    await prisma.payment.create({ data: { code: `PT-${uid()}`, branchId: ctx.branchId, customerId: c.id, amount: 3_000_000, method: "CASH" } });
    ids.push(a.id, b.id, c.id, d.id);
  });

  it("xem trước không ghi gì; chạy thật tạo đúng một cơ hội mỗi khách, gắn lịch sử, giữ bước khách; chạy lại không tạo thêm", async () => {
    const reportUrls = [
      "/api/reports/dashboard",
      "/api/reports/revenue",
      "/api/reports/marketing/funnel",
      "/api/reports/staff-performance",
      "/api/analytics/weekly",
      "/api/analytics/eod",
      "/api/analytics/retention",
      "/api/analytics/ltv",
      "/api/home",
    ];
    const snapshot = async () => {
      const out: Record<string, string> = {};
      for (const u of reportUrls) {
        const r = await ctx.as(director).get(u);
        expect({ u, status: r.status }).toEqual({ u, status: 200 });
        out[u] = stable(r.body);
      }
      const pipe = await ctx.as(director).get("/api/customers/pipeline").query({ q: TAG });
      out.pipeline = stable(
        pipe.body.columns.map((col: { key: string; count: number; totalValue: number; overdueCount: number; conversion: unknown; items: Array<{ id: string; daysInStage: number; expectedValue: number; heat: string }> }) => ({
          key: col.key,
          count: col.count,
          totalValue: col.totalValue,
          overdueCount: col.overdueCount,
          conversion: col.conversion,
          items: col.items.map((i) => [i.id, i.daysInStage, i.expectedValue, i.heat]),
        }))
      );
      out.stages = JSON.stringify(await prisma.customer.findMany({ where: { id: { in: ids } }, orderBy: { id: "asc" }, select: { id: true, stage: true, lostReason: true, stageChangedAt: true } }));
      return out;
    };
    const before = await snapshot();

    const dry = await migrateCustomersToOpportunities({ apply: false });
    expect(dry.toCreate).toBeGreaterThanOrEqual(4);
    expect(await prisma.opportunity.count({ where: { customerId: { in: ids } } })).toBe(0);

    const run = await migrateCustomersToOpportunities({ apply: true });
    expect(run.created).toBe(dry.toCreate);
    for (const id of ids) {
      const opps = await prisma.opportunity.findMany({ where: { customerId: id } });
      expect(opps).toHaveLength(1);
      const cust = await prisma.customer.findUniqueOrThrow({ where: { id } });
      expect(opps[0].stage).toBe(cust.stage);
      expect(await prisma.stageHistory.count({ where: { customerId: id, opportunityId: null } })).toBe(0);
    }
    const [oa] = await prisma.opportunity.findMany({ where: { customerId: ids[0] } });
    expect(oa).toMatchObject({ status: "OPEN", ownerId: telesale.id, serviceId: svc.id, source: "MIGRATION" });
    expect((await prisma.opportunity.findFirstOrThrow({ where: { customerId: ids[2] } })).status).toBe("WON");
    expect(await prisma.opportunity.findFirstOrThrow({ where: { customerId: ids[3] } })).toMatchObject({ status: "LOST", lostReason: "CHE_GIA" });

    const again = await migrateCustomersToOpportunities({ apply: true });
    expect(again.created).toBe(0);
    expect(again.toCreate).toBe(0);

    // HỒI QUY: báo cáo cũ, bảng bước (giờ đọc cơ hội), bước khách ra y hệt trước khi chuyển.
    const after = await snapshot();
    for (const k of Object.keys(before)) expect({ k, v: after[k] }).toEqual({ k, v: before[k] });
  });

  it("khách mới chưa có cơ hội: đổi bước tay tạo đúng một cơ hội rồi đổi bước cơ hội đó", async () => {
    const c = await customer("Lười");
    const r = await ctx.as(manager).post(`/api/customers/${c.id}/stage`).send({ stage: "NHAN_TIN" });
    expect(r.status).toBe(200);
    const opps = await prisma.opportunity.findMany({ where: { customerId: c.id } });
    expect(opps.map((o) => o.stage)).toEqual(["NHAN_TIN"]);
    const h = await prisma.stageHistory.findFirstOrThrow({ where: { customerId: c.id } });
    expect(h.opportunityId).toBe(opps[0].id);
  });
});

describe("P6: khách đã làm dịch vụ quay lại thì mở cơ hội mới", () => {
  it("cọc / check-in sau thời gian chăm sóc: cơ hội mới, bước khách = cơ hội mở mới nhất; trong thời gian chăm sóc thì không", async () => {
    const c = await customer("Quay lại", { assignedToId: telesale.id });
    const longAgo = new Date(Date.now() - 60 * DAY);
    await applyStageEvent(c.id, StageEvent.PROCEDURE_DONE, { at: longAgo });
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: c.id } })).stage).toBe("LAM_DICH_VU");
    // Tin nhắn chăm sóc không mở cơ hội mới (mặc định không nằm trong danh sách sự kiện).
    expect((await applyStageEvent(c.id, StageEvent.MESSAGE)).changed).toBe(false);
    const r = await applyStageEvent(c.id, StageEvent.CHECK_IN);
    expect(r).toMatchObject({ changed: true, to: "DEN_CO_SO" });
    const opps = await prisma.opportunity.findMany({ where: { customerId: c.id }, orderBy: { createdAt: "asc" } });
    expect(opps.map((o) => [o.stage, o.status])).toEqual([
      ["LAM_DICH_VU", "WON"],
      ["DEN_CO_SO", "OPEN"],
    ]);
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: c.id } })).stage).toBe("DEN_CO_SO");
    // Làm dịch vụ lần hai trong 180 ngày: cơ hội mới sang Quay lại (thắng), bước khách theo.
    expect((await applyStageEvent(c.id, StageEvent.VISIT_SERVICE_DONE)).to).toBe("QUAY_LAI");
    expect((await prisma.opportunity.findUniqueOrThrow({ where: { id: opps[1].id } })).status).toBe("WON");
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: c.id } })).stage).toBe("QUAY_LAI");

    // Bảng bước: khách không còn cơ hội mở thì hiện cơ hội gần nhất.
    const pipe = await ctx.as(manager).get("/api/customers/pipeline").query({ q: TAG });
    const cards = pipe.body.columns.flatMap((col: { key: string; items: Array<{ id: string; opportunityId: string }> }) => col.items.map((i) => ({ ...i, col: col.key }))).filter((i: { id: string }) => i.id === c.id);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ col: "QUAY_LAI", opportunityId: opps[1].id });

    const recent = await customer("Tái khám");
    await applyStageEvent(recent.id, StageEvent.PROCEDURE_DONE, { at: new Date(Date.now() - 3 * DAY) });
    expect((await applyStageEvent(recent.id, StageEvent.CHECK_IN)).changed).toBe(false);
    expect(await prisma.opportunity.count({ where: { customerId: recent.id } })).toBe(1);
  });

  it("mở cơ hội tay theo dịch vụ, không trùng dịch vụ; bảng hiện mỗi cơ hội mở một thẻ", async () => {
    const svc = await service("Botox xoá nhăn", 3_000_000);
    const svc2 = await service("Meso căng bóng", 2_000_000);
    const c = await customer("Hai cơ hội", { assignedToId: telesale.id, stage: "NHAN_TIN", daysInStage: 1 });
    const o1 = await ctx.as(telesale).post(`/api/crm360/customers/${c.id}/opportunities`).send({ serviceId: svc.id });
    expect(o1.status).toBe(201);
    expect((await ctx.as(telesale).post(`/api/crm360/customers/${c.id}/opportunities`).send({ serviceId: svc.id })).status).toBe(409);
    expect((await ctx.as(telesale).post(`/api/crm360/customers/${c.id}/opportunities`).send({ serviceId: svc2.id, stage: "LAM_DICH_VU" })).status).toBe(400);
    // Telesale không nhập được giá trị dự kiến (Quyết định 3).
    expect((await ctx.as(telesale).post(`/api/crm360/customers/${c.id}/opportunities`).send({ serviceId: svc2.id, expectedValue: 1 })).status).toBe(403);
    const list = await ctx.as(manager).get(`/api/crm360/customers/${c.id}/opportunities`);
    expect(list.body.items).toHaveLength(2);
    expect(list.body.currentId).toBe(o1.body.id);
    expect(list.body.items[0]).toMatchObject({ title: svc.name, stage: "TIEP_CAN", expectedValue: 3_000_000, valueSource: "SERVICE" });
    const pipe = await ctx.as(manager).get("/api/customers/pipeline").query({ q: TAG });
    const mine = pipe.body.columns.flatMap((col: { items: Array<{ id: string; opportunityId: string }> }) => col.items).filter((i: { id: string }) => i.id === c.id);
    expect(mine).toHaveLength(2);
    // Đổi bước một cơ hội: cơ hội kia giữ nguyên, bước khách = cơ hội mở mới nhất.
    const mv = await ctx.as(manager).post(`/api/crm360/opportunities/${o1.body.id}/stage`).send({ stage: "CO_ANH" });
    expect(mv.status).toBe(200);
    expect(mv.body.customerStage).toBe("CO_ANH");
    const older = list.body.items[1];
    expect((await prisma.opportunity.findUniqueOrThrow({ where: { id: older.id } })).stage).toBe("NHAN_TIN");
  });
});

// ======================================================== P4 + P5

describe("P4 + P5: bước con, giới hạn cột, điều kiện khi kéo, thả thẻ mở form", () => {
  it("sang Lịch cọc phải có lịch; có lịch chưa cọc thì bước con Đã hẹn chưa cọc, cọc xong thành Đã cọc", async () => {
    const c = await customer("Lịch cọc", { assignedToId: manager.id, stage: "CO_ANH", daysInStage: 1 });
    const noAppt = await ctx.as(manager).post(`/api/customers/${c.id}/stage`).send({ stage: "LICH_COC" });
    expect(noAppt.status).toBe(409);
    expect(noAppt.body).toMatchObject({ missing: ["APPOINTMENT"], action: "BOOK" });
    const check = await ctx.as(manager).get(`/api/crm360/customers/${c.id}/drop-check`).query({ to: "LICH_COC" });
    expect(check.body).toMatchObject({ blocking: true, action: "BOOK" });

    const appt = await upcomingAppointment(c.id, "CHO_COC");
    const opp = await prisma.opportunity.findFirstOrThrow({ where: { customerId: c.id } });
    const plan = await ctx.as(manager).get(`/api/crm360/opportunities/${opp.id}/drop-check`).query({ to: "LICH_COC" });
    expect(plan.body).toMatchObject({ blocking: false, action: "DEPOSIT", missing: [] });
    expect((await ctx.as(manager).post(`/api/crm360/opportunities/${opp.id}/stage`).send({ stage: "LICH_COC" })).status).toBe(200);

    const card = async () => {
      const pipe = await ctx.as(manager).get("/api/customers/pipeline").query({ q: TAG });
      const col = pipe.body.columns.find((x: { key: string }) => x.key === "LICH_COC");
      return { col, card: col.items.find((i: { id: string }) => i.id === c.id) };
    };
    let r = await card();
    expect(r.card.subStage).toBe("HEN_CHUA_COC");
    expect(r.col.subStages.map((s: { key: string }) => s.key)).toEqual(["HEN_CHUA_COC", "DA_COC"]);
    await prisma.appointment.update({ where: { id: appt.id }, data: { depositStatus: "DA_COC" } });
    r = await card();
    expect(r.card.subStage).toBe("DA_COC");
    expect(r.col.subStages.find((s: { key: string }) => s.key === "DA_COC").count).toBeGreaterThanOrEqual(1);

    // P5: thả vào Đến cơ sở mở lập báo giá, Mất khách mở lý do.
    expect((await ctx.as(manager).get(`/api/crm360/opportunities/${opp.id}/drop-check`).query({ to: "DEN_CO_SO" })).body.action).toBe("QUOTE");
    expect((await ctx.as(manager).get(`/api/crm360/opportunities/${opp.id}/drop-check`).query({ to: "MAT_KHACH" })).body.action).toBe("LOST_REASON");
  });

  it("sang Làm dịch vụ phải có hợp đồng; tắt điều kiện trong Cài đặt thì kéo được; giới hạn cột cảnh báo", async () => {
    const c = await customer("Hợp đồng", { assignedToId: manager.id, stage: "DEN_CO_SO", daysInStage: 0 });
    const no = await ctx.as(manager).post(`/api/customers/${c.id}/stage`).send({ stage: "LAM_DICH_VU" });
    expect(no.status).toBe(409);
    expect(no.body).toMatchObject({ missing: ["CONTRACT"], action: "CONTRACT" });
    await contract(c.id, 4_000_000);
    expect((await ctx.as(manager).post(`/api/customers/${c.id}/stage`).send({ stage: "LAM_DICH_VU" })).status).toBe(200);

    const c2 = await customer("Không cần hợp đồng", { assignedToId: manager.id, stage: "DEN_CO_SO" });
    await setSetting("pipeline.requireContractStages", "");
    try {
      expect((await ctx.as(manager).post(`/api/customers/${c2.id}/stage`).send({ stage: "LAM_DICH_VU" })).status).toBe(200);
    } finally {
      await clearSetting("pipeline.requireContractStages");
    }
    expect((await ctx.as("QUAN_LY_HE_THONG").put("/api/settings").send({ values: { "pipeline.wipLimits": "LICH_COC:abc" } })).status).toBe(400);
    await setSetting("pipeline.wipLimits", "LAM_DICH_VU:1");
    try {
      const pipe = await ctx.as(manager).get("/api/customers/pipeline").query({ q: TAG });
      const col = pipe.body.columns.find((x: { key: string }) => x.key === "LAM_DICH_VU");
      expect(col.wipLimit).toBe(1);
      expect(col.overWip).toBe(col.count > 1);
    } finally {
      await clearSetting("pipeline.wipLimits");
    }
  });

  it("bước con tay: đọc từ Cài đặt, bước con theo cọc không chọn tay được", () => {
    const defs = parseSubStages("LICH_COC:HEN_CHUA_COC=Đã hẹn chưa cọc|DA_COC=Đã cọc;CO_ANH:CHO_BS=Chờ bác sĩ xem|DA_XEM=Bác sĩ đã xem");
    expect(subStageOf(defs, "CO_ANH", "DA_XEM", null)).toBe("DA_XEM");
    expect(subStageOf(defs, "CO_ANH", "LA", null)).toBeNull();
    expect(subStageOf(defs, "LICH_COC", "DA_COC", "UNPAID")).toBe("HEN_CHUA_COC");
    expect(subStageOf(defs, "NHAN_TIN", null, null)).toBeNull();
  });
});

// ======================================================== C3

class FakeAi implements AiClient {
  calls: AiRequest[] = [];
  constructor(private text: string) {}
  async complete(req: AiRequest) {
    this.calls.push(req);
    return { text: this.text, model: req.model };
  }
}

describe("C3: hồ sơ nhu cầu chọn nhanh, AI1 gợi ý", () => {
  it("lưu lựa chọn trong danh sách tham số, từ chối lựa chọn ngoài danh sách; ghi nhật ký", async () => {
    const c = await customer("Nhu cầu", { assignedToId: telesale.id });
    const opts = (await ctx.as(telesale).get(`/api/crm360/customers/${c.id}/needs`)).body.options;
    const ok = await ctx.as(telesale).put(`/api/crm360/customers/${c.id}/needs`).send({
      areas: ["MOI", "CAM"],
      budget: opts.budgets[1],
      fears: [opts.fears[0]],
      decisionMaker: opts.decisionMakers[0],
      occasion: opts.occasions[0],
      comparing: ["Phòng khám X", "Phòng khám X"],
    });
    expect(ok.status).toBe(200);
    const got = (await ctx.as(telesale).get(`/api/crm360/customers/${c.id}/needs`)).body.needs;
    expect(got).toMatchObject({ areas: ["MOI", "CAM"], budget: opts.budgets[1], comparing: ["Phòng khám X"] });
    expect((await ctx.as(telesale).put(`/api/crm360/customers/${c.id}/needs`).send({ budget: "1 tỷ" })).status).toBe(400);
    expect((await ctx.as(telesale).put(`/api/crm360/customers/${c.id}/needs`).send({ areas: ["BUNG"] })).status).toBe(400);
    expect(await prisma.auditLog.count({ where: { entityId: c.id, summary: { contains: "hồ sơ nhu cầu" } } })).toBe(1);
  });

  it("AI1 chỉ gợi ý khi khách đồng ý; bỏ phần AI đoán ngoài danh sách; không tự ghi", async () => {
    const o = await loadNeedsOptions();
    const fake = new FakeAi(JSON.stringify({ areas: ["MOI", "BUNG"], budget: o.budgets[2], fears: [o.fears[0], "Sợ ma"], decisionMaker: "Ông hàng xóm", occasion: o.occasions[0], comparing: ["Spa Y"] }));
    setAiClientForTests(fake);
    const c = await customer("AI nhu cầu", { assignedToId: telesale.id });
    const conv = await prisma.conversation.create({ data: { title: "nhu cầu", channel: "FACEBOOK", customerId: c.id, branchId: ctx.branchId } });
    await prisma.chatMessage.create({ data: { conversationId: conv.id, direction: "IN", content: "Em muốn làm môi, tầm 10 đến 20 triệu, cưới tháng sau" } });
    const no = await ctx.as(telesale).post(`/api/crm360/customers/${c.id}/needs/suggest`);
    expect(no.body.status).toBe("NO_CONSENT");
    expect(fake.calls).toHaveLength(0);
    await prisma.customer.update({ where: { id: c.id }, data: { aiDataConsent: true } });
    const res = await ctx.as(telesale).post(`/api/crm360/customers/${c.id}/needs/suggest`);
    expect(res.body.status).toBe("OK");
    expect(res.body.suggestion).toEqual({ areas: ["MOI"], budget: o.budgets[2], fears: [o.fears[0]], occasion: o.occasions[0], comparing: ["Spa Y"] });
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: c.id } })).needsProfile).toBeNull();
    expect(sanitizeSuggestion({ budget: "bịa" }, o)).toEqual({});
  });
});

// ======================================================== C4

describe("C4: dòng thời gian đa kênh có lọc", () => {
  it("gom tin Facebook, Zalo, cuộc gọi, lần đến, báo giá, thanh toán; lọc theo loại, kênh; ẩn tiền với telesale; phân trang", async () => {
    const c = await customer("Dòng thời gian", { assignedToId: telesale.id });
    const t = (m: number) => new Date(Date.now() - m * 60_000);
    const fb = await prisma.conversation.create({ data: { title: "fb", channel: "FACEBOOK", customerId: c.id } });
    const zl = await prisma.conversation.create({ data: { title: "zl", channel: "ZALO_OA", customerId: c.id } });
    await prisma.chatMessage.create({ data: { conversationId: fb.id, direction: "IN", content: "Chào shop", createdAt: t(60) } });
    await prisma.chatMessage.create({ data: { conversationId: zl.id, direction: "OUT", content: "Dạ em chào chị", senderName: "Sale A", createdAt: t(50) } });
    await prisma.visit.create({ data: { branchId: ctx.branchId, customerId: c.id, queueNumber: 9, checkedInAt: t(40) } });
    await prisma.quotation.create({ data: { code: `BG-${uid()}`, branchId: ctx.branchId, customerId: c.id, status: "SENT", total: 6_000_000, subtotal: 6_000_000, createdAt: t(30) } });
    await prisma.payment.create({ data: { code: `PT-${uid()}`, branchId: ctx.branchId, customerId: c.id, amount: 2_000_000, method: "CASH", paidAt: t(20) } });
    const call = await ctx.as(telesale).post(`/api/crm360/customers/${c.id}/calls`).send({ direction: "OUT", result: "ANSWERED", durationSec: 180, note: "Khách hẹn thứ 7" });
    expect(call.status).toBe(201);

    const all = await ctx.as(manager).get(`/api/crm360/customers/${c.id}/timeline`);
    expect(all.status).toBe(200);
    expect(all.body.items.map((i: { kind: string }) => i.kind)).toEqual(["CALL", "PAYMENT", "QUOTE", "VISIT", "MESSAGE", "MESSAGE"]);
    expect(all.body.items[0].title).toContain("nghe máy");
    expect(all.body.items[1].amount).toBe(2_000_000);
    expect(all.body.channels.map((x: { key: string }) => x.key).sort()).toEqual(["FACEBOOK", "ZALO_OA"]);

    const fbOnly = await ctx.as(manager).get(`/api/crm360/customers/${c.id}/timeline`).query({ channel: "FACEBOOK" });
    expect(fbOnly.body.items.map((i: { text: string }) => i.text)).toEqual(["Chào shop"]);
    const money = await ctx.as(manager).get(`/api/crm360/customers/${c.id}/timeline`).query({ kinds: "PAYMENT,QUOTE" });
    expect(money.body.items.map((i: { kind: string }) => i.kind)).toEqual(["PAYMENT", "QUOTE"]);

    const ts = await ctx.as(telesale).get(`/api/crm360/customers/${c.id}/timeline`);
    expect(ts.body.items.every((i: { amount: unknown }) => i.amount === null)).toBe(true);

    const p1 = await ctx.as(manager).get(`/api/crm360/customers/${c.id}/timeline`).query({ limit: 4 });
    expect(p1.body.items).toHaveLength(4);
    expect(p1.body.nextBefore).toBeTruthy();
    const p2 = await ctx.as(manager).get(`/api/crm360/customers/${c.id}/timeline`).query({ limit: 4, before: p1.body.nextBefore });
    expect(p2.body.items.map((i: { kind: string }) => i.kind)).toEqual(["MESSAGE", "MESSAGE"]);
    expect(p2.body.nextBefore).toBeNull();

    const other = await customer("Không phải khách của telesale");
    expect((await ctx.as(telesale).get(`/api/crm360/customers/${other.id}/timeline`)).status).toBe(404);
  });
});

// ======================================================== J2 + J3

describe("J2: báo cáo hành trình", () => {
  it("thời gian TB mỗi bước, bước rơi nhiều nhất (hàm thuần)", () => {
    const t = (d: number) => new Date(Date.UTC(2026, 8, d));
    const rows = [
      { key: "a", fromStage: null, toStage: "NHAN_TIN", createdAt: t(1) },
      { key: "a", fromStage: "NHAN_TIN", toStage: "CO_ANH", createdAt: t(3) },
      { key: "a", fromStage: "CO_ANH", toStage: "MAT_KHACH", createdAt: t(4) },
      { key: "b", fromStage: null, toStage: "NHAN_TIN", createdAt: t(2) },
      { key: "b", fromStage: "NHAN_TIN", toStage: "MAT_KHACH", createdAt: t(6) },
      { key: "c", fromStage: null, toStage: "NHAN_TIN", createdAt: t(5) },
      { key: "c", fromStage: "NHAN_TIN", toStage: "MAT_KHACH", createdAt: t(6) },
    ];
    const s = journeySummary(rows, ClinicMode.INJECTION, { from: t(1), to: t(30) });
    const nt = s.stages.find((x) => x.stage === "NHAN_TIN")!;
    expect(nt).toEqual({ stage: "NHAN_TIN", entered: 3, completed: 3, avgDays: Math.round(((2 + 4 + 1) / 3) * 10) / 10, dropped: 2 });
    expect(s.stages.find((x) => x.stage === "CO_ANH")).toMatchObject({ entered: 1, avgDays: 1, dropped: 1 });
    expect(s.topDrop).toEqual({ stage: "NHAN_TIN", dropped: 2 });
    expect(s).toMatchObject({ units: 3, lost: 3 });
  });

  it("endpoint theo sale; telesale chỉ thấy cơ hội của mình", async () => {
    const res = await ctx.as(manager).get("/api/crm360/reports/journey").query({ groupBy: "sale", days: 30 });
    expect(res.status).toBe(200);
    expect(res.body.overall.stages.length).toBe(7);
    expect(res.body.groups.length).toBeGreaterThan(0);
    const ts = await ctx.as(telesale).get("/api/crm360/reports/journey").query({ groupBy: "channel" });
    expect(ts.status).toBe(200);
    expect(ts.body.overall.units).toBeLessThanOrEqual(res.body.overall.units);
  });
});

describe("J3: việc theo bước", () => {
  it("vào bước thì sinh việc theo checklist kèm mẫu tin; không sinh trùng khi việc còn mở; chỉ quản lý khai checklist", async () => {
    expect((await ctx.as(telesale).post("/api/crm360/stage-checklist").send({ stage: "CO_ANH", title: `${TAG} không được` })).status).toBe(403);
    // Quản lý cơ sở không khai được việc cho mọi cơ sở.
    expect((await ctx.as(manager).post("/api/crm360/stage-checklist").send({ stage: "CO_ANH", title: `${TAG} mọi cơ sở` })).status).toBe(403);
    const item = await ctx.as(manager).post("/api/crm360/stage-checklist").send({
      stage: "CO_ANH",
      branchId: ctx.branchId,
      title: `${TAG} Gửi nhận xét bác sĩ`,
      messageTemplate: "Dạ bác sĩ đã xem ảnh của chị ạ.",
      dueDays: 1,
    });
    expect(item.status).toBe(201);
    const c = await customer("Việc theo bước", { assignedToId: telesale.id, stage: "NHAN_TIN" });
    await ctx.as(manager).post(`/api/customers/${c.id}/stage`).send({ stage: "CO_ANH" });
    const tasks = await prisma.task.findMany({ where: { customerId: c.id, kind: "STAGE_CHECKLIST" } });
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ title: `${TAG} Gửi nhận xét bác sĩ`, assigneeId: telesale.id, stageKey: "CO_ANH", checklistItemId: item.body.id });
    expect(tasks[0].description).toContain("Mẫu tin gợi ý");
    expect(tasks[0].dueAt!.getTime()).toBeGreaterThan(Date.now() + 12 * 3_600_000);
    // Lùi rồi vào lại khi việc cũ còn mở: không sinh thêm.
    await ctx.as(manager).post(`/api/customers/${c.id}/stage`).send({ stage: "NHAN_TIN", reason: "Khách gửi lại ảnh" });
    await ctx.as(manager).post(`/api/customers/${c.id}/stage`).send({ stage: "CO_ANH" });
    expect(await prisma.task.count({ where: { customerId: c.id, kind: "STAGE_CHECKLIST" } })).toBe(1);
    const list = await ctx.as(telesale).get("/api/crm360/stage-checklist");
    expect(list.body.canManage).toBe(false);
    expect(list.body.items.some((i: { id: string }) => i.id === item.body.id)).toBe(true);
  });
});

// ======================================================== V3

describe("V3: gói liệu trình nhiều buổi trả trước", () => {
  it("giá buổi chia đều, buổi cuối nhận phần dư", () => {
    expect([1, 2, 3].map((n) => sessionValue(10_000_000, 3, n))).toEqual([3_333_333, 3_333_333, 3_333_334]);
    expect(packageStats({ price: 10_000_000, totalSessions: 3, usedSessions: 2 })).toEqual({ remainingSessions: 1, usedValue: 6_666_666, remainingValue: 3_333_334 });
  });

  it("lập gói từ dòng hợp đồng, trừ buổi, hết buổi thì xong; doanh số vẫn theo hợp đồng ký; nhắc đặt buổi tiếp một lần", async () => {
    const svc = await service("Meso 3 buổi", 3_000_000);
    const c = await customer("Gói", { assignedToId: telesale.id });
    const k = await contract(c.id, 9_000_000, { items: [{ serviceId: svc.id, name: svc.name, quantity: 3, amount: 9_000_000 }], signedDaysAgo: 40 });
    await prisma.payment.create({ data: { code: `PT-${uid()}`, branchId: ctx.branchId, customerId: c.id, contractId: k.id, amount: 9_000_000, method: "TRANSFER" } });
    await prisma.contract.update({ where: { id: k.id }, data: { paidAmount: 9_000_000 } });

    const cand = await ctx.as(manager).get(`/api/crm360/customers/${c.id}/packages`);
    expect(cand.body.candidates.map((x: { id: string }) => x.id)).toEqual([k.items[0].id]);
    expect((await ctx.as(telesale).post("/api/crm360/packages").send({ contractItemId: k.items[0].id })).status).toBe(403);
    const pkg = await ctx.as(manager).post("/api/crm360/packages").send({ contractItemId: k.items[0].id, intervalDays: 21 });
    expect(pkg.status).toBe(201);
    expect(pkg.body).toMatchObject({ totalSessions: 3, usedSessions: 0, price: 9_000_000 });
    expect(pkg.body.expiresAt).toBeTruthy();
    expect((await ctx.as(manager).post("/api/crm360/packages").send({ contractItemId: k.items[0].id })).status).toBe(409);

    // Lập gói 40 ngày trước (giả lập), chưa dùng buổi nào, không có lịch: nhắc một lần.
    await prisma.treatmentPackage.update({ where: { id: pkg.body.id }, data: { createdAt: new Date(Date.now() - 30 * DAY) } });
    expect((await rulePackageReminder(new Date())).created).toBeGreaterThanOrEqual(1);
    const reminders = await prisma.task.findMany({ where: { customerId: c.id, kind: "PACKAGE_REMINDER" } });
    expect(reminders).toHaveLength(1);
    expect(reminders[0].assigneeId).toBe(telesale.id);
    await rulePackageReminder(new Date());
    expect(await prisma.task.count({ where: { customerId: c.id, kind: "PACKAGE_REMINDER" } })).toBe(1);

    for (let i = 1; i <= 3; i++) {
      // Buổi 1 telesale bấm (không thấy tiền, Quyết định 3); buổi sau lễ tân (finance.read cơ sở, thấy tiền).
      const r = await ctx.as(i === 1 ? telesale : reception).post(`/api/crm360/packages/${pkg.body.id}/sessions`).send({ note: `Buổi ${i}` });
      expect(r.status).toBe(201);
      expect(r.body.session.sessionNo).toBe(i);
      expect(r.body.session.value).toBe(i === 1 ? null : 3_000_000);
    }
    expect((await ctx.as(reception).post(`/api/crm360/packages/${pkg.body.id}/sessions`).send({})).status).toBe(409);
    const after = await prisma.treatmentPackage.findUniqueOrThrow({ where: { id: pkg.body.id }, include: { sessions: true } });
    expect(after.status).toBe("COMPLETED");
    expect(after.sessions.reduce((s, x) => s + x.value, 0)).toBe(9_000_000);
    expect((await prisma.contractItem.findUniqueOrThrow({ where: { id: k.items[0].id } })).deliveredQty).toBe(3);
    // Đã có buổi gần nhất hôm nay: gói xong thì không nhắc nữa.
    await rulePackageReminder(new Date(Date.now() + 60 * DAY));
    expect(await prisma.task.count({ where: { customerId: c.id, kind: "PACKAGE_REMINDER" } })).toBe(1);

    const sum = await ctx.as("KE_TOAN").get("/api/crm360/packages/summary");
    expect(sum.status).toBe(200);
    expect(sum.body.note).toContain("theo hợp đồng ký");
    expect(sum.body.soldValue).toBeGreaterThanOrEqual(9_000_000);
    expect((await ctx.as(telesale).get("/api/crm360/packages/summary")).status).toBe(403);
  });

  it("khách đang có gói còn buổi: check-in không mở cơ hội mới", async () => {
    const c = await customer("Gói còn buổi");
    await applyStageEvent(c.id, StageEvent.PROCEDURE_DONE, { at: new Date(Date.now() - 40 * DAY) });
    const k = await contract(c.id, 4_000_000, { items: [{ name: "Gói 2 buổi", quantity: 2, amount: 4_000_000 }] });
    await ctx.as(manager).post("/api/crm360/packages").send({ contractItemId: k.items[0].id });
    expect((await applyStageEvent(c.id, StageEvent.CHECK_IN)).changed).toBe(false);
    expect(await prisma.opportunity.count({ where: { customerId: c.id } })).toBe(1);
  });
});

// ======================================================== V4

describe("V4: giá trị đơn trung bình (chỉ đo)", () => {
  it("hàm thuần: tổng, theo chiều, tỉ lệ đơn có bán kèm", () => {
    const r = aovReport(
      [
        { id: "1", total: 4_000_000, hasUpsell: true, dims: { sale: "a" } },
        { id: "2", total: 2_000_000, hasUpsell: false, dims: { sale: "a" } },
        { id: "3", total: 9_000_000, hasUpsell: false, dims: { sale: "b" } },
      ],
      ["sale"]
    );
    expect(r.overall).toMatchObject({ orders: 3, revenue: 15_000_000, avg: 5_000_000, withUpsell: 1 });
    expect(r.by.sale.find((x) => x.key === "a")).toMatchObject({ orders: 2, avg: 3_000_000, upsellRate: 0.5 });
  });

  it("endpoint: theo sale, cơ sở, dịch vụ đầu vào; telesale không xem được", async () => {
    const svc = await service("Đầu vào", 1_000_000);
    const c = await customer("Đơn TB");
    await contract(c.id, 5_000_000, { consultantId: manager.id, signedDaysAgo: 20, items: [{ serviceId: svc.id, name: svc.name, quantity: 1, amount: 5_000_000 }] });
    await contract(c.id, 3_000_000, { consultantId: manager.id, signedDaysAgo: 2, items: [{ name: "Kèm", quantity: 1, amount: 3_000_000, upsellById: manager.id }] });
    const res = await ctx.as(manager).get("/api/crm360/reports/aov").query({ days: 30 });
    expect(res.status).toBe(200);
    const me = res.body.by.sale.find((x: { key: string }) => x.key === manager.id);
    expect(me).toMatchObject({ label: expect.any(String) });
    expect(me.orders).toBeGreaterThanOrEqual(2);
    expect(res.body.by.entryService.some((x: { key: string }) => x.key === svc.id)).toBe(true);
    expect(res.body.note).toContain("không dùng tính lương");
    expect((await ctx.as(telesale).get("/api/crm360/reports/aov")).status).toBe(403);
  });
});

// ======================================================== V6

describe("V6: báo giá bị từ chối", () => {
  it("bắt buộc lý do; tự tạo việc chăm lại sau số ngày tham số cho sale phụ trách", async () => {
    await setSetting("quote.rejectFollowupDays", "10");
    const c = await customer("Từ chối", { assignedToId: telesale.id });
    const q = await prisma.quotation.create({ data: { code: `BG-${uid()}`, branchId: ctx.branchId, customerId: c.id, status: "SENT", total: 5_000_000, subtotal: 5_000_000 } });
    expect((await ctx.as(manager).post(`/api/sales/quotations/${q.id}/status`).send({ status: "REJECTED" })).status).toBe(400);
    const ok = await ctx.as(manager).post(`/api/sales/quotations/${q.id}/status`).send({ status: "REJECTED", reason: "Chê giá, muốn so sánh thêm" });
    expect(ok.status).toBe(200);
    expect(ok.body.followupTaskId).toBeTruthy();
    const task = await prisma.task.findUniqueOrThrow({ where: { id: ok.body.followupTaskId } });
    expect(task).toMatchObject({ kind: "QUOTE_FOLLOWUP", assigneeId: telesale.id });
    const days = (task.dueAt!.getTime() - Date.now()) / DAY;
    expect(days).toBeGreaterThan(9);
    expect(days).toBeLessThan(11.1);
    expect((await prisma.quotation.findUniqueOrThrow({ where: { id: q.id } })).rejectReason).toBe("Chê giá, muốn so sánh thêm");
  });
});

// ======================================================== V7

describe("V7: dự báo pipeline từ lịch sử bước thật", () => {
  it("xác suất = thắng / đã có kết quả; dưới ngưỡng mẫu là chưa đủ dữ liệu; dự báo không cộng bước thiếu dữ liệu", () => {
    const t = (d: number) => new Date(Date.UTC(2026, 8, d));
    const rows = [
      { key: "a", fromStage: null, toStage: "LICH_COC", createdAt: t(1) },
      { key: "a", fromStage: "LICH_COC", toStage: "LAM_DICH_VU", createdAt: t(2) },
      { key: "b", fromStage: null, toStage: "LICH_COC", createdAt: t(1) },
      { key: "b", fromStage: "LICH_COC", toStage: "MAT_KHACH", createdAt: t(3) },
      { key: "c", fromStage: null, toStage: "LICH_COC", createdAt: t(1) },
      { key: "c", fromStage: "LICH_COC", toStage: "DEN_CO_SO", createdAt: t(2) },
      { key: "d", fromStage: null, toStage: "NHAN_TIN", createdAt: t(1) },
    ];
    const p = stageProbabilities(rows, ClinicMode.INJECTION, 2);
    expect(p.get("LICH_COC")).toEqual({ stage: "LICH_COC", settled: 2, won: 1, probability: 0.5 });
    expect(p.get("NHAN_TIN")!.probability).toBeNull();
    expect(p.has("LAM_DICH_VU")).toBe(false);
    expect(stageProbabilities(rows, ClinicMode.INJECTION, 30).get("LICH_COC")!.probability).toBeNull();
    const f = forecastReport(
      [
        { id: "x", stage: "LICH_COC", value: 10_000_000, ownerId: "s1", month: "2026-10" },
        { id: "y", stage: "NHAN_TIN", value: 4_000_000, ownerId: "s1", month: null },
      ],
      p
    );
    expect(f.total).toMatchObject({ count: 2, pipelineValue: 14_000_000, weightedValue: 5_000_000, noDataCount: 1, noDataValue: 4_000_000 });
    expect(f.byMonth.map((b) => b.key)).toEqual(["2026-10", null]);
  });

  it("endpoint: mặc định 30 lượt mẫu nên bước ít dữ liệu hiện chưa đủ; telesale không xem được", async () => {
    const res = await ctx.as(director).get("/api/crm360/reports/forecast");
    expect(res.status).toBe(200);
    expect(res.body.minSamples).toBe(30);
    expect(res.body.probabilities.every((p: { settled: number; probability: number | null }) => p.settled >= 30 || p.probability === null)).toBe(true);
    expect(res.body.total.weightedValue).toBeLessThanOrEqual(res.body.total.pipelineValue);
    await setSetting("forecast.minSamples", "5");
    try {
      const r2 = await ctx.as(director).get("/api/crm360/reports/forecast");
      expect(r2.body.minSamples).toBe(5);
    } finally {
      await clearSetting("forecast.minSamples");
    }
    expect((await ctx.as(telesale).get("/api/crm360/reports/forecast")).status).toBe(403);
  });
});
