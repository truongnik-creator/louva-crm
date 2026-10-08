import { describe, it, expect, beforeAll } from "vitest";
import { normalizeVnPhone, isValidVnPhone } from "../src/lib/phone";
import { normalizeName, isSimilarName } from "../src/lib/text";
import { backfillNormalizedColumns } from "../src/lib/bootstrap";
import { setupTestContext, uniquePhone, prisma, type TestContext } from "./helpers";

describe("normalizeVnPhone (B17)", () => {
  it.each([
    ["0912345678", "0912345678"],
    ["0912 345 678", "0912345678"],
    ["0912.345.678", "0912345678"],
    ["091-234-5678", "0912345678"],
    ["(091) 234 5678", "0912345678"],
    ["+84912345678", "0912345678"],
    ["+84 912 345 678", "0912345678"],
    ["84912345678", "0912345678"],
    ["0084912345678", "0912345678"],
    ["+84 0912 345 678", "0912345678"],
    ["912345678", "0912345678"],
    ["02438123456", "02438123456"],
  ])("%s -> %s", (raw, expected) => {
    expect(normalizeVnPhone(raw)).toBe(expected);
  });

  it("trả null cho giá trị rỗng hoặc quá ngắn", () => {
    expect(normalizeVnPhone(null)).toBeNull();
    expect(normalizeVnPhone("")).toBeNull();
    expect(normalizeVnPhone("  ")).toBeNull();
    expect(normalizeVnPhone("123")).toBeNull();
  });

  it("giữ số quốc tế khác dạng +mã", () => {
    expect(normalizeVnPhone("+1 (415) 555-0100")).toBe("+14155550100");
  });

  it("isValidVnPhone", () => {
    expect(isValidVnPhone("+84 912 345 678")).toBe(true);
    expect(isValidVnPhone("0112345678")).toBe(false);
  });
});

describe("normalizeName / isSimilarName", () => {
  it("bỏ dấu, chữ thường, gộp khoảng trắng", () => {
    expect(normalizeName("  Nguyễn   Thị  Lan Anh ")).toBe("nguyen thi lan anh");
    expect(normalizeName("Đặng Quốc Hưng")).toBe("dang quoc hung");
  });
  it("coi gõ sai một chữ là gần giống", () => {
    expect(isSimilarName("nguyen thi lan anh", "nguyen thi lam anh")).toBe(true);
    expect(isSimilarName("tran bao ngoc", "tran bao ngoc")).toBe(true);
    expect(isSimilarName("tran bao ngoc", "le minh chau")).toBe(false);
  });
});

describe("Chống trùng SĐT qua API (B17)", () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await setupTestContext("phone");
    await ctx.createUser("QUAN_LY_CO_SO");
    await ctx.createUser("MARKETING");
    await ctx.createUser("TU_VAN_VIEN");
  });

  it("lưu phoneNormalized khi tạo khách và chặn tạo trùng dù khác định dạng", async () => {
    const local = uniquePhone();
    const intl = `+84 ${local.slice(1, 4)} ${local.slice(4, 7)} ${local.slice(7)}`;

    const first = await ctx.as("QUAN_LY_CO_SO").post("/api/customers").send({ name: "Khách Một", phone: local });
    expect(first.status).toBe(201);
    const row = await prisma.customer.findUniqueOrThrow({ where: { id: first.body.id } });
    expect(row.phoneNormalized).toBe(local);
    expect(row.nameNormalized).toBe("khach mot");
    // Cột chuẩn hoá không bao giờ trả về máy khách.
    expect(first.body).not.toHaveProperty("phoneNormalized");

    const dup = await ctx.as("QUAN_LY_CO_SO").post("/api/customers").send({ name: "Khách Hai", phone: intl });
    expect(dup.status).toBe(409);
    expect(dup.body.duplicate).toMatchObject({ type: "customer", id: first.body.id });
  });

  it("chặn đổi SĐT sang số đã thuộc khách khác", async () => {
    const a = await ctx.createCustomer({ name: "Khách A đổi số", phone: uniquePhone() });
    const bPhone = uniquePhone();
    await ctx.createCustomer({ name: "Khách B đổi số", phone: bPhone });
    const res = await ctx
      .as("QUAN_LY_CO_SO")
      .patch(`/api/customers/${a.id}`)
      .send({ phone: `+84${bPhone.slice(1)}` });
    expect(res.status).toBe(409);
  });

  it("lead: chặn lead mở trùng SĐT, báo khách sẵn có", async () => {
    const phone = uniquePhone();
    const cust = await ctx.createCustomer({ name: "Khách cũ quay lại", phone });

    const l1 = await ctx.as("MARKETING").post("/api/leads").send({ name: "Lead Một", phone: `84${phone.slice(1)}` });
    expect(l1.status).toBe(201);
    expect(l1.body.matchedCustomer).toMatchObject({ id: cust.id });

    const l2 = await ctx.as("MARKETING").post("/api/leads").send({ name: "Lead Hai", phone: phone.replace(/(\d{4})(\d{3})(\d{3})/, "$1.$2.$3") });
    expect(l2.status).toBe(409);
    expect(l2.body.duplicate).toMatchObject({ type: "lead", id: l1.body.id });
  });

  it("chuyển lead thành khách gộp vào khách trùng SĐT chuẩn hoá", async () => {
    const phone = uniquePhone();
    const cust = await ctx.createCustomer({ name: "Khách sẵn có", phone });
    const lead = await prisma.lead.create({
      data: { name: "Lead cùng số", phone: `+84 ${phone.slice(1)}`, branchId: ctx.branchId },
    });
    expect(lead.phoneNormalized).toBe(phone);

    const res = await ctx.as("QUAN_LY_CO_SO").post(`/api/leads/${lead.id}/convert`).send({});
    expect(res.status).toBe(201);
    expect(res.body.merged).toBe(true);
    expect(res.body.customer.id).toBe(cust.id);
  });

  it("cảnh báo tên gần giống và trùng SĐT", async () => {
    const phone = uniquePhone();
    const existing = await ctx.createCustomer({ name: "Phạm Thuỳ Dươngx", phone });
    const res = await ctx
      .as("TU_VAN_VIEN")
      .get("/api/customers/duplicates/check")
      .query({ name: "Pham Thuy Duongz", phone: `+84${phone.slice(1)}` });
    expect(res.status).toBe(200);
    expect(res.body.phoneMatches.map((c: { id: string }) => c.id)).toContain(existing.id);

    const other = await ctx.createCustomer({ name: "Hoàng Thị Mai Hươngq" });
    const res2 = await ctx
      .as("TU_VAN_VIEN")
      .get("/api/customers/duplicates/check")
      .query({ name: "Hoang Thi Mai Huongp" });
    expect(res2.body.similarNames.map((c: { id: string }) => c.id)).toContain(other.id);
  });

  it("backfill điền cột chuẩn hoá cho dữ liệu cũ mà không đổi updatedAt", async () => {
    const c = await ctx.createCustomer({ name: "Khách dữ liệu cũ", phone: "0987 000 111" });
    await prisma.$executeRawUnsafe(`UPDATE customers SET phoneNormalized = NULL, nameNormalized = NULL WHERE id = ?`, c.id);
    const before = await prisma.customer.findUniqueOrThrow({ where: { id: c.id } });
    await backfillNormalizedColumns();
    const after = await prisma.customer.findUniqueOrThrow({ where: { id: c.id } });
    expect(after.phoneNormalized).toBe("0987000111");
    expect(after.nameNormalized).toBe("khach du lieu cu");
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
  });
});

