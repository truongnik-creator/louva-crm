import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { parsePagination } from "../lib/pagination";
import { asyncHandler, HttpError } from "../middleware/errorHandler";
import { requireAuth, currentUser } from "../middleware/auth";
import { requirePermission, notFound } from "../middleware/rbac";
import { writeAudit } from "../lib/audit";
import { getJob, isJobEnabled, listJobs, runJob } from "../lib/jobs";
import { findSetting, getSettingRaw } from "../lib/settings-catalog";
import { RoleCode } from "../lib/rbac-catalog";
import { AuditAction, JobTrigger } from "../types/enums";
import "../lib/automation";

// F8: màn Cài đặt › Nhật ký tác vụ. Xem: settings.read. Chạy tay: chỉ Quản trị
// hệ thống (như sửa Cài đặt). Bật tắt từng quy tắc = sửa khoá Cài đặt của nó
// qua PUT /api/settings.

const router = Router();
router.use(requireAuth);

/** GET /api/automation/jobs — danh sách tác vụ, trạng thái bật, lần chạy gần nhất. */
router.get(
  "/jobs",
  requirePermission("settings.read"),
  asyncHandler(async (_req, res) => {
    const jobs = listJobs();
    const out = [];
    for (const j of jobs) {
      const last = await prisma.jobRun.findFirst({ where: { jobKey: j.key }, orderBy: { startedAt: "desc" } });
      const lastOk = await prisma.jobRun.findFirst({ where: { jobKey: j.key, status: "SUCCESS" }, orderBy: { startedAt: "desc" } });
      out.push({
        key: j.key,
        label: j.label,
        intervalMinutes: Math.round(j.intervalMs / 60_000),
        settingKey: j.settingKey ?? null,
        settingLabel: j.settingKey ? (findSetting(j.settingKey)?.label ?? null) : null,
        switchOn: j.settingKey ? (await getSettingRaw(j.settingKey)) === "true" : true,
        enabled: await isJobEnabled(j),
        lastRun: last,
        lastSuccessAt: lastOk?.finishedAt ?? null,
      });
    }
    res.json({ globalEnabled: (await getSettingRaw("jobs.enabled")) === "true", jobs: out });
  })
);

/** GET /api/automation/runs?jobKey=&status=&limit=&offset= — nhật ký chạy. */
router.get(
  "/runs",
  requirePermission("settings.read"),
  asyncHandler(async (req, res) => {
    const q = z
      .object({ jobKey: z.string().max(80).optional(), status: z.string().max(20).optional() })
      .parse({ jobKey: req.query.jobKey || undefined, status: req.query.status || undefined });
    const page = parsePagination(req.query, { defaultLimit: 50, maxLimit: 200 });
    const where = { ...(q.jobKey ? { jobKey: q.jobKey } : {}), ...(q.status ? { status: q.status } : {}) };
    const [items, total] = await Promise.all([
      prisma.jobRun.findMany({ where, orderBy: { startedAt: "desc" }, take: page.take, skip: page.skip }),
      prisma.jobRun.count({ where }),
    ]);
    res.json({ total, items });
  })
);

/** POST /api/automation/jobs/:key/run — chạy ngay (kể cả đang tắt), có khoá chống chạy chồng. */
router.post(
  "/jobs/:key/run",
  requirePermission("settings.update"),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    if (!me.roles.includes(RoleCode.QUAN_LY_HE_THONG)) throw new HttpError(403, "Chỉ Quản trị hệ thống chạy tay tác vụ nền");
    const job = getJob(req.params.key);
    if (!job) throw notFound("Không có tác vụ này");
    const outcome = await runJob(job.key, { trigger: JobTrigger.MANUAL, force: true, triggeredById: me.id });
    if (outcome.status === "SKIPPED_LOCKED") throw new HttpError(409, "Tác vụ đang chạy, thử lại sau ít phút");
    await writeAudit({
      req,
      action: AuditAction.UPDATE,
      entity: "JobRun",
      entityId: outcome.runId ?? null,
      summary: `Chạy tay tác vụ "${job.label}": ${outcome.status}${outcome.created != null ? `, tạo ${outcome.created}` : ""}`,
    });
    res.json(outcome);
  })
);

export default router;
