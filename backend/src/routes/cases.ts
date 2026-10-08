import { Router, type Request } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { pageQuery } from "../lib/pagination";
import { asyncHandler, HttpError } from "../middleware/errorHandler";
import { requireAuth, currentUser } from "../middleware/auth";
import { hasPermission, notFound, requirePermission, scopeOf } from "../middleware/rbac";
import { writeAudit, writeAccessLog } from "../lib/audit";
import { getDecrypted } from "../lib/storage";
import { AccessResourceType, AccessSeverity, AuditAction, CaseStudyStatus, PermissionScope } from "../types/enums";

// F30: THƯ VIỆN CASE (/api/cases).
//
// Ba luật:
//   1. CHỈ ảnh thuộc bộ ảnh có consentForMarketing = true (F2) mới hiện. Tắt cờ
//      đồng ý là ảnh biến khỏi thư viện ngay (lọc lúc đọc, không chép ảnh).
//   2. ẨN DANH: phản hồi không có tên, SĐT, mã khách, id khách, tên tệp ảnh.
//      Chỉ có nhãn ẩn danh "Nữ, 32 tuổi".
//   3. Sale (chỉ có case_study.read) chỉ thấy case ĐÃ XUẤT BẢN (đủ hai cổng duyệt
//      chuyên môn và truyền thông). Bác sĩ, quản lý thấy cả nháp để duyệt.

const router = Router();
router.use(requireAuth);

type Req = Request;

/** Nhãn ẩn danh từ giới tính và tuổi, không bao giờ dùng tên. */
export function anonymLabelOf(c: { gender: string | null; dob: Date | null }, now = new Date()): string {
  const g = c.gender === "FEMALE" ? "Nữ" : c.gender === "MALE" ? "Nam" : "Khách";
  if (!c.dob) return g;
  let age = now.getUTCFullYear() - c.dob.getUTCFullYear();
  const m = now.getUTCMonth() - c.dob.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < c.dob.getUTCDate())) age--;
  // Làm tròn về nhóm 5 tuổi để khó nhận diện hơn.
  const band = Math.floor(age / 5) * 5;
  return age > 0 ? `${g}, ${band} đến ${band + 4} tuổi` : g;
}

const canManage = (req: Req) => hasPermission(req, "case_study.create") || hasPermission(req, "case_study.approve");

function caseWhere(req: Req): Record<string, unknown> {
  const me = currentUser(req);
  const scope = scopeOf(req, "case_study.read");
  const and: Record<string, unknown>[] = [{ status: { notIn: [CaseStudyStatus.WITHDRAWN, CaseStudyStatus.REJECTED] } }];
  if (scope !== PermissionScope.ALL) and.push({ branchId: { in: me.branchIds } });
  if (!canManage(req)) and.push({ status: CaseStudyStatus.PUBLISHED });
  return { AND: and };
}

/** Ảnh ĐƯỢC PHÉP hiện của một case: bộ ảnh của khách (theo lần thực hiện nếu có) có đồng ý marketing. */
async function consentedPhotos(c: { customerId: string | null; procedureId: string | null }) {
  if (!c.customerId) return [];
  const sets = await prisma.photoSet.findMany({
    where: {
      customerId: c.customerId,
      consentForMarketing: true,
      ...(c.procedureId ? { OR: [{ procedureId: c.procedureId }, { procedureId: null }] } : {}),
    },
    orderBy: { takenAt: "asc" },
    select: { id: true, stage: true, takenAt: true, photos: { select: { id: true, angle: true } } },
  });
  return sets.flatMap((s) => s.photos.map((p) => ({ id: p.id, stage: s.stage, angle: p.angle, takenAt: s.takenAt })));
}

type CaseRow = Awaited<ReturnType<typeof loadCases>>[number];
async function loadCases(where: Record<string, unknown>, query: unknown) {
  return prisma.caseStudy.findMany({
    where,
    orderBy: [{ publishedAt: "desc" }, { createdAt: "desc" }],
    ...pageQuery(query, { defaultLimit: 50, maxLimit: 200 }),
    include: {
      service: { select: { id: true, name: true } },
      doctor: { select: { id: true, name: true } },
      branch: { select: { id: true, name: true } },
    },
  });
}

