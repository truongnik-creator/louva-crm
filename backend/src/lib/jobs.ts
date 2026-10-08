import crypto from "node:crypto";
import os from "node:os";
import { prisma } from "./prisma";
import { logger } from "./logger";
import { getSettingBool } from "./settings-catalog";
import { JobRunStatus, JobTrigger } from "../types/enums";

// F8: BỘ CHẠY TÁC VỤ NỀN trong chính tiến trình backend (không cần Redis).
//
// - Mỗi tác vụ đăng ký một lần bằng registerJob(); bộ hẹn giờ (startJobScheduler)
//   quét 30 giây một lần, tác vụ nào đến hạn và đang BẬT trong Cài đặt thì chạy.
// - KHOÁ hai lớp: trong tiến trình (Set) và trong CSDL (bảng job_locks, giành khoá
//   bằng một câu UPDATE có điều kiện) nên một tác vụ không bao giờ chạy chồng,
//   kể cả khi lỡ mở hai tiến trình backend trên cùng CSDL.
// - Mỗi lần chạy ghi một dòng JobRun (màn Cài đặt › Nhật ký tác vụ).
// - Tác vụ nhận `now` từ bộ chạy (không tự gọi new Date()) để test dùng giờ giả.
//
// Thêm tác vụ mới ở lô sau:
//   registerJob({ key: "ten-tac-vu", label: "...", intervalMs: 60_000,
//                 settingKey: "automation.xxx.enabled", run: async ({ now }) => ({ created: 0 }) });
// rồi khai settingKey trong lib/settings-catalog.ts (nhóm "Tự động hoá").

export interface JobContext {
  now: Date;
  runId: string;
}

export interface JobResult {
  /** Số việc, thông báo, tin... tác vụ đã tạo ra. */
  created: number;
  message?: string;
}

export interface JobDef {
  key: string;
  label: string;
  /** Chu kỳ chạy theo lịch. */
  intervalMs: number;
  /** Khoá Cài đặt kiểu boolean bật/tắt tác vụ. Trống = luôn bật. */
  settingKey?: string;
  /** Thời gian giữ khoá tối đa (tác vụ treo thì khoá tự hết hạn). */
  lockMs?: number;
  run(ctx: JobContext): Promise<JobResult>;
}

const registry = new Map<string, JobDef>();
const runningInProcess = new Set<string>();
const OWNER = `${os.hostname()}:${process.pid}:${crypto.randomBytes(3).toString("hex")}`;

export function registerJob(def: JobDef): void {
  registry.set(def.key, def);
}

export function listJobs(): JobDef[] {
  return [...registry.values()];
}

export function getJob(key: string): JobDef | undefined {
  return registry.get(key);
}

export async function isJobEnabled(def: JobDef): Promise<boolean> {
  if (!(await getSettingBool("jobs.enabled"))) return false;
  return def.settingKey ? getSettingBool(def.settingKey) : true;
}

/** Giành khoá CSDL. true = giành được. */
async function acquireDbLock(key: string, now: Date, lockMs: number): Promise<boolean> {
  const until = new Date(now.getTime() + lockMs);
  // Dòng khoá tạo một lần; từ đó giành khoá = UPDATE có điều kiện (nguyên tử trong SQLite).
  await prisma.jobLock.upsert({
    where: { key },
    create: { key, owner: "", lockedUntil: new Date(0) },
    update: {},
  });
  const r = await prisma.jobLock.updateMany({
    where: { key, lockedUntil: { lt: now } },
    data: { owner: OWNER, lockedUntil: until },
  });
  return r.count === 1;
}

async function releaseDbLock(key: string): Promise<void> {
  await prisma.jobLock
    .updateMany({ where: { key, owner: OWNER }, data: { lockedUntil: new Date(0) } })
    .catch(() => undefined);
}

export interface RunOutcome {
  status: "SUCCESS" | "FAILED" | "SKIPPED_LOCKED" | "SKIPPED_DISABLED" | "UNKNOWN_JOB";
  runId?: string;
  created?: number;
  message?: string;
  error?: string;
}

