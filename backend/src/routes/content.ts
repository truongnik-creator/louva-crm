import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { pageQuery } from "../lib/pagination";
import { asyncHandler, HttpError } from "../middleware/errorHandler";
import { requireAuth, currentUser } from "../middleware/auth";
import {
  requirePermission,
  scopedWhere,
  notFound,
  scopeOf,
} from "../middleware/rbac";
import { writeAudit } from "../lib/audit";
import { startOfVnDay } from "../lib/datetime";
import { bestRating, matchPlan, normalizePostUrl } from "../lib/content-link";
import {
  AuditAction,
  ContentFormat,
  ContentStage,
  ContentTaskKind,
  CONTENT_STAGE_ORDER,
  PermissionScope,
  WorkReportSyncMode,
  WorkTaskStatus,
} from "../types/enums";

// F37: SẢN XUẤT NỘI DUNG — khối Sáng tạo & Marketing.
//
// F36 kéo được việc ĐÃ LÀM từ trang tính về. Màn này lo phần còn lại: bài sắp
// làm, ai đang giữ, bao giờ đăng.
//
// Ranh giới dữ liệu: KHÔNG có đường nào từ đây chạm tới hồ sơ khách. Bảng
// `content_plans` không có `customerId`, và không route nào dưới đây đọc bảng
// khách hay bệnh án. Media/Design/Content vào được màn này nhưng vẫn không có
// `customer.view_phone` — không có gì để che vì không có gì được trả ra.

const router = Router();
router.use(requireAuth);

/**
 * Phạm vi của một bài: OWN = bài mình phụ trách HOẶC có việc con gán cho mình.
 *
 * `scopedWhere` chỉ so được các cột nằm ngay trên bảng, mà "có việc con gán cho
 * mình" là điều kiện trên bảng `content_tasks`. Nên ở phạm vi OWN ta tự ghép
 * thêm nhánh `tasks.some` thay vì dựa hết vào helper.
 */
function planScope(req: Parameters<typeof scopedWhere>[0]) {
  const me = currentUser(req);
  const scope = scopeOf(req, "content.read");
  if (!scope) throw new HttpError(403, "Không có quyền: content.read");

  if (scope === PermissionScope.ALL) return {};
  if (scope === PermissionScope.BRANCH) {
    return { OR: [{ branchId: { in: me.branchIds } }, { branchId: null }] };
  }
  return {
    AND: [
      { OR: [{ branchId: { in: me.branchIds } }, { branchId: null }] },
      { OR: [{ ownerId: me.id }, { createdById: me.id }, { tasks: { some: { assigneeId: me.id } } }] },
    ],
  };
}

const planInclude = {
  owner: { select: { id: true, name: true } },
  approvedBy: { select: { id: true, name: true } },
  campaign: { select: { id: true, code: true, name: true } },
  channel: { select: { id: true, key: true, name: true } },
  tasks: {
    orderBy: { createdAt: "asc" as const },
    include: { assignee: { select: { id: true, name: true } } },
  },
};

/**
 * Sửa được bài này không?
 *
 * Phạm vi OWN (media, design, content) chỉ được đụng bài mình phụ trách hoặc
 * có phần việc trong đó. Người có BRANCH/ALL (MKT, quản lý) thì qua cổng 3 của
 * `content.update` là đủ.
 */
async function assertCanEdit(req: Parameters<typeof scopedWhere>[0], planId: string) {
  const me = currentUser(req);
  const scope = scopeOf(req, "content.update");
  if (!scope) throw new HttpError(403, "Không có quyền: content.update");

  const plan = await prisma.contentPlan.findUnique({
    where: { id: planId },
    include: { tasks: { select: { assigneeId: true } } },
  });
  if (!plan) throw notFound("Không tìm thấy bài");

  if (scope === PermissionScope.ALL) return plan;

  const inBranch = !plan.branchId || me.branchIds.includes(plan.branchId);
  if (!inBranch) throw notFound("Không tìm thấy bài");
  if (scope === PermissionScope.BRANCH) return plan;

  const mine =
    plan.ownerId === me.id ||
    plan.createdById === me.id ||
    plan.tasks.some((t) => t.assigneeId === me.id);
  if (!mine) throw notFound("Không tìm thấy bài");
  return plan;
}

