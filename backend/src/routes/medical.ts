import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { asyncHandler, HttpError } from "../middleware/errorHandler";
import { requireAuth, currentUser } from "../middleware/auth";
import { requirePermission, hasPermission, notFound } from "../middleware/rbac";
import { writeAudit, writeAccessLog } from "../lib/audit";
import { withCode, CodePrefix } from "../lib/codes";
import { putEncrypted, getDecrypted, removeStored } from "../lib/storage";
import {
  loadMedicalRecord,
  resolveMedicalScope,
  grantBreakGlass,
  hasActiveBreakGlass,
} from "../lib/medical-scope";
import {
  AuditAction,
  ActivityType,
  AccessResourceType,
  AccessSeverity,
  ConsentStatus,
  ConsentType,
  PhotoStage,
} from "../types/enums";

// Bệnh án, dị ứng, chống chỉ định, cam kết, ảnh trước-sau.
//
// Ba quy tắc bất di bất dịch ở phân hệ này:
//   1. CÁCH LY THEO CƠ SỞ — đi qua lib/medical-scope.ts, trả 404 khi vượt.
//   2. MỌI LẦN ĐỌC ĐỀU GHI DataAccessLog, kể cả đọc thành công.
//   3. ẢNH KHÔNG BAO GIỜ NẰM THÔ — mã hoá trên đĩa, phát từng lần qua API có
//      kiểm quyền, tải về cần quyền riêng `photo.download`.

const router = Router();
router.use(requireAuth);

// Ảnh giữ trong RAM rồi mã hoá ngay, không ghi tệp tạm chưa mã hoá xuống đĩa.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 12 },
});

// ---------------------------------------------------------------- BREAK-GLASS

router.post(
  "/break-glass",
  requirePermission("medical.break_glass"),
  asyncHandler(async (req, res) => {
    const body = z
      .object({ customerId: z.string().uuid(), reason: z.string().min(10) })
      .parse(req.body);

    const customer = await prisma.customer.findUnique({ where: { id: body.customerId } });
    if (!customer) throw notFound("Không tìm thấy khách");

    const grant = await grantBreakGlass(req, body.customerId, body.reason);
    res.status(201).json({ expiresAt: grant.expiresAt, minutes: Math.round((grant.expiresAt.getTime() - Date.now()) / 60000) });
  })
);

// ------------------------------------------------------------------ BỆNH ÁN

// GET /api/medical/records/:customerId
router.get(
  "/records/:customerId",
  requirePermission("medical.read"),
  asyncHandler(async (req, res) => {
    const record = await loadMedicalRecord(req, req.params.customerId);

    const [full, entries, allergies, contraindications] = await Promise.all([
      prisma.medicalRecord.findUnique({
        where: { id: record.id },
        include: {
          doctor: { select: { id: true, name: true, title: true } },
          branch: { select: { id: true, code: true, shortName: true } },
        },
      }),
      prisma.medicalRecordEntry.findMany({
        where: { recordId: record.id },
        orderBy: { createdAt: "desc" },
        take: 100,
      }),
      prisma.allergy.findMany({ where: { recordId: record.id } }),
      prisma.contraindication.findMany({ where: { recordId: record.id } }),
    ]);

    // Tư vấn viên chỉ thấy phần liên quan bán hàng: dị ứng, chống chỉ định.
    // Không thấy chẩn đoán, phiếu mổ, phiếu gây mê (mục 4.3 chú thích **).
    const restricted = !hasPermission(req, "medical.update");

    res.json({
      ...full,
      allergies,
      contraindications,
      entries: restricted ? [] : entries,
      restricted,
    });
  })
);

const recordSchema = z.object({
  customerId: z.string().uuid(),
  branchId: z.string().uuid().optional(),
  bloodType: z.string().optional().nullable(),
  chronicDisease: z.string().optional().nullable(),
  currentMedication: z.string().optional().nullable(),
  smoking: z.boolean().optional(),
  pregnancyNote: z.string().optional().nullable(),
  pastAesthetic: z.string().optional().nullable(),
  doctorId: z.string().uuid().optional().nullable(),
});

