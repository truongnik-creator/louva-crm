// Application-level "enums" backed by plain string columns in SQLite.
//
// Prisma on SQLite has no native `enum`, so the schema stores these as String
// columns. Each entry below is a `const` object plus a same-named type derived
// from its values — a drop-in shape for `z.nativeEnum(...)` and for call sites
// that used Prisma-generated enums. When the project moves to PostgreSQL these
// become real enums and this file shrinks to the few that stay app-only.
//
// Value sets mirror crm-app/docs/schema_tmv.prisma.

function makeEnum<T extends Record<string, string>>(v: T) {
  return Object.freeze(v);
}

export const UserStatus = makeEnum({
  ACTIVE: "ACTIVE",
  SUSPENDED: "SUSPENDED",
  RESIGNED: "RESIGNED",
});
export type UserStatus = (typeof UserStatus)[keyof typeof UserStatus];

export const Gender = makeEnum({ MALE: "MALE", FEMALE: "FEMALE", OTHER: "OTHER" });
export type Gender = (typeof Gender)[keyof typeof Gender];

/** Phạm vi dữ liệu — cổng 3 của mô hình phân quyền (mục 4.1 kiến trúc). */
export const PermissionScope = makeEnum({ ALL: "ALL", BRANCH: "BRANCH", OWN: "OWN" });
export type PermissionScope = (typeof PermissionScope)[keyof typeof PermissionScope];

export const AuditAction = makeEnum({
  CREATE: "CREATE",
  UPDATE: "UPDATE",
  DELETE: "DELETE",
  APPROVE: "APPROVE",
  REJECT: "REJECT",
  LOGIN: "LOGIN",
  LOGIN_FAILED: "LOGIN_FAILED",
  LOGOUT: "LOGOUT",
  BREAK_GLASS: "BREAK_GLASS",
  ACCOUNT_LOCKED: "ACCOUNT_LOCKED",
  MERGE: "MERGE",
  IMPORT: "IMPORT",
});
export type AuditAction = (typeof AuditAction)[keyof typeof AuditAction];

export const AccessResourceType = makeEnum({
  MEDICAL_RECORD: "MEDICAL_RECORD",
  PHOTO: "PHOTO",
  CUSTOMER_PHONE: "CUSTOMER_PHONE",
  CONSENT_FORM: "CONSENT_FORM",
  PROCEDURE: "PROCEDURE",
  REPORT_EXPORT: "REPORT_EXPORT",
  /** Gửi nội dung chat của khách lên dịch vụ AI (Nghị định 13/2023). */
  AI_PROCESSING: "AI_PROCESSING",
});
export type AccessResourceType = (typeof AccessResourceType)[keyof typeof AccessResourceType];

export const AccessSeverity = makeEnum({
  NORMAL: "NORMAL",
  ELEVATED: "ELEVATED",
  CRITICAL: "CRITICAL",
});
export type AccessSeverity = (typeof AccessSeverity)[keyof typeof AccessSeverity];

export const LeadStage = makeEnum({
  NEW: "NEW",
  CONTACTING: "CONTACTING",
  APPOINTED: "APPOINTED",
  ARRIVED: "ARRIVED",
  WON: "WON",
  LOST: "LOST",
  SPAM: "SPAM",
});
export type LeadStage = (typeof LeadStage)[keyof typeof LeadStage];

export const CustomerStatus = makeEnum({
  LEAD: "LEAD",
  ACTIVE: "ACTIVE",
  POST_OP: "POST_OP",
  COMPLETED: "COMPLETED",
  INACTIVE: "INACTIVE",
  BLACKLIST: "BLACKLIST",
});
export type CustomerStatus = (typeof CustomerStatus)[keyof typeof CustomerStatus];

/**
 * Giai đoạn phễu hiển thị trên UI — khớp đúng biến STAGES trong
 * docs/prototype_tmv.html. Đây là trục điều hành hằng ngày của telesale/tư vấn,
 * tách khỏi CustomerStatus (trục vòng đời khách).
 */
export const FunnelStage = makeEnum({
  MOI: "MOI",
  LIENHE: "LIENHE",
  HEN: "HEN",
  DEN: "DEN",
  CHOT: "CHOT",
  PT: "PT",
  HAUPHAU: "HAUPHAU",
  HOANTAT: "HOANTAT",
  TAIMUA: "TAIMUA",
  MAT: "MAT",
});
export type FunnelStage = (typeof FunnelStage)[keyof typeof FunnelStage];

/** Chế độ phòng khám (F6). INJECTION = nội khoa (tiêm), SURGERY = phẫu thuật. */
export const ClinicMode = makeEnum({ INJECTION: "INJECTION", SURGERY: "SURGERY" });
export type ClinicMode = (typeof ClinicMode)[keyof typeof ClinicMode];

