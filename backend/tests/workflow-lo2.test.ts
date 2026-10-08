import crypto from "node:crypto";
import { describe, it, expect, beforeAll } from "vitest";
import { setupTestContext, uniquePhone, prisma, type TestContext } from "./helpers";
import { putEncrypted } from "../src/lib/storage";

// Lô 2: B12 (chặn tin còn {{...}}, điền biến), B13 (lưu ảnh chat vào hồ sơ),
// B14 (giá sàn ở hợp đồng nhập tay), B15 (trang chủ theo vai), che SĐT lồng
// trong lịch hẹn và hợp đồng.

const uid = () => crypto.randomBytes(4).toString("hex");
const masked = (p: string) => `${p.slice(0, 2)}xx xxx ${p.slice(-3)}`;

let ctx: TestContext;

beforeAll(async () => {
  ctx = await setupTestContext("lo2flow");
  await ctx.createUser("QUAN_LY_CO_SO");
  await ctx.createUser("TELESALE");
  await ctx.createUser("DIEU_DUONG");
  await ctx.createUser("BAC_SI");
  await ctx.createUser("MARKETING");
});

async function conversationFor(customerId: string | null, title = "Hội thoại test") {
  return prisma.conversation.create({
    data: { title, kind: "CUSTOMER", channel: "ZALO_OA", branchId: ctx.branchId, customerId },
  });
}

describe("B12: mẫu tin nhanh có biến {{...}}", () => {
  it("backend chặn gửi tin còn {{", async () => {
    const c = await ctx.createCustomer({ name: "Chị Lan", phone: uniquePhone() });
    const conv = await conversationFor(c.id);
    const res = await ctx
      .as("QUAN_LY_CO_SO")
      .post(`/api/conversations/${conv.id}/messages`)
      .send({ content: "Chào {{ten_khach}}, lịch của chị lúc {{gio_hen}}" });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("{{");
    expect(await prisma.chatMessage.count({ where: { conversationId: conv.id } })).toBe(0);
  });

  it("điền biến từ hồ sơ khách, bảng giá; biến thiếu dữ liệu giữ nguyên để báo", async () => {
    const c = await ctx.createCustomer({ name: "Chị Mai", phone: uniquePhone() });
    const conv = await conversationFor(c.id);
    const svc = await prisma.service.create({ data: { code: `FIL${uid()}`.toUpperCase(), name: "Filler" } });
    await prisma.servicePrice.create({ data: { serviceId: svc.id, branchId: ctx.branchId, price: 4_500_000 } });

    const res = await ctx
      .as("QUAN_LY_CO_SO")
      .post(`/api/conversations/${conv.id}/render-template`)
      .send({ content: `Chào {{ten_khach}}, giá filler {{gia:${svc.code}}}. Hẹn {{lich_hen}}` });
    expect(res.status).toBe(200);
    expect(res.body.content).toBe("Chào Chị Mai, giá filler 4.500.000đ. Hẹn {{lich_hen}}");
    expect(res.body.unresolved).toEqual(["lich_hen"]);
  });

  it("chỉ vai có quyền quản lý mẫu được thêm; biến sai tên bị từ chối", async () => {
    const denied = await ctx.as("TELESALE").post("/api/conversations/quick-replies").send({ title: "Chào", content: "Chào {{ten_khach}}" });
    expect(denied.status).toBe(403);

    const bad = await ctx
      .as("QUAN_LY_CO_SO")
      .post("/api/conversations/quick-replies")
      .send({ title: "Sai biến", content: "Chào {{ten_khachh}}" });
    expect(bad.status).toBe(400);

    const ok = await ctx
      .as("QUAN_LY_CO_SO")
      .post("/api/conversations/quick-replies")
      .send({ title: `Chào ${uid()}`, content: "Chào {{ten_khach}}", category: "Mở đầu" });
    expect(ok.status).toBe(201);
    const off = await ctx.as("QUAN_LY_CO_SO").patch(`/api/conversations/quick-replies/${ok.body.id}`).send({ active: false });
    expect(off.status).toBe(200);
    expect(off.body.active).toBe(false);
  });
});

