import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { pageQuery } from "../lib/pagination";
import { asyncHandler, HttpError } from "../middleware/errorHandler";
import { requireAuth, currentUser } from "../middleware/auth";
import { requirePermission, scopedWhere, notFound, scopeOf } from "../middleware/rbac";
import { writeAudit } from "../lib/audit";
import { vnDayKey, startOfVnDay } from "../lib/datetime";
import { parseSpreadsheetId, spreadsheetUrl } from "../lib/work-report";
import {
  applyTab,
  finishSync,
  findSourceByToken,
  issueSourceToken,
  pullAllSources,
  pullSource,
} from "../lib/work-report-sync";
import { renderAppsScript } from "../lib/work-report-appsscript";
import { previewPublicWorksheet, WorksheetError } from "../services/worksheet";
import { WORK_REPORT_DEPARTMENT_CODES, WORK_REPORT_ROLE_CODES } from "../lib/rbac-catalog";
import { getSettingRaw } from "../lib/settings-catalog";
import {
  AuditAction,
  PermissionScope,
  WorkPostRating,
  WorkReportSyncMode,
  WorkReportSyncStatus,
  WorkTaskStatus,
} from "../types/enums";

// F36: màn "Báo cáo công việc" — theo dõi tiến độ của media, mkt, design,
// content mà không phải mở từng trang tính và đi nhắc gửi link.

const router = Router();

// --------------------------------------------------------------- CỔNG ĐẨY
//
// Đặt TRƯỚC requireAuth: Apps Script không có phiên đăng nhập, nó xác thực
// bằng token riêng của nguồn (hash trong CSDL). Cố ý KHÔNG trả thông tin gì về
// nguồn khi token sai — token sai và nguồn đã tắt phải nhìn như nhau.

const ingestSchema = z.object({
  spreadsheetId: z.string().min(10),
  spreadsheetTitle: z.string().max(300).optional().nullable(),
  mode: z.enum(["FULL", "EDIT", "MANUAL"]).optional(),
  generatedAt: z.string().optional(),
  tabs: z
    .array(
      z.object({
        gid: z.string().min(1).max(32),
        name: z.string().min(1).max(200),
        rows: z.array(z.array(z.string().max(5000))).max(5000),
        linkRows: z.array(z.array(z.string().max(2000))).max(5000).optional(),
        headerRows: z.number().int().min(0).max(20).optional(),
        startRow: z.number().int().min(1).optional(),
      })
    )
    .min(1)
    .max(13),
});

router.post(
  "/ingest",
  asyncHandler(async (req, res) => {
    const token = String(req.header("X-Report-Token") ?? "").trim();
    const source = await findSourceByToken(token);
    if (!source) throw new HttpError(401, "Token không hợp lệ");
    if (!source.active) throw new HttpError(403, "Nguồn báo cáo đang bị tắt");

    const body = ingestSchema.parse(req.body);

    // Token gắn với đúng một trang tính. Dán mã của người này vào trang tính
    // người khác là lỗi thật, phải báo chứ không âm thầm ghi sai chủ.
    if (body.spreadsheetId !== source.spreadsheetId) {
      throw new HttpError(
        409,
        "Token này thuộc một trang tính khác. Hãy lấy lại đoạn mã Apps Script của đúng trang tính trong CRM."
      );
    }

    const applied = [];
    const errors: string[] = [];
    for (const tab of body.tabs) {
      try {
        applied.push(await applyTab(source.id, tab));
      } catch (err) {
        errors.push(`${tab.name}: ${(err as Error)?.message ?? err}`);
      }
    }

    await finishSync({
      sourceId: source.id,
      status: errors.length && !applied.length ? WorkReportSyncStatus.ERROR : WorkReportSyncStatus.OK,
      error: errors.join(" | ") || null,
      title: body.spreadsheetTitle ?? null,
    });
    await prisma.workReportSource.update({
      where: { id: source.id },
      data: { tokenLastUsedAt: new Date(), syncMode: WorkReportSyncMode.PUSH },
    });

    const entries = applied.reduce((s, a) => s + a.entries, 0);
    res.json({
      ok: true,
      tabs: applied.filter((a) => !a.skipped).length,
      skipped: applied.filter((a) => a.skipped).map((a) => a.name),
      entries,
      warnings: [
        ...errors,
        ...applied
          .filter((a) => a.parse?.fallbackColumns)
          .map((a) => `${a.name}: không dò được dòng tiêu đề, đang đọc theo vị trí cột mặc định`),
      ],
    });
  })
);

