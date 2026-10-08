/**
 * Bộ khung test dùng chung cho mọi lô (T3/S4/S5/S6/B17 và các lô sau).
 *
 * Cách dùng trong một tệp test:
 *
 *   import { setupTestContext, type TestContext } from "./helpers";
 *   let ctx: TestContext;
 *   beforeAll(async () => { ctx = await setupTestContext("tenfile"); });
 *
 *   const res = await ctx.as("MARKETING").get("/api/leads");      // gọi API bằng vai
 *   const c = await ctx.createCustomer({ name: "...", phone: "0912..." });
 *   const u = await ctx.createUser("BAC_SI");                      // thêm người dùng
 *
 * - CSDL test: data/test/test.db, migration áp một lần trong global-setup.ts.
 * - Mỗi tệp gọi setupTestContext(prefix) với prefix riêng: email, mã khách có
 *   tiền tố đó nên nhiều tệp dùng chung CSDL mà không đụng nhau.
 * - Token lấy thẳng bằng issueSession (không qua /login) để không ăn vào giới
 *   hạn đăng nhập của S6.
 */
import crypto from "node:crypto";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import bcrypt from "bcryptjs";
import type { Express } from "express";
import { createApp } from "../src/app";
import { bootstrap } from "../src/lib/bootstrap";
import { prisma } from "../src/lib/prisma";
import { issueSession } from "../src/lib/session";
import { RoleCode } from "../src/lib/rbac-catalog";

export const TEST_PASSWORD = "Test-password-123";

export type RoleName = keyof typeof RoleCode;

export interface TestUser {
  id: string;
  email: string;
  role: RoleName;
  token: string;
}

export interface TestContext {
  app: Express;
  prefix: string;
  branchId: string;
  users: Record<string, TestUser>;
  /** supertest với header Authorization của vai đó (tạo người dùng nếu chưa có). */
  as(role: RoleName | TestUser): AuthedAgent;
  createUser(role: RoleName, opts?: { key?: string; mustChangePassword?: boolean; password?: string }): Promise<TestUser>;
  createCustomer(data: { name: string; phone?: string | null; assignedToId?: string | null }): Promise<{ id: string; code: string }>;
  /** Tạo một vai trò tuỳ biến với danh sách quyền, dùng để thử tổ hợp quyền hiếm. */
  createRoleUser(grants: Array<{ code: string; scope: "ALL" | "BRANCH" | "OWN" }>): Promise<TestUser>;
}

type Method = "get" | "post" | "patch" | "put" | "delete";
export type AuthedAgent = Record<Method, (url: string) => request.Test>;

/**
 * supertest qua UNIX SOCKET riêng của từng app (dùng lại cho mọi request cùng app).
 *
 * KHÔNG dùng `request(app)` trực tiếp. supertest khi đó mở máy chủ TCP cổng
 * ngẫu nhiên rồi gọi 127.0.0.1:cổng. Trên máy phát triển có sẵn nhiều tiến
 * trình nghe cổng cao (chuyển tiếp cổng của máy ảo, trình duyệt...), và macOS
 * cho hai socket cùng cổng khác kiểu bind cùng tồn tại (SO_REUSEADDR), nên thỉnh
 * thoảng request rơi sang tiến trình khác và nhận 404. Đó là nguyên nhân test
 * chập chờn "expected 404 to be 200/409" (khoảng 1 trong 5 lần chạy). Gắn cả vào
 * 127.0.0.1 vẫn còn gặp, nên dùng unix socket: không có cổng nào để tranh.
 */
const servers = new WeakMap<Express, string>();
let socketSeq = 0;
const socketFiles: string[] = [];
process.once("exit", () => {
  for (const f of socketFiles) fs.rmSync(f, { force: true });
});

export function api(app: Express): ReturnType<typeof request> {
  let url = servers.get(app);
  if (!url) {
    const file = path.join(os.tmpdir(), `lv-${process.pid}-${++socketSeq}.sock`);
    fs.rmSync(file, { force: true });
    // Unix socket không có địa chỉ IP: gán 127.0.0.1 để req.ip, giới hạn đăng
    // nhập theo IP (S6) và nhật ký kiểm toán chạy như qua mạng thật.
    const server = http.createServer((req, res) => {
      Object.defineProperty(req.socket, "remoteAddress", { value: "127.0.0.1", configurable: true });
      app(req, res);
    });
    server.listen(file);
    server.unref();
    socketFiles.push(file);
    url = `http+unix://${encodeURIComponent(file)}`;
    servers.set(app, url);
  }
  return request(url);
}

