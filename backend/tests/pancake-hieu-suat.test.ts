import crypto from "node:crypto";
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { setupTestContext, prisma, type TestContext } from "./helpers";
import { encryptNullable } from "../src/lib/crypto";
import { vnDayKey } from "../src/lib/datetime";
import { syncConfigStats, pancakeDateRange, defaultStatsWindow, backfillWindows } from "../src/services/pancake-stats";
import { syncPancakeConfig } from "../src/services/pancake-sync";
import { relinkAgentMessages } from "../src/services/pancake-stats";
import {
  attachmentLabel,
  classifyAttachments,
  conversationPhone,
  extractAdSource,
  fetchMessages,
  fetchPages,
  isFromCustomer,
  messageText,
  normalizePlatform,
  pageTokenOf,
  parsePancakeTime,
  parseStatHour,
} from "../src/services/pancake";
import { runPancakeStatsSync, runPancakePullSync } from "../src/lib/pancake-jobs";
import { buildPancakeAgentReport } from "../src/lib/pancake-report";
import { discoverPagesAndAgents } from "../src/services/pancake-stats";
import { startOfVnDay } from "../src/lib/datetime";

// F35: HIỆU SUẤT NHÂN VIÊN TRÊN PANCAKE.
//
// Những điều test này giữ cho đúng:
//   · Kéo lại cùng một khoảng thời gian KHÔNG cộng dồn (mỗi 10 phút chạy một
//     lần, cùng một giờ sẽ được kéo lại hàng chục lần trong ngày).
//   · Trung bình tốc độ phản hồi tính CÓ TRỌNG SỐ theo số tin, và ô Pancake
//     trả 0 bị coi là KHÔNG ĐO ĐƯỢC chứ không phải "trả lời tức thì".
//   · Nhân viên Pancake tự gắn với tài khoản CRM khi tên khớp duy nhất.
//   · `date_range` gửi cho Pancake theo giờ Việt Nam; mốc giờ nhận về đọc từ
//     `hour_in_integer` (UTC), KHÔNG đọc `hour` (giờ địa phương của trang).
//   · `average_response_time` là GIÂY.
//
// Hình dạng phản hồi trong các stub dưới đây lấy đúng từ tài khoản thật
// (08/10/2026): có `hour_in_integer`, `page_id`, `order_count`, và `hour` lệch
// đúng 7 giờ so với `hour_in_integer`.

const uid = () => crypto.randomBytes(4).toString("hex");
let ctx: TestContext;

beforeAll(async () => {
  ctx = await setupTestContext("f35pancake");
  await ctx.createUser("QUAN_LY_CO_SO");
  await ctx.createUser("TELESALE");
});

afterEach(() => vi.unstubAllGlobals());

/** Mốc giờ tròn, UTC. */
function utcHour(offsetHours = 0): Date {
  const d = new Date();
  d.setUTCMinutes(0, 0, 0);
  d.setUTCHours(d.getUTCHours() - offsetHours);
  return d;
}

/**
 * Hai trường mốc giờ ĐÚNG NHƯ PANCAKE TRẢ: `hour` là giờ địa phương của trang
 * (UTC+7), `hour_in_integer` là UTC. Test phải đọc ra cùng một mốc UTC dù hai
 * trường lệch nhau 7 tiếng.
 */
