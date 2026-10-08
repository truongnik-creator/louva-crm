import crypto from "node:crypto";
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { setupTestContext, uniquePhone, prisma, type TestContext, type TestUser } from "./helpers";
import { invalidateSettingsCache } from "../src/lib/settings-catalog";
import { processBroadcastQueue } from "../src/lib/broadcast";
import { setAiClientForTests, AI_MODELS, type AiClient, type AiRequest, type AiSystemBlock } from "../src/lib/ai";

// Kênh gửi tin giả: test không gọi Zalo, Pancake thật.
const sent: Array<{ convId: string; text: string }> = [];
vi.mock("../src/services/outbound", () => ({
  channelOf: () => "ZALO",
  sendToChannel: async (conv: { id: string }, text: string) => {
    sent.push({ convId: conv.id, text });
    return { ok: true, externalId: null };
  },
}));

// Lô 4: F13 + F21 (ưu đãi, trần giảm, duyệt, rò rỉ chiết khấu), F11 (nhóm khách,
// hàng đợi gửi có giới hạn, từ chối nhận tin, cửa sổ 24 giờ Facebook), AI2, AI3.

const uid = () => crypto.randomBytes(4).toString("hex");
const DAY = 86_400_000;
let ctx: TestContext;
let consultant: TestUser;
let manager: TestUser;
let director: TestUser;
let admin: TestUser;

async function setSetting(key: string, value: string) {
  await prisma.systemSetting.upsert({ where: { key }, create: { key, value }, update: { value } });
  invalidateSettingsCache();
}

async function serviceWithPrice(price: number, minPrice: number | null = null) {
  const svc = await prisma.service.create({ data: { code: `SV${uid()}`.toUpperCase(), name: `Dịch vụ ${uid()}`, kind: "INJECTION" } });
  await prisma.servicePrice.create({ data: { serviceId: svc.id, branchId: ctx.branchId, price, minPrice } });
  return svc;
}

beforeAll(async () => {
  ctx = await setupTestContext("lo4sales");
  consultant = await ctx.createUser("TU_VAN_VIEN");
  manager = await ctx.createUser("QUAN_LY_CO_SO");
  director = await ctx.createUser("GIAM_DOC");
  admin = await ctx.createUser("QUAN_LY_HE_THONG");
  await ctx.createUser("TELESALE");
});

afterEach(() => setAiClientForTests(undefined));

