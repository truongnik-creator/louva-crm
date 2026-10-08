import { api } from './api'
import type { AftercareTask } from './api-lo4'

/* API của Lô 7 (CRM 360 Lô A): bảng bước khối, thanh 360, hành trình,
   báo giá 3 phương án, gợi ý bán kèm, màn chốt tại quầy. */

export type Heat = 'HOT' | 'WARM' | 'COLD'
export type AgeLevel = 'OK' | 'WARN' | 'OVERDUE' | 'NONE'

export interface PipelineCard {
  /** Id khách (mở hồ sơ). */
  id: string
  /** Lô 8 · P6: cơ hội của thẻ (null = khách chưa có cơ hội, dữ liệu cũ). */
  opportunityId: string | null
  opportunityTitle: string | null
  /** Dịch vụ của cơ hội (null: cơ hội cũ không có dịch vụ). */
  serviceName: string | null
  opportunityCount: number
  /** Lô 8 · P4: bước con (ví dụ HEN_CHUA_COC, DA_COC). */
  subStage: string | null
  code: string
  name: string
  phone: string | null
  stage: string
  lostReason: string | null
  interest: string[]
  assignedTo: { id: string; name: string } | null
  telesale: { id: string; name: string } | null
  channel: { id: string; name: string } | null
  campaign: { id: string; name: string } | null
  branches: Array<{ id: string; code: string; shortName: string | null }>
  lastContactAt: string | null
  daysInStage: number
  maxDays: number
  ageLevel: AgeLevel
  heat: Heat
  heatFactors: string[]
  /** null khi vai không được xem tiền (Quyết định 3). */
  expectedValue: number | null
  valueSource: 'MANUAL' | 'QUOTE' | 'PLAN' | 'INTEREST' | 'SERVICE' | null
  deposit: 'PAID' | 'UNPAID' | null
  nextAppointmentAt: string | null
  nextTask: { id: string; title: string; dueAt: string | null; overdue: boolean } | null
  openQuoteCount: number
  upsellHint: string[] | null
}

export interface PipelineColumn {
  key: string
  label: string
  bg: string
  fg: string
  lost: boolean
  inFunnel: boolean
  count: number
  totalValue: number | null
  overdueCount: number
  warnCount: number
  maxDays: number | null
  conversion: { entered: number; moved: number; rate: number | null } | null
  /** Lô 8 · P4: giới hạn số thẻ (cảnh báo) và bước con. */
  wipLimit: number | null
  overWip: boolean
  subStages: Array<{ key: string; label: string; auto: boolean; count: number }>
  items: PipelineCard[]
}

export interface Pipeline {
  mode: 'INJECTION' | 'SURGERY'
  moneyVisible: boolean
  periodDays: number
  total: number
  columns: PipelineColumn[]
}

export interface BoardFilters {
  mine?: boolean
  hot?: boolean
  overdue?: boolean
  branchId?: string
  serviceId?: string
  channelId?: string
  campaignId?: string
}

export type BoardView = 'kanban' | 'funnel' | 'table'

export async function fetchPipeline(params: BoardFilters & { q?: string; perStage?: number }): Promise<Pipeline> {
  const p: Record<string, string | number> = {}
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === '' || v === false) continue
    p[k] = v === true ? '1' : (v as string | number)
  }
  return (await api.get('/customers/pipeline', { params: p })).data
}

export async function fetchBoardPrefs(): Promise<{ view: BoardView; filters: BoardFilters }> {
  return (await api.get('/customers/pipeline/prefs')).data
}

export async function saveBoardPrefs(prefs: { view: BoardView; filters: BoardFilters }): Promise<void> {
  await api.put('/customers/pipeline/prefs', prefs)
}

/* ------------------------------------------------------------ THANH 360 */

export interface Milestone {
  kind: 'SOURCE' | 'FIRST_MESSAGE' | 'PHOTO' | 'DEPOSIT' | 'VISIT' | 'SERVICE' | 'AFTERCARE' | 'APPOINTMENT' | 'RETREAT'
  label: string
  detail: string | null
  at: string
  future: boolean
  gapDays: number | null
}

export interface Customer360 {
  customer: {
    id: string
    code: string
    name: string
    phone: string | null
    gender: string | null
    profileLabel: string
    branches: Array<{ id: string; code: string; shortName: string | null; isPrimary: boolean }>
  }
  stage: { key: string; label: string; lost: boolean; lostReason: string | null; since: string; days: number; maxDays: number; level: AgeLevel }
  heat: { heat: Heat; score: number; factors: string[] }
  source: { channel: string | null; firstAd: string | null; at: string }
  sale: { assignedTo: { id: string; name: string } | null; telesale: { id: string; name: string } | null }
  stats: {
    serviceCount: number
    lastServiceAt: string | null
    retreatDueAt: string | null
    retreatOverdue: boolean
    openQuoteCount: number
    voucherCount: number
    nearestVoucherExpiry: string | null
    hasDebt: boolean
  }
  moneyVisible: boolean
  money: null | {
    lifetimeSpend: number
    orderCount: number
    avgOrderValue: number | null
    openQuoteTotal: number
    debt: number
    voucherValue: number
    expectedValue: number | null
    valueSource: string | null
  }
  medicalVisible: boolean
  medical: null | { flags: Array<{ kind: string; text: string; blocking: boolean }> }
  conversationScore: { score: number | null; weekKey: string; summary: string | null } | null
  nextAppointment: { id: string; startAt: string; title: string; depositStatus: string | null; depositAmount: number | null; code: string | null } | null
  nextTask: { id: string; title: string; dueAt: string | null; overdue: boolean } | null
  /** Việc mở của khách (mọi người được giao), việc có hạn trước. */
  openTasks: Array<{
    id: string
    title: string
    dueAt: string | null
    overdue: boolean
    kind: string
    stageKey: string | null
    opportunityId: string | null
    assignee: { id: string; name: string } | null
  }>
  journey: Milestone[]
}