// --------------------------------------------------------------------- BÀI

router.get(
  "/plans",
  requirePermission("content.read"),
  asyncHandler(async (req, res) => {
    const q = z
      .object({
        stage: z.nativeEnum(ContentStage).optional(),
        channelId: z.string().optional(),
        campaignId: z.string().optional(),
        ownerId: z.string().optional(),
        from: z.string().optional(),
        to: z.string().optional(),
      })
      .parse(req.query);

    const where: Record<string, unknown> = { ...planScope(req) };
    if (q.stage) where.stage = q.stage;
    if (q.channelId) where.channelId = q.channelId;
    if (q.campaignId) where.campaignId = q.campaignId;
    if (q.ownerId) where.ownerId = q.ownerId;
    if (q.from || q.to) {
      where.plannedDate = {
        ...(q.from ? { gte: startOfVnDay(new Date(q.from)) } : {}),
        ...(q.to ? { lte: startOfVnDay(new Date(q.to)) } : {}),
      };
    }

    const plans = await prisma.contentPlan.findMany({
      where,
      include: planInclude,
      orderBy: [{ plannedDate: "asc" }, { createdAt: "desc" }],
      ...pageQuery(req.query),
    });
    res.json(plans);
  })
);

router.get(
  "/plans/:id",
  requirePermission("content.read"),
  asyncHandler(async (req, res) => {
    const plan = await prisma.contentPlan.findFirst({
      where: { AND: [{ id: req.params.id }, planScope(req)] },
      include: planInclude,
    });
    if (!plan) throw notFound("Không tìm thấy bài");
    res.json(plan);
  })
);

const planBody = z.object({
  title: z.string().min(2).max(300),
  format: z.nativeEnum(ContentFormat).optional(),
  brief: z.string().max(5000).optional().nullable(),
  branchId: z.string().optional().nullable(),
  campaignId: z.string().optional().nullable(),
  channelId: z.string().optional().nullable(),
  ownerId: z.string().optional().nullable(),
  plannedDate: z.string().optional().nullable(),
  note: z.string().max(2000).optional().nullable(),
});

router.post(
  "/plans",
  requirePermission("content.create"),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const body = planBody.parse(req.body);

    // Cơ sở mặc định là cơ sở đầu của người tạo — giữ cổng 2 không bị hở khi
    // giao diện quên gửi branchId.
    const branchId = body.branchId ?? me.branchIds[0] ?? null;
    if (branchId && !me.branchIds.includes(branchId) && scopeOf(req, "content.create") !== PermissionScope.ALL) {
      throw notFound("Không tìm thấy cơ sở");
    }

    const plan = await prisma.contentPlan.create({
      data: {
        title: body.title,
        format: body.format ?? ContentFormat.VIDEO,
        brief: body.brief ?? null,
        branchId,
        campaignId: body.campaignId ?? null,
        channelId: body.channelId ?? null,
        ownerId: body.ownerId ?? me.id,
        plannedDate: body.plannedDate ? startOfVnDay(new Date(body.plannedDate)) : null,
        note: body.note ?? null,
        stage: ContentStage.Y_TUONG,
        createdById: me.id,
      },
      include: planInclude,
    });

    await writeAudit({
      req,
      action: AuditAction.CREATE,
      entity: "ContentPlan",
      entityId: plan.id,
      summary: `Tạo bài "${plan.title}"`,
    });
    res.status(201).json(plan);
  })
);

