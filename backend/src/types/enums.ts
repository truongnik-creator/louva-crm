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
});
export type AuditAction = (typeof AuditAction)[keyof typeof AuditAction];

export const AccessResourceType = makeEnum({
  MEDICAL_RECORD: "MEDICAL_RECORD",
  PHOTO: "PHOTO",
  CUSTOMER_PHONE: "CUSTOMER_PHONE",
  CONSENT_FORM: "CONSENT_FORM",
  PROCEDURE: "PROCEDURE",
  REPORT_EXPORT: "REPORT_EXPORT",
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
  D1: "D1",
  D7: "D7",
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