/** Dạng công bố: KHÔNG có customerId, procedureId, tên khách, SĐT. */
async function present(c: CaseRow) {
  const photos = await consentedPhotos(c);
  return {
    id: c.id,
    title: c.title,
    anonymLabel: c.anonymLabel,
    summary: c.summary,
    beforeNote: c.beforeNote,
    afterNote: c.afterNote,
    status: c.status,
    service: c.service,
    doctor: c.doctor,
    branch: c.branch,
    medicalApprovedAt: c.medicalApprovedAt,
    marketingApprovedAt: c.marketingApprovedAt,
    publishedAt: c.publishedAt,
    createdAt: c.createdAt,
    photos: photos.map((p) => ({ id: p.id, stage: p.stage, angle: p.angle, takenAt: p.takenAt })),
  };
}

/** GET /api/cases?serviceId=: thư viện case ẩn danh. */
router.get(
  "/",
  requirePermission("case_study.read"),
  asyncHandler(async (req, res) => {
    const serviceId = req.query.serviceId ? z.string().uuid().parse(req.query.serviceId) : undefined;
    const where = { AND: [caseWhere(req), ...(serviceId ? [{ serviceId }] : [])] };
    const rows = await loadCases(where, req.query);
    const items = [];
    for (const r of rows) {
      const p = await present(r);
      // Case không còn ảnh đồng ý nào thì sale không thấy (không có gì để cho khách xem).
      if (!p.photos.length && !canManage(req)) continue;
      items.push(p);
    }
    const services = await prisma.service.findMany({
      where: { caseStudies: { some: caseWhere(req) } },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    });
    res.json({ items, services, canManage: canManage(req) });
  })
);

/** GET /api/cases/:caseId/photos/:photoId: ảnh đã giải mã, chỉ khi ảnh thuộc bộ có đồng ý marketing. */
router.get(
  "/:caseId/photos/:photoId",
  requirePermission("case_study.read"),
  asyncHandler(async (req, res) => {
    const c = await prisma.caseStudy.findFirst({ where: { id: req.params.caseId, ...caseWhere(req) } });
    if (!c) throw notFound();
    const allowed = await consentedPhotos(c);
    if (!allowed.some((p) => p.id === req.params.photoId)) throw notFound("Ảnh không có trong thư viện");
    const photo = await prisma.photoAsset.findUniqueOrThrow({ where: { id: req.params.photoId } });
    await writeAccessLog({
      req,
      customerId: c.customerId,
      branchId: c.branchId,
      resourceType: AccessResourceType.PHOTO,
      resourceId: photo.id,
      severity: AccessSeverity.NORMAL,
      reason: "Xem ảnh thư viện case (đã đồng ý marketing)",
      rowCount: 1,
    });
    res.setHeader("Content-Type", photo.mimeType);
    res.setHeader("Cache-Control", "no-store, private");
    res.send(getDecrypted(photo.storageKey, photo.encIv, photo.encTag));
  })
);

/** POST /api/cases: bác sĩ, quản lý tạo case từ khách (và lần thực hiện) đã có ảnh đồng ý marketing. */
router.post(
  "/",
  requirePermission("case_study.create"),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        customerId: z.string().uuid(),
        procedureId: z.string().uuid().optional().nullable(),
        serviceId: z.string().uuid().optional().nullable(),
        title: z.string().trim().min(3).max(200),
        summary: z.string().trim().max(2000).optional().nullable(),
        beforeNote: z.string().trim().max(1000).optional().nullable(),
        afterNote: z.string().trim().max(1000).optional().nullable(),
      })
      .parse(req.body);
    const me = currentUser(req);
    const customer = await prisma.customer.findUnique({ where: { id: body.customerId }, select: { id: true, code: true, gender: true, dob: true, name: true, phone: true } });
    if (!customer) throw notFound("Không tìm thấy khách");
    const procedure = body.procedureId
      ? await prisma.procedureRecord.findUnique({ where: { id: body.procedureId }, select: { id: true, customerId: true, serviceId: true, branchId: true, surgeonId: true } })
      : null;
    if (body.procedureId && (!procedure || procedure.customerId !== customer.id)) throw new HttpError(400, "Lần thực hiện không thuộc khách này");
    const photos = await consentedPhotos({ customerId: customer.id, procedureId: procedure?.id ?? null });
    if (!photos.length) throw new HttpError(400, "Khách chưa có bộ ảnh nào được đồng ý dùng làm marketing");
    // Chữ tự do không được chứa tên hay SĐT khách.
    const texts = [body.title, body.summary, body.beforeNote, body.afterNote].filter(Boolean).join(" ").toLowerCase();
    const phoneDigits = (customer.phone ?? "").replace(/\D/g, "");
    if ((customer.name && customer.name.trim().length >= 3 && texts.includes(customer.name.trim().toLowerCase())) || (phoneDigits.length >= 9 && texts.replace(/\D/g, "").includes(phoneDigits))) {
      throw new HttpError(400, "Nội dung case có tên hoặc SĐT của khách, hãy viết ẩn danh");
    }
    const branchId = procedure?.branchId ?? me.activeBranchId;
    if (!branchId || !me.branchIds.includes(branchId)) throw notFound();
    const c = await prisma.caseStudy.create({
      data: {
        branchId,
        customerId: customer.id,
        procedureId: procedure?.id ?? null,
        serviceId: body.serviceId ?? procedure?.serviceId ?? null,
        doctorId: procedure?.surgeonId ?? me.id,
        title: body.title,
        anonymLabel: anonymLabelOf(customer),
        summary: body.summary ?? null,
        beforeNote: body.beforeNote ?? null,
        afterNote: body.afterNote ?? null,
        status: CaseStudyStatus.PENDING_MEDICAL,
        createdById: me.id,
      },
    });
    await writeAudit({ req, action: AuditAction.CREATE, entity: "CaseStudy", entityId: c.id, branchId, summary: `Tạo case "${c.title}" (khách ${customer.code})` });
    res.status(201).json({ id: c.id, status: c.status, anonymLabel: c.anonymLabel, photoCount: photos.length });
  })
);