// Từ đây trở xuống là màn hình CRM — bắt buộc đăng nhập.
router.use(requireAuth);

const READ = "work_report.read";
const MANAGE = "work_report.manage_source";

function sourceScope(req: Parameters<typeof requireAuth>[0]) {
  return scopedWhere(req, READ, { ownerFields: ["userId"], branchField: "branchId" });
}

const sourceSelect = {
  id: true,
  userId: true,
  branchId: true,
  spreadsheetId: true,
  url: true,
  title: true,
  year: true,
  active: true,
  note: true,
  syncMode: true,
  tokenPrefix: true,
  tokenCreatedAt: true,
  tokenLastUsedAt: true,
  lastSyncStatus: true,
  lastSyncAt: true,
  lastSyncError: true,
  rowCount: true,
  lastEntryDate: true,
  createdAt: true,
  user: {
    select: {
      id: true,
      name: true,
      title: true,
      email: true,
      status: true,
      department: { select: { id: true, code: true, name: true } },
    },
  },
  tabs: { select: { gid: true, name: true, month: true, rowCount: true, lastSyncAt: true }, orderBy: { month: "asc" } },
} as const;

/** Token gốc không bao giờ ra khỏi backend — giao diện chỉ cần biết CÓ hay CHƯA. */
function shapeSource<T extends { tokenPrefix: string | null }>(source: T) {
  return { ...source, hasToken: Boolean(source.tokenPrefix) };
}

/**
 * "Ai thuộc khối báo cáo trang tính" — khớp theo VAI TRÒ **hoặc** BỘ PHẬN.
 *
 * Lúc đầu chỉ khớp theo bộ phận và danh sách ra RỖNG trên máy thật, dù đã có
 * người mang vai trò Media và Design: tạo tài khoản thì bắt buộc chọn vai trò,
 * còn bộ phận là tuỳ chọn nên thực tế luôn để trống. Khớp theo vai trò là
 * chính; bộ phận chỉ là lối thứ hai cho người đã gán bộ phận tử tế.
 *
 * `departmentId` (lọc trên giao diện) vẫn ưu tiên tuyệt đối khi được truyền.
 */
function workReportStaffWhere(opts: { departmentId?: string; all?: boolean } = {}): Record<string, unknown> {
  if (opts.departmentId) return { departmentId: opts.departmentId };
  // "Mọi nhân viên": gắn trang tính cho người ngoài bốn bộ phận (trưởng nhóm
  // kinh doanh cũng ghi báo cáo trên sheet chẳng hạn).
  if (opts.all) return {};
  return {
    OR: [
      { roleLinks: { some: { role: { code: { in: WORK_REPORT_ROLE_CODES } } } } },
      { department: { code: { in: WORK_REPORT_DEPARTMENT_CODES } } },
    ],
  };
}

// ------------------------------------------------------------------ NGUỒN

router.get(
  "/sources",
  requirePermission(READ),
  asyncHandler(async (req, res) => {
    const { where } = sourceScope(req);
    const extra: Record<string, unknown> = {};
    if (req.query.departmentId) extra.user = { departmentId: String(req.query.departmentId) };
    if (req.query.active !== undefined) extra.active = String(req.query.active) !== "false";

    const sources = await prisma.workReportSource.findMany({
      where: { ...where, ...extra },
      select: sourceSelect,
      orderBy: [{ user: { name: "asc" } }],
      ...pageQuery(req.query, { defaultLimit: 200, maxLimit: 500 }),
    });
    res.json(sources.map(shapeSource));
  })
);