/** F1: 7 bước bán hàng của phòng khám tiêm + bước mất khách. */
export const InjectionStage = makeEnum({
  TIEP_CAN: "TIEP_CAN",
  NHAN_TIN: "NHAN_TIN",
  CO_ANH: "CO_ANH",
  LICH_COC: "LICH_COC",
  DEN_CO_SO: "DEN_CO_SO",
  LAM_DICH_VU: "LAM_DICH_VU",
  QUAY_LAI: "QUAY_LAI",
  MAT_KHACH: "MAT_KHACH",
});
export type InjectionStage = (typeof InjectionStage)[keyof typeof InjectionStage];

/** F1: lý do mất khách (bắt buộc khi chuyển sang bước mất khách). */
export const LostReason = makeEnum({
  CHE_GIA: "CHE_GIA",
  O_XA: "O_XA",
  CHUA_SAN_SANG: "CHUA_SAN_SANG",
  KHONG_DU_DIEU_KIEN_Y_KHOA: "KHONG_DU_DIEU_KIEN_Y_KHOA",
  SO_SANH_NOI_KHAC: "SO_SANH_NOI_KHAC",
  KHONG_PHAN_HOI: "KHONG_PHAN_HOI",
  KHAC: "KHAC",
});
export type LostReason = (typeof LostReason)[keyof typeof LostReason];

export const StageSource = makeEnum({
  MANUAL: "MANUAL",
  AUTO: "AUTO",
  IMPORT: "IMPORT",
  MIGRATION: "MIGRATION",
});
export type StageSource = (typeof StageSource)[keyof typeof StageSource];

/** F1: sự kiện nghiệp vụ làm khách tự chuyển bước. */
export const StageEvent = makeEnum({
  MESSAGE: "MESSAGE",
  PHOTO: "PHOTO",
  APPOINTMENT_BOOKED: "APPOINTMENT_BOOKED",
  DEPOSIT_CONFIRMED: "DEPOSIT_CONFIRMED",
  CHECK_IN: "CHECK_IN",
  CONTRACT: "CONTRACT",
  PROCEDURE_DONE: "PROCEDURE_DONE",
  VISIT_SERVICE_DONE: "VISIT_SERVICE_DONE",
});
export type StageEvent = (typeof StageEvent)[keyof typeof StageEvent];

/** F25: trạng thái cọc của lịch hẹn. */
export const DepositStatus = makeEnum({
  CHO_COC: "CHO_COC",
  DA_COC: "DA_COC",
  HOAN_COC: "HOAN_COC",
});
export type DepositStatus = (typeof DepositStatus)[keyof typeof DepositStatus];

export const PaymentType = makeEnum({
  DEPOSIT: "DEPOSIT",
  PAYMENT: "PAYMENT",
  REFUND: "REFUND",
});
export type PaymentType = (typeof PaymentType)[keyof typeof PaymentType];

/** Thứ tự tiến của phễu — dùng để phát hiện "lùi trạng thái" (bắt buộc ghi lý do). */
export const FUNNEL_ORDER: FunnelStage[] = [
  FunnelStage.MOI,
  FunnelStage.LIENHE,
  FunnelStage.HEN,
  FunnelStage.DEN,
  FunnelStage.CHOT,
  FunnelStage.PT,
  FunnelStage.HAUPHAU,
  FunnelStage.HOANTAT,
  FunnelStage.TAIMUA,
];

export const ChannelKind = makeEnum({
  FACEBOOK: "FACEBOOK",
  TIKTOK: "TIKTOK",
  GOOGLE: "GOOGLE",
  ZALO: "ZALO",
  WEBSITE: "WEBSITE",
  REFERRAL: "REFERRAL",
  WALK_IN: "WALK_IN",
  HOTLINE: "HOTLINE",
  KOL: "KOL",
  OTHER: "OTHER",
});
export type ChannelKind = (typeof ChannelKind)[keyof typeof ChannelKind];

export const ConversationKind = makeEnum({ CUSTOMER: "CUSTOMER", GROUP: "GROUP" });
export type ConversationKind = (typeof ConversationKind)[keyof typeof ConversationKind];

export const ConversationChannel = makeEnum({
  ZALO_OA: "ZALO_OA",
  ZALO_GROUP: "ZALO_GROUP",
  FACEBOOK: "FACEBOOK",
  HOTLINE: "HOTLINE",
  INTERNAL: "INTERNAL",
});
export type ConversationChannel = (typeof ConversationChannel)[keyof typeof ConversationChannel];

export const MessageDirection = makeEnum({ IN: "IN", OUT: "OUT" });
export type MessageDirection = (typeof MessageDirection)[keyof typeof MessageDirection];

export const MessageType = makeEnum({
  TEXT: "TEXT",
  IMAGE: "IMAGE",
  FILE: "FILE",
  STICKER: "STICKER",
  LOCATION: "LOCATION",
  TEMPLATE: "TEMPLATE",
  SYSTEM: "SYSTEM",
});
export type MessageType = (typeof MessageType)[keyof typeof MessageType];

