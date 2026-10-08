import crypto from "node:crypto";
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { setupTestContext, uniquePhone, prisma, api, type TestContext } from "./helpers";
import { decryptNullable, encryptNullable } from "../src/lib/crypto";
import { extractVnPhones } from "../src/lib/extract";
import { setAiClientForTests, type AiClient, type AiRequest } from "../src/lib/ai";
import { ingestMessageMedia } from "../src/lib/chat-media";
import { invalidateSettingsCache } from "../src/lib/settings-catalog";

// Lô 3: F4 (nhập Excel/CSV chống trùng), F5 (Pancake trả lời qua Pancake,
// webhook có xác thực, nguồn quảng cáo), AI1 (regex + AI có cổng đồng ý, mock),
// F2 (ảnh chat tự lưu hồ sơ, cờ marketing), F24 (gửi vị trí).

const uid = () => crypto.randomBytes(4).toString("hex");
let ctx: TestContext;

beforeAll(async () => {
  ctx = await setupTestContext("lo3inbox");
  await ctx.createUser("QUAN_LY_CO_SO");
  await ctx.createUser("TELESALE");
  await ctx.createUser("BAC_SI");
  await ctx.createUser("DIEU_DUONG");
  await prisma.systemSetting.upsert({
    where: { key: "clinic.mode" },
    create: { key: "clinic.mode", value: "INJECTION" },
    update: { value: "INJECTION" },
  });
  invalidateSettingsCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  setAiClientForTests(undefined);
});

afterAll(() => setAiClientForTests(undefined));

function csv(rows: string[][]): Buffer {
  return Buffer.from("﻿" + rows.map((r) => r.join(",")).join("\r\n"), "utf8");
}

