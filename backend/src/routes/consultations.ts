import { Router, type Request } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { pageQuery } from "../lib/pagination";
import { asyncHandler, HttpError } from "../middleware/errorHandler";
import { requireAuth, currentUser } from "../middleware/auth";
import { assertInScope, hasPermission, maskCustomerPhonesInResponse, notFound, requirePermission, scopedWhere } from "../middleware/rbac";
import { writeAudit, writeAccessLog } from "../lib/audit";
import { createUpload, verifyFileSignatures } from "../lib/upload";
import { putEncrypted } from "../lib/storage";
import { applyStageEventSafe } from "../lib/stages";
import { currentOpportunityId } from "../lib/opportunities";
import { currentListPrice, discountCapPercent, evaluatePricing, initialApprovalStatus, lineData } from "../lib/pricing";
import { withCode, CodePrefix } from "../lib/codes";
import { formatVnd } from "../lib/datetime";
import { RoleCode } from "../lib/rbac-catalog";
import {
  FACE_AREA_LABEL,
  enrichProposals,
  parseFaceAreas,
  parseProposals,
  planItemLabel,
  proposalInputSchema,
} from "../lib/consultation";
import { AccessResourceType, ActivityType, AuditAction, FaceArea, PhotoStage, StageEvent, TreatmentPlanStatus } from "../types/enums";

// F30: PHIẾU TƯ VẤN, PHÁC ĐỒ, BÁO GIÁ TỪ PHÁC ĐỒ (/api/consultations).
// Bác sĩ, tư vấn viên, quản lý lập phiếu (consultation.create); vai khác chỉ xem.

const router = Router();
router.use(requireAuth);
router.use(maskCustomerPhonesInResponse);

const SCOPE = { ownerFields: ["consultantId", "doctorId", "createdById"], branchField: "branchId" };
const upload = createUpload({ kinds: ["image"], maxFileSize: 15 * 1024 * 1024, maxFiles: 12 });
const checkImages = verifyFileSignatures(["image"]);

const sessionBody = z.object({
  customerId: z.string().uuid(),
  branchId: z.string().uuid().optional(),
  doctorId: z.string().uuid().optional().nullable(),
  faceAreas: z.array(z.nativeEnum(FaceArea)).max(20).default([]),
  proposals: z.array(proposalInputSchema).max(20).default([]),
  expectation: z.string().trim().max(2000).optional().nullable(),
  budgetNote: z.string().trim().max(500).optional().nullable(),
  readiness: z.string().trim().max(100).optional().nullable(),
  contraindicationNote: z.string().trim().max(1000).optional().nullable(),
  note: z.string().trim().max(2000).optional().nullable(),
});

function resolveBranch(req: Request, requested?: string): string {
  const me = currentUser(req);
  const branchId = requested ?? me.activeBranchId;
  if (!branchId || !me.branchIds.includes(branchId)) throw notFound("Không thuộc cơ sở này");
  return branchId;
}

async function loadSession(req: Request, id: string, code: string) {
  const s = await prisma.consultationSession.findUnique({ where: { id } });
  assertInScope(req, code, s as unknown as Record<string, unknown>, SCOPE);
  return s!;
}

function present(s: {
  faceAreas: string | null;
  proposals: string | null;
}) {
  return { faceAreas: parseFaceAreas(s.faceAreas), proposals: parseProposals(s.proposals) };
}

/** GET /api/consultations/meta: danh mục vùng mặt, dịch vụ đang bán (kèm giá niêm yết), sản phẩm. */
router.get(
  "/meta",
  requirePermission("consultation.read"),
  asyncHandler(async (req, res) => {
    const branchId = resolveBranch(req);
    const [services, products] = await Promise.all([
      prisma.service.findMany({
        where: { active: true },
        orderBy: [{ category: { name: "asc" } }, { name: "asc" }],
        select: { id: true, code: true, name: true, category: { select: { name: true } } },
      }),
      prisma.product.findMany({ where: { active: true, isImplant: false }, orderBy: { name: "asc" }, select: { id: true, name: true, unit: true } }),
    ]);
    const priced = [];
    for (const s of services) priced.push({ ...s, category: s.category?.name ?? null, listPrice: (await currentListPrice(s.id, branchId))?.price ?? null });
    res.json({
      faceAreas: Object.entries(FACE_AREA_LABEL).map(([value, label]) => ({ value, label })),
      services: priced,
      products,
    });
  })
);