router.patch(
  "/plans/:id",
  requirePermission("content.update"),
  asyncHandler(async (req, res) => {
    await assertCanEdit(req, req.params.id);
    const body = planBody
      .partial()
      .extend({ postUrl: z.string().url().max(2000).optional().nullable() })
      .parse(req.body);

    const data: Record<string, unknown> = {};
    for (const k of ["title", "format", "brief", "campaignId", "channelId", "ownerId", "note", "postUrl"] as const) {
      if (k in body) data[k] = body[k] ?? null;
    }
    // F38: khoá ghép luôn đi kèm postUrl — không bao giờ để hai cột lệch nhau.
    if ("postUrl" in body) data.postUrlKey = normalizePostUrl(body.postUrl);
    if ("plannedDate" in body) {
      data.plannedDate = body.plannedDate ? startOfVnDay(new Date(body.plannedDate)) : null;
    }

    const plan = await prisma.contentPlan.update({
      where: { id: req.params.id },
      data,
      include: planInclude,
    });
    if ("postUrl" in body) await matchPlan(plan.id);
    await writeAudit({
      req,
      action: AuditAction.UPDATE,
      entity: "ContentPlan",
      entityId: plan.id,
      summary: `Sửa bài "${plan.title}"`,
    });
    res.json(plan);
  })
);

/**
 * Chuyển bước.
 *
 * Đi một bước một, không nhảy cóc, không lùi. HUY là lối ra ở bất kỳ bước nào
 * và không quay lại được. Hai bước cuối có cổng riêng:
 *   · vào DA_DUYET  — cần `content.approve`
 *   · vào DA_DANG   — cần postUrl, vì bài đã đăng mà không có link thì sau này
 *                     không đối chiếu được kết quả về phễu.
 */
router.post(
  "/plans/:id/stage",
  requirePermission("content.update"),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const plan = await assertCanEdit(req, req.params.id);
    const body = z
      .object({
        stage: z.nativeEnum(ContentStage),
        postUrl: z.string().url().max(2000).optional().nullable(),
      })
      .parse(req.body);

    const from = plan.stage as ContentStage;
    const to = body.stage;

    if (from === ContentStage.HUY) throw new HttpError(422, "Bài đã huỷ, không chuyển bước được nữa");
    if (to === from) throw new HttpError(422, "Bài đang ở bước này rồi");

    if (to !== ContentStage.HUY) {
      const i = CONTENT_STAGE_ORDER.indexOf(from);
      const j = CONTENT_STAGE_ORDER.indexOf(to);
      if (i < 0 || j < 0) throw new HttpError(422, "Bước không hợp lệ");
      if (j < i) throw new HttpError(422, "Không lùi bước được");
      if (j > i + 1) throw new HttpError(422, `Phải đi lần lượt, bước kế tiếp là ${CONTENT_STAGE_ORDER[i + 1]}`);
    }

    if (to === ContentStage.DA_DUYET && !req.user?.permissions["content.approve"]) {
      throw new HttpError(403, "Không có quyền duyệt bài: content.approve");
    }

    const postUrl = body.postUrl ?? plan.postUrl;
    if (to === ContentStage.DA_DANG && !postUrl) {
      throw new HttpError(422, "Phải có link bài đăng trước khi chuyển sang Đã đăng");
    }

    const updated = await prisma.contentPlan.update({
      where: { id: plan.id },
      data: {
        stage: to,
        postUrl,
        postUrlKey: normalizePostUrl(postUrl),
        ...(to === ContentStage.DA_DUYET ? { approvedById: me.id, approvedAt: new Date() } : {}),
        ...(to === ContentStage.DA_DANG ? { publishedAt: new Date() } : {}),
      },
      include: planInclude,
    });

    if (postUrl !== plan.postUrl) await matchPlan(plan.id);
    await writeAudit({
      req,
      action: to === ContentStage.DA_DUYET ? AuditAction.APPROVE : AuditAction.UPDATE,
      entity: "ContentPlan",
      entityId: plan.id,
      summary: `Bài "${plan.title}": ${from} → ${to}`,
    });
    res.json(updated);
  })
);