/**
 * Nhân viên thuộc các bộ phận báo cáo nhưng CHƯA gắn trang tính. Đây là nửa
 * còn lại của việc "theo dõi tiến độ": không thấy ai trống nghĩa là không biết
 * mình đang thiếu báo cáo của ai.
 */
router.get(
  "/unlinked",
  requirePermission(MANAGE),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const scope = scopeOf(req, MANAGE);
    const all = String(req.query.all ?? "") === "true";

    const users = await prisma.user.findMany({
      where: {
        status: "ACTIVE",
        workReportSource: null,
        ...workReportStaffWhere({ departmentId: req.query.departmentId ? String(req.query.departmentId) : undefined, all }),
        ...(scope === PermissionScope.ALL ? {} : { branches: { some: { branchId: { in: me.branchIds } } } }),
      },
      select: {
        id: true,
        name: true,
        title: true,
        email: true,
        department: { select: { id: true, code: true, name: true } },
        roleLinks: { select: { role: { select: { code: true, name: true } } } },
      },
      orderBy: { name: "asc" },
    });
    res.json(
      users.map((u) => ({
        id: u.id,
        name: u.name,
        title: u.title,
        email: u.email,
        department: u.department,
        roles: u.roleLinks.map((l) => l.role),
      }))
    );
  })
);

const createSchema = z.object({
  userId: z.string().uuid(),
  /** Dán cả URL trang tính cũng được, hệ thống tự trích ID. */
  url: z.string().min(10),
  year: z.number().int().min(2020).max(2100).optional(),
  note: z.string().max(500).optional().nullable(),
  syncMode: z.nativeEnum(WorkReportSyncMode).optional(),
});

router.post(
  "/sources",
  requirePermission(MANAGE),
  asyncHandler(async (req, res) => {
    const body = createSchema.parse(req.body);
    const me = currentUser(req);

    const spreadsheetId = parseSpreadsheetId(body.url);
    if (!spreadsheetId) throw new HttpError(400, "Liên kết không phải trang tính Google hợp lệ");

    const target = await prisma.user.findUnique({
      where: { id: body.userId },
      select: { id: true, name: true, branches: { select: { branchId: true, isPrimary: true } } },
    });
    if (!target) throw notFound("Không tìm thấy nhân viên");

    // Không gắn trang tính cho người ở cơ sở mình không quản lý.
    if (scopeOf(req, MANAGE) !== PermissionScope.ALL) {
      const shares = target.branches.some((b) => me.branchIds.includes(b.branchId));
      if (!shares) throw notFound();
    }

    const clash = await prisma.workReportSource.findUnique({
      where: { spreadsheetId },
      select: { user: { select: { name: true } } },
    });
    if (clash) throw new HttpError(409, `Trang tính này đã gắn cho ${clash.user.name}`);

    const branchId =
      target.branches.find((b) => b.isPrimary)?.branchId ?? target.branches[0]?.branchId ?? null;

    const source = await prisma.workReportSource.create({
      data: {
        userId: target.id,
        branchId,
        spreadsheetId,
        url: spreadsheetUrl(spreadsheetId),
        year: body.year ?? Number(vnDayKey(new Date()).slice(0, 4)),
        note: body.note ?? null,
        syncMode: body.syncMode ?? WorkReportSyncMode.PUSH,
        createdById: me.id,
      },
      select: sourceSelect,
    });

    // Cấp token ngay: gắn trang tính mà chưa có token thì Apps Script chưa chạy
    // được, và người gắn sẽ phải quay lại bấm thêm một nút nữa.
    const token = await issueSourceToken(source.id);

    await writeAudit({
      req,
      action: AuditAction.CREATE,
      entity: "WorkReportSource",
      entityId: source.id,
      summary: `Gắn trang tính báo cáo công việc cho ${target.name} (${spreadsheetId})`,
      branchId,
    });

    res.status(201).json({ source: shapeSource({ ...source, tokenPrefix: token.prefix }), token: token.token });
  })
);

const updateSchema = z.object({
  url: z.string().min(10).optional(),
  year: z.number().int().min(2020).max(2100).optional(),
  active: z.boolean().optional(),
  note: z.string().max(500).nullable().optional(),
  syncMode: z.nativeEnum(WorkReportSyncMode).optional(),
});

