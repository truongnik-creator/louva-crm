import { describe, it, expect, beforeAll } from "vitest";
import { ZodError } from "zod";
import { parsePagination, MAX_OFFSET } from "../src/lib/pagination";
import { stripInternalKeys } from "../src/middleware/strip-internal";
import { formatDateTimeVN, startOfVnDay, vnDayKey } from "../src/lib/datetime";
import { setupTestContext, type TestContext } from "./helpers";

describe("parsePagination (T3)", () => {
  it("mặc định và kẹp trần", () => {
    expect(parsePagination({}, { defaultLimit: 50, maxLimit: 200 })).toMatchObject({ take: 50, skip: 0 });
    expect(parsePagination({ limit: "9999" }, { maxLimit: 200 }).take).toBe(200);
    expect(parsePagination({ limit: "20", offset: "40" })).toMatchObject({ take: 20, skip: 40, offset: 40 });
    expect(parsePagination({ skip: "5" }).skip).toBe(5);
  });

  it("cursor dùng skip 1", () => {
    expect(parsePagination({ cursor: "abc", limit: "10" })).toMatchObject({ take: 10, skip: 1, cursor: { id: "abc" } });
  });

  it.each([{ limit: "abc" }, { limit: "-1" }, { limit: "0" }, { limit: "1.5" }, { offset: "-3" }, { offset: String(MAX_OFFSET + 1) }])(
    "từ chối %o",
    (q) => {
      expect(() => parsePagination(q)).toThrow(ZodError);
    }
  );
});

describe("Phân trang trên API (T3)", () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await setupTestContext("paging");
    await ctx.createUser("QUAN_LY_CO_SO");
    for (let i = 0; i < 5; i++) await ctx.createCustomer({ name: `Khách phân trang ${i}` });
  });

  it("danh sách khách trả total, nextOffset và đúng số dòng", async () => {
    const page1 = await ctx.as("QUAN_LY_CO_SO").get("/api/customers").query({ q: "Khách phân trang", limit: 2 });
    expect(page1.status).toBe(200);
    expect(page1.body.items).toHaveLength(2);
    expect(page1.body.total).toBe(5);
    expect(page1.body.nextOffset).toBe(2);

    const page3 = await ctx.as("QUAN_LY_CO_SO").get("/api/customers").query({ q: "Khách phân trang", limit: 2, offset: 4 });
    expect(page3.body.items).toHaveLength(1);
    expect(page3.body.nextOffset).toBeNull();

    const ids = new Set([...page1.body.items, ...page3.body.items].map((c: { id: string }) => c.id));
    expect(ids.size).toBe(3);
  });

  it.each([
    "/api/customers?limit=abc",
    "/api/customers?offset=-1",
    `/api/customers?offset=${MAX_OFFSET + 1}`,
    "/api/leads?limit=0",
    "/api/org/branches?limit=xyz",
    "/api/reception/appointments?limit=-5",
    "/api/users?offset=abc",
  ])("%s -> 400", async (url) => {
    const res = await ctx.as("QUAN_LY_CO_SO").get(url);
    expect(res.status).toBe(400);
  });

  it("list trước đây không có take nay nhận limit", async () => {
    const res = await ctx.as("QUAN_LY_CO_SO").get("/api/customers/tags/all").query({ limit: 1 });
    expect(res.status).toBe(200);
    expect(res.body.length).toBeLessThanOrEqual(1);
  });
});

describe("Tiện ích nền", () => {
  it("stripInternalKeys gỡ cột chuẩn hoá ở mọi độ sâu, giữ Date", () => {
    const d = new Date();
    const out = stripInternalKeys({ a: 1, phoneNormalized: "09", list: [{ nameNormalized: "x", at: d }] }) as {
      list: Array<{ at: Date }>;
    };
    expect(out).toEqual({ a: 1, list: [{ at: d }] });
  });

  it("định dạng giờ theo Asia/Ho_Chi_Minh bất kể múi giờ máy chủ", () => {
    const d = new Date("2026-09-30T02:30:00Z"); // 09:30 giờ Việt Nam
    expect(formatDateTimeVN(d)).toContain("09:30");
    expect(vnDayKey(new Date("2026-09-30T18:00:00Z"))).toBe("2026-10-01");
    expect(startOfVnDay(new Date("2026-09-30T18:00:00Z")).toISOString()).toBe("2026-09-30T17:00:00.000Z");
  });
});
