import crypto from "node:crypto";
import { describe, it, expect, beforeAll } from "vitest";
import { setupTestContext, uniquePhone, prisma, type TestContext, type TestUser } from "./helpers";
import { putEncrypted } from "../src/lib/storage";
import { anonymLabelOf } from "../src/routes/cases";

// Lô 6 · F30: phiếu tư vấn -> phác đồ -> báo giá; thư viện case ẩn danh, chỉ ảnh đồng ý marketing.

const uid = () => crypto.randomBytes(4).toString("hex");
const png = () => Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), crypto.randomBytes(64)]);

let ctx: TestContext;
let doctor: TestUser;
let manager: TestUser;
let director: TestUser;
let sale: TestUser;
let serviceId: string;
let otherServiceId: string;

async function makeService(name: string, price: number): Promise<string> {
  const s = await prisma.service.create({ data: { code: `L6-${uid()}`, name, kind: "INJECTION" } });
  await prisma.servicePrice.create({ data: { serviceId: s.id, branchId: ctx.branchId, price, validFrom: new Date(Date.now() - 86_400_000) } });
  return s.id;
}

beforeAll(async () => {
  ctx = await setupTestContext("lo6cc");
  doctor = await ctx.createUser("BAC_SI");
  manager = await ctx.createUser("QUAN_LY_CO_SO");
  director = await ctx.createUser("GIAM_DOC");
  sale = await ctx.createUser("TELESALE");
  serviceId = await makeService("Filler môi L6", 3_500_000);
  otherServiceId = await makeService("Botox gọn hàm L6", 9_000_000);
});