async function loadSourceInScope(req: Parameters<typeof requireAuth>[0], id: string) {
  const { where } = scopedWhere(req, MANAGE, { ownerFields: ["userId"], branchField: "branchId" });
  const source = await prisma.workReportSource.findFirst({
    where: { id, ...where },
    select: { id: true, userId: true, branchId: true, spreadsheetId: true, year: true, user: { select: { name: true } } },
  });
  if (!source) throw notFound("Không tìm thấy nguồn báo cáo");
  return source;
}

router.patch(
  "/sources/:id",
  requirePermission(MANAGE),
  asyncHandler(async (req, res) => {
    const body = updateSchema.parse(req.body);
    const source = await loadSourceInScope(req, req.params.id);

    const data: Record<string, unknown> = {};
    if (body.url !== undefined) {
      const spreadsheetId = parseSpreadsheetId(body.url);
      if (!spreadsheetId) throw new HttpError(400, "Liên kết không phải trang tính Google hợp lệ");
      if (spreadsheetId !== source.spreadsheetId) {
        const clash = await prisma.workReportSource.findUnique({
          where: { spreadsheetId },
          select: { id: true, user: { select: { name: true } } },
        });
        if (clash && clash.id !== source.id) throw new HttpError(409, `Trang tính này đã gắn cho ${clash.user.name}`);
        data.spreadsheetId = spreadsheetId;
        data.url = spreadsheetUrl(spreadsheetId);
        // Đổi trang tính là đổi nguồn sự thật: dòng việc cũ không còn ứng với
        // trang tính nào nên phải bỏ, nếu không báo cáo sẽ trộn hai trang tính.
        await prisma.workReportTab.deleteMany({ where: { sourceId: source.id } });
      }
    }
    if (body.year !== undefined) data.year = body.year;
    if (body.active !== undefined) data.active = body.active;
    if (body.note !== undefined) data.note = body.note;
    if (body.syncMode !== undefined) data.syncMode = body.syncMode;

    const updated = await prisma.workReportSource.update({
      where: { id: source.id },
      data,
      select: sourceSelect,
    });

    await writeAudit({
      req,
      action: AuditAction.UPDATE,
      entity: "WorkReportSource",
      entityId: source.id,
      summary: `Sửa nguồn báo cáo của ${source.user.name}: ${Object.keys(data).join(", ") || "không có thay đổi"}`,
      branchId: source.branchId,
    });
    res.json(shapeSource(updated));
  })
);

router.delete(
  "/sources/:id",
  requirePermission(MANAGE),
  asyncHandler(async (req, res) => {
    const source = await loadSourceInScope(req, req.params.id);
    await prisma.workReportSource.delete({ where: { id: source.id } });
    await writeAudit({
      req,
      action: AuditAction.DELETE,
      entity: "WorkReportSource",
      entityId: source.id,
      summary: `Ngắt trang tính báo cáo của ${source.user.name} và xoá dòng việc đã đồng bộ`,
      branchId: source.branchId,
    });
    res.json({ ok: true });
  })
);

/** Cấp lại token — token cũ chết ngay, Apps Script cũ sẽ nhận 401. */
router.post(
  "/sources/:id/token",
  requirePermission(MANAGE),
  asyncHandler(async (req, res) => {
    const source = await loadSourceInScope(req, req.params.id);
    const token = await issueSourceToken(source.id);
    await writeAudit({
      req,
      action: AuditAction.UPDATE,
      entity: "WorkReportSource",
      entityId: source.id,
      summary: `Cấp lại token Apps Script cho nguồn báo cáo của ${source.user.name}; token cũ hết hiệu lực`,
      branchId: source.branchId,
    });
    res.json({ token: token.token, prefix: token.prefix });
  })
);

/**
 * Đoạn mã Apps Script dán vào trang tính. Token KHÔNG lưu dạng gốc nên không
 * đọc lại được: mỗi lần lấy mã là cấp token mới (và khai tử token cũ). Đó là
 * hành vi đúng — mã cũ đã nằm trong một trang tính nào đó thì coi như đã phát.
 */
