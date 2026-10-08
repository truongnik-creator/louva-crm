import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { describe, it, expect, beforeAll } from "vitest";
import { setupTestContext, prisma, api, type TestContext } from "./helpers";
import { parseCsv } from "../src/services/worksheet";
import {
  detectHeader,
  monthFromTabName,
  normalizeRating,
  normalizeStatus,
  parseSheet,
  parseSpreadsheetId,
  parseWorkDate,
} from "../src/lib/work-report";
import { WorkPostRating, WorkTaskStatus } from "../src/types/enums";

// F36: báo cáo công việc hàng ngày lấy từ trang tính của từng nhân viên.
//
// Fixture `f36-thang-1-mau.csv` là bản chụp THẬT sheet "T1" của trang tính mẫu
// (Báo Cáo Kim Sơn Media) — giữ nguyên hai dòng tiêu đề, ô ngày gộp, cột
// "Công/ngày" tích luỹ và các dòng "NGHỈ". Test chạy trên dữ liệu thật để
// không tự ru ngủ bằng dữ liệu bịa vừa khít bộ phân tích.

const uid = () => crypto.randomBytes(4).toString("hex");
const SAMPLE = parseCsv(fs.readFileSync(path.join(__dirname, "fixtures/f36-thang-1-mau.csv"), "utf8"));

let ctx: TestContext;
beforeAll(async () => {
  ctx = await setupTestContext("f36work");
  await ctx.createUser("QUAN_LY_HE_THONG");
  await ctx.createUser("KHO");
});

describe("F36 · trích ID trang tính và tên sheet tháng", () => {
  it("trích ID từ URL có gid và từ ID trần", () => {
    const id = "1VwO4kIczvSwQaxYBrYDt4R9A2i-3JP0SaofEnpjIF6o";
    expect(parseSpreadsheetId(`https://docs.google.com/spreadsheets/d/${id}/edit?gid=959368949#gid=959368949`)).toBe(id);
    expect(parseSpreadsheetId(id)).toBe(id);
    expect(parseSpreadsheetId("https://example.com/khong-phai-trang-tinh")).toBeNull();
    expect(parseSpreadsheetId("")).toBeNull();
  });

  it('nhận "T1".."T12" và bỏ qua sheet phụ', () => {
    expect(monthFromTabName("T1")).toBe(1);
    expect(monthFromTabName("T12")).toBe(12);
    expect(monthFromTabName("Tháng 9")).toBe(9);
    expect(monthFromTabName("Quy trình Media")).toBeNull();
    expect(monthFromTabName("T13")).toBeNull();
  });
});

describe("F36 · chuẩn hoá chữ gõ tay", () => {
  it("quy tiến độ về mã đếm được", () => {
    expect(normalizeStatus("Hoàn thành", "Hoàn thành", "TikTok")).toBe(WorkTaskStatus.DONE);
    expect(normalizeStatus("", "Đang làm", "Fanpage")).toBe(WorkTaskStatus.IN_PROGRESS);
    expect(normalizeStatus("Trễ hạn", "", "Khác")).toBe(WorkTaskStatus.LATE);
    expect(normalizeStatus("Chưa làm", "", "Khác")).toBe(WorkTaskStatus.PENDING);
    expect(normalizeStatus("", "", "NGHỈ")).toBe(WorkTaskStatus.DAY_OFF);
    expect(normalizeStatus("", "", "")).toBe(WorkTaskStatus.UNKNOWN);
  });

  it('xét "Xuất sắc" trước "Tốt" nên không bị hiểu thành GOOD', () => {
    expect(normalizeRating("Xuất sắc ( >, = 50k view )")).toBe(WorkPostRating.EXCELLENT);
    expect(normalizeRating("Tốt")).toBe(WorkPostRating.GOOD);
    expect(normalizeRating("Trung bình")).toBe(WorkPostRating.AVERAGE);
    expect(normalizeRating("Chưa tốt")).toBe(WorkPostRating.BAD);
    expect(normalizeRating("")).toBeNull();
  });

  it("đọc ngày dd/MM/yyyy theo giờ Việt Nam, không lệch sang ngày trước", () => {
    const d = parseWorkDate("01/01/2026")!;
    expect(d.toISOString()).toBe("2025-12-31T17:00:00.000Z"); // 00:00 ngày 1/1 giờ VN
    expect(parseWorkDate("2026-03-15")).not.toBeNull();
    expect(parseWorkDate("15", 2026, 3)).not.toBeNull();
    expect(parseWorkDate("")).toBeNull();
  });
});