export async function fetchCustomer360(id: string): Promise<Customer360> {
  return (await api.get(`/customers/${id}/360`)).data
}

export async function fetchCustomerAftercare(customerId: string): Promise<{ items: AftercareTask[]; overdueDays: number }> {
  return (await api.get('/aftercare', { params: { view: 'all', customerId, limit: 100 } })).data
}

/* ------------------------------------------------------------ BÁN KÈM (V2) */

export interface UpsellSuggestion {
  ruleId: string
  triggerServiceId: string
  triggerServiceName: string
  suggestServiceId: string
  suggestServiceName: string
  pitch: string
  conditionNote: string | null
  isSample: boolean
  priority: number
  listPrice: number | null
  lastOffer: { id: string; status: 'SUGGESTED' | 'ACCEPTED' | 'DECLINED'; at: string; declineReason: string | null } | null
}

export type UpsellContext = 'CONSULT' | 'COUNTER' | 'INBOX' | 'QUOTE'

export async function fetchUpsell(customerId: string): Promise<{ items: UpsellSuggestion[] }> {
  return (await api.get(`/crm360/customers/${customerId}/upsell`)).data
}

export async function recordUpsellOffer(body: {
  customerId: string
  suggestServiceId: string
  ruleId?: string | null
  triggerServiceId?: string | null
  context: UpsellContext
  status?: 'SUGGESTED' | 'ACCEPTED' | 'DECLINED'
  declineReason?: string | null
}): Promise<void> {
  await api.post('/crm360/upsell-offers', body)
}

export interface UpsellRule {
  id: string
  branchId: string | null
  triggerServiceId: string
  suggestServiceId: string
  triggerService: { id: string; name: string }
  suggestService: { id: string; name: string }
  pitch: string
  conditionNote: string | null
  onlyIfNotDone: boolean
  priority: number
  active: boolean
  isSample: boolean
  reviewedAt: string | null
}

export async function fetchUpsellRules(): Promise<{ items: UpsellRule[]; canManage: boolean; canReview: boolean }> {
  return (await api.get('/crm360/upsell-rules')).data
}
export async function createUpsellRule(body: Partial<UpsellRule>): Promise<UpsellRule> {
  return (await api.post('/crm360/upsell-rules', body)).data
}
export async function updateUpsellRule(id: string, body: Partial<UpsellRule>): Promise<UpsellRule> {
  return (await api.patch(`/crm360/upsell-rules/${id}`, body)).data
}
export async function reviewUpsellRule(id: string): Promise<UpsellRule> {
  return (await api.post(`/crm360/upsell-rules/${id}/review`)).data
}
export interface UpsellStatRow {
  ruleId: string | null
  suggestServiceId: string
  suggestServiceName: string
  suggested: number
  accepted: number
  declined: number
  acceptRate: number | null
}
export async function fetchUpsellStats(days = 30): Promise<{ days: number; total: Omit<UpsellStatRow, 'ruleId' | 'suggestServiceId' | 'suggestServiceName'>; items: UpsellStatRow[] }> {
  return (await api.get('/crm360/upsell-offers/stats', { params: { days } })).data
}

/* ------------------------------------------------------------ BÁO GIÁ 3 PHƯƠNG ÁN (V1) */

export type QuoteTier = 'BASIC' | 'RECOMMENDED' | 'PACKAGE'

export interface QuoteOptionLine {
  serviceId: string
  name: string
  quantity: number
  unitPrice: number
  listPrice: number
  promotionId: string | null
  promotionName: string | null
  promotionDiscount: number
  extraDiscount: number
  discount: number
  amount: number
  upsellRuleId?: string | null
}

export interface QuoteOption {
  tier: QuoteTier
  label: string
  lines: QuoteOptionLine[]
  subtotal: number
  discount: number
  total: number
}

export interface QuoteOptions {
  source: { kind: 'PLAN' | 'SESSION'; id: string; title: string }
  branchId: string
  capPercent: number
  packageDiscountPercent: number
  appliedPackagePercent: number
  capLimited: boolean
  options: QuoteOption[]
  /** Dịch vụ bán kèm không tự cộng vào Trọn gói vì khách đã từ chối gần đây. */
  skippedDeclined?: Array<{ serviceId: string; name: string; declinedAt: string; declineReason: string | null }>
}

export async function previewQuoteOptions(body: { customerId: string; planId?: string | null; sessionId?: string | null }): Promise<QuoteOptions> {
  return (await api.post('/crm360/quote-options/preview', body)).data
}

export async function chooseQuoteOption(body: {
  customerId: string
  planId?: string | null
  sessionId?: string | null
  tier: QuoteTier
  accept?: boolean
  context?: UpsellContext
}): Promise<{ quotation: { id: string; code: string; total: number; status: string }; upsellAccepted: number }> {
  return (await api.post('/crm360/quote-options/choose', body)).data
}

/* ------------------------------------------------------------ QUẦY (V5) */

export interface CounterVisit {
  id: string
  queueNumber: number
  status: string
  checkedInAt: string
  purpose: string | null
  consultant: { id: string; name: string } | null
  customer: { id: string; code: string; name: string; phone: string | null; stage: string }
  mine: boolean
}

export async function fetchCounter(): Promise<{ items: CounterVisit[] }> {
  return (await api.get('/crm360/counter')).data
}