router.get(
  "/",
  requirePermission("consultation.read"),
  asyncHandler(async (req, res) => {
    const { where } = scopedWhere(req, "consultation.read", SCOPE);
    const customerId = req.query.customerId ? z.string().uuid().parse(req.query.customerId) : undefined;
    const rows = await prisma.consultationSession.findMany({
      where: { ...where, ...(customerId ? { customerId } : {}) },
      orderBy: { heldAt: "desc" },
      ...pageQuery(req.query, { defaultLimit: 50, maxLimit: 200 }),
      include: {
        customer: { select: { id: true, code: true, name: true, phone: true } },
        doctor: { select: { id: true, name: true } },
        consultant: { select: { id: true, name: true } },
        plans: { select: { id: true, title: true, status: true, quotationId: true } },
      },
    });
    res.json(rows.map((r) => ({ ...r, ...present(r) })));
  })
);

router.get(
  "/:id",
  requirePermission("consultation.read"),
  asyncHandler(async (req, res) => {
    const s = await loadSession(req, req.params.id, "consultation.read");
    const [customer, plans, photoSet] = await Promise.all([
      prisma.customer.findUnique({ where: { id: s.customerId }, select: { id: true, code: true, name: true, phone: true, gender: true, dob: true } }),
      prisma.treatmentPlan.findMany({
        where: { sessionId: s.id },
        orderBy: { createdAt: "asc" },
        include: {
          items: { orderBy: { stepOrder: "asc" } },
          quotation: { select: { id: true, code: true, status: true, total: true, approvalStatus: true } },
        },
      }),
      s.photoSetId && hasPermission(req, "photo.read")
        ? prisma.photoSet.findUnique({ where: { id: s.photoSetId }, select: { id: true, stage: true, takenAt: true, photos: { select: { id: true, angle: true } } } })
        : null,
    ]);
    if (photoSet) {
      await writeAccessLog({ req, customerId: s.customerId, branchId: s.branchId, resourceType: AccessResourceType.PHOTO, resourceId: photoSet.id, rowCount: photoSet.photos.length });
    }
    res.json({ ...s, ...present(s), customer, plans, photoSet });
  })
);

router.post(
  "/",
  requirePermission("consultation.create"),
  asyncHandler(async (req, res) => {
    const body = sessionBody.parse(req.body);
    const me = currentUser(req);
    const branchId = resolveBranch(req, body.branchId);
    const customer = await prisma.customer.findUnique({ where: { id: body.customerId }, select: { id: true, code: true, mergedIntoId: true } });
    if (!customer || customer.mergedIntoId) throw notFound("Không tìm thấy khách");
    const proposals = await enrichProposals(body.proposals, branchId);
    const isDoctor = me.roles.includes(RoleCode.BAC_SI);
    const s = await prisma.consultationSession.create({
      data: {
        branchId,
        customerId: customer.id,
        doctorId: body.doctorId ?? (isDoctor ? me.id : null),
        consultantId: isDoctor ? null : me.id,
        createdById: me.id,
        faceAreas: JSON.stringify(body.faceAreas),
        concernArea: body.faceAreas.map((a) => FACE_AREA_LABEL[a]).join(" · ") || null,
        proposals: JSON.stringify(proposals),
        expectation: body.expectation ?? null,
        budgetNote: body.budgetNote ?? null,
        readiness: body.readiness ?? null,
        contraindicationNote: body.contraindicationNote ?? null,
        note: body.note ?? null,
      },
    });
    await prisma.activity.create({
      data: {
        customerId: customer.id,
        type: ActivityType.SYSTEM,
        content: `${me.name} lập phiếu tư vấn: ${proposals.map((p) => p.serviceName).join(", ") || "chưa có đề xuất"}`,
        userId: me.id,
        userName: me.name,
      },
    });
    await writeAudit({ req, action: AuditAction.CREATE, entity: "ConsultationSession", entityId: s.id, branchId, summary: `Lập phiếu tư vấn cho khách ${customer.code}` });
    res.status(201).json({ ...s, ...present(s) });
  })
);