describe("F4: nhập khách từ CSV", () => {
  it("chỉ vai có quyền nhập mới dùng được", async () => {
    const res = await ctx
      .as("TELESALE")
      .post("/api/customers/import/parse")
      .attach("file", csv([["Họ tên", "SĐT"], ["A", "0912000000"]]), "khach.csv");
    expect(res.status).toBe(403);
  });

  it("xem trước, gợi ý ghép cột, chống trùng theo SĐT chuẩn hoá (bỏ qua), báo lỗi và tải tệp lỗi", async () => {
    const existingPhone = uniquePhone();
    await ctx.createCustomer({ name: "Khách Đã Có", phone: existingPhone });
    const newPhone = uniquePhone();
    const file = csv([
      ["Họ tên", "Số điện thoại", "Dịch vụ đã làm", "Ngày làm", "Nguồn", "Ghi chú"],
      ["Khách Mới Một", newPhone, "Filler Hàn Sardenya (1cc)", "15/03/2026", "Facebook", "Khách cũ 2025"],
      ["Khách Đã Có", `+84 ${existingPhone.slice(1)}`, "", "", "", ""],
      ["Khách Mới Một Lặp", `${newPhone.slice(0, 4)}.${newPhone.slice(4, 7)}.${newPhone.slice(7)}`, "", "", "", ""],
      ["Sai Số", "12345", "", "", "", ""],
      ["Khách Không Số", "", "", "", "Hội chợ", ""],
      ["X", "", "", "", "", ""],
    ]);

    const parsed = await ctx.as("QUAN_LY_CO_SO").post("/api/customers/import/parse").attach("file", file, "khach-cu.csv");
    expect(parsed.status).toBe(200);
    expect(parsed.body.totalRows).toBe(6);
    expect(parsed.body.preview).toHaveLength(6);
    expect(parsed.body.suggestedMapping).toMatchObject({ name: 0, phone: 1, service: 2, serviceDate: 3, source: 4, note: 5 });

    const run = await ctx.as("QUAN_LY_CO_SO").post("/api/customers/import/run").send({
      token: parsed.body.token,
      mapping: parsed.body.suggestedMapping,
      duplicateMode: "SKIP",
    });
    expect(run.status).toBe(200);
    expect(run.body).toMatchObject({ total: 6, created: 2, skipped: 2, errors: 2, updated: 0, merged: 0 });
    expect(run.body.errorRows.map((e: { row: number }) => e.row)).toEqual([5, 7]);

    const created = await prisma.customer.findFirstOrThrow({ where: { phoneNormalized: newPhone } });
    expect(created.name).toBe("Khách Mới Một");
    expect(created.stage).toBe("LAM_DICH_VU"); // có ngày làm dịch vụ
    expect(created.lastServiceAt).not.toBeNull();
    expect(await prisma.customer.count({ where: { phoneNormalized: newPhone } })).toBe(1);
    expect(await prisma.customer.count({ where: { phoneNormalized: existingPhone } })).toBe(1);
    const noPhone = await prisma.customer.findFirstOrThrow({ where: { name: "Khách Không Số", createdAt: { gte: new Date(Date.now() - 60_000) } } });
    expect(noPhone.note).toContain("Nguồn: Hội chợ");

    const errFile = await ctx.as("QUAN_LY_CO_SO").get(`/api/customers/import/errors/${run.body.errorFileToken}`);
    expect(errFile.status).toBe(200);
    expect(errFile.headers["content-type"]).toContain("text/csv");
    expect(errFile.text).toContain("Lỗi");
    expect(errFile.text).toContain("SĐT không hợp lệ");

    const audit = await prisma.auditLog.findFirst({ where: { action: "IMPORT", summary: { contains: "khach-cu.csv" } } });
    expect(audit).not.toBeNull();

    // Một phiên chỉ chạy một lần.
    const rerun = await ctx.as("QUAN_LY_CO_SO").post("/api/customers/import/run").send({
      token: parsed.body.token,
      mapping: parsed.body.suggestedMapping,
      duplicateMode: "SKIP",
    });
    expect(rerun.status).toBe(404);
  });

  it("gộp (MERGE) chỉ điền ô trống và nối ghi chú; cập nhật (UPDATE) ghi đè tên", async () => {
    const phone = uniquePhone();
    const c = await ctx.createCustomer({ name: "Tên Cũ", phone });
    const file = csv([
      ["Tên", "SĐT", "Ghi chú", "Dịch vụ"],
      ["Tên Mới", phone, "Đã tiêm 2 lần", "Botox gọn hàm Hàn"],
    ]);
    const mapping = { name: 0, phone: 1, note: 2, service: 3 };

    const p1 = await ctx.as("QUAN_LY_CO_SO").post("/api/customers/import/parse").attach("file", file, "gop.csv");
    const merge = await ctx.as("QUAN_LY_CO_SO").post("/api/customers/import/run").send({ token: p1.body.token, mapping, duplicateMode: "MERGE" });
    expect(merge.body.merged).toBe(1);
    let saved = await prisma.customer.findUniqueOrThrow({ where: { id: c.id } });
    expect(saved.name).toBe("Tên Cũ");
    expect(saved.note).toContain("Đã tiêm 2 lần");
    expect(JSON.parse(saved.interest!)).toContain("Botox gọn hàm Hàn");

    const p2 = await ctx.as("QUAN_LY_CO_SO").post("/api/customers/import/parse").attach("file", file, "capnhat.csv");
    const update = await ctx.as("QUAN_LY_CO_SO").post("/api/customers/import/run").send({ token: p2.body.token, mapping, duplicateMode: "UPDATE" });
    expect(update.body.updated).toBe(1);
    saved = await prisma.customer.findUniqueOrThrow({ where: { id: c.id } });
    expect(saved.name).toBe("Tên Mới");
  });

  it("đọc được tệp .xlsx", async () => {
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Khach");
    const phone = uniquePhone();
    ws.addRow(["Họ và tên", "Điện thoại"]);
    ws.addRow(["Khách Excel", phone]);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const parsed = await ctx.as("QUAN_LY_CO_SO").post("/api/customers/import/parse").attach("file", buf, "khach.xlsx");
    expect(parsed.status).toBe(200);
    expect(parsed.body.preview[0]).toEqual(["Khách Excel", phone]);
  });

  it("từ chối tệp không phải bảng tính", async () => {
    const res = await ctx
      .as("QUAN_LY_CO_SO")
      .post("/api/customers/import/parse")
      .attach("file", Buffer.from("MZ\x90\x00binary"), "virus.exe");
    expect(res.status).toBe(415);
  });
});

