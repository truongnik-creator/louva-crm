import { prisma } from "./prisma";
import { logger } from "./logger";
import { hashToken, randomToken } from "./crypto";
import { monthFromTabName, parseSheet, type ParseSheetResult } from "./work-report";
import { WorkReportSyncMode, WorkReportSyncStatus } from "../types/enums";
import { fetchPublicSheet, listPublicTabs, WorksheetError } from "../services/worksheet";

// F36 · GHI DỮ LIỆU BÁO CÁO CÔNG VIỆC.
//
// Cả hai đường vào (Apps Script đẩy về, hoặc backend tự kéo) đều đi qua
// applyTab() để chỉ có MỘT chỗ quyết định dữ liệu trông thế nào.
//
// Ngữ nghĩa ghi: THAY TOÀN BỘ DÒNG CỦA MỘT SHEET. Trang tính là nguồn sự thật,
// CRM chỉ là bản sao để xem; hợp nhất từng dòng sẽ để lại rác khi nhân viên
// xoá hoặc chèn dòng giữa tháng (mọi dòng dưới nó đổi số dòng).

export interface TabPayload {
  gid: string;
  name: string;
  /** Giá trị hiển thị của sheet. */
  rows: string[][];
  /** URL siêu liên kết song song với `rows`; chỉ chế độ đẩy có. */
  linkRows?: string[][];
  headerRows?: number;
  /** Dòng đầu của `rows` là dòng số mấy trong sheet (1-based). */
  startRow?: number;
}

export interface ApplyTabResult {
  gid: string;
  name: string;
  month: number | null;
  skipped: boolean;
  skipReason?: string;
  entries: number;
  parse?: ParseSheetResult;
}

/** Cơ sở chính của nhân viên — chép xuống nguồn và từng dòng để cổng 3 lọc được. */
async function primaryBranchOf(userId: string): Promise<string | null> {
  const rows = await prisma.userBranch.findMany({
    where: { userId },
    select: { branchId: true, isPrimary: true },
    orderBy: { isPrimary: "desc" },
  });
  return rows[0]?.branchId ?? null;
}

/**
 * Ghi một sheet tháng vào CSDL. Sheet không phải tháng ("Quy trình Media",
 * "Ghi chú"...) bị bỏ qua có chủ ý: đó là tài liệu, không phải dòng việc.
 */
export async function applyTab(sourceId: string, payload: TabPayload): Promise<ApplyTabResult> {
  const source = await prisma.workReportSource.findUnique({
    where: { id: sourceId },
    select: { id: true, userId: true, branchId: true, year: true },
  });
  if (!source) throw new Error(`Không tìm thấy nguồn báo cáo ${sourceId}`);

  const month = monthFromTabName(payload.name);
  if (month === null) {
    return { gid: payload.gid, name: payload.name, month: null, skipped: true, skipReason: "Không phải sheet tháng", entries: 0 };
  }

  const parse = parseSheet({
    rows: payload.rows,
    linkRows: payload.linkRows,
    year: source.year,
    month,
    headerRows: payload.headerRows,
    startRow: payload.startRow ?? 1,
  });

  const branchId = source.branchId ?? (await primaryBranchOf(source.userId));

  await prisma.$transaction(async (tx) => {
    const tab = await tx.workReportTab.upsert({
      where: { sourceId_gid: { sourceId, gid: payload.gid } },
      create: {
        sourceId,
        gid: payload.gid,
        name: payload.name,
        month,
        rowCount: parse.entries.length,
        headerRows: parse.headerRows,
        lastSyncAt: new Date(),
      },
      update: {
        name: payload.name,
        month,
        rowCount: parse.entries.length,
        headerRows: parse.headerRows,
        lastSyncAt: new Date(),
      },
      select: { id: true },
    });

    await tx.workReportEntry.deleteMany({ where: { tabId: tab.id } });
    if (parse.entries.length) {
      await tx.workReportEntry.createMany({
        data: parse.entries.map((e) => ({
          sourceId,
          tabId: tab.id,
          userId: source.userId,
          branchId,
          year: source.year,
          month,
          rowIndex: e.rowIndex,
          workDate: e.workDate,
          dayKey: e.dayKey,
          weekday: e.weekday,
          channel: e.channel,
          taskName: e.taskName,
          progress: e.progress,
          status: e.status,
          rating: e.rating,
          linkText: e.linkText,
          linkUrl: e.linkUrl,
          note: e.note,
          summary: e.summary,
          dayCredit: e.dayCredit,
          statusCode: e.statusCode,
          ratingCode: e.ratingCode,
          isDayOff: e.isDayOff,
          raw: e.raw,
        })),
      });
    }
  });

  return { gid: payload.gid, name: payload.name, month, skipped: false, entries: parse.entries.length, parse };
}

export interface FinishSyncInput {
  sourceId: string;
  status: WorkReportSyncStatus;
  error?: string | null;
  title?: string | null;
}