describe("F13: đợt ưu đãi có số suất, tự khoá khi hết suất", () => {
  it("giảm trong đợt không cần duyệt; hết suất thì khoá, hợp đồng sau bị chặn; huỷ hợp đồng trả suất", async () => {
    const svc = await serviceWithPrice(4_000_000);
    const denied = await ctx.as(consultant).post("/api/promotions").send({});
    expect(denied.status).toBe(403);
    const promo = await ctx.as(manager).post("/api/promotions").send({
      code: `KM${uid()}`,
      name: "Ưu đãi thử 10%",
      kind: "PERCENT",
      value: 10,
      maxSlots: 1,
      startAt: new Date(Date.now() - DAY).toISOString(),
      endAt: new Date(Date.now() + 10 * DAY).toISOString(),
      serviceIds: [svc.id],
    });
    expect(promo.status).toBe(201);
    expect(promo.body.state).toBe("ACTIVE");

    const c = await ctx.createCustomer({ name: "Khách ưu đãi", phone: uniquePhone(), assignedToId: consultant.id });
    const line = { serviceId: svc.id, name: "DV", quantity: 1, unitPrice: 4_000_000, discount: 400_000, promotionId: promo.body.id };
    const q = await ctx.as(consultant).post("/api/sales/quotations").send({ customerId: c.id, items: [line] });
    expect(q.status).toBe(201);
    expect(q.body.approval.status).toBe("NOT_REQUIRED");
    expect(q.body.items[0]).toMatchObject({ listPrice: 4_000_000, discountAmount: 400_000, promotionDiscount: 400_000, promotionId: promo.body.id });

    const k1 = await ctx.as(consultant).post("/api/sales/contracts").send({ customerId: c.id, quotationId: q.body.id });
    expect(k1.status).toBe(201);
    let p = await prisma.promotion.findUniqueOrThrow({ where: { id: promo.body.id } });
    expect(p.usedSlots).toBe(1);
    expect(p.lockedAt).not.toBeNull();

    const k2 = await ctx.as(consultant).post("/api/sales/contracts").send({ customerId: c.id, items: [line] });
    expect(k2.status).toBe(400);
    expect(k2.body.error).toContain("hết suất");

    const cancel = await ctx.as(manager).post(`/api/sales/contracts/${k1.body.id}/cancel`).send({ reason: "Khách đổi ý huỷ" });
    expect(cancel.status).toBe(200);
    p = await prisma.promotion.findUniqueOrThrow({ where: { id: promo.body.id } });
    expect(p.usedSlots).toBe(0);
    expect(p.lockedAt).toBeNull();
  });

  it("đợt ưu đãi không áp dụng dịch vụ khác, đợt đã hết hạn bị từ chối", async () => {
    const svc = await serviceWithPrice(2_000_000);
    const other = await serviceWithPrice(2_000_000);
    const ended = await prisma.promotion.create({
      data: {
        code: `HET${uid()}`.toUpperCase(), name: "Đợt cũ", kind: "AMOUNT", value: 200_000,
        startAt: new Date(Date.now() - 10 * DAY), endAt: new Date(Date.now() - DAY),
        services: { create: [{ serviceId: svc.id }] },
      },
    });
    const c = await ctx.createCustomer({ name: "Khách đợt cũ", phone: uniquePhone(), assignedToId: consultant.id });
    const res = await ctx.as(consultant).post("/api/sales/quotations").send({
      customerId: c.id,
      items: [{ serviceId: svc.id, name: "DV", quantity: 1, unitPrice: 2_000_000, discount: 200_000, promotionId: ended.id }],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("đã kết thúc");
    const live = await prisma.promotion.create({
      data: {
        code: `SONG${uid()}`.toUpperCase(), name: "Đợt riêng", kind: "AMOUNT", value: 200_000,
        startAt: new Date(Date.now() - DAY), endAt: new Date(Date.now() + DAY),
        services: { create: [{ serviceId: svc.id }] },
      },
    });
    const wrong = await ctx.as(consultant).post("/api/sales/quotations").send({
      customerId: c.id,
      items: [{ serviceId: other.id, name: "DV khác", quantity: 1, unitPrice: 2_000_000, discount: 200_000, promotionId: live.id }],
    });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error).toContain("không áp dụng");
  });
});

describe("F21: trần giảm theo vai, vượt trần chờ duyệt", () => {
  it("tư vấn viên (trần 0%) giảm phải ghi lý do và chờ quản lý duyệt; chưa duyệt không gửi, không chốt được", async () => {
    const svc = await serviceWithPrice(5_000_000);
    const c = await ctx.createCustomer({ name: "Khách xin giảm", phone: uniquePhone(), assignedToId: consultant.id });
    const items = (discount: number, reason?: string) => [
      { serviceId: svc.id, name: "DV", quantity: 1, unitPrice: 5_000_000, discount, ...(reason ? { discountReason: reason } : {}) },
    ];
    const noReason = await ctx.as(consultant).post("/api/sales/quotations").send({ customerId: c.id, items: items(250_000) });
    expect(noReason.status).toBe(400);
    expect(noReason.body.error).toContain("lý do");

    const q = await ctx.as(consultant).post("/api/sales/quotations").send({ customerId: c.id, items: items(250_000, "Khách giới thiệu bạn") });
    expect(q.status).toBe(201);
    expect(q.body.approval).toMatchObject({ status: "PENDING", maxExcessPercent: 5, capPercent: 0 });
    expect((await prisma.notification.findMany({ where: { userId: manager.id, title: { contains: q.body.code } } })).length).toBe(1);

    expect((await ctx.as(consultant).post(`/api/sales/quotations/${q.body.id}/status`).send({ status: "SENT" })).status).toBe(409);
    expect((await ctx.as(consultant).post("/api/sales/contracts").send({ customerId: c.id, quotationId: q.body.id })).status).toBe(409);
    // Lập thẳng hợp đồng để lách duyệt cũng bị chặn.
    const direct = await ctx.as(consultant).post("/api/sales/contracts").send({ customerId: c.id, items: items(250_000, "Lách") });
    expect(direct.status).toBe(409);

    expect((await ctx.as(consultant).post(`/api/sales/quotations/${q.body.id}/approval`).send({ decision: "APPROVE" })).status).toBe(403);
    const list = await ctx.as(manager).get("/api/sales/discount-approvals");
    expect(list.body.some((r: { id: string }) => r.id === q.body.id)).toBe(true);
    const ok = await ctx.as(manager).post(`/api/sales/quotations/${q.body.id}/approval`).send({ decision: "APPROVE", note: "Đồng ý" });
    expect(ok.status).toBe(200);
    expect(ok.body.approvalStatus).toBe("APPROVED");
    expect(ok.body.items[0].approvedById).toBe(manager.id);

    const k = await ctx.as(consultant).post("/api/sales/contracts").send({ customerId: c.id, quotationId: q.body.id });
    expect(k.status).toBe(201);
    expect(k.body.items[0]).toMatchObject({ listPrice: 5_000_000, discountAmount: 250_000, approvedById: manager.id, discountReason: "Khách giới thiệu bạn" });
  });

  it("vượt trần của quản lý (10%) thì quản lý không duyệt được, giám đốc duyệt; giá sàn tuyệt đối không ai vượt", async () => {
    const svc = await serviceWithPrice(10_000_000, 7_000_000);
    const c = await ctx.createCustomer({ name: "Khách giảm sâu", phone: uniquePhone(), assignedToId: consultant.id });
    const q = await ctx.as(consultant).post("/api/sales/quotations").send({
      customerId: c.id,
      items: [{ serviceId: svc.id, name: "DV", quantity: 1, unitPrice: 10_000_000, discount: 2_000_000, discountReason: "Khách VIP" }],
    });
    expect(q.body.approval.status).toBe("PENDING");
    const mgr = await ctx.as(manager).post(`/api/sales/quotations/${q.body.id}/approval`).send({ decision: "APPROVE" });
    expect(mgr.status).toBe(403);
    expect(mgr.body.error).toContain("vượt trần");
    const dir = await ctx.as(director).post(`/api/sales/quotations/${q.body.id}/approval`).send({ decision: "APPROVE" });
    expect(dir.status).toBe(200);

    const floor = await ctx.as(consultant).post("/api/sales/quotations").send({
      customerId: c.id,
      items: [{ serviceId: svc.id, name: "DV", quantity: 1, unitPrice: 10_000_000, discount: 3_500_000, discountReason: "Thử" }],
    });
    expect(floor.status).toBe(400);
    expect(floor.body.error).toContain("giá sàn");
  });

  it("giá niêm yết dùng bảng giá chung khi bật một bảng giá cho mọi cơ sở", async () => {
    const svc = await serviceWithPrice(3_000_000);
    const code = `BG_${uid()}`.toUpperCase();
    const branch = await prisma.branch.create({ data: { code, name: `Cơ sở ${code}` } });
    await prisma.userBranch.create({ data: { userId: manager.id, branchId: branch.id } });
    const c = await ctx.createCustomer({ name: "Khách bảng giá chung", phone: uniquePhone() });
    const body = { customerId: c.id, branchId: branch.id, items: [{ serviceId: svc.id, name: "DV", quantity: 1, unitPrice: 3_000_000, discount: 0 }] };
    const before = await ctx.as(manager).post("/api/sales/quotations").send(body);
    expect(before.body.items[0].listPrice).toBeNull(); // cơ sở mới chưa có giá
    // Cơ sở gốc là cơ sở tạo đầu tiên (ctx.branchId).
    await setSetting("pricing.singlePriceList", "true");
    const after = await ctx.as(manager).post("/api/sales/quotations").send(body);
    expect(after.body.items[0].listPrice).toBe(3_000_000);
    await setSetting("pricing.singlePriceList", "false");
  });
});

describe("F21: báo cáo rò rỉ chiết khấu", () => {
  it("gom theo sale, dịch vụ, tháng; chỉ tính giảm ngoài ưu đãi, không tính hợp đồng huỷ", async () => {
    const code = `LK_${uid()}`.toUpperCase();
    const branch = await prisma.branch.create({ data: { code, name: `Cơ sở ${code}` } });
    await prisma.userBranch.create({ data: { userId: director.id, branchId: branch.id } });
    const s1 = await ctx.createUser("TU_VAN_VIEN", { key: `s1-${uid()}` });
    const s2 = await ctx.createUser("TU_VAN_VIEN", { key: `s2-${uid()}` });
    const svcA = await prisma.service.create({ data: { code: `LA${uid()}`.toUpperCase(), name: "Filler rò rỉ" } });
    const svcB = await prisma.service.create({ data: { code: `LB${uid()}`.toUpperCase(), name: "Botox rò rỉ" } });
    const c = await ctx.createCustomer({ name: "Khách rò rỉ", phone: uniquePhone() });
    const mk = async (consultantId: string, status: string, items: Array<Record<string, unknown>>) =>
      prisma.contract.create({
        data: {
          code: `DH-LK-${uid()}`, branchId: branch.id, customerId: c.id, consultantId, status, signedAt: new Date(),
          items: { create: items as never },
        },
      });
    // s1: 1 dòng giảm 1tr ngoài ưu đãi (có duyệt) + 1 dòng ưu đãi 500k.
    await mk(s1.id, "SIGNED", [
      { serviceId: svcA.id, name: "A", quantity: 1, unitPrice: 10_000_000, discount: 1_000_000, amount: 9_000_000, listPrice: 10_000_000, discountAmount: 1_000_000, promotionDiscount: 0, approvedById: director.id },
      { serviceId: svcB.id, name: "B", quantity: 1, unitPrice: 5_000_000, discount: 500_000, amount: 4_500_000, listPrice: 5_000_000, discountAmount: 500_000, promotionDiscount: 500_000 },
    ]);
    // s2: bán dưới niêm yết bằng cách hạ đơn giá (không qua ô giảm) 300k, không duyệt.
    await mk(s2.id, "SIGNED", [
      { serviceId: svcB.id, name: "B", quantity: 2, unitPrice: 4_850_000, discount: 0, amount: 9_700_000, listPrice: 5_000_000, discountAmount: 300_000, promotionDiscount: 0 },
    ]);
    // Hợp đồng huỷ không tính.
    await mk(s2.id, "CANCELLED", [
      { serviceId: svcA.id, name: "A", quantity: 1, unitPrice: 5_000_000, discount: 5_000_000, amount: 5_000_000, listPrice: 10_000_000, discountAmount: 5_000_000, promotionDiscount: 0 },
    ]);

    const denied = await ctx.as(consultant).get("/api/reports/discount-leakage").query({ branchId: branch.id });
    expect(denied.status).toBe(403);
    const bySales = await ctx.as(director).get("/api/reports/discount-leakage").query({ branchId: branch.id, groupBy: "sales" });
    expect(bySales.status).toBe(200);
    expect(bySales.body.total).toMatchObject({ lines: 3, listTotal: 25_000_000, discountTotal: 1_800_000, promotionDiscount: 500_000, leakage: 1_300_000, approvedLeakage: 1_000_000, leakagePercent: 5.2 });
    const row1 = bySales.body.rows.find((r: { key: string }) => r.key === s1.id);
    const row2 = bySales.body.rows.find((r: { key: string }) => r.key === s2.id);
    expect(row1).toMatchObject({ leakage: 1_000_000, approvedLeakage: 1_000_000, promotionDiscount: 500_000, listTotal: 15_000_000 });
    expect(row2).toMatchObject({ leakage: 300_000, approvedLeakage: 0, listTotal: 10_000_000, leakagePercent: 3 });

    const bySvc = await ctx.as(director).get("/api/reports/discount-leakage").query({ branchId: branch.id, groupBy: "service" });
    expect(bySvc.body.rows.find((r: { key: string }) => r.key === svcB.id)).toMatchObject({ leakage: 300_000, promotionDiscount: 500_000 });
    const byMonth = await ctx.as(director).get("/api/reports/discount-leakage").query({ branchId: branch.id, groupBy: "month" });
    expect(byMonth.body.rows).toHaveLength(1);
    expect(byMonth.body.rows[0].leakage).toBe(1_300_000);
  });
});

describe("F11: nhóm khách và gửi theo kịch bản", () => {
  it("lọc nhóm, loại khách từ chối nhận tin, giới hạn mỗi giờ, ngoài 24 giờ Facebook thì tạo việc cho sale", async () => {
    const code = `SG_${uid()}`.toUpperCase();
    const branch = await prisma.branch.create({ data: { code, name: `Cơ sở ${code}` } });
    const saleOwner = await ctx.createUser("TELESALE", { key: `owner-${uid()}` });
    const now = new Date("2031-05-10T03:00:00Z");
    const mkCustomer = async (name: string, opts: { optOut?: boolean; channel?: string; lastInHoursAgo?: number; silentDays?: number } = {}) => {
      const c = await prisma.customer.create({
        data: {
          code: `KH-SG-${uid()}`, name, phone: uniquePhone(), optOut: opts.optOut ?? false, assignedToId: saleOwner.id,
          lastContactAt: new Date(Date.now() - (opts.silentDays ?? 60) * DAY),
          branchLinks: { create: { branchId: branch.id, isPrimary: true } },
        },
      });
      if (opts.channel) {
        await prisma.conversation.create({
          data: {
            title: name, kind: "CUSTOMER", channel: opts.channel, branchId: branch.id, customerId: c.id,
            lastMessageAt: new Date(now.getTime() - (opts.lastInHoursAgo ?? 1) * 3_600_000),
            lastInboundAt: new Date(now.getTime() - (opts.lastInHoursAgo ?? 1) * 3_600_000),
          },
        });
      }
      return c;
    };
    const refused = await mkCustomer("Khách từ chối", { optOut: true, channel: "ZALO_OA" });
    const fbOld = await mkCustomer("Khách FB cũ", { channel: "FACEBOOK", lastInHoursAgo: 30 });
    const fbNew = await mkCustomer("Khách FB mới", { channel: "facebook", lastInHoursAgo: 2 });
    const zalo = await mkCustomer("Khách Zalo", { channel: "ZALO_OA", lastInHoursAgo: 200 });
    await mkCustomer("Khách mới nhắn", { channel: "ZALO_OA", silentDays: 1 }); // không im lặng: ngoài nhóm

    const filter = { branchId: branch.id, silentDays: 30 };
    expect((await ctx.as("TELESALE").post("/api/outreach/segments/preview").send({ filter })).status).toBe(403);
    const preview = await ctx.as(admin).post("/api/outreach/segments/preview").send({ filter });
    expect(preview.body).toMatchObject({ total: 4, optOut: 1, willSend: 3 });

    const bad = await ctx.as(admin).post("/api/outreach/broadcasts").send({ name: "Sai biến", template: "Chào {{ten_sai}}", filter });
    expect(bad.status).toBe(400);

    const b = await ctx.as(admin).post("/api/outreach/broadcasts").send({
      name: "Chăm lại khách im lặng",
      template: "Chào {{ten_khach}}, lâu rồi chưa gặp mình ạ",
      filter,
    });
    expect(b.status).toBe(201);
    expect(b.body).toMatchObject({ total: 4, queued: 3, optOut: 1 });
    const refusedRow = await prisma.broadcastRecipient.findFirstOrThrow({ where: { broadcastId: b.body.id, customerId: refused.id } });
    expect(refusedRow.status).toBe("SKIPPED_OPT_OUT");

    // Giờ giả 2031 cho hàng đợi: cửa sổ 24 giờ Facebook tính theo mốc tin khách ở trên.
    await setSetting("broadcast.maxPerHour", "1");
    sent.length = 0;
    const r1 = await processBroadcastQueue(now);
    // Khách FB cũ: ngoài 24 giờ, không gửi, tạo việc (không tính vào giới hạn); gửi được đúng 1 tin.
    expect(sent).toHaveLength(1);
    expect(r1.message).toContain("Đã gửi 1");
    const task = await prisma.task.findFirstOrThrow({ where: { customerId: fbOld.id, kind: "MANUAL_MESSAGE" } });
    expect(task.assigneeId).toBe(saleOwner.id);
    expect(task.description).toContain("Chào Khách FB cũ");
    expect((await prisma.broadcastRecipient.findFirstOrThrow({ where: { broadcastId: b.body.id, customerId: fbOld.id } })).status).toBe("TASK_CREATED");

    await processBroadcastQueue(new Date(now.getTime() + 10 * 60_000));
    expect(sent).toHaveLength(1); // vẫn trong giờ: hết hạn mức
    await processBroadcastQueue(new Date(now.getTime() + 61 * 60_000));
    expect(sent).toHaveLength(2);
    const final = await prisma.broadcastRecipient.findMany({ where: { broadcastId: b.body.id, customerId: { in: [fbNew.id, zalo.id] } } });
    expect(final.every((r) => r.status === "SENT" && r.content?.startsWith("Chào Khách"))).toBe(true);
    expect((await prisma.broadcast.findUniqueOrThrow({ where: { id: b.body.id } })).status).toBe("DONE");
    await setSetting("broadcast.maxPerHour", "60");

    const log = await ctx.as(admin).get(`/api/outreach/broadcasts/${b.body.id}/recipients`);
    expect(log.body.total).toBe(4);
  });

  it("khách bấm từ chối nhận tin: tin đang chờ bị bỏ", async () => {
    const c = await ctx.createCustomer({ name: "Khách đổi ý", phone: uniquePhone() });
    const bc = await prisma.broadcast.create({ data: { name: "Đợt chờ", filter: "{}", template: "Chào", status: "QUEUED" } });
    await prisma.broadcastRecipient.create({ data: { broadcastId: bc.id, customerId: c.id } });
    const res = await ctx.as("QUAN_LY_CO_SO").post(`/api/outreach/customers/${c.id}/opt-out`).send({ optOut: true, reason: "Không muốn nhận tin" });
    expect(res.status).toBe(200);
    expect((await prisma.broadcastRecipient.findFirstOrThrow({ where: { broadcastId: bc.id } })).status).toBe("SKIPPED_OPT_OUT");
    await prisma.broadcast.update({ where: { id: bc.id }, data: { status: "CANCELLED" } });
  });
});

// ------------------------------------------------------------------ AI2, AI3

class MockAi implements AiClient {
  calls: AiRequest[] = [];
  constructor(private answer: (req: AiRequest) => string) {}
  async complete(req: AiRequest) {
    this.calls.push(req);
    return { text: this.answer(req), model: req.model };
  }
}

function isCheck(req: AiRequest): boolean {
  return typeof req.system === "string" && req.system.includes("bộ KIỂM TRA");
}

async function aiConversation(text: string, consent = true) {
  const c = await ctx.createCustomer({ name: `Khách AI ${uid()}`, phone: uniquePhone() });
  if (consent) await prisma.customer.update({ where: { id: c.id }, data: { aiDataConsent: true } });
  const conv = await prisma.conversation.create({
    data: { title: "Khách AI", kind: "CUSTOMER", channel: "ZALO_OA", branchId: ctx.branchId, customerId: c.id },
  });
  await prisma.chatMessage.create({ data: { conversationId: conv.id, direction: "IN", content: text } });
  return { conv, customerId: c.id };
}

describe("AI2: gợi ý câu trả lời theo kịch bản, hàng rào hai lớp", () => {
  it("lớp 1: tin khách có từ khoá y khoa thì KHÔNG gọi AI, đề nghị chuyển bác sĩ", async () => {
    const mock = new MockAi(() => "không được gọi");
    setAiClientForTests(mock);
    const { conv } = await aiConversation("Em tiêm filler hôm qua giờ bị sưng đau có sao không ạ");
    const res = await ctx.as("TELESALE").post(`/api/conversations/${conv.id}/suggest`);
    // Telesale chỉ thấy hội thoại của mình (OWN): dùng quản lý cơ sở.
    expect([404, 200]).toContain(res.status);
    const ok = await ctx.as(manager).post(`/api/conversations/${conv.id}/suggest`);
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe("BLOCKED_MEDICAL");
    expect(ok.body.suggestion).toContain("chuyển bác sĩ");
    expect(mock.calls).toHaveLength(0);
    expect(await prisma.aiSuggestion.count({ where: { conversationId: conv.id, status: "BLOCKED_MEDICAL" } })).toBe(1);
  });

  it("khách chưa đồng ý xử lý dữ liệu: không gọi AI", async () => {
    const mock = new MockAi(() => "x");
    setAiClientForTests(mock);
    const { conv } = await aiConversation("Giá filler môi bao nhiêu ạ", false);
    const res = await ctx.as(manager).post(`/api/conversations/${conv.id}/suggest`);
    expect(res.body.status).toBe("NO_CONSENT");
    expect(mock.calls).toHaveLength(0);
  });

  it("lớp 2: AI tự kiểm từ chối thì không trả câu gợi ý", async () => {
    const mock = new MockAi((req) =>
      isCheck(req) ? '{"ok": false, "violations": ["Nói giảm giá ngoài đợt ưu đãi"]}' : "Dạ filler môi bên em giá tốt lắm chị ơi"
    );
    setAiClientForTests(mock);
    const { conv } = await aiConversation("Giá filler môi bao nhiêu ạ");
    const res = await ctx.as(manager).post(`/api/conversations/${conv.id}/suggest`);
    expect(res.body.status).toBe("REJECTED_CHECK");
    expect(res.body.suggestion).toBeNull();
    expect(res.body.violations).toEqual(["Nói giảm giá ngoài đợt ưu đãi"]);
    expect(mock.calls.map((c) => c.model)).toEqual([AI_MODELS.SMART, AI_MODELS.CHEAP]);
  });

  it("lớp 2 luật cứng: câu hứa hẹn kết quả bị chặn ngay, không cần AI tự kiểm", async () => {
    const mock = new MockAi(() => "Dạ bên em cam kết đẹp tự nhiên 100% chị ạ");
    setAiClientForTests(mock);
    const { conv } = await aiConversation("Tiêm xong có đẹp không em");
    const res = await ctx.as(manager).post(`/api/conversations/${conv.id}/suggest`);
    expect(res.body.status).toBe("REJECTED_CHECK");
    expect(mock.calls).toHaveLength(1);
  });

  it("qua hai lớp: trả câu gợi ý, kịch bản gắn cache; sale sửa rồi gửi thì ghi đối chiếu và nhật ký", async () => {
    await ctx.as(manager).post("/api/sales-scripts").send({
      title: "Kịch bản win của Thầy",
      content: "Bước 1: chào hỏi, hỏi nhu cầu. Bước 2: xin ảnh mặt. Bước 3: mời đặt lịch có cọc.",
    });
    const mock = new MockAi((req) => (isCheck(req) ? '{"ok": true, "violations": []}' : "Dạ chị gửi em ảnh mặt để bác sĩ xem giúp mình nha"));
    setAiClientForTests(mock);
    const { conv } = await aiConversation("Em muốn tiêm filler môi");
    const res = await ctx.as(manager).post(`/api/conversations/${conv.id}/suggest`);
    expect(res.body.status).toBe("OK");
    expect(res.body.suggestion).toContain("ảnh mặt");
    const system = mock.calls[0].system as AiSystemBlock[];
    expect(system.find((b) => b.cache)?.text).toContain("Kịch bản win của Thầy");

    const edited = "Dạ chị gửi em 1 ảnh mặt mộc để bác sĩ xem giúp mình nha";
    const send = await ctx.as(manager).post(`/api/conversations/${conv.id}/messages`).send({ content: edited, suggestionId: res.body.id });
    expect(send.status).toBe(201);
    const row = await prisma.aiSuggestion.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(row).toMatchObject({ sentText: edited, edited: true, sentMessageId: send.body.id });
    const audit = await prisma.auditLog.findFirst({ where: { entity: "AiSuggestion", entityId: row.id, action: "UPDATE" } });
    expect(audit?.changes).toContain("mặt mộc");
    expect(await prisma.dataAccessLog.count({ where: { customerId: row.customerId, resourceType: "AI_PROCESSING" } })).toBe(2);
  });
});

describe("AI3: tóm tắt hội thoại và bước tiếp theo", () => {
  it("dùng model rẻ, không gửi câu có nội dung sức khoẻ, lưu vào lịch sử khách", async () => {
    const mock = new MockAi(() => '{"summary": "Khách hỏi giá filler môi, đã gửi ảnh.", "nextAction": "Mời đặt lịch có cọc"}');
    setAiClientForTests(mock);
    const { conv, customerId } = await aiConversation("Em muốn tiêm filler môi. Em đang cho con bú có được không.");
    const res = await ctx.as(manager).post(`/api/conversations/${conv.id}/summary`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "OK", nextAction: "Mời đặt lịch có cọc" });
    expect(mock.calls[0].model).toBe(AI_MODELS.CHEAP);
    const sentText = mock.calls[0].messages[0].content;
    expect(sentText).toContain("filler môi");
    expect(sentText).not.toContain("cho con bú");
    const act = await prisma.activity.findFirstOrThrow({ where: { customerId, type: "AI_SUMMARY" } });
    expect(act.content).toContain("Mời đặt lịch có cọc");
    const latest = await ctx.as(manager).get(`/api/conversations/${conv.id}/summary`);
    expect(latest.body.summary).toContain("filler");
  });
});
