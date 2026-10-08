import { Router } from "express";
import { asyncHandler } from "../middleware/errorHandler";
import { requireAuth } from "../middleware/auth";
import { getSettingBool, getSettingNumber, getSettingRaw } from "../lib/settings-catalog";
import { INJECTION_STAGES, LOST_REASONS, SURGERY_STAGES, getClinicMode, stagesFor } from "../lib/stages";
import { isAiConfigured } from "../lib/ai";
import { ClinicMode, ConsentType, PhotoStage } from "../types/enums";
import { prisma } from "../lib/prisma";
import { ND13_BODY, ND13_TITLE } from "../lib/consent-templates";

// F6: cấu hình phòng khám cho MỌI người đăng nhập (không phải khu cài đặt):
// chế độ tiêm/phẫu thuật, bộ bước của khách, lý do mất khách, nhãn giao diện.
// Giao diện đọc cái này để ẩn menu phẫu thuật và đổi tên thuật ngữ.

const router = Router();
router.use(requireAuth);

const TERMS: Record<ClinicMode, Record<string, string>> = {
  INJECTION: {
    medicalRecord: "Hồ sơ điều trị",
    postOp: "Chăm sóc sau tiêm",
    procedure: "Ca thực hiện",
    procedures: "Ca thực hiện",
  },
  SURGERY: {
    medicalRecord: "Bệnh án",
    postOp: "Hậu phẫu",
    procedure: "Ca mổ",
    procedures: "Hồ sơ phẫu thuật",
  },
};

const PHOTO_STAGES: Record<ClinicMode, string[]> = {
  INJECTION: [PhotoStage.D0, PhotoStage.D7, PhotoStage.D30, PhotoStage.CONSULT, PhotoStage.CHAT, PhotoStage.OTHER],
  SURGERY: [
    PhotoStage.PRE_OP,
    PhotoStage.INTRA_OP,
    PhotoStage.D1,
    PhotoStage.D7,
    PhotoStage.M1,
    PhotoStage.M3,
    PhotoStage.M6,
    PhotoStage.CHAT,
    PhotoStage.OTHER,
  ],
};

/** GET /api/clinic/config */
router.get(
  "/config",
  asyncHandler(async (_req, res) => {
    const mode = await getClinicMode();
    res.json({
      mode,
      name: await getSettingRaw("clinic.name"),
      stages: stagesFor(mode),
      /** Nhãn của cả hai bộ: dữ liệu cũ chưa chuyển bộ bước vẫn hiện đúng tên. */
      allStages: [...INJECTION_STAGES, ...SURGERY_STAGES.filter((s) => !INJECTION_STAGES.some((i) => i.key === s.key))],
      lostReasons: LOST_REASONS,
      terms: TERMS[mode],
      photoStages: PHOTO_STAGES[mode],
      ai: {
        configured: isAiConfigured(),
        extractEnabled: await getSettingBool("ai.extractEnabled"),
        suggestEnabled: await getSettingBool("ai.suggestEnabled"),
        summaryEnabled: await getSettingBool("ai.summaryEnabled"),
      },
      inbox: { waitingAlertMinutes: await getSettingNumber("inbox.waitingAlertMinutes") },
      pricing: { singlePriceList: await getSettingBool("pricing.singlePriceList") },
      deposit: { defaultAmount: await getSettingNumber("deposit.defaultAmount") },
    });
  })
);

/** GET /api/clinic/consent-templates — Mẫu biểu, gồm mẫu đồng ý xử lý dữ liệu (Nghị định 13/2023). */
router.get(
  "/consent-templates",
  asyncHandler(async (_req, res) => {
    const rows = await prisma.consentTemplate.findMany({ where: { active: true }, orderBy: { title: "asc" } });
    const hasNd13 = rows.some((r) => r.code === "ND13-XU-LY-DU-LIEU");
    res.json([
      ...(hasNd13
        ? []
        : [{ id: "nd13-mac-dinh", code: "ND13-XU-LY-DU-LIEU", type: ConsentType.DATA_PRIVACY, title: ND13_TITLE, bodyText: ND13_BODY }]),
      ...rows.map((r) => ({ id: r.id, code: r.code, type: r.type, title: r.title, bodyText: r.bodyText })),
    ]);
  })
);

export default router;
