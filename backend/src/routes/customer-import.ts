import crypto from "node:crypto";
import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { asyncHandler, HttpError } from "../middleware/errorHandler";
import { requireAuth, currentUser } from "../middleware/auth";
import { requirePermission, notFound } from "../middleware/rbac";
import { writeAudit } from "../lib/audit";
import { withCode, CodePrefix } from "../lib/codes";
import { normalizeVnPhone, isValidVnPhone } from "../lib/phone";
import { normalizeName } from "../lib/text";
import { formatDateVN } from "../lib/datetime";
import { getSettingNumber } from "../lib/settings-catalog";
import { readSheet, toCsv, detectSheetKind } from "../lib/spreadsheet";
import { changeStage, getClinicMode, initialStageFor, stageForEvent, stageRank } from "../lib/stages";
import { ActivityType, AuditAction, CustomerStatus, StageEvent, StageSource } from "../types/enums";

// F4: nạp dữ liệu khách cũ từ Excel, CSV.
//
// Luồng 3 bước: (1) tải tệp lên, máy chủ đọc và giữ tạm 30 phút, trả tiêu đề
// cột + 20 dòng xem trước + gợi ý ghép cột; (2) người dùng ghép cột, chọn cách
// xử lý trùng SĐT; (3) chạy nhập, trả báo cáo và tệp lỗi tải về được.
// Chống trùng theo phoneNormalized (B17), không bao giờ tạo hồ sơ thứ hai cho
// cùng một số.

const router = Router();
router.use(requireAuth);

export const IMPORT_FIELDS = ["name", "phone", "branch", "service", "serviceDate", "source", "note"] as const;
type ImportField = (typeof IMPORT_FIELDS)[number];

const FIELD_HINTS: Record<ImportField, string[]> = {
  name: ["ho ten", "ten khach", "ho va ten", "khach hang", "ten", "name"],
  phone: ["so dien thoai", "dien thoai", "sdt", "phone", "mobile", "zalo"],
  branch: ["co so", "chi nhanh", "branch"],
  service: ["dich vu", "service"],
  serviceDate: ["ngay lam", "ngay thuc hien", "ngay dich vu", "ngay"],
  source: ["nguon", "kenh", "source"],
  note: ["ghi chu", "note", "mo ta"],
};

interface ParsedFile {
  userId: string;
  fileName: string;
  headers: string[];
  rows: string[][];
  createdAt: number;
}
interface ErrorFile {
  userId: string;
  data: Buffer;
  createdAt: number;
}

const TTL_MS = 30 * 60_000;
const parsedFiles = new Map<string, ParsedFile>();
const errorFiles = new Map<string, ErrorFile>();

function sweep() {
  const now = Date.now();
  for (const [k, v] of parsedFiles) if (now - v.createdAt > TTL_MS) parsedFiles.delete(k);
  for (const [k, v] of errorFiles) if (now - v.createdAt > TTL_MS) errorFiles.delete(k);
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
});

export function suggestMapping(headers: string[]): Record<ImportField, number | null> {
  const norm = headers.map((h) => normalizeName(h) ?? "");
  const used = new Set<number>();
  const out = {} as Record<ImportField, number | null>;
  for (const field of IMPORT_FIELDS) {
    let found: number | null = null;
    for (const hint of FIELD_HINTS[field]) {
      const idx = norm.findIndex((h, i) => !used.has(i) && (h === hint || h.includes(hint)));
      if (idx >= 0) {
        found = idx;
        break;
      }
    }
    if (found !== null) used.add(found);
    out[field] = found;
  }
  return out;
}

/** "15/09/2024", "15-9-2024", "2024-09-15", số ngày kiểu Excel (45550). */
export function parseImportDate(raw: string): Date | null {
  const s = raw.trim();
  if (!s) return null;
  let y: number, m: number, d: number;
  let match = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (match) [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  else if ((match = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/))) [d, m, y] = [Number(match[1]), Number(match[2]), Number(match[3])];
  else if (/^\d{5}$/.test(s)) {
    const date = new Date(Date.UTC(1899, 11, 30) + Number(s) * 86_400_000);
    [y, m, d] = [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()];
  } else return null;
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1990 || y > 2100) return null;
  // 12:00 giờ Việt Nam của ngày đó (05:00 UTC): không lệch ngày theo múi giờ.
  const date = new Date(Date.UTC(y, m - 1, d, 5));
  if (date.getUTCDate() !== d) return null;
  return date > new Date() ? null : date;
}