router.delete(
  "/plans/:id",
  requirePermission("content.delete"),
  asyncHandler(async (req, res) => {
    const plan = await assertCanEdit(req, req.params.id);
    await prisma.contentPlan.delete({ where: { id: plan.id } });
    await writeAudit({
      req,
      action: AuditAction.DELETE,
      entity: "ContentPlan",
      entityId: plan.id,
      summary: `Xoá bài "${plan.title}"`,
    });
    res.status(204).end();
  })
);

// ---------------------------------------------------------------- VIỆC CON

const taskBody = z.object({
  planId: z.string(),
  kind: z.nativeEnum(ContentTaskKind),
  assigneeId: z.string().optional().nullable(),
  dueDate: z.string().optional().nullable(),
  note: z.string().max(2000).optional().nullable(),
});

router.post(
  "/tasks",
  requirePermission("content.create"),
  asyncHandler(async (req, res) => {
    const body = taskBody.parse(req.body);
    await assertCanEdit(req, body.planId);

    const task = await prisma.contentTask.create({
      data: {
        planId: body.planId,
        kind: body.kind,
        assigneeId: body.assigneeId ?? null,
        dueDate: body.dueDate ? startOfVnDay(new Date(body.dueDate)) : null,
        note: body.note ?? null,
        status: WorkTaskStatus.PENDING,
      },
      include: { assignee: { select: { id: true, name: true } } },
    });
    await writeAudit({
      req,
      action: AuditAction.CREATE,
      entity: "ContentTask",
      entityId: task.id,
      summary: `Thêm việc ${task.kind}`,
    });
    res.status(201).json(task);
  })
);

router.patch(
  "/tasks/:id",
  requirePermission("content.update"),
  asyncHandler(async (req, res) => {
    const existing = await prisma.contentTask.findUnique({ where: { id: req.params.id } });
    if (!existing) throw notFound("Không tìm thấy việc");
    await assertCanEdit(req, existing.planId);

    const body = z
      .object({
        kind: z.nativeEnum(ContentTaskKind).optional(),
        assigneeId: z.string().optional().nullable(),
        dueDate: z.string().optional().nullable(),
        status: z.nativeEnum(WorkTaskStatus).optional(),
        resultUrl: z.string().url().max(2000).optional().nullable(),
        note: z.string().max(2000).optional().nullable(),
      })
      .parse(req.body);

    const data: Record<string, unknown> = {};
    for (const k of ["kind", "assigneeId", "status", "resultUrl", "note"] as const) {
      if (k in body) data[k] = body[k] ?? null;
    }
    if ("dueDate" in body) data.dueDate = body.dueDate ? startOfVnDay(new Date(body.dueDate)) : null;

    const task = await prisma.contentTask.update({
      where: { id: req.params.id },
      data,
      include: { assignee: { select: { id: true, name: true } } },
    });
    await writeAudit({
      req,
      action: AuditAction.UPDATE,
      entity: "ContentTask",
      entityId: task.id,
      summary: `Sửa việc ${task.kind}`,
    });
    res.json(task);
  })
);

router.delete(
  "/tasks/:id",
  requirePermission("content.delete"),
  asyncHandler(async (req, res) => {
    const existing = await prisma.contentTask.findUnique({ where: { id: req.params.id } });
    if (!existing) throw notFound("Không tìm thấy việc");
    await assertCanEdit(req, existing.planId);
    await prisma.contentTask.delete({ where: { id: existing.id } });
    await writeAudit({
      req,
      action: AuditAction.DELETE,
      entity: "ContentTask",
      entityId: existing.id,
      summary: `Xoá việc ${existing.kind}`,
    });
    res.status(204).end();
  })
);

// ------------------------------------------------------------ VIỆC CỦA TÔI