router.get(
  "/sources/:id/apps-script",
  requirePermission(MANAGE),
  asyncHandler(async (req, res) => {
    const source = await loadSourceInScope(req, req.params.id);
    const full = await prisma.workReportSource.findUnique({
      where: { id: source.id },
      select: { title: true, user: { select: { name: true } } },
    });

    const configured = await getSettingRaw("workReport.publicBaseUrl");
    const baseUrl = (configured || "").trim() || `${req.protocol}://${req.get("host")}`;
    const token = await issueSourceToken(source.id);

    const code = renderAppsScript({
      baseUrl,
      token: token.token,
      employeeName: full?.user.name ?? null,
      spreadsheetTitle: full?.title ?? null,
    });

    await writeAudit({
      req,
      action: AuditAction.UPDATE,
      entity: "WorkReportSource",
      entityId: source.id,
      summary: `Lấy đoạn mã Apps Script cho nguồn báo cáo của ${source.user.name} (cấp token mới)`,
      branchId: source.branchId,
    });

    res.type("text/plain; charset=utf-8").send(code);
  })
);

// --------------------------------------------------------------- ĐỒNG BỘ

router.post(
  "/sources/:id/sync",
  requirePermission("work_report.sync"),
  asyncHandler(async (req, res) => {
    const source = await loadSourceInScope(req, req.params.id);
    const months = z
      .array(z.number().int().min(1).max(12))
      .optional()
      .parse(req.body?.months);

    const result = await pullSource(source.id, { months: months ?? [] });
    res.json({
      entries: result.entries,
      tabs: result.tabs.filter((t) => !t.skipped).length,
      errors: result.errors,
    });
  })
);

router.post(
  "/sync",
  requirePermission("work_report.sync"),
  asyncHandler(async (_req, res) => {
    res.json(await pullAllSources());
  })
);

/** Xem thử một trang tính công khai trước khi gắn cho nhân viên. */
router.get(
  "/preview",
  requirePermission(MANAGE),
  asyncHandler(async (req, res) => {
    const url = String(req.query.url ?? "").trim();
    if (!url) throw new HttpError(400, "Thiếu tham số url");
    try {
      res.json(await previewPublicWorksheet(url, { maxRows: 30 }));
    } catch (err) {
      if (err instanceof WorksheetError) throw new HttpError(422, err.message);
      throw err;
    }
  })
);

// ------------------------------------------------------------ DÒNG VIỆC

const entryQuerySchema = z.object({
  userId: z.string().uuid().optional(),
  sourceId: z.string().uuid().optional(),
  departmentId: z.string().uuid().optional(),
  year: z.coerce.number().int().min(2020).max(2100).optional(),
  month: z.coerce.number().int().min(1).max(12).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  statusCode: z.nativeEnum(WorkTaskStatus).optional(),
  ratingCode: z.nativeEnum(WorkPostRating).optional(),
  channel: z.string().max(100).optional(),
  q: z.string().max(200).optional(),
  /** Mặc định ẩn dòng "chưa ghi việc" cho khỏi loãng danh sách. */
  includeEmpty: z.coerce.boolean().optional(),
});

