import crypto from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestContext, uniquePhone, prisma, type TestContext, type TestUser } from "./helpers";
import { invalidateSettingsCache } from "../src/lib/settings-catalog";
import { applyStageEvent } from "../src/lib/stages";
import { StageEvent } from "../src/types/enums";

// Lô 8 · sửa 4 lỗi phát hiện khi chụp demo CRM 360:
//  1. Cơ hội mở tay theo dịch vụ: thẻ hiện "Chưa rõ dịch vụ" và giá trị dự kiến lấy
//     từ dịch vụ quan tâm cũ (INTEREST) thay vì dịch vụ của cơ hội.
//  2. Ô "Việc cần làm với khách này" báo trống khi thanh 360 còn việc; check-in sang
//     Đến cơ sở không sinh việc theo bước khi cơ hội chưa gắn cơ sở.
//  3. Trọn gói (V1) tự cộng dịch vụ bán kèm khách vừa TỪ CHỐI (V2).
//  4. Ghi chú hồ sơ nhu cầu (C3) lưu qua API nhưng giao diện không có chỗ hiện.

const uid = () => crypto.randomBytes(4).toString("hex");
const DAY = 86_400_000;
const TAG = `SL${uid()}`;

let ctx: TestContext;
let manager: TestUser;
let telesale: TestUser;
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
  const s = await prisma.service.create({ data: { code: `SL-${uid()}`, name: `${name} ${uid()}`, kind: "INJECTION" } });
  await prisma.servicePrice.create({ data: { serviceId: s.id, branchId: ctx.branchId, price, validFrom: new Date(Date.now() - DAY) } });
  return s;
}

type Card = { id: string; opportunityId: string | null; serviceName: string | null; expectedValue: number | null; valueSource: string | null };
async function cardsOf(customerId: string): Promise<Card[]> {
  const pipe = await ctx.as(manager).get("/api/customers/pipeline").query({ q: TAG });
  expect(pipe.status).toBe(200);
  return pipe.body.columns.flatMap((c: { items: Card[] }) => c.items).filter((i: Card) => i.id === customerId);
}

beforeAll(async () => {
  ctx = await setupTestContext("lo8fix");
  manager = await ctx.createUser("QUAN_LY_CO_SO");
  telesale = await ctx.createUser("TELESALE");
  reception = await ctx.createUser("LE_TAN");
  await setSetting("clinic.mode", "INJECTION");
});

afterAll(async () => {
  await prisma.stageChecklistItem.updateMany({ where: { title: { startsWith: TAG } }, data: { active: false } });
  await prisma.upsellRule.updateMany({ where: { pitch: { startsWith: TAG } }, data: { active: false } });
  await clearSetting("upsell.declineCooldownDays");
});

// ======================================================== LỖI 1

describe("Lỗi 1: giá trị và tên dịch vụ của cơ hội mở tay", () => {
  it("cơ hội HIFU mở tay: thẻ ghi tên HIFU, giá trị = giá niêm yết HIFU, không lấy dịch vụ quan tâm cũ", async () => {
    const oldA = await service("Nâng ngực", 50_000_000);
    const oldB = await service("Trẻ hoá da", 48_000_000);
    const hifu = await service("HIFU 500S", 7_500_000);
    const c = await ctx.createCustomer({ name: `${TAG} Quay lại HIFU`, phone: uniquePhone(), assignedToId: telesale.id });
    await prisma.customer.update({ where: { id: c.id }, data: { interest: JSON.stringify([oldA.name, oldB.name]) } });
    await applyStageEvent(c.id, StageEvent.PROCEDURE_DONE, { at: new Date(Date.now() - 60 * DAY) });
    // Báo giá cũ chưa gắn cơ hội, lập TRƯỚC khi mở cơ hội HIFU: thuộc cơ hội cũ.
    await prisma.quotation.create({
      data: { code: `BG-SL-${uid()}`, branchId: ctx.branchId, customerId: c.id, status: "SENT", subtotal: 30_000_000, total: 30_000_000, createdAt: new Date(Date.now() - 30 * DAY) },
    });

    const o = await ctx.as(telesale).post(`/api/crm360/customers/${c.id}/opportunities`).send({ serviceId: hifu.id });
    expect(o.status).toBe(201);

    const card = (await cardsOf(c.id)).find((x) => x.opportunityId === o.body.id)!;
    expect(card).toMatchObject({ serviceName: hifu.name, expectedValue: 7_500_000, valueSource: "SERVICE" });

    // Thanh 360 (cơ hội hiện tại) và danh sách cơ hội cùng một con số.
    const bar = await ctx.as(manager).get(`/api/customers/${c.id}/360`);
    expect(bar.body.money).toMatchObject({ expectedValue: 7_500_000, valueSource: "SERVICE" });
    const list = await ctx.as(manager).get(`/api/crm360/customers/${c.id}/opportunities`);
    expect(list.body.items.find((i: { id: string }) => i.id === o.body.id)).toMatchObject({ expectedValue: 7_500_000, valueSource: "SERVICE" });
    // Cơ hội cũ vẫn giữ báo giá cũ chưa gắn cơ hội.
    expect(list.body.items.find((i: { id: string }) => i.id !== o.body.id)).toMatchObject({ expectedValue: 30_000_000, valueSource: "QUOTE" });

    // Báo giá gắn cơ hội HIFU đứng trước giá niêm yết.
    await prisma.quotation.create({
      data: { code: `BG-SL-${uid()}`, branchId: ctx.branchId, customerId: c.id, opportunityId: o.body.id, status: "SENT", subtotal: 6_000_000, total: 6_000_000 },
    });
    const after = (await cardsOf(c.id)).find((x) => x.opportunityId === o.body.id)!;
    expect(after).toMatchObject({ serviceName: hifu.name, expectedValue: 6_000_000, valueSource: "QUOTE" });
  });

  it("cơ hội không có dịch vụ (dữ liệu cũ) vẫn tính theo dịch vụ quan tâm", async () => {
    const a = await service("Filler cằm", 9_000_000);
    const c = await ctx.createCustomer({ name: `${TAG} Quan tâm`, phone: uniquePhone() });
    await prisma.customer.update({ where: { id: c.id }, data: { interest: JSON.stringify([a.name]) } });
    await prisma.opportunity.create({ data: { customerId: c.id, branchId: ctx.branchId, title: "Cơ hội đầu tiên", stage: "TIEP_CAN", source: "MIGRATION" } });
    const [card] = await cardsOf(c.id);
    expect(card).toMatchObject({ serviceName: null, expectedValue: 9_000_000, valueSource: "INTEREST" });
  });
});

