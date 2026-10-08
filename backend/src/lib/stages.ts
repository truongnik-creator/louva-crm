import { prisma } from "./prisma";
import { logger } from "./logger";
import { getSettingNumber, getSettingRaw } from "./settings-catalog";
import { startOfVnDay } from "./datetime";
import {
  createStageTasksSafe,
  ensureCurrentOpportunity,
  openOpportunity,
  shouldAutoOpen,
  statusForStage,
  syncCustomerStage,
} from "./opportunities";
import {
  ActivityType,
  ClinicMode,
  OpportunitySource,
  OpportunityStatus,
  FunnelStage,
  InjectionStage,
  LostReason,
  StageEvent,
  StageSource,
} from "../types/enums";

// F1 + F6: bước bán hàng của khách theo CHẾ ĐỘ PHÒNG KHÁM.
//
// Mỗi chế độ có một bộ bước riêng. Phòng khám tiêm (mặc định) dùng 7 bước
// TIEP_CAN → QUAY_LAI + MAT_KHACH; phòng khám phẫu thuật giữ bộ bước cũ MOI → TAIMUA
// + MAT. Mọi chỗ đổi bước (tay, tự động, nhập file) đi qua `changeStage` để
// luôn ghi StageHistory: báo cáo chuyển đổi đọc bảng đó, không đọc Activity.

export interface StageDef {
  key: string;
  label: string;
  bg: string;
  fg: string;
  /** Bước mất khách: bắt buộc lostReason. */
  lost?: boolean;
}

export const INJECTION_STAGES: StageDef[] = [
  { key: InjectionStage.TIEP_CAN, label: "Tiếp cận", bg: "#EEF2FF", fg: "#4338CA" },
  { key: InjectionStage.NHAN_TIN, label: "Nhắn tin", bg: "#FEF3C7", fg: "#B45309" },
  { key: InjectionStage.CO_ANH, label: "Có ảnh", bg: "#FAE8FF", fg: "#A21CAF" },
  { key: InjectionStage.LICH_COC, label: "Lịch cọc", bg: "#DBEAFE", fg: "#1D4ED8" },
  { key: InjectionStage.DEN_CO_SO, label: "Đến cơ sở", bg: "#CFFAFE", fg: "#0E7490" },
  { key: InjectionStage.LAM_DICH_VU, label: "Làm dịch vụ", bg: "#DCFCE7", fg: "#15803D" },
  { key: InjectionStage.QUAY_LAI, label: "Quay lại", bg: "#D1FAE5", fg: "#047857" },
  { key: InjectionStage.MAT_KHACH, label: "Mất khách", bg: "#FEE2E2", fg: "#B91C1C", lost: true },
];

export const SURGERY_STAGES: StageDef[] = [
  { key: FunnelStage.MOI, label: "Mới", bg: "#EEF2FF", fg: "#4338CA" },
  { key: FunnelStage.LIENHE, label: "Đã liên hệ", bg: "#FEF3C7", fg: "#B45309" },
  { key: FunnelStage.HEN, label: "Đã hẹn", bg: "#DBEAFE", fg: "#1D4ED8" },
  { key: FunnelStage.DEN, label: "Đã đến", bg: "#CFFAFE", fg: "#0E7490" },
  { key: FunnelStage.CHOT, label: "Đã chốt", bg: "#DCFCE7", fg: "#15803D" },
  { key: FunnelStage.PT, label: "Đã phẫu thuật", bg: "#D1FAE5", fg: "#047857" },
  { key: FunnelStage.HAUPHAU, label: "Hậu phẫu", bg: "#E0F2FE", fg: "#0369A1" },
  { key: FunnelStage.HOANTAT, label: "Hoàn tất", bg: "#F1F5F9", fg: "#475569" },
  { key: FunnelStage.TAIMUA, label: "Tái mua", bg: "#FAE8FF", fg: "#A21CAF" },
  { key: FunnelStage.MAT, label: "Mất khách", bg: "#FEE2E2", fg: "#B91C1C", lost: true },
];

export const LOST_REASONS: Array<{ key: LostReason; label: string }> = [
  { key: LostReason.CHE_GIA, label: "Chê giá" },
  { key: LostReason.O_XA, label: "Ở xa" },
  { key: LostReason.CHUA_SAN_SANG, label: "Chưa sẵn sàng" },
  { key: LostReason.KHONG_DU_DIEU_KIEN_Y_KHOA, label: "Không đủ điều kiện y khoa" },
  { key: LostReason.SO_SANH_NOI_KHAC, label: "So sánh nơi khác" },
  { key: LostReason.KHONG_PHAN_HOI, label: "Không phản hồi" },
  { key: LostReason.KHAC, label: "Khác" },
];

