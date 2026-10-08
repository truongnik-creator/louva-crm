import { api } from './api'

/* API của Lô 4 (Đợt 2 NOVA): tác vụ nền, chăm sóc sau điều trị, nhóm khách và
   gửi theo kịch bản, ưu đãi và duyệt giảm giá, việc của tôi, hộp thư theo ca,
   kịch bản bán hàng, AI gợi ý trả lời và tóm tắt. */

/* ------------------------------------------------------- TÁC VỤ NỀN (F8) */

export interface JobRunRow {
  id: string
  jobKey: string
  status: 'RUNNING' | 'SUCCESS' | 'FAILED'
  trigger: 'SCHEDULE' | 'MANUAL'
  startedAt: string
  finishedAt: string | null
  durationMs: number | null
  createdCount: number
  message: string | null
  error: string | null
}

export interface JobRow {
  key: string
  label: string
  intervalMinutes: number
  settingKey: string | null
  settingLabel: string | null
  switchOn: boolean
  enabled: boolean
  lastRun: JobRunRow | null
  lastSuccessAt: string | null
}

export async function fetchJobs(): Promise<{ globalEnabled: boolean; jobs: JobRow[] }> {
  const { data } = await api.get('/automation/jobs')
  return data
}

export async function fetchJobRuns(params: { jobKey?: string; status?: string; limit?: number; offset?: number } = {}): Promise<{
  total: number
  items: JobRunRow[]
}> {
  const { data } = await api.get('/automation/runs', { params })
  return data
}

export async function runJobNow(key: string): Promise<{ status: string; created?: number; message?: string; error?: string }> {
  const { data } = await api.post(`/automation/jobs/${encodeURIComponent(key)}/run`)
  return data
}

export async function saveSettings(values: Record<string, string>): Promise<void> {
  await api.put('/settings', { values })
}

/* ------------------------------------------- CHĂM SÓC SAU ĐIỀU TRỊ (F10) */

export type AftercareView = 'due' | 'overdue' | 'upcoming' | 'done' | 'all'
export type AftercareResult = 'REACHED_OK' | 'REACHED_ISSUE' | 'NO_ANSWER' | 'CALL_BACK_LATER'

export interface AftercareTask {
  id: string
  title: string
  description: string | null
  kind: 'AFTERCARE' | 'RETREAT'
  milestone: string | null
  status: string
  dueAt: string | null
  result: string | null
  resultNote: string | null
  contactedAt: string | null
  overdue: boolean
  dueToday: boolean
  customer: { id: string; code: string; name: string; phone: string | null; stage: string } | null
  assignee: { id: string; name: string } | null
  procedure: {
    id: string
    code: string
    title: string
    finishedAt: string | null
    retreatDays: number | null
    retreatDueAt: string | null
    injectionArea: string | null
    volumeTenthCc: number | null
    service: { name: string; retreatDays: number | null } | null
  } | null
}

export async function fetchAftercare(params: {
  view?: AftercareView
  kind?: string
  milestone?: string
  mine?: '1'
  limit?: number
  offset?: number
}): Promise<{ total: number; overdueDays: number; counts: { due: number; overdue: number; upcoming: number }; items: AftercareTask[] }> {
  const { data } = await api.get('/aftercare', { params })
  return data
}

export async function contactAftercare(
  taskId: string,
  payload: { result: AftercareResult; note?: string; nextDueAt?: string }
): Promise<void> {
  await api.post(`/aftercare/${taskId}/contact`, payload)
}

export async function setRetreatDays(procedureId: string, retreatDays: number | null): Promise<{ retreatDueAt: string | null }> {
  const { data } = await api.patch(`/aftercare/procedures/${procedureId}/retreat`, { retreatDays })
  return data
}

/* ------------------------------------------------- NHÓM KHÁCH, GỬI TIN (F11) */

export interface SegmentFilter {
  silentDays?: number
  serviceIds?: string[]
  servedAny?: boolean
  retreatWithinDays?: number
  birthdayMonth?: number
  stages?: string[]
  branchId?: string
}

export interface SegmentPreview {
  total: number
  optOut: number
  willSend: number
  capped: boolean
  sample: Array<{ id: string; code: string; name: string; phone: string | null; optOut: boolean; lastContactAt: string | null }>
}

export async function previewSegment(filter: SegmentFilter): Promise<SegmentPreview> {
  const { data } = await api.post('/outreach/segments/preview', { filter })
  return data
}

export interface SegmentRow {
  id: string
  name: string
  filter: SegmentFilter
  createdAt: string
}

export async function fetchSegments(): Promise<SegmentRow[]> {
  const { data } = await api.get('/outreach/segments')
  return data
}

export async function saveSegment(name: string, filter: SegmentFilter): Promise<SegmentRow> {
  const { data } = await api.post('/outreach/segments', { name, filter })
  return data
}