let bootstrapped = false;
let counter = 0;

export async function ensureBootstrapped(): Promise<void> {
  if (bootstrapped) return;
  await bootstrap({ skipMigrate: true, exitOnError: false });
  bootstrapped = true;
}

export async function setupTestContext(prefix: string): Promise<TestContext> {
  await ensureBootstrapped();
  const app = createApp();
  const branch = await prisma.branch.findFirstOrThrow({ orderBy: { createdAt: "asc" } });
  const users: Record<string, TestUser> = {};
  const passwordHash = await bcrypt.hash(TEST_PASSWORD, 4);

  async function createUser(
    role: RoleName,
    opts: { key?: string; mustChangePassword?: boolean; password?: string } = {}
  ): Promise<TestUser> {
    const key = opts.key ?? role;
    const email = `${prefix}.${key.toLowerCase()}.${++counter}@test.local`.replace(/_/g, "-");
    const roleRow = await prisma.role.findUniqueOrThrow({ where: { code: RoleCode[role] } });
    const user = await prisma.user.create({
      data: {
        email,
        name: `${prefix} ${key}`,
        passwordHash: opts.password ? await bcrypt.hash(opts.password, 4) : passwordHash,
        mustChangePassword: opts.mustChangePassword ?? false,
        roleLinks: { create: { roleId: roleRow.id } },
        branches: { create: { branchId: branch.id, isPrimary: true } },
      },
    });
    const session = await issueSession(user.id);
    const tu: TestUser = { id: user.id, email, role, token: session.accessToken };
    if (!opts.key || opts.key === role) users[role] ??= tu;
    users[key] = tu;
    return tu;
  }

  async function createRoleUser(grants: Array<{ code: string; scope: "ALL" | "BRANCH" | "OWN" }>) {
    const code = `${prefix}_ROLE_${++counter}`.toUpperCase();
    const role = await prisma.role.create({ data: { code, name: code, isSystem: false } });
    for (const g of grants) {
      const perm = await prisma.permission.findUniqueOrThrow({ where: { code: g.code } });
      await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: perm.id, scope: g.scope } });
    }
    const email = `${prefix}.custom.${counter}@test.local`;
    const user = await prisma.user.create({
      data: {
        email,
        name: `${prefix} custom`,
        passwordHash,
        roleLinks: { create: { roleId: role.id } },
        branches: { create: { branchId: branch.id, isPrimary: true } },
      },
    });
    const session = await issueSession(user.id);
    return { id: user.id, email, role: "MARKETING" as RoleName, token: session.accessToken };
  }

  function agentFor(user: TestUser): AuthedAgent {
    const make = (m: Method) => (url: string) =>
      api(app)[m](url).set("Authorization", `Bearer ${user.token}`);
    return { get: make("get"), post: make("post"), patch: make("patch"), put: make("put"), delete: make("delete") };
  }

  const ctx: TestContext = {
    app,
    prefix,
    branchId: branch.id,
    users,
    as(role) {
      if (typeof role !== "string") return agentFor(role);
      const existing = users[role];
      if (existing) return agentFor(existing);
      throw new Error(`Chưa tạo người dùng vai ${role}: gọi await ctx.createUser("${role}") trong beforeAll`);
    },
    createUser,
    createRoleUser,
    async createCustomer(data) {
      const code = `KH-${prefix.toUpperCase().slice(0, 6)}-${String(++counter).padStart(5, "0")}`;
      const c = await prisma.customer.create({
        data: {
          code,
          name: data.name,
          phone: data.phone ?? null,
          assignedToId: data.assignedToId ?? null,
          branchLinks: { create: { branchId: branch.id, isPrimary: true } },
        },
      });
      return { id: c.id, code: c.code };
    },
  };
  return ctx;
}

/** Một số điện thoại di động hợp lệ dạng 09xxxxxxxx, ngẫu nhiên (gần như không thể trùng). */
export function uniquePhone(): string {
  return `09${String(crypto.randomInt(0, 100_000_000)).padStart(8, "0")}`;
}

export { prisma };