export const MessageStatus = makeEnum({
  PENDING: "PENDING",
  SENT: "SENT",
  DELIVERED: "DELIVERED",
  READ: "READ",
  FAILED: "FAILED",
});
export type MessageStatus = (typeof MessageStatus)[keyof typeof MessageStatus];

export const AppointmentType = makeEnum({
  CONSULT: "CONSULT",
  PRE_OP: "PRE_OP",
  SURGERY: "SURGERY",
  FOLLOW_UP: "FOLLOW_UP",
  TREATMENT: "TREATMENT",
  OTHER: "OTHER",
});
export type AppointmentType = (typeof AppointmentType)[keyof typeof AppointmentType];

export const AppointmentStatus = makeEnum({
  PENDING: "PENDING",
  CONFIRMED: "CONFIRMED",
  ARRIVED: "ARRIVED",
  DONE: "DONE",
  CANCELLED: "CANCELLED",
  NO_SHOW: "NO_SHOW",
});
export type AppointmentStatus = (typeof AppointmentStatus)[keyof typeof AppointmentStatus];

export const VisitStatus = makeEnum({
  WAITING: "WAITING",
  CONSULTING: "CONSULTING",
  IN_SERVICE: "IN_SERVICE",
  PAYING: "PAYING",
  DONE: "DONE",
  LEFT: "LEFT",
});
export type VisitStatus = (typeof VisitStatus)[keyof typeof VisitStatus];

/** Luồng hàng đợi lễ tân — chỉ cho phép đi tiếp theo thứ tự này. */
export const VISIT_FLOW: VisitStatus[] = [
  VisitStatus.WAITING,
  VisitStatus.CONSULTING,
  VisitStatus.IN_SERVICE,
  VisitStatus.PAYING,
  VisitStatus.DONE,
];

export const RoomType = makeEnum({
  CONSULT: "CONSULT",
  OPERATING: "OPERATING",
  MINOR_OP: "MINOR_OP",
  TREATMENT: "TREATMENT",
  RECOVERY: "RECOVERY",
});
export type RoomType = (typeof RoomType)[keyof typeof RoomType];

export const ShiftKind = makeEnum({
  MORNING: "MORNING",
  AFTERNOON: "AFTERNOON",
  FULL_DAY: "FULL_DAY",
  NIGHT: "NIGHT",
  ON_CALL: "ON_CALL",
});
export type ShiftKind = (typeof ShiftKind)[keyof typeof ShiftKind];

export const ShiftAssignmentStatus = makeEnum({
  PLANNED: "PLANNED",
  CONFIRMED: "CONFIRMED",
  SWAPPED: "SWAPPED",
  CANCELLED: "CANCELLED",
});
export type ShiftAssignmentStatus = (typeof ShiftAssignmentStatus)[keyof typeof ShiftAssignmentStatus];

export const ServiceKind = makeEnum({
  SURGERY: "SURGERY",
  MINOR_PROCEDURE: "MINOR_PROCEDURE",
  INJECTION: "INJECTION",
  LASER: "LASER",
  SKIN_CARE: "SKIN_CARE",
  CONSULT: "CONSULT",
  OTHER: "OTHER",
});
export type ServiceKind = (typeof ServiceKind)[keyof typeof ServiceKind];

export const QuotationStatus = makeEnum({
  DRAFT: "DRAFT",
  SENT: "SENT",
  ACCEPTED: "ACCEPTED",
  REJECTED: "REJECTED",
  EXPIRED: "EXPIRED",
});
export type QuotationStatus = (typeof QuotationStatus)[keyof typeof QuotationStatus];

export const ContractStatus = makeEnum({
  DRAFT: "DRAFT",
  SIGNED: "SIGNED",
  IN_PROGRESS: "IN_PROGRESS",
  COMPLETED: "COMPLETED",
  CANCELLED: "CANCELLED",
});
export type ContractStatus = (typeof ContractStatus)[keyof typeof ContractStatus];

export const InvoiceStatus = makeEnum({
  DRAFT: "DRAFT",
  ISSUED: "ISSUED",
  PARTIAL: "PARTIAL",
  PAID: "PAID",
  OVERDUE: "OVERDUE",
  VOID: "VOID",
});
export type InvoiceStatus = (typeof InvoiceStatus)[keyof typeof InvoiceStatus];

export const PaymentMethod = makeEnum({
  CASH: "CASH",
  BANK_TRANSFER: "BANK_TRANSFER",
  CARD: "CARD",
  QR: "QR",
  INSTALLMENT: "INSTALLMENT",
  OTHER: "OTHER",
  /** F20: trừ bằng voucher. KHÔNG phải tiền thật: báo cáo doanh thu đã thu bỏ qua. */
  VOUCHER: "VOUCHER",
});
export type PaymentMethod = (typeof PaymentMethod)[keyof typeof PaymentMethod];