/**
 * Trang chủ của media / design / content: việc đến hạn, bài mình giữ, bài chờ
 * duyệt. Không phân trang — đây là màn mở đầu ngày, phải gọn.
 */
router.get(
  "/my-day",
  requirePermission("content.read"),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const today = startOfVnDay(new Date());
    const openStages = [ContentStage.Y_TUONG, ContentStage.DANG_LAM, ContentStage.CHO_DUYET, ContentStage.DA_DUYET];

    const [tasks, owned, waiting] = await Promise.all([
      prisma.contentTask.findMany({
        where: {
          assigneeId: me.id,
          status: { notIn: [WorkTaskStatus.DONE, WorkTaskStatus.CANCELLED] },
        },
        include: { plan: { select: { id: true, title: true, stage: true, plannedDate: true } } },
        orderBy: [{ dueDate: "asc" }, { createdAt: "asc" }],
        take: 50,
      }),
      prisma.contentPlan.findMany({
        where: { ownerId: me.id, stage: { in: openStages } },
        include: planInclude,
        orderBy: [{ plannedDate: "asc" }],
        take: 50,
      }),
      // Bài chờ duyệt chỉ hiện với người duyệt được, khỏi bày việc của người khác.
      req.user?.permissions["content.approve"]
        ? prisma.contentPlan.findMany({
            where: { AND: [{ stage: ContentStage.CHO_DUYET }, planScope(req)] },
            include: planInclude,
            orderBy: [{ plannedDate: "asc" }],
            take: 50,
          })
        : Promise.resolve([]),
    ]);

    res.json({
      today,
      tasks,
      owned,
      waiting,
      overdue: tasks.filter((t) => t.dueDate && t.dueDate < today).length,
    });
  })
);

// ------------------------------------------------------------- ĐO LƯỜNG F38
//
// Nguồn số liệu là TRANG TÍNH, không phải người gõ lại vào CRM. Cột "Đánh giá
// bài đăng" của trang tính đã phân bậc theo view (<5k / ≥5k / ≥10k / ≥50k), nên
// chỉ việc đọc lên chứ không tự chấm lại.

/** Một bài kèm kết quả thật lấy từ trang tính. */
function ketQuaCuaBai(plan: {
  id: string;
  entries: Array<{ ratingCode: string | null; workDate: Date | null; linkUrl: string | null }>;
}) {
  const rating = bestRating(plan.entries.map((e) => e.ratingCode));
  const ngayBaoCao = plan.entries
    .map((e) => e.workDate)
    .filter((d): d is Date => Boolean(d))
    .sort((a, b) => a.getTime() - b.getTime())[0];
  return { rating, ngayBaoCao: ngayBaoCao ?? null, soDong: plan.entries.length };
}