describe("Gộp hồ sơ trùng (B17)", () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await setupTestContext("merge");
    await ctx.createUser("QUAN_LY_CO_SO");
    await ctx.createUser("TU_VAN_VIEN");
  });

  it("liệt kê nhóm trùng SĐT, gộp giữ lịch sử và ghi audit", async () => {
    const phone = uniquePhone();
    const keep = await ctx.createCustomer({ name: "Nguyễn Hồ Sơ Giữ", phone });
    // Hồ sơ trùng tạo thẳng qua prisma (API đã chặn trùng), mô phỏng dữ liệu cũ.
    const dup = await ctx.createCustomer({ name: "Nguyen Ho So Giu", phone: `+84${phone.slice(1)}` });
    await prisma.customer.update({ where: { id: dup.id }, data: { email: "trung@test.local", note: "ghi chú cũ" } });
    await prisma.activity.create({ data: { customerId: dup.id, type: "NOTE", content: "hoạt động của hồ sơ trùng" } });
    await prisma.task.create({ data: { customerId: dup.id, title: "việc của hồ sơ trùng" } });

    const groups = await ctx.as("QUAN_LY_CO_SO").get("/api/customers/duplicates");
    expect(groups.status).toBe(200);
    const group = groups.body.groups.find((g: { customers: Array<{ id: string }> }) =>
      g.customers.some((c) => c.id === keep.id)
    );
    expect(group.customers.map((c: { id: string }) => c.id).sort()).toEqual([keep.id, dup.id].sort());

    // Tư vấn viên không có quyền gộp.
    const denied = await ctx
      .as("TU_VAN_VIEN")
      .post("/api/customers/merge")
      .send({ primaryId: keep.id, duplicateIds: [dup.id], reason: "trùng số" });
    expect(denied.status).toBe(403);

    const res = await ctx
      .as("QUAN_LY_CO_SO")
      .post("/api/customers/merge")
      .send({ primaryId: keep.id, duplicateIds: [dup.id], reason: "Cùng một khách nhập hai lần" });
    expect(res.status).toBe(200);

    const merged = await prisma.customer.findUniqueOrThrow({ where: { id: dup.id } });
    expect(merged.hidden).toBe(true);
    expect(merged.mergedIntoId).toBe(keep.id);

    const kept = await prisma.customer.findUniqueOrThrow({ where: { id: keep.id } });
    expect(kept.email).toBe("trung@test.local");
    expect(kept.note).toContain("ghi chú cũ");

    expect(await prisma.activity.count({ where: { customerId: dup.id } })).toBe(0);
    expect(await prisma.activity.count({ where: { customerId: keep.id, content: "hoạt động của hồ sơ trùng" } })).toBe(1);
    expect(await prisma.task.count({ where: { customerId: keep.id } })).toBe(1);

    const audit = await prisma.auditLog.findFirst({ where: { action: "MERGE", entityId: keep.id } });
    expect(audit?.summary).toContain("Cùng một khách nhập hai lần");

    // Sau khi gộp: tạo khách mới cùng SĐT vẫn bị chặn (trỏ về hồ sơ giữ lại).
    const again = await ctx.as("QUAN_LY_CO_SO").post("/api/customers").send({ name: "Lại trùng", phone });
    expect(again.status).toBe(409);
    expect(again.body.duplicate.id).toBe(keep.id);

    // Gộp lại lần nữa bị từ chối.
    const twice = await ctx
      .as("QUAN_LY_CO_SO")
      .post("/api/customers/merge")
      .send({ primaryId: keep.id, duplicateIds: [dup.id], reason: "gộp lần hai" });
    expect(twice.status).toBe(409);
  });
});
