import { describe, it, expect, beforeAll } from "vitest";
import { setupTestContext, prisma, type TestContext, type TestUser } from "./helpers";
import { ContentStage, ContentTaskKind, WorkTaskStatus } from "../src/types/enums";

// F37: sản xuất nội dung — khối Sáng tạo & Marketing.
//
// Ba thứ phải đúng, vì sai thì hỏng người hoặc hỏng số:
//   1. Phạm vi OWN — media không được đụng bài của người khác.
//   2. Cổng duyệt — chỉ người có content.approve mới đẩy sang DA_DUYET.
//   3. Ranh giới dữ liệu — không nhánh nào trả ra SĐT hay hồ sơ khách.

let ctx: TestContext;
let media: TestUser;
let mediaKhac: TestUser;
let mkt: TestUser;
let giamDoc: TestUser;
let leTan: TestUser;

beforeAll(async () => {
  ctx = await setupTestContext("f37noidung");
  media = await ctx.createUser("MEDIA");
  mediaKhac = await ctx.createUser("MEDIA", { key: "MEDIA2" });
  mkt = await ctx.createUser("MARKETING");
  giamDoc = await ctx.createUser("GIAM_DOC");
  leTan = await ctx.createUser("LE_TAN");
});

/** Tạo một bài bằng quyền MKT, trả về bản ghi. */
async function taoBai(title: string, extra: Record<string, unknown> = {}) {
  const res = await ctx.as(mkt).post("/api/content/plans").send({ title, ...extra });
  expect(res.status).toBe(201);
  return res.body as { id: string; stage: string; ownerId: string | null; title: string };
}

describe("F37 · cổng 1 — vai trò nào vào được", () => {
  it("lễ tân không có quyền content, bị 403 ở cả đọc lẫn tạo", async () => {
    expect((await ctx.as(leTan).get("/api/content/plans")).status).toBe(403);
    expect((await ctx.as(leTan).post("/api/content/plans").send({ title: "Bài thử" })).status).toBe(403);
  });

  it("media đọc được nhưng KHÔNG tạo được bài", async () => {
    expect((await ctx.as(media).get("/api/content/plans")).status).toBe(200);
    const res = await ctx.as(media).post("/api/content/plans").send({ title: "Media tự tạo" });
    expect(res.status).toBe(403);
    expect(res.body.error).toContain("content.create");
  });

  it("MKT và giám đốc tạo được bài", async () => {
    expect((await taoBai("Bài của MKT")).stage).toBe(ContentStage.Y_TUONG);
    const res = await ctx.as(giamDoc).post("/api/content/plans").send({ title: "Bài của giám đốc" });
    expect(res.status).toBe(201);
  });
});

describe("F37 · cổng 3 — phạm vi OWN của media", () => {
  it("media không sửa được bài không liên quan tới mình", async () => {
    const bai = await taoBai("Bài MKT giữ");
    const res = await ctx.as(media).patch(`/api/content/plans/${bai.id}`).send({ note: "chen vào" });
    // 404 chứ không 403: không được lộ ra là bài có tồn tại.
    expect(res.status).toBe(404);
  });

  it("media sửa được bài có việc con gán cho mình", async () => {
    const bai = await taoBai("Bài có việc của media");
    const task = await ctx.as(mkt).post("/api/content/tasks").send({
      planId: bai.id,
      kind: ContentTaskKind.QUAY,
      assigneeId: media.id,
    });
    expect(task.status).toBe(201);

    const res = await ctx.as(media).patch(`/api/content/plans/${bai.id}`).send({ note: "đã quay xong" });
    expect(res.status).toBe(200);
    expect(res.body.note).toBe("đã quay xong");
  });

  it("media khác vẫn không đụng được bài đó", async () => {
    const bai = await taoBai("Bài riêng của media 1");
    await ctx.as(mkt).post("/api/content/tasks").send({
      planId: bai.id,
      kind: ContentTaskKind.DUNG,
      assigneeId: media.id,
    });
    const res = await ctx.as(mediaKhac).patch(`/api/content/plans/${bai.id}`).send({ note: "người khác" });
    expect(res.status).toBe(404);
  });

  it("media XEM được cả bảng của đội — bảng sản xuất là bảng chung", async () => {
    // Cố ý: content.read của media là phạm vi BRANCH, không phải OWN. Bảng sản
    // xuất mà mỗi người chỉ thấy phần mình thì không còn là bảng của đội nữa.
    // Ranh giới nằm ở chỗ SỬA (OWN), đã kiểm ở ba test trên.
    const cua_nguoi_khac = await taoBai("Bài MKT tự giữ");
    const cua_toi = await taoBai("Media có phần");
    await ctx.as(mkt).post("/api/content/tasks").send({
      planId: cua_toi.id,
      kind: ContentTaskKind.VIET,
      assigneeId: media.id,
    });

    const res = await ctx.as(media).get("/api/content/plans");
    expect(res.status).toBe(200);
    const ids = (res.body as Array<{ id: string }>).map((p) => p.id);
    expect(ids).toContain(cua_toi.id);
    expect(ids).toContain(cua_nguoi_khac.id);
  });

  it("vai trò được cấp content.read phạm vi OWN thì chỉ thấy bài của mình", async () => {
    // Không vai trò mặc định nào dùng phạm vi này, nhưng nhánh OWN trong
    // planScope() phải chạy đúng trước khi ai đó cấu hình một vai như vậy.
    const hep = await ctx.createRoleUser([{ code: "content.read", scope: "OWN" }]);
    const cua_nguoi_khac = await taoBai("Bài ngoài tầm vai hẹp");
    const cua_ho = await taoBai("Bài vai hẹp có phần");
    await ctx.as(mkt).post("/api/content/tasks").send({
      planId: cua_ho.id,
      kind: ContentTaskKind.DANG,
      assigneeId: hep.id,
    });

    const res = await ctx.as(hep).get("/api/content/plans");
    expect(res.status).toBe(200);
    const ids = (res.body as Array<{ id: string }>).map((p) => p.id);
    expect(ids).toContain(cua_ho.id);
    expect(ids).not.toContain(cua_nguoi_khac.id);
  });
});

