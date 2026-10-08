import crypto from "node:crypto";
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { setupTestContext, prisma, type TestContext } from "./helpers";
import { encryptNullable } from "../src/lib/crypto";
import { syncConfigStats, pancakeDateRange, defaultStatsWindow } from "../src/services/pancake-stats";
import { runPancakeStatsSync } from "../src/lib/pancake-jobs";

// F35: HIỆU SUẤT NHÂN VIÊN TRÊN PANCAKE.
//
// Những điều test này giữ cho đúng:
//   · Kéo lại cùng một khoảng thời gian KHÔNG cộng dồn (mỗi 10 phút chạy một
//     lần, cùng một giờ sẽ được kéo lại hàng chục lần trong ngày).
//   · Trung bình tốc độ phản hồi tính CÓ TRỌNG SỐ theo số tin, và ô Pancake
//     trả 0 bị coi là KHÔNG ĐO ĐƯỢC chứ không phải "trả lời tức thì".
//   · Nhân viên Pancake tự gắn với tài khoản CRM khi tên khớp duy nhất.
//   · `date_range` gửi cho Pancake theo giờ Việt Nam, còn mốc `hour` nhận về
//     đọc là UTC.

const uid = () => crypto.randomBytes(4).toString("hex");
let ctx: TestContext;

beforeAll(async () => {
  ctx = await setupTestContext("f35pancake");
  await ctx.createUser("QUAN_LY_CO_SO");
  await ctx.createUser("TELESALE");
});

afterEach(() => vi.unstubAllGlobals());

/** Mốc giờ tròn của hiện tại, định dạng Pancake trả về: UTC, không có "Z". */
function utcHourStamp(offsetHours = 0): string {
  const d = new Date();
  d.setUTCMinutes(0, 0, 0);
  d.setUTCHours(d.getUTCHours() - offsetHours);
  return d.toISOString().slice(0, 19);
}

async function fixture() {
  const config = await prisma.pancakeConfig.create({
    data: {
      label: `Pancake F35 ${uid()}`,
      accessTokenEnc: encryptNullable("user-token")!,
      branchId: ctx.branchId,
      active: true,
    },
  });
  const fb = await prisma.pancakePage.create({
    data: {
      configId: config.id,
      pageId: `fb${uid()}`,
      name: "Trang Facebook",
      platform: "FACEBOOK",
      branchId: ctx.branchId,
      pageAccessTokenEnc: encryptNullable("pat-fb"),
    },
  });
  const tiktok = await prisma.pancakePage.create({
    data: {
      configId: config.id,
      pageId: `tt${uid()}`,
      name: "Trang TikTok",
      platform: "TIKTOK",
      branchId: ctx.branchId,
      pageAccessTokenEnc: encryptNullable("pat-tt"),
    },
  });
  return { config, fb, tiktok };
}

/**
 * Giả lập API thống kê: trả số liệu khác nhau theo trang để kiểm tra phần tách
 * theo nền tảng. Ghi lại URL để kiểm tra token và date_range.
 */
function stubStatistics(opts: {
  fbPageId: string;
  ttPageId: string;
  saleA: { uid: string; name: string };
  saleB: { uid: string; name: string };
}) {
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL) => {
      const u = String(url);
      urls.push(u);
      const forFb = u.includes(`/pages/${opts.fbPageId}/`);
      const statistics = forFb
        ? {
            [opts.saleA.uid]: [
              { hour: utcHourStamp(1), inbox_count: 6, comment_count: 0, unique_inbox_count: 3, average_response_time: 60_000, phone_number_count: 2 },
              { hour: utcHourStamp(0), inbox_count: 2, comment_count: 0, unique_inbox_count: 1, average_response_time: 120_000, phone_number_count: 1 },
            ],
          }
        : {
            [opts.saleB.uid]: [
              // Pancake không đo được tốc độ giờ này (trả 0) nhưng vẫn có tin.
              { hour: utcHourStamp(0), inbox_count: 4, comment_count: 0, unique_inbox_count: 2, average_response_time: 0 },
            ],
          };
      const users = forFb
        ? { [opts.saleA.uid]: { user_name: opts.saleA.name, inbox_count: 8 } }
        : { [opts.saleB.uid]: { user_name: opts.saleB.name, inbox_count: 4 } };
      return new Response(JSON.stringify({ success: true, data: { statistics, users } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    })
  );
  return urls;
}