router.patch(
  "/:id",
  requirePermission("consultation.update"),
  asyncHandler(async (req, res) => {
    const body = sessionBody.partial().omit({ customerId: true, branchId: true }).parse(req.body);
    const s = await loadSession(req, req.params.id, "consultation.update");
    const proposals = body.proposals ? await enrichProposals(body.proposals, s.branchId) : undefined;
    const updated = await prisma.consultationSession.update({
      where: { id: s.id },
      data: {
        ...(body.doctorId !== undefined ? { doctorId: body.doctorId } : {}),
        ...(body.faceAreas ? { faceAreas: JSON.stringify(body.faceAreas), concernArea: body.faceAreas.map((a) => FACE_AREA_LABEL[a]).join(" · ") || null } : {}),
        ...(proposals ? { proposals: JSON.stringify(proposals) } : {}),
        ...(body.expectation !== undefined ? { expectation: body.expectation } : {}),
        ...(body.budgetNote !== undefined ? { budgetNote: body.budgetNote } : {}),
        ...(body.readiness !== undefined ? { readiness: body.readiness } : {}),
        ...(body.contraindicationNote !== undefined ? { contraindicationNote: body.contraindicationNote } : {}),
        ...(body.note !== undefined ? { note: body.note } : {}),
      },
    });
    await writeAudit({ req, action: AuditAction.UPDATE, entity: "ConsultationSession", entityId: s.id, branchId: s.branchId, summary: "Sửa phiếu tư vấn" });
    res.json({ ...updated, ...present(updated) });
  })
);

// ------------------------------------------------------------ ẢNH TRƯỚC

/** POST /api/consultations/:id/photos (multipart "photos"): chụp, đính ảnh "trước" vào bộ ảnh CONSULT của phiếu. */
router.post(
  "/:id/photos",
  requirePermission("consultation.update"),
  requirePermission("photo.create"),
  upload.array("photos", 12),
  checkImages,
  asyncHandler(async (req, res) => {
    const s = await loadSession(req, req.params.id, "consultation.update");
    const me = currentUser(req);
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    if (!files.length) throw new HttpError(400, "Chưa chọn ảnh nào");
    const angle = z.enum(["front", "left45", "right45", "profile"]).optional().parse(req.body?.angle || undefined);

    let setId = s.photoSetId;
    if (setId && !(await prisma.photoSet.findUnique({ where: { id: setId }, select: { id: true } }))) setId = null;
    if (!setId) {
      const set = await prisma.photoSet.create({
        data: { branchId: s.branchId, customerId: s.customerId, stage: PhotoStage.CONSULT, takenById: me.id, note: "Ảnh trước, chụp trong buổi tư vấn" },
      });
      setId = set.id;
      await prisma.consultationSession.update({ where: { id: s.id }, data: { photoSetId: setId } });
    }
    for (const file of files) {
      const stored = putEncrypted(`photos/${s.customerId}`, file.originalname, file.buffer);
      await prisma.photoAsset.create({
        data: {
          photoSetId: setId,
          storageKey: stored.storageKey,
          fileName: file.originalname,
          mimeType: file.mimetype,
          size: stored.size,
          angle: angle ?? null,
          encIv: stored.iv,
          encTag: stored.tag,
        },
      });
    }
    await writeAudit({ req, action: AuditAction.CREATE, entity: "PhotoSet", entityId: setId, branchId: s.branchId, summary: `Thêm ${files.length} ảnh trước vào phiếu tư vấn` });
    await writeAccessLog({ req, customerId: s.customerId, branchId: s.branchId, resourceType: AccessResourceType.PHOTO, resourceId: setId, rowCount: files.length });
    await applyStageEventSafe(s.customerId, StageEvent.PHOTO, { actor: { id: me.id, name: me.name } });
    res.status(201).json({ photoSetId: setId, added: files.length });
  })
);

// ------------------------------------------------------------ PHÁC ĐỒ