async function pancakeFixture(opts: { secret?: string; pageToken?: string | null } = {}) {
  const config = await prisma.pancakeConfig.create({
    data: {
      label: `Pancake ${uid()}`,
      accessTokenEnc: encryptNullable("pancake-test-token-123")!,
      webhookSecretEnc: opts.secret ? encryptNullable(opts.secret) : null,
      branchId: ctx.branchId,
    },
  });
  const page = await prisma.pancakePage.create({
    data: {
      configId: config.id,
      pageId: `pg${uid()}`,
      name: "Trang NOVA",
      platform: "FACEBOOK",
      branchId: ctx.branchId,
      // API cấp trang của Pancake chỉ nhận page_access_token.
      pageAccessTokenEnc: opts.pageToken === null ? null : encryptNullable(opts.pageToken ?? "pancake-page-token-456"),
    },
  });
  return { config, page };
}

describe("F5: Pancake", () => {
  it("trả lời hội thoại nguồn Pancake đi qua API Pancake, không qua Zalo", async () => {
    const { page } = await pancakeFixture();
    const c = await ctx.createCustomer({ name: "Khách Pancake", phone: uniquePhone() });
    const conv = await prisma.conversation.create({
      data: {
        title: "Khách Pancake",
        kind: "CUSTOMER",
        channel: "FACEBOOK",
        branchId: ctx.branchId,
        customerId: c.id,
        pancakePageId: page.id,
        pancakeConversationId: `pc-${uid()}`,
      },
    });
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        calls.push({ url: String(url), init });
        return new Response(JSON.stringify({ id: `m-${uid()}` }), { status: 200, headers: { "content-type": "application/json" } });
      })
    );

    const res = await ctx.as("QUAN_LY_CO_SO").post(`/api/conversations/${conv.id}/messages`).send({ content: "Dạ em chào chị" });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("SENT");
    expect(res.body.channel).toBe("PANCAKE");
    expect(calls).toHaveLength(1);
    // Tài liệu Pancake: API cấp trang nằm ở /api/public_api/v1 và token đi bằng
    // tham số URL page_access_token, KHÔNG có header Authorization.
    expect(calls[0].url).toContain("/api/public_api/v1");
    expect(calls[0].url).toContain(`/pages/${page.pageId}/conversations/${conv.pancakeConversationId}/messages`);
    expect(calls[0].url).not.toContain("zalo");
    expect(calls[0].url).toContain("page_access_token=pancake-page-token-456");
    // Token người dùng không được dùng cho API cấp trang.
    expect(calls[0].url).not.toContain("pancake-test-token-123");
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBeUndefined();
    // F1: nhắn tin thì khách sang bước Nhắn tin.
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: c.id } })).stage).toBe("NHAN_TIN");
  });

  it("hội thoại Zalo vẫn gửi qua Zalo (báo lỗi chưa gắn OA, không gọi Pancake)", async () => {
    const conv = await prisma.conversation.create({ data: { title: "Zalo", kind: "CUSTOMER", channel: "ZALO_OA", branchId: ctx.branchId } });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const res = await ctx.as("QUAN_LY_CO_SO").post(`/api/conversations/${conv.id}/messages`).send({ content: "Chào" });
    expect(res.body.status).toBe("FAILED");
    expect(res.body.errorMessage).toContain("Official Account");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("webhook: sai bí mật bị từ chối; đúng bí mật thì ghi tin, lưu nguồn quảng cáo, tạo lead, không nhân bản", async () => {
    const secret = `whsec-${uid()}`;
    const { page } = await pancakeFixture({ secret });
    const convId = `pcw-${uid()}`;
    const payload = {
      page_id: page.pageId,
      event_type: "messaging",
      data: {
        conversation: { id: convId, customer_name: "Khách Quảng Cáo", ad_id: "120210001", post_id: "post-77", campaign_name: "Filler tháng 10" },
        message: { id: `msg-${uid()}`, message: "Cho em hỏi giá filler", from_customer: true, inserted_at: new Date().toISOString() },
      },
    };

    const wrong = await api(ctx.app).post("/api/pancake/webhook").set("X-Webhook-Secret", "sai").send(payload);
    expect(wrong.status).toBe(401);

    const body = JSON.stringify(payload);
    const sig = crypto.createHmac("sha256", secret).update(body).digest("hex");
    const ok = await api(ctx.app)
      .post("/api/pancake/webhook")
      .set("Content-Type", "application/json")
      .set("X-Pancake-Signature", sig)
      .send(body);
    expect(ok.status).toBe(200);
    expect(ok.body.created).toBe(1);

    const conv = await prisma.conversation.findUniqueOrThrow({ where: { pancakeConversationId: convId } });
    expect(conv.adId).toBe("120210001");
    expect(conv.adPostId).toBe("post-77");
    expect(conv.adCampaign).toBe("Filler tháng 10");
    expect(conv.unreadCount).toBe(1);
    const lead = await prisma.lead.findUniqueOrThrow({ where: { externalId: `pancake:${convId}` } });
    expect(lead.adId).toBe("120210001");
    expect(conv.leadId).toBe(lead.id);

    const again = await api(ctx.app).post("/api/pancake/webhook").set("X-Webhook-Secret", secret).send(payload);
    expect(again.status).toBe(200);
    expect(again.body.created).toBe(0);
    expect(await prisma.chatMessage.count({ where: { conversationId: conv.id } })).toBe(1);
  });

  it("trang chưa có token riêng thì tự sinh token trang một lần rồi lưu lại", async () => {
    const { page } = await pancakeFixture({ pageToken: null });
    const conv = await prisma.conversation.create({
      data: {
        title: "Khách chưa có token trang",
        kind: "CUSTOMER",
        channel: "FACEBOOK",
        branchId: ctx.branchId,
        pancakePageId: page.id,
        pancakeConversationId: `pc-${uid()}`,
      },
    });
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        const u = String(url);
        calls.push(u);
        const body = u.includes("generate_page_access_token")
          ? { page_access_token: "pat-vua-sinh" }
          : { id: `m-${uid()}` };
        return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
      })
    );

    const res = await ctx.as("QUAN_LY_CO_SO").post(`/api/conversations/${conv.id}/messages`).send({ content: "Chào chị" });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("SENT");
    // Lượt 1: sinh token bằng token người dùng. Lượt 2: gửi tin bằng token trang.
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("generate_page_access_token");
    expect(calls[0]).toContain("access_token=pancake-test-token-123");
    expect(calls[1]).toContain("page_access_token=pat-vua-sinh");
    // Đã lưu lại nên lần sau không gọi sinh token nữa.
    const saved = await prisma.pancakePage.findUniqueOrThrow({ where: { id: page.id } });
    expect(decryptNullable(saved.pageAccessTokenEnc)).toBe("pat-vua-sinh");
  });

  it("đồng bộ tay chạy nền trả 202", async () => {
    const { config } = await pancakeFixture();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ conversations: [] }), { status: 200 })));
    const res = await ctx.as("QUAN_LY_CO_SO").post(`/api/pancake/${config.id}/sync`);
    expect(res.status).toBe(202);
    const waited = await ctx.as("QUAN_LY_CO_SO").post(`/api/pancake/${config.id}/sync?wait=1`);
    expect([200, 202]).toContain(waited.status);
  });
});

