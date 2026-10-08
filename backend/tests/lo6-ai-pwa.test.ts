import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { describe, it, expect, beforeAll, afterEach, afterAll } from "vitest";
import { setupTestContext, uniquePhone, prisma, api, type TestContext, type TestUser } from "./helpers";
import { setAiClientForTests, AI_MODELS, type AiClient, type AiRequest } from "../src/lib/ai";
import { invalidateSettingsCache } from "../src/lib/settings-catalog";
import { draftReengagements } from "../src/lib/reengage";
import { processBroadcastQueue } from "../src/lib/broadcast";
import { briefingPrompt, collectBriefingMetrics, runMorningBriefing, vnHour } from "../src/lib/briefing";

// Lô 6: AI5 nháp tin chăm lại vào hàng chờ duyệt (không tự gửi), AI6 bản tin sáng
// không có thông tin cá nhân khách, F28 PWA (manifest, service worker không lưu /api).

const DAY = 86_400_000;
const uid = () => crypto.randomBytes(4).toString("hex");

let ctx: TestContext;
let sale: TestUser;
let otherSale: TestUser;
let manager: TestUser;
let director: TestUser;

function mockAi(reply: string) {
  const calls: AiRequest[] = [];
  const client: AiClient = {
    async complete(req) {
      calls.push(req);
      return { text: reply, model: req.model };
    },
  };
  setAiClientForTests(client);
  return calls;
}

const promptText = (r: AiRequest) =>
  [typeof r.system === "string" ? r.system : (r.system ?? []).map((b) => b.text).join("\n"), ...r.messages.map((m) => m.content)].join("\n");

async function setSetting(key: string, value: string) {
  await prisma.systemSetting.upsert({ where: { key }, create: { key, value }, update: { value } });
  invalidateSettingsCache();
}

beforeAll(async () => {
  ctx = await setupTestContext("lo6ai");
  sale = await ctx.createUser("TELESALE");
  otherSale = await ctx.createUser("TELESALE", { key: "SALE2" });
  manager = await ctx.createUser("QUAN_LY_CO_SO");
  director = await ctx.createUser("GIAM_DOC");
  await setSetting("ai.reengageDailyLimit", "500");
});

afterEach(() => setAiClientForTests(undefined));
afterAll(() => setAiClientForTests(undefined));

