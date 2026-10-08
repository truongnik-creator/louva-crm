import { describe, it, expect, beforeAll } from "vitest";
import { createApp } from "../src/app";
import { setupTestContext, TEST_PASSWORD, prisma, api, type TestContext } from "./helpers";

// S6: giới hạn đăng nhập sai theo IP (express-rate-limit) và khoá tạm tài khoản.
// vitest.config.ts đặt LOGIN_RATE_LIMIT_MAX=8; khoá tài khoản mặc định sau 5 lần.

describe("Khoá tạm tài khoản sau nhiều lần sai (S6)", () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await setupTestContext("lockout");
  });

  it("đăng nhập đúng trả token và đưa bộ đếm về 0", async () => {
    const u = await ctx.createUser("LE_TAN", { key: "ok" });
    const app = createApp();
    await api(app).post("/api/auth/login").send({ email: u.email, password: "sai-mat-khau" }).expect(401);
    let row = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
    expect(row.failedLoginCount).toBe(1);

    const ok = await api(app).post("/api/auth/login").send({ email: u.email, password: TEST_PASSWORD });
    expect(ok.status).toBe(200);
    expect(ok.body.accessToken).toBeTruthy();
    row = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
    expect(row.failedLoginCount).toBe(0);
  });

  it("sai 5 lần thì khoá, nhập đúng cũng bị từ chối 423 và có audit", async () => {
    const u = await ctx.createUser("LE_TAN", { key: "victim" });
    const app = createApp();
    for (let i = 0; i < 5; i++) {
      const r = await api(app).post("/api/auth/login").send({ email: u.email, password: `sai-${i}` });
      expect(r.status, `lần sai thứ ${i + 1}: ${JSON.stringify(r.body)}`).toBe(401);
    }
    const row = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
    expect(row.lockedUntil).not.toBeNull();
    expect(row.lockedUntil!.getTime()).toBeGreaterThan(Date.now());

    const locked = await api(app).post("/api/auth/login").send({ email: u.email, password: TEST_PASSWORD });
    expect(locked.status, JSON.stringify(locked.body)).toBe(423);
    expect(locked.body.error).toMatch(/tạm khoá/);

    const audit = await prisma.auditLog.findFirst({ where: { action: "ACCOUNT_LOCKED", entityId: u.id } });
    expect(audit).not.toBeNull();
  });

  it("hết thời gian khoá thì đăng nhập lại được", async () => {
    const u = await ctx.createUser("LE_TAN", { key: "expired" });
    await prisma.user.update({ where: { id: u.id }, data: { lockedUntil: new Date(Date.now() - 1000) } });
    const res = await api(createApp()).post("/api/auth/login").send({ email: u.email, password: TEST_PASSWORD });
    expect(res.status).toBe(200);
  });
});

describe("Giới hạn tần suất /api/auth/login theo IP (S6)", () => {
  it("quá LOGIN_RATE_LIMIT_MAX lượt sai thì trả 429", async () => {
    const app = createApp(); // bộ đếm riêng cho app này
    const max = Number(process.env.LOGIN_RATE_LIMIT_MAX);
    for (let i = 0; i < max; i++) {
      const r = await api(app).post("/api/auth/login").send({ email: `khong-ton-tai-${i}@test.local`, password: "x" });
      expect(r.status).toBe(401);
    }
    const blocked = await api(app).post("/api/auth/login").send({ email: "khong-ton-tai@test.local", password: "x" });
    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toMatch(/quá nhiều lần/);
  });

  it("mỗi phản hồi có X-Request-Id (log có cấu trúc, T5)", async () => {
    const res = await api(createApp()).get("/health");
    expect(res.headers["x-request-id"]).toBeTruthy();
    const echoed = await api(createApp()).get("/health").set("X-Request-Id", "yeu-cau-123");
    expect(echoed.headers["x-request-id"]).toBe("yeu-cau-123");
  });
});