describe("F37 · chuyển bước", () => {
  it("đi lần lượt thì được", async () => {
    const bai = await taoBai("Bài đi đúng đường");
    for (const b of [ContentStage.DANG_LAM, ContentStage.CHO_DUYET]) {
      const res = await ctx.as(mkt).post(`/api/content/plans/${bai.id}/stage`).send({ stage: b });
      expect(res.status).toBe(200);
      expect(res.body.stage).toBe(b);
    }
  });

  it("nhảy cóc bị chặn", async () => {
    const bai = await taoBai("Bài nhảy cóc");
    const res = await ctx.as(mkt).post(`/api/content/plans/${bai.id}/stage`).send({ stage: ContentStage.DA_DANG });
    expect(res.status).toBe(422);
    expect(res.body.error).toContain("lần lượt");
  });

  it("lùi bước bị chặn", async () => {
    const bai = await taoBai("Bài lùi");
    await ctx.as(mkt).post(`/api/content/plans/${bai.id}/stage`).send({ stage: ContentStage.DANG_LAM });
    const res = await ctx.as(mkt).post(`/api/content/plans/${bai.id}/stage`).send({ stage: ContentStage.Y_TUONG });
    expect(res.status).toBe(422);
    expect(res.body.error).toContain("lùi");
  });

  it("huỷ được ở bất kỳ bước nào, nhưng huỷ rồi thì khoá luôn", async () => {
    const bai = await taoBai("Bài bỏ giữa chừng");
    await ctx.as(mkt).post(`/api/content/plans/${bai.id}/stage`).send({ stage: ContentStage.DANG_LAM });
    expect((await ctx.as(mkt).post(`/api/content/plans/${bai.id}/stage`).send({ stage: ContentStage.HUY })).status).toBe(200);

    const res = await ctx.as(mkt).post(`/api/content/plans/${bai.id}/stage`).send({ stage: ContentStage.DANG_LAM });
    expect(res.status).toBe(422);
    expect(res.body.error).toContain("đã huỷ");
  });

  it("media KHÔNG duyệt được bài dù có phần việc trong đó", async () => {
    const bai = await taoBai("Bài chờ duyệt");
    await ctx.as(mkt).post("/api/content/tasks").send({
      planId: bai.id,
      kind: ContentTaskKind.DUNG,
      assigneeId: media.id,
    });
    await ctx.as(mkt).post(`/api/content/plans/${bai.id}/stage`).send({ stage: ContentStage.DANG_LAM });
    await ctx.as(media).post(`/api/content/plans/${bai.id}/stage`).send({ stage: ContentStage.CHO_DUYET });

    const res = await ctx.as(media).post(`/api/content/plans/${bai.id}/stage`).send({ stage: ContentStage.DA_DUYET });
    expect(res.status).toBe(403);
    expect(res.body.error).toContain("content.approve");
  });

  it("MKT duyệt được, và bản ghi lưu lại ai duyệt", async () => {
    const bai = await taoBai("Bài MKT duyệt");
    await ctx.as(mkt).post(`/api/content/plans/${bai.id}/stage`).send({ stage: ContentStage.DANG_LAM });
    await ctx.as(mkt).post(`/api/content/plans/${bai.id}/stage`).send({ stage: ContentStage.CHO_DUYET });
    const res = await ctx.as(mkt).post(`/api/content/plans/${bai.id}/stage`).send({ stage: ContentStage.DA_DUYET });

    expect(res.status).toBe(200);
    expect(res.body.approvedById).toBe(mkt.id);
    expect(res.body.approvedAt).toBeTruthy();
  });

  it("chuyển sang Đã đăng mà thiếu link thì bị chặn", async () => {
    const bai = await taoBai("Bài thiếu link");
    for (const b of [ContentStage.DANG_LAM, ContentStage.CHO_DUYET, ContentStage.DA_DUYET]) {
      await ctx.as(mkt).post(`/api/content/plans/${bai.id}/stage`).send({ stage: b });
    }
    const thieu = await ctx.as(mkt).post(`/api/content/plans/${bai.id}/stage`).send({ stage: ContentStage.DA_DANG });
    expect(thieu.status).toBe(422);
    expect(thieu.body.error).toContain("link");

    const du = await ctx
      .as(mkt)
      .post(`/api/content/plans/${bai.id}/stage`)
      .send({ stage: ContentStage.DA_DANG, postUrl: "https://www.tiktok.com/@nova/video/123" });
    expect(du.status).toBe(200);
    expect(du.body.publishedAt).toBeTruthy();
  });
});

