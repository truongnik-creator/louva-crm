import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { pageQuery, CATALOG_PAGE } from "../lib/pagination";
import { asyncHandler } from "../middleware/errorHandler";
import { requireAuth, currentUser } from "../middleware/auth";
import { requirePermission, scopeOf, notFound } from "../middleware/rbac";
import { writeAudit, diffFields } from "../lib/audit";
import { AuditAction, PermissionScope, RoomType } from "../types/enums";

// Cơ sở, phòng ban, phòng/thiết bị — nhóm "Cài đặt" trong prototype.

const router = Router();
router.use(requireAuth);

// ---------------------------------------------------------------- BRANCHES

// Ai cũng đọc được danh sách cơ sở MÌNH THUỘC VỀ (để đổi cơ sở đang làm việc).
router.get(
  "/branches",
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const canSeeAll = scopeOf(req, "settings.read") === PermissionScope.ALL;
    const branches = await prisma.branch.findMany({
      ...pageQuery(req.query, CATALOG_PAGE),
      where: canSeeAll ? {} : { id: { in: user.branchIds } },
      orderBy: { code: "asc" },
    });
    res.json(branches);
  })
);

const branchSchema = z.object({
  code: z.string().min(2).max(20),
  name: z.string().min(2),
  shortName: z.string().optional(),
  address: z.string().optional(),
  phone: z.string().optional(),
  active: z.boolean().optional(),
  // F24: chỉ dẫn đường cho khách.
  mapUrl: z.string().trim().url("Link bản đồ phải là đường dẫn http(s)").max(500).nullable().optional().or(z.literal("")),
  parkingGuide: z.string().trim().max(500).nullable().optional(),
  buildingGuide: z.string().trim().max(500).nullable().optional(),
  facadePhotoUrl: z.string().trim().url("Ảnh mặt tiền phải là đường dẫn http(s)").max(500).nullable().optional().or(z.literal("")),
  // F25: tài khoản nhận cọc của cơ sở.
  bankBin: z.string().trim().regex(/^\d{6}$/, "Mã BIN ngân hàng gồm 6 chữ số").nullable().optional().or(z.literal("")),
  bankAccountNo: z.string().trim().regex(/^[0-9A-Za-z]{4,30}$/, "Số tài khoản không hợp lệ").nullable().optional().or(z.literal("")),
  bankAccountName: z.string().trim().max(100).nullable().optional(),
});

/** Chuỗi rỗng từ form nghĩa là xoá giá trị. */
function blankToNull<T extends Record<string, unknown>>(data: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) out[k] = v === "" ? null : v;
  return out as T;
}

router.post(
  "/branches",
  requirePermission("settings.create"),
  asyncHandler(async (req, res) => {
    const data = blankToNull(branchSchema.parse(req.body));
    const branch = await prisma.branch.create({ data: data as typeof data & { code: string; name: string } });
    await writeAudit({
      req,
      action: AuditAction.CREATE,
      entity: "Branch",
      entityId: branch.id,
      summary: `Tạo cơ sở ${branch.name}`,
    });
    res.status(201).json(branch);
  })
);

router.patch(
  "/branches/:id",
  requirePermission("settings.update"),
  asyncHandler(async (req, res) => {
    const data = blankToNull(branchSchema.partial().parse(req.body));
    const before = await prisma.branch.findUnique({ where: { id: req.params.id } });
    if (!before) throw notFound("Không tìm thấy cơ sở");

    const branch = await prisma.branch.update({ where: { id: req.params.id }, data });
    await writeAudit({
      req,
      action: AuditAction.UPDATE,
      entity: "Branch",
      entityId: branch.id,
      summary: `Sửa cơ sở ${branch.name}`,
      changes: diffFields(before, data),
    });
    res.json(branch);
  })
);

// ------------------------------------------------------------- DEPARTMENTS

router.get(
  "/departments",
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const branchId = (req.query.branchId as string) ?? undefined;
    res.json(
      await prisma.department.findMany({
        ...pageQuery(req.query, CATALOG_PAGE),
        where: {
          branchId: branchId ?? { in: user.branchIds },
          ...(req.query.active === "1" ? { active: true } : {}),
        },
        orderBy: { name: "asc" },
        include: { branch: { select: { id: true, code: true, name: true } } },
      })
    );
  })
);

const departmentSchema = z.object({
  branchId: z.string().uuid(),
  code: z.string().min(1),
  name: z.string().min(1),
  active: z.boolean().optional(),
});

router.post(
  "/departments",
  requirePermission("settings.create"),
  asyncHandler(async (req, res) => {
    const data = departmentSchema.parse(req.body);
    const dept = await prisma.department.create({ data });
    await writeAudit({
      req,
      action: AuditAction.CREATE,
      entity: "Department",
      entityId: dept.id,
      branchId: dept.branchId,
      summary: `Tạo phòng ban ${dept.name}`,
    });
    res.status(201).json(dept);
  })
);

router.patch(
  "/departments/:id",
  requirePermission("settings.update"),
  asyncHandler(async (req, res) => {
    const data = departmentSchema.partial().omit({ branchId: true }).parse(req.body);
    const dept = await prisma.department.update({ where: { id: req.params.id }, data });
    await writeAudit({
      req,
      action: AuditAction.UPDATE,
      entity: "Department",
      entityId: dept.id,
      branchId: dept.branchId,
      summary: `Sửa phòng ban ${dept.name}`,
    });
    res.json(dept);
  })
);

// -------------------------------------------------------------------- ROOMS

router.get(
  "/rooms",
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const branchId = (req.query.branchId as string) ?? user.activeBranchId ?? undefined;
    res.json(
      await prisma.room.findMany({
        ...pageQuery(req.query, CATALOG_PAGE),
        where: {
          branchId: branchId && user.branchIds.includes(branchId) ? branchId : { in: user.branchIds },
          ...(req.query.type ? { type: String(req.query.type) } : {}),
          ...(req.query.active === "1" ? { active: true } : {}),
        },
        orderBy: [{ type: "asc" }, { code: "asc" }],
      })
    );
  })
);

const roomSchema = z.object({
  branchId: z.string().uuid(),
  code: z.string().min(1),
  name: z.string().min(1),
  type: z.nativeEnum(RoomType).optional(),
  capacity: z.number().int().positive().optional(),
  active: z.boolean().optional(),
});

router.post(
  "/rooms",
  requirePermission("settings.create"),
  asyncHandler(async (req, res) => {
    const data = roomSchema.parse(req.body);
    const user = currentUser(req);
    if (!user.branchIds.includes(data.branchId)) throw notFound();

    const room = await prisma.room.create({ data });
    await writeAudit({
      req,
      action: AuditAction.CREATE,
      entity: "Room",
      entityId: room.id,
      branchId: room.branchId,
      summary: `Tạo phòng ${room.name}`,
    });
    res.status(201).json(room);
  })
);

router.patch(
  "/rooms/:id",
  requirePermission("settings.update"),
  asyncHandler(async (req, res) => {
    const data = roomSchema.partial().omit({ branchId: true }).parse(req.body);
    const user = currentUser(req);
    const before = await prisma.room.findUnique({ where: { id: req.params.id } });
    if (!before || !user.branchIds.includes(before.branchId)) throw notFound("Không tìm thấy phòng");

    const room = await prisma.room.update({ where: { id: req.params.id }, data });
    await writeAudit({
      req,
      action: AuditAction.UPDATE,
      entity: "Room",
      entityId: room.id,
      branchId: room.branchId,
      summary: `Sửa phòng ${room.name}`,
      changes: diffFields(before, data),
    });
    res.json(room);
  })
);

export default router;
