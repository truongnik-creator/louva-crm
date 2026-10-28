import { describe, it, expect, beforeAll } from "vitest";
import { setupTestContext, prisma, type TestContext, type TestUser } from "./helpers";
import { normalizePostUrl, bestRating, matchPlan } from "../src/lib/content-link";
import { ContentStage, WorkPostRating, WorkTaskStatus } from "../src/types/enums";

// F38: đấu nối trang tính báo cáo vào đo lường nội dung.
//
// Rủi ro lớn nhất không phải "không ghép được" mà là "ghép nhầm": một bài bị
// gán kết quả của bài khác sẽ làm hỏng mọi số liệu dựa trên nó mà không ai
// phát hiện. Phần lớn test dưới đây là để chặn đúng chuyện đó.

let ctx: TestContext;
let mkt: TestUser;
let media: TestUser;
let giamDoc: TestUser;

beforeAll(async () => {
  ctx = await setupTestContext("f38dolo");
  mkt = await ctx.createUser("MARKETING");
  media = await ctx.createUser("MEDIA");
  giamDoc = await ctx.createUser("GIAM_DOC");
});

describe("F38 · chuẩn hoá URL bài đăng", () => {
  it("cùng một bài TikTok dán từ nhiều nơi ra cùng một khoá", () => {
    const k = normalizePostUrl("https://www.tiktok.com/@nova/video/7412");
    expect(k).toBeTruthy();
    for (const bien of [
      "https://www.tiktok.com/@nova/video/7412?is_from_webapp=1&sender_device=pc",
      "https://m.tiktok.com/@nova/video/7412/",
      "https://vt.tiktok.com/@nova/video/7412?_t=abc&_r=1",
      "https://tiktok.com/@nova/video/7412#comment",
      "  https://www.tiktok.com/@nova/video/7412  ",
      "www.tiktok.com/@nova/video/7412",
    ]) {
      expect(normalizePostUrl(bien), bien).toBe(k);
    }
  });

  it("gộp tên miền Facebook theo quốc gia, bỏ tham số theo dõi", () => {
    const k = normalizePostUrl("https://www.facebook.com/nova/posts/123");
    expect(normalizePostUrl("https://facebook.com/nova/posts/123?fbclid=XYZ")).toBe(k);
    expect(normalizePostUrl("https://m.facebook.com/nova/posts/123/")).toBe(k);
    expect(normalizePostUrl("https://www.facebook.com/nova/posts/123?utm_source=zalo&utm_medium=cpc")).toBe(k);
  });

  it("KHÔNG gộp hai bài khác nhau", () => {
    expect(normalizePostUrl("https://www.tiktok.com/@nova/video/7412")).not.toBe(
      normalizePostUrl("https://www.tiktok.com/@nova/video/7413")
    );
    // Hoa thường trong id bài là phân biệt — gộp lại là ghép nhầm.
    expect(normalizePostUrl("https://fb.com/p/AbC")).not.toBe(normalizePostUrl("https://fb.com/p/abc"));
  });

  it("giữ tham số có nghĩa, bỏ qua thứ tự tham số", () => {
    expect(normalizePostUrl("https://x.com/p?a=1&b=2")).toBe(normalizePostUrl("https://x.com/p?b=2&a=1"));
    expect(normalizePostUrl("https://x.com/p?a=1")).not.toBe(normalizePostUrl("https://x.com/p?a=2"));
  });

  it('trả null cho ô chỉ có chữ "Link" và các chuỗi không dùng được', () => {
    // Trang tính chạy đường KÉO không lấy được siêu liên kết — ô chỉ còn chữ.
    for (const x of ["Link", "", "   ", null, undefined, "chưa đăng", "javascript:alert(1)", "ftp://a/b"]) {
      expect(normalizePostUrl(x as string), String(x)).toBeNull();
    }
  });
});

describe("F38 · chọn kết quả tốt nhất", () => {
  it("lấy bậc cao nhất khi một bài có nhiều dòng báo cáo", () => {
    expect(bestRating(["BAD", "GOOD", "AVERAGE"])).toBe("GOOD");
    expect(bestRating(["EXCELLENT", "BAD"])).toBe("EXCELLENT");
    expect(bestRating([null, null])).toBeNull();
    expect(bestRating([])).toBeNull();
  });
});