const planItemSchema = proposalInputSchema.extend({ name: z.string().trim().min(1).max(200).optional() });

/** POST /api/consultations/:id/plans: lập phác đồ; không gửi items thì lấy từ đề xuất của phiếu. */
router.post(
  "/:id/plans",
  requirePermission("consultation.create"),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        title: z.string().trim().min(2).max(200).optional(),
        method: z.string().trim().max(1000).optional().nullable(),
        expectedResult: z.string().trim().max(1000).optional().nullable(),
        riskNote: z.string().trim().max(1000).optional().nullable(),
        recoveryDays: z.number().int().min(0).max(365).optional().nullable(),
        note: z.string().trim().max(1000).optional().nullable(),
        items: z.array(planItemSchema).max(20).optional(),
      })
      .parse(req.body ?? {});
    const s = await loadSession(req, req.params.id, "consultation.create");
    const me = currentUser(req);
    const items = body.items
      ? (await enrichProposals(body.items, s.branchId)).map((p, i) => ({ ...p, name: body.items![i].name ?? p.serviceName }))
      : parseProposals(s.proposals).map((p) => ({ ...p, name: p.serviceName }));
    if (!items.length) throw new HttpError(400, "Phiếu chưa có dịch vụ đề xuất để lập phác đồ");
    const plan = await prisma.treatmentPlan.create({
      data: {
        branchId: s.branchId,
        customerId: s.customerId,
        sessionId: s.id,
        doctorId: s.doctorId ?? (me.roles.includes(RoleCode.BAC_SI) ? me.id : null),
        createdById: me.id,
        title: body.title ?? `Phác đồ ${items.map((i) => i.serviceName).join(", ")}`.slice(0, 200),
        method: body.method ?? null,
        expectedResult: body.expectedResult ?? null,
        riskNote: body.riskNote ?? null,
        recoveryDays: body.recoveryDays ?? null,
        note: body.note ?? null,
        status: TreatmentPlanStatus.PROPOSED,
        items: {
          create: items.map((p, idx) => ({
            serviceId: p.serviceId,
            name: p.name,
            stepOrder: idx + 1,
            productId: p.productId,
            productName: p.productName,
            doseTenths: p.doseTenths,
            quantity: p.quantity,
            listPrice: p.listPrice,
            faceArea: p.faceArea,
            note: p.note,
          })),
        },
      },
      include: { items: { orderBy: { stepOrder: "asc" } } },
    });
    await writeAudit({ req, action: AuditAction.CREATE, entity: "TreatmentPlan", entityId: plan.id, branchId: s.branchId, summary: `Lập phác đồ "${plan.title}"` });
    res.status(201).json(plan);
  })
);

async function loadPlan(req: Request, code: string) {
  const plan = await prisma.treatmentPlan.findUnique({ where: { id: req.params.planId }, include: { items: { orderBy: { stepOrder: "asc" } } } });
  if (!plan) throw notFound("Không tìm thấy phác đồ");
  const session = plan.sessionId ? await prisma.consultationSession.findUnique({ where: { id: plan.sessionId } }) : null;
  assertInScope(req, code, (session ?? { ...plan, consultantId: null }) as unknown as Record<string, unknown>, SCOPE);
  return plan;
}

router.patch(
  "/plans/:planId",
  requirePermission("consultation.update"),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        status: z.nativeEnum(TreatmentPlanStatus).optional(),
        title: z.string().trim().min(2).max(200).optional(),
        method: z.string().trim().max(1000).optional().nullable(),
        expectedResult: z.string().trim().max(1000).optional().nullable(),
        riskNote: z.string().trim().max(1000).optional().nullable(),
        note: z.string().trim().max(1000).optional().nullable(),
      })
      .parse(req.body);
    const plan = await loadPlan(req, "consultation.update");
    const updated = await prisma.treatmentPlan.update({ where: { id: plan.id }, data: body });
    await writeAudit({
      req,
      action: AuditAction.UPDATE,
      entity: "TreatmentPlan",
      entityId: plan.id,
      branchId: plan.branchId,
      summary: `Sửa phác đồ "${updated.title}"${body.status ? `, trạng thái ${body.status}` : ""}`,
    });
    res.json(updated);
  })
);