describe("F35: kéo thống kê nhân viên Pancake", () => {
  it("date_range gửi theo giờ Việt Nam, đúng định dạng Pancake đòi", () => {
    const day = new Date("2026-10-08T05:00:00Z"); // 12:00 giờ VN
    expect(pancakeDateRange(day, day)).toBe("08/10/2026 00:00:00 - 08/10/2026 23:59:59");
    // Cửa sổ mặc định phủ cả hôm qua: chạy lúc 00h05 vẫn chốt được hôm qua.
    const w = defaultStatsWindow(day);
    expect(w.dateRange).toBe("07/10/2026 00:00:00 - 08/10/2026 23:59:59");
  });

  it("kéo số liệu, tự gắn nhân viên theo tên, và kéo lại KHÔNG cộng dồn", async () => {
    const { config, fb, tiktok } = await fixture();
    // Tài khoản CRM trùng tên nhân viên Pancake -> tự gắn.
    const crmUser = await prisma.user.findUniqueOrThrow({ where: { id: ctx.users.TELESALE.id } });
    const saleA = { uid: `pu-${uid()}`, name: crmUser.name };
    const saleB = { uid: `pu-${uid()}`, name: `Người lạ ${uid()}` };

    const urls = stubStatistics({ fbPageId: fb.pageId, ttPageId: tiktok.pageId, saleA, saleB });
    const first = await syncConfigStats(config.id);
    expect(first.errors).toEqual([]);
    expect(first.pages).toBe(2);
    expect(first.buckets).toBe(3);

    // Token trang đi bằng tham số URL, không dùng token người dùng.
    expect(urls.some((u) => u.includes("page_access_token=pat-fb"))).toBe(true);
    expect(urls.every((u) => !u.includes("user-token"))).toBe(true);
    expect(urls.every((u) => u.includes("/statistics/users"))).toBe(true);

    const agents = await prisma.pancakeAgent.findMany({ where: { configId: config.id } });
    expect(agents).toHaveLength(2);
    expect(agents.find((a) => a.pancakeUserId === saleA.uid)?.userId).toBe(crmUser.id);
    // Tên không khớp ai trong CRM thì để trống, chờ gắn tay.
    expect(agents.find((a) => a.pancakeUserId === saleB.uid)?.userId).toBeNull();

    const countAfterFirst = await prisma.pancakeAgentStat.count({ where: { pageId: { in: [fb.id, tiktok.id] } } });
    expect(countAfterFirst).toBe(3);
    const sumAfterFirst = await prisma.pancakeAgentStat.aggregate({
      where: { pageId: { in: [fb.id, tiktok.id] } },
      _sum: { inboxCount: true },
    });
    expect(sumAfterFirst._sum.inboxCount).toBe(12);

    // Lượt kéo thứ hai trên cùng khoảng thời gian: số phải GIỮ NGUYÊN.
    stubStatistics({ fbPageId: fb.pageId, ttPageId: tiktok.pageId, saleA, saleB });
    const second = await syncConfigStats(config.id);
    expect(second.errors).toEqual([]);
    // Không ô nào đổi giá trị nên không ghi lại gì.
    expect(second.buckets).toBe(0);
    expect(await prisma.pancakeAgentStat.count({ where: { pageId: { in: [fb.id, tiktok.id] } } })).toBe(3);
    const sumAfterSecond = await prisma.pancakeAgentStat.aggregate({
      where: { pageId: { in: [fb.id, tiktok.id] } },
      _sum: { inboxCount: true },
    });
    expect(sumAfterSecond._sum.inboxCount).toBe(12);

    // Pancake báo số mới cho cùng mốc giờ (giờ đang chạy): ghi ĐÈ, không cộng.
    vi.unstubAllGlobals();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) =>
        new Response(
          JSON.stringify({
            success: true,
            data: String(url).includes(`/pages/${fb.pageId}/`)
              ? {
                  statistics: {
                    [saleA.uid]: [
                      { hour: utcHourStamp(1), inbox_count: 6, comment_count: 0, unique_inbox_count: 3, average_response_time: 60_000, phone_number_count: 2 },
                      { hour: utcHourStamp(0), inbox_count: 5, comment_count: 0, unique_inbox_count: 2, average_response_time: 120_000, phone_number_count: 1 },
                    ],
                  },
                  users: { [saleA.uid]: { user_name: saleA.name } },
                }
              : { statistics: {}, users: {} },
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      )
    );
    const third = await syncConfigStats(config.id);
    expect(third.buckets).toBe(1);
    expect(await prisma.pancakeAgentStat.count({ where: { pageId: { in: [fb.id, tiktok.id] } } })).toBe(3);
    const sumAfterThird = await prisma.pancakeAgentStat.aggregate({
      where: { pageId: { in: [fb.id, tiktok.id] } },
      _sum: { inboxCount: true },
    });
    expect(sumAfterThird._sum.inboxCount).toBe(15); // 6 + 5 + 4
  });

  it("một trang lỗi thì các trang khác vẫn kéo được, lỗi báo rõ theo tên trang", async () => {
    const { config, fb } = await fixture();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        if (String(url).includes(`/pages/${fb.pageId}/`)) return new Response("sập", { status: 500 });
        return new Response(JSON.stringify({ success: true, data: { statistics: {}, users: {} } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      })
    );
    const r = await syncConfigStats(config.id);
    expect(r.pages).toBe(1);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toContain("Trang Facebook");
  });

  it("tác vụ nền chạy được khi chưa có kết nối nào và không ném lỗi", async () => {
    await prisma.pancakeConfig.updateMany({ data: { active: false } });
    const r = await runPancakeStatsSync(new Date());
    expect(r.created).toBe(0);
    expect(r.message).toContain("0 trang");
  });
});