router.get(
  "/measure",
  requirePermission("content.read"),
  asyncHandler(async (req, res) => {
    const q = z
      .object({ from: z.string().optional(), to: z.string().optional() })
      .parse(req.query);

    const where: Record<string, unknown> = { ...planScope(req) };
    if (q.from || q.to) {
      where.plannedDate = {
        ...(q.from ? { gte: startOfVnDay(new Date(q.from)) } : {}),
        ...(q.to ? { lte: startOfVnDay(new Date(q.to)) } : {}),
      };
    }

    const plans = await prisma.contentPlan.findMany({
      where,
      select: {
        id: true,
        title: true,
        format: true,
        stage: true,
        plannedDate: true,
        publishedAt: true,
        postUrl: true,
        channel: { select: { id: true, name: true } },
        campaign: { select: { id: true, name: true } },
        owner: { select: { id: true, name: true } },
        entries: { select: { ratingCode: true, workDate: true, linkUrl: true } },
      },
      orderBy: [{ plannedDate: "desc" }],
    });

    // Xem được năng suất của NGƯỜI KHÁC hay không.
    //
    // Nếu cứ trả `owner` kèm `rating` cho mọi vai thì một bạn media chỉ cần
    // cộng tay là ra bảng xếp hạng đồng nghiệp — lúc đó cổng ở /measure/by-person
    // chỉ là hình thức. Tổng theo kênh, theo dạng thì ai cũng xem được: đó là
    // kết quả của đội, không phải điểm của một người.
    const xemDuocNguoiKhac = Boolean(req.user?.permissions["content.view_team_output"]);

    const RATINGS = ["BAD", "AVERAGE", "GOOD", "EXCELLENT"] as const;
    const emptyRatings = () => Object.fromEntries(RATINGS.map((r) => [r, 0])) as Record<string, number>;

    const tong = {
      keHoach: plans.filter((p) => p.stage !== ContentStage.HUY).length,
      daDang: plans.filter((p) => p.stage === ContentStage.DA_DANG).length,
      huy: plans.filter((p) => p.stage === ContentStage.HUY).length,
      coKetQua: 0,
      ratings: emptyRatings(),
    };

    const theoKenh = new Map<string, { name: string; keHoach: number; daDang: number; ratings: Record<string, number> }>();
    const theoDang = new Map<string, { keHoach: number; daDang: number; ratings: Record<string, number> }>();

    const coKetQua: unknown[] = [];
    const chuaCoKetQua: unknown[] = [];

    for (const p of plans) {
      const kq = ketQuaCuaBai(p);
      const kenhKey = p.channel?.id ?? "KHONG";
      const kenh =
        theoKenh.get(kenhKey) ??
        { name: p.channel?.name ?? "Chưa chọn kênh", keHoach: 0, daDang: 0, ratings: emptyRatings() };
      const dang = theoDang.get(p.format) ?? { keHoach: 0, daDang: 0, ratings: emptyRatings() };

      if (p.stage !== ContentStage.HUY) {
        kenh.keHoach++;
        dang.keHoach++;
      }
      if (p.stage === ContentStage.DA_DANG) {
        kenh.daDang++;
        dang.daDang++;
      }
      if (kq.rating) {
        tong.coKetQua++;
        tong.ratings[kq.rating]++;
        kenh.ratings[kq.rating]++;
        dang.ratings[kq.rating]++;
      }

      theoKenh.set(kenhKey, kenh);
      theoDang.set(p.format, dang);

      const row = {
        id: p.id,
        title: p.title,
        format: p.format,
        stage: p.stage,
        channel: p.channel,
        campaign: p.campaign,
        owner: xemDuocNguoiKhac ? p.owner : null,
        plannedDate: p.plannedDate,
        publishedAt: p.publishedAt,
        postUrl: p.postUrl,
        ...kq,
      };
      if (kq.rating) coKetQua.push(row);
      else if (p.stage === ContentStage.DA_DANG) chuaCoKetQua.push(row);
    }

    // Dòng việc có link trong trang tính mà chưa ứng với bài nào — gợi ý ghép tay.
    const { where: entryWhere } = scopedWhere(req, "content.read", {
      ownerFields: ["userId"],
      branchField: "branchId",
    });
    const chuaGhep = await prisma.workReportEntry.findMany({
      where: { ...entryWhere, contentPlanId: null, linkUrlKey: { not: null } },
      select: {
        id: true,
        taskName: true,
        channel: true,
        workDate: true,
        linkUrl: true,
        ratingCode: true,
        user: { select: { id: true, name: true } },
      },
      orderBy: { workDate: "desc" },
      take: 50,
    });

    // Trang tính chạy đường KÉO không lấy được URL trong ô "Link hoàn thành" —
    // nói thẳng ra, đừng để người đọc tưởng số liệu đã đủ.
    const nguonKeo = await prisma.workReportSource.count({
      where: { active: true, syncMode: WorkReportSyncMode.PULL },
    });

    res.json({
      tong,
      theoKenh: [...theoKenh.entries()].map(([id, v]) => ({ id, ...v })),
      theoDang: [...theoDang.entries()].map(([format, v]) => ({ format, ...v })),
      coKetQua,
      chuaCoKetQua,
      chuaGhep,
      canhBao: {
        nguonKeo,
        thieuLink: nguonKeo > 0,
      },
    });
  })
);

