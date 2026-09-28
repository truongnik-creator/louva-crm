import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { asyncHandler, HttpError } from "../middleware/errorHandler";
import { requireAuth, currentUser } from "../middleware/auth";
import { requirePermission, scopedWhere, assertInScope, notFound, phoneFor, hasPermission } from "../middleware/rbac";
import { writeAudit, writeAccessLog, diffFields } from "../lib/audit";
import { withCode, CodePrefix } from "../lib/codes";
import {
  AuditAction,
  ActivityType,
  AccessResourceType,
  CustomerStatus,
  FunnelStage,
  FUNNEL_ORDER,
  Gender,
  TaskPriority,
  TaskStatus,
} from "../types/enums";

// Khách hàng — LIÊN THÔNG TOÀN CÔNG TY (mục 4.2). Vì vậy scopedWhere dùng
// branchField: null: không lọc theo cơ sở, chỉ lọc theo người phụ trách khi
// phạm vi là OWN. Bệnh án của khách thì ngược lại — cách ly, xem routes/medical.ts.

const router = Router();
router.use(requireAuth);

const OWNER_FIELDS = ["assignedToId", "telesaleId"];
const CUSTOMER_SCOPE = { ownerFields: OWNER_FIELDS, branchField: null };

const listSelect = {
  id: true,
  code: true,
  name: true,
  phone: true,
  status: true,
  stage: true,
  interest: true,
  lastContactAt: true,
  createdAt: true,
  assignedTo: { select: { id: true, name: true } },
  telesale: { select: { id: true, name: true } },
  channel: { select: { id: true, name: true, kind: true } },
  branchLinks: { select: { branch: { select: { id: true, code: true, shortName: true } } } },
} as const;