describe("F35: báo cáo hiệu suất", () => {
  it("gom theo nhân viên và theo nền tảng, trung bình phản hồi có trọng số", async () => {
    // Tắt mọi trang của các test trước: báo cáo gom theo CƠ SỞ (không theo kết
    // nối), nên trang cũ còn bật sẽ cộng số liệu vào bảng theo nền tảng.
    await prisma.pancakeConfig.updateMany({ data: { active: false } });
    await prisma.pancakePage.updateMany({ data: { active: false } });
    const { config, fb, tiktok } = await fixture();
    const crmUser = await prisma.user.findUniqueOrThrow({ where: { id: ctx.users.TELESALE.id } });
    const saleA = { uid: `pu-${uid()}`, name: crmUser.name };
    const saleB = { uid: `pu-${uid()}`, name: `Người lạ ${uid()}` };
    stubStatistics({ fbPageId: fb.pageId, ttPageId: tiktok.pageId, saleA, saleB });
    await syncConfigStats(config.id);

    const res = await ctx.as("QUAN_LY_CO_SO").get("/api/reports/pancake-agents?period=today");
    expect(res.status).toBe(200);

    const mine = res.body.agents.find((a: { pancakeUserId: string }) => a.pancakeUserId === saleA.uid);
    expect(mine.messages).toBe(8);
    expect(mine.userId).toBe(crmUser.id);
    expect(mine.userName).toBe(crmUser.name);
    // (60.000ms × 6 tin + 120.000ms × 2 tin) ÷ 8 tin = 75.000ms = 75 giây.
    expect(mine.avgResponseSeconds).toBe(75);
    expect(mine.phones).toBe(3);

    const other = res.body.agents.find((a: { pancakeUserId: string }) => a.pancakeUserId === saleB.uid);
    expect(other.messages).toBe(4);
    // Pancake trả 0 = không đo được, KHÔNG phải trả lời trong 0 giây.
    expect(other.avgResponseSeconds).toBeNull();
    expect(other.userId).toBeNull();
    expect(res.body.unmappedAgents).toBeGreaterThanOrEqual(1);

    const fbRow = res.body.platforms.find((p: { key: string }) => p.key === "FACEBOOK");
    const ttRow = res.body.platforms.find((p: { key: string }) => p.key === "TIKTOK");
    expect(fbRow.messages).toBe(8);
    expect(ttRow.messages).toBe(4);
    expect(ttRow.avgResponseSeconds).toBeNull();

    expect(res.body.totals.messages).toBe(12);
    // Tổng chỉ tính trung bình trên các ô đo được -> vẫn là 75 giây.
    expect(res.body.totals.avgResponseSeconds).toBe(75);
    expect(res.body.pages).toHaveLength(2);
    expect(res.body.lastSyncAt).toBeTruthy();
  });

  it("vai không có quyền xem số người khác bị chặn", async () => {
    const res = await ctx.as("TELESALE").get("/api/reports/pancake-agents?period=today");
    expect(res.status).toBe(403);
  });
});