export const ProcedureStatus = makeEnum({
  SCHEDULED: "SCHEDULED",
  CONFIRMED: "CONFIRMED",
  IN_PROGRESS: "IN_PROGRESS",
  COMPLETED: "COMPLETED",
  CANCELLED: "CANCELLED",
  POSTPONED: "POSTPONED",
});
export type ProcedureStatus = (typeof ProcedureStatus)[keyof typeof ProcedureStatus];

export const AnesthesiaType = makeEnum({
  NONE: "NONE",
  LOCAL: "LOCAL",
  SEDATION: "SEDATION",
  GENERAL: "GENERAL",
});
export type AnesthesiaType = (typeof AnesthesiaType)[keyof typeof AnesthesiaType];

export const PhotoStage = makeEnum({
  PRE_OP: "PRE_OP",
  INTRA_OP: "INTRA_OP",
  /** F2: mốc ảnh dịch vụ tiêm D0 (trước tiêm), D7, D30. */
  D0: "D0",
  D1: "D1",
  D7: "D7",
  D30: "D30",
  /** F2: ảnh khách tự gửi qua chat, ảnh chụp lúc tư vấn. */
  CHAT: "CHAT",
  CONSULT: "CONSULT",
  M1: "M1",
  M3: "M3",
  M6: "M6",
  OTHER: "OTHER",
});
export type PhotoStage = (typeof PhotoStage)[keyof typeof PhotoStage];

export const ConsentType = makeEnum({
  SURGERY: "SURGERY",
  ANESTHESIA: "ANESTHESIA",
  PHOTO_USE: "PHOTO_USE",
  DATA_PRIVACY: "DATA_PRIVACY",
  MINOR_PROCEDURE: "MINOR_PROCEDURE",
});
export type ConsentType = (typeof ConsentType)[keyof typeof ConsentType];

export const ConsentStatus = makeEnum({
  DRAFT: "DRAFT",
  SIGNED: "SIGNED",
  WITHDRAWN: "WITHDRAWN",
  EXPIRED: "EXPIRED",
});
export type ConsentStatus = (typeof ConsentStatus)[keyof typeof ConsentStatus];

export const TaskStatus = makeEnum({
  OPEN: "OPEN",
  IN_PROGRESS: "IN_PROGRESS",
  DONE: "DONE",
  CANCELLED: "CANCELLED",
});
export type TaskStatus = (typeof TaskStatus)[keyof typeof TaskStatus];

export const TaskPriority = makeEnum({
  LOW: "LOW",
  NORMAL: "NORMAL",
  HIGH: "HIGH",
  URGENT: "URGENT",
});
export type TaskPriority = (typeof TaskPriority)[keyof typeof TaskPriority];

export const ActivityType = makeEnum({
  NOTE: "NOTE",
  STAGE_CHANGE: "STAGE_CHANGE",
  STATUS_CHANGE: "STATUS_CHANGE",
  ASSIGNED: "ASSIGNED",
  MESSAGE: "MESSAGE",
  APPOINTMENT: "APPOINTMENT",
  CHECK_IN: "CHECK_IN",
  QUOTATION: "QUOTATION",
  CONTRACT: "CONTRACT",
  PAYMENT: "PAYMENT",
  MEDICAL: "MEDICAL",
  PROCEDURE: "PROCEDURE",
  SYSTEM: "SYSTEM",
  /** F10: chăm sóc sau điều trị (sinh việc, kết quả liên hệ). */
  AFTERCARE: "AFTERCARE",
  /** AI3: tóm tắt hội thoại + bước tiếp theo. */
  AI_SUMMARY: "AI_SUMMARY",
  /** Lô 8 · C4: cuộc gọi ghi tay (chiều, kết quả, thời lượng trong meta). */
  CALL: "CALL",
  /** Lô 8 · P6: mở, đóng cơ hội bán. */
  OPPORTUNITY: "OPPORTUNITY",
  /** Lô 8 · V3: dùng buổi gói liệu trình. */
  PACKAGE: "PACKAGE",
});
export type ActivityType = (typeof ActivityType)[keyof typeof ActivityType];

/** Bảy mục checklist tiền phẫu — khớp biến CHECKLIST trong prototype. */
export const PRE_OP_CHECKLIST = [
  "Đã đặt cọc tối thiểu theo quy định",
  "Đã ký cam kết phẫu thuật",
  "Đã có xét nghiệm tiền phẫu (30 ngày)",
  "Đã khám tiền mê (nếu mê toàn thân)",
  "Đã chụp ảnh trước mổ",
  "Đã dặn nhịn ăn / ngưng thuốc chống đông",
  "Đã xác nhận vật tư/implant có sẵn",
] as const;

export const ProductKind = makeEnum({
  CONSUMABLE: "CONSUMABLE",
  IMPLANT: "IMPLANT",
  MEDICINE: "MEDICINE",
  FILLER: "FILLER",
  INSTRUMENT: "INSTRUMENT",
  COSMETIC: "COSMETIC",
  OTHER: "OTHER",
});
export type ProductKind = (typeof ProductKind)[keyof typeof ProductKind];