function parseJsonArray(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

// GET /api/customers
router.get(
  "/",
  requirePermission("customer.read"),
  asyncHandler(async (req, res) => {
    const { where } = scopedWhere(req, "customer.read", CUSTOMER_SCOPE);
    const q = (req.query.q as string)?.trim();

    const filters: Record<string, unknown> = { ...where, hidden: false };
    if (q) {
      filters.OR = [
        { name: { contains: q } },
        { phone: { contains: q.replace(/\s/g, "") } },
        { code: { contains: q } },
      ];
    }
    if (req.query.status) filters.status = String(req.query.status);
    if (req.query.stage) filters.stage = String(req.query.stage);
    if (req.query.assignedToId) filters.assignedToId = String(req.query.assignedToId);
    if (req.query.branchId) filters.branchLinks = { some: { branchId: String(req.query.branchId) } };
    if (req.query.tagId) filters.tags = { some: { tagId: String(req.query.tagId) } };

    const take = Math.min(Number(req.query.limit ?? 100), 500);
    const [rows, total] = await Promise.all([
      prisma.customer.findMany({
        where: filters,
        select: listSelect,
        orderBy: { updatedAt: "desc" },
        take,
        skip: Number(req.query.offset ?? 0),
      }),
      prisma.customer.count({ where: filters }),
    ]);

    // Marketing thấy danh sách nhưng SĐT bị che (mục 4.4).
    res.json({
      total,
      items: rows.map((c) => ({
        ...c,
        phone: phoneFor(req, c.phone),
        interest: parseJsonArray(c.interest),
        branches: c.branchLinks.map((b) => b.branch),
        branchLinks: undefined,
      })),
    });
  })
);

// GET /api/customers/:id
router.get(
  "/:id",
  requirePermission("customer.read"),
  asyncHandler(async (req, res) => {
    const customer = await prisma.customer.findUnique({
      where: { id: req.params.id },
      include: {
        assignedTo: { select: { id: true, name: true } },
        telesale: { select: { id: true, name: true } },
        channel: true,
        campaign: { select: { id: true, name: true, code: true } },
        tags: { include: { tag: true } },
        branchLinks: { include: { branch: { select: { id: true, code: true, name: true, shortName: true } } } },
      },
    });
    assertInScope(req, "customer.read", customer as unknown as Record<string, unknown>, CUSTOMER_SCOPE);

    // Xem hồ sơ khách có kèm SĐT là hành vi cần ghi vết (mục 4.4).
    if (hasPermission(req, "customer.view_phone") && customer!.phone) {
      await writeAccessLog({
        req,
        customerId: customer!.id,
        resourceType: AccessResourceType.CUSTOMER_PHONE,
        resourceId: customer!.id,
      });
    }

    const [totalPaid, debt] = await Promise.all([
      prisma.payment.aggregate({ where: { customerId: customer!.id }, _sum: { amount: true } }),
      prisma.invoice.aggregate({
        where: { customerId: customer!.id, status: { in: ["ISSUED", "PARTIAL", "OVERDUE"] } },
        _sum: { amount: true, paidAmount: true },
      }),
    ]);

    res.json({
      ...customer,
      phone: phoneFor(req, customer!.phone),
      interest: parseJsonArray(customer!.interest),
      tags: customer!.tags.map((t) => t.tag),
      branches: customer!.branchLinks.map((b) => ({ ...b.branch, isPrimary: b.isPrimary })),
      branchLinks: undefined,
      totalPaid: totalPaid._sum.amount ?? 0,
      debt: (debt._sum.amount ?? 0) - (debt._sum.paidAmount ?? 0),
    });
  })
);

const customerSchema = z.object({
  name: z.string().min(2),
  phone: z.string().min(8).optional().nullable(),
  email: z.string().email().optional().nullable(),
  zaloUserId: z.string().optional().nullable(),
  dob: z.coerce.date().optional().nullable(),
  gender: z.nativeEnum(Gender).optional().nullable(),
  address: z.string().optional().nullable(),
  city: z.string().optional().nullable(),
  status: z.nativeEnum(CustomerStatus).optional(),
  stage: z.nativeEnum(FunnelStage).optional(),
  channelId: z.string().uuid().optional().nullable(),
  campaignId: z.string().uuid().optional().nullable(),
  interest: z.array(z.string()).optional(),
  budgetNote: z.string().optional().nullable(),
  note: z.string().optional().nullable(),
  assignedToId: z.string().uuid().optional().nullable(),
  telesaleId: z.string().uuid().optional().nullable(),
  branchId: z.string().uuid().optional(),
});

// POST /api/customers
router.post(
  "/",
  requirePermission("customer.create"),
  asyncHandler(async (req, res) => {
    const body = customerSchema.parse(req.body);
    const me = currentUser(req);
    const branchId = body.branchId ?? me.activeBranchId;

    if (body.phone) {
      const dup = await prisma.customer.findFirst({
        where: { phone: body.phone },
        select: { id: true, name: true, code: true },
      });
      if (dup) {
        throw new HttpError(409, `Số điện thoại đã tồn tại ở khách ${dup.name} (${dup.code})`);
      }
    }

    const customer = await withCode(CodePrefix.CUSTOMER, (code) =>
      prisma.customer.create({
        data: {
          code,
          name: body.name,
          phone: body.phone ?? null,
          email: body.email ?? null,
          zaloUserId: body.zaloUserId ?? null,
          dob: body.dob ?? null,
          gender: body.gender ?? null,
          address: body.address ?? null,
          city: body.city ?? null,
          status: body.status ?? CustomerStatus.LEAD,
          stage: body.stage ?? FunnelStage.MOI,
          channelId: body.channelId ?? null,
          campaignId: body.campaignId ?? null,
          interest: body.interest ? JSON.stringify(body.interest) : null,
          budgetNote: body.budgetNote ?? null,
          note: body.note ?? null,
          assignedToId: body.assignedToId ?? me.id,
          telesaleId: body.telesaleId ?? null,
          ...(branchId ? { branchLinks: { create: { branchId, isPrimary: true } } } : {}),
          activities: {
            create: {
              type: ActivityType.SYSTEM,
              content: `Tạo hồ sơ khách bởi ${me.name}`,
              userId: me.id,
              userName: me.name,
            },
          },
        },
      })
    );

    await writeAudit({
      req,
      action: AuditAction.CREATE,
      entity: "Customer",
      entityId: customer.id,
      branchId,
      summary: `Tạo khách ${customer.name} (${customer.code})`,
    });
    res.status(201).json(customer);
  })
);

// PATCH /api/customers/:id
router.patch(
  "/:id",
  requirePermission("customer.update"),
  asyncHandler(async (req, res) => {
    const body = customerSchema.partial().omit({ branchId: true }).parse(req.body);
    const before = await prisma.customer.findUnique({ where: { id: req.params.id } });
    assertInScope(req, "customer.update", before as unknown as Record<string, unknown>, CUSTOMER_SCOPE);

    const { interest, ...rest } = body;
    const data = { ...rest, ...(interest ? { interest: JSON.stringify(interest) } : {}) };

    const customer = await prisma.customer.update({ where: { id: req.params.id }, data });
    await writeAudit({
      req,
      action: AuditAction.UPDATE,
      entity: "Customer",
      entityId: customer.id,
      summary: `Sửa khách ${customer.name} (${customer.code})`,
      changes: diffFields(before as unknown as Record<string, unknown>, data),
    });
    res.json(customer);
  })
);

/**
 * POST /api/customers/:id/stage
 * Chuyển giai đoạn phễu. LÙI trạng thái bắt buộc có lý do — quy tắc nghiệp vụ
 * ghi trong prototype ("bắt buộc ghi lý do khi lùi trạng thái").
 */
router.post(
  "/:id/stage",
  requirePermission("customer.update"),
  asyncHandler(async (req, res) => {
    const body = z
      .object({ stage: z.nativeEnum(FunnelStage), reason: z.string().optional() })
      .parse(req.body);

    const before = await prisma.customer.findUnique({ where: { id: req.params.id } });
    assertInScope(req, "customer.update", before as unknown as Record<string, unknown>, CUSTOMER_SCOPE);

    const prevIndex = FUNNEL_ORDER.indexOf(before!.stage as FunnelStage);
    const nextIndex = FUNNEL_ORDER.indexOf(body.stage);
    const isRegression = prevIndex >= 0 && nextIndex >= 0 && nextIndex < prevIndex;
    if (isRegression && !body.reason) {
      throw new HttpError(400, "Lùi giai đoạn phễu bắt buộc phải ghi lý do");
    }

    const me = currentUser(req);
    const customer = await prisma.customer.update({
      where: { id: req.params.id },
      data: {
        stage: body.stage,
        activities: {
          create: {
            type: ActivityType.STAGE_CHANGE,
            content: `${me.name} đổi giai đoạn: ${before!.stage} → ${body.stage}${body.reason ? ` — lý do: ${body.reason}` : ""}`,
            userId: me.id,
            userName: me.name,
          },
        },
      },
    });

    await writeAudit({
      req,
      action: AuditAction.UPDATE,
      entity: "Customer",
      entityId: customer.id,
      summary: `Đổi giai đoạn khách ${customer.code}: ${before!.stage} → ${body.stage}`,
      changes: { stage: [before!.stage, body.stage] },
    });
    res.json(customer);
  })
);

// POST /api/customers/:id/assign — đổi người phụ trách
router.post(
  "/:id/assign",
  requirePermission("customer.update"),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        assignedToId: z.string().uuid().nullable().optional(),
        telesaleId: z.string().uuid().nullable().optional(),
        reason: z.string().min(3),
      })
      .parse(req.body);

    const before = await prisma.customer.findUnique({ where: { id: req.params.id } });
    assertInScope(req, "customer.update", before as unknown as Record<string, unknown>, CUSTOMER_SCOPE);

    const me = currentUser(req);
    const data: Record<string, unknown> = {};
    if (body.assignedToId !== undefined) data.assignedToId = body.assignedToId;
    if (body.telesaleId !== undefined) data.telesaleId = body.telesaleId;

    const customer = await prisma.customer.update({
      where: { id: req.params.id },
      data: {
        ...data,
        activities: {
          create: {
            type: ActivityType.ASSIGNED,
            content: `${me.name} đổi người phụ trách — lý do: ${body.reason}`,
            userId: me.id,
            userName: me.name,
            meta: JSON.stringify(data),
          },
        },
      },
      include: {
        assignedTo: { select: { id: true, name: true } },
        telesale: { select: { id: true, name: true } },
      },
    });

    await writeAudit({
      req,
      action: AuditAction.UPDATE,
      entity: "Customer",
      entityId: customer.id,
      summary: `Đổi phụ trách khách ${customer.code}. Lý do: ${body.reason}`,
      changes: diffFields(before as unknown as Record<string, unknown>, data),
    });
    res.json(customer);
  })
);