describe("AI5: nháp tin chăm lại khách im lặng", () => {
  it("chỉ soạn cho khách im lặng đã đồng ý dữ liệu, không từ chối nhận tin; nháp vào hàng chờ, không gửi; không gửi tên, SĐT lên AI", async () => {
    const now = new Date();
    const old = new Date(now.getTime() - 60 * DAY);
    const mk = async (name: string, data: { aiDataConsent?: boolean; optOut?: boolean; lastContactAt?: Date }) => {
      const phone = uniquePhone();
      const c = await ctx.createCustomer({ name, phone, assignedToId: sale.id });
      await prisma.customer.update({ where: { id: c.id }, data: { createdAt: old, lastContactAt: data.lastContactAt ?? old, aiDataConsent: data.aiDataConsent ?? false, optOut: data.optOut ?? false } });
      const conv = await prisma.conversation.create({
        data: { branchId: ctx.branchId, customerId: c.id, kind: "CUSTOMER", title: name, externalId: `l6-${uid()}` },
      });
      await prisma.chatMessage.create({ data: { conversationId: conv.id, direction: "IN", content: `Em là ${name}, số ${phone}, hỏi giá filler`, createdAt: old } });
      return { ...c, phone, name, conv };
    };
    const ok = await mk(`Lê Thị Im Lặng ${uid()}`, { aiDataConsent: true });
    const noConsent = await mk(`Khách Chưa Đồng Ý ${uid()}`, {});
    const optedOut = await mk(`Khách Từ Chối ${uid()}`, { aiDataConsent: true, optOut: true });
    const active = await mk(`Khách Mới Nhắn ${uid()}`, { aiDataConsent: true, lastContactAt: now });

    const calls = mockAi("Chào {{ten_khach}}, lâu rồi em chưa nghe tin mình. Mình có muốn ghé {{co_so}} để bác sĩ xem lại không ạ?");
    const r = await draftReengagements(now);
    expect(r.created).toBeGreaterThanOrEqual(1);

    const drafts = await prisma.reengageDraft.findMany({ where: { customerId: { in: [ok.id, noConsent.id, optedOut.id, active.id] } } });
    expect(drafts.map((d) => d.customerId)).toEqual([ok.id]);
    expect(drafts[0]).toMatchObject({ status: "PENDING", ownerId: sale.id, conversationId: ok.conv.id });

    // Không gửi gì cho khách: không tin OUT, không vào hàng đợi.
    expect(await prisma.chatMessage.count({ where: { conversationId: ok.conv.id, direction: "OUT" } })).toBe(0);
    expect(await prisma.broadcastRecipient.count({ where: { customerId: ok.id } })).toBe(0);

    // Lời gửi AI dùng model rẻ, không có tên, SĐT khách (kể cả tên, số khách tự gõ trong chat).
    const call = calls.find((c) => promptText(c).includes("Khách im lặng"));
    expect(call?.model).toBe(AI_MODELS.CHEAP);
    for (const c of calls) {
      const t = promptText(c);
      expect(t).not.toContain(ok.name);
      expect(t).not.toContain(ok.phone);
      expect(t).not.toMatch(/(^|\D)0\d{9}(\D|$)/);
      expect(t).not.toContain(noConsent.name);
      expect(t).not.toContain(noConsent.phone);
      expect(t).not.toContain(optedOut.phone);
    }
    // Chạy lại trong thời gian chờ: không soạn trùng.
    await draftReengagements(now);
    expect(await prisma.reengageDraft.count({ where: { customerId: ok.id } })).toBe(1);
  });

  it("sale phụ trách duyệt (có sửa) thì vào hàng đợi F11; sale khác không thấy; hàng đợi tôn trọng khách từ chối nhận tin", async () => {
    const c = await ctx.createCustomer({ name: `Khách Duyệt ${uid()}`, phone: uniquePhone(), assignedToId: sale.id });
    const d = await prisma.reengageDraft.create({ data: { customerId: c.id, ownerId: sale.id, branchId: ctx.branchId, dayKey: "2026-10-01", content: "Chào {{ten_khach}} ạ" } });

    const mine = await ctx.as(sale).get("/api/reengage/drafts");
    expect(mine.status).toBe(200);
    expect(mine.body.items.some((x: { id: string }) => x.id === d.id)).toBe(true);
    const others = await ctx.as(otherSale).get("/api/reengage/drafts");
    expect(others.body.items.some((x: { id: string }) => x.id === d.id)).toBe(false);
    expect((await ctx.as(otherSale).post(`/api/reengage/drafts/${d.id}/approve`).send({})).status).toBe(404);

    // Biến lạ bị chặn.
    expect((await ctx.as(sale).post(`/api/reengage/drafts/${d.id}/approve`).send({ content: "Chào {{ten_sai}}" })).status).toBe(400);

    const ap = await ctx.as(sale).post(`/api/reengage/drafts/${d.id}/approve`).send({ content: "Chào {{ten_khach}}, em nhắn hỏi thăm mình ạ" });
    expect(ap.status).toBe(200);
    expect(ap.body.recipientStatus).toBe("PENDING");
    const row = await prisma.reengageDraft.findUniqueOrThrow({ where: { id: d.id } });
    expect(row).toMatchObject({ status: "QUEUED", edited: true, reviewedById: sale.id, broadcastId: ap.body.broadcastId });
    const b = await prisma.broadcast.findUniqueOrThrow({ where: { id: ap.body.broadcastId }, include: { recipients: true } });
    expect(b.template).toBe("Chào {{ten_khach}}, em nhắn hỏi thăm mình ạ");
    expect(b.recipients.map((x) => x.customerId)).toEqual([c.id]);
    expect((await ctx.as(sale).post(`/api/reengage/drafts/${d.id}/approve`).send({})).status).toBe(409);

    // Khách từ chối nhận tin trước lượt gửi: hàng đợi bỏ qua, không gửi.
    await prisma.customer.update({ where: { id: c.id }, data: { optOut: true } });
    await processBroadcastQueue(new Date());
    const rec = await prisma.broadcastRecipient.findFirstOrThrow({ where: { broadcastId: b.id } });
    expect(rec.status).toBe("SKIPPED_OPT_OUT");
  });

  it("AI chưa cấu hình thì không soạn gì", async () => {
    setAiClientForTests(null);
    const r = await draftReengagements(new Date());
    expect(r.created).toBe(0);
    expect(r.message).toContain("chưa cấu hình");
  });
});

