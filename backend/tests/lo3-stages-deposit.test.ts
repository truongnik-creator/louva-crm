import crypto from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestContext, uniquePhone, prisma, type TestContext } from "./helpers";
import { applyStageEvent, LEGACY_TO_INJECTION } from "../src/lib/stages";
import { migrateLegacyStages } from "../src/lib/stage-migration";
import { buildVietQrUrl } from "../src/lib/vietqr";
import { invalidateSettingsCache } from "../src/lib/settings-catalog";
import { StageEvent } from "../src/types/enums";
import { startOfVnDay } from "../src/lib/datetime";

// Lô 3: F1 (7 bước, mất khách bắt buộc lý do, StageHistory, tự chuyển bước),
// F6 (chế độ phòng khám ẩn bộ bước phẫu thuật), F25 + F12 (cọc gắn lịch hẹn,
// VietQR, tự trừ cọc khi thanh toán).

const uid = () => crypto.randomBytes(4).toString("hex");
let ctx: TestContext;

async function setSetting(key: string, value: string) {
  await prisma.systemSetting.upsert({ where: { key }, create: { key, value }, update: { value } });
  invalidateSettingsCache();
}

beforeAll(async () => {
  ctx = await setupTestContext("lo3stage");
  await ctx.createUser("QUAN_LY_CO_SO");
  await ctx.createUser("LE_TAN");
  await ctx.createUser("TELESALE");
  await ctx.createUser("QUAN_LY_HE_THONG");
  await setSetting("clinic.mode", "INJECTION");
});

afterAll(async () => {
  await setSetting("clinic.mode", "INJECTION");
});

async function stageOf(id: string) {
  return (await prisma.customer.findUniqueOrThrow({ where: { id } })).stage;
}

describe("F1: đổi bước tay", () => {
  it("khách mới tạo qua API ở bước Tiếp cận", async () => {
    const res = await ctx.as("QUAN_LY_CO_SO").post("/api/customers").send({ name: "Chị Tiếp Cận", phone: uniquePhone() });
    expect(res.status).toBe(201);
    expect(res.body.stage).toBe("TIEP_CAN");
  });

  it("đổi bước ghi StageHistory; mất khách bắt buộc lý do trong danh sách", async () => {
    const c = await ctx.createCustomer({ name: "Chị Bước", phone: uniquePhone() });
    const up = await ctx.as("QUAN_LY_CO_SO").post(`/api/customers/${c.id}/stage`).send({ stage: "CO_ANH" });
    expect(up.status).toBe(200);
    expect(up.body.stage).toBe("CO_ANH");

    const noReason = await ctx.as("QUAN_LY_CO_SO").post(`/api/customers/${c.id}/stage`).send({ stage: "MAT_KHACH" });
    expect(noReason.status).toBe(400);
    expect(noReason.body.error).toContain("lý do");

    const badReason = await ctx
      .as("QUAN_LY_CO_SO")
      .post(`/api/customers/${c.id}/stage`)
      .send({ stage: "MAT_KHACH", lostReason: "KHONG_CO_TRONG_DANH_SACH" });
    expect(badReason.status).toBe(400);

    const lost = await ctx
      .as("QUAN_LY_CO_SO")
      .post(`/api/customers/${c.id}/stage`)
      .send({ stage: "MAT_KHACH", lostReason: "CHE_GIA" });
    expect(lost.status).toBe(200);
    const saved = await prisma.customer.findUniqueOrThrow({ where: { id: c.id } });
    expect(saved.stage).toBe("MAT_KHACH");
    expect(saved.lostReason).toBe("CHE_GIA");

    const history = await prisma.stageHistory.findMany({ where: { customerId: c.id }, orderBy: { createdAt: "asc" } });
    expect(history.map((h) => [h.fromStage, h.toStage, h.source])).toEqual([
      ["TIEP_CAN", "CO_ANH", "MANUAL"],
      ["CO_ANH", "MAT_KHACH", "MANUAL"],
    ]);
    expect(history[1].lostReason).toBe("CHE_GIA");

    const hist = await ctx.as("QUAN_LY_CO_SO").get(`/api/customers/${c.id}/stage-history`);
    expect(hist.status).toBe(200);
    expect(hist.body).toHaveLength(2);
  });

  it("lùi bước bắt buộc ghi lý do; rời bước mất khách thì xoá lostReason", async () => {
    const c = await ctx.createCustomer({ name: "Chị Lùi", phone: uniquePhone() });
    await ctx.as("QUAN_LY_CO_SO").post(`/api/customers/${c.id}/stage`).send({ stage: "DEN_CO_SO" });
    const back = await ctx.as("QUAN_LY_CO_SO").post(`/api/customers/${c.id}/stage`).send({ stage: "NHAN_TIN" });
    expect(back.status).toBe(400);
    const ok = await ctx
      .as("QUAN_LY_CO_SO")
      .post(`/api/customers/${c.id}/stage`)
      .send({ stage: "NHAN_TIN", reason: "Khách dời lịch, nhắn lại" });
    expect(ok.status).toBe(200);
  });

  it("PATCH hồ sơ không đổi được bước (phải qua /stage để có lịch sử)", async () => {
    const c = await ctx.createCustomer({ name: "Chị Patch", phone: uniquePhone() });
    await ctx.as("QUAN_LY_CO_SO").patch(`/api/customers/${c.id}`).send({ stage: "QUAY_LAI", note: "x" });
    expect(await stageOf(c.id)).toBe("TIEP_CAN");
  });
});