describe("B13: lưu ảnh chat vào hồ sơ", () => {
  it("ảnh trong hội thoại được mã hoá vào bộ ảnh của khách, không lưu trùng", async () => {
    const c = await ctx.createCustomer({ name: "Khách gửi ảnh", phone: uniquePhone() });
    const conv = await conversationFor(c.id);
    const png = Buffer.concat([Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"), crypto.randomBytes(32)]);
    const stored = putEncrypted("chat-test", "anh.png", png);
    const msg = await prisma.chatMessage.create({
      data: {
        conversationId: conv.id,
        direction: "IN",
        type: "IMAGE",
        content: "[Ảnh]",
        attachments: {
          create: {
            kind: "IMAGE",
            fileName: "anh.png",
            mimeType: "image/png",
            storageKey: stored.storageKey,
            encIv: stored.iv,
            encTag: stored.tag,
          },
        },
      },
      include: { attachments: true },
    });
    const att = msg.attachments[0];

    const view = await ctx.as("BAC_SI").get(`/api/conversations/${conv.id}/attachments/${att.id}/content`);
    expect(view.status).toBe(200);
    expect(view.headers["content-type"]).toContain("image/png");

    const save = await ctx.as("BAC_SI").post(`/api/conversations/${conv.id}/attachments/${att.id}/save-to-profile`).send({});
    expect(save.status).toBe(201);
    const set = await prisma.photoSet.findUniqueOrThrow({ where: { id: save.body.photoSetId }, include: { photos: true } });
    expect(set.customerId).toBe(c.id);
    expect(set.photos).toHaveLength(1);

    const again = await ctx.as("BAC_SI").post(`/api/conversations/${conv.id}/attachments/${att.id}/save-to-profile`).send({});
    expect(again.status).toBe(409);
  });
});

describe("B14: giá sàn ở hợp đồng nhập tay", () => {
  it("chặn dòng nhập tay thấp hơn giá sàn, cho qua khi đủ giá", async () => {
    const c = await ctx.createCustomer({ name: "Khách hợp đồng", phone: uniquePhone() });
    const svc = await prisma.service.create({ data: { code: `BTX${uid()}`.toUpperCase(), name: "Botox" } });
    await prisma.servicePrice.create({
      data: { serviceId: svc.id, branchId: ctx.branchId, price: 5_000_000, minPrice: 4_500_000 },
    });
    // Lô 4 (F21): giảm ngoài ưu đãi phải ghi lý do và nằm trong trần của vai (quản lý cơ sở 10%).
    const line = (unitPrice: number, discount = 0) => ({
      customerId: c.id,
      branchId: ctx.branchId,
      items: [{ serviceId: svc.id, name: "Botox", quantity: 1, unitPrice, discount, discountReason: "Khách quen" }],
    });

    const low = await ctx.as("QUAN_LY_CO_SO").post("/api/sales/contracts").send(line(5_000_000, 1_000_000));
    expect(low.status).toBe(400);
    expect(low.body.error).toContain("giá sàn");

    const ok = await ctx.as("QUAN_LY_CO_SO").post("/api/sales/contracts").send(line(5_000_000, 500_000));
    expect(ok.status).toBe(201);
  });
});

describe("Che SĐT khách lồng trong lịch hẹn, hợp đồng", () => {
  let phone: string;
  let customerId: string;

  beforeAll(async () => {
    phone = uniquePhone();
    const c = await ctx.createCustomer({ name: "Khách che số lịch hẹn", phone });
    customerId = c.id;
    const start = new Date(Date.now() + 3600_000);
    await prisma.appointment.create({
      data: {
        branchId: ctx.branchId,
        customerId,
        title: "Tư vấn filler",
        startAt: start,
        endAt: new Date(start.getTime() + 1800_000),
      },
    });
    await prisma.contract.create({
      data: { code: `DH-MASK-${uid()}`, branchId: ctx.branchId, customerId, total: 1_000_000, subtotal: 1_000_000 },
    });
  });

  it("lịch hẹn: điều dưỡng (không có customer.view_phone) thấy số bị che", async () => {
    const from = new Date(Date.now() - 3600_000).toISOString();
    const to = new Date(Date.now() + 5 * 3600_000).toISOString();
    const res = await ctx.as("DIEU_DUONG").get("/api/reception/appointments").query({ from, to, customerId });
    expect(res.status).toBe(200);
    expect(res.body.items[0].customer.phone).toBe(masked(phone));
    expect(JSON.stringify(res.body)).not.toContain(phone);

    const full = await ctx.as("QUAN_LY_CO_SO").get("/api/reception/appointments").query({ from, to, customerId });
    expect(full.body.items[0].customer.phone).toBe(phone);
  });

  it("hợp đồng: vai có finance.read nhưng thiếu customer.view_phone thấy số bị che", async () => {
    const reader = await ctx.createRoleUser([{ code: "finance.read", scope: "BRANCH" }]);
    const res = await ctx.as(reader).get("/api/sales/contracts").query({ customerId });
    expect(res.status).toBe(200);
    expect(res.body[0].customer.phone).toBe(masked(phone));
    expect(JSON.stringify(res.body)).not.toContain(phone);

    const full = await ctx.as("QUAN_LY_CO_SO").get("/api/sales/contracts").query({ customerId });
    expect(full.body[0].customer.phone).toBe(phone);
  });
});

describe("B15: trang chủ theo vai", () => {
  it("điều dưỡng có khối lịch hẹn và lịch thủ thuật, không có khối lead", async () => {
    const res = await ctx.as("DIEU_DUONG").get("/api/home");
    expect(res.status).toBe(200);
    expect(res.body.sections.appointments).toBeDefined();
    expect(res.body.sections.procedures).toBeDefined();
    expect(res.body.sections.leads).toBeUndefined();
  });

  it("marketing có khối lead hôm nay", async () => {
    const res = await ctx.as("MARKETING").get("/api/home");
    expect(res.status).toBe(200);
    expect(res.body.sections.leads.total).toBeGreaterThanOrEqual(0);
    expect(res.body.sections.appointments).toBeUndefined();
  });
});