function parseInterest(v: string | null): string[] {
  if (!v) return [];
  try {
    const arr = JSON.parse(v);
    return Array.isArray(arr) ? arr.map(String) : [];
  } catch {
    return [];
  }
}

/** POST /api/customers/import/parse — tải tệp, trả tiêu đề cột + 20 dòng xem trước. */
router.post(
  "/parse",
  requirePermission("customer.import"),
  upload.single("file"),
  asyncHandler(async (req, res) => {
    sweep();
    const file = req.file;
    if (!file) throw new HttpError(400, "Chưa chọn tệp");
    if (!detectSheetKind(file.originalname, file.buffer)) {
      throw new HttpError(415, "Chỉ nhận tệp Excel .xlsx hoặc .csv");
    }
    let sheet;
    try {
      sheet = await readSheet(file.originalname, file.buffer);
    } catch (err) {
      throw new HttpError(400, `Không đọc được tệp: ${err instanceof Error ? err.message : "định dạng lạ"}`);
    }
    if (!sheet.rows.length) throw new HttpError(400, "Tệp không có dòng dữ liệu nào dưới dòng tiêu đề");
    const maxRows = await getSettingNumber("import.maxRows");
    if (sheet.rows.length > maxRows) {
      throw new HttpError(400, `Tệp có ${sheet.rows.length} dòng, vượt hạn mức ${maxRows} dòng mỗi lần. Chia nhỏ tệp rồi nhập lại.`);
    }
    const me = currentUser(req);
    const token = crypto.randomUUID();
    parsedFiles.set(token, { userId: me.id, fileName: file.originalname, headers: sheet.headers, rows: sheet.rows, createdAt: Date.now() });
    res.json({
      token,
      fileName: file.originalname,
      headers: sheet.headers,
      totalRows: sheet.rows.length,
      preview: sheet.rows.slice(0, 20),
      suggestedMapping: suggestMapping(sheet.headers),
      fields: IMPORT_FIELDS,
    });
  })
);

const runSchema = z.object({
  token: z.string().uuid(),
  mapping: z.object(
    Object.fromEntries(IMPORT_FIELDS.map((f) => [f, z.number().int().min(0).nullable().optional()])) as Record<
      ImportField,
      z.ZodOptional<z.ZodNullable<z.ZodNumber>>
    >
  ),
  duplicateMode: z.enum(["SKIP", "MERGE", "UPDATE"]),
  defaultBranchId: z.string().uuid().optional(),
});

