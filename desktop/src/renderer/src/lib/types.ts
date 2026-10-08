/* Kiểu dữ liệu dùng chung cho renderer. Khớp với phản hồi API của backend
   (crm-app/backend/src/routes). Chỉ khai báo những trường giao diện thật sự
   dùng — không chép nguyên bảng CSDL. */

export type PermissionScope = 'ALL' | 'BRANCH' | 'OWN'
export type EffectivePermissions = Record<string, PermissionScope>

export interface Branch {
  id: string
  code: string
  name: string
  shortName?: string | null
  isPrimary?: boolean
}

export interface RoleRef {
  code: string
  name: string
}

export interface CurrentUser {
  id: string
  email: string
  name: string
  title?: string | null
  phone?: string | null
  mustChangePassword: boolean
  department?: { id: string; name: string } | null
  roles: RoleRef[]
  branches: Branch[]
  permissions: EffectivePermissions
}

export interface UserRef {
  id: string
  name: string
  title?: string | null
}

export interface StaffUser extends UserRef {
  email: string
  phone?: string | null
  status: string
  lastLoginAt?: string | null
  createdAt: string
  department?: { id: string; name: string } | null
  roles: Array<{ id: string; code: string; name: string }>
  branches: Branch[]
}

/** Bộ bước phẫu thuật (clinic.mode = SURGERY). */
export type SurgeryStage =
  | 'MOI'
  | 'LIENHE'
  | 'HEN'
  | 'DEN'
  | 'CHOT'
  | 'PT'
  | 'HAUPHAU'
  | 'HOANTAT'
  | 'TAIMUA'
  | 'MAT'

/** F1: bộ 7 bước phòng khám tiêm (clinic.mode = INJECTION, mặc định). */
export type InjectionStage =
  | 'TIEP_CAN'
  | 'NHAN_TIN'
  | 'CO_ANH'
  | 'LICH_COC'
  | 'DEN_CO_SO'
  | 'LAM_DICH_VU'
  | 'QUAY_LAI'
  | 'MAT_KHACH'

export type FunnelStage = SurgeryStage | InjectionStage

export interface CustomerListItem {
  id: string
  code: string
  name: string
  phone: string | null
  status: string
  stage: FunnelStage
  lostReason?: string | null
  interest: string[]
  lastContactAt: string | null
  createdAt: string
  assignedTo: UserRef | null
  telesale: UserRef | null
  channel: { id: string; name: string; kind: string } | null
  branches: Branch[]
}

export interface CustomerDetail extends CustomerListItem {
  email: string | null
  dob: string | null
  gender: string | null
  address: string | null
  city: string | null
  note: string | null
  budgetNote: string | null
  campaign: { id: string; name: string; code: string } | null
  tags: Array<{ id: string; name: string; color: string }>
  totalPaid: number
  debt: number
  aiDataConsent?: boolean
  aiDataConsentAt?: string | null
  /** F11: khách từ chối nhận tin gửi theo nhóm. */
  optOut?: boolean
}

export interface TimelineEntry {
  at: string
  kind: 'activity' | 'message' | 'appointment' | 'contract' | 'payment'
  type: string
  text: string
  by: string | null
}

export interface Conversation {
  id: string
  kind: 'CUSTOMER' | 'GROUP'
  channel: string
  title: string
  externalId: string | null
  memberCount: number | null
  customerId: string | null
  unreadCount: number
  lastMessageAt: string | null
  lastMessagePreview: string | null
  branchId: string | null
  customer: {
    id: string
    name: string
    phone: string | null
    code: string
    stage: FunnelStage
  } | null
  assignedTo: UserRef | null
  branch?: Branch | null
  pancakeConversationId?: string | null
  adId?: string | null
  adPostId?: string | null
  adCampaign?: string | null
  /** F26: nhóm kênh cho huy hiệu, số phút khách chờ, nhãn, cờ y khoa. */
  channelGroup?: 'FB' | 'ZALO' | 'TIKTOK' | 'OTHER'
  waitingSince?: string | null
  waitingMinutes?: number | null
  tags?: Array<{ id: string; name: string; color: string }>
  medicalFlag?: boolean
}

