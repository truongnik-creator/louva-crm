import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { pageQuery } from "../lib/pagination";
import { asyncHandler, HttpError } from "../middleware/errorHandler";
import { requireAuth, currentUser } from "../middleware/auth";
import { requirePermission, scopedWhere, notFound, scopeOf } from "../middleware/rbac";
import { writeAudit } from "../lib/audit";
import { startOfVnDay } from "../lib/datetime";
import {
  AuditAction,
  ContentFormat,
  ContentStage,
  ContentTaskKind,
  CONTENT_STAGE_ORDER,
  PermissionScope,
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
    if ("plannedDate" in body) {
      data.plannedDate = body.plannedDate ? startOfVnDay(new Date(body.plannedDate)) : null;
    }

    const plan = await prisma.contentPlan.update({
      where: { id: req.params.id },
      data,
      include: planInclude,
    });
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
        ...(to === ContentStage.DA_DUYET ? { approvedById: me.id, approvedAt: new Date() } : {}),
        ...(to === ContentStage.DA_DANG ? { publishedAt: new Date() } : {}),
      },
      include: planInclude,
    });

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

export default router;