/**
 * Dựng một dòng việc có link, như sau khi đồng bộ trang tính.
 *
 * Mỗi nhân viên chỉ có ĐÚNG MỘT trang tính (`userId` là @unique trong lược đồ),
 * nên nguồn được dùng lại cho cùng một người thay vì tạo mới mỗi lần.
 */
const sourceCache = new Map<string, string>();
let rowSeq = 0;

async function taoDongTrangTinh(opts: {
  userId: string;
  branchId: string | null;
  linkUrl: string | null;
  rating?: string | null;
  taskName?: string;
}) {
  let sourceId = sourceCache.get(opts.userId);
  if (!sourceId) {
    const created = await prisma.workReportSource.create({
      data: {
        userId: opts.userId,
        branchId: opts.branchId,
        spreadsheetId: `ss-${Math.random().toString(36).slice(2, 12)}`,
        url: "https://docs.google.com/spreadsheets/d/x/edit",
        year: 2026,
      },
    });
    sourceId = created.id;
    sourceCache.set(opts.userId, sourceId);
  }
  const source = { id: sourceId };

  const tab = await prisma.workReportTab.create({
    data: { sourceId: source.id, gid: String(++rowSeq + 1_000_000), name: "T10", month: 10 },
  });
  const entry = await prisma.workReportEntry.create({
    data: {
      sourceId: source.id,
      tabId: tab.id,
      userId: opts.userId,
      branchId: opts.branchId,
      year: 2026,
      month: 10,
      rowIndex: 3,
      workDate: new Date("2026-10-20T00:00:00+07:00"),
      dayKey: "2026-10-20",
      taskName: opts.taskName ?? "Dựng clip review",
      channel: "TikTok",
      linkUrl: opts.linkUrl,
      linkUrlKey: normalizePostUrl(opts.linkUrl),
      ratingCode: opts.rating ?? WorkPostRating.GOOD,
      statusCode: WorkTaskStatus.DONE,
    },
  });
  return { source, entry };
}

async function taoBaiDaDang(postUrl: string) {
  const res = await ctx.as(mkt).post("/api/content/plans").send({ title: `Bài ${Math.random()}` });
  const id = res.body.id as string;
  for (const b of [ContentStage.DANG_LAM, ContentStage.CHO_DUYET, ContentStage.DA_DUYET]) {
    await ctx.as(mkt).post(`/api/content/plans/${id}/stage`).send({ stage: b });
  }
  await ctx.as(mkt).post(`/api/content/plans/${id}/stage`).send({ stage: ContentStage.DA_DANG, postUrl });
  return id;
}