describe("AI6: bản tin sáng cho quản lý", () => {
  // Ngày giả xa trong tương lai để không đụng bản tin khác.
  const at = (d: string) => new Date(`${d}T00:30:00Z`); // 07:30 giờ VN

  it("chưa tới giờ thì bỏ qua; tới giờ thì tạo bản AI, lời gửi AI không có tên, SĐT khách; báo giám đốc; hiện ở trang chủ", async () => {
    const name = `Trần Thị Riêng Tư ${uid()}`;
    const phone = uniquePhone();
    const c = await ctx.createCustomer({ name, phone, assignedToId: sale.id });
    const day = "2031-01-10";
    const yesterday = new Date(at(day).getTime() - DAY);
    await prisma.visit.create({ data: { branchId: ctx.branchId, customerId: c.id, queueNumber: 7000 + Math.floor(Math.random() * 1000), checkedInAt: yesterday, status: "DONE" } });
    await prisma.payment.create({ data: { code: `PT-L6-${uid()}`, branchId: ctx.branchId, customerId: c.id, amount: 4_500_000, paidAt: yesterday, method: "CASH" } });

    expect(vnHour(new Date("2031-01-09T23:00:00Z"))).toBe(6);
    const early = await runMorningBriefing(new Date("2031-01-09T23:00:00Z"));
    expect(early.created).toBe(0);

    const calls = mockAi("Hôm qua thu 4.500.000đ, 1 khách đến. Hôm nay cần xử lý việc quá hạn.");
    const r = await runMorningBriefing(at(day));
    expect(r.created).toBeGreaterThanOrEqual(1);
    expect(calls.length).toBeGreaterThanOrEqual(1);
    for (const call of calls) {
      expect(call.model).toBe(AI_MODELS.CHEAP);
      const t = promptText(call);
      expect(t).not.toContain(name);
      expect(t).not.toContain(phone);
      expect(t).not.toContain(c.code);
      expect(t).not.toMatch(/(^|\D)0\d{9}(\D|$)/);
    }
    const all = await prisma.managerBriefing.findUniqueOrThrow({ where: { dayKey_scopeKey: { dayKey: day, scopeKey: "ALL" } } });
    expect(all.source).toBe("AI");
    const metrics = JSON.parse(all.metricsJson);
    expect(metrics.collected).toBeGreaterThanOrEqual(4_500_000);
    expect(metrics.showups).toBeGreaterThanOrEqual(1);
    expect(all.metricsJson).not.toContain(name);

    const notif = await prisma.notification.findFirst({ where: { userId: director.id, title: { contains: "Bản tin sáng" } } });
    expect(notif?.body).toContain("4.500.000");

    // Chạy lại cùng ngày không tạo trùng.
    expect((await runMorningBriefing(at(day))).created).toBe(0);

    const home = await ctx.as(director).get("/api/home");
    expect(home.status).toBe(200);
    expect(home.body.sections.briefing.dayKey).toBe(day);
    expect(home.body.sections.briefing.content).toContain("4.500.000đ");
    const saleHome = await ctx.as(sale).get("/api/home");
    expect(saleHome.body.sections.briefing).toBeUndefined();
  });

  it("AI chưa cấu hình thì gửi bản số liệu thuần", async () => {
    setAiClientForTests(null);
    const day = "2031-02-11";
    await runMorningBriefing(at(day));
    const b = await prisma.managerBriefing.findUniqueOrThrow({ where: { dayKey_scopeKey: { dayKey: day, scopeKey: "ALL" } } });
    expect(b.source).toBe("FALLBACK");
    expect(b.content).toContain("Thực thu");
    expect(b.content).not.toContain("—");
  });

  it("số liệu gửi AI chỉ là con số tổng", async () => {
    const m = await collectBriefingMetrics({ now: at("2031-03-05"), branchIds: [ctx.branchId], scopeLabel: "thử" });
    const p = briefingPrompt(m);
    const parsed = JSON.parse(p.slice(p.indexOf("{")));
    const walk = (v: unknown): void => {
      if (v && typeof v === "object") Object.values(v).forEach(walk);
      else expect(["number", "string", "object"]).toContain(typeof v);
    };
    walk(parsed);
    expect(Object.keys(parsed).sort()).toEqual(
      ["appointmentsToday", "collected", "day", "depositBookings", "medicalFlags24h", "month", "newMessages", "noShows", "overdueTasks", "payments", "pendingDiscountApprovals", "pendingReengageDrafts", "phones", "scope", "showups"].sort()
    );
  });
});