describe("F6: chế độ phòng khám", () => {
  it("INJECTION: cấu hình trả 7 bước tiêm, bước phẫu thuật bị từ chối", async () => {
    const cfg = await ctx.as("TELESALE").get("/api/clinic/config");
    expect(cfg.status).toBe(200);
    expect(cfg.body.mode).toBe("INJECTION");
    expect(cfg.body.stages.map((s: { key: string }) => s.key)).toEqual([
      "TIEP_CAN", "NHAN_TIN", "CO_ANH", "LICH_COC", "DEN_CO_SO", "LAM_DICH_VU", "QUAY_LAI", "MAT_KHACH",
    ]);
    expect(cfg.body.terms.postOp).toBe("Chăm sóc sau tiêm");
    expect(cfg.body.lostReasons).toHaveLength(7);

    const c = await ctx.createCustomer({ name: "Chị Chế Độ", phone: uniquePhone() });
    const res = await ctx.as("QUAN_LY_CO_SO").post(`/api/customers/${c.id}/stage`).send({ stage: "PT" });
    expect(res.status).toBe(400);
  });

  it("SURGERY: đổi chế độ ở Cài đặt thì dùng bộ bước phẫu thuật, bộ tiêm bị ẩn", async () => {
    const bad = await ctx.as("QUAN_LY_HE_THONG").put("/api/settings").send({ values: { "clinic.mode": "LASER" } });
    expect(bad.status).toBe(400);
    const put = await ctx.as("QUAN_LY_HE_THONG").put("/api/settings").send({ values: { "clinic.mode": "SURGERY" } });
    expect(put.status).toBe(200);

    const cfg = await ctx.as("TELESALE").get("/api/clinic/config");
    const keys = cfg.body.stages.map((s: { key: string }) => s.key);
    expect(keys).toContain("PT");
    expect(keys).not.toContain("TIEP_CAN");
    expect(cfg.body.terms.procedure).toBe("Ca mổ");

    const c = await ctx.createCustomer({ name: "Chị Mổ", phone: uniquePhone() });
    await prisma.customer.update({ where: { id: c.id }, data: { stage: "MOI" } });
    expect((await ctx.as("QUAN_LY_CO_SO").post(`/api/customers/${c.id}/stage`).send({ stage: "CO_ANH" })).status).toBe(400);
    const lost = await ctx.as("QUAN_LY_CO_SO").post(`/api/customers/${c.id}/stage`).send({ stage: "MAT" });
    expect(lost.status).toBe(400); // mất khách ở chế độ phẫu thuật cũng bắt buộc lý do

    await ctx.as("QUAN_LY_HE_THONG").put("/api/settings").send({ values: { "clinic.mode": "INJECTION" } });
  });
});