router.post(
  "/records",
  requirePermission("medical.create"),
  asyncHandler(async (req, res) => {
    const body = recordSchema.parse(req.body);
    const me = currentUser(req);
    const branchId = body.branchId ?? me.activeBranchId;
    if (!branchId) throw new HttpError(400, "Chưa xác định được cơ sở");
    if (!me.branchIds.includes(branchId)) throw notFound();

    const existing = await prisma.medicalRecord.findUnique({
      where: { customerId_branchId: { customerId: body.customerId, branchId } },
    });
    if (existing) throw new HttpError(409, "Khách đã có bệnh án tại cơ sở này");

    const { customerId, branchId: _ignored, ...rest } = body;
    const record = await withCode(CodePrefix.MEDICAL_RECORD, (code) =>
      prisma.medicalRecord.create({
        data: { ...rest, code, customerId, branchId, doctorId: body.doctorId ?? me.id },
      })
    );

    await prisma.activity.create({
      data: {
        customerId,
        type: ActivityType.MEDICAL,
        content: `${me.name} mở bệnh án ${record.code}`,
        userId: me.id,
        userName: me.name,
      },
    });

    await writeAudit({
      req,
      action: AuditAction.CREATE,
      entity: "MedicalRecord",
      entityId: record.id,
      branchId,
      summary: `Mở bệnh án ${record.code}`,
    });
    res.status(201).json(record);
  })
);

router.patch(
  "/records/:id",
  requirePermission("medical.update"),
  asyncHandler(async (req, res) => {
    const body = recordSchema.partial().omit({ customerId: true, branchId: true }).parse(req.body);
    const me = currentUser(req);
    const before = await prisma.medicalRecord.findUnique({ where: { id: req.params.id } });
    if (!before) throw notFound("Không tìm thấy bệnh án");
    if (!me.branchIds.includes(before.branchId) && !(await hasActiveBreakGlass(me.id, before.customerId))) {
      throw notFound();
    }

    const record = await prisma.medicalRecord.update({ where: { id: req.params.id }, data: body });
    await writeAudit({
      req,
      action: AuditAction.UPDATE,
      entity: "MedicalRecord",
      entityId: record.id,
      branchId: record.branchId,
      summary: `Sửa bệnh án ${record.code}`,
    });
    res.json(record);
  })
);

// POST /api/medical/records/:id/entries — ghi chú khám, chẩn đoán
router.post(
  "/records/:id/entries",
  requirePermission("medical.update"),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        kind: z.enum(["EXAM", "DIAGNOSIS", "NOTE", "PLAN"]).optional(),
        content: z.string().min(2),
      })
      .parse(req.body);

    const me = currentUser(req);
    const record = await prisma.medicalRecord.findUnique({ where: { id: req.params.id } });
    if (!record) throw notFound("Không tìm thấy bệnh án");
    if (!me.branchIds.includes(record.branchId)) throw notFound();

    const entry = await prisma.medicalRecordEntry.create({
      data: {
        recordId: record.id,
        kind: body.kind ?? "EXAM",
        content: body.content,
        authorId: me.id,
        authorName: me.name,
      },
    });

    await writeAudit({
      req,
      action: AuditAction.CREATE,
      entity: "MedicalRecordEntry",
      entityId: entry.id,
      branchId: record.branchId,
      summary: `Ghi bệnh án ${record.code}: ${body.kind ?? "EXAM"}`,
    });
    res.status(201).json(entry);
  })
);

// POST /api/medical/records/:id/allergies
router.post(
  "/records/:id/allergies",
  requirePermission("medical.update"),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        substance: z.string().min(1),
        reaction: z.string().optional(),
        severity: z.string().optional(),
        note: z.string().optional(),
      })
      .parse(req.body);

    const me = currentUser(req);
    const record = await prisma.medicalRecord.findUnique({ where: { id: req.params.id } });
    if (!record || !me.branchIds.includes(record.branchId)) throw notFound();

    const allergy = await prisma.allergy.create({ data: { ...body, recordId: record.id } });
    await writeAudit({
      req,
      action: AuditAction.CREATE,
      entity: "Allergy",
      entityId: allergy.id,
      branchId: record.branchId,
      summary: `Thêm dị ứng "${body.substance}" vào bệnh án ${record.code}`,
    });
    res.status(201).json(allergy);
  })
);

// POST /api/medical/records/:id/contraindications
router.post(
  "/records/:id/contraindications",
  requirePermission("medical.update"),
  asyncHandler(async (req, res) => {
    const body = z
      .object({ content: z.string().min(2), blocking: z.boolean().optional(), note: z.string().optional() })
      .parse(req.body);

    const me = currentUser(req);
    const record = await prisma.medicalRecord.findUnique({ where: { id: req.params.id } });
    if (!record || !me.branchIds.includes(record.branchId)) throw notFound();

    const row = await prisma.contraindication.create({ data: { ...body, recordId: record.id } });
    await writeAudit({
      req,
      action: AuditAction.CREATE,
      entity: "Contraindication",
      entityId: row.id,
      branchId: record.branchId,
      summary: `Thêm chống chỉ định vào bệnh án ${record.code}${body.blocking ? " (CHẶN ca mổ)" : ""}`,
    });
    res.status(201).json(row);
  })
);