export interface BroadcastRow {
  id: string
  name: string
  template: string
  status: 'QUEUED' | 'RUNNING' | 'DONE' | 'CANCELLED'
  total: number
  createdByName: string | null
  createdAt: string
  finishedAt: string | null
  counts: Record<string, number>
}

export async function fetchBroadcasts(): Promise<BroadcastRow[]> {
  const { data } = await api.get('/outreach/broadcasts')
  return data
}

export async function createBroadcast(payload: {
  name: string
  template: string
  filter?: SegmentFilter
  segmentId?: string
}): Promise<{ id: string; queued: number; optOut: number }> {
  const { data } = await api.post('/outreach/broadcasts', payload)
  return data
}

export async function cancelBroadcast(id: string): Promise<void> {
  await api.post(`/outreach/broadcasts/${id}/cancel`)
}

export interface RecipientRow {
  id: string
  status: string
  content: string | null
  error: string | null
  sentAt: string | null
  customer: { id: string; code: string; name: string; phone: string | null } | null
}

export async function fetchRecipients(id: string, params: { status?: string } = {}): Promise<{ total: number; items: RecipientRow[] }> {
  const { data } = await api.get(`/outreach/broadcasts/${id}/recipients`, { params })
  return data
}

export async function setCustomerOptOut(id: string, optOut: boolean, reason?: string): Promise<void> {
  await api.post(`/outreach/customers/${id}/opt-out`, { optOut, reason })
}

/* ------------------------------------------ ƯU ĐÃI, DUYỆT GIẢM GIÁ (F13, F21) */

export interface PromotionRow {
  id: string
  code: string
  name: string
  kind: 'PERCENT' | 'AMOUNT'
  value: number
  maxSlots: number | null
  usedSlots: number
  slotsLeft: number | null
  startAt: string
  endAt: string
  branchId: string | null
  active: boolean
  state: 'ACTIVE' | 'UPCOMING' | 'ENDED' | 'FULL' | 'PAUSED'
  note: string | null
  services: Array<{ serviceId: string; service: { id: string; name: string; code: string } }>
}

export async function fetchPromotions(params: { active?: '1'; serviceId?: string } = {}): Promise<PromotionRow[]> {
  const { data } = await api.get('/promotions', { params })
  return data
}

export async function createPromotion(payload: {
  code: string
  name: string
  kind: 'PERCENT' | 'AMOUNT'
  value: number
  maxSlots?: number | null
  startAt: string
  endAt: string
  serviceIds: string[]
  note?: string
}): Promise<PromotionRow> {
  const { data } = await api.post('/promotions', payload)
  return data
}

export async function updatePromotion(id: string, payload: Partial<{ active: boolean; maxSlots: number | null; endAt: string; name: string }>): Promise<PromotionRow> {
  const { data } = await api.patch(`/promotions/${id}`, payload)
  return data
}

export interface ApprovalRow {
  id: string
  code: string
  total: number
  discount: number
  approvalStatus: string
  approvalNote: string | null
  createdAt: string
  maxExcessPercent: number
  customer: { id: string; name: string; code: string }
  createdBy: { id: string; name: string } | null
  items: Array<{
    id: string
    name: string
    quantity: number
    unitPrice: number
    amount: number
    listPrice: number | null
    discountAmount: number
    promotionDiscount: number
    discountReason: string | null
  }>
}

export async function fetchDiscountApprovals(status = 'PENDING'): Promise<ApprovalRow[]> {
  const { data } = await api.get('/sales/discount-approvals', { params: { status } })
  return data
}

export async function decideDiscount(id: string, decision: 'APPROVE' | 'REJECT', note?: string): Promise<void> {
  await api.post(`/sales/quotations/${id}/approval`, { decision, note })
}

export interface LeakageRow {
  key: string
  label: string
  lines: number
  listTotal: number
  netTotal: number
  discountTotal: number
  promotionDiscount: number
  leakage: number
  approvedLeakage: number
  leakagePercent: number
}

export async function fetchLeakage(params: { period?: string; groupBy: 'sales' | 'service' | 'month'; from?: string; to?: string }): Promise<{
  rows: LeakageRow[]
  total: LeakageRow
}> {
  const { data } = await api.get('/reports/discount-leakage', { params })
  return data
}

/* ----------------------------------------------- VIỆC CỦA TÔI HÔM NAY (F27) */

export interface MyTask {
  id: string
  title: string
  description: string | null
  kind: string
  priority: string
  status: string
  dueAt: string | null
  overdue: boolean
  milestone: string | null
  customer: { id: string; name: string; code: string; phone: string | null; stage: string } | null
}

export async function fetchMyTasksToday(): Promise<MyTask[]> {
  const { data } = await api.get('/customers/tasks/mine', { params: { today: '1' } })
  return data
}