export interface ConversationDetail extends Conversation {
  customer:
    | (CustomerListItem & {
        assignedTo: UserRef | null
        telesale: UserRef | null
        aiDataConsent?: boolean
        city?: string | null
      })
    | null
  nextAppointment?: {
    id: string
    title: string
    startAt: string
    code?: string | null
    depositAmount?: number
    depositStatus?: string | null
    doctor?: { name: string } | null
    room?: { name: string } | null
  } | null
  debt?: number
  debtDueDate?: string | null
  totalPaid?: number
}

export interface ChatMessage {
  id: string
  conversationId: string
  direction: 'IN' | 'OUT'
  type: string
  content: string
  senderName: string | null
  status: string
  errorMessage: string | null
  createdAt: string
  attachments?: MessageAttachment[]
}

/** Ảnh, tệp khách gửi kèm tin nhắn (B13). */
export interface MessageAttachment {
  id: string
  kind: 'IMAGE' | 'FILE' | string
  fileName: string
  mimeType: string | null
  size: number | null
  savedPhotoSetId: string | null
}

export interface QuickReply {
  id: string
  title: string
  content: string
  category: string | null
  active?: boolean
}

export interface TemplateVariable {
  key: string
  label: string
  example: string
}

export type AppointmentStatus =
  | 'PENDING'
  | 'CONFIRMED'
  | 'ARRIVED'
  | 'DONE'
  | 'CANCELLED'
  | 'NO_SHOW'

export interface Appointment {
  id: string
  branchId: string
  title: string
  type: string
  status: AppointmentStatus
  startAt: string
  endAt: string
  note: string | null
  code?: string | null
  depositAmount?: number
  depositStatus?: 'CHO_COC' | 'DA_COC' | 'HOAN_COC' | null
  customer: { id: string; name: string; phone: string | null; code: string; stage: FunnelStage }
  doctor: UserRef | null
  room: { id: string; name: string; code: string; type: string } | null
  service: { id: string; name: string; durationMin: number } | null
  visit: { id: string; status: string; queueNumber: number } | null
}

export interface Visit {
  id: string
  branchId: string
  queueNumber: number
  status: 'WAITING' | 'CONSULTING' | 'IN_SERVICE' | 'PAYING' | 'DONE' | 'LEFT'
  purpose: string | null
  checkedInAt: string
  calledAt: string | null
  waitingMinutes: number
  customer: { id: string; name: string; phone: string | null; code: string; stage: FunnelStage }
  appointment: { id: string; title: string; startAt: string; doctor?: { name: string } | null } | null
  consultant: UserRef | null
}

export interface Room {
  id: string
  branchId: string
  code: string
  name: string
  type: string
  capacity: number
  active: boolean
}

export interface Service {
  id: string
  code: string
  name: string
  kind: string
  durationMin: number
  recoveryDays: number | null
  requiresConsent: boolean
  requiresPreOpLab: boolean
  anesthesia: string | null
  active: boolean
  category: { id: string; name: string } | null
  price: number | null
  minPrice: number | null
  /** F10: số ngày tái tiêm. */
  retreatDays?: number | null
}

export interface Lead {
  id: string
  name: string
  phone: string | null
  interest: string | null
  stage: string
  lostReason: string | null
  note: string | null
  createdAt: string
  channel: { id: string; name: string; kind: string } | null
  campaign: { id: string; name: string; code: string } | null
  assignedTo: UserRef | null
}

export interface Campaign {
  id: string
  code: string
  name: string
  budget: number | null
  startDate: string | null
  endDate: string | null
  active: boolean
  channel: { id: string; name: string; kind: string } | null
  leadCount: number
  customerCount: number
  spentAmount: number
}

export interface Contract {
  id: string
  code: string
  status: string
  subtotal: number
  discount: number
  total: number
  paidAmount: number
  remaining: number
  signedAt: string | null
  createdAt: string
  note: string | null
  customer: { id: string; name: string; code: string; phone: string | null }
  consultant: UserRef | null
  branch: Branch
  items: Array<{ id: string; name: string; quantity: number; unitPrice: number; amount: number }>
}

export interface Invoice {
  id: string
  code: string
  title: string | null
  status: string
  amount: number
  paidAmount: number
  remaining: number
  dueDate: string | null
  overdueDays: number
  customer: { id: string; name: string; code: string; phone: string | null }
  contract: { id: string; code: string } | null
}

export interface DebtReport {
  totalDebt: number
  overdueCount: number
  overdueAmount: number
  items: Invoice[]
}

export interface Payment {
  id: string
  code: string
  amount: number
  method: string
  reference: string | null
  paidAt: string
  customer: { id: string; name: string; code: string }
  receivedBy: UserRef | null
  invoice: { id: string; code: string; title: string | null } | null
}