function hourFields(offsetHours = 0): { hour: string; hour_in_integer: string } {
  const utc = utcHour(offsetHours);
  const local = new Date(utc.getTime() + 7 * 3_600_000);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return {
    hour: local.toISOString().slice(0, 19),
    hour_in_integer: `${utc.getUTCFullYear()}${pad(utc.getUTCMonth() + 1)}${pad(utc.getUTCDate())}${pad(utc.getUTCHours())}0000`
  };
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
              { ...hourFields(1), page_id: opts.fbPageId, inbox_count: 6, comment_count: 0, unique_inbox_count: 3, order_count: 0, average_response_time: 60, phone_number_count: 2 },
              { ...hourFields(0), page_id: opts.fbPageId, inbox_count: 2, comment_count: 0, unique_inbox_count: 1, order_count: 0, average_response_time: 120, phone_number_count: 1 },
            ],
          }
        : {
            [opts.saleB.uid]: [
              // Pancake không đo được tốc độ giờ này (trả 0) nhưng vẫn có tin.
              { ...hourFields(0), page_id: opts.ttPageId, inbox_count: 4, comment_count: 0, unique_inbox_count: 2, order_count: 0, average_response_time: 0 },
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

  it("nạp lại lịch sử chia theo tuần, phủ đủ số ngày yêu cầu, mới nhất trước", () => {
    const now = new Date("2026-10-08T05:00:00Z"); // 12:00 giờ VN ngày 08/10
    const w = backfillWindows(now, 30);
    // 30 ngày chia theo tuần = 5 cửa sổ (7+7+7+7+2).
    expect(w).toHaveLength(5);
    expect(w[0].dateRange).toBe("02/10/2026 00:00:00 - 08/10/2026 23:59:59");
    expect(w[1].dateRange).toBe("25/09/2026 00:00:00 - 01/10/2026 23:59:59");
    // Cửa sổ cuối không được trườn quá 30 ngày.
    expect(w[4].dateRange).toBe("09/09/2026 00:00:00 - 10/09/2026 23:59:59");
    // Các cửa sổ liền kề nhau, không hở ngày nào và không trùng ngày nào.
    for (let i = 1; i < w.length; i++) {
      expect(w[i].to.getTime()).toBe(w[i - 1].from.getTime() - 86_400_000);
    }
    // Nạp 1 ngày vẫn ra một cửa sổ hợp lệ.
    expect(backfillWindows(now, 1)).toHaveLength(1);
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
                      { ...hourFields(1), inbox_count: 6, comment_count: 0, unique_inbox_count: 3, average_response_time: 60, phone_number_count: 2 },
                      { ...hourFields(0), inbox_count: 5, comment_count: 0, unique_inbox_count: 2, average_response_time: 120, phone_number_count: 1 },
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

  it("mốc giờ đọc từ hour_in_integer (UTC), không đọc hour (giờ trang)", async () => {
    await prisma.pancakeConfig.updateMany({ data: { active: false } });
    const { config, fb } = await fixture();
    const saleUid = `pu-${uid()}`;
    const want = utcHour(0);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) =>
        new Response(
          JSON.stringify({
            success: true,
            data: String(url).includes(`/pages/${fb.pageId}/`)
              ? {
                  statistics: { [saleUid]: [{ ...hourFields(0), inbox_count: 3, average_response_time: 90 }] },
                  users: { [saleUid]: { user_name: "Hằng Trần" } }
                }
              : { statistics: {}, users: {} }
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      )
    );
    await syncConfigStats(config.id);
    const row = await prisma.pancakeAgentStat.findFirstOrThrow({ where: { pageId: fb.id, pancakeUserId: saleUid } });
    // Nếu lỡ đọc `hour` thì mốc sẽ lệch 7 tiếng và dayKey có thể sang ngày khác.
    expect(row.hour.toISOString()).toBe(want.toISOString());
    expect(row.avgResponseSeconds).toBe(90);
    expect(row.dayKey).toBe(vnDayKey(want));
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
    // (60 giây × 6 tin + 120 giây × 2 tin) ÷ 8 tin = 75 giây.
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

/* Những khẳng định dưới đây chốt lại SÁU chỗ tài liệu Pancake nói khác API
 * thật. Dữ liệu mẫu copy nguyên dạng từ tài khoản thật ngày 08/10/2026 — nếu ai
 * đó "sửa cho giống tài liệu" thì các test này đổ ngay. */
describe("Pancake: đọc đúng hình dạng API THẬT (không theo tài liệu)", () => {
  it("1. GET /pages trả categorized.activated, kèm token trang và nhân viên", async () => {
    const body = {
      success: true,
      categorized: {
        hidden: [],
        inactivated: [{ id: "999", name: "Trang đã tắt", platform: "facebook" }],
        activated: [
          {
            id: "101778372233531",
            name: "Nova International Aesthetic",
            platform: "facebook",
            timezone: 7.0,
            settings: { page_access_token: "pat-that" },
            users: [
              { name: "Hằng Trần", status: "active", user_id: "b595e8b8", fb_id: "7757219" },
              { name: "Tạ Thu Hằng", status: "removed", user_id: "49d30b80", fb_id: "116057652372083" }
            ]
          }
        ]
      }
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }))
    );
    const pages = await fetchPages("user-token");
    // Bản cũ đọc `categorized_pages` nên ở đây sẽ ra 0 trang và cả tính năng chết lặng.
    expect(pages).toHaveLength(1);
    expect(pages[0].name).toBe("Nova International Aesthetic");

    // 2. Token trang nằm sẵn trong phản hồi -> không cần sinh token mới.
    expect(pageTokenOf(pages[0])).toBe("pat-that");
    expect(pages[0].users).toHaveLength(2);
    // Nền tảng trả chữ thường.
    expect(normalizePlatform(pages[0].platform)).toBe("FACEBOOK");
  });

  it("3 + 4. average_response_time là giây; mốc giờ lấy từ hour_in_integer (UTC)", () => {
    const bucket = { hour: "2026-10-07T08:00:00", hour_in_integer: "20261007010000", average_response_time: 150 };
    // hour nói 08:00, hour_in_integer nói 01:00 UTC — đúng là 01:00 UTC.
    expect(parseStatHour(bucket)?.toISOString()).toBe("2026-10-07T01:00:00.000Z");
    // Thiếu hour_in_integer thì mới suy từ hour, trừ lệch giờ của trang.
    expect(parseStatHour({ hour: "2026-10-07T08:00:00" }, 7)?.toISOString()).toBe("2026-10-07T01:00:00.000Z");
    expect(parseStatHour({})).toBeNull();
  });

  it("5. GET messages: xếp lại theo thời gian, không tin vào thứ tự Pancake trả", async () => {
    // Tài khoản thật trả CŨ TRƯỚC; tài liệu nói MỚI TRƯỚC. Trộn lộn xộn để chắc.
    const raw = {
      success: true,
      conv_from: { id: "29622954850640757", name: "Huỳnh Ngân" },
      messages: [
        { id: "m3", inserted_at: "2026-10-08T08:09:37.000000", original_message: "ba", from: { id: "29622954850640757" } },
        { id: "m1", inserted_at: "2026-10-08T08:09:32.000000", original_message: "mot", from: { id: "355628047872664" } },
        { id: "m2", inserted_at: "2026-10-08T08:09:36.000000", original_message: "hai", from: { id: "355628047872664" } }
      ]
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(raw), { status: 200, headers: { "content-type": "application/json" } }))
    );
    const r = await fetchMessages("pat", "355628047872664", "355628047872664_29622954850640757");
    expect(r.messages.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
    expect(r.convFromId).toBe("29622954850640757");

    // Không có from_customer: suy ra từ from.id so với page_id và conv_from.id.
    const ctx = { pageId: "355628047872664", convFromId: "29622954850640757" };
    expect(isFromCustomer(r.messages[0], ctx)).toBe(false); // trang gửi
    expect(isFromCustomer(r.messages[2], ctx)).toBe(true); // khách gửi
    // inserted_at không có hậu tố múi giờ nhưng LÀ UTC.
    expect(parsePancakeTime(r.messages[0].inserted_at).toISOString()).toBe("2026-10-08T08:09:32.000Z");
  });

  it("6. nội dung tin lấy original_message; thiếu thì bóc thẻ khỏi message HTML", () => {
    expect(
      messageText({
        id: "m",
        message: "<div>Dạ em chào chị\r<br key='n_0' />Chị muốn cải thiện vùng nào ạ?</div>",
        original_message: "Dạ em chào chị\r\nChị muốn cải thiện vùng nào ạ?"
      })
    ).toBe("Dạ em chào chị\r\nChị muốn cải thiện vùng nào ạ?");

    // Không có bản sạch: phải ra văn bản, tuyệt đối không để lọt "<div>" cho khách thấy.
    const stripped = messageText({ id: "m", message: "<div>Chi phí&nbsp;Full Face <br/>là bao nhiêu?</div>" });
    expect(stripped).toBe("Chi phí Full Face \nlà bao nhiêu?");
    expect(stripped).not.toContain("<");

    // Tin chỉ có ảnh: Pancake trả "<div></div>" -> coi như không có chữ.
    expect(messageText({ id: "m", message: "<div></div>" })).toBeNull();
  });

  it("SĐT và nguồn quảng cáo của hội thoại lấy đúng chỗ API thật để", () => {
    const conv = {
      id: "355628047872664_29622954850640757",
      type: "INBOX",
      from: { id: "29622954850640757", name: "Huỳnh Ngân" },
      seen: false,
      recent_phone_numbers: [{ captured: "0862356173", phone_number: "0862356173" }],
      ads: [{ ad_id: "120254179570120722", post_id: "355628047872664_1421243236808896" }],
      ad_ids: ["120254179570120722"]
    };
    // Không có customer_phone trong phản hồi thật.
    expect(conversationPhone(conv)).toBe("0862356173");
    const ad = extractAdSource(conv);
    expect(ad.adId).toBe("120254179570120722");
    expect(ad.adPostId).toBe("355628047872664_1421243236808896");
    // Chỉ có ad_ids, không có mảng ads: vẫn phải ra mã quảng cáo.
    expect(extractAdSource({ id: "c", ad_ids: ["120000"] }).adId).toBe("120000");
  });
});

/* Kéo hội thoại mỗi 10 phút: danh sách luôn trả 60 hội thoại gần nhất, mà mỗi
 * hội thoại phải một lượt gọi riêng để lấy tin. Không lọc thì mỗi lượt kéo lại
 * toàn bộ — đo trên máy chủ thật là 95 giây cho 4 trang. */
describe("Pancake: kéo hội thoại bỏ qua phần không đổi", () => {
  it("hội thoại có updated_at không mới hơn mốc đã lưu thì không gọi lấy tin", async () => {
    await prisma.pancakeConfig.updateMany({ data: { active: false } });
    await prisma.pancakePage.updateMany({ data: { active: false } });
    const config = await prisma.pancakeConfig.create({
      data: { label: `Kéo ${uid()}`, accessTokenEnc: encryptNullable("ut")!, branchId: ctx.branchId, active: true }
    });
    const page = await prisma.pancakePage.create({
      data: {
        configId: config.id,
        pageId: `pg${uid()}`,
        name: "Trang kéo",
        platform: "FACEBOOK",
        branchId: ctx.branchId,
        pageAccessTokenEnc: encryptNullable("pat")
      }
    });

    const cuId = `cu-${uid()}`;
    const moiId = `moi-${uid()}`;
    const updatedAt = "2026-10-08T08:00:00.000000";
    // Hội thoại "cu" đã có trong CRM với mốc tin cuối ĐÚNG BẰNG updated_at.
    await prisma.conversation.create({
      data: {
        title: "Khách cũ",
        kind: "CUSTOMER",
        channel: "FACEBOOK",
        branchId: ctx.branchId,
        pancakePageId: page.id,
        pancakeConversationId: cuId,
        lastMessageAt: new Date("2026-10-08T08:00:00.000Z")
      }
    });

    const msgCalls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        const u = String(url);
        if (u.includes("/conversations?") || /\/conversations\?/.test(u)) {
          return new Response(
            JSON.stringify({
              conversations: [
                { id: cuId, type: "INBOX", updated_at: updatedAt, from: { id: "kh1", name: "Khách cũ" }, seen: true },
                { id: moiId, type: "INBOX", updated_at: "2026-10-08T09:00:00.000000", from: { id: "kh2", name: "Khách mới" }, seen: false }
              ]
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }
        msgCalls.push(u);
        return new Response(
          JSON.stringify({
            conv_from: { id: "kh2", name: "Khách mới" },
            messages: [{ id: `m-${uid()}`, inserted_at: "2026-10-08T09:00:00.000000", original_message: "Cho em hỏi giá", from: { id: "kh2" } }]
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      })
    );

    const r = await syncPancakeConfig(config.id);
    expect(r.errors).toEqual([]);
    expect(r.skipped).toBe(1);
    expect(r.conversations).toBe(1);
    expect(r.messages).toBe(1);
    // CHỈ gọi lấy tin cho hội thoại mới — đây là chỗ tiết kiệm thời gian thật.
    expect(msgCalls).toHaveLength(1);
    expect(msgCalls[0]).toContain(encodeURIComponent(moiId));
    expect(msgCalls.some((u) => u.includes(encodeURIComponent(cuId)))).toBe(false);
  });
});

/* Lọc đính kèm. Đo trên máy chủ thật: lọc bằng "có url https" cho ra 287 tệp
 * giả (ad_click trỏ facebook.com) với tên tệp là nguyên bài quảng cáo, và 385
 * tin (14%) hiện "[Tệp đính kèm]" thay cho nội dung. Mẫu dưới đây là 11 loại
 * đính kèm gặp thật trên 4 trang. */
describe("Pancake: chỉ nhận đính kèm THẬT là media", () => {
  const AD_COPY = "‼️ TUYỂN MẪU  FREE FREE‼️\nKHÔNG MẤT PHÍ GÌ - TUYỂN MẪU FULLFACE";

  it("bỏ ad_click và link dù chúng có url https và có name", () => {
    const got = classifyAttachments([
      { type: "ad_click", name: AD_COPY, url: "https://www.facebook.com/122185480646767087", ad_id: "120254179570120722" },
      { type: "link", name: "Không có ngọn núi nào dành cho người sợ độ cao", url: "https://facebook.com/100178379510349_951512941042723" },
      { type: "photo", url: "https://content.pancake.vn/2-2610/2026/10/8/abc.jpg", image_data: { height: 2048, width: 1536 } } as never
    ]);
    expect(got).toHaveLength(1);
    expect(got[0].kind).toBe("IMAGE");
    // Tên tệp KHÔNG được là bài quảng cáo.
    expect(got[0].fileName).toBe("anh-pancake.jpg");
  });

  it("bỏ reaction, address, template, replied_message, system_message", () => {
    expect(
      classifyAttachments([
        { type: "reaction", emoji: "❤" },
        { type: "address", full_address: "E ở, Phường Long Biên, Hà Nội" },
        { type: "template" },
        { type: "replied_message" },
        { type: "system_message" },
        { type: "response_feedback" }
      ])
    ).toEqual([]);
  });

  it("video lấy tệp thật ở video_data.url, không lấy ảnh đại diện .jpg", () => {
    const got = classifyAttachments([
      {
        type: "video",
        mime_type: "video/mp4",
        url: "https://content.pancake.vn/2-2610/2026/10/8/thumbnail.jpg",
        video_data: { url: "https://scontent.fdad5-1.fna.fbcdn.net/o1/v/t2/f2/m483/that.mp4" }
      }
    ]);
    expect(got).toHaveLength(1);
    expect(got[0].url).toContain("that.mp4");
    expect(got[0].url).not.toContain("thumbnail.jpg");
    expect(got[0].kind).toBe("FILE");
    expect(got[0].fileName).toBe("video-pancake.mp4");
  });

  it("nhãn dán tính là ảnh; loại lạ của Pancake về sau thì bỏ qua", () => {
    expect(classifyAttachments([{ type: "sticker", url: "https://scontent.fbcdn.net/v/sticker.png" }])[0].kind).toBe("IMAGE");
    expect(classifyAttachments([{ type: "loai_moi_nam_sau", url: "https://a.b/c" }])).toEqual([]);
    // Trừ khi nó khai mime_type hẳn hoi.
    expect(classifyAttachments([{ type: "loai_moi", mime_type: "application/pdf", url: "https://a.b/c.pdf" }])).toHaveLength(1);
  });

  it("tin không có chữ thì nói rõ khách gửi gì, không phải một dãy [Tệp đính kèm]", () => {
    expect(attachmentLabel([{ type: "reaction", emoji: "❤" }])).toBe("Đã bày tỏ cảm xúc ❤");
    expect(attachmentLabel([{ type: "address", full_address: "E ở, Phường Long Biên, Hà Nội" }])).toBe(
      "Địa chỉ: E ở, Phường Long Biên, Hà Nội"
    );
    expect(attachmentLabel([{ type: "photo", url: "https://a/b.jpg" }])).toBe("[Hình ảnh]");
    expect(attachmentLabel([{ type: "video" }])).toBe("[Video]");
    expect(attachmentLabel([{ type: "ad_click", name: AD_COPY }])).toBe("Khách nhắn từ quảng cáo");
    expect(attachmentLabel([])).toBeNull();
  });
});

/* Gắn nhân viên MUỘN. Chạy thật: 2.814 tin đã về, 19 nhân viên chưa ai gắn.
 * Không quy lại thì mọi báo cáo của CRM chỉ đếm từ lúc gắn trở đi. */
describe("F35: gắn nhân viên muộn vẫn quy lại được tin đã đồng bộ", () => {
  async function fix() {
    await prisma.pancakeConfig.updateMany({ data: { active: false } });
    await prisma.pancakePage.updateMany({ data: { active: false } });
    const config = await prisma.pancakeConfig.create({
      data: { label: `Quy lại ${uid()}`, accessTokenEnc: encryptNullable("ut")!, branchId: ctx.branchId, active: true }
    });
    const page = await prisma.pancakePage.create({
      data: { configId: config.id, pageId: `pg${uid()}`, name: "Trang", platform: "FACEBOOK", branchId: ctx.branchId }
    });
    const conv = await prisma.conversation.create({
      data: { title: "Khách", kind: "CUSTOMER", channel: "FACEBOOK", branchId: ctx.branchId, pancakePageId: page.id, pancakeConversationId: `c-${uid()}` }
    });
    return { config, page, conv };
  }

  it("quy theo uid, và theo tên cho tin về trước khi có cột uid", async () => {
    const { config, conv } = await fix();
    const crmUser = await prisma.user.findUniqueOrThrow({ where: { id: ctx.users.TELESALE.id } });
    const puid = `pu-${uid()}`;
    const agent = await prisma.pancakeAgent.create({
      data: { configId: config.id, pancakeUserId: puid, name: crmUser.name, userId: null }
    });

    const moi = await prisma.chatMessage.create({
      data: { conversationId: conv.id, direction: "OUT", content: "tin moi", externalId: `e-${uid()}`, pancakeAgentUid: puid, senderName: crmUser.name }
    });
    const cu = await prisma.chatMessage.create({
      data: { conversationId: conv.id, direction: "OUT", content: "tin cu", externalId: `e-${uid()}`, pancakeAgentUid: null, senderName: crmUser.name }
    });
    // Tin của người KHÁC: không được quy sai sang nhân viên này.
    const khac = await prisma.chatMessage.create({
      data: { conversationId: conv.id, direction: "OUT", content: "nguoi khac", externalId: `e-${uid()}`, senderName: "Người Khác" }
    });
    // Tin KHÁCH gửi: không bao giờ có người gửi nội bộ.
    const cuaKhach = await prisma.chatMessage.create({
      data: { conversationId: conv.id, direction: "IN", content: "khach hoi", externalId: `e-${uid()}`, senderName: crmUser.name }
    });

    await prisma.pancakeAgent.update({ where: { id: agent.id }, data: { userId: crmUser.id } });
    const r = await relinkAgentMessages(agent.id);
    expect(r.linked).toBe(2); // một theo uid, một theo tên

    const get = async (id: string) => (await prisma.chatMessage.findUniqueOrThrow({ where: { id } })).senderUserId;
    expect(await get(moi.id)).toBe(crmUser.id);
    expect(await get(cu.id)).toBe(crmUser.id);
    expect(await get(khac.id)).toBeNull();
    expect(await get(cuaKhach.id)).toBeNull();
  });

  it("bỏ gắn chỉ xoá tin khớp uid, KHÔNG xoá tin người đó gửi từ CRM", async () => {
    const { config, conv } = await fix();
    const crmUser = await prisma.user.findUniqueOrThrow({ where: { id: ctx.users.TELESALE.id } });
    const puid = `pu-${uid()}`;
    const agent = await prisma.pancakeAgent.create({
      data: { configId: config.id, pancakeUserId: puid, name: crmUser.name, userId: crmUser.id }
    });

    const tuPancake = await prisma.chatMessage.create({
      data: { conversationId: conv.id, direction: "OUT", content: "go trong pancake", externalId: `e-${uid()}`, pancakeAgentUid: puid, senderUserId: crmUser.id, senderName: crmUser.name }
    });
    // Tin gửi TỪ CRM: có senderUserId nhưng không có uid Pancake.
    const tuCrm = await prisma.chatMessage.create({
      data: { conversationId: conv.id, direction: "OUT", content: "gui tu CRM", senderUserId: crmUser.id, senderName: crmUser.name }
    });

    await prisma.pancakeAgent.update({ where: { id: agent.id }, data: { userId: null } });
    const r = await relinkAgentMessages(agent.id);
    expect(r.cleared).toBe(1);

    const get = async (id: string) => (await prisma.chatMessage.findUniqueOrThrow({ where: { id } })).senderUserId;
    expect(await get(tuPancake.id)).toBeNull();
    // Mất dòng này là mất dữ liệu thật: chính người đó đã bấm gửi trong CRM.
    expect(await get(tuCrm.id)).toBe(crmUser.id);
  });

  it("không đụng tới tin của kết nối Pancake khác", async () => {
    const a = await fix();
    const crmUser = await prisma.user.findUniqueOrThrow({ where: { id: ctx.users.TELESALE.id } });
    const puid = `pu-${uid()}`;
    const agent = await prisma.pancakeAgent.create({
      data: { configId: a.config.id, pancakeUserId: puid, name: crmUser.name, userId: crmUser.id }
    });

    // Kết nối thứ hai, cùng tên nhân viên, cùng uid.
    const b = await fix();
    const laCuaBenKhac = await prisma.chatMessage.create({
      data: { conversationId: b.conv.id, direction: "OUT", content: "ben khac", externalId: `e-${uid()}`, pancakeAgentUid: puid, senderName: crmUser.name }
    });

    await relinkAgentMessages(agent.id);
    expect((await prisma.chatMessage.findUniqueOrThrow({ where: { id: laCuaBenKhac.id } })).senderUserId).toBeNull();
  });
});

/* Trang ngủ. Chạy thật: bảng "Theo trang" chỉ hiện 2 trong 4 trang vì hai
 * trang kia không có hoạt động trong kỳ — mà báo cáo không nói gì, nên người
 * xem không phân biệt được "trang ngủ" với "kéo số bị lỗi". */
describe("F35: báo cáo nói rõ trang nào không có hoạt động", () => {
  it("liệt kê trang đã kéo số nhưng không có số trong kỳ, kèm mốc tin cuối", async () => {
    await prisma.pancakeConfig.updateMany({ data: { active: false } });
    await prisma.pancakePage.updateMany({ data: { active: false } });
    const config = await prisma.pancakeConfig.create({
      data: { label: `Ngủ ${uid()}`, accessTokenEnc: encryptNullable("ut")!, branchId: ctx.branchId, active: true }
    });
    const mk = (name: string, statsSyncAt: Date | null) =>
      prisma.pancakePage.create({
        data: { configId: config.id, pageId: `pg${uid()}`, name, platform: "FACEBOOK", branchId: ctx.branchId, statsSyncAt }
      });

    const chay = await mk("Trang đang chạy", new Date());
    const ngu = await mk("Trang ngủ", new Date());
    const chuaKeo = await mk("Trang chưa kéo", null);

    // Trang ngủ: tin cuối 30 ngày trước.
    const cuoi = new Date(Date.now() - 30 * 86_400_000);
    await prisma.conversation.create({
      data: { title: "Khách cũ", kind: "CUSTOMER", channel: "FACEBOOK", branchId: ctx.branchId, pancakePageId: ngu.id, pancakeConversationId: `c-${uid()}`, lastMessageAt: cuoi }
    });
    // Trang đang chạy: có ô số liệu trong kỳ.
    const hour = new Date();
    hour.setUTCMinutes(0, 0, 0);
    await prisma.pancakeAgentStat.create({
      data: { pageId: chay.id, pancakeUserId: `pu-${uid()}`, hour, dayKey: vnDayKey(hour), inboxCount: 5, avgResponseSeconds: 60 }
    });

    const today = startOfVnDay(new Date());
    const r = await buildPancakeAgentReport(
      { from: today, to: new Date(today.getTime() + 86_400_000) },
      { ids: [ctx.branchId], specific: false }
    );

    expect(r.pages.map((p) => p.label)).toEqual(["Trang đang chạy · Facebook"]);
    // Trang ngủ phải được GỌI TÊN, kèm số ngày kể từ tin cuối.
    const idle = r.idlePages.find((p) => p.name === "Trang ngủ");
    expect(idle).toBeTruthy();
    expect(idle!.daysIdle).toBeGreaterThanOrEqual(29);
    expect(idle!.lastMessageAt).toBeTruthy();
    // Trang đang chạy không bị kể là ngủ.
    expect(r.idlePages.some((p) => p.name === "Trang đang chạy")).toBe(false);
    // Trang CHƯA kéo lần nào là vấn đề khác: thuộc pagesNeverSynced, không phải ngủ.
    expect(r.idlePages.some((p) => p.name === "Trang chưa kéo")).toBe(false);
    expect(r.pagesNeverSynced).toContain("Trang chưa kéo");
    void chuaKeo;
  });
});

/* Nối thêm kênh bên Pancake thì CRM phải tự nhận, không chờ ai bấm "Dò trang" —
 * thực tế đã có một trang TikTok nối thêm mà CRM im lặng không biết. */
describe("F35: lượt kéo định kỳ tự nhận trang mới", () => {
  it("trang lạ trong GET /pages được thêm vào CSDL ngay trong lượt kéo", async () => {
    await prisma.pancakeConfig.updateMany({ data: { active: false } });
    await prisma.pancakePage.updateMany({ data: { active: false } });
    const config = await prisma.pancakeConfig.create({
      data: { label: `Tự nhận ${uid()}`, accessTokenEnc: encryptNullable("ut")!, branchId: ctx.branchId, active: true }
    });
    const cu = await prisma.pancakePage.create({
      data: { configId: config.id, pageId: `cu${uid()}`, name: "Trang cũ", platform: "FACEBOOK", branchId: ctx.branchId, pageAccessTokenEnc: encryptNullable("pat-cu") }
    });
    const idMoi = `ttm_-${uid()}`;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        const u = String(url);
        if (u.includes("/api/v1/pages")) {
          return new Response(
            JSON.stringify({
              success: true,
              categorized: {
                activated: [
                  { id: cu.pageId, name: "Trang cũ", platform: "facebook", settings: { page_access_token: "pat-cu" }, users: [] },
                  {
                    id: idMoi,
                    name: "Kênh TikTok mới",
                    platform: "tiktok_business_messaging",
                    settings: { page_access_token: "pat-moi" },
                    users: [{ user_id: `pu-${uid()}`, name: "Nhân viên mới", status: "active" }]
                  }
                ]
              }
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }
        // Hội thoại: trả rỗng cho mọi trang, test này chỉ quan tâm việc nhận trang.
        return new Response(JSON.stringify({ conversations: [] }), { status: 200, headers: { "content-type": "application/json" } });
      })
    );

    const r = await runPancakePullSync();
    expect(r.message).toContain("TRANG MỚI: 1");

    const moi = await prisma.pancakePage.findUnique({ where: { pageId: idMoi } });
    expect(moi).toBeTruthy();
    expect(moi!.name).toBe("Kênh TikTok mới");
    expect(moi!.platform).toBe("TIKTOK");
    // Token riêng của trang lấy luôn trong cùng lượt gọi -> kéo được tin ngay.
    expect(moi!.pageAccessTokenEnc).toBeTruthy();
    expect(moi!.active).toBe(true);
    // Nhân viên của trang mới cũng vào theo.
    expect(await prisma.pancakeAgent.count({ where: { configId: config.id, name: "Nhân viên mới" } })).toBe(1);

    // Lượt sau không được báo "trang mới" nữa.
    const lan2 = await runPancakePullSync();
    expect(lan2.message).not.toContain("TRANG MỚI");
  });

  it("kênh CHƯA KÍCH HOẠT không nhận vào CSDL nhưng phải được kể tên", async () => {
    await prisma.pancakeConfig.updateMany({ data: { active: false } });
    await prisma.pancakePage.updateMany({ data: { active: false } });
    const config = await prisma.pancakeConfig.create({
      data: { label: `Chưa kích hoạt ${uid()}`, accessTokenEnc: encryptNullable("ut")!, branchId: ctx.branchId, active: true }
    });
    const idTat = `ttm_-${uid()}`;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        if (String(url).includes("/api/v1/pages")) {
          return new Response(
            JSON.stringify({
              success: true,
              categorized: {
                activated: [{ id: `fb${uid()}`, name: "Trang chạy", platform: "facebook", settings: { page_access_token: "pat" }, users: [] }],
                // Kênh TikTok chưa kích hoạt: KHÔNG có page_access_token.
                inactivated: [{ id: idTat, name: "Vân Trần Douyin", platform: "tiktok_business_messaging", is_activated: false }]
              }
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }
        return new Response(JSON.stringify({ conversations: [] }), { status: 200, headers: { "content-type": "application/json" } });
      })
    );

    const r = await discoverPagesAndAgents(config.id);
    // Chỉ trang kích hoạt được nhận: trang chưa kích hoạt không có token nên
    // nhận vào chỉ là một dòng chết, không kéo được gì.
    expect(r.created).toBe(1);
    expect(await prisma.pancakePage.findUnique({ where: { pageId: idTat } })).toBeNull();
    // Nhưng PHẢI kể tên, nếu không người dùng lại tưởng CRM bỏ sót kênh.
    expect(r.inactive.map((p) => p.name)).toContain("Vân Trần Douyin");
    expect(r.inactive.find((p) => p.name === "Vân Trần Douyin")?.platform).toBe("TIKTOK");
  });

  it("dò trang lỗi KHÔNG chặn việc kéo tin của các trang đã có", async () => {
    await prisma.pancakeConfig.updateMany({ data: { active: false } });
    await prisma.pancakePage.updateMany({ data: { active: false } });
    const config = await prisma.pancakeConfig.create({
      data: { label: `Dò lỗi ${uid()}`, accessTokenEnc: encryptNullable("ut")!, branchId: ctx.branchId, active: true }
    });
    await prisma.pancakePage.create({
      data: { configId: config.id, pageId: `pg${uid()}`, name: "Trang đã có", platform: "FACEBOOK", branchId: ctx.branchId, pageAccessTokenEnc: encryptNullable("pat") }
    });

    let convCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        const u = String(url);
        if (u.includes("/api/v1/pages")) return new Response("Pancake sập", { status: 500 });
        convCalls++;
        return new Response(JSON.stringify({ conversations: [] }), { status: 200, headers: { "content-type": "application/json" } });
      })
    );

    const r = await runPancakePullSync();
    // Vẫn gọi kéo hội thoại dù dò trang lỗi.
    expect(convCalls).toBeGreaterThan(0);
    expect(r.message).toContain("dò trang");
  });
});