describe("F30: phiếu tư vấn, phác đồ, báo giá", () => {
  it("bác sĩ lập phiếu có vùng mặt, dịch vụ, liều 0,1; lập phác đồ rồi báo giá theo giá niêm yết, gắn vào phác đồ", async () => {
    const c = await ctx.createCustomer({ name: "Khách tư vấn L6", phone: uniquePhone() });
    const product = await prisma.product.create({ data: { code: `SP-${uid()}`, name: "Youthfill L6", unit: "cc" } });
    const created = await ctx
      .as(doctor)
      .post("/api/consultations")
      .send({
        customerId: c.id,
        faceAreas: ["MOI", "CAM"],
        proposals: [{ serviceId, productId: product.id, doseTenths: 15, faceArea: "MOI" }],
        expectation: "Môi đầy tự nhiên",
      });
    expect(created.status).toBe(201);
    expect(created.body.faceAreas).toEqual(["MOI", "CAM"]);
    expect(created.body.proposals[0]).toMatchObject({ serviceId, doseTenths: 15, quantity: 2, listPrice: 3_500_000, productName: "Youthfill L6" });
    expect(created.body.doctorId).toBe(doctor.id);

    // Ảnh "trước" vào bộ ảnh CONSULT của khách.
    const up = await ctx.as(doctor).post(`/api/consultations/${created.body.id}/photos`).attach("photos", png(), "truoc.png");
    expect(up.status).toBe(201);
    const set = await prisma.photoSet.findUniqueOrThrow({ where: { id: up.body.photoSetId }, include: { photos: true } });
    expect(set.stage).toBe("CONSULT");
    expect(set.customerId).toBe(c.id);
    expect(set.photos).toHaveLength(1);

    const plan = await ctx.as(doctor).post(`/api/consultations/${created.body.id}/plans`).send({});
    expect(plan.status).toBe(201);
    expect(plan.body.items[0]).toMatchObject({ serviceId, doseTenths: 15, quantity: 2, productName: "Youthfill L6" });

    const q = await ctx.as(doctor).post(`/api/consultations/plans/${plan.body.id}/quote`);
    expect(q.status).toBe(201);
    expect(q.body.quotation.total).toBe(7_000_000);
    const quote = await prisma.quotation.findUniqueOrThrow({ where: { id: q.body.quotation.id }, include: { items: true, treatmentPlan: true } });
    expect(quote.customerId).toBe(c.id);
    expect(quote.treatmentPlan?.id).toBe(plan.body.id);
    expect(quote.items[0]).toMatchObject({ serviceId, quantity: 2, unitPrice: 3_500_000, listPrice: 3_500_000, discountAmount: 0 });
    expect(quote.items[0].name).toContain("1,5");
    expect(quote.approvalStatus).toBe("NOT_REQUIRED");

    // Lập lần hai bị chặn; chi tiết phiếu thấy báo giá của phác đồ.
    expect((await ctx.as(doctor).post(`/api/consultations/plans/${plan.body.id}/quote`)).status).toBe(409);
    const detail = await ctx.as(doctor).get(`/api/consultations/${created.body.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.plans[0].quotation.code).toBe(quote.code);
    expect(detail.body.photoSet.photos).toHaveLength(1);
  });

  it("quản lý cơ sở được lập phiếu; telesale chỉ xem; liều sai định dạng và dịch vụ lạ bị chặn", async () => {
    const c = await ctx.createCustomer({ name: "Khách quản lý L6", phone: uniquePhone() });
    expect((await ctx.as(manager).post("/api/consultations").send({ customerId: c.id, proposals: [{ serviceId }] })).status).toBe(201);
    expect((await ctx.as(sale).post("/api/consultations").send({ customerId: c.id })).status).toBe(403);
    expect((await ctx.as(doctor).post("/api/consultations").send({ customerId: c.id, proposals: [{ serviceId, doseTenths: 1.5 }] })).status).toBe(400);
    expect((await ctx.as(doctor).post("/api/consultations").send({ customerId: c.id, proposals: [{ serviceId: crypto.randomUUID() }] })).status).toBe(400);
  });

  it("gắn báo giá sẵn có phải cùng khách", async () => {
    const a = await ctx.createCustomer({ name: "Khách A L6", phone: uniquePhone() });
    const b = await ctx.createCustomer({ name: "Khách B L6", phone: uniquePhone() });
    const s = await ctx.as(doctor).post("/api/consultations").send({ customerId: a.id, proposals: [{ serviceId }] });
    const plan = await ctx.as(doctor).post(`/api/consultations/${s.body.id}/plans`).send({});
    const otherQuote = await prisma.quotation.create({ data: { code: `BG-L6-${uid()}`, branchId: ctx.branchId, customerId: b.id } });
    expect((await ctx.as(doctor).post(`/api/consultations/plans/${plan.body.id}/link-quote`).send({ quotationId: otherQuote.id })).status).toBe(400);
    const ownQuote = await prisma.quotation.create({ data: { code: `BG-L6-${uid()}`, branchId: ctx.branchId, customerId: a.id } });
    expect((await ctx.as(doctor).post(`/api/consultations/plans/${plan.body.id}/link-quote`).send({ quotationId: ownQuote.id })).status).toBe(200);
  });
});

describe("F30: thư viện case", () => {
  it("nhãn ẩn danh theo giới và nhóm tuổi", () => {
    const now = new Date("2026-10-01T00:00:00Z");
    expect(anonymLabelOf({ gender: "FEMALE", dob: new Date("1994-05-01T00:00:00Z") }, now)).toBe("Nữ, 30 đến 34 tuổi");
    expect(anonymLabelOf({ gender: null, dob: null }, now)).toBe("Khách");
  });

  it("chỉ ảnh đồng ý marketing, không lộ tên, SĐT, mã khách; sale chỉ thấy case đã xuất bản; lọc theo dịch vụ", async () => {
    const phone = uniquePhone();
    const name = `Nguyễn Bí Mật ${uid()}`;
    const c = await ctx.createCustomer({ name, phone });
    await prisma.customer.update({ where: { id: c.id }, data: { gender: "FEMALE", dob: new Date("1995-03-10T00:00:00Z") } });
    const mkSet = async (consent: boolean, stage: string) => {
      const set = await prisma.photoSet.create({ data: { branchId: ctx.branchId, customerId: c.id, stage, consentForMarketing: consent } });
      const stored = putEncrypted(`photos/${c.id}`, `${name}.png`, png());
      const photo = await prisma.photoAsset.create({
        data: { photoSetId: set.id, storageKey: stored.storageKey, fileName: `${name}-${phone}.png`, mimeType: "image/png", size: stored.size, encIv: stored.iv, encTag: stored.tag },
      });
      return photo.id;
    };
    const okPhoto = await mkSet(true, "D0");
    const secretPhoto = await mkSet(false, "D30");

    // Nội dung case có tên khách thì bị chặn.
    expect((await ctx.as(doctor).post("/api/cases").send({ customerId: c.id, serviceId, title: `Case của ${name}` })).status).toBe(400);
    const created = await ctx.as(doctor).post("/api/cases").send({ customerId: c.id, serviceId, title: "Filler môi 1,5cc tự nhiên", summary: "Khách muốn môi đầy" });
    expect(created.status).toBe(201);
    expect(created.body.anonymLabel).toMatch(/^Nữ, \d+ đến \d+ tuổi$/);

    // Chưa duyệt: sale không thấy.
    let list = await ctx.as(sale).get("/api/cases");
    expect(list.body.items.find((i: { id: string }) => i.id === created.body.id)).toBeUndefined();

    expect((await ctx.as(doctor).post(`/api/cases/${created.body.id}/approve`).send({ gate: "MEDICAL" })).body.status).toBe("PENDING_MARKETING");
    expect((await ctx.as(director).post(`/api/cases/${created.body.id}/approve`).send({ gate: "MARKETING" })).body.status).toBe("PUBLISHED");

    list = await ctx.as(sale).get("/api/cases");
    expect(list.status).toBe(200);
    const item = list.body.items.find((i: { id: string }) => i.id === created.body.id);
    expect(item).toBeTruthy();
    expect(item.photos.map((p: { id: string }) => p.id)).toEqual([okPhoto]);
    const raw = JSON.stringify(list.body);
    expect(raw).not.toContain(name);
    expect(raw).not.toContain(phone);
    expect(raw).not.toContain(c.code);
    expect(raw).not.toContain(c.id);
    expect(raw).not.toContain(secretPhoto);

    // Lọc theo dịch vụ.
    const filtered = await ctx.as(sale).get(`/api/cases?serviceId=${otherServiceId}`);
    expect(filtered.body.items.find((i: { id: string }) => i.id === created.body.id)).toBeUndefined();
    const same = await ctx.as(sale).get(`/api/cases?serviceId=${serviceId}`);
    expect(same.body.items.find((i: { id: string }) => i.id === created.body.id)).toBeTruthy();

    // Ảnh không đồng ý không tải được qua thư viện; ảnh đồng ý tải được.
    expect((await ctx.as(sale).get(`/api/cases/${created.body.id}/photos/${secretPhoto}`)).status).toBe(404);
    const ok = await ctx.as(sale).get(`/api/cases/${created.body.id}/photos/${okPhoto}`);
    expect(ok.status).toBe(200);
    expect(ok.headers["content-type"]).toContain("image/png");

    // Tắt đồng ý là ảnh biến khỏi thư viện ngay.
    await prisma.photoSet.updateMany({ where: { customerId: c.id }, data: { consentForMarketing: false } });
    list = await ctx.as(sale).get("/api/cases");
    expect(list.body.items.find((i: { id: string }) => i.id === created.body.id)).toBeUndefined();
    expect((await ctx.as(sale).get(`/api/cases/${created.body.id}/photos/${okPhoto}`)).status).toBe(404);
  });

  it("khách chưa có ảnh đồng ý thì không tạo được case; sale không tạo được case", async () => {
    const c = await ctx.createCustomer({ name: "Khách chưa đồng ý L6", phone: uniquePhone() });
    await prisma.photoSet.create({ data: { branchId: ctx.branchId, customerId: c.id, stage: "D0", consentForMarketing: false } });
    expect((await ctx.as(doctor).post("/api/cases").send({ customerId: c.id, title: "Case thử" })).status).toBe(400);
    expect((await ctx.as(sale).post("/api/cases").send({ customerId: c.id, title: "Case thử" })).status).toBe(403);
  });
});