/**
 * POST /api/customers/:id/hide
 * Không có xoá khách. Chỉ ẩn, bắt buộc lý do — quy tắc trong prototype
 * ("Không xoá được khách. Chỉ Quản lý/Chủ đầu tư được Ẩn kèm lý do").
 */
router.post(
  "/:id/hide",
  requirePermission("customer.delete"),
  asyncHandler(async (req, res) => {
    const { reason } = z.object({ reason: z.string().min(5) }).parse(req.body);
    const before = await prisma.customer.findUnique({ where: { id: req.params.id } });
    assertInScope(req, "customer.delete", before as unknown as Record<string, unknown>, CUSTOMER_SCOPE);

    const customer = await prisma.customer.update({
      where: { id: req.params.id },
      data: { hidden: true, hiddenReason: reason },
    });
    await writeAudit({
      req,
      action: AuditAction.DELETE,
      entity: "Customer",
      entityId: customer.id,
      summary: `Ẩn hồ sơ khách ${customer.code}. Lý do: ${reason}`,
    });
    res.json({ ok: true });
  })
);

/**
 * GET /api/customers/:id/timeline
 * Gộp activity + tin nhắn + lịch hẹn + hợp đồng + phiếu thu thành một dòng
 * thời gian duy nhất — đúng tab "Dòng thời gian" trong prototype.
 */