describe("F36 · phân tích sheet tháng thật", () => {
  it("dò được hai dòng tiêu đề và đúng từng cột", () => {
    const h = detectHeader(SAMPLE);
    expect(h.fallback).toBe(false);
    expect(h.headerRows).toBe(2);
    expect(h.columns).toMatchObject({
      date: 0,
      weekday: 1,
      channel: 2,
      task: 3,
      progress: 4,
      status: 5,
      rating: 6,
      link: 7,
      note: 8,
      summary: 9,
      dayCredit: 10,
    });
  });

  it('suy ra cột ngày và "Công/ngày" theo vị trí vì tiêu đề là ô gộp', () => {
    // Trên trang tính thật, ô tiêu đề "🕒Time" và "Công/ngày" là ô gộp nên
    // Google trả về rỗng — dò theo chữ không bao giờ ra. Thiếu cột ngày là mất
    // cả màn theo dõi tiến độ, nên hai cột này được vá theo vị trí mẫu.
    const h = detectHeader(SAMPLE);
    expect(SAMPLE[0][0]).toBe("");
    expect(SAMPLE[1][0]).toBe("");
    expect(h.inferred).toEqual(expect.arrayContaining(["date", "weekday", "dayCredit"]));
    expect(h.fallback).toBe(false);
  });

  it("điền xuôi ngày cho các dòng việc của cùng một ngày", () => {
    const { entries } = parseSheet({ rows: SAMPLE, year: 2026, month: 1 });

    // Ngày 02/01 có 3 dòng việc; chỉ dòng đầu có ô ngày trong trang tính.
    const day2 = entries.filter((e) => e.dayKey === "2026-01-02");
    expect(day2).toHaveLength(3);
    expect(day2.every((e) => e.dayKey === "2026-01-02")).toBe(true);
    expect(day2.map((e) => e.taskName).every(Boolean)).toBe(true);
  });

  it('KHÔNG nhân cột "Công/ngày" ra mọi dòng của ngày', () => {
    const { entries } = parseSheet({ rows: SAMPLE, year: 2026, month: 1 });
    const day3 = entries.filter((e) => e.dayKey === "2026-01-03");
    expect(day3.length).toBeGreaterThan(1);
    expect(day3.filter((e) => e.dayCredit !== null)).toHaveLength(1);
    expect(day3[0].dayCredit).toBe(2);

    // Số công của tháng là giá trị LỚN NHẤT (tích luỹ), không phải tổng.
    const credits = entries.map((e) => e.dayCredit).filter((v): v is number => v !== null);
    expect(Math.max(...credits)).toBe(24);
  });

  it('đánh dấu dòng "NGHỈ" là ngày nghỉ và Chủ nhật trống cũng là ngày nghỉ', () => {
    const { entries } = parseSheet({ rows: SAMPLE, year: 2026, month: 1 });

    const off = entries.find((e) => e.dayKey === "2026-01-01")!;
    expect(off.statusCode).toBe(WorkTaskStatus.DAY_OFF);
    expect(off.isDayOff).toBe(true);
    expect(off.taskName).toBeNull();

    // 04/01/2026 là Chủ nhật, mẫu để trắng -> ngày nghỉ tuần, KHÔNG phải bỏ sót.
    const sunday = entries.find((e) => e.dayKey === "2026-01-04")!;
    expect(sunday.weekday).toBe("CN");
    expect(sunday.statusCode).toBe(WorkTaskStatus.DAY_OFF);
  });

  it("giữ số dòng của sheet để mở đúng dòng trong trang tính gốc", () => {
    const { entries } = parseSheet({ rows: SAMPLE, year: 2026, month: 1, startRow: 1 });
    // Dòng dữ liệu đầu tiên nằm ngay sau 2 dòng tiêu đề -> dòng 3 của sheet.
    expect(entries[0].rowIndex).toBe(3);
    expect(entries.every((e) => e.rowIndex >= 3)).toBe(true);
  });

  it("rơi về vị trí cột mặc định khi sheet không có tiêu đề nhận ra được", () => {
    const rows = [["01/01/2026", "Thứ 5", "TikTok", "Dựng clip", "Hoàn thành", "Hoàn thành"]];
    const h = detectHeader(rows);
    expect(h.fallback).toBe(true);
    expect(h.headerRows).toBe(0);

    const { entries, fallbackColumns } = parseSheet({ rows, year: 2026, month: 1 });
    expect(fallbackColumns).toBe(true);
    expect(entries[0].taskName).toBe("Dựng clip");
  });
});