// ======================================================== LỖI 2

describe("Lỗi 2: việc của khách nhất quán giữa thanh 360 và ô Việc cần làm; J3 khi check-in", () => {
  it("thanh 360 trả danh sách việc mở của khách (mọi người được giao), việc kế tiếp nằm trong danh sách", async () => {
    const c = await ctx.createCustomer({ name: `${TAG} Việc`, phone: uniquePhone(), assignedToId: telesale.id });
    await prisma.task.create({ data: { customerId: c.id, title: "Gọi lại", status: "OPEN", assigneeId: telesale.id, dueAt: new Date(Date.now() + DAY) } });
    await prisma.task.create({ data: { customerId: c.id, title: "Không hạn", status: "OPEN", assigneeId: null } });
    await prisma.task.create({ data: { customerId: c.id, title: "Đã xong", status: "DONE", assigneeId: telesale.id } });
    // Người xem (quản lý) KHÔNG phải người được giao việc.
    const bar = await ctx.as(manager).get(`/api/customers/${c.id}/360`);
    expect(bar.status).toBe(200);
    expect(bar.body.nextTask).toMatchObject({ title: "Gọi lại" });
    expect(bar.body.openTasks.map((t: { title: string }) => t.title)).toEqual(["Gọi lại", "Không hạn"]);
    expect(bar.body.openTasks[0]).toMatchObject({ id: bar.body.nextTask.id, assignee: { id: telesale.id } });
  });

  it("check-in tự sang Đến cơ sở: sinh việc theo bước cả khi cơ hội chưa gắn cơ sở (việc khai riêng cho cơ sở check-in)", async () => {
    const item = await ctx.as(manager).post("/api/crm360/stage-checklist").send({
      stage: "DEN_CO_SO",
      branchId: ctx.branchId,
      title: `${TAG} Lập báo giá 3 phương án`,
      dueDays: 0,
    });
    expect(item.status).toBe(201);
    // Lead từ chat: chưa gắn cơ sở, chưa có sale phụ trách.
    const c = await prisma.customer.create({ data: { code: `KH-SL-${uid()}`, name: `${TAG} Check-in`, phone: uniquePhone(), stage: "LICH_COC" } });
    const v = await ctx.as(reception).post("/api/reception/visits").send({ customerId: c.id, branchId: ctx.branchId });
    expect(v.status).toBe(201);
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: c.id } })).stage).toBe("DEN_CO_SO");
    const tasks = await prisma.task.findMany({ where: { customerId: c.id, kind: "STAGE_CHECKLIST", checklistItemId: item.body.id } });
    expect(tasks).toHaveLength(1);
    // Không có sale phụ trách: giao cho người làm đổi bước (lễ tân check-in), gắn cơ sở check-in.
    expect(tasks[0]).toMatchObject({ stageKey: "DEN_CO_SO", assigneeId: reception.id, branchId: ctx.branchId });
    const bar = await ctx.as(manager).get(`/api/customers/${c.id}/360`);
    expect(bar.body.openTasks.some((t: { id: string }) => t.id === tasks[0].id)).toBe(true);
  });

  it("khách có sale: việc theo bước khi check-in giao cho sale phụ trách cơ hội", async () => {
    const c = await ctx.createCustomer({ name: `${TAG} Có sale`, phone: uniquePhone(), assignedToId: telesale.id });
    await prisma.customer.update({ where: { id: c.id }, data: { stage: "LICH_COC" } });
    expect((await ctx.as(reception).post("/api/reception/visits").send({ customerId: c.id, branchId: ctx.branchId })).status).toBe(201);
    const t = await prisma.task.findFirstOrThrow({ where: { customerId: c.id, kind: "STAGE_CHECKLIST", title: `${TAG} Lập báo giá 3 phương án` } });
    expect(t.assigneeId).toBe(telesale.id);
  });
});