router.get(
  "/:id/timeline",
  requirePermission("customer.read"),
  asyncHandler(async (req, res) => {
    const customer = await prisma.customer.findUnique({ where: { id: req.params.id } });
    assertInScope(req, "customer.read", customer as unknown as Record<string, unknown>, CUSTOMER_SCOPE);

    const [activities, messages, appointments, contracts, payments] = await Promise.all([
      prisma.activity.findMany({
        where: { customerId: customer!.id },
        orderBy: { createdAt: "desc" },
        take: 100,
      }),
      prisma.chatMessage.findMany({
        where: { conversation: { customerId: customer!.id } },
        orderBy: { createdAt: "desc" },
        take: 30,
        select: { id: true, content: true, direction: true, senderName: true, createdAt: true },
      }),
      prisma.appointment.findMany({
        where: { customerId: customer!.id },
        orderBy: { startAt: "desc" },
        take: 30,
        include: { doctor: { select: { name: true } } },
      }),
      prisma.contract.findMany({
        where: { customerId: customer!.id },
        orderBy: { createdAt: "desc" },
        take: 20,
      }),
      prisma.payment.findMany({
        where: { customerId: customer!.id },
        orderBy: { paidAt: "desc" },
        take: 30,
      }),
    ]);

    const entries = [
      ...activities.map((a) => ({
        at: a.createdAt,
        kind: "activity" as const,
        type: a.type,
        text: a.content,
        by: a.userName,
      })),
      ...messages.map((m) => ({
        at: m.createdAt,
        kind: "message" as const,
        type: m.direction,
        text: m.direction === "IN" ? `Khách nhắn: "${m.content}"` : `Trả lời khách: "${m.content}"`,
        by: m.senderName,
      })),
      ...appointments.map((a) => ({
        at: a.createdAt,
        kind: "appointment" as const,
        type: a.status,
        text: `Lịch ${a.title} — ${a.startAt.toLocaleString("vi-VN")}${a.doctor ? ` với ${a.doctor.name}` : ""}`,
        by: null,
      })),
      ...contracts.map((c) => ({
        at: c.createdAt,
        kind: "contract" as const,
        type: c.status,
        text: `Hợp đồng ${c.code} — ${c.total.toLocaleString("vi-VN")}đ`,
        by: null,
      })),
      ...payments.map((p) => ({
        at: p.paidAt,
        kind: "payment" as const,
        type: p.method,
        text: `Thu ${p.amount.toLocaleString("vi-VN")}đ — phiếu ${p.code}`,
        by: null,
      })),
    ].sort((a, b) => b.at.getTime() - a.at.getTime());

    res.json(entries.slice(0, 150));
  })
);

