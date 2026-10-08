import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { asyncHandler, HttpError } from "../middleware/errorHandler";
import { requireAuth, currentUser } from "../middleware/auth";
import { notFound, requireAnyPermission, requirePermission } from "../middleware/rbac";
import { writeAudit } from "../lib/audit";
import { AuditAction } from "../types/enums";

// AI2: KỊCH BẢN BÁN HÀNG CHUẨN có phiên bản. Quản lý dán kịch bản "win" của
// Thầy vào; mỗi lần lưu là một phiên bản mới, chỉ một phiên bản đang dùng. AI
// gợi ý trả lời đọc phiên bản đang dùng (khoá "default").

const router = Router();
router.use(requireAuth);

router.get(
  "/",
  requireAnyPermission("inbox.manage_scripts", "inbox.read"),
  asyncHandler(async (req, res) => {
    const key = String(req.query.key ?? "default");
    res.json(await prisma.salesScript.findMany({ where: { key }, orderBy: { version: "desc" }, take: 100 }));
  })
);

router.post(
  "/",
  requirePermission("inbox.manage_scripts"),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        key: z.string().trim().min(1).max(40).default("default"),
        title: z.string().trim().min(2).max(160),
        content: z.string().trim().min(20, "Kịch bản quá ngắn").max(60_000),
        note: z.string().trim().max(500).optional(),
        activate: z.boolean().default(true),
      })
      .parse(req.body);
    const me = currentUser(req);
    const row = await prisma.$transaction(async (tx) => {
      const last = await tx.salesScript.findFirst({ where: { key: body.key }, orderBy: { version: "desc" } });
      if (body.activate) await tx.salesScript.updateMany({ where: { key: body.key }, data: { isActive: false } });
      return tx.salesScript.create({
        data: {
          key: body.key,
          version: (last?.version ?? 0) + 1,
          title: body.title,
          content: body.content,
          note: body.note ?? null,
          isActive: body.activate,
          createdById: me.id,
          createdByName: me.name,
        },
      });
    });
    await writeAudit({
      req,
      action: AuditAction.CREATE,
      entity: "SalesScript",
      entityId: row.id,
      summary: `Lưu kịch bản bán hàng "${row.title}" phiên bản ${row.version}${row.isActive ? " (đang dùng)" : ""}`,
    });
    res.status(201).json(row);
  })
);

router.post(
  "/:id/activate",
  requirePermission("inbox.manage_scripts"),
  asyncHandler(async (req, res) => {
    const row = await prisma.salesScript.findUnique({ where: { id: req.params.id } });
    if (!row) throw notFound();
    if (row.isActive) throw new HttpError(409, "Phiên bản này đang dùng");
    await prisma.$transaction([
      prisma.salesScript.updateMany({ where: { key: row.key }, data: { isActive: false } }),
      prisma.salesScript.update({ where: { id: row.id }, data: { isActive: true } }),
    ]);
    await writeAudit({
      req,
      action: AuditAction.UPDATE,
      entity: "SalesScript",
      entityId: row.id,
      summary: `Chuyển sang dùng kịch bản "${row.title}" phiên bản ${row.version}`,
    });
    res.json({ ...row, isActive: true });
  })
);

export default router;