/**
 * Chạy một tác vụ NGAY (có khoá). Bộ hẹn giờ và nút "Chạy ngay" đều đi qua đây.
 * `force` bỏ qua công tắc bật/tắt (quản trị bấm chạy tay để thử).
 */
export async function runJob(
  key: string,
  opts: { now?: Date; trigger?: JobTrigger; force?: boolean; triggeredById?: string | null } = {}
): Promise<RunOutcome> {
  const def = registry.get(key);
  if (!def) return { status: "UNKNOWN_JOB" };
  if (!opts.force && !(await isJobEnabled(def))) return { status: "SKIPPED_DISABLED" };

  if (runningInProcess.has(key)) return { status: "SKIPPED_LOCKED" };
  runningInProcess.add(key);
  // Khoá CSDL tính theo giờ thật: giờ giả của test không được làm khoá "hết hạn" sớm.
  const realNow = new Date();
  try {
    if (!(await acquireDbLock(key, realNow, def.lockMs ?? 10 * 60_000))) return { status: "SKIPPED_LOCKED" };
    const now = opts.now ?? realNow;
    const run = await prisma.jobRun.create({
      data: {
        jobKey: key,
        status: JobRunStatus.RUNNING,
        trigger: opts.trigger ?? JobTrigger.SCHEDULE,
        triggeredById: opts.triggeredById ?? null,
      },
    });
    const started = Date.now();
    try {
      const result = await def.run({ now, runId: run.id });
      await prisma.jobRun.update({
        where: { id: run.id },
        data: {
          status: JobRunStatus.SUCCESS,
          finishedAt: new Date(),
          durationMs: Date.now() - started,
          createdCount: result.created,
          message: result.message?.slice(0, 1000) ?? null,
        },
      });
      return { status: "SUCCESS", runId: run.id, created: result.created, message: result.message };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger.error({ err, job: key }, "[jobs] tác vụ nền lỗi");
      await prisma.jobRun.update({
        where: { id: run.id },
        data: { status: JobRunStatus.FAILED, finishedAt: new Date(), durationMs: Date.now() - started, error: error.slice(0, 2000) },
      });
      return { status: "FAILED", runId: run.id, error };
    } finally {
      await releaseDbLock(key);
    }
  } finally {
    runningInProcess.delete(key);
  }
}

// ------------------------------------------------------------- BỘ HẸN GIỜ

let timer: NodeJS.Timeout | null = null;
const lastStartedAt = new Map<string, number>();

async function tick(): Promise<void> {
  for (const def of registry.values()) {
    const last = lastStartedAt.get(def.key) ?? 0;
    if (Date.now() - last < def.intervalMs) continue;
    if (!(await isJobEnabled(def).catch(() => false))) continue;
    lastStartedAt.set(def.key, Date.now());
    // Tuần tự từng tác vụ: SQLite chỉ một luồng ghi, chạy song song chỉ thêm SQLITE_BUSY.
    await runJob(def.key).catch((err) => logger.error({ err, job: def.key }, "[jobs] không chạy được tác vụ"));
  }
}

/** Bật bộ hẹn giờ (index.ts gọi sau bootstrap). Test không gọi: test chạy runJob trực tiếp. */
export function startJobScheduler(tickMs = 30_000): void {
  if (timer) return;
  let busy = false;
  timer = setInterval(() => {
    if (busy) return;
    busy = true;
    void tick().finally(() => {
      busy = false;
    });
  }, tickMs);
  timer.unref();
  logger.info({ jobs: [...registry.keys()] }, "[jobs] bộ chạy tác vụ nền đã bật");
}

export function stopJobScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Dấu "đã xử lý" của quy tắc cho một đối tượng. true = lần đầu (được phép tạo việc). */
export async function markOnce(ruleKey: string, dedupeKey: string): Promise<boolean> {
  try {
    await prisma.automationMark.create({ data: { ruleKey, dedupeKey } });
    return true;
  } catch {
    return false; // trùng khoá unique: đã xử lý rồi
  }
}

export async function wasMarked(ruleKey: string, dedupeKey: string): Promise<boolean> {
  return Boolean(await prisma.automationMark.findUnique({ where: { ruleKey_dedupeKey: { ruleKey, dedupeKey } } }));
}