/**
 * POST /api/consultations/plans/:planId/quote: lập báo giá theo GIÁ NIÊM YẾT từ
 * phác đồ và gắn vào phác đồ. Giảm giá (nếu có) sale làm ở báo giá mới theo luật
 * trần giảm F21; báo giá từ phác đồ không có giảm nên không cần duyệt.
 */
router.post(
  "/plans/:planId/quote",
  requirePermission("consultation.update"),
  asyncHandler(async (req, res) => {
    const plan = await loadPlan(req, "consultation.update");
    if (plan.quotationId) throw new HttpError(409, "Phác đồ đã có báo giá");
    const me = currentUser(req);
    const lines = [];
    for (const i of plan.items) {
      if (!i.serviceId) continue;
      const price = await currentListPrice(i.serviceId, plan.branchId);
      if (!price) throw new HttpError(400, `"${i.name}" chưa có giá niêm yết tại cơ sở này`);
      lines.push({ serviceId: i.serviceId, name: planItemLabel(i), quantity: i.quantity, unitPrice: price.price, discount: 0 });
    }
    if (!lines.length) throw new HttpError(400, "Phác đồ không có dịch vụ để báo giá");
    const priced = await evaluatePricing(lines, { branchId: plan.branchId, capPercent: await discountCapPercent(me.roles) });
    const oppIdForQuote = await currentOpportunityId(plan.customerId);
    const quotation = await withCode(CodePrefix.QUOTATION, (code) =>
      prisma.quotation.create({
        data: {
          code,
          branchId: plan.branchId,
          customerId: plan.customerId,
          subtotal: priced.subtotal,
          discount: priced.discount,
          total: priced.total,
          note: `Lập từ phác đồ "${plan.title}"`,
          createdById: me.id,
          opportunityId: oppIdForQuote,
          approvalStatus: initialApprovalStatus(priced.needsApproval),
          items: { create: priced.lines.map(lineData) },
        },
      })
    );
    await prisma.treatmentPlan.update({ where: { id: plan.id }, data: { quotationId: quotation.id } });
    await prisma.activity.create({
      data: {
        customerId: plan.customerId,
        type: ActivityType.QUOTATION,
        content: `${me.name} lập báo giá ${quotation.code} từ phác đồ: ${formatVnd(quotation.total)}đ`,
        userId: me.id,
        userName: me.name,
      },
    });
    await writeAudit({
      req,
      action: AuditAction.CREATE,
      entity: "Quotation",
      entityId: quotation.id,
      branchId: plan.branchId,
      summary: `Lập báo giá ${quotation.code} từ phác đồ "${plan.title}": ${formatVnd(quotation.total)}đ`,
    });
    res.status(201).json({ planId: plan.id, quotation });
  })
);

/** POST /api/consultations/plans/:planId/link-quote { quotationId }: gắn báo giá sẵn có (cùng khách). */
router.post(
  "/plans/:planId/link-quote",
  requirePermission("consultation.update"),
  asyncHandler(async (req, res) => {
    const { quotationId } = z.object({ quotationId: z.string().uuid() }).parse(req.body);
    const plan = await loadPlan(req, "consultation.update");
    const q = await prisma.quotation.findUnique({ where: { id: quotationId }, select: { id: true, code: true, customerId: true, treatmentPlan: { select: { id: true } } } });
    if (!q || q.customerId !== plan.customerId) throw new HttpError(400, "Báo giá không thuộc khách của phác đồ");
    if (q.treatmentPlan && q.treatmentPlan.id !== plan.id) throw new HttpError(409, "Báo giá đã gắn với phác đồ khác");
    await prisma.treatmentPlan.update({ where: { id: plan.id }, data: { quotationId: q.id } });
    await writeAudit({ req, action: AuditAction.UPDATE, entity: "TreatmentPlan", entityId: plan.id, branchId: plan.branchId, summary: `Gắn báo giá ${q.code} vào phác đồ` });
    res.json({ ok: true, planId: plan.id, quotationId: q.id });
  })
);

export default router;