describe("F37 · ranh giới dữ liệu khách", () => {
  it("không nhánh nào của /api/content trả ra SĐT hay hồ sơ khách", async () => {
    const khach = await ctx.createCustomer({ name: "Khách thử F37", phone: "0901234567" });
    const bai = await taoBai("Bài có khách thật trong CSDL", { brief: "quay cho chiến dịch tháng 10" });
    await ctx.as(mkt).post("/api/content/tasks").send({
      planId: bai.id,
      kind: ContentTaskKind.QUAY,
      assigneeId: media.id,
    });

    for (const url of ["/api/content/plans", `/api/content/plans/${bai.id}`, "/api/content/my-day"]) {
      const res = await ctx.as(media).get(url);
      expect(res.status).toBe(200);
      const text = JSON.stringify(res.body);
      expect(text).not.toContain("0901234567");
      expect(text).not.toContain(khach.id);
      expect(text).not.toMatch(/phoneNormalized/);
    }
  });

  it("bảng content_plans không có cột khách hàng", async () => {
    const cols = await prisma.$queryRawUnsafe<Array<{ name: string }>>(`PRAGMA table_info(content_plans)`);
    const names = cols.map((c) => c.name);
    expect(names).not.toContain("customerId");
    expect(names).toContain("campaignId");
  });
});

describe("F37 · trang chủ việc của tôi", () => {
  it("media thấy việc của mình, không thấy mục chờ duyệt", async () => {
    const bai = await taoBai("Bài cho my-day");
    await ctx.as(mkt).post("/api/content/tasks").send({
      planId: bai.id,
      kind: ContentTaskKind.DUNG,
      assigneeId: media.id,
      dueDate: "2026-01-05",
    });

    const res = await ctx.as(media).get("/api/content/my-day");
    expect(res.status).toBe(200);
    const taskIds = (res.body.tasks as Array<{ planId: string }>).map((t) => t.planId);
    expect(taskIds).toContain(bai.id);
    // Không có content.approve thì danh sách chờ duyệt phải rỗng.
    expect(res.body.waiting).toEqual([]);
    expect(res.body.overdue).toBeGreaterThanOrEqual(1);
  });

  it("MKT thấy được mục chờ duyệt", async () => {
    const bai = await taoBai("Bài đang chờ MKT duyệt");
    await ctx.as(mkt).post(`/api/content/plans/${bai.id}/stage`).send({ stage: ContentStage.DANG_LAM });
    await ctx.as(mkt).post(`/api/content/plans/${bai.id}/stage`).send({ stage: ContentStage.CHO_DUYET });

    const res = await ctx.as(mkt).get("/api/content/my-day");
    expect(res.status).toBe(200);
    expect((res.body.waiting as Array<{ id: string }>).map((p) => p.id)).toContain(bai.id);
  });

  it("việc đã xong không còn nằm trong danh sách hôm nay", async () => {
    const bai = await taoBai("Bài có việc đã xong");
    const task = await ctx.as(mkt).post("/api/content/tasks").send({
      planId: bai.id,
      kind: ContentTaskKind.THIET_KE,
      assigneeId: media.id,
    });
    await ctx.as(media).patch(`/api/content/tasks/${task.body.id}`).send({ status: WorkTaskStatus.DONE });

    const res = await ctx.as(media).get("/api/content/my-day");
    expect((res.body.tasks as Array<{ id: string }>).map((t) => t.id)).not.toContain(task.body.id);
  });
});

describe("F37 · nhật ký kiểm toán", () => {
  it("tạo, duyệt và xoá bài đều ghi lại", async () => {
    const bai = await taoBai("Bài kiểm toán");
    await ctx.as(mkt).post(`/api/content/plans/${bai.id}/stage`).send({ stage: ContentStage.DANG_LAM });
    await ctx.as(giamDoc).delete(`/api/content/plans/${bai.id}`);

    const logs = await prisma.auditLog.findMany({ where: { entity: "ContentPlan", entityId: bai.id } });
    const actions = logs.map((l) => l.action);
    expect(actions).toContain("CREATE");
    expect(actions).toContain("UPDATE");
    expect(actions).toContain("DELETE");
  });
});