class MockAi implements AiClient {
  calls: AiRequest[] = [];
  constructor(private reply: string) {}
  async complete(req: AiRequest) {
    this.calls.push(req);
    return { text: this.reply, model: req.model };
  }
}

describe("AI1: tách thông tin từ chat", () => {
  it("regex SĐT Việt Nam nhiều cách viết, bỏ số dính chuỗi số dài", () => {
    expect(extractVnPhones("sđt em 0912 345 678 nhé")).toEqual(["0912345678"]);
    expect(extractVnPhones("+84.987.654.321 hoặc 0987654321")).toEqual(["0987654321"]);
    expect(extractVnPhones("mã đơn 1234567890123456")).toEqual([]);
    expect(extractVnPhones("số 0123 không hợp lệ")).toEqual([]);
  });

  async function convWith(customerId: string | null, text: string) {
    const conv = await prisma.conversation.create({
      data: { title: "Khách AI", kind: "CUSTOMER", channel: "FACEBOOK", branchId: ctx.branchId, customerId },
    });
    await prisma.chatMessage.create({ data: { conversationId: conv.id, direction: "IN", content: text } });
    return conv;
  }

  it("khách CHƯA đồng ý: không gọi AI, regex vẫn chạy", async () => {
    const mock = new MockAi('{"phone":null,"name":"Hà","interest":"filler","area":"Cầu Giấy"}');
    setAiClientForTests(mock);
    const c = await ctx.createCustomer({ name: "Khách Chưa Đồng Ý", phone: null });
    const conv = await convWith(c.id, "Em tên Hà, sđt 0912 345 111, ở Cầu Giấy muốn tiêm filler");
    const res = await ctx.as("QUAN_LY_CO_SO").post(`/api/conversations/${conv.id}/extract`);
    expect(res.status).toBe(200);
    expect(res.body.ai.status).toBe("NO_CONSENT");
    expect(res.body.suggestion.phone).toBe("0912345111");
    expect(mock.calls).toHaveLength(0);
  });

  it("AI chưa cấu hình: báo NOT_CONFIGURED, không lỗi", async () => {
    setAiClientForTests(null);
    const c = await ctx.createCustomer({ name: "Khách Không AI", phone: null });
    await prisma.customer.update({ where: { id: c.id }, data: { aiDataConsent: true } });
    const conv = await convWith(c.id, "Em ở Hà Nội, sđt 0912345222");
    const res = await ctx.as("QUAN_LY_CO_SO").post(`/api/conversations/${conv.id}/extract`);
    expect(res.status).toBe(200);
    expect(res.body.ai.status).toBe("NOT_CONFIGURED");
    const cfg = await ctx.as("TELESALE").get("/api/clinic/config");
    expect(cfg.body.ai.configured).toBe(false);
  });

  it("khách đã đồng ý: gọi AI (mock), ghi DataAccessLog, gợi ý không tự ghi hồ sơ; Áp dụng thì mới ghi", async () => {
    const mock = new MockAi('```json\n{"phone":"0912345333","name":"Nguyễn Thu Hà","interest":"Filler","area":"Cầu Giấy"}\n```');
    setAiClientForTests(mock);
    const c = await ctx.createCustomer({ name: "Khách Zalo 123", phone: null });
    const consent = await ctx.as("QUAN_LY_CO_SO").post(`/api/customers/${c.id}/ai-consent`).send({ consent: true });
    expect(consent.status).toBe(200);
    const conv = await convWith(c.id, "Em tên Thu Hà ở Cầu Giấy, muốn tiêm filler");

    const res = await ctx.as("QUAN_LY_CO_SO").post(`/api/conversations/${conv.id}/extract`);
    expect(res.body.ai.status).toBe("OK");
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0].model).toBe("claude-haiku-4-5-20251001");
    expect(res.body.suggestion).toEqual({ phone: "0912345333", name: "Nguyễn Thu Hà", interest: "Filler", area: "Cầu Giấy" });
    const log = await prisma.dataAccessLog.findFirst({ where: { customerId: c.id, resourceType: "AI_PROCESSING" } });
    expect(log).not.toBeNull();
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: c.id } })).name).toBe("Khách Zalo 123");

    const apply = await ctx
      .as("QUAN_LY_CO_SO")
      .post(`/api/conversations/${conv.id}/extract/apply`)
      .send(res.body.suggestion);
    expect(apply.status).toBe(200);
    const saved = await prisma.customer.findUniqueOrThrow({ where: { id: c.id } });
    expect(saved.name).toBe("Nguyễn Thu Hà");
    expect(saved.phoneNormalized).toBe("0912345333");
    expect(saved.city).toBe("Cầu Giấy");
  });

  it("SĐT trùng khách khác: báo trùng, không tự gộp", async () => {
    setAiClientForTests(null);
    const phone = uniquePhone();
    const other = await ctx.createCustomer({ name: "Khách Có Số", phone });
    const c = await ctx.createCustomer({ name: "Khách Mới Nhắn", phone: null });
    const conv = await convWith(c.id, `số em ${phone}`);
    const res = await ctx.as("QUAN_LY_CO_SO").post(`/api/conversations/${conv.id}/extract`);
    expect(res.body.duplicate).toMatchObject({ id: other.id });
    const apply = await ctx.as("QUAN_LY_CO_SO").post(`/api/conversations/${conv.id}/extract/apply`).send({ phone });
    expect(apply.status).toBe(409);
    expect(apply.body.duplicate.id).toBe(other.id);
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: c.id } })).phone).toBeNull();
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: other.id } })).mergedIntoId).toBeNull();
  });
});