// ---------------------------------------------------------------- CAM KẾT

router.get(
  "/consents",
  requirePermission("medical.read"),
  asyncHandler(async (req, res) => {
    const customerId = z.string().uuid().parse(req.query.customerId);
    const { branchIds } = await resolveMedicalScope(req, customerId);

    const forms = await prisma.consentForm.findMany({
      where: { customerId, ...(branchIds ? { branchId: { in: branchIds } } : {}) },
      orderBy: { createdAt: "desc" },
      include: { staff: { select: { id: true, name: true } } },
    });

    await writeAccessLog({
      req,
      customerId,
      resourceType: AccessResourceType.CONSENT_FORM,
      rowCount: forms.length,
    });

    // Không bao giờ trả khoá tệp chữ ký ra ngoài.
    res.json(forms.map((f) => ({ ...f, signatureKey: undefined, hasSignature: Boolean(f.signatureKey) })));
  })
);

router.post(
  "/consents",
  requirePermission("medical.create"),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        customerId: z.string().uuid(),
        branchId: z.string().uuid().optional(),
        procedureId: z.string().uuid().optional(),
        type: z.nativeEnum(ConsentType).optional(),
        title: z.string().min(2),
        bodyText: z.string().min(10),
      })
      .parse(req.body);

    const me = currentUser(req);
    const branchId = body.branchId ?? me.activeBranchId;
    if (!branchId || !me.branchIds.includes(branchId)) throw notFound();

    const form = await prisma.consentForm.create({
      data: { ...body, branchId, type: body.type ?? ConsentType.SURGERY, staffId: me.id },
    });
    await writeAudit({
      req,
      action: AuditAction.CREATE,
      entity: "ConsentForm",
      entityId: form.id,
      branchId,
      summary: `Tạo cam kết "${form.title}"`,
    });
    res.status(201).json({ ...form, signatureKey: undefined });
  })
);

/**
 * POST /api/medical/consents/:id/sign
 * Ảnh chữ ký gửi lên dạng multipart. Chữ ký là dữ liệu định danh mạnh nên đi
 * cùng đường mã hoá với ảnh trước-sau.
 */
router.post(
  "/consents/:id/sign",
  requirePermission("medical.update"),
  upload.single("signature"),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const form = await prisma.consentForm.findUnique({ where: { id: req.params.id } });
    if (!form || !me.branchIds.includes(form.branchId)) throw notFound();
    if (form.status === ConsentStatus.SIGNED) throw new HttpError(409, "Cam kết đã được ký");

    let signatureKey: string | null = null;
    if (req.file) {
      const stored = putEncrypted(`consents/${form.customerId}`, req.file.originalname, req.file.buffer);
      signatureKey = stored.storageKey;
    }

    const signed = await prisma.consentForm.update({
      where: { id: form.id },
      data: { status: ConsentStatus.SIGNED, signedAt: new Date(), signatureKey, staffId: me.id },
    });

    await prisma.activity.create({
      data: {
        customerId: form.customerId,
        type: ActivityType.MEDICAL,
        content: `Khách ký cam kết "${form.title}" (nhân viên chứng kiến: ${me.name})`,
        userId: me.id,
        userName: me.name,
      },
    });

    await writeAudit({
      req,
      action: AuditAction.APPROVE,
      entity: "ConsentForm",
      entityId: form.id,
      branchId: form.branchId,
      summary: `Ký cam kết "${form.title}"`,
    });
    res.json({ ...signed, signatureKey: undefined, hasSignature: Boolean(signatureKey) });
  })
);

// ------------------------------------------------------------ ẢNH TRƯỚC-SAU

router.get(
  "/photo-sets",
  requirePermission("photo.read"),
  asyncHandler(async (req, res) => {
    const customerId = z.string().uuid().parse(req.query.customerId);
    const { branchIds } = await resolveMedicalScope(req, customerId, "photo.read");

    const sets = await prisma.photoSet.findMany({
      where: { customerId, ...(branchIds ? { branchId: { in: branchIds } } : {}) },
      orderBy: { takenAt: "desc" },
      include: {
        photos: { select: { id: true, fileName: true, angle: true, mimeType: true, size: true } },
        takenBy: { select: { id: true, name: true } },
      },
    });

    await writeAccessLog({
      req,
      customerId,
      resourceType: AccessResourceType.PHOTO,
      rowCount: sets.reduce((s, x) => s + x.photos.length, 0),
    });

    res.json(sets);
  })
);