/** Bước cũ (bộ phẫu thuật) sang bộ 7 bước tiêm. Dùng cho script migrate-stages. */
export const LEGACY_TO_INJECTION: Record<string, InjectionStage> = {
  [FunnelStage.MOI]: InjectionStage.TIEP_CAN,
  [FunnelStage.LIENHE]: InjectionStage.NHAN_TIN,
  // Có lịch nhưng chưa có dữ liệu cọc: vẫn ở bước nhắn tin. Script nâng lên
  // LICH_COC nếu lịch sắp tới đã có cọc.
  [FunnelStage.HEN]: InjectionStage.NHAN_TIN,
  [FunnelStage.DEN]: InjectionStage.DEN_CO_SO,
  [FunnelStage.CHOT]: InjectionStage.DEN_CO_SO,
  [FunnelStage.PT]: InjectionStage.LAM_DICH_VU,
  [FunnelStage.HAUPHAU]: InjectionStage.LAM_DICH_VU,
  [FunnelStage.HOANTAT]: InjectionStage.LAM_DICH_VU,
  [FunnelStage.TAIMUA]: InjectionStage.QUAY_LAI,
  [FunnelStage.MAT]: InjectionStage.MAT_KHACH,
};

export function parseClinicMode(raw: string | null | undefined): ClinicMode {
  return raw === ClinicMode.SURGERY ? ClinicMode.SURGERY : ClinicMode.INJECTION;
}

export async function getClinicMode(): Promise<ClinicMode> {
  return parseClinicMode(await getSettingRaw("clinic.mode"));
}

export function stagesFor(mode: ClinicMode): StageDef[] {
  return mode === ClinicMode.SURGERY ? SURGERY_STAGES : INJECTION_STAGES;
}

export function initialStageFor(mode: ClinicMode): string {
  return stagesFor(mode)[0].key;
}

export function lostStageFor(mode: ClinicMode): string {
  return stagesFor(mode).find((s) => s.lost)!.key;
}

export function isValidStage(mode: ClinicMode, stage: string): boolean {
  return stagesFor(mode).some((s) => s.key === stage);
}

/** Thứ hạng tiến của bước (bước mất khách = -1, bước lạ = -1). */
export function stageRank(mode: ClinicMode, stage: string | null | undefined): number {
  const list = stagesFor(mode);
  const idx = list.findIndex((s) => s.key === stage);
  if (idx < 0 || list[idx].lost) return -1;
  return idx;
}

/** Nhãn tiếng Việt của một bước, tra cả hai bộ (dữ liệu cũ chưa migrate vẫn đọc được). */
export function stageLabel(stage: string | null | undefined): string {
  if (!stage) return "(chưa có)";
  return (
    INJECTION_STAGES.find((s) => s.key === stage)?.label ??
    SURGERY_STAGES.find((s) => s.key === stage)?.label ??
    stage
  );
}

export function lostReasonLabel(reason: string | null | undefined): string {
  return LOST_REASONS.find((r) => r.key === reason)?.label ?? reason ?? "";
}

/**
 * Bước đích của một sự kiện nghiệp vụ theo chế độ phòng khám. null = sự kiện
 * không đổi bước ở chế độ này.
 */
export function stageForEvent(mode: ClinicMode, event: StageEvent, opts: { isReturn?: boolean } = {}): string | null {
  if (mode === ClinicMode.SURGERY) {
    switch (event) {
      case StageEvent.MESSAGE:
        return FunnelStage.LIENHE;
      case StageEvent.APPOINTMENT_BOOKED:
      case StageEvent.DEPOSIT_CONFIRMED:
        return FunnelStage.HEN;
      case StageEvent.CHECK_IN:
        return FunnelStage.DEN;
      case StageEvent.CONTRACT:
        return FunnelStage.CHOT;
      case StageEvent.PROCEDURE_DONE:
        return FunnelStage.PT;
      default:
        return null;
    }
  }
  switch (event) {
    case StageEvent.MESSAGE:
      return InjectionStage.NHAN_TIN;
    case StageEvent.PHOTO:
      return InjectionStage.CO_ANH;
    case StageEvent.DEPOSIT_CONFIRMED:
      return InjectionStage.LICH_COC;
    case StageEvent.CHECK_IN:
      return InjectionStage.DEN_CO_SO;
    case StageEvent.PROCEDURE_DONE:
    case StageEvent.VISIT_SERVICE_DONE:
      return opts.isReturn ? InjectionStage.QUAY_LAI : InjectionStage.LAM_DICH_VU;
    default:
      // Đặt lịch chưa cọc, ký hợp đồng: không phải một bước riêng ở phòng khám tiêm.
      return null;
  }
}