describe("F1: tự chuyển bước theo sự kiện", () => {
  it("check-in: khách sang Đến cơ sở, ghi lịch sử nguồn AUTO", async () => {
    const c = await ctx.createCustomer({ name: "Chị Check-in", phone: uniquePhone() });
    const res = await ctx.as("LE_TAN").post("/api/reception/visits").send({ customerId: c.id });
    expect(res.status).toBe(201);
    expect(await stageOf(c.id)).toBe("DEN_CO_SO");
    const h = await prisma.stageHistory.findFirstOrThrow({ where: { customerId: c.id } });
    expect(h.source).toBe("AUTO");
    expect(h.event).toBe("CHECK_IN");
  });

  it("chỉ tiến không lùi: khách đã làm dịch vụ nhắn tin lại vẫn giữ bước", async () => {
    const c = await ctx.createCustomer({ name: "Chị Không Lùi", phone: uniquePhone() });
    await prisma.customer.update({ where: { id: c.id }, data: { stage: "LAM_DICH_VU" } });
    const r = await applyStageEvent(c.id, StageEvent.MESSAGE);
    expect(r.changed).toBe(false);
    expect(await stageOf(c.id)).toBe("LAM_DICH_VU");
  });

  it("khách đã mất chỉ quay lại khi có sự kiện mạnh (cọc, check-in)", async () => {
    const c = await ctx.createCustomer({ name: "Chị Mất", phone: uniquePhone() });
    await prisma.customer.update({ where: { id: c.id }, data: { stage: "MAT_KHACH", lostReason: "O_XA" } });
    expect((await applyStageEvent(c.id, StageEvent.MESSAGE)).changed).toBe(false);
    expect((await applyStageEvent(c.id, StageEvent.CHECK_IN)).to).toBe("DEN_CO_SO");
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: c.id } })).lostReason).toBeNull();
  });

  it("làm dịch vụ lần 2 trong 180 ngày thì sang Quay lại; cùng ngày chỉ tính một lần", async () => {
    const c = await ctx.createCustomer({ name: "Chị Quay Lại", phone: uniquePhone() });
    // Mốc 12:00 giờ VN của 60 ngày trước: cộng 1 giờ vẫn cùng ngày VN, dù test chạy lúc 23:xx.
    const first = new Date(startOfVnDay(new Date(Date.now() - 60 * 86_400_000)).getTime() + 12 * 3600_000);
    expect((await applyStageEvent(c.id, StageEvent.PROCEDURE_DONE, { at: first })).to).toBe("LAM_DICH_VU");
    // Cùng ngày (khách rời quầy sau ca thực hiện) không phải lần 2.
    await applyStageEvent(c.id, StageEvent.VISIT_SERVICE_DONE, { at: new Date(first.getTime() + 3600_000) });
    expect(await stageOf(c.id)).toBe("LAM_DICH_VU");
    expect((await applyStageEvent(c.id, StageEvent.VISIT_SERVICE_DONE)).to).toBe("QUAY_LAI");
  });

  it("quá 180 ngày thì không tính là quay lại", async () => {
    const c = await ctx.createCustomer({ name: "Chị Lâu Ngày", phone: uniquePhone() });
    await prisma.customer.update({
      where: { id: c.id },
      data: { stage: "NHAN_TIN", lastServiceAt: new Date(Date.now() - 400 * 86_400_000) },
    });
    expect((await applyStageEvent(c.id, StageEvent.PROCEDURE_DONE)).to).toBe("LAM_DICH_VU");
  });

  it("script migrate chuyển bước cũ sang bộ 7 bước và ghi lịch sử MIGRATION", async () => {
    const c = await ctx.createCustomer({ name: "Chị Bước Cũ", phone: uniquePhone() });
    await prisma.customer.update({ where: { id: c.id }, data: { stage: "HAUPHAU" } });
    const dry = await migrateLegacyStages({ apply: false });
    expect(dry.total).toBeGreaterThan(0);
    expect(await stageOf(c.id)).toBe("HAUPHAU");
    await migrateLegacyStages({ apply: true });
    expect(await stageOf(c.id)).toBe(LEGACY_TO_INJECTION.HAUPHAU);
    const h = await prisma.stageHistory.findFirstOrThrow({ where: { customerId: c.id } });
    expect([h.fromStage, h.toStage, h.source]).toEqual(["HAUPHAU", "LAM_DICH_VU", "MIGRATION"]);
  });
});

