import type { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { logger } from "./logger";
import { HttpError } from "../middleware/errorHandler";
import { getSettingBool, getSettingList, getSettingNumber, getSettingRaw } from "./settings-catalog";
import { startOfVnDay } from "./datetime";
import { lostStageFor, stageLabel } from "./stages";
import {
  ActivityType,
  AppointmentStatus,
  ClinicMode,
  ContractStatus,
  DepositSubStage,
  DropAction,
  FunnelStage,
  InjectionStage,
  OpportunitySource,
  OpportunityStatus,
  PackageStatus,
  StageRequirement,
  TaskKind,
  TaskPriority,
  TaskStatus,
} from "../types/enums";

// Lô 8 · P6: PIPELINE THEO CƠ HỘI.
//
// Mỗi khách có một hoặc nhiều cơ hội (Opportunity). Mọi lần đổi bước (tay, tự
// động, nhập file) đi qua stages.changeStage, hàm đó đổi bước CỦA CƠ HỘI rồi
// đồng bộ lại Customer.stage = bước của cơ hội đang mở mới nhất, không có cơ hội
// mở thì cơ hội gần nhất. Nhờ vậy mọi báo cáo, lương, tự động hoá, test cũ đọc
// Customer.stage vẫn chạy y như trước.
//
// Khách chưa có cơ hội (dữ liệu trước Lô 8 chưa chạy script chuyển dữ liệu, hoặc
// khách mới chưa đổi bước lần nào) được tạo đúng một cơ hội từ trạng thái hiện
// tại của khách ngay lần đầu cần tới (ensureCurrentOpportunity), y như script
// scripts/migrate-opportunities.ts làm hàng loạt.

type Tx = Prisma.TransactionClient | typeof prisma;

/** Bước "đã làm dịch vụ" = cơ hội thắng. Phẫu thuật: từ khi đã phẫu thuật. */
export function wonStagesFor(mode: ClinicMode): string[] {
  return mode === ClinicMode.SURGERY
    ? [FunnelStage.PT, FunnelStage.HAUPHAU, FunnelStage.HOANTAT, FunnelStage.TAIMUA]
    : [InjectionStage.LAM_DICH_VU, InjectionStage.QUAY_LAI];
}

export function statusForStage(mode: ClinicMode, stage: string): OpportunityStatus {
  if (stage === lostStageFor(mode)) return OpportunityStatus.LOST;
  if (wonStagesFor(mode).includes(stage)) return OpportunityStatus.WON;
  return OpportunityStatus.OPEN;
}

export function parseInterestList(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

/** Cơ hội "hiện tại" của khách: đang mở mới nhất, không có thì gần nhất. */
export async function currentOpportunity(customerId: string, tx: Tx = prisma) {
  return (
    (await tx.opportunity.findFirst({
      where: { customerId, status: OpportunityStatus.OPEN },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    })) ??
    (await tx.opportunity.findFirst({ where: { customerId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] }))
  );
}

/** Customer.stage = bước của cơ hội hiện tại. Gọi sau mọi thay đổi cơ hội. */
export async function syncCustomerStage(customerId: string, tx: Tx = prisma): Promise<void> {
  const opp = await currentOpportunity(customerId, tx);
  if (!opp) return;
  const c = await tx.customer.findUnique({ where: { id: customerId }, select: { stage: true, stageChangedAt: true, lostReason: true } });
  if (!c) return;
  const lostReason = opp.status === OpportunityStatus.LOST ? opp.lostReason : null;
  const stageChangedAt = opp.stageChangedAt ?? c.stageChangedAt;
  if (c.stage === opp.stage && c.lostReason === lostReason && (c.stageChangedAt?.getTime() ?? 0) === (stageChangedAt?.getTime() ?? 0)) return;
  await tx.customer.update({ where: { id: customerId }, data: { stage: opp.stage, stageChangedAt, lostReason } });
}

interface CustomerSeed {
  id: string;
  stage: string;
  lostReason: string | null;
  stageChangedAt: Date | null;
  createdAt: Date;
  interest: string | null;
  assignedToId: string | null;
  telesaleId: string | null;
  channelId: string | null;
  campaignId: string | null;
  branchLinks: Array<{ branchId: string; isPrimary: boolean }>;
}

const SEED_SELECT = {
  id: true,
  stage: true,
  lostReason: true,
  stageChangedAt: true,
  createdAt: true,
  interest: true,
  assignedToId: true,
  telesaleId: true,
  channelId: true,
  campaignId: true,
  branchLinks: { select: { branchId: true, isPrimary: true } },
} as const;

/** Dữ liệu cơ hội chuyển từ trạng thái hiện tại của khách (script chuyển dữ liệu và tạo lười). */
export function opportunityFromCustomer(c: CustomerSeed, mode: ClinicMode, serviceByName: Map<string, string>) {
  const interest = parseInterestList(c.interest);
  const serviceId = interest.map((n) => serviceByName.get(n.trim().toLowerCase())).find(Boolean) ?? null;
  const status = statusForStage(mode, c.stage);
  return {
    customerId: c.id,
    branchId: (c.branchLinks.find((b) => b.isPrimary) ?? c.branchLinks[0])?.branchId ?? null,
    serviceId,
    title: interest.length ? interest.slice(0, 3).join(", ") : "Cơ hội đầu tiên",
    stage: c.stage,
    stageChangedAt: c.stageChangedAt,
    status,
    channelId: c.channelId,
    campaignId: c.campaignId,
    ownerId: c.assignedToId ?? c.telesaleId,
    lostReason: status === OpportunityStatus.LOST ? c.lostReason : null,
    closedAt: status === OpportunityStatus.OPEN ? null : (c.stageChangedAt ?? c.createdAt),
    source: OpportunitySource.MIGRATION,
    createdAt: c.createdAt,
  };
}

async function serviceNameIndex(): Promise<Map<string, string>> {
  const services = await prisma.service.findMany({ where: { active: true }, select: { id: true, name: true } });
  return new Map(services.map((s) => [s.name.trim().toLowerCase(), s.id]));
}

/**
 * Cơ hội hiện tại của khách; chưa có thì tạo đúng một cơ hội từ khách và gắn
 * toàn bộ lịch sử bước cũ vào đó. Bước cơ hội lệch với Customer.stage (dữ liệu
 * ghi thẳng ngoài luồng changeStage) thì kéo cơ hội về đúng bước của khách.
 */
export async function ensureCurrentOpportunity(customerId: string, mode: ClinicMode) {
  const c = await prisma.customer.findUnique({ where: { id: customerId }, select: SEED_SELECT });
  if (!c) return null;
  let opp = await currentOpportunity(customerId);
  if (!opp) {
    const data = opportunityFromCustomer(c, mode, await serviceNameIndex());
    opp = await prisma.$transaction(async (tx) => {
      const created = await tx.opportunity.create({ data });
      await tx.stageHistory.updateMany({ where: { customerId, opportunityId: null }, data: { opportunityId: created.id } });
      return created;
    });
    return opp;
  }
  if (opp.stage !== c.stage) {
    const status = statusForStage(mode, c.stage);
    opp = await prisma.opportunity.update({
      where: { id: opp.id },
      data: {
        stage: c.stage,
        status,
        stageChangedAt: c.stageChangedAt ?? opp.stageChangedAt,
        lostReason: status === OpportunityStatus.LOST ? c.lostReason : null,
        closedAt: status === OpportunityStatus.OPEN ? null : (opp.closedAt ?? c.stageChangedAt ?? new Date()),
      },
    });
  }
  return opp;
}

/** Id cơ hội hiện tại (không tạo mới), để gắn báo giá, hợp đồng. */
export async function currentOpportunityId(customerId: string): Promise<string | null> {
  return (await currentOpportunity(customerId))?.id ?? null;
}

// ------------------------------------------------------------ TỰ MỞ CƠ HỘI MỚI

/**
 * Khách đã làm dịch vụ (cơ hội thắng) có sự kiện mua mới (cọc, check-in) thì mở
 * cơ hội mới. Không mở khi: sự kiện không nằm trong danh sách tham số; còn trong
 * số ngày chăm sóc sau lần làm dịch vụ gần nhất; khách còn gói liệu trình còn buổi.
 */
export async function shouldAutoOpen(customerId: string, event: string, lastServiceAt: Date | null, at: Date): Promise<boolean> {
  const events = await getSettingList("opportunity.autoOpenEvents");
  if (!events.includes(event)) return false;
  const minDays = await getSettingNumber("opportunity.reopenMinDays");
  if (lastServiceAt && at.getTime() - lastServiceAt.getTime() < minDays * 86_400_000) return false;
  const pkg = await prisma.treatmentPackage.findFirst({
    where: { customerId, status: PackageStatus.ACTIVE, OR: [{ expiresAt: null }, { expiresAt: { gt: at } }] },
    select: { id: true, totalSessions: true, usedSessions: true },
  });
  if (pkg && pkg.usedSessions < pkg.totalSessions) return false;
  return true;
}

export interface OpenOpportunityInput {
  customerId: string;
  stage: string;
  mode: ClinicMode;
  source: OpportunitySource;
  title?: string | null;
  serviceId?: string | null;
  expectedValue?: number | null;
  expectedCloseAt?: Date | null;
  ownerId?: string | null;
  branchId?: string | null;
  actor?: { id: string; name: string } | null;
  event?: string | null;
  note?: string | null;
  /** Ghi thêm vào khách (lastServiceAt khi mở do sự kiện làm dịch vụ). */
  customerExtra?: Record<string, unknown>;
}

/** Mở cơ hội mới, ghi lịch sử bước (từ "chưa có" sang bước đầu), đồng bộ bước khách. */
export async function openOpportunity(input: OpenOpportunityInput) {
  const c = await prisma.customer.findUniqueOrThrow({ where: { id: input.customerId }, select: SEED_SELECT });
  const svc = input.serviceId ? await prisma.service.findUnique({ where: { id: input.serviceId }, select: { name: true } }) : null;
  const status = statusForStage(input.mode, input.stage);
  const now = new Date();
  const title = input.title?.trim() || svc?.name || "Cơ hội mới";
  const via = input.source === OpportunitySource.AUTO ? "tự động" : input.actor ? `bởi ${input.actor.name}` : "";
  const opp = await prisma.$transaction(async (tx) => {
    const created = await tx.opportunity.create({
      data: {
        customerId: c.id,
        branchId: input.branchId ?? (c.branchLinks.find((b) => b.isPrimary) ?? c.branchLinks[0])?.branchId ?? null,
        serviceId: input.serviceId ?? null,
        title,
        stage: input.stage,
        stageChangedAt: now,
        status,
        expectedValue: input.expectedValue ?? null,
        expectedCloseAt: input.expectedCloseAt ?? null,
        channelId: c.channelId,
        campaignId: c.campaignId,
        ownerId: input.ownerId ?? c.assignedToId ?? c.telesaleId,
        closedAt: status === OpportunityStatus.OPEN ? null : now,
        source: input.source,
        createdById: input.actor?.id ?? null,
      },
    });
    await tx.stageHistory.create({
      data: {
        customerId: c.id,
        opportunityId: created.id,
        fromStage: null,
        toStage: input.stage,
        source: input.source === OpportunitySource.MANUAL ? "MANUAL" : "AUTO",
        event: input.event ?? null,
        note: input.note ?? null,
        userId: input.actor?.id ?? null,
        userName: input.actor?.name ?? null,
        createdAt: now,
      },
    });
    await tx.activity.create({
      data: {
        customerId: c.id,
        type: ActivityType.OPPORTUNITY,
        content: `Mở cơ hội mới "${title}" ở bước ${stageLabel(input.stage)}${via ? ` (${via})` : ""}${input.note ? `. Ghi chú: ${input.note}` : ""}`,
        userId: input.actor?.id ?? null,
        userName: input.actor?.name ?? null,
      },
    });
    if (input.customerExtra) await tx.customer.update({ where: { id: c.id }, data: input.customerExtra });
    await syncCustomerStage(c.id, tx);
    return created;
  });
  await createStageTasksSafe(opp.id, input.stage, { branchId: input.branchId ?? null, fallbackAssigneeId: input.actor?.id ?? null });
  return opp;
}

// ------------------------------------------------------------ P4 BƯỚC CON, ĐIỀU KIỆN

export interface SubStageDef {
  key: string;
  label: string;
  /** Tự tính theo cọc của lịch hẹn, không chọn tay. */
  auto: boolean;
}

export function parseSubStages(raw: string): Map<string, SubStageDef[]> {
  const out = new Map<string, SubStageDef[]>();
  for (const part of raw.split(";").map((x) => x.trim()).filter(Boolean)) {
    const m = part.match(/^([A-Z_]+)\s*:\s*(.+)$/);
    if (!m) continue;
    const subs: SubStageDef[] = [];
    for (const sub of m[2].split("|")) {
      const mm = sub.trim().match(/^([A-Z_]+)\s*=\s*(.+)$/);
      if (!mm) continue;
      subs.push({ key: mm[1], label: mm[2].trim(), auto: mm[1] === DepositSubStage.HEN_CHUA_COC || mm[1] === DepositSubStage.DA_COC });
    }
    if (subs.length) out.set(m[1], subs);
  }
  return out;
}

export async function loadSubStages(): Promise<Map<string, SubStageDef[]>> {
  return parseSubStages(await getSettingRaw("pipeline.subStages"));
}

/** Bước con của một thẻ: bước con theo cọc tự tính; bước con tay lấy giá trị đã lưu nếu hợp lệ. */
export function subStageOf(
  defs: Map<string, SubStageDef[]>,
  stage: string,
  stored: string | null | undefined,
  deposit: "PAID" | "UNPAID" | null
): string | null {
  const subs = defs.get(stage);
  if (!subs) return null;
  const hasDepositSubs = subs.some((s) => s.auto);
  if (hasDepositSubs && deposit) {
    const want = deposit === "PAID" ? DepositSubStage.DA_COC : DepositSubStage.HEN_CHUA_COC;
    if (subs.some((s) => s.key === want)) return want;
  }
  if (stored && subs.some((s) => s.key === stored && !s.auto)) return stored;
  if (hasDepositSubs) return DepositSubStage.HEN_CHUA_COC;
  return null;
}

export function parseStageNumbers(raw: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const part of raw.split(",").map((x) => x.trim()).filter(Boolean)) {
    const m = part.match(/^([A-Z_]+)\s*:\s*(\d+)$/);
    if (m) out.set(m[1], Number(m[2]));
  }
  return out;
}

export async function loadWipLimits(): Promise<Map<string, number>> {
  return parseStageNumbers(await getSettingRaw("pipeline.wipLimits"));
}

export interface RequirementCheck {
  missing: StageRequirement[];
  /** Lịch hẹn sắp tới (để mở form cọc khi đã có lịch). */
  appointment: { id: string; startAt: Date; depositStatus: string | null; depositAmount: number; code: string | null } | null;
  hasContract: boolean;
}

/**
 * P4: điều kiện bắt buộc khi kéo tay sang bước (tham số Cài đặt): bước cần lịch
 * hẹn thì khách phải có lịch sắp tới chưa huỷ; bước cần hợp đồng thì cơ hội phải
 * có hợp đồng chưa huỷ (hợp đồng gắn cơ hội, hoặc lập từ khi cơ hội mở).
 */
export async function checkStageRequirements(
  customerId: string,
  opportunity: { id: string; createdAt: Date } | null,
  toStage: string,
  now = new Date()
): Promise<RequirementCheck> {
  const [apptStages, contractStages] = await Promise.all([
    getSettingList("pipeline.requireAppointmentStages"),
    getSettingList("pipeline.requireContractStages"),
  ]);
  const appointment = await prisma.appointment.findFirst({
    where: {
      customerId,
      startAt: { gte: startOfVnDay(now) },
      status: { notIn: [AppointmentStatus.CANCELLED, AppointmentStatus.NO_SHOW, AppointmentStatus.DONE] },
    },
    orderBy: { startAt: "asc" },
    select: { id: true, startAt: true, depositStatus: true, depositAmount: true, code: true },
  });
  const contract = await prisma.contract.findFirst({
    where: {
      customerId,
      status: { not: ContractStatus.CANCELLED },
      ...(opportunity ? { OR: [{ opportunityId: opportunity.id }, { createdAt: { gte: opportunity.createdAt } }] } : {}),
    },
    select: { id: true },
  });
  const missing: StageRequirement[] = [];
  if (apptStages.includes(toStage) && !appointment) missing.push(StageRequirement.APPOINTMENT);
  if (contractStages.includes(toStage) && !contract) missing.push(StageRequirement.CONTRACT);
  return { missing, appointment, hasContract: Boolean(contract) };
}

export const REQUIREMENT_MESSAGE: Record<StageRequirement, string> = {
  APPOINTMENT: "Sang bước này phải có lịch hẹn: đặt lịch trước",
  CONTRACT: "Sang bước này phải có hợp đồng: tạo hợp đồng trước",
};

// ------------------------------------------------------------ J3 VIỆC THEO BƯỚC

/**
 * Cơ hội vào bước thì sinh việc theo checklist của bước (mục áp mọi cơ sở hoặc
 * đúng cơ sở của cơ hội). Không sinh trùng: mục đã có việc đang mở cho cơ hội này
 * thì bỏ qua. Người nhận: sale phụ trách cơ hội, rồi tư vấn viên, rồi telesale.
 */
export interface StageTaskContext {
  /** Cơ sở nơi xảy ra sự kiện (ví dụ cơ sở check-in) khi cơ hội chưa gắn cơ sở. */
  branchId?: string | null;
  /** Người nhận việc khi cơ hội và khách chưa có sale phụ trách (người làm đổi bước). */
  fallbackAssigneeId?: string | null;
}

/**
 * J3: tạo việc theo checklist của bước cho cơ hội.
 * Sửa lỗi sau chụp demo Lô 8: cơ hội chưa gắn cơ sở (lead mới từ chat chưa có cơ sở)
 * trước đây chỉ nhận việc "mọi cơ sở", bỏ sót việc khai riêng cho cơ sở, nên khách
 * check-in sang Đến cơ sở không có việc. Nay cơ sở lấy theo thứ tự: cơ sở của cơ hội,
 * cơ sở của sự kiện (check-in), cơ sở chính của khách. Không có sale phụ trách thì
 * giao cho người làm đổi bước để việc không "mồ côi".
 */
export async function createStageTasks(opportunityId: string, stage: string, now = new Date(), ctx: StageTaskContext = {}): Promise<number> {
  if (!(await getSettingBool("pipeline.stageTasks.enabled"))) return 0;
  const opp = await prisma.opportunity.findUnique({
    where: { id: opportunityId },
    select: {
      id: true,
      customerId: true,
      branchId: true,
      ownerId: true,
      title: true,
      customer: { select: { assignedToId: true, telesaleId: true, branchLinks: { select: { branchId: true, isPrimary: true } } } },
    },
  });
  if (!opp) return 0;
  const links = opp.customer.branchLinks;
  const branchId = opp.branchId ?? ctx.branchId ?? (links.find((b) => b.isPrimary) ?? links[0])?.branchId ?? null;
  const items = await prisma.stageChecklistItem.findMany({
    where: { stage, active: true, OR: [{ branchId: null }, ...(branchId ? [{ branchId }] : [])] },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
  });
  if (!items.length) return 0;
  const open = await prisma.task.findMany({
    where: { opportunityId: opp.id, checklistItemId: { in: items.map((i) => i.id) }, status: { in: [TaskStatus.OPEN, TaskStatus.IN_PROGRESS] } },
    select: { checklistItemId: true },
  });
  const have = new Set(open.map((t) => t.checklistItemId));
  const assigneeId = opp.ownerId ?? opp.customer.assignedToId ?? opp.customer.telesaleId ?? ctx.fallbackAssigneeId ?? null;
  let created = 0;
  for (const item of items) {
    if (have.has(item.id)) continue;
    await prisma.task.create({
      data: {
        customerId: opp.customerId,
        branchId,
        title: item.title,
        description: item.messageTemplate ? `Mẫu tin gợi ý: ${item.messageTemplate}` : null,
        status: TaskStatus.OPEN,
        priority: TaskPriority.NORMAL,
        dueAt: new Date(startOfVnDay(now).getTime() + (item.dueDays + 1) * 86_400_000 - 60_000),
        assigneeId,
        kind: TaskKind.STAGE_CHECKLIST,
        source: `stage-checklist:${stage}`,
        opportunityId: opp.id,
        stageKey: stage,
        checklistItemId: item.id,
      },
    });
    created++;
  }
  return created;
}

export async function createStageTasksSafe(opportunityId: string, stage: string, ctx: StageTaskContext = {}): Promise<number> {
  try {
    return await createStageTasks(opportunityId, stage, new Date(), ctx);
  } catch (err) {
    logger.error({ err, opportunityId, stage }, "[opportunity] tạo việc theo bước lỗi");
    return 0;
  }
}

// ------------------------------------------------------------ CHUYỂN DỮ LIỆU (P6)

export interface OpportunityMigrationPlan {
  customers: number;
  alreadyHave: number;
  toCreate: number;
  skippedMerged: number;
  historyRowsToAttach: number;
  byStage: Record<string, number>;
  byStatus: Record<string, number>;
  created: number;
}

/**
 * Mỗi khách chưa có cơ hội thành đúng một cơ hội mang bước hiện tại, gắn toàn bộ
 * lịch sử bước cũ của khách vào cơ hội đó. Không đổi Customer.stage nên mọi báo
 * cáo cũ ra cùng kết quả. Chạy lại bao nhiêu lần cũng được (khách đã có cơ hội bỏ qua).
 * Hồ sơ đã gộp vào hồ sơ khác (mergedIntoId) không tạo cơ hội: lịch sử của nó đã
 * chuyển sang hồ sơ giữ lại.
 */
export async function migrateCustomersToOpportunities(opts: { apply: boolean; batch?: number; mode?: ClinicMode }): Promise<OpportunityMigrationPlan> {
  const mode = opts.mode ?? ClinicMode.INJECTION;
  const all = await prisma.customer.findMany({ select: { ...SEED_SELECT, mergedIntoId: true, _count: { select: { opportunities: true } } } });
  const services = await serviceNameIndex();
  const plan: OpportunityMigrationPlan = {
    customers: all.length,
    alreadyHave: 0,
    toCreate: 0,
    skippedMerged: 0,
    historyRowsToAttach: 0,
    byStage: {},
    byStatus: {},
    created: 0,
  };
  const todo: typeof all = [];
  for (const c of all) {
    if (c.mergedIntoId) {
      plan.skippedMerged++;
      continue;
    }
    if (c._count.opportunities > 0) {
      plan.alreadyHave++;
      continue;
    }
    todo.push(c);
    plan.byStage[c.stage] = (plan.byStage[c.stage] ?? 0) + 1;
    const st = statusForStage(mode, c.stage);
    plan.byStatus[st] = (plan.byStatus[st] ?? 0) + 1;
  }
  plan.toCreate = todo.length;
  plan.historyRowsToAttach = todo.length
    ? await prisma.stageHistory.count({ where: { opportunityId: null, customerId: { in: todo.map((c) => c.id) } } })
    : 0;
  if (!opts.apply) return plan;

  const size = opts.batch ?? 200;
  for (let i = 0; i < todo.length; i += size) {
    const chunk = todo.slice(i, i + size);
    await prisma.$transaction(async (tx) => {
      for (const c of chunk) {
        // Kiểm lại trong giao dịch: chạy song song với máy chủ đang tạo cơ hội lười.
        if ((await tx.opportunity.count({ where: { customerId: c.id } })) > 0) continue;
        const created = await tx.opportunity.create({ data: opportunityFromCustomer(c, mode, services) });
        await tx.stageHistory.updateMany({ where: { customerId: c.id, opportunityId: null }, data: { opportunityId: created.id } });
        plan.created++;
      }
    });
  }
  return plan;
}


// ------------------------------------------------------------ P5 THẢ THẺ MỞ HÀNH ĐỘNG

export interface DropPlan {
  /** Điều kiện còn thiếu (chặn đổi bước cho tới khi bổ sung). */
  missing: StageRequirement[];
  /** Form mở sẵn: chặn (BOOK, CONTRACT, LOST_REASON) thì mở trước khi đổi bước; DEPOSIT, QUOTE mở sau khi đổi bước. */
  action: DropAction | null;
  blocking: boolean;
  appointment: RequirementCheck["appointment"];
  message: string | null;
}

/**
 * P5: thả thẻ vào cột nào thì mở sẵn form nào. Thiếu lịch hẹn: đặt lịch; có lịch
 * chưa cọc ở bước cần lịch: thu cọc; thiếu hợp đồng: tạo hợp đồng; mất khách: lý do
 * mất; vào cột đến quầy (Đến cơ sở / Đã đến): lập báo giá.
 */
export async function planDrop(customerId: string, opportunity: { id: string; createdAt: Date } | null, mode: ClinicMode, toStage: string): Promise<DropPlan> {
  const check = await checkStageRequirements(customerId, opportunity, toStage);
  if (toStage === lostStageFor(mode)) {
    return { missing: [], action: DropAction.LOST_REASON, blocking: true, appointment: check.appointment, message: null };
  }
  if (check.missing.includes(StageRequirement.APPOINTMENT)) {
    return { missing: check.missing, action: DropAction.BOOK, blocking: true, appointment: null, message: REQUIREMENT_MESSAGE.APPOINTMENT };
  }
  if (check.missing.includes(StageRequirement.CONTRACT)) {
    return { missing: check.missing, action: DropAction.CONTRACT, blocking: true, appointment: check.appointment, message: REQUIREMENT_MESSAGE.CONTRACT };
  }
  const apptStages = await getSettingList("pipeline.requireAppointmentStages");
  if (apptStages.includes(toStage) && check.appointment && check.appointment.depositStatus !== "DA_COC") {
    return { missing: [], action: DropAction.DEPOSIT, blocking: false, appointment: check.appointment, message: null };
  }
  if (toStage === InjectionStage.DEN_CO_SO || toStage === FunnelStage.DEN) {
    return { missing: [], action: DropAction.QUOTE, blocking: false, appointment: check.appointment, message: null };
  }
  return { missing: [], action: null, blocking: false, appointment: check.appointment, message: null };
}

/** P4: chặn đổi bước tay khi thiếu điều kiện; lỗi 409 kèm `missing`, `action` để giao diện mở form. */
export async function assertStageRequirements(customerId: string, opportunity: { id: string; createdAt: Date } | null, mode: ClinicMode, toStage: string): Promise<void> {
  if (toStage === lostStageFor(mode)) return;
  const plan = await planDrop(customerId, opportunity, mode, toStage);
  if (plan.missing.length) {
    throw new HttpError(409, plan.message ?? "Thiếu điều kiện để sang bước này", { missing: plan.missing, action: plan.action });
  }
}