/**
 * Năng suất theo NGƯỜI.
 *
 * Gác bằng quyền riêng `content.view_team_output`, không dùng lại
 * `work_report.read`.
 *
 * Hai thứ đó khác nhau: `work_report.read` là dữ liệu NHÂN SỰ (ngày công, ngày
 * nghỉ, từng dòng việc), còn đây là SẢN LƯỢNG nội dung. Gộp chúng lại thì MKT —
 * người lên kế hoạch và duyệt bài, đúng người cần số này — bị chặn vì
 * `work_report.read` của họ là OWN; còn muốn mở cho MKT thì lại phải mở luôn cả
 * bảng công của đội. Tách quyền là cách duy nhất cho đúng cả hai.
 */
router.get(
  "/measure/by-person",
  requirePermission("content.view_team_output"),
  asyncHandler(async (req, res) => {
    // Phạm vi phải đi theo ĐÚNG quyền đang gác cổng. Lọc theo work_report.read
    // thì MKT (OWN với quyền đó) qua được cổng nhưng chỉ thấy dòng của chính
    // mình — bảng rỗng, không báo lỗi, không ai biết tại sao.
    const { where } = scopedWhere(req, "content.view_team_output", {
      ownerFields: ["userId"],
      branchField: "branchId",
    });

    const entries = await prisma.workReportEntry.findMany({
      where: { ...where, contentPlanId: { not: null } },
      select: {
        ratingCode: true,
        contentPlanId: true,
        user: { select: { id: true, name: true } },
      },
    });

    const byUser = new Map<string, { id: string; name: string; baiCoKetQua: Set<string>; ratings: Record<string, number> }>();
    for (const e of entries) {
      const row =
        byUser.get(e.user.id) ??
        { id: e.user.id, name: e.user.name, baiCoKetQua: new Set<string>(), ratings: { BAD: 0, AVERAGE: 0, GOOD: 0, EXCELLENT: 0 } };
      if (e.contentPlanId) row.baiCoKetQua.add(e.contentPlanId);
      if (e.ratingCode) row.ratings[e.ratingCode] = (row.ratings[e.ratingCode] ?? 0) + 1;
      byUser.set(e.user.id, row);
    }

    res.json(
      [...byUser.values()]
        .map((r) => ({
          id: r.id,
          name: r.name,
          soBai: r.baiCoKetQua.size,
          ratings: r.ratings,
          baiTot: r.ratings.GOOD + r.ratings.EXCELLENT,
        }))
        .sort((a, b) => b.soBai - a.soBai)
    );
  })
);

/** Ghép tay một dòng việc vào bài, khi URL không khớp (gõ tay, rút gọn...). */
router.post(
  "/plans/:id/link-entry",
  requirePermission("content.update"),
  asyncHandler(async (req, res) => {
    const plan = await assertCanEdit(req, req.params.id);
    const { entryId } = z.object({ entryId: z.string() }).parse(req.body);

    const { where } = scopedWhere(req, "content.read", { ownerFields: ["userId"], branchField: "branchId" });
    const entry = await prisma.workReportEntry.findFirst({
      where: { ...where, id: entryId },
      select: { id: true, taskName: true },
    });
    if (!entry) throw notFound("Không tìm thấy dòng việc");

    await prisma.workReportEntry.update({ where: { id: entry.id }, data: { contentPlanId: plan.id } });
    await writeAudit({
      req,
      action: AuditAction.UPDATE,
      entity: "ContentPlan",
      entityId: plan.id,
      summary: `Ghép tay dòng trang tính "${entry.taskName ?? entry.id}" vào bài "${plan.title}"`,
    });
    res.json({ ok: true });
  })
);

export default router;