describe("F28: PWA", () => {
  const webSrc = path.resolve(__dirname, "..", "..", "desktop", "src", "renderer", "public-web");

  it("manifest hợp lệ, có biểu tượng 192 và 512", () => {
    const m = JSON.parse(fs.readFileSync(path.join(webSrc, "manifest.webmanifest"), "utf8"));
    expect(m.display).toBe("standalone");
    expect(m.start_url).toBe("/");
    const sizes = m.icons.map((i: { sizes: string }) => i.sizes);
    expect(sizes).toContain("192x192");
    expect(sizes).toContain("512x512");
    for (const i of m.icons) expect(fs.existsSync(path.join(webSrc, i.src))).toBe(true);
  });

  it("service worker không bao giờ trả lời yêu cầu /api hay /socket.io (không lưu đệm dữ liệu)", async () => {
    const code = fs.readFileSync(path.join(webSrc, "sw.js"), "utf8");
    const listeners: Record<string, (e: unknown) => void> = {};
    const cachePuts: string[] = [];
    const sandbox = {
      self: {
        location: { origin: "https://crm.example.test" },
        addEventListener: (t: string, fn: (e: unknown) => void) => (listeners[t] = fn),
        skipWaiting: () => undefined,
        clients: { claim: () => undefined },
      },
      caches: {
        open: async () => ({ match: async () => undefined, put: async (req: { url: string }) => cachePuts.push(req.url), addAll: async () => undefined }),
        match: async () => undefined,
        keys: async () => [],
        delete: async () => true,
      },
      fetch: async () => ({ ok: true, type: "basic", clone: () => ({}) }),
      URL,
      Promise,
    };
    vm.runInNewContext(code, sandbox);
    const respond = (url: string, mode = "cors") => {
      let responded = false;
      listeners.fetch({ request: { url, method: "GET", mode }, respondWith: () => (responded = true) });
      return responded;
    };
    expect(respond("https://crm.example.test/api/customers")).toBe(false);
    expect(respond("https://crm.example.test/api/medical/photos/x/content")).toBe(false);
    expect(respond("https://crm.example.test/socket.io/?EIO=4")).toBe(false);
    expect(respond("https://other.example.test/app.js")).toBe(false);
    expect(respond("https://crm.example.test/assets/index-abc.js")).toBe(true);
    expect(respond("https://crm.example.test/", "navigate")).toBe(true);
    let posted = false;
    listeners.fetch({ request: { url: "https://crm.example.test/assets/x.js", method: "POST", mode: "cors" }, respondWith: () => (posted = true) });
    expect(posted).toBe(false);
    await new Promise((r) => setTimeout(r, 10));
    expect(cachePuts.every((u) => !u.includes("/api/"))).toBe(true);
  });

  it("bản web đã build (nếu có) phục vụ manifest và sw.js; index.html gắn manifest", async () => {
    const out = path.resolve(__dirname, "..", "..", "desktop", "out", "web");
    if (!fs.existsSync(path.join(out, "index.html"))) return; // chưa build web: bỏ qua phần này
    const m = await api(ctx.app).get("/manifest.webmanifest");
    expect(m.status).toBe(200);
    const sw = await api(ctx.app).get("/sw.js");
    expect(sw.status).toBe(200);
    expect(sw.headers["content-type"]).toContain("javascript");
    const html = fs.readFileSync(path.join(out, "index.html"), "utf8");
    expect(html).toContain('rel="manifest"');
  });
});
