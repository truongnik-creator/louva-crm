import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { parsePagination } from "../lib/pagination";
import { asyncHandler, HttpError } from "../middleware/errorHandler";
import { requireAuth, currentUser } from "../middleware/auth";
import { notFound, phoneFor, requirePermission, scopeOf } from "../middleware/rbac";
import { writeAudit } from "../lib/audit";
import { isAiConfigured } from "../lib/ai";
import { getSettingBool } from "../lib/settings-catalog";
import { approveDraft } from "../lib/reengage";
import { AuditAction, PermissionScope, ReengageDraftStatus } from "../types/enums";

// AI5: HÀNG CHỜ DUYỆT NHÁP TIN CHĂM LẠI (/api/reengage).
//
// Phạm vi quyền inbox.reengage:
//   OWN    sale chỉ thấy nháp của khách mình phụ trách
//   BRANCH quản lý cơ sở thấy nháp của cơ sở mình
//   ALL    giám đốc, quản trị thấy tất cả
// Duyệt = đưa vào hàng đợi gửi theo nhóm (F11), không gửi thẳng.

const router = Router();
router.use(requireAuth);

type Req = Parameters<typeof requireAuth>[0];

function draftWhere(req: Req): Record<string, unknown> {
  const me = currentUser(req);
  const scope = scopeOf(req, "inbox.reengage");
  if (scope === PermissionScope.ALL) return {};
  if (scope === PermissionScope.BRANCH) return { OR: [{ branchId: { in: me.branchIds } }, { ownerId: me.id }] };
  return { ownerId: me.id };
}

async function loadDraft(req: Req) {
  const d = await prisma.reengageDraft.findFirst({ where: { id: req.params.id, ...draftWhere(req) } });
  if (!d) throw notFound("Không tìm thấy nháp");
  return d;
}

router.get(
  "/drafts",
  requirePermission("inbox.reengage"),
  asyncHandler(async (req, res) => {
    const status = z.nativeEnum(ReengageDraftStatus).default(ReengageDraftStatus.PENDING).parse(req.query.status ?? undefined);
    const page = parsePagination(req.query, { defaultLimit: 50, maxLimit: 200 });
    const where = { ...draftWhere(req), status };
    const [rows, total] = await Promise.all([
      prisma.reengageDraft.findMany({ where, orderBy: { createdAt: "desc" }, take: page.take, skip: page.skip }),
      prisma.reengageDraft.count({ where }),
    ]);
    const customers = await prisma.customer.findMany({
      where: { id: { in: rows.map((r) => r.customerId) } },
      select: { id: true, code: true, name: true, phone: true, optOut: true, lastContactAt: true, stage: true },
    });
    const byId = new Map(customers.map((c) => [c.id, { ...c, phone: phoneFor(req, c.phone) }]));
    res.json({
      total,
      aiConfigured: isAiConfigured(),
      enabled: await getSettingBool("ai.reengageEnabled"),
      items: rows.map((r) => ({ ...r, customer: byId.get(r.customerId) ?? null })),
    });
  })
);

/** POST /api/reengage/drafts/:id/approve { content? } — duyệt (có thể sửa) rồi đưa vào hàng đợi gửi. */
router.post(
  "/drafts/:id/approve",
  requirePermission("inbox.reengage"),
  asyncHandler(async (req, res) => {
    const body = z.object({ content: z.string().trim().min(2).max(2000).optional() }).parse(req.body ?? {});
    const draft = await loadDraft(req);
    const me = currentUser(req);
    const out = await approveDraft({ req, draft, content: body.content, user: { id: me.id, name: me.name, activeBranchId: me.activeBranchId } });
    res.json({ ok: true, ...out });
  })
);

router.post(
  "/drafts/:id/reject",
  requirePermission("inbox.reengage"),
  asyncHandler(async (req, res) => {
    const body = z.object({ reason: z.string().trim().max(300).optional() }).parse(req.body ?? {});
    const draft = await loadDraft(req);
    const me = currentUser(req);
    const r = await prisma.reengageDraft.updateMany({
      where: { id: draft.id, status: ReengageDraftStatus.PENDING },
      data: { status: ReengageDraftStatus.REJECTED, rejectReason: body.reason ?? null, reviewedById: me.id, reviewedByName: me.name, reviewedAt: new Date() },
    });
    if (r.count !== 1) throw new HttpError(409, "Nháp đã được xử lý");
    await writeAudit({
      req,
      action: AuditAction.REJECT,
      entity: "ReengageDraft",
      entityId: draft.id,
      branchId: draft.branchId,
      summary: `Bỏ nháp tin chăm lại${body.reason ? `: ${body.reason}` : ""}`,
    });
    res.json({ ok: true });
  })
);

export default router;