export const StockMoveType = makeEnum({
  IN: "IN",
  OUT: "OUT",
  TRANSFER: "TRANSFER",
  ADJUST: "ADJUST",
  DISPOSE: "DISPOSE",
});
export type StockMoveType = (typeof StockMoveType)[keyof typeof StockMoveType];

export const PurchaseOrderStatus = makeEnum({
  DRAFT: "DRAFT",
  ORDERED: "ORDERED",
  PARTIAL: "PARTIAL",
  RECEIVED: "RECEIVED",
  CANCELLED: "CANCELLED",
});
export type PurchaseOrderStatus = (typeof PurchaseOrderStatus)[keyof typeof PurchaseOrderStatus];

export const AttendanceStatus = makeEnum({
  PRESENT: "PRESENT",
  LATE: "LATE",
  ABSENT: "ABSENT",
  ON_LEAVE: "ON_LEAVE",
  HOLIDAY: "HOLIDAY",
});
export type AttendanceStatus = (typeof AttendanceStatus)[keyof typeof AttendanceStatus];

export const LeaveType = makeEnum({
  ANNUAL: "ANNUAL",
  SICK: "SICK",
  UNPAID: "UNPAID",
  MATERNITY: "MATERNITY",
  OTHER: "OTHER",
});
export type LeaveType = (typeof LeaveType)[keyof typeof LeaveType];

export const LeaveStatus = makeEnum({
  PENDING: "PENDING",
  APPROVED: "APPROVED",
  REJECTED: "REJECTED",
  CANCELLED: "CANCELLED",
});
export type LeaveStatus = (typeof LeaveStatus)[keyof typeof LeaveStatus];

export const CommissionBasis = makeEnum({
  COLLECTED: "COLLECTED",
  SIGNED: "SIGNED",
});
export type CommissionBasis = (typeof CommissionBasis)[keyof typeof CommissionBasis];

export const CommissionStatus = makeEnum({
  PENDING: "PENDING",
  APPROVED: "APPROVED",
  PAID: "PAID",
  REVERSED: "REVERSED",
});
export type CommissionStatus = (typeof CommissionStatus)[keyof typeof CommissionStatus];

export const KpiGroup = makeEnum({
  SALES: "SALES",
  NURSING: "NURSING",
  DOCTOR: "DOCTOR",
  RECEPTION: "RECEPTION",
});
export type KpiGroup = (typeof KpiGroup)[keyof typeof KpiGroup];

export const CaseStudyStatus = makeEnum({
  DRAFT: "DRAFT",
  PENDING_MEDICAL: "PENDING_MEDICAL",
  PENDING_MARKETING: "PENDING_MARKETING",
  PUBLISHED: "PUBLISHED",
  REJECTED: "REJECTED",
  WITHDRAWN: "WITHDRAWN",
});
export type CaseStudyStatus = (typeof CaseStudyStatus)[keyof typeof CaseStudyStatus];

export const TreatmentPlanStatus = makeEnum({
  DRAFT: "DRAFT",
  PROPOSED: "PROPOSED",
  ACCEPTED: "ACCEPTED",
  REJECTED: "REJECTED",
});
export type TreatmentPlanStatus = (typeof TreatmentPlanStatus)[keyof typeof TreatmentPlanStatus];

export const WarehouseKind = makeEnum({
  MAIN: "MAIN",
  SUB: "SUB",
});
export type WarehouseKind = (typeof WarehouseKind)[keyof typeof WarehouseKind];

export const TransferStatus = makeEnum({
  PENDING: "PENDING",
  APPROVED: "APPROVED",
  COMPLETED: "COMPLETED",
  REJECTED: "REJECTED",
});
export type TransferStatus = (typeof TransferStatus)[keyof typeof TransferStatus];

// ============================================================ LÔ 4 · ĐỢT 2

/** F8: trạng thái một lần chạy tác vụ nền. */
export const JobRunStatus = makeEnum({ RUNNING: "RUNNING", SUCCESS: "SUCCESS", FAILED: "FAILED" });
export type JobRunStatus = (typeof JobRunStatus)[keyof typeof JobRunStatus];

export const JobTrigger = makeEnum({ SCHEDULE: "SCHEDULE", MANUAL: "MANUAL" });
export type JobTrigger = (typeof JobTrigger)[keyof typeof JobTrigger];