router.get(
  "/entries",
  requirePermission(READ),
  asyncHandler(async (req, res) => {
    const q = entryQuerySchema.parse(req.query);
    const { where } = scopedWhere(req, READ, { ownerFields: ["userId"], branchField: "branchId" });

    const filters: Record<string, unknown> = { ...where };
    if (q.userId) filters.userId = q.userId;
    if (q.sourceId) filters.sourceId = q.sourceId;
    if (q.departmentId) filters.user = { departmentId: q.departmentId };
    if (q.year) filters.year = q.year;
    if (q.month) filters.month = q.month;
    if (q.statusCode) filters.statusCode = q.statusCode;
    if (q.ratingCode) filters.ratingCode = q.ratingCode;
    if (q.channel) filters.channel = q.channel;
    if (q.q) filters.taskName = { contains: q.q };
    if (!q.includeEmpty) filters.taskName = q.q ? { contains: q.q } : { not: null };
    if (q.from || q.to) {
      filters.workDate = {
        ...(q.from ? { gte: startOfVnDay(new Date(`${q.from}T12:00:00Z`)) } : {}),
        ...(q.to ? { lte: startOfVnDay(new Date(`${q.to}T12:00:00Z`)) } : {}),
      };
    }

    const [rows, total] = await Promise.all([
      prisma.workReportEntry.findMany({
        where: filters,
        orderBy: [{ workDate: "desc" }, { rowIndex: "asc" }],
        ...pageQuery(req.query, { defaultLimit: 200, maxLimit: 1000 }),
        select: {
          id: true,
          rowIndex: true,
          workDate: true,
          dayKey: true,
          weekday: true,
          channel: true,
          taskName: true,
          progress: true,
          status: true,
          rating: true,
          linkText: true,
          linkUrl: true,
          note: true,
          summary: true,
          dayCredit: true,
          statusCode: true,
          ratingCode: true,
          isDayOff: true,
          year: true,
          month: true,
          user: { select: { id: true, name: true, title: true } },
          tab: { select: { gid: true, name: true } },
          source: { select: { id: true, spreadsheetId: true } },
        },
      }),
      prisma.workReportEntry.count({ where: filters }),
    ]);

    res.json({
      total,
      entries: rows.map((r) => ({
        ...r,
        /** Mở đúng sheet, đúng dòng trong trang tính gốc. */
        sheetUrl: `${spreadsheetUrl(r.source.spreadsheetId, r.tab.gid)}&range=A${r.rowIndex}`,
      })),
    });
  })
);

// -------------------------------------------------------------- TỔNG QUAN

const EMPTY_TOTALS = () => ({
  tasks: 0,
  [WorkTaskStatus.DONE]: 0,
  [WorkTaskStatus.IN_PROGRESS]: 0,
  [WorkTaskStatus.LATE]: 0,
  [WorkTaskStatus.PENDING]: 0,
  [WorkTaskStatus.CANCELLED]: 0,
  [WorkTaskStatus.DAY_OFF]: 0,
  [WorkTaskStatus.UNKNOWN]: 0,
});

/**
 * Lưới theo dõi tiến độ: mỗi nhân viên một dòng, mỗi ngày trong tháng một ô.
 *
 * Gộp số trong bộ nhớ chứ không groupBy nhiều lượt: một tháng của cả khối chỉ
 * khoảng vài nghìn dòng, còn thứ cần tính (ngày trống, số công, phân bố kênh,
 * phân bố đánh giá) thì mỗi thứ một groupBy sẽ thành 5 lượt truy vấn.
 */