/** Sự kiện đủ mạnh để kéo khách đã mất quay lại quy trình. */
const REACTIVATING: StageEvent[] = [
  StageEvent.DEPOSIT_CONFIRMED,
  StageEvent.CHECK_IN,
  StageEvent.CONTRACT,
  StageEvent.PROCEDURE_DONE,
  StageEvent.VISIT_SERVICE_DONE,
];

const SERVICE_EVENTS: StageEvent[] = [StageEvent.PROCEDURE_DONE, StageEvent.VISIT_SERVICE_DONE];

const EVENT_LABEL: Record<StageEvent, string> = {
  MESSAGE: "nhắn tin",
  PHOTO: "khách gửi ảnh",
  APPOINTMENT_BOOKED: "đặt lịch",
  DEPOSIT_CONFIRMED: "xác nhận đã cọc",
  CHECK_IN: "check-in tại cơ sở",
  CONTRACT: "chốt hợp đồng",
  PROCEDURE_DONE: "hoàn tất lần thực hiện",
  VISIT_SERVICE_DONE: "làm xong dịch vụ tại quầy",
};

export interface ChangeStageInput {
  customerId: string;
  fromStage: string | null;
  toStage: string;
  source: StageSource;
  event?: StageEvent | null;
  lostReason?: string | null;
  note?: string | null;
  actor?: { id: string; name: string } | null;
  mode: ClinicMode;
  extra?: Record<string, unknown>;
  /** Lô 8 · P6: cơ hội cần đổi bước. Trống = cơ hội hiện tại của khách (tạo nếu chưa có). */
  opportunityId?: string | null;
  /** Lô 8 · P4: bước con chọn tay (bước con theo cọc tự tính). */
  subStage?: string | null;
  /** Cơ sở nơi xảy ra sự kiện (check-in): dùng chọn việc theo bước khi cơ hội chưa gắn cơ sở. */
  branchId?: string | null;
}

/**
 * Ghi đổi bước + StageHistory + Activity. Không kiểm luật; gọi từ route/tự động đã kiểm.
 * Lô 8 · P6: đổi bước CỦA CƠ HỘI rồi đồng bộ Customer.stage (cơ hội mở mới nhất,
 * không có thì cơ hội gần nhất). Khách chỉ có một cơ hội thì kết quả y như trước.
 */
export async function changeStage(input: ChangeStageInput) {
  const toLost = stagesFor(input.mode).find((s) => s.key === input.toStage)?.lost ?? false;
  const opp = input.opportunityId
    ? await prisma.opportunity.findUniqueOrThrow({ where: { id: input.opportunityId } })
    : await ensureCurrentOpportunity(input.customerId, input.mode);
  if (!opp) throw new Error(`Không tìm thấy khách ${input.customerId}`);
  const fromStage = input.opportunityId ? opp.stage : input.fromStage;
  const via =
    input.source === StageSource.AUTO && input.event
      ? `tự động khi ${EVENT_LABEL[input.event]}`
      : input.source === StageSource.IMPORT
        ? "khi nhập file"
        : input.source === StageSource.MIGRATION
          ? "khi chuyển bộ bước"
          : input.actor
            ? `bởi ${input.actor.name}`
            : "";
  const parts = [`Đổi bước: ${stageLabel(fromStage)} → ${stageLabel(input.toStage)}`];
  if (via) parts.push(`(${via})`);
  if (toLost && input.lostReason) parts.push(`. Lý do mất: ${lostReasonLabel(input.lostReason)}`);
  if (input.note) parts.push(`. Ghi chú: ${input.note}`);
  const multi = (await prisma.opportunity.count({ where: { customerId: input.customerId } })) > 1;
  if (multi) parts.push(`. Cơ hội: ${opp.title}`);

  const now = new Date();
  const status = statusForStage(input.mode, input.toStage);
  const customer = await prisma.$transaction(async (tx) => {
    await tx.opportunity.update({
      where: { id: opp.id },
      data: {
        stage: input.toStage,
        stageChangedAt: now,
        status,
        lostReason: toLost ? (input.lostReason ?? null) : null,
        lostNote: toLost ? (input.note ?? null) : null,
        closedAt: status === OpportunityStatus.OPEN ? null : now,
        subStage: input.subStage ?? null,
      },
    });
    await tx.stageHistory.create({
      data: {
        customerId: input.customerId,
        opportunityId: opp.id,
        fromStage,
        toStage: input.toStage,
        source: input.source,
        event: input.event ?? null,
        lostReason: toLost ? (input.lostReason ?? null) : null,
        note: input.note ?? null,
        userId: input.actor?.id ?? null,
        userName: input.actor?.name ?? null,
        createdAt: now,
      },
    });
    await tx.customer.update({
      where: { id: input.customerId },
      data: {
        ...(input.extra ?? {}),
        activities: {
          create: {
            type: ActivityType.STAGE_CHANGE,
            content: parts.join(" "),
            userId: input.actor?.id ?? null,
            userName: input.actor?.name ?? null,
          },
        },
      },
    });
    await syncCustomerStage(input.customerId, tx);
    return tx.customer.findUniqueOrThrow({ where: { id: input.customerId } });
  });
  if (input.source === StageSource.MANUAL || input.source === StageSource.AUTO) {
    await createStageTasksSafe(opp.id, input.toStage, { branchId: input.branchId ?? null, fallbackAssigneeId: input.actor?.id ?? null });
  }
  return customer;
}