export async function fetchMyTaskCount(): Promise<{ today: number; overdue: number }> {
  const { data } = await api.get('/customers/tasks/mine/count')
  return data
}

export async function completeTask(id: string): Promise<void> {
  await api.patch(`/customers/tasks/${id}`, { status: 'DONE' })
}

/* --------------------------------------------------- HỘP THƯ THEO CA (F26) */

export interface ConvTag {
  id: string
  name: string
  color: string
}

export interface ConvNote {
  id: string
  userName: string | null
  content: string
  createdAt: string
}

export async function fetchConversationNotes(id: string): Promise<{ notes: ConvNote[]; tags: ConvTag[]; medicalFlag: boolean }> {
  const { data } = await api.get(`/conversations/${id}/notes`)
  return data
}

export async function addConversationNote(id: string, content: string): Promise<void> {
  await api.post(`/conversations/${id}/notes`, { content })
}

export async function addConversationTag(id: string, name: string): Promise<ConvTag> {
  const { data } = await api.post(`/conversations/${id}/tags`, { name })
  return data
}

export async function removeConversationTag(id: string, tagId: string): Promise<void> {
  await api.delete(`/conversations/${id}/tags/${tagId}`)
}

export async function setMedicalFlag(id: string, flag: boolean): Promise<void> {
  await api.post(`/conversations/${id}/medical-flag`, { flag })
}

export async function autoAssignInbox(): Promise<{ assigned: number; total: number }> {
  const { data } = await api.post('/conversations/auto-assign', {})
  return data
}

export async function fetchOnDuty(): Promise<Array<{ id: string; name: string }>> {
  const { data } = await api.get('/conversations/shift/on-duty')
  return data
}

/* --------------------------------------------------------- AI2, AI3 */

export interface SuggestResult {
  id: string
  status: 'OK' | 'BLOCKED_MEDICAL' | 'REJECTED_CHECK' | 'NOT_CONFIGURED' | 'DISABLED' | 'NO_CONSENT' | 'ERROR'
  suggestion: string | null
  reason: string | null
  violations?: string[]
}

export async function suggestReply(conversationId: string): Promise<SuggestResult> {
  const { data } = await api.post(`/conversations/${conversationId}/suggest`, {}, { timeout: 90_000 })
  return data
}

export async function sendMessageWithSuggestion(conversationId: string, content: string, suggestionId?: string): Promise<void> {
  await api.post(`/conversations/${conversationId}/messages`, { content, ...(suggestionId ? { suggestionId } : {}) })
}

export interface SummaryResult {
  status: string
  summary?: string
  nextAction?: string
  message?: string
}

export async function summarizeConversation(conversationId: string): Promise<SummaryResult> {
  const { data } = await api.post(`/conversations/${conversationId}/summary`, {}, { timeout: 60_000 })
  return data
}

export async function fetchLatestSummary(conversationId: string): Promise<{ summary: string; nextAction: string; createdAt: string; by: string | null } | null> {
  const { data } = await api.get(`/conversations/${conversationId}/summary`)
  return data
}

/* ----------------------------------------------------- KỊCH BẢN BÁN HÀNG */

export interface SalesScriptRow {
  id: string
  key: string
  version: number
  title: string
  content: string
  isActive: boolean
  note: string | null
  createdByName: string | null
  createdAt: string
}

export async function fetchSalesScripts(): Promise<SalesScriptRow[]> {
  const { data } = await api.get('/sales-scripts')
  return data
}

export async function saveSalesScript(payload: { title: string; content: string; note?: string; activate?: boolean }): Promise<SalesScriptRow> {
  const { data } = await api.post('/sales-scripts', payload)
  return data
}

export async function activateSalesScript(id: string): Promise<void> {
  await api.post(`/sales-scripts/${id}/activate`)
}

/* ------------------------------------------------------------ NHÃN CHUNG */

export const TASK_KIND_LABEL: Record<string, string> = {
  CALLBACK: 'Gọi lại',
  DEPOSIT_REMINDER: 'Nhắc cọc',
  AFTERCARE: 'Chăm sóc',
  RETREAT: 'Tái tiêm',
  CARE_AGAIN: 'Chăm lại',
  MANUAL_MESSAGE: 'Nhắn tay',
  OTHER: 'Khác'
}

export const CHANNEL_BADGE: Record<string, { t: string; bg: string; fg: string }> = {
  FB: { t: 'FB', bg: '#DBEAFE', fg: '#1D4ED8' },
  ZALO: { t: 'Zalo', bg: '#E0F2FE', fg: '#0369A1' },
  TIKTOK: { t: 'TikTok', bg: '#F1F5F9', fg: '#0F172A' },
  OTHER: { t: 'Khác', bg: '#F1F5F9', fg: '#475569' }
}

export function vndText(n: number): string {
  return `${n.toLocaleString('vi-VN')}đ`
}