describe("F2: ảnh khách gửi qua chat", () => {
  const png = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), crypto.randomBytes(64)]);

  it("tự tải, mã hoá, lưu vào bộ ảnh CHAT; khách sang bước Có ảnh", async () => {
    const c = await ctx.createCustomer({ name: "Khách Gửi Ảnh", phone: uniquePhone() });
    await prisma.customer.update({ where: { id: c.id }, data: { stage: "NHAN_TIN" } });
    const conv = await prisma.conversation.create({
      data: { title: "Khách Gửi Ảnh", kind: "CUSTOMER", channel: "ZALO_OA", branchId: ctx.branchId, customerId: c.id },
    });
    const msg = await prisma.chatMessage.create({
      data: {
        conversationId: conv.id,
        direction: "IN",
        type: "IMAGE",
        content: "[Tệp đính kèm]",
        attachments: { create: { kind: "IMAGE", fileName: "mat.png", url: "https://cdn.example.test/mat.png" } },
      },
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(png, { status: 200, headers: { "content-length": String(png.length) } })));

    await ingestMessageMedia(msg.id);
    const att = await prisma.messageAttachment.findFirstOrThrow({ where: { messageId: msg.id } });
    expect(att.storageKey).toBeTruthy();
    expect(att.savedPhotoSetId).toBeTruthy();
    const set = await prisma.photoSet.findUniqueOrThrow({ where: { id: att.savedPhotoSetId! }, include: { photos: true } });
    expect(set.stage).toBe("CHAT");
    expect(set.consentForMarketing).toBe(false);
    expect(set.photos).toHaveLength(1);
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: c.id } })).stage).toBe("CO_ANH");

    // Cờ marketing: điều dưỡng không bật được, bác sĩ bật được và có audit.
    const denied = await ctx.as("DIEU_DUONG").patch(`/api/medical/photo-sets/${set.id}/marketing-consent`).send({ consent: true });
    expect(denied.status).toBe(403);
    const ok = await ctx.as("BAC_SI").patch(`/api/medical/photo-sets/${set.id}/marketing-consent`).send({ consent: true });
    expect(ok.status).toBe(200);
    expect(ok.body.consentForMarketing).toBe(true);
    expect(await prisma.auditLog.count({ where: { entity: "PhotoSet", entityId: set.id } })).toBeGreaterThan(0);
  });

  it("ảnh chưa gắn hồ sơ thì chờ; gắn hồ sơ xong mới lưu", async () => {
    const conv = await prisma.conversation.create({ data: { title: "Khách Lạ", kind: "CUSTOMER", channel: "ZALO_OA", branchId: ctx.branchId } });
    const msg = await prisma.chatMessage.create({
      data: {
        conversationId: conv.id,
        direction: "IN",
        content: "[Tệp đính kèm]",
        attachments: { create: { kind: "IMAGE", fileName: "a.png", url: "https://cdn.example.test/a.png" } },
      },
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(png, { status: 200 })));
    await ingestMessageMedia(msg.id);
    let att = await prisma.messageAttachment.findFirstOrThrow({ where: { messageId: msg.id } });
    expect(att.storageKey).toBeTruthy();
    expect(att.savedPhotoSetId).toBeNull();

    const c = await ctx.createCustomer({ name: "Khách Lạ", phone: uniquePhone() });
    const link = await ctx.as("QUAN_LY_CO_SO").post(`/api/conversations/${conv.id}/link-customer`).send({ customerId: c.id });
    expect(link.status).toBe(200);
    await vi.waitFor(async () => {
      att = await prisma.messageAttachment.findFirstOrThrow({ where: { messageId: msg.id } });
      expect(att.savedPhotoSetId).toBeTruthy();
    });
  });

  it("ảnh quá dung lượng hoặc không phải ảnh thì không lưu", async () => {
    const conv = await prisma.conversation.create({ data: { title: "Khách X", kind: "CUSTOMER", channel: "ZALO_OA", branchId: ctx.branchId } });
    const msg = await prisma.chatMessage.create({
      data: {
        conversationId: conv.id,
        direction: "IN",
        content: "x",
        attachments: { create: { kind: "IMAGE", fileName: "x.png", url: "https://cdn.example.test/x.png" } },
      },
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>not image</html>", { status: 200 })));
    await ingestMessageMedia(msg.id);
    expect((await prisma.messageAttachment.findFirstOrThrow({ where: { messageId: msg.id } })).storageKey).toBeNull();
  });
});