/** POST /api/cases/:id/approve { gate: MEDICAL | MARKETING }: đủ hai cổng thì xuất bản. */
router.post(
  "/:id/approve",
  requirePermission("case_study.approve"),
  asyncHandler(async (req, res) => {
    const { gate } = z.object({ gate: z.enum(["MEDICAL", "MARKETING"]) }).parse(req.body);
    const c = await prisma.caseStudy.findFirst({ where: { id: req.params.id, ...caseWhere(req) } });
    if (!c) throw notFound();
    const me = currentUser(req);
    const now = new Date();
    const medicalAt = gate === "MEDICAL" ? now : c.medicalApprovedAt;
    const marketingAt = gate === "MARKETING" ? now : c.marketingApprovedAt;
    const status = medicalAt && marketingAt ? CaseStudyStatus.PUBLISHED : medicalAt ? CaseStudyStatus.PENDING_MARKETING : CaseStudyStatus.PENDING_MEDICAL;
    const updated = await prisma.caseStudy.update({
      where: { id: c.id },
      data: {
        ...(gate === "MEDICAL" ? { medicalApprovedById: me.id, medicalApprovedAt: now } : { marketingApprovedById: me.id, marketingApprovedAt: now }),
        status,
        publishedAt: status === CaseStudyStatus.PUBLISHED ? (c.publishedAt ?? now) : null,
      },
    });
    await writeAudit({
      req,
      action: AuditAction.APPROVE,
      entity: "CaseStudy",
      entityId: c.id,
      branchId: c.branchId,
      summary: `Duyệt ${gate === "MEDICAL" ? "chuyên môn" : "truyền thông"} case "${c.title}"${status === CaseStudyStatus.PUBLISHED ? ", đã xuất bản" : ""}`,
    });
    res.json({ id: updated.id, status: updated.status, publishedAt: updated.publishedAt });
  })
);

/** POST /api/cases/:id/withdraw { reason }: gỡ case (khách rút đồng ý, sai sót...). */
router.post(
  "/:id/withdraw",
  requirePermission("case_study.update"),
  asyncHandler(async (req, res) => {
    const { reason } = z.object({ reason: z.string().trim().min(3).max(300) }).parse(req.body);
    const c = await prisma.caseStudy.findFirst({ where: { id: req.params.id, ...caseWhere(req) } });
    if (!c) throw notFound();
    await prisma.caseStudy.update({ where: { id: c.id }, data: { status: CaseStudyStatus.WITHDRAWN, withdrawnAt: new Date(), withdrawReason: reason } });
    await writeAudit({ req, action: AuditAction.UPDATE, entity: "CaseStudy", entityId: c.id, branchId: c.branchId, summary: `Gỡ case "${c.title}": ${reason}` });
    res.json({ ok: true });
  })
);

export default router;