/** POST /api/customers/import/run — chạy nhập theo cách ghép cột đã chọn. */
router.post(
  "/run",
  requirePermission("customer.import"),
  asyncHandler(async (req, res) => {
    sweep();
    const body = runSchema.parse(req.body);
    const me = currentUser(req);
    const file = parsedFiles.get(body.token);
    if (!file || file.userId !== me.id) throw notFound("Phiên nhập đã hết hạn. Tải tệp lên lại.");
    if (body.mapping.name == null) throw new HttpError(400, "Phải ghép cột Tên khách");
    for (const idx of Object.values(body.mapping)) {
      if (idx != null && idx >= file.headers.length) throw new HttpError(400, "Cột ghép không tồn tại trong tệp");
    }
    const defaultBranchId = body.defaultBranchId ?? me.activeBranchId;
    if (!defaultBranchId || !me.branchIds.includes(defaultBranchId)) throw new HttpError(400, "Chưa chọn cơ sở mặc định hợp lệ");
    parsedFiles.delete(body.token); // một tệp chỉ chạy một lần

    const [branches, channels, mode] = await Promise.all([
      prisma.branch.findMany({ where: { id: { in: me.branchIds } }, select: { id: true, code: true, name: true, shortName: true } }),
      prisma.channel.findMany({ select: { id: true, key: true, name: true } }),
      getClinicMode(),
    ]);
    const findBranch = (v: string) => {
      const n = normalizeName(v);
      return branches.find(
        (b) => b.code.toLowerCase() === v.toLowerCase() || normalizeName(b.name) === n || (b.shortName && normalizeName(b.shortName) === n)
      );
    };
    const findChannel = (v: string) => {
      const n = normalizeName(v);
      return channels.find((c) => c.key.toLowerCase() === v.toLowerCase() || normalizeName(c.name) === n);
    };
    const get = (row: string[], f: ImportField) => {
      const idx = body.mapping[f];
      return idx == null ? "" : (row[idx] ?? "").trim();
    };

    const report = { total: file.rows.length, created: 0, updated: 0, merged: 0, skipped: 0, errors: 0 };
    const errorRows: Array<{ row: number; error: string }> = [];
    const errorCsv: string[][] = [[...file.headers, "Lỗi"]];
    const seenInFile = new Map<string, string>(); // SĐT chuẩn hoá -> id khách (trong lần nhập này)
    const serviceDone = stageForEvent(mode, StageEvent.PROCEDURE_DONE);

    for (let i = 0; i < file.rows.length; i++) {
      const row = file.rows[i];
      const rowNo = i + 2; // dòng 1 là tiêu đề
      try {
        const name = get(row, "name");
        if (name.length < 2) throw new Error("Thiếu tên khách");
        const rawPhone = get(row, "phone");
        const phoneNormalized = rawPhone ? normalizeVnPhone(rawPhone) : null;
        if (rawPhone && (!phoneNormalized || !isValidVnPhone(phoneNormalized))) throw new Error(`SĐT không hợp lệ: ${rawPhone}`);
        const branchRaw = get(row, "branch");
        const branch = branchRaw ? findBranch(branchRaw) : null;
        if (branchRaw && !branch) throw new Error(`Không tìm thấy cơ sở "${branchRaw}"`);
        const branchId = branch?.id ?? defaultBranchId;
        const service = get(row, "service");
        const dateRaw = get(row, "serviceDate");
        const serviceDate = dateRaw ? parseImportDate(dateRaw) : null;
        if (dateRaw && !serviceDate) throw new Error(`Ngày làm không hợp lệ: ${dateRaw} (dùng dd/mm/yyyy)`);
        const sourceRaw = get(row, "source");
        const channel = sourceRaw ? findChannel(sourceRaw) : null;
        const noteParts = [get(row, "note"), sourceRaw && !channel ? `Nguồn: ${sourceRaw}` : ""].filter(Boolean);
        const importNote = noteParts.length ? `[Nhập từ ${file.fileName}] ${noteParts.join(". ")}` : null;
        const serviceLine = service || serviceDate
          ? `Dịch vụ đã làm (nhập từ file): ${service || "không rõ"}${serviceDate ? `, ngày ${formatDateVN(serviceDate)}` : ""}`
          : null;

        const dupId = phoneNormalized
          ? (seenInFile.get(phoneNormalized) ??
            (await prisma.customer.findFirst({
              where: { phoneNormalized, mergedIntoId: null },
              orderBy: { createdAt: "asc" },
              select: { id: true },
            }))?.id)
          : undefined;

        if (dupId) {
          if (body.duplicateMode === "SKIP") {
            report.skipped++;
            continue;
          }
          const existing = await prisma.customer.findUniqueOrThrow({ where: { id: dupId } });
          const data: Record<string, unknown> = {};
          if (body.duplicateMode === "UPDATE") {
            if (name !== existing.name) data.name = name;
            if (channel) data.channelId = channel.id;
          } else if (channel && !existing.channelId) {
            data.channelId = channel.id;
          }
          if (importNote) data.note = [existing.note, importNote].filter(Boolean).join("\n");
          if (service) {
            const interests = parseInterest(existing.interest);
            if (!interests.includes(service)) data.interest = JSON.stringify([...interests, service]);
          }
          if (serviceDate && (!existing.lastServiceAt || serviceDate > existing.lastServiceAt)) data.lastServiceAt = serviceDate;
          await prisma.customer.update({
            where: { id: existing.id },
            data: {
              ...data,
              activities: {
                create: {
                  type: ActivityType.SYSTEM,
                  content: `${me.name} ${body.duplicateMode === "UPDATE" ? "cập nhật" : "gộp"} dữ liệu từ tệp ${file.fileName} (dòng ${rowNo})${serviceLine ? `. ${serviceLine}` : ""}`,
                  userId: me.id,
                  userName: me.name,
                },
              },
            },
          });
          await prisma.customerBranchLink.upsert({
            where: { customerId_branchId: { customerId: existing.id, branchId } },
            create: { customerId: existing.id, branchId },
            update: {},
          });
          if (serviceDate && serviceDone && stageRank(mode, serviceDone) > stageRank(mode, existing.stage)) {
            await changeStage({
              customerId: existing.id,
              fromStage: existing.stage,
              toStage: serviceDone,
              source: StageSource.IMPORT,
              actor: { id: me.id, name: me.name },
              mode,
            });
          }
          if (body.duplicateMode === "UPDATE") report.updated++;
          else report.merged++;
          continue;
        }

        const stage = serviceDate && serviceDone ? serviceDone : initialStageFor(mode);
        const created = await withCode(CodePrefix.CUSTOMER, (code) =>
          prisma.customer.create({
            data: {
              code,
              name,
              phone: rawPhone || null,
              channelId: channel?.id ?? null,
              interest: service ? JSON.stringify([service]) : null,
              note: importNote,
              status: serviceDate ? CustomerStatus.ACTIVE : CustomerStatus.LEAD,
              stage,
              stageChangedAt: new Date(),
              lastServiceAt: serviceDate,
              assignedToId: null,
              branchLinks: { create: { branchId, isPrimary: true } },
              activities: {
                create: {
                  type: ActivityType.SYSTEM,
                  content: `Tạo hồ sơ khi nhập tệp ${file.fileName} (dòng ${rowNo}) bởi ${me.name}${serviceLine ? `. ${serviceLine}` : ""}`,
                  userId: me.id,
                  userName: me.name,
                },
              },
              stageHistory: {
                create: { fromStage: null, toStage: stage, source: StageSource.IMPORT, userId: me.id, userName: me.name },
              },
            },
          })
        );
        if (phoneNormalized) seenInFile.set(phoneNormalized, created.id);
        report.created++;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        report.errors++;
        if (errorRows.length < 200) errorRows.push({ row: rowNo, error: message });
        errorCsv.push([...row, message]);
      }
    }

    let errorFileToken: string | null = null;
    if (report.errors) {
      errorFileToken = crypto.randomUUID();
      errorFiles.set(errorFileToken, { userId: me.id, data: toCsv(errorCsv), createdAt: Date.now() });
    }

    await writeAudit({
      req,
      action: AuditAction.IMPORT,
      entity: "Customer",
      summary: `Nhập tệp khách ${file.fileName}: ${report.total} dòng, tạo mới ${report.created}, cập nhật ${report.updated}, gộp ${report.merged}, bỏ qua trùng ${report.skipped}, lỗi ${report.errors} (xử lý trùng: ${body.duplicateMode})`,
    });

    res.json({ ...report, duplicates: report.updated + report.merged + report.skipped, errorRows, errorFileToken });
  })
);

/** GET /api/customers/import/errors/:token — tải tệp CSV các dòng lỗi (kèm cột Lỗi). */
router.get(
  "/errors/:token",
  requirePermission("customer.import"),
  asyncHandler(async (req, res) => {
    sweep();
    const me = currentUser(req);
    const file = errorFiles.get(req.params.token);
    if (!file || file.userId !== me.id) throw notFound("Tệp lỗi đã hết hạn");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="dong-loi-nhap-khach.csv"');
    res.setHeader("Cache-Control", "no-store, private");
    res.send(file.data);
  })
);

export default router;