/** Loại việc (Task.kind), để gom nhóm ở trang Việc của tôi và màn Chăm sóc. */
export const TaskKind = makeEnum({
  /** Gọi lại khách (quá giờ hẹn chưa đến, khách hẹn gọi lại). */
  CALLBACK: "CALLBACK",
  /** Nhắc khách chuyển cọc cho lịch hẹn. */
  DEPOSIT_REMINDER: "DEPOSIT_REMINDER",
  /** F10: chăm sóc sau điều trị theo mốc D0, D1, D3... */
  AFTERCARE: "AFTERCARE",
  /** F9 quy tắc 8: đến mốc tái tiêm, cơ hội bán. */
  RETREAT: "RETREAT",
  /** F9 quy tắc 4: khách kẹt ở bước Có ảnh, chăm lại. */
  CARE_AGAIN: "CARE_AGAIN",
  /** F11: ngoài cửa sổ 24 giờ của Facebook, sale tự nhắn. */
  MANUAL_MESSAGE: "MANUAL_MESSAGE",
  /** F20: nhắc sale chúc mừng sinh nhật khách. */
  BIRTHDAY: "BIRTHDAY",
  /** Lô 8 · J3: việc trong checklist của bước. */
  STAGE_CHECKLIST: "STAGE_CHECKLIST",
  /** Lô 8 · V6: chăm lại báo giá bị từ chối. */
  QUOTE_FOLLOWUP: "QUOTE_FOLLOWUP",
  /** Lô 8 · V3: nhắc khách đặt buổi tiếp của gói liệu trình. */
  PACKAGE_REMINDER: "PACKAGE_REMINDER",
  OTHER: "OTHER",
});
export type TaskKind = (typeof TaskKind)[keyof typeof TaskKind];

/** F10: kết quả nút "Đã liên hệ". */
export const AftercareResult = makeEnum({
  /** Liên hệ được, khách ổn. */
  REACHED_OK: "REACHED_OK",
  /** Liên hệ được, khách có vấn đề: báo bác sĩ. */
  REACHED_ISSUE: "REACHED_ISSUE",
  /** Không nghe máy, không trả lời: việc giữ mở, dời hạn. */
  NO_ANSWER: "NO_ANSWER",
  /** Khách hẹn gọi lại: việc giữ mở, dời hạn theo ngày hẹn. */
  CALL_BACK_LATER: "CALL_BACK_LATER",
});
export type AftercareResult = (typeof AftercareResult)[keyof typeof AftercareResult];

/** F13: đợt ưu đãi giảm theo % hay số tiền. */
export const PromotionKind = makeEnum({ PERCENT: "PERCENT", AMOUNT: "AMOUNT" });
export type PromotionKind = (typeof PromotionKind)[keyof typeof PromotionKind];

/** F21: duyệt giảm giá vượt trần. */
export const ApprovalStatus = makeEnum({
  NOT_REQUIRED: "NOT_REQUIRED",
  PENDING: "PENDING",
  APPROVED: "APPROVED",
  REJECTED: "REJECTED",
});
export type ApprovalStatus = (typeof ApprovalStatus)[keyof typeof ApprovalStatus];

export const BroadcastStatus = makeEnum({
  QUEUED: "QUEUED",
  RUNNING: "RUNNING",
  DONE: "DONE",
  CANCELLED: "CANCELLED",
});
export type BroadcastStatus = (typeof BroadcastStatus)[keyof typeof BroadcastStatus];

export const RecipientStatus = makeEnum({
  PENDING: "PENDING",
  SENT: "SENT",
  FAILED: "FAILED",
  SKIPPED_OPT_OUT: "SKIPPED_OPT_OUT",
  /** Ngoài cửa sổ 24 giờ Facebook: đã tạo việc cho sale thay vì tự gửi. */
  TASK_CREATED: "TASK_CREATED",
  CANCELLED: "CANCELLED",
});
export type RecipientStatus = (typeof RecipientStatus)[keyof typeof RecipientStatus];

/** AI2: kết quả một lần gợi ý câu trả lời. */
export const AiSuggestionStatus = makeEnum({
  OK: "OK",
  /** Lớp 1: tin khách có từ khoá y khoa, không sinh, đề nghị chuyển bác sĩ. */
  BLOCKED_MEDICAL: "BLOCKED_MEDICAL",
  /** Lớp 2: câu trả lời không qua tự kiểm. */
  REJECTED_CHECK: "REJECTED_CHECK",
  NOT_CONFIGURED: "NOT_CONFIGURED",
  DISABLED: "DISABLED",
  NO_CONSENT: "NO_CONSENT",
  ERROR: "ERROR",
});
export type AiSuggestionStatus = (typeof AiSuggestionStatus)[keyof typeof AiSuggestionStatus];

// ------------------------------------------------------------ LÔ 5 · ĐỢT 3

/** F15: nguồn nhập chi phí quảng cáo theo ngày. */
export const CostSource = makeEnum({
  MANUAL: "MANUAL",
  CSV_META: "CSV_META",
  CSV_TIKTOK: "CSV_TIKTOK",
  CSV_OTHER: "CSV_OTHER",
});
export type CostSource = (typeof CostSource)[keyof typeof CostSource];

/** F17: FULL = sale chốt từ A đến Z; PARTIAL = sale kéo khách đến, bác sĩ chốt. */
export const CloseType = makeEnum({ FULL: "FULL", PARTIAL: "PARTIAL" });
export type CloseType = (typeof CloseType)[keyof typeof CloseType];

