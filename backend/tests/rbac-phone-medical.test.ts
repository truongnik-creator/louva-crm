import { describe, it, expect, beforeAll } from "vitest";
import { setupTestContext, uniquePhone, prisma, type TestContext } from "./helpers";

// S4: che SĐT với vai không có customer.view_phone; S5: dữ liệu y khoa hạn chế;
// S1: tài khoản còn mật khẩu tạm bị chặn khỏi mọi API nghiệp vụ.

describe("Che số điện thoại (S4)", () => {
  let ctx: TestContext;
  let phone: string;
  let customerId: string;

  beforeAll(async () => {
    ctx = await setupTestContext("rbacphone");
    await ctx.createUser("MARKETING");
    await ctx.createUser("QUAN_LY_CO_SO");
    phone = uniquePhone();
    const c = await ctx.createCustomer({ name: "Khách che số", phone });
    customerId = c.id;
    await prisma.lead.create({ data: { name: "Lead che số", phone, branchId: ctx.branchId } });
  });

  const masked = (p: string) => `${p.slice(0, 2)}xx xxx ${p.slice(-3)}`;

  it("GET /api/leads che SĐT với marketing, không lộ phoneNormalized", async () => {
    const res = await ctx.as("MARKETING").get("/api/leads").query({ q: "Lead che số" });
    expect(res.status).toBe(200);
    const lead = res.body.find((l: { name: string }) => l.name === "Lead che số");
    expect(lead.phone).toBe(masked(phone));
    expect(JSON.stringify(res.body)).not.toContain(phone);
  });

  it("GET /api/leads trả số thật cho vai có customer.view_phone", async () => {
    const res = await ctx.as("QUAN_LY_CO_SO").get("/api/leads").query({ q: "Lead che số" });
    const lead = res.body.find((l: { name: string }) => l.name === "Lead che số");
    expect(lead.phone).toBe(phone);
    expect(lead).not.toHaveProperty("phoneNormalized");
  });

  it("marketing sửa lead không ghi đè được số thật bằng chuỗi đã che", async () => {
    const lead = await prisma.lead.findFirstOrThrow({ where: { name: "Lead che số" } });
    const res = await ctx
      .as("MARKETING")
      .patch(`/api/leads/${lead.id}`)
      .send({ phone: masked(phone), note: "sửa ghi chú" });
    expect(res.status).toBe(200);
    const after = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(after.phone).toBe(phone);
    expect(after.note).toBe("sửa ghi chú");
  });

  it("danh sách và chi tiết khách che SĐT với marketing", async () => {
    const list = await ctx.as("MARKETING").get("/api/customers").query({ q: "Khách che số" });
    expect(list.status).toBe(200);
    expect(list.body.items[0].phone).toBe(masked(phone));
    const detail = await ctx.as("MARKETING").get(`/api/customers/${customerId}`);
    expect(detail.body.phone).toBe(masked(phone));
    expect(JSON.stringify(detail.body)).not.toContain(phone);
  });

  it("xuất dữ liệu khách che SĐT khi vai có report.export nhưng thiếu view_phone", async () => {
    const exporter = await ctx.createRoleUser([
      { code: "report.export", scope: "ALL" },
      { code: "customer.read", scope: "ALL" },
    ]);
    const res = await ctx.as(exporter).post("/api/reports/export").send({ dataset: "customers" });
    expect(res.status).toBe(200);
    const row = res.body.rows.find((r: { name: string }) => r.name === "Khách che số");
    expect(row.phone).toBe(masked(phone));
    expect(JSON.stringify(res.body)).not.toContain(phone);

    const full = await ctx.as("QUAN_LY_CO_SO").post("/api/reports/export").send({ dataset: "customers" });
    const fullRow = full.body.rows.find((r: { name: string }) => r.name === "Khách che số");
    expect(fullRow.phone).toBe(phone);
  });
});

describe("Dữ liệu y khoa hạn chế (S5)", () => {
  let ctx: TestContext;
  let customerId: string;

  beforeAll(async () => {
    ctx = await setupTestContext("rbacmed");
    await ctx.createUser("BAC_SI");
    await ctx.createUser("TU_VAN_VIEN");
    await ctx.createUser("TELESALE");
    const c = await ctx.createCustomer({ name: "Khách có bệnh án", phone: uniquePhone() });
    customerId = c.id;
    const record = await prisma.medicalRecord.create({
      data: {
        code: `BA-${ctx.prefix}-1`,
        customerId,
        branchId: ctx.branchId,
        chronicDisease: "Tiểu đường type 2",
        currentMedication: "Metformin",
        pregnancyNote: "Đang cho con bú",
        bloodType: "O",
      },
    });
    await prisma.allergy.create({ data: { recordId: record.id, substance: "Lidocain" } });
  });

  it("bác sĩ xem đủ bệnh án", async () => {
    const res = await ctx.as("BAC_SI").get(`/api/medical/records/${customerId}`);
    expect(res.status).toBe(200);
    expect(res.body.restricted).toBe(false);
    expect(res.body.chronicDisease).toBe("Tiểu đường type 2");
    expect(res.body.currentMedication).toBe("Metformin");
    expect(res.body.pregnancyNote).toBe("Đang cho con bú");
  });

  it("tư vấn viên chỉ thấy dị ứng, chống chỉ định; không có bệnh nền, thuốc, thai kỳ", async () => {
    const res = await ctx.as("TU_VAN_VIEN").get(`/api/medical/records/${customerId}`);
    expect(res.status).toBe(200);
    expect(res.body.restricted).toBe(true);
    expect(res.body).not.toHaveProperty("chronicDisease");
    expect(res.body).not.toHaveProperty("currentMedication");
    expect(res.body).not.toHaveProperty("pregnancyNote");
    expect(res.body.entries).toEqual([]);
    expect(res.body.allergies.map((a: { substance: string }) => a.substance)).toContain("Lidocain");
    const text = JSON.stringify(res.body);
    expect(text).not.toContain("Tiểu đường");
    expect(text).not.toContain("Metformin");
  });

  it("telesale không đọc được bệnh án", async () => {
    const res = await ctx.as("TELESALE").get(`/api/medical/records/${customerId}`);
    expect(res.status).toBe(403);
  });
});

describe("Buộc đổi mật khẩu lần đầu (S1)", () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await setupTestContext("mustchange");
  });

  it("chặn API nghiệp vụ, vẫn cho /api/auth/me", async () => {
    const u = await ctx.createUser("LE_TAN", { key: "fresh", mustChangePassword: true });
    const blocked = await ctx.as(u).get("/api/customers");
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe("MUST_CHANGE_PASSWORD");
    const me = await ctx.as(u).get("/api/auth/me");
    expect(me.status).toBe(200);
    expect(me.body.mustChangePassword).toBe(true);
  });
});