/** Cập nhật trạng thái đồng bộ + hai số liệu tổng (tổng dòng, ngày việc mới nhất). */
export async function finishSync({ sourceId, status, error, title }: FinishSyncInput): Promise<void> {
  const [rowCount, latest] = await Promise.all([
    prisma.workReportEntry.count({ where: { sourceId } }),
    prisma.workReportEntry.findFirst({
      where: { sourceId, workDate: { not: null }, isDayOff: false, taskName: { not: null } },
      orderBy: { workDate: "desc" },
      select: { workDate: true },
    }),
  ]);

  await prisma.workReportSource.update({
    where: { id: sourceId },
    data: {
      lastSyncStatus: status,
      lastSyncAt: new Date(),
      lastSyncError: status === WorkReportSyncStatus.OK ? null : (error ?? "Lỗi không rõ"),
      rowCount,
      lastEntryDate: latest?.workDate ?? null,
      ...(title ? { title } : {}),
    },
  });
}

// --------------------------------------------------------------------- TOKEN

export interface IssuedSourceToken {
  /** Token gốc — chỉ hiện MỘT LẦN cho người gắn trang tính, không lưu lại được. */
  token: string;
  prefix: string;
}

/**
 * Cấp (hoặc cấp lại) token cho Apps Script của một nguồn. Lưu hash giống refresh
 * token: CSDL bị đọc cũng không dùng được để bắn dữ liệu giả vào CRM.
 */
export async function issueSourceToken(sourceId: string): Promise<IssuedSourceToken> {
  const token = randomToken(32);
  const prefix = token.slice(0, 8);
  await prisma.workReportSource.update({
    where: { id: sourceId },
    data: { tokenHash: hashToken(token), tokenPrefix: prefix, tokenCreatedAt: new Date(), tokenLastUsedAt: null },
  });
  return { token, prefix };
}

export async function findSourceByToken(token: string) {
  if (!token) return null;
  return prisma.workReportSource.findUnique({
    where: { tokenHash: hashToken(token) },
    select: { id: true, userId: true, spreadsheetId: true, year: true, active: true, branchId: true },
  });
}

// ----------------------------------------------------------- CHẾ ĐỘ KÉO

export interface PullResult {
  sourceId: string;
  tabs: ApplyTabResult[];
  entries: number;
  errors: string[];
}

/**
 * Kéo một nguồn qua liên kết công khai. Trang tính ẩn sẽ ném WorksheetError
 * kèm lời nhắc chuyển sang chế độ đẩy — ghi vào lastSyncError để quản lý thấy
 * ngay trên giao diện chứ không phải đi đọc log.
 */
export async function pullSource(sourceId: string, opts: { months?: number[] } = {}): Promise<PullResult> {
  const source = await prisma.workReportSource.findUnique({
    where: { id: sourceId },
    select: { id: true, spreadsheetId: true, syncMode: true },
  });
  if (!source) throw new Error(`Không tìm thấy nguồn báo cáo ${sourceId}`);

  const result: PullResult = { sourceId, tabs: [], entries: 0, errors: [] };
  try {
    const info = await listPublicTabs(source.spreadsheetId);
    const wanted = info.tabs.filter((t) => t.month !== null && (!opts.months?.length || opts.months.includes(t.month!)));

    if (!wanted.length) result.errors.push("Trang tính không có sheet tháng nào dạng T1..T12");

    for (const tab of wanted) {
      try {
        const rows = await fetchPublicSheet(source.spreadsheetId, tab.gid);
        const applied = await applyTab(sourceId, { gid: tab.gid, name: tab.name, rows });
        result.tabs.push(applied);
        result.entries += applied.entries;
      } catch (err) {
        const message = err instanceof WorksheetError ? err.message : `${(err as Error)?.message ?? err}`;
        result.errors.push(`${tab.name}: ${message}`);
      }
    }

    await finishSync({
      sourceId,
      status: result.errors.length && !result.entries ? WorkReportSyncStatus.ERROR : WorkReportSyncStatus.OK,
      error: result.errors.join(" | ") || null,
      title: info.title,
    });
  } catch (err) {
    const message = err instanceof WorksheetError ? err.message : `${(err as Error)?.message ?? err}`;
    result.errors.push(message);
    await finishSync({ sourceId, status: WorkReportSyncStatus.ERROR, error: message });
  }

  return result;
}

/** Tác vụ nền: kéo mọi nguồn đang BẬT và đặt ở chế độ kéo. */
export async function pullAllSources(now = new Date()): Promise<{ sources: number; entries: number; errors: string[] }> {
  const sources = await prisma.workReportSource.findMany({
    where: { active: true, syncMode: WorkReportSyncMode.PULL },
    select: { id: true, user: { select: { name: true } } },
  });
  if (!sources.length) return { sources: 0, entries: 0, errors: [] };

  // Chỉ kéo tháng này và tháng trước: tháng cũ không còn đổi, kéo lại 12 sheet
  // mỗi lần là 12 lượt gọi mạng mỗi nhân viên cho không thêm thông tin gì.
  const month = Number(
    new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh", month: "numeric" }).format(now)
  );
  const months = [...new Set([month, month === 1 ? 12 : month - 1])];

  let entries = 0;
  const errors: string[] = [];
  for (const s of sources) {
    try {
      const r = await pullSource(s.id, { months });
      entries += r.entries;
      errors.push(...r.errors.map((e) => `${s.user.name}: ${e}`));
    } catch (err) {
      errors.push(`${s.user.name}: ${(err as Error)?.message ?? err}`);
      logger.warn({ err, sourceId: s.id }, "[work-report] kéo nguồn thất bại");
    }
  }
  return { sources: sources.length, entries, errors };
}