/** F17: kỳ lương. CLOSED = đã khoá, không tính lại được. */
export const PayrollStatus = makeEnum({ OPEN: "OPEN", CLOSED: "CLOSED" });
export type PayrollStatus = (typeof PayrollStatus)[keyof typeof PayrollStatus];

/** F17: phương án thưởng doanh số. */
export const BonusScheme = makeEnum({ MILESTONE: "MILESTONE", PERCENT_TIER: "PERCENT_TIER" });
export type BonusScheme = (typeof BonusScheme)[keyof typeof BonusScheme];

/** F20: voucher. Hết hạn không lưu thành trạng thái, tính theo expiresAt. */
export const VoucherStatus = makeEnum({ ACTIVE: "ACTIVE", REDEEMED: "REDEEMED", CANCELLED: "CANCELLED" });
export type VoucherStatus = (typeof VoucherStatus)[keyof typeof VoucherStatus];

export const VoucherSource = makeEnum({ MANUAL: "MANUAL", REFERRAL: "REFERRAL", BIRTHDAY: "BIRTHDAY", GIFT: "GIFT" });
export type VoucherSource = (typeof VoucherSource)[keyof typeof VoucherSource];

/** F19: hình thức thưởng giới thiệu. */
export const ReferralRewardKind = makeEnum({ VOUCHER: "VOUCHER", CASH: "CASH" });
export type ReferralRewardKind = (typeof ReferralRewardKind)[keyof typeof ReferralRewardKind];

export const ReferralRewardStatus = makeEnum({ ISSUED: "ISSUED", PENDING_PAYOUT: "PENDING_PAYOUT", PAID: "PAID" });
export type ReferralRewardStatus = (typeof ReferralRewardStatus)[keyof typeof ReferralRewardStatus];

/** AI4: kết quả chấm một hội thoại. */
export const ConversationScoreStatus = makeEnum({ SCORED: "SCORED", FAILED: "FAILED" });
export type ConversationScoreStatus = (typeof ConversationScoreStatus)[keyof typeof ConversationScoreStatus];

// ------------------------------------------------------------- Lô 6 · SAU 90 NGÀY

/** F30: vùng mặt trên phiếu tư vấn (máy tính bảng). */
export const FaceArea = makeEnum({
  TRAN: "TRAN",
  THAI_DUONG: "THAI_DUONG",
  HOC_MAT: "HOC_MAT",
  MUI: "MUI",
  MA: "MA",
  RANH_MUI_MA: "RANH_MUI_MA",
  MOI: "MOI",
  CAM: "CAM",
  HAM: "HAM",
  NONG_CAM: "NONG_CAM",
  CO: "CO",
  TOAN_MAT: "TOAN_MAT",
});
export type FaceArea = (typeof FaceArea)[keyof typeof FaceArea];

/** AI5: nháp tin chăm lại. QUEUED = sale đã duyệt, đã đưa vào hàng đợi gửi F11. */
export const ReengageDraftStatus = makeEnum({ PENDING: "PENDING", QUEUED: "QUEUED", REJECTED: "REJECTED", EXPIRED: "EXPIRED" });
export type ReengageDraftStatus = (typeof ReengageDraftStatus)[keyof typeof ReengageDraftStatus];

/** AI6: bản tin sáng do AI viết hay bản số liệu thuần (AI chưa cấu hình hoặc lỗi). */
export const BriefingSource = makeEnum({ AI: "AI", FALLBACK: "FALLBACK" });
export type BriefingSource = (typeof BriefingSource)[keyof typeof BriefingSource];

// ------------------------------------------------------------ Lô 7 · CRM 360

/** P1: nhiệt độ khách trên thẻ bảng bước. */
export const Heat = makeEnum({ HOT: "HOT", WARM: "WARM", COLD: "COLD" });
export type Heat = (typeof Heat)[keyof typeof Heat];

/** P1: mức số ngày ở bước so với ngưỡng của bước. */
export const StageAgeLevel = makeEnum({ OK: "OK", WARN: "WARN", OVERDUE: "OVERDUE", NONE: "NONE" });
export type StageAgeLevel = (typeof StageAgeLevel)[keyof typeof StageAgeLevel];

/** V1: ba phương án báo giá. */
export const QuoteTier = makeEnum({ BASIC: "BASIC", RECOMMENDED: "RECOMMENDED", PACKAGE: "PACKAGE" });
export type QuoteTier = (typeof QuoteTier)[keyof typeof QuoteTier];

/** V2: nơi gợi ý bán kèm. */
export const UpsellContext = makeEnum({ CONSULT: "CONSULT", COUNTER: "COUNTER", INBOX: "INBOX", QUOTE: "QUOTE" });
export type UpsellContext = (typeof UpsellContext)[keyof typeof UpsellContext];