describe("F24: gửi vị trí và bảng giá chuẩn", () => {
  it("tin vị trí lấy đúng cơ sở của hội thoại; bảng giá lấy giá niêm yết", async () => {
    await prisma.branch.update({
      where: { id: ctx.branchId },
      data: { address: "Tầng 3, 12 Phố Test", mapUrl: "https://maps.example.test/nova", parkingGuide: "Gửi xe tầng hầm B1" },
    });
    const svc = await prisma.service.create({ data: { code: `L3-${uid()}`.toUpperCase(), name: `Meso thử ${uid()}` } });
    await prisma.servicePrice.create({ data: { serviceId: svc.id, branchId: ctx.branchId, price: 3_000_000, minPrice: 2_000_000 } });
    const c = await ctx.createCustomer({ name: "Khách Vị Trí", phone: uniquePhone() });
    await prisma.customer.update({ where: { id: c.id }, data: { interest: JSON.stringify([svc.name]) } });
    const conv = await prisma.conversation.create({
      data: {
        title: "Khách Vị Trí",
        kind: "CUSTOMER",
        channel: "ZALO_OA",
        branchId: ctx.branchId,
        customerId: c.id,
        assignedToId: ctx.users.TELESALE.id,
      },
    });

    const loc = await ctx.as("TELESALE").get(`/api/conversations/${conv.id}/canned/location`);
    expect(loc.status).toBe(200);
    expect(loc.body.content).toContain("Tầng 3, 12 Phố Test");
    expect(loc.body.content).toContain("https://maps.example.test/nova");
    expect(loc.body.content).toContain("Gửi xe tầng hầm B1");

    const price = await ctx.as("TELESALE").get(`/api/conversations/${conv.id}/canned/price`);
    expect(price.body.content).toContain("3.000.000đ");
    expect(price.body.content).not.toContain("2.000.000");

    vi.stubGlobal("fetch", vi.fn());
    const sent = await ctx.as("QUAN_LY_CO_SO").post(`/api/conversations/${conv.id}/canned/location`).send({});
    expect(sent.status).toBe(201);
    expect(sent.body.type).toBe("LOCATION");
  });
});