// ======================================================== LỖI 3

describe("Lỗi 3: Trọn gói không tự cộng dịch vụ bán kèm khách vừa từ chối", () => {
  let cid: string;
  let main: { id: string; name: string };
  let up: { id: string; name: string };
  let ruleId: string;

  beforeAll(async () => {
    main = await service("Filler môi", 5_000_000);
    up = await service("Meso cấp ẩm", 1_000_000);
    ruleId = (await prisma.upsellRule.create({ data: { triggerServiceId: main.id, suggestServiceId: up.id, pitch: `${TAG} cấp ẩm sau tiêm`, branchId: ctx.branchId } })).id;
    const c = await ctx.createCustomer({ name: `${TAG} Từ chối bán kèm`, phone: uniquePhone(), assignedToId: manager.id });
    cid = c.id;
    await prisma.treatmentPlan.create({
      data: { branchId: ctx.branchId, customerId: cid, title: "Phác đồ môi", items: { create: [{ serviceId: main.id, name: main.name, quantity: 1, listPrice: 5_000_000, stepOrder: 1 }] } },
    });
  });

  const packageOf = async () => {
    const r = await ctx.as(manager).post("/api/crm360/quote-options/preview").send({ customerId: cid });
    expect(r.status).toBe(200);
    return { body: r.body, pack: r.body.options.find((o: { tier: string }) => o.tier === "PACKAGE") };
  };

  it("chưa từ chối: Trọn gói cộng bán kèm; từ chối thì không cộng, trả ghi chú; hết số ngày tham số thì cộng lại", async () => {
    let r = await packageOf();
    expect(r.pack.lines.map((l: { serviceId: string }) => l.serviceId)).toContain(up.id);

    const d = await ctx.as(manager).post("/api/crm360/upsell-offers").send({ customerId: cid, suggestServiceId: up.id, ruleId, context: "COUNTER", status: "DECLINED", declineReason: "Chưa đủ ngân sách" });
    expect(d.status).toBe(201);
    r = await packageOf();
    expect(r.pack.lines.map((l: { serviceId: string }) => l.serviceId)).not.toContain(up.id);
    expect(r.pack.total).toBe(5_000_000);
    expect(r.body.skippedDeclined).toEqual([expect.objectContaining({ serviceId: up.id, declineReason: "Chưa đủ ngân sách" })]);

    // Từ chối đã cũ hơn số ngày tham số: gợi ý lại như bình thường.
    await prisma.upsellOffer.updateMany({ where: { customerId: cid, suggestServiceId: up.id }, data: { decidedAt: new Date(Date.now() - 40 * DAY), suggestedAt: new Date(Date.now() - 40 * DAY) } });
    r = await packageOf();
    expect(r.pack.lines.map((l: { serviceId: string }) => l.serviceId)).toContain(up.id);
    expect(r.body.skippedDeclined).toEqual([]);

    // Tham số 0 = luôn cộng như trước.
    await prisma.upsellOffer.updateMany({ where: { customerId: cid, suggestServiceId: up.id }, data: { decidedAt: new Date() } });
    await setSetting("upsell.declineCooldownDays", "0");
    r = await packageOf();
    expect(r.pack.lines.map((l: { serviceId: string }) => l.serviceId)).toContain(up.id);
    await clearSetting("upsell.declineCooldownDays");
  });
});

// ======================================================== LỖI 4

describe("Lỗi 4: ghi chú hồ sơ nhu cầu", () => {
  it("lưu, đọc lại ghi chú; xoá ghi chú (chuỗi rỗng) lưu là null", async () => {
    const c = await ctx.createCustomer({ name: `${TAG} Nhu cầu`, phone: uniquePhone(), assignedToId: telesale.id });
    const put = await ctx.as(telesale).put(`/api/crm360/customers/${c.id}/needs`).send({ areas: ["MOI"], note: "  Khách muốn dáng môi tự nhiên, sợ người nhà biết  " });
    expect(put.status).toBe(200);
    let got = (await ctx.as(telesale).get(`/api/crm360/customers/${c.id}/needs`)).body.needs;
    expect(got.note).toBe("Khách muốn dáng môi tự nhiên, sợ người nhà biết");
    await ctx.as(telesale).put(`/api/crm360/customers/${c.id}/needs`).send({ ...got, note: "" });
    got = (await ctx.as(telesale).get(`/api/crm360/customers/${c.id}/needs`)).body.needs;
    expect(got.note).toBeNull();
  });
});