export interface StageEventResult {
  changed: boolean;
  from: string | null;
  to: string | null;
}

/**
 * Tự chuyển bước khi có sự kiện (F1). Chỉ TIẾN, không bao giờ tự lùi; khách đã
 * mất chỉ được kéo lại bởi sự kiện mạnh (cọc, check-in, làm dịch vụ). Lỗi ở
 * đây không được làm hỏng nghiệp vụ gốc: người gọi nên bắt lỗi và ghi log.
 */
export async function applyStageEvent(
  customerId: string | null | undefined,
  event: StageEvent,
  opts: { actor?: { id: string; name: string } | null; at?: Date; branchId?: string | null } = {}
): Promise<StageEventResult> {
  const none = { changed: false, from: null, to: null };
  if (!customerId) return none;
  const customer = await prisma.customer.findUnique({
    where: { id: customerId },
    select: { id: true, stage: true, lastServiceAt: true, mergedIntoId: true },
  });
  if (!customer || customer.mergedIntoId) return none;

  const mode = await getClinicMode();
  const at = opts.at ?? new Date();
  let isReturn = false;
  let serviceUpdate: Record<string, unknown> | undefined;

  if (SERVICE_EVENTS.includes(event)) {
    const last = customer.lastServiceAt;
    const sameDay = last ? startOfVnDay(last).getTime() === startOfVnDay(at).getTime() : false;
    if (last && !sameDay) {
      const windowDays = await getSettingNumber("stage.returnWindowDays");
      isReturn = at.getTime() - last.getTime() <= windowDays * 86_400_000;
    }
    // Cùng một ngày (ca thực hiện + khách rời quầy) chỉ tính một lần làm dịch vụ.
    if (!sameDay) serviceUpdate = { lastServiceAt: at };
  }

  const target = stageForEvent(mode, event, { isReturn });
  // Lô 8 · P6: sự kiện áp vào cơ hội hiện tại (đã khớp bước với Customer.stage).
  const opp = await ensureCurrentOpportunity(customerId, mode);
  const lost = lostStageFor(mode);
  const current = opp?.stage ?? customer.stage;
  const blocked =
    !target ||
    target === current ||
    (current === lost && !REACTIVATING.includes(event)) ||
    (current !== lost && stageRank(mode, target) <= stageRank(mode, current));

  // Khách đã làm dịch vụ có sự kiện mua mới (cọc, check-in): mở cơ hội mới thay vì giữ bước cũ.
  if (blocked && target && opp && opp.status === OpportunityStatus.WON && (await shouldAutoOpen(customerId, event, customer.lastServiceAt, at))) {
    await openOpportunity({
      customerId,
      stage: target,
      mode,
      source: OpportunitySource.AUTO,
      actor: opts.actor ?? null,
      event,
      note: `Khách quay lại, ${EVENT_LABEL[event]}`,
      customerExtra: serviceUpdate,
      branchId: opts.branchId ?? null,
    });
    return { changed: true, from: current, to: target };
  }

  if (blocked) {
    if (serviceUpdate) await prisma.customer.update({ where: { id: customerId }, data: serviceUpdate });
    return { changed: false, from: current, to: current };
  }

  await changeStage({
    customerId,
    fromStage: current,
    toStage: target!,
    source: StageSource.AUTO,
    event,
    actor: opts.actor ?? null,
    mode,
    extra: serviceUpdate,
    opportunityId: opp?.id ?? null,
    branchId: opts.branchId ?? null,
  });
  return { changed: true, from: current, to: target };
}

/** Bọc applyStageEvent cho luồng nghiệp vụ: không bao giờ ném lỗi ra ngoài. */
export async function applyStageEventSafe(
  customerId: string | null | undefined,
  event: StageEvent,
  opts: { actor?: { id: string; name: string } | null; at?: Date; branchId?: string | null } = {}
): Promise<StageEventResult> {
  try {
    return await applyStageEvent(customerId, event, opts);
  } catch (err) {
    logger.error({ err, customerId, event }, "[stage] tự chuyển bước lỗi");
    return { changed: false, from: null, to: null };
  }
}