describe("F36 · cổng đẩy /api/work-reports/ingest", () => {
  async function makeSource(role: "QUAN_LY_HE_THONG" = "QUAN_LY_HE_THONG") {
    const target = await ctx.createUser("MEDIA", { key: `media-${uid()}` });
    const spreadsheetId = `sheet-${uid()}${"x".repeat(20)}`;
    const res = await ctx
      .as(role)
      .post("/api/work-reports/sources")
      .send({ userId: target.id, url: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`, year: 2026 })
      .expect(201);
    return { target, spreadsheetId, sourceId: res.body.source.id as string, token: res.body.token as string };
  }

  const payload = (spreadsheetId: string, rows: string[][], name = "T1") => ({
    spreadsheetId,
    spreadsheetTitle: "Báo Cáo Kim Sơn Media",
    mode: "FULL",
    tabs: [{ gid: "959368949", name, rows }],
  });

  it("nhận dữ liệu bằng token và ghi dòng việc", async () => {
    const { sourceId, spreadsheetId, token, target } = await makeSource();

    const res = await api(ctx.app)
      .post("/api/work-reports/ingest")
      .set("X-Report-Token", token)
      .send(payload(spreadsheetId, SAMPLE))
      .expect(200);

    expect(res.body.tabs).toBe(1);
    expect(res.body.entries).toBeGreaterThan(60);

    const count = await prisma.workReportEntry.count({ where: { sourceId } });
    expect(count).toBe(res.body.entries);

    const source = await prisma.workReportSource.findUniqueOrThrow({ where: { id: sourceId } });
    expect(source.lastSyncStatus).toBe("OK");
    expect(source.title).toBe("Báo Cáo Kim Sơn Media");
    expect(source.rowCount).toBe(count);
    expect(source.tokenLastUsedAt).not.toBeNull();

    // Dòng việc mang theo chủ sở hữu để cổng phạm vi OWN lọc được.
    const sample = await prisma.workReportEntry.findFirstOrThrow({ where: { sourceId } });
    expect(sample.userId).toBe(target.id);
    expect(sample.branchId).toBe(ctx.branchId);
  });

  it("đẩy lại thì THAY dòng cũ chứ không nhân đôi", async () => {
    const { sourceId, spreadsheetId, token } = await makeSource();
    const first = await api(ctx.app)
      .post("/api/work-reports/ingest")
      .set("X-Report-Token", token)
      .send(payload(spreadsheetId, SAMPLE))
      .expect(200);

    await api(ctx.app)
      .post("/api/work-reports/ingest")
      .set("X-Report-Token", token)
      .send(payload(spreadsheetId, SAMPLE))
      .expect(200);

    expect(await prisma.workReportEntry.count({ where: { sourceId } })).toBe(first.body.entries);
    expect(await prisma.workReportTab.count({ where: { sourceId } })).toBe(1);
  });

  it("bỏ qua sheet không phải tháng", async () => {
    const { sourceId, spreadsheetId, token } = await makeSource();
    const res = await api(ctx.app)
      .post("/api/work-reports/ingest")
      .set("X-Report-Token", token)
      .send(payload(spreadsheetId, SAMPLE, "Quy trình Media"))
      .expect(200);

    expect(res.body.tabs).toBe(0);
    expect(res.body.skipped).toEqual(["Quy trình Media"]);
    expect(await prisma.workReportEntry.count({ where: { sourceId } })).toBe(0);
  });

  it("từ chối token sai, token của trang tính khác, và nguồn đã tắt", async () => {
    const { sourceId, spreadsheetId, token } = await makeSource();

    await api(ctx.app)
      .post("/api/work-reports/ingest")
      .set("X-Report-Token", "token-bia-dat")
      .send(payload(spreadsheetId, SAMPLE))
      .expect(401);

    await api(ctx.app).post("/api/work-reports/ingest").send(payload(spreadsheetId, SAMPLE)).expect(401);

    // Dán mã của người này vào trang tính người khác.
    await api(ctx.app)
      .post("/api/work-reports/ingest")
      .set("X-Report-Token", token)
      .send(payload(`khac-${uid()}${"y".repeat(20)}`, SAMPLE))
      .expect(409);

    await prisma.workReportSource.update({ where: { id: sourceId }, data: { active: false } });
    await api(ctx.app)
      .post("/api/work-reports/ingest")
      .set("X-Report-Token", token)
      .send(payload(spreadsheetId, SAMPLE))
      .expect(403);
  });

  it("cấp lại token làm token cũ hết hiệu lực ngay", async () => {
    const { sourceId, spreadsheetId, token } = await makeSource();
    const res = await ctx.as("QUAN_LY_HE_THONG").post(`/api/work-reports/sources/${sourceId}/token`).expect(200);
    const fresh = res.body.token as string;
    expect(fresh).not.toBe(token);

    await api(ctx.app)
      .post("/api/work-reports/ingest")
      .set("X-Report-Token", token)
      .send(payload(spreadsheetId, SAMPLE))
      .expect(401);

    await api(ctx.app)
      .post("/api/work-reports/ingest")
      .set("X-Report-Token", fresh)
      .send(payload(spreadsheetId, SAMPLE))
      .expect(200);
  });

  it("token KHÔNG bao giờ trả ra dạng gốc ở màn danh sách", async () => {
    await makeSource();
    const res = await ctx.as("QUAN_LY_HE_THONG").get("/api/work-reports/sources").expect(200);
    for (const s of res.body) {
      expect(s.hasToken).toBe(true);
      expect(s.tokenHash).toBeUndefined();
      expect(String(s.tokenPrefix ?? "").length).toBeLessThanOrEqual(8);
    }
  });
});

describe("F36 · phân quyền và tổng quan", () => {
  it("nhân viên MEDIA chỉ thấy báo cáo của chính mình (phạm vi OWN)", async () => {
    const a = await ctx.createUser("MEDIA", { key: `mediaA-${uid()}` });
    const b = await ctx.createUser("MEDIA", { key: `mediaB-${uid()}` });

    for (const u of [a, b]) {
      const r = await ctx
        .as("QUAN_LY_HE_THONG")
        .post("/api/work-reports/sources")
        .send({ userId: u.id, url: `https://docs.google.com/spreadsheets/d/own-${uid()}${"z".repeat(20)}/edit`, year: 2026 })
        .expect(201);
      await api(ctx.app)
        .post("/api/work-reports/ingest")
        .set("X-Report-Token", r.body.token)
        .send({ spreadsheetId: r.body.source.spreadsheetId, tabs: [{ gid: "1", name: "T1", rows: SAMPLE }] })
        .expect(200);
    }

    const mine = await ctx.as(a).get("/api/work-reports/sources").expect(200);
    expect(mine.body).toHaveLength(1);
    expect(mine.body[0].userId).toBe(a.id);

    const entries = await ctx.as(a).get("/api/work-reports/entries?year=2026&month=1").expect(200);
    expect(entries.body.entries.length).toBeGreaterThan(0);
    expect(new Set(entries.body.entries.map((e: { user: { id: string } }) => e.user.id))).toEqual(new Set([a.id]));

    // Quản trị thấy cả hai.
    const all = await ctx.as("QUAN_LY_HE_THONG").get("/api/work-reports/sources").expect(200);
    expect(all.body.length).toBeGreaterThanOrEqual(2);
  });

  it("liệt kê nhân viên theo VAI TRÒ dù chưa gán bộ phận", async () => {
    // Đây là tình huống thật trên máy chủ: tạo tài khoản thì bắt buộc chọn vai
    // trò, còn bộ phận là tuỳ chọn nên bị bỏ trống. Lọc chỉ theo bộ phận làm ô
    // "Chọn nhân viên" rỗng dù đã có đủ người của Media và Design.
    const media = await ctx.createUser("MEDIA", { key: `nodept-media-${uid()}` });
    const design = await ctx.createUser("DESIGN", { key: `nodept-design-${uid()}` });
    await prisma.user.updateMany({ where: { id: { in: [media.id, design.id] } }, data: { departmentId: null } });

    const res = await ctx.as("QUAN_LY_HE_THONG").get("/api/work-reports/unlinked").expect(200);
    const ids = res.body.map((u: { id: string }) => u.id);
    expect(ids).toContain(media.id);
    expect(ids).toContain(design.id);

    const row = res.body.find((u: { id: string }) => u.id === media.id);
    expect(row.department).toBeNull();
    expect(row.roles.map((r: { code: string }) => r.code)).toContain("MEDIA");

    // Overview cũng phải nhắc đúng những người này.
    const ov = await ctx.as("QUAN_LY_HE_THONG").get("/api/work-reports/overview").expect(200);
    expect(ov.body.unlinked.map((u: { id: string }) => u.id)).toEqual(expect.arrayContaining([media.id, design.id]));
  });

  it("lọc mặc định bỏ qua vai trò ngoài khối, ?all=true thì hiện", async () => {
    const kho = await ctx.createUser("KHO", { key: `ngoaikhoi-${uid()}` });
    await prisma.user.updateMany({ where: { id: kho.id }, data: { departmentId: null } });

    const mac = await ctx.as("QUAN_LY_HE_THONG").get("/api/work-reports/unlinked").expect(200);
    expect(mac.body.map((u: { id: string }) => u.id)).not.toContain(kho.id);

    const all = await ctx.as("QUAN_LY_HE_THONG").get("/api/work-reports/unlinked?all=true").expect(200);
    expect(all.body.map((u: { id: string }) => u.id)).toContain(kho.id);
  });

  it("người đã gắn trang tính thì biến khỏi danh sách", async () => {
    const u = await ctx.createUser("CONTENT", { key: `datgan-${uid()}` });
    await prisma.user.updateMany({ where: { id: u.id }, data: { departmentId: null } });

    const before = await ctx.as("QUAN_LY_HE_THONG").get("/api/work-reports/unlinked").expect(200);
    expect(before.body.map((x: { id: string }) => x.id)).toContain(u.id);

    await ctx
      .as("QUAN_LY_HE_THONG")
      .post("/api/work-reports/sources")
      .send({ userId: u.id, url: `https://docs.google.com/spreadsheets/d/gone-${uid()}${"k".repeat(20)}/edit` })
      .expect(201);

    const after = await ctx.as("QUAN_LY_HE_THONG").get("/api/work-reports/unlinked").expect(200);
    expect(after.body.map((x: { id: string }) => x.id)).not.toContain(u.id);
  });

  it("vai trò không có quyền thì bị chặn ở cổng 1", async () => {
    await ctx.as("KHO").get("/api/work-reports/sources").expect(403);
    await ctx.as("KHO").get("/api/work-reports/overview").expect(403);
    // MEDIA xem được báo cáo nhưng KHÔNG được gắn trang tính cho người khác.
    const m = await ctx.createUser("MEDIA", { key: `mediaC-${uid()}` });
    await ctx.as(m).get("/api/work-reports/unlinked").expect(403);
    await ctx
      .as(m)
      .post("/api/work-reports/sources")
      .send({ userId: m.id, url: "https://docs.google.com/spreadsheets/d/aaaaaaaaaaaaaaaaaaaaaa/edit" })
      .expect(403);
  });

  it("tổng quan đếm việc, số công, ngày bỏ trống và liệt kê người chưa gắn trang tính", async () => {
    const u = await ctx.createUser("MEDIA", { key: `mediaD-${uid()}` });
    const r = await ctx
      .as("QUAN_LY_HE_THONG")
      .post("/api/work-reports/sources")
      .send({ userId: u.id, url: `https://docs.google.com/spreadsheets/d/ov-${uid()}${"q".repeat(20)}/edit`, year: 2026 })
      .expect(201);
    await api(ctx.app)
      .post("/api/work-reports/ingest")
      .set("X-Report-Token", r.body.token)
      .send({ spreadsheetId: r.body.source.spreadsheetId, tabs: [{ gid: "7", name: "T1", rows: SAMPLE }] })
      .expect(200);

    const res = await ctx.as("QUAN_LY_HE_THONG").get("/api/work-reports/overview?year=2026&month=1").expect(200);
    expect(res.body.days).toHaveLength(31);

    const row = res.body.rows.find((x: { source: { userId: string } }) => x.source.userId === u.id);
    expect(row).toBeTruthy();
    expect(row.totals.tasks).toBeGreaterThan(60);
    expect(row.totals.DONE).toBeGreaterThan(60);
    expect(row.dayCredit).toBe(24);
    expect(row.daysReported).toBeGreaterThan(20);
    expect(row.channels.map((c: { name: string }) => c.name)).toContain("TikTok");
    expect(Array.isArray(res.body.unlinked)).toBe(true);
  });

  it("sinh mã Apps Script có đúng địa chỉ CRM và token mới", async () => {
    const u = await ctx.createUser("MEDIA", { key: `mediaE-${uid()}` });
    const r = await ctx
      .as("QUAN_LY_HE_THONG")
      .post("/api/work-reports/sources")
      .send({ userId: u.id, url: `https://docs.google.com/spreadsheets/d/gs-${uid()}${"w".repeat(20)}/edit` })
      .expect(201);

    const res = await ctx.as("QUAN_LY_HE_THONG").get(`/api/work-reports/sources/${r.body.source.id}/apps-script`).expect(200);
    expect(res.headers["content-type"]).toContain("text/plain");
    expect(res.text).toContain("/api/work-reports/ingest");
    expect(res.text).toContain("function setup()");
    expect(res.text).toContain("getRichTextValues");
    // Lấy mã = cấp token mới, nên token cũ phải chết.
    expect(res.text).not.toContain(r.body.token);
  });
});