describe("F38 · ghép dòng trang tính với bài", () => {
  it("link khớp (khác dạng viết) thì ghép được, và bài mang kết quả của trang tính", async () => {
    const planId = await taoBaiDaDang("https://www.tiktok.com/@nova/video/9001");
    await taoDongTrangTinh({
      userId: media.id,
      branchId: ctx.branchId,
      linkUrl: "https://m.tiktok.com/@nova/video/9001/?_t=zz",
      rating: WorkPostRating.EXCELLENT,
    });
    await matchPlan(planId);

    const entries = await prisma.workReportEntry.findMany({ where: { contentPlanId: planId } });
    expect(entries).toHaveLength(1);

    const res = await ctx.as(mkt).get("/api/content/measure");
    expect(res.status).toBe(200);
    const bai = (res.body.coKetQua as Array<{ id: string; rating: string }>).find((b) => b.id === planId);
    expect(bai?.rating).toBe(WorkPostRating.EXCELLENT);
  });

  it("link khác thì KHÔNG ghép", async () => {
    const planId = await taoBaiDaDang("https://www.tiktok.com/@nova/video/9002");
    await taoDongTrangTinh({ userId: media.id, branchId: ctx.branchId, linkUrl: "https://www.tiktok.com/@nova/video/9999" });
    await matchPlan(planId);
    expect(await prisma.workReportEntry.count({ where: { contentPlanId: planId } })).toBe(0);
  });

  it('ô chỉ có chữ "Link" thì không ghép và không làm vỡ gì', async () => {
    const planId = await taoBaiDaDang("https://www.tiktok.com/@nova/video/9003");
    await taoDongTrangTinh({ userId: media.id, branchId: ctx.branchId, linkUrl: "Link" });
    await matchPlan(planId);
    expect(await prisma.workReportEntry.count({ where: { contentPlanId: planId } })).toBe(0);
  });

  it("hai bài cùng một link thì bỏ qua cả cụm, không chọn bừa", async () => {
    const url = "https://www.tiktok.com/@nova/video/9004";
    const a = await taoBaiDaDang(url);
    const b = await taoBaiDaDang(url);
    await taoDongTrangTinh({ userId: media.id, branchId: ctx.branchId, linkUrl: url });

    await matchPlan(a);
    await matchPlan(b);
    expect(await prisma.workReportEntry.count({ where: { contentPlanId: { in: [a, b] } } })).toBe(0);
  });

  it("đổi link của bài thì liên kết cũ bị gỡ", async () => {
    const planId = await taoBaiDaDang("https://www.tiktok.com/@nova/video/9005");
    await taoDongTrangTinh({ userId: media.id, branchId: ctx.branchId, linkUrl: "https://www.tiktok.com/@nova/video/9005" });
    await matchPlan(planId);
    expect(await prisma.workReportEntry.count({ where: { contentPlanId: planId } })).toBe(1);

    await ctx.as(mkt).patch(`/api/content/plans/${planId}`).send({ postUrl: "https://www.tiktok.com/@nova/video/9006" });
    expect(await prisma.workReportEntry.count({ where: { contentPlanId: planId } })).toBe(0);
  });

  it("ghép lại nhiều lần không nhân đôi", async () => {
    const planId = await taoBaiDaDang("https://www.tiktok.com/@nova/video/9007");
    await taoDongTrangTinh({ userId: media.id, branchId: ctx.branchId, linkUrl: "https://www.tiktok.com/@nova/video/9007" });
    await matchPlan(planId);
    await matchPlan(planId);
    await matchPlan(planId);
    expect(await prisma.workReportEntry.count({ where: { contentPlanId: planId } })).toBe(1);
  });
});

describe("F38 · đo lường", () => {
  it("đếm kế hoạch, đã đăng và phân bố đánh giá", async () => {
    const res = await ctx.as(mkt).get("/api/content/measure");
    expect(res.status).toBe(200);
    expect(res.body.tong.keHoach).toBeGreaterThan(0);
    expect(res.body.tong.daDang).toBeGreaterThan(0);
    expect(res.body.tong.ratings).toHaveProperty("EXCELLENT");
    expect(Array.isArray(res.body.theoKenh)).toBe(true);
    expect(Array.isArray(res.body.theoDang)).toBe(true);
  });

  it("dòng có link mà chưa ứng với bài nào thì nằm ở mục chờ ghép tay", async () => {
    await taoDongTrangTinh({
      userId: media.id,
      branchId: ctx.branchId,
      linkUrl: "https://www.tiktok.com/@nova/video/8888",
      taskName: "Clip chưa ai dán link vào CRM",
    });
    const res = await ctx.as(mkt).get("/api/content/measure");
    const ids = (res.body.chuaGhep as Array<{ linkUrl: string }>).map((e) => e.linkUrl);
    expect(ids).toContain("https://www.tiktok.com/@nova/video/8888");
  });

  it("ghép tay được, và ghi nhật ký kiểm toán", async () => {
    const planId = await taoBaiDaDang("https://www.tiktok.com/@nova/video/9100");
    const { entry } = await taoDongTrangTinh({
      userId: media.id,
      branchId: ctx.branchId,
      linkUrl: "https://bit.ly/rut-gon-khong-khop",
    });

    const res = await ctx.as(mkt).post(`/api/content/plans/${planId}/link-entry`).send({ entryId: entry.id });
    expect(res.status).toBe(200);

    const sau = await prisma.workReportEntry.findUnique({ where: { id: entry.id } });
    expect(sau?.contentPlanId).toBe(planId);

    const logs = await prisma.auditLog.findMany({ where: { entity: "ContentPlan", entityId: planId } });
    expect(logs.some((l) => l.summary?.includes("Ghép tay"))).toBe(true);
  });

  it("cảnh báo khi còn trang tính chạy đường KÉO (không lấy được link)", async () => {
    await prisma.workReportSource.create({
      data: {
        userId: giamDoc.id,
        branchId: ctx.branchId,
        spreadsheetId: `ss-keo-${Math.random().toString(36).slice(2, 10)}`,
        url: "https://docs.google.com/spreadsheets/d/y/edit",
        year: 2026,
        syncMode: "PULL",
      },
    });
    const res = await ctx.as(mkt).get("/api/content/measure");
    expect(res.body.canhBao.nguonKeo).toBeGreaterThan(0);
    expect(res.body.canhBao.thieuLink).toBe(true);
  });
});