router.get(
  "/overview",
  requirePermission(READ),
  asyncHandler(async (req, res) => {
    const q = z
      .object({
        year: z.coerce.number().int().min(2020).max(2100).optional(),
        month: z.coerce.number().int().min(1).max(12).optional(),
        departmentId: z.string().uuid().optional(),
      })
      .parse(req.query);

    const today = vnDayKey(new Date());
    const year = q.year ?? Number(today.slice(0, 4));
    const month = q.month ?? Number(today.slice(5, 7));

    const { where, scope } = scopedWhere(req, READ, { ownerFields: ["userId"], branchField: "branchId" });
    const me = currentUser(req);

    const sources = await prisma.workReportSource.findMany({
      where: {
        ...where,
        ...(q.departmentId ? { user: { departmentId: q.departmentId } } : {}),
      },
      select: sourceSelect,
      orderBy: [{ user: { name: "asc" } }],
    });

    const entries = await prisma.workReportEntry.findMany({
      where: {
        ...where,
        year,
        month,
        ...(q.departmentId ? { user: { departmentId: q.departmentId } } : {}),
      },
      select: {
        userId: true,
        dayKey: true,
        taskName: true,
        channel: true,
        statusCode: true,
        ratingCode: true,
        dayCredit: true,
        workDate: true,
      },
    });

    const byUser = new Map<string, typeof entries>();
    for (const e of entries) {
      const list = byUser.get(e.userId) ?? [];
      list.push(e);
      byUser.set(e.userId, list);
    }

    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const days = Array.from({ length: daysInMonth }, (_, i) => {
      const d = new Date(Date.UTC(year, month - 1, i + 1, 12));
      return { day: i + 1, dayKey: vnDayKey(d), isFuture: vnDayKey(d) > today };
    });

    const rows = sources.map((source) => {
      const list = byUser.get(source.userId) ?? [];
      const totals = EMPTY_TOTALS();
      const ratings: Record<string, number> = { BAD: 0, AVERAGE: 0, GOOD: 0, EXCELLENT: 0 };
      const channels = new Map<string, number>();
      const byDay = new Map<string, { tasks: number; done: number; dayOff: boolean }>();
      let dayCredit = 0;

      for (const e of list) {
        totals[e.statusCode as keyof typeof totals] = (totals[e.statusCode as keyof typeof totals] ?? 0) + 1;
        if (e.taskName) {
          totals.tasks++;
          if (e.channel) channels.set(e.channel, (channels.get(e.channel) ?? 0) + 1);
        }
        if (e.ratingCode) ratings[e.ratingCode] = (ratings[e.ratingCode] ?? 0) + 1;
        // "Công/ngày" trong mẫu là số TÍCH LUỸ, nên số công của tháng là giá
        // trị lớn nhất, không phải tổng các ô.
        if (e.dayCredit && e.dayCredit > dayCredit) dayCredit = e.dayCredit;

        if (e.dayKey) {
          const cell = byDay.get(e.dayKey) ?? { tasks: 0, done: 0, dayOff: false };
          if (e.taskName) cell.tasks++;
          if (e.statusCode === WorkTaskStatus.DONE) cell.done++;
          if (e.statusCode === WorkTaskStatus.DAY_OFF) cell.dayOff = true;
          byDay.set(e.dayKey, cell);
        }
      }

      const daysReported = [...byDay.values()].filter((c) => c.tasks > 0).length;
      const daysOff = [...byDay.values()].filter((c) => c.dayOff && c.tasks === 0).length;
      // Ngày đã qua, không nghỉ, không ghi việc nào = ngày bỏ trống báo cáo.
      const daysMissing = days.filter(
        (d) => !d.isFuture && !(byDay.get(d.dayKey)?.tasks ?? 0) && !byDay.get(d.dayKey)?.dayOff
      ).length;

      const staleDays = source.lastEntryDate
        ? Math.floor((startOfVnDay(new Date()).getTime() - startOfVnDay(source.lastEntryDate).getTime()) / 86_400_000)
        : null;

      return {
        source: shapeSource(source),
        totals,
        ratings,
        channels: [...channels.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
        dayCredit: dayCredit || null,
        daysReported,
        daysOff,
        daysMissing,
        staleDays,
        byDay: Object.fromEntries(byDay),
      };
    });

    // Nhân viên khối báo cáo chưa gắn trang tính — hiện ngay trên tổng quan.
    const unlinked = await prisma.user.findMany({
      where: {
        status: "ACTIVE",
        workReportSource: null,
        ...workReportStaffWhere({ departmentId: q.departmentId }),
        ...(scope === PermissionScope.ALL ? {} : { branches: { some: { branchId: { in: me.branchIds } } } }),
        ...(scope === PermissionScope.OWN ? { id: me.id } : {}),
      },
      select: { id: true, name: true, title: true, department: { select: { id: true, code: true, name: true } } },
      orderBy: { name: "asc" },
    });

    res.json({
      year,
      month,
      today,
      days,
      rows,
      unlinked,
      summary: {
        people: rows.length,
        tasks: rows.reduce((s, r) => s + r.totals.tasks, 0),
        done: rows.reduce((s, r) => s + r.totals[WorkTaskStatus.DONE], 0),
        daysMissing: rows.reduce((s, r) => s + r.daysMissing, 0),
        syncErrors: rows.filter((r) => r.source.lastSyncStatus === WorkReportSyncStatus.ERROR).length,
        neverSynced: rows.filter((r) => r.source.lastSyncStatus === WorkReportSyncStatus.NEVER).length,
      },
    });
  })
);

export default router;