export interface Procedure {
  id: string
  code: string
  title: string
  status: string
  anesthesia: string
  scheduledAt: string
  durationMin: number
  teamNote: string | null
  materialNote: string | null
  report: string | null
  checklistMissing: number
  checklistReady: boolean
  customer: { id: string; name: string; code: string; phone: string | null }
  surgeon: UserRef | null
  room: { id: string; name: string; code: string } | null
  service: { id: string; name: string } | null
  contract: { id: string; code: string; total: number; paidAmount: number; status: string } | null
}

export interface ChecklistResult {
  items: Array<{ label: string; ok: boolean; detail?: string }>
  missing: number
  ready: boolean
}

export interface MedicalRecord {
  id: string
  code: string
  branchId: string
  customerId: string
  bloodType: string | null
  /** Không có khi restricted (S5). */
  chronicDisease?: string | null
  currentMedication?: string | null
  smoking: boolean
  pregnancyNote?: string | null
  pastAesthetic: string | null
  doctor: UserRef | null
  branch: Branch
  restricted: boolean
  entries: Array<{
    id: string
    kind: string
    content: string
    authorName: string | null
    createdAt: string
  }>
  allergies: Array<{ id: string; substance: string; reaction: string | null; severity: string }>
  contraindications: Array<{ id: string; content: string; blocking: boolean }>
}

export interface ConsentForm {
  id: string
  type: string
  title: string
  bodyText: string
  status: string
  signedAt: string | null
  hasSignature: boolean
  createdAt: string
  staff: UserRef | null
}

export interface PhotoSet {
  id: string
  stage: string
  consentForMarketing?: boolean
  takenAt: string
  note: string | null
  takenBy: UserRef | null
  photos: Array<{ id: string; fileName: string; angle: string | null; mimeType: string; size: number }>
}

export interface DashboardKpi {
  label: string
  value: number
  unit: string
  invert?: boolean
  delta: { value: number; pct: number | null; up: boolean }
}

export interface DashboardData {
  period: { from: string; to: string }
  kpis: DashboardKpi[]
  funnel: Array<{ stage: FunnelStage; label: string; count: number }>
  daily: Array<{ date: string; signed: number; collected: number }>
  topServices: Array<{ name: string; count: number; revenue: number }>
  topConsultants: Array<{
    userId: string | null
    name: string
    collected: number
    signed: number
    contracts: number
  }>
  alerts: Array<{ level: 'dg' | 'wr'; text: string }>
}

export interface StaffPerformanceRow {
  userId: string
  name: string
  roles: string[]
  customersAssigned: number
  contractsWon: number
  signed: number
  collected: number
  messagesSent: number
  closeRate: number
}

export interface MarketingFunnelRow {
  campaignId: string
  name: string
  code: string
  channel: string
  leads: number
  won: number
  conversionRate: number
  spent: number
  revenue: number
  cpl: number
  roas: number | null
}

export interface AuditLogEntry {
  id: string
  actorName: string | null
  action: string
  entity: string
  entityId: string | null
  summary: string
  changes: Record<string, [unknown, unknown]> | null
  ipAddress: string | null
  createdAt: string
  branch: { code: string; shortName: string | null } | null
}

export interface DataAccessLogEntry {
  id: string
  actorName: string | null
  resourceType: string
  resourceId: string | null
  severity: 'NORMAL' | 'ELEVATED' | 'CRITICAL'
  reason: string | null
  rowCount: number | null
  createdAt: string
  customer: { id: string; name: string; code: string } | null
}

export interface ZaloOAConfigView {
  id: string
  label: string
  oaId: string
  appId: string
  active: boolean
  connected: boolean
  tokenExpiresAt: string | null
  hasWebhookSecret: boolean
  updatedAt: string
  branch: { id: string; code: string; name: string } | null
}

export interface Notification {
  id: string
  title: string
  body: string | null
  level: string
  link: string | null
  readAt: string | null
  createdAt: string
}

export interface ShiftTemplate {
  id: string
  branchId: string
  code: string
  name: string
  kind: string
  startTime: string
  endTime: string
  color: string
}

export interface ShiftAssignment {
  id: string
  date: string
  status: string
  note: string | null
  user: UserRef & { department?: { name: string } | null }
  template: ShiftTemplate | null
}