/** V2: kết quả gợi ý bán kèm. */
export const UpsellOfferStatus = makeEnum({ SUGGESTED: "SUGGESTED", ACCEPTED: "ACCEPTED", DECLINED: "DECLINED" });
export type UpsellOfferStatus = (typeof UpsellOfferStatus)[keyof typeof UpsellOfferStatus];

// ------------------------------------------------------------ Lô 8 · CRM 360 LÔ B

/** P6: trạng thái cơ hội bán. WON = đã làm dịch vụ, LOST = mất. */
export const OpportunityStatus = makeEnum({ OPEN: "OPEN", WON: "WON", LOST: "LOST" });
export type OpportunityStatus = (typeof OpportunityStatus)[keyof typeof OpportunityStatus];

/** P6: cơ hội sinh ra từ đâu. */
export const OpportunitySource = makeEnum({ MIGRATION: "MIGRATION", AUTO: "AUTO", MANUAL: "MANUAL" });
export type OpportunitySource = (typeof OpportunitySource)[keyof typeof OpportunitySource];

/** P4: bước con tự tính theo cọc của lịch hẹn. */
export const DepositSubStage = makeEnum({ HEN_CHUA_COC: "HEN_CHUA_COC", DA_COC: "DA_COC" });
export type DepositSubStage = (typeof DepositSubStage)[keyof typeof DepositSubStage];

/** P4 + P5: điều kiện còn thiếu khi kéo thẻ, và form mở sẵn khi thả thẻ. */
export const StageRequirement = makeEnum({ APPOINTMENT: "APPOINTMENT", CONTRACT: "CONTRACT" });
export type StageRequirement = (typeof StageRequirement)[keyof typeof StageRequirement];

export const DropAction = makeEnum({
  BOOK: "BOOK",
  DEPOSIT: "DEPOSIT",
  LOST_REASON: "LOST_REASON",
  QUOTE: "QUOTE",
  CONTRACT: "CONTRACT",
});
export type DropAction = (typeof DropAction)[keyof typeof DropAction];

/** V3: gói liệu trình. */
export const PackageStatus = makeEnum({ ACTIVE: "ACTIVE", COMPLETED: "COMPLETED", CANCELLED: "CANCELLED" });
export type PackageStatus = (typeof PackageStatus)[keyof typeof PackageStatus];

/** C4: kết quả cuộc gọi ghi tay. */
export const CallResult = makeEnum({ ANSWERED: "ANSWERED", NO_ANSWER: "NO_ANSWER", BUSY: "BUSY", WRONG_NUMBER: "WRONG_NUMBER" });
export type CallResult = (typeof CallResult)[keyof typeof CallResult];

// ---------------------------------------------------------------------------
// F36: báo cáo công việc hàng ngày lấy từ trang tính Google
// ---------------------------------------------------------------------------

/** Cách dữ liệu đi từ trang tính về CRM. */
export const WorkReportSyncMode = makeEnum({
  /** Apps Script trong trang tính tự POST về CRM — dùng được cho trang tính ẩn. */
  PUSH: "PUSH",
  /** Backend tự đọc trang tính; chỉ chạy khi link chia sẻ công khai. */
  PULL: "PULL",
});
export type WorkReportSyncMode = (typeof WorkReportSyncMode)[keyof typeof WorkReportSyncMode];

export const WorkReportSyncStatus = makeEnum({ NEVER: "NEVER", OK: "OK", ERROR: "ERROR" });
export type WorkReportSyncStatus = (typeof WorkReportSyncStatus)[keyof typeof WorkReportSyncStatus];

/**
 * Tiến độ một dòng việc, chuẩn hoá từ chữ người dùng tự gõ trong trang tính
 * ("Hoàn thành", "Đang làm", "Trễ"...) để đếm và lọc được.
 */
export const WorkTaskStatus = makeEnum({
  DONE: "DONE",
  IN_PROGRESS: "IN_PROGRESS",
  LATE: "LATE",
  PENDING: "PENDING",
  CANCELLED: "CANCELLED",
  /** Dòng ghi "NGHỈ" — không phải việc, nhưng phải giữ để biết ngày nghỉ. */
  DAY_OFF: "DAY_OFF",
  UNKNOWN: "UNKNOWN",
});
export type WorkTaskStatus = (typeof WorkTaskStatus)[keyof typeof WorkTaskStatus];

/** Cột "Đánh giá bài đăng" theo bậc view của mẫu trang tính. */
export const WorkPostRating = makeEnum({
  /** Chưa tốt — dưới 5k view. */
  BAD: "BAD",
  /** Trung bình — từ 5k view. */
  AVERAGE: "AVERAGE",
  /** Tốt — từ 10k view. */
  GOOD: "GOOD",
  /** Xuất sắc — từ 50k view. */
  EXCELLENT: "EXCELLENT",
});
export type WorkPostRating = (typeof WorkPostRating)[keyof typeof WorkPostRating];