describe("F38 · phân quyền đo lường theo người", () => {
  it("media KHÔNG xem được sản lượng của người khác", async () => {
    const res = await ctx.as(media).get("/api/content/measure/by-person");
    expect(res.status).toBe(403);
    expect(res.body.error).toContain("content.view_team_output");
  });

  it("media xem /measure thì KHÔNG kèm tên người phụ trách", async () => {
    // Nếu trả owner kèm rating thì chỉ cần cộng tay là ra bảng xếp hạng đồng
    // nghiệp, và cổng ở by-person thành hình thức.
    const res = await ctx.as(media).get("/api/content/measure");
    expect(res.status).toBe(200);
    for (const row of res.body.coKetQua as Array<{ owner: unknown }>) {
      expect(row.owner).toBeNull();
    }
  });

  it("MKT xem /measure thì CÓ tên người phụ trách", async () => {
    const res = await ctx.as(mkt).get("/api/content/measure");
    const coOwner = (res.body.coKetQua as Array<{ owner: unknown }>).some((r) => r.owner !== null);
    expect(coOwner).toBe(true);
  });

  it("media vẫn xem được đo lường chung", async () => {
    expect((await ctx.as(media).get("/api/content/measure")).status).toBe(200);
  });

  it("MKT và giám đốc xem được năng suất theo người, và CÓ số liệu của người khác", async () => {
    // Dựng một bài của media đã ghép với trang tính, để bảng chắc chắn có dòng.
    const planId = await taoBaiDaDang("https://www.tiktok.com/@nova/video/9500");
    await ctx.as(mkt).patch(`/api/content/plans/${planId}`).send({ ownerId: media.id });
    await taoDongTrangTinh({
      userId: media.id,
      branchId: ctx.branchId,
      linkUrl: "https://www.tiktok.com/@nova/video/9500",
      rating: WorkPostRating.GOOD,
    });
    await matchPlan(planId);

    for (const u of [mkt, giamDoc]) {
      const res = await ctx.as(u).get("/api/content/measure/by-person");
      expect(res.status, u.role).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);

      // Đây mới là điều phải đúng: thấy được người KHÁC, không phải bảng rỗng.
      // Chỉ kiểm mã 200 thì cổng mở mà dữ liệu bị lọc sạch vẫn lọt.
      const rows = res.body as Array<{ id: string; soBai: number }>;
      const cuaMedia = rows.find((r) => r.id === media.id);
      expect(cuaMedia, `${u.role} phải thấy dòng của media`).toBeTruthy();
      expect(cuaMedia!.soBai).toBeGreaterThan(0);
    }
  });

  it("số liệu theo người không kèm SĐT hay hồ sơ khách", async () => {
    const res = await ctx.as(giamDoc).get("/api/content/measure/by-person");
    const text = JSON.stringify(res.body);
    expect(text).not.toMatch(/phone/i);
    expect(text).not.toMatch(/customer/i);
  });
});