// POST /api/customers/:id/activities — ghi chú tay
router.post(
  "/:id/activities",
  requirePermission("customer.update"),
  asyncHandler(async (req, res) => {
    const body = z
      .object({ content: z.string().min(1), type: z.nativeEnum(ActivityType).optional() })
      .parse(req.body);
    const customer = await prisma.customer.findUnique({ where: { id: req.params.id } });
    assertInScope(req, "customer.update", customer as unknown as Record<string, unknown>, CUSTOMER_SCOPE);

    const me = currentUser(req);
    const activity = await prisma.activity.create({
      data: {
        customerId: customer!.id,
        type: body.type ?? ActivityType.NOTE,
        content: body.content,
        userId: me.id,
        userName: me.name,
      },
    });
    await prisma.customer.update({
      where: { id: customer!.id },
      data: { lastContactAt: new Date() },
    });
    res.status(201).json(activity);
  })
);

// ---------------------------------------------------------------- TAGS

router.get(
  "/tags/all",
  requirePermission("customer.read"),
  asyncHandler(async (_req, res) => {
    res.json(await prisma.tag.findMany({ orderBy: { name: "asc" } }));
  })
);

router.post(
  "/:id/tags",
  requirePermission("customer.update"),
  asyncHandler(async (req, res) => {
    const { tagId } = z.object({ tagId: z.string().uuid() }).parse(req.body);
    const customer = await prisma.customer.findUnique({ where: { id: req.params.id } });
    assertInScope(req, "customer.update", customer as unknown as Record<string, unknown>, CUSTOMER_SCOPE);

    await prisma.customerTag.upsert({
      where: { customerId_tagId: { customerId: customer!.id, tagId } },
      create: { customerId: customer!.id, tagId },
      update: {},
    });
    res.status(201).json({ ok: true });
  })
);

router.delete(
  "/:id/tags/:tagId",
  requirePermission("customer.update"),
  asyncHandler(async (req, res) => {
    await prisma.customerTag.deleteMany({
      where: { customerId: req.params.id, tagId: req.params.tagId },
    });
    res.json({ ok: true });
  })
);

// ---------------------------------------------------------------- TASKS

// GET /api/customers/tasks/mine — "việc cần làm", có cảnh báo quá hạn
router.get(
  "/tasks/mine",
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const tasks = await prisma.task.findMany({
      where: {
        assigneeId: me.id,
        status: { in: [TaskStatus.OPEN, TaskStatus.IN_PROGRESS] },
        ...(req.query.customerId ? { customerId: String(req.query.customerId) } : {}),
      },
      orderBy: [{ dueAt: "asc" }],
      include: { customer: { select: { id: true, name: true, code: true } } },
    });
    const now = Date.now();
    res.json(tasks.map((t) => ({ ...t, overdue: Boolean(t.dueAt && t.dueAt.getTime() < now) })));
  })
);

router.post(
  "/tasks",
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        customerId: z.string().uuid().optional(),
        title: z.string().min(2),
        description: z.string().optional(),
        priority: z.nativeEnum(TaskPriority).optional(),
        dueAt: z.coerce.date().optional(),
        assigneeId: z.string().uuid().optional(),
      })
      .parse(req.body);

    const me = currentUser(req);
    const task = await prisma.task.create({
      data: {
        ...body,
        branchId: me.activeBranchId,
        assigneeId: body.assigneeId ?? me.id,
        createdById: me.id,
      },
    });
    res.status(201).json(task);
  })
);

router.patch(
  "/tasks/:id",
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        status: z.nativeEnum(TaskStatus).optional(),
        title: z.string().optional(),
        dueAt: z.coerce.date().nullable().optional(),
        assigneeId: z.string().uuid().nullable().optional(),
      })
      .parse(req.body);

    const task = await prisma.task.findUnique({ where: { id: req.params.id } });
    if (!task) throw notFound("Không tìm thấy công việc");

    const updated = await prisma.task.update({
      where: { id: req.params.id },
      data: {
        ...body,
        ...(body.status === TaskStatus.DONE ? { completedAt: new Date() } : {}),
      },
    });
    res.json(updated);
  })
);

export default router;