router.post(
  "/photo-sets",
  requirePermission("photo.create"),
  upload.array("photos", 12),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        customerId: z.string().uuid(),
        branchId: z.string().uuid().optional(),
        procedureId: z.string().uuid().optional(),
        stage: z.nativeEnum(PhotoStage),
        note: z.string().optional(),
      })
      .parse(req.body);

    const me = currentUser(req);
    const branchId = body.branchId ?? me.activeBranchId;
    if (!branchId || !me.branchIds.includes(branchId)) throw notFound();

    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    if (!files.length) throw new HttpError(400, "Chưa chọn ảnh nào");

    const set = await prisma.photoSet.create({
      data: {
        customerId: body.customerId,
        branchId,
        procedureId: body.procedureId,
        stage: body.stage,
        note: body.note,
        takenById: me.id,
      },
    });

    for (const file of files) {
      const stored = putEncrypted(`photos/${body.customerId}`, file.originalname, file.buffer);
      await prisma.photoAsset.create({
        data: {
          photoSetId: set.id,
          storageKey: stored.storageKey,
          fileName: file.originalname,
          mimeType: file.mimetype,
          size: stored.size,
          encIv: stored.iv,
          encTag: stored.tag,
        },
      });
    }

    await writeAudit({
      req,
      action: AuditAction.CREATE,
      entity: "PhotoSet",
      entityId: set.id,
      branchId,
      summary: `Thêm ${files.length} ảnh mốc ${body.stage}`,
    });
    await writeAccessLog({
      req,
      customerId: body.customerId,
      resourceType: AccessResourceType.PHOTO,
      resourceId: set.id,
      rowCount: files.length,
    });

    res.status(201).json({ id: set.id, photoCount: files.length });
  })
);

/**
 * GET /api/medical/photos/:id/content
 * Trả nội dung ảnh đã giải mã. KHÔNG có URL tĩnh nào tới ảnh — mỗi lần xem đều
 * đi qua đây, đều kiểm quyền và đều ghi log. `?download=1` cần quyền riêng
 * `photo.download` (mục 4.4).
 */
router.get(
  "/photos/:id/content",
  requirePermission("photo.read"),
  asyncHandler(async (req, res) => {
    const wantsDownload = req.query.download === "1";
    if (wantsDownload && !hasPermission(req, "photo.download")) {
      throw new HttpError(403, "Không có quyền tải ảnh về máy");
    }

    const photo = await prisma.photoAsset.findUnique({
      where: { id: req.params.id },
      include: { photoSet: { select: { customerId: true, branchId: true } } },
    });
    if (!photo) throw notFound("Không tìm thấy ảnh");

    const { branchIds } = await resolveMedicalScope(req, photo.photoSet.customerId, "photo.read");
    if (branchIds && !branchIds.includes(photo.photoSet.branchId)) throw notFound();

    await writeAccessLog({
      req,
      customerId: photo.photoSet.customerId,
      branchId: photo.photoSet.branchId,
      resourceType: AccessResourceType.PHOTO,
      resourceId: photo.id,
      severity: wantsDownload ? AccessSeverity.ELEVATED : AccessSeverity.NORMAL,
      rowCount: 1,
    });

    const data = getDecrypted(photo.storageKey, photo.encIv, photo.encTag);
    res.setHeader("Content-Type", photo.mimeType);
    res.setHeader("Cache-Control", "no-store, private");
    if (wantsDownload) {
      res.setHeader("Content-Disposition", `attachment; filename="${photo.fileName}"`);
    }
    res.send(data);
  })
);

router.delete(
  "/photos/:id",
  requirePermission("photo.delete"),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const photo = await prisma.photoAsset.findUnique({
      where: { id: req.params.id },
      include: { photoSet: { select: { customerId: true, branchId: true } } },
    });
    if (!photo || !me.branchIds.includes(photo.photoSet.branchId)) throw notFound();

    await prisma.photoAsset.delete({ where: { id: photo.id } });
    removeStored(photo.storageKey);

    await writeAudit({
      req,
      action: AuditAction.DELETE,
      entity: "PhotoAsset",
      entityId: photo.id,
      branchId: photo.photoSet.branchId,
      summary: `Xoá ảnh ${photo.fileName}`,
    });
    res.json({ ok: true });
  })
);

export default router;