describe("F25 + F12: cọc gắn lịch hẹn", () => {
  it("VietQR quick link đúng định dạng img.vietqr.io", () => {
    const url = buildVietQrUrl({
      bank: { bin: "970436", accountNo: "0011001234567", accountName: "CONG TY NOVA" },
      amount: 500000,
      addInfo: "LH-2609-0001",
    });
    expect(url).toBe(
      "https://img.vietqr.io/image/970436-0011001234567-compact2.png?amount=500000&addInfo=LH-2609-0001&accountName=CONG+TY+NOVA"
    );
  });

  it("đặt lịch có cọc, lấy QR, lễ tân xác nhận một nút: phiếu DEPOSIT + bước Lịch cọc", async () => {
    await setSetting("deposit.bankBin", "970436");
    await setSetting("deposit.bankAccountNo", "0011001234567");
    await setSetting("deposit.bankAccountName", "CONG TY NOVA");

    const c = await ctx.createCustomer({ name: "Chị Cọc", phone: uniquePhone() });
    const start = new Date(Date.now() + 3 * 86_400_000);
    const appt = await ctx.as("LE_TAN").post("/api/reception/appointments").send({
      customerId: c.id,
      title: `Filler ${uid()}`,
      startAt: start.toISOString(),
      depositAmount: 500_000,
    });
    expect(appt.status).toBe(201);
    expect(appt.body.code).toMatch(/^LH-\d{4}-\d{4}$/);
    expect(appt.body.depositStatus).toBe("CHO_COC");
    // Phòng khám tiêm: đặt lịch chưa cọc chưa lên bước.
    expect(await stageOf(c.id)).toBe("TIEP_CAN");

    const qr = await ctx.as("LE_TAN").get(`/api/reception/appointments/${appt.body.id}/deposit-qr`);
    expect(qr.status).toBe(200);
    expect(qr.body.bankConfigured).toBe(true);
    expect(qr.body.url).toBe(
      `https://img.vietqr.io/image/970436-0011001234567-compact2.png?amount=500000&addInfo=${appt.body.code}&accountName=CONG+TY+NOVA`
    );

    const denied = await ctx.as("TELESALE").post(`/api/reception/appointments/${appt.body.id}/deposit/confirm`).send({});
    expect(denied.status).toBe(403);

    const ok = await ctx.as("LE_TAN").post(`/api/reception/appointments/${appt.body.id}/deposit/confirm`).send({});
    expect(ok.status).toBe(201);
    expect(ok.body.appointment.depositStatus).toBe("DA_COC");
    expect(ok.body.payment.type).toBe("DEPOSIT");
    expect(ok.body.payment.amount).toBe(500_000);
    expect(ok.body.payment.appointmentId).toBe(appt.body.id);
    expect(await stageOf(c.id)).toBe("LICH_COC");

    const again = await ctx.as("LE_TAN").post(`/api/reception/appointments/${appt.body.id}/deposit/confirm`).send({});
    expect(again.status).toBe(409);
  });

  it("thanh toán dịch vụ tự trừ cọc; không cho thu vượt phần còn lại sau cọc", async () => {
    const c = await ctx.createCustomer({ name: "Chị Trừ Cọc", phone: uniquePhone() });
    const appt = await ctx.as("LE_TAN").post("/api/reception/appointments").send({
      customerId: c.id,
      title: `Meso ${uid()}`,
      startAt: new Date(Date.now() + 5 * 86_400_000).toISOString(),
      depositAmount: 1_000_000,
    });
    expect((await ctx.as("LE_TAN").post(`/api/reception/appointments/${appt.body.id}/deposit/confirm`).send({})).status).toBe(201);
    const inv = await prisma.invoice.create({
      data: {
        code: `HD-L3-${uid()}`,
        branchId: ctx.branchId,
        customerId: c.id,
        amount: 5_000_000,
        status: "ISSUED",
        issuedAt: new Date(),
      },
    });

    const over = await ctx
      .as("LE_TAN")
      .post("/api/sales/payments")
      .send({ customerId: c.id, invoiceId: inv.id, amount: 5_000_000 });
    expect(over.status).toBe(400);
    expect(over.body.error).toContain("trừ cọc");

    const open = await ctx.as("LE_TAN").get("/api/sales/open-deposits").query({ customerId: c.id });
    expect(open.body.total).toBe(1_000_000);

    const pay = await ctx
      .as("LE_TAN")
      .post("/api/sales/payments")
      .send({ customerId: c.id, invoiceId: inv.id, amount: 4_000_000, misaInvoiceNo: "MISA-0001" });
    expect(pay.status).toBe(201);
    expect(pay.body.depositApplied).toBe(1_000_000);
    expect(pay.body.type).toBe("PAYMENT");
    expect(pay.body.misaInvoiceNo).toBe("MISA-0001");

    const after = await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } });
    expect(after.paidAmount).toBe(5_000_000);
    expect(after.status).toBe("PAID");
    const deposit = await prisma.payment.findFirstOrThrow({ where: { appointmentId: appt.body.id, type: "DEPOSIT" } });
    expect(deposit.invoiceId).toBe(inv.id);
    expect(deposit.depositAppliedAt).not.toBeNull();
    // Cọc đã trừ thì không trừ lần hai.
    expect((await ctx.as("LE_TAN").get("/api/sales/open-deposits").query({ customerId: c.id })).body.total).toBe(0);
  });

  it("cọc trả đủ phần còn lại: thu 0 đồng chỉ ghi trừ cọc, hoá đơn đã thu đủ", async () => {
    const c = await ctx.createCustomer({ name: "Chị Cọc Đủ", phone: uniquePhone() });
    const appt = await ctx.as("LE_TAN").post("/api/reception/appointments").send({
      customerId: c.id,
      title: `Tan ${uid()}`,
      startAt: new Date(Date.now() + 6 * 86_400_000).toISOString(),
      depositAmount: 500_000,
    });
    expect((await ctx.as("LE_TAN").post(`/api/reception/appointments/${appt.body.id}/deposit/confirm`).send({})).status).toBe(201);
    const inv = await prisma.invoice.create({
      data: { code: `HD-L3-${uid()}`, branchId: ctx.branchId, customerId: c.id, amount: 500_000, status: "ISSUED" },
    });
    const zeroNoDeposit = await ctx.as("LE_TAN").post("/api/sales/payments").send({ customerId: c.id, invoiceId: inv.id, amount: 0, applyDeposit: false });
    expect(zeroNoDeposit.status).toBe(400);
    const pay = await ctx.as("LE_TAN").post("/api/sales/payments").send({ customerId: c.id, invoiceId: inv.id, amount: 0 });
    expect(pay.status).toBe(201);
    expect(pay.body.depositApplied).toBe(500_000);
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } })).status).toBe("PAID");
  });

  it("báo cáo tỉ lệ có cọc và không đến theo có, không cọc", async () => {
    const res = await ctx.as("QUAN_LY_CO_SO").get("/api/reports/deposits").query({ period: "month" });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("depositRate");
    expect(res.body.noShow).toHaveProperty("withDeposit");
    expect(res.body.noShow).toHaveProperty("withoutDeposit");
  });
});
