import axios, { AxiosError, AxiosRequestConfig } from 'axios'
import type {
  Appointment,
  AuditLogEntry,
  Branch,
  Campaign,
  ChatMessage,
  ChecklistResult,
  ConsentForm,
  Contract,
  Conversation,
  ConversationDetail,
  CurrentUser,
  CustomerDetail,
  CustomerListItem,
  DashboardData,
  DataAccessLogEntry,
  DebtReport,
  Invoice,
  Lead,
  MarketingFunnelRow,
  MedicalRecord,
  Notification,
  Payment,
  PhotoSet,
  Procedure,
  QuickReply,
  TemplateVariable,
  Room,
  Service,
  ShiftAssignment,
  ShiftTemplate,
  StaffPerformanceRow,
  StaffUser,
  TimelineEntry,
  Visit,
  ZaloOAConfigView
} from './types'

export const API_BASE_URL: string = import.meta.env.VITE_API_URL || 'http://localhost:4000/api'

export const api = axios.create({ baseURL: API_BASE_URL, timeout: 20000 })

// Access token sống 15 phút nên phải giữ cả refresh token và tự đổi khi hết
// hạn — nếu không nhân viên sẽ bị đá ra mỗi 15 phút giữa ca làm việc.
let accessToken: string | null = null
let refreshToken: string | null = null
let activeBranchId: string | null = null
let onSessionLost: (() => void) | null = null

export function setTokens(access: string | null, refresh: string | null): void {
  accessToken = access
  refreshToken = refresh
}

export function getAccessToken(): string | null {
  return accessToken
}

export function setActiveBranch(branchId: string | null): void {
  activeBranchId = branchId
}

export function setSessionLostHandler(handler: (() => void) | null): void {
  onSessionLost = handler
}

api.interceptors.request.use((config) => {
  config.headers = config.headers ?? {}
  if (accessToken) config.headers.Authorization = `Bearer ${accessToken}`
  if (activeBranchId) config.headers['X-Branch-Id'] = activeBranchId
  return config
})

// Một lần refresh dùng chung cho mọi request đang chờ, tránh việc 5 request
// cùng hết hạn thì gọi 5 lần /auth/refresh và xoay vòng token loạn lên.
let refreshPromise: Promise<string | null> | null = null

async function doRefresh(): Promise<string | null> {
  if (!refreshToken) return null
  try {
    const { data } = await axios.post(`${API_BASE_URL}/auth/refresh`, { refreshToken })
    accessToken = data.accessToken
    refreshToken = data.refreshToken
    await window.crm.setTokens(data.accessToken, data.refreshToken)
    return data.accessToken as string
  } catch {
    accessToken = null
    refreshToken = null
    await window.crm.setTokens(null, null)
    onSessionLost?.()
    return null
  }
}

api.interceptors.response.use(
  (response) => response,
  async (error: AxiosError) => {
    const original = error.config as AxiosRequestConfig & { _retried?: boolean }
    const isAuthCall = original?.url?.includes('/auth/refresh') || original?.url?.includes('/auth/login')

    if (error.response?.status === 401 && original && !original._retried && !isAuthCall) {
      original._retried = true
      refreshPromise = refreshPromise ?? doRefresh()
      const fresh = await refreshPromise
      refreshPromise = null
      if (fresh) {
        original.headers = { ...original.headers, Authorization: `Bearer ${fresh}` }
        return api.request(original)
      }
    }
    return Promise.reject(error)
  }
)

export function getApiErrorMessage(error: unknown, fallback = 'Đã xảy ra lỗi, vui lòng thử lại.'): string {
  if (axios.isAxiosError(error)) {
    const data = (error as AxiosError<{ message?: string; error?: string }>).response?.data
    return data?.error || data?.message || error.message || fallback
  }
  if (error instanceof Error) return error.message
  return fallback
}

/** Lỗi 409 trùng SĐT khi tạo khách trả kèm hồ sơ đã có; lấy ra để gợi ý gắn vào hồ sơ đó. */
export function getDuplicateFromError(error: unknown): { id: string; code: string; name: string } | null {
  if (!axios.isAxiosError(error) || error.response?.status !== 409) return null
  const dup = (error.response.data as { duplicate?: { id: string; code: string; name: string } } | undefined)?.duplicate
  return dup?.id ? dup : null
}

/* ------------------------------------------------------------------- AUTH */

export async function login(
  email: string,
  password: string
): Promise<{ accessToken: string; refreshToken: string; user: CurrentUser }> {
  const { data } = await api.post('/auth/login', { email, password })
  return data
}

export async function fetchMe(): Promise<CurrentUser> {
  const { data } = await api.get('/auth/me')
  return data
}

export async function logoutRequest(): Promise<void> {
  await api.post('/auth/logout').catch(() => undefined)
}

export async function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  await api.post('/auth/change-password', { currentPassword, newPassword })
}

/* -------------------------------------------------------------------- ORG */

export async function fetchBranches(): Promise<Branch[]> {
  const { data } = await api.get('/org/branches')
  return data
}

export async function fetchRooms(params: { branchId?: string; type?: string } = {}): Promise<Room[]> {
  const { data } = await api.get('/org/rooms', { params })
  return data
}

export async function createRoom(payload: Partial<Room> & { branchId: string }): Promise<Room> {
  const { data } = await api.post('/org/rooms', payload)
  return data
}

export async function fetchDepartments(): Promise<Array<{ id: string; name: string; code: string }>> {
  const { data } = await api.get('/org/departments')
  return data
}

/* ------------------------------------------------------------------ USERS */

export async function fetchStaff(params: { q?: string; status?: string } = {}): Promise<StaffUser[]> {
  const { data } = await api.get('/users', { params })
  return data
}

export async function createStaff(payload: {
  email: string
  password: string
  name: string
  title?: string
  phone?: string
  roleIds: string[]
  branchIds: string[]
}): Promise<StaffUser> {
  const { data } = await api.post('/users', payload)
  return data
}

export async function updateStaff(
  id: string,
  payload: Record<string, unknown>
): Promise<StaffUser> {
  const { data } = await api.patch(`/users/${id}`, payload)
  return data
}

export async function deactivateStaff(
  id: string,
  payload: { reason: string; handoverToUserId?: string; status?: string }
): Promise<{ revokedSessions: number; handedOverCustomers: number }> {
  const { data } = await api.post(`/users/${id}/deactivate`, payload)
  return data
}

export interface RoleWithPermissions {
  id: string
  code: string
  name: string
  description: string | null
  isSystem: boolean
  userCount: number
  permissions: Array<{ code: string; name: string; scope: string }>
}

export async function fetchRoles(): Promise<RoleWithPermissions[]> {
  const { data } = await api.get('/users/roles/all')
  return data
}

export async function fetchPermissionCatalog(): Promise<{
  permissions: Array<{ id: string; code: string; module: string; action: string; name: string; isSpecial: boolean }>
}> {
  const { data } = await api.get('/users/permissions/all')
  return data
}

export async function saveRolePermissions(
  roleId: string,
  permissions: Array<{ code: string; scope: string }>
): Promise<{ affectedUsers: number }> {
  const { data } = await api.put(`/users/roles/${roleId}/permissions`, { permissions })
  return data
}

/* -------------------------------------------------------------- CUSTOMERS */

export async function fetchCustomers(
  params: {
    q?: string
    status?: string
    stage?: string
    assignedToId?: string
    limit?: number
    offset?: number
  } = {}
): Promise<{ total: number; items: CustomerListItem[]; nextOffset?: number | null }> {
  const { data } = await api.get('/customers', { params })
  return data
}

export interface DuplicateRef {
  id: string
  code: string
  name: string
  phone: string | null
}

/** B17: cảnh báo trùng SĐT (chuẩn hoá) và tên gần giống khi nhập khách. */
export async function checkCustomerDuplicates(params: {
  name?: string
  phone?: string
  excludeId?: string
}): Promise<{ phoneMatches: DuplicateRef[]; similarNames: DuplicateRef[] }> {
  const { data } = await api.get('/customers/duplicates/check', { params })
  return data
}

export interface DuplicateGroupCustomer extends DuplicateRef {
  stage: string
  status: string
  hidden: boolean
  createdAt: string
  assignedTo: { id: string; name: string } | null
  _count: { appointments: number; contracts: number; conversations: number; payments: number }
}

export async function fetchDuplicateGroups(
  params: { limit?: number; offset?: number } = {}
): Promise<{ groups: Array<{ key: string | null; customers: DuplicateGroupCustomer[] }>; nextOffset: number | null }> {
  const { data } = await api.get('/customers/duplicates', { params })
  return data
}

export async function mergeCustomers(body: {
  primaryId: string
  duplicateIds: string[]
  reason: string
}): Promise<{ ok: boolean; primaryId: string }> {
  const { data } = await api.post('/customers/merge', body)
  return data
}

export async function fetchCustomer(id: string): Promise<CustomerDetail> {
  const { data } = await api.get(`/customers/${id}`)
  return data
}

export async function createCustomer(payload: Record<string, unknown>): Promise<CustomerDetail> {
  const { data } = await api.post('/customers', payload)
  return data
}

export async function updateCustomer(id: string, payload: Record<string, unknown>): Promise<CustomerDetail> {
  const { data } = await api.patch(`/customers/${id}`, payload)
  return data
}

export async function changeCustomerStage(
  id: string,
  stage: string,
  reason?: string
): Promise<CustomerDetail> {
  const { data } = await api.post(`/customers/${id}/stage`, { stage, reason })
  return data
}

export async function assignCustomer(
  id: string,
  payload: { assignedToId?: string | null; telesaleId?: string | null; reason: string }
): Promise<CustomerDetail> {
  const { data } = await api.post(`/customers/${id}/assign`, payload)
  return data
}

export async function fetchCustomerTimeline(id: string): Promise<TimelineEntry[]> {
  const { data } = await api.get(`/customers/${id}/timeline`)
  return data
}

export async function addCustomerNote(id: string, content: string): Promise<void> {
  await api.post(`/customers/${id}/activities`, { content })
}

/* ------------------------------------------------------------------ INBOX */

export async function fetchConversations(
  params: {
    kind?: string
    q?: string
    unread?: string
    assignedToId?: string
    /** F26: của tôi, chưa phân công, theo nhóm kênh FB | ZALO | TIKTOK. */
    mine?: string
    unassigned?: string
    channel?: string
    limit?: number
    offset?: number
  } = {}
): Promise<Conversation[]> {
  const { data } = await api.get('/conversations', { params })
  return data
}

export async function fetchConversation(id: string): Promise<ConversationDetail> {
  const { data } = await api.get(`/conversations/${id}`)
  return data
}

export async function fetchMessages(
  conversationId: string,
  params: { cursor?: string; limit?: number } = {}
): Promise<{ items: ChatMessage[]; nextCursor: string | null }> {
  const { data } = await api.get(`/conversations/${conversationId}/messages`, { params })
  return data
}

export async function sendMessage(conversationId: string, content: string, suggestionId?: string): Promise<ChatMessage> {
  const { data } = await api.post(`/conversations/${conversationId}/messages`, {
    content,
    ...(suggestionId ? { suggestionId } : {})
  })
  return data
}

export async function markConversationRead(conversationId: string): Promise<void> {
  await api.post(`/conversations/${conversationId}/read`)
}

export async function assignConversation(
  conversationId: string,
  userId: string | null
): Promise<Conversation> {
  const { data } = await api.post(`/conversations/${conversationId}/assign`, { userId })
  return data
}

export async function linkConversationCustomer(
  conversationId: string,
  customerId: string
): Promise<Conversation> {
  const { data } = await api.post(`/conversations/${conversationId}/link-customer`, { customerId })
  return data
}

export async function fetchQuickReplies(params: { includeInactive?: boolean } = {}): Promise<QuickReply[]> {
  const { data } = await api.get('/conversations/quick-replies/all', {
    params: params.includeInactive ? { includeInactive: '1' } : {}
  })
  return data
}

export async function fetchTemplateVariables(): Promise<TemplateVariable[]> {
  const { data } = await api.get('/conversations/quick-replies/variables')
  return data
}

export async function createQuickReply(payload: {
  title: string
  content: string
  category?: string | null
}): Promise<QuickReply> {
  const { data } = await api.post('/conversations/quick-replies', payload)
  return data
}

export async function updateQuickReply(
  id: string,
  payload: { title?: string; content?: string; category?: string | null; active?: boolean }
): Promise<QuickReply> {
  const { data } = await api.patch(`/conversations/quick-replies/${id}`, payload)
  return data
}

export async function deleteQuickReply(id: string): Promise<void> {
  await api.delete(`/conversations/quick-replies/${id}`)
}

/** Điền biến {{...}} của mẫu theo hồ sơ khách của hội thoại (B12). Không gửi gì. */
export async function renderTemplate(
  conversationId: string,
  content: string
): Promise<{ content: string; unresolved: string[] }> {
  const { data } = await api.post(`/conversations/${conversationId}/render-template`, { content })
  return data
}

/** Ảnh, tệp đính kèm trong chat: tải qua API có kiểm quyền rồi tạo object URL (B13). */
export async function fetchAttachmentBlob(conversationId: string, attachmentId: string): Promise<string> {
  const { data } = await api.get(`/conversations/${conversationId}/attachments/${attachmentId}/content`, {
    responseType: 'blob'
  })
  return URL.createObjectURL(data as Blob)
}

export async function saveAttachmentToProfile(
  conversationId: string,
  attachmentId: string,
  payload: { stage?: string; note?: string } = {}
): Promise<{ photoSetId: string }> {
  const { data } = await api.post(
    `/conversations/${conversationId}/attachments/${attachmentId}/save-to-profile`,
    payload
  )
  return data
}

/* -------------------------------------------------------------- RECEPTION */

export async function fetchAppointments(
  params: { date?: string; from?: string; to?: string; doctorId?: string; status?: string; customerId?: string } = {}
): Promise<{ items: Appointment[]; counts: Record<string, number>; total: number }> {
  const { data } = await api.get('/reception/appointments', { params })
  return data
}

export async function createAppointment(payload: Record<string, unknown>): Promise<Appointment> {
  const { data } = await api.post('/reception/appointments', payload)
  return data
}

export async function setAppointmentStatus(
  id: string,
  status: string,
  reason?: string
): Promise<Appointment> {
  const { data } = await api.post(`/reception/appointments/${id}/status`, { status, reason })
  return data
}

export async function fetchQueue(params: { date?: string; includeFinished?: string } = {}): Promise<Visit[]> {
  const { data } = await api.get('/reception/visits/queue', { params })
  return data
}

export async function checkIn(payload: {
  customerId: string
  appointmentId?: string
  purpose?: string
}): Promise<Visit> {
  const { data } = await api.post('/reception/visits', payload)
  return data
}

export async function setVisitStatus(id: string, status: string): Promise<Visit> {
  const { data } = await api.patch(`/reception/visits/${id}/status`, { status })
  return data
}

/* ---------------------------------------------------------------- CATALOG */

export async function fetchServices(params: { q?: string; categoryId?: string } = {}): Promise<Service[]> {
  const { data } = await api.get('/catalog/services', { params })
  return data
}

export async function fetchServiceCategories(): Promise<
  Array<{ id: string; code: string; name: string; _count: { services: number } }>
> {
  const { data } = await api.get('/catalog/service-categories')
  return data
}

export async function createService(payload: Record<string, unknown>): Promise<Service> {
  const { data } = await api.post('/catalog/services', payload)
  return data
}

export async function updateService(id: string, payload: Record<string, unknown>): Promise<Service> {
  const { data } = await api.patch(`/catalog/services/${id}`, payload)
  return data
}

export async function setServicePrice(payload: {
  serviceId: string
  branchId: string
  price: number
  minPrice?: number
}): Promise<void> {
  await api.post('/catalog/service-prices', payload)
}

export async function fetchShiftTemplates(): Promise<ShiftTemplate[]> {
  const { data } = await api.get('/catalog/shift-templates')
  return data
}

export async function fetchShiftCalendar(params: {
  from: string
  to: string
  branchId?: string
}): Promise<ShiftAssignment[]> {
  const { data } = await api.get('/catalog/shifts/calendar', { params })
  return data
}

export async function bulkAssignShifts(payload: {
  branchId: string
  assignments: Array<{ userId: string; templateId: string; date: string }>
}): Promise<{ count: number }> {
  const { data } = await api.post('/catalog/shift-assignments/bulk', payload)
  return data
}

export async function deleteShiftAssignment(id: string): Promise<void> {
  await api.delete(`/catalog/shift-assignments/${id}`)
}

/* ------------------------------------------------------------------ SALES */

export async function fetchContracts(
  params: { customerId?: string; status?: string } = {}
): Promise<Contract[]> {
  const { data } = await api.get('/sales/contracts', { params })
  return data
}

export async function createContract(payload: Record<string, unknown>): Promise<Contract> {
  const { data } = await api.post('/sales/contracts', payload)
  return data
}

export async function signContract(id: string): Promise<Contract> {
  const { data } = await api.post(`/sales/contracts/${id}/sign`)
  return data
}

export async function fetchInvoices(params: { customerId?: string; status?: string } = {}): Promise<Invoice[]> {
  const { data } = await api.get('/sales/invoices', { params })
  return data
}

export async function fetchDebts(params: { overdueDays?: number } = {}): Promise<DebtReport> {
  const { data } = await api.get('/sales/debts', { params })
  return data
}

export async function fetchPayments(params: { customerId?: string } = {}): Promise<Payment[]> {
  const { data } = await api.get('/sales/payments', { params })
  return data
}

export async function createPayment(payload: {
  customerId: string
  invoiceId?: string
  contractId?: string
  amount: number
  method?: string
  reference?: string
  note?: string
  /** F25: tự trừ cọc đã nhận (mặc định bật ở máy chủ). */
  applyDeposit?: boolean
  appointmentId?: string
  misaInvoiceNo?: string
}): Promise<Payment & { depositApplied?: number }> {
  const { data } = await api.post('/sales/payments', payload)
  return data
}

export async function createQuotation(payload: Record<string, unknown>): Promise<{ id: string; code: string }> {
  const { data } = await api.post('/sales/quotations', payload)
  return data
}

/* ---------------------------------------------------------------- MEDICAL */

export async function fetchMedicalRecord(customerId: string): Promise<MedicalRecord> {
  const { data } = await api.get(`/medical/records/${customerId}`)
  return data
}

export async function createMedicalRecord(payload: Record<string, unknown>): Promise<MedicalRecord> {
  const { data } = await api.post('/medical/records', payload)
  return data
}

export async function addMedicalEntry(recordId: string, content: string, kind?: string): Promise<void> {
  await api.post(`/medical/records/${recordId}/entries`, { content, kind })
}

export async function fetchConsents(customerId: string): Promise<ConsentForm[]> {
  const { data } = await api.get('/medical/consents', { params: { customerId } })
  return data
}

export async function createConsent(payload: Record<string, unknown>): Promise<ConsentForm> {
  const { data } = await api.post('/medical/consents', payload)
  return data
}

/** Ký cam kết; `signature` là ảnh PNG chữ ký tay vẽ trên canvas (B16). */
export async function signConsent(id: string, signature?: Blob): Promise<ConsentForm> {
  if (!signature) {
    const { data } = await api.post(`/medical/consents/${id}/sign`)
    return data
  }
  const form = new FormData()
  form.append('signature', signature, 'chu-ky.png')
  const { data } = await api.post(`/medical/consents/${id}/sign`, form)
  return data
}

export async function fetchPhotoSets(customerId: string): Promise<PhotoSet[]> {
  const { data } = await api.get('/medical/photo-sets', { params: { customerId } })
  return data
}

export async function uploadPhotoSet(payload: {
  customerId: string
  stage: string
  note?: string
  files: File[]
}): Promise<{ id: string; photoCount: number }> {
  const form = new FormData()
  form.append('customerId', payload.customerId)
  form.append('stage', payload.stage)
  if (payload.note) form.append('note', payload.note)
  payload.files.forEach((f) => form.append('photos', f))
  const { data } = await api.post('/medical/photo-sets', form)
  return data
}

/** URL ảnh luôn đi qua API có kiểm quyền — không có đường dẫn tĩnh tới ảnh. */
export function photoUrl(photoId: string, download = false): string {
  const params = new URLSearchParams()
  if (download) params.set('download', '1')
  return `${API_BASE_URL}/medical/photos/${photoId}/content${params.toString() ? `?${params}` : ''}`
}

export async function fetchPhotoBlob(photoId: string): Promise<string> {
  const { data } = await api.get(`/medical/photos/${photoId}/content`, { responseType: 'blob' })
  return URL.createObjectURL(data as Blob)
}

export async function breakGlass(customerId: string, reason: string): Promise<{ expiresAt: string; minutes: number }> {
  const { data } = await api.post('/medical/break-glass', { customerId, reason })
  return data
}

/* -------------------------------------------------------------- PROCEDURES */

export async function fetchProcedures(
  params: { from?: string; to?: string; roomId?: string; customerId?: string } = {}
): Promise<{ items: Procedure[]; stats: { count: number; totalHours: number; notReady: number } }> {
  const { data } = await api.get('/procedures', { params })
  return data
}

export async function fetchChecklist(id: string): Promise<ChecklistResult> {
  const { data } = await api.get(`/procedures/${id}/checklist`)
  return data
}

export async function createProcedure(payload: Record<string, unknown>): Promise<Procedure> {
  const { data } = await api.post('/procedures', payload)
  return data
}

export async function setProcedureStatus(
  id: string,
  payload: { status: string; report?: string; reason?: string }
): Promise<Procedure> {
  const { data } = await api.post(`/procedures/${id}/status`, payload)
  return data
}

export async function updateProcedureChecklist(id: string, checklist: boolean[]): Promise<Procedure> {
  const { data } = await api.patch(`/procedures/${id}`, { checklist })
  return data
}

/* ------------------------------------------------------------------ LEADS */

export async function fetchLeads(params: { stage?: string; q?: string } = {}): Promise<Lead[]> {
  const { data } = await api.get('/leads', { params })
  return data
}

export async function createLead(payload: Record<string, unknown>): Promise<Lead> {
  const { data } = await api.post('/leads', payload)
  return data
}

export async function convertLead(id: string): Promise<{ customer: CustomerDetail; merged: boolean }> {
  const { data } = await api.post(`/leads/${id}/convert`)
  return data
}

export async function assignLead(id: string, userId: string): Promise<Lead> {
  const { data } = await api.post(`/leads/${id}/assign`, { userId })
  return data
}

export async function fetchCampaigns(): Promise<Campaign[]> {
  const { data } = await api.get('/leads/campaigns')
  return data
}

export async function fetchChannels(): Promise<Array<{ id: string; key: string; name: string; kind: string }>> {
  const { data } = await api.get('/leads/channels')
  return data
}

/* ---------------------------------------------------------------- REPORTS */

/* ---- TRANG CHỦ THEO VAI (B15) ---- */

export interface HomeCustomerRef {
  id: string
  name: string
  code: string
  phone: string | null
}

export interface HomeData {
  date: string
  sections: {
    appointments?: {
      total: number
      arrived: number
      pending: number
      items: Array<{
        id: string
        startAt: string
        title: string
        status: string
        customer: HomeCustomerRef
        doctor: { id: string; name: string } | null
      }>
    }
    queue?: {
      waiting: number
      inProgress: number
      items: Array<{ id: string; queueNumber: number; status: string; checkedInAt: string; customer: HomeCustomerRef }>
    }
    procedures?: {
      total: number
      mine: number
      items: Array<{
        id: string
        code: string
        title: string
        status: string
        scheduledAt: string
        surgeon: { id: string; name: string } | null
        customer: HomeCustomerRef
      }>
    }
    leads?: { total: number; unassigned: number; byChannel: Array<{ channel: string; count: number }> }
    conversations?: {
      unread: number
      items: Array<{
        id: string
        title: string
        channel: string
        unreadCount: number
        lastMessageAt: string | null
        lastMessagePreview: string | null
      }>
    }
  } & import('./api-lo5-home').HomeLo5Sections
  roles?: string[]
  financeView?: boolean
}

export async function fetchHome(): Promise<HomeData> {
  const { data } = await api.get('/home')
  return data
}

export async function fetchDashboard(params: { period?: string; branchId?: string } = {}): Promise<DashboardData> {
  const { data } = await api.get('/reports/dashboard', { params })
  return data
}

export async function fetchRevenueReport(
  params: { period?: string; groupBy?: string } = {}
): Promise<Array<{ key: string; revenue: number; collected?: number; count: number }>> {
  const { data } = await api.get('/reports/revenue', { params })
  return data
}

export async function fetchStaffPerformance(params: { period?: string } = {}): Promise<StaffPerformanceRow[]> {
  const { data } = await api.get('/reports/staff-performance', { params })
  return data
}

export async function fetchMarketingFunnel(params: { period?: string } = {}): Promise<MarketingFunnelRow[]> {
  const { data } = await api.get('/reports/marketing/funnel', { params })
  return data
}

/* ---- BẢNG ĐIỂM HIỆU SUẤT THEO BỘ PHẬN ---- */

export type MetricUnit = 'đ' | '%' | 'phút' | 'giờ' | 'số'

export interface ScoreColumn {
  key: string
  label: string
  unit?: MetricUnit
  goodHigh: boolean
  weight?: number
  zeroMeansNoData?: boolean
  hint?: string
}

export interface ScoreRow {
  key: string
  name: string
  sub?: string
  metrics: Record<string, number>
  /** 0–100 so với người dẫn đầu bộ phận. null = chưa phát sinh việc nào. */
  score?: number | null
}

export interface HeadlineStat {
  label: string
  value: number
  unit?: MetricUnit
  tone?: 'good' | 'bad' | 'neutral'
  hint?: string
}

export interface DepartmentScore {
  key: string
  name: string
  icon: string
  subtitle: string
  entityLabel: string
  headline: HeadlineStat[]
  columns: ScoreColumn[]
  rows: ScoreRow[]
  alerts: Array<{ level: 'ok' | 'wr' | 'dg'; text: string }>
  note?: string
}

export async function fetchDepartmentScores(
  params: { period?: string } = {}
): Promise<{ period: { from: string; to: string }; departments: DepartmentScore[] }> {
  const { data } = await api.get('/reports/departments', { params })
  return data
}

export async function fetchClinicOperations(params: { period?: string } = {}): Promise<{
  appointments: { total: number; noShow: number; noShowBase: number; noShowRate: number }
  queue: { visits: number; avgWaitMinutes: number; stillWaiting: number }
  capacityHoursPerDay: number
  surgeryCapacity: Array<{ date: string; minutes: number; utilization: number }>
  capacityByDoctor: Array<{
    doctorId: string | null
    name: string
    cases: number
    minutes: number
    workDays: number
    utilization: number
  }>
  capacityByBranch: Array<{ branchId: string; name: string; rooms: number; minutes: number; utilization: number }>
}> {
  const { data } = await api.get('/reports/clinic-operations', { params })
  return data
}

export async function exportDataset(payload: {
  dataset: string
  from?: string
  to?: string
}): Promise<{ dataset: string; rowCount: number; rows: Record<string, unknown>[] }> {
  const { data } = await api.post('/reports/export', payload)
  return data
}

/* ------------------------------------------------------------------ AUDIT */

export async function fetchAuditLogs(
  params: { entity?: string; actorId?: string; action?: string; limit?: number } = {}
): Promise<{ total: number; items: AuditLogEntry[] }> {
  const { data } = await api.get('/audit/logs', { params })
  return data
}

export async function fetchDataAccessLogs(
  params: { customerId?: string; severity?: string; limit?: number } = {}
): Promise<{ total: number; items: DataAccessLogEntry[] }> {
  const { data } = await api.get('/audit/data-access', { params })
  return data
}

export async function fetchNotifications(): Promise<{ items: Notification[]; unread: number }> {
  const { data } = await api.get('/audit/notifications')
  return data
}

export async function markNotificationsRead(): Promise<void> {
  await api.post('/audit/notifications/read')
}

/* ------------------------------------------------------------------- ZALO */

export async function fetchZaloConfigs(): Promise<ZaloOAConfigView[]> {
  const { data } = await api.get('/zalo/oa-configs')
  return data
}

export async function saveZaloConfig(payload: {
  id?: string
  label: string
  oaId: string
  appId: string
  appSecret?: string
  webhookSecret?: string
  branchId?: string | null
}): Promise<{ id: string }> {
  const { data } = await api.put('/zalo/oa-configs', payload)
  return data
}

export async function fetchZaloAuthorizeUrl(configId: string): Promise<string> {
  const { data } = await api.get('/zalo/oauth/authorize-url', { params: { configId } })
  return data.url
}

/* -------------------------------------------------------------- KHO VẬT TƯ */

export interface ProductRow {
  id: string
  code: string
  name: string
  kind: string
  unit: string
  isImplant: boolean
  requiresLot: boolean
  minStock: number
  maxStock: number
  note: string | null
  active: boolean
  onHand: number
  lotCount: number
  belowMin: boolean
  aboveMax: boolean
  expiringSoon: number
  expiredLots: number
}

export interface StockLotRow {
  id: string
  lotNumber: string
  serialNumber: string | null
  expiryDate: string | null
  quantity: number
  unitCost: number
  receivedAt: string
  daysToExpiry: number | null
  expired: boolean
  expiringSoon: boolean
  product: { id: string; code: string; name: string; unit: string; isImplant: boolean; minStock: number }
  warehouse: { id: string; name: string }
  supplier: { id: string; name: string } | null
}

export interface SupplierRow {
  id: string
  code: string
  name: string
  phone: string | null
  email: string | null
  address: string | null
  contactName: string | null
  taxCode: string | null
  active: boolean
  _count: { lots: number; purchaseOrders: number }
}

export interface StockMovementRow {
  id: string
  type: string
  quantity: number
  reason: string | null
  createdAt: string
  product: { id: string; name: string; unit: string }
  lot: { id: string; lotNumber: string; expiryDate: string | null } | null
  actor: { id: string; name: string } | null
  warehouse: { id: string; name: string }
}

export async function fetchProducts(params: { q?: string; kind?: string } = {}): Promise<ProductRow[]> {
  const { data } = await api.get('/inventory/products', { params })
  return data
}

export async function createProduct(payload: Record<string, unknown>): Promise<ProductRow> {
  const { data } = await api.post('/inventory/products', payload)
  return data
}

export async function fetchSuppliers(): Promise<SupplierRow[]> {
  const { data } = await api.get('/inventory/suppliers')
  return data
}

export async function createSupplier(payload: Record<string, unknown>): Promise<SupplierRow> {
  const { data } = await api.post('/inventory/suppliers', payload)
  return data
}

export async function fetchOnHand(
  params: { productId?: string; all?: string } = {}
): Promise<{
  items: StockLotRow[]
  stats: { lotCount: number; expired: number; expiringSoon: number; totalValue: number }
}> {
  const { data } = await api.get('/inventory/on-hand', { params })
  return data
}

export async function receiveStock(payload: {
  productId: string
  lotNumber: string
  serialNumber?: string
  expiryDate?: string
  quantity: number
  unitCost?: number
  supplierId?: string
  note?: string
}): Promise<StockLotRow> {
  const { data } = await api.post('/inventory/receive', payload)
  return data
}

export async function useStock(payload: {
  lotId: string
  customerId: string
  procedureId?: string
  quantity?: number
  note?: string
}): Promise<{ id: string }> {
  const { data } = await api.post('/inventory/use', payload)
  return data
}

export async function adjustStock(payload: {
  lotId: string
  quantity: number
  type?: string
  reason: string
}): Promise<void> {
  await api.post('/inventory/adjust', payload)
}

export async function fetchMovements(
  params: { productId?: string; type?: string; limit?: number } = {}
): Promise<StockMovementRow[]> {
  const { data } = await api.get('/inventory/movements', { params })
  return data
}

export interface TraceabilityResult {
  lot: StockLotRow
  usedQuantity: number
  customerCount: number
  usages: Array<{
    id: string
    quantity: number
    usedAt: string
    note: string | null
    customer: { id: string; code: string; name: string; phone: string | null } | null
    procedure: { id: string; code: string; title: string; scheduledAt: string } | null
    recordedBy: { id: string; name: string } | null
  }>
}

export async function fetchTraceability(lotId: string): Promise<TraceabilityResult> {
  const { data } = await api.get(`/inventory/traceability/${lotId}`)
  return data
}

export async function fetchCustomerMaterials(customerId: string): Promise<
  Array<{
    id: string
    quantity: number
    usedAt: string
    product: { id: string; name: string; isImplant: boolean }
    lot: { id: string; lotNumber: string; serialNumber: string | null; expiryDate: string | null } | null
    procedure: { id: string; code: string; title: string } | null
  }>
> {
  const { data } = await api.get(`/inventory/traceability/customer/${customerId}`)
  return data
}

/* --------------------------------------------------- NHÂN SỰ · HOA HỒNG · KPI */

export interface AttendanceRow {
  id: string
  date: string
  checkInAt: string | null
  checkOutAt: string | null
  status: string
  lateMinutes: number
  earlyMinutes: number
  workedMinutes: number
  note: string | null
  user: { id: string; name: string; title: string | null }
}

export interface LeaveRow {
  id: string
  type: string
  fromDate: string
  toDate: string
  days: number
  reason: string
  status: string
  decisionNote: string | null
  createdAt: string
  user: { id: string; name: string }
  approver: { id: string; name: string } | null
}

export interface CommissionRuleRow {
  id: string
  name: string
  roleCode: string
  basis: string
  percent: number
  minAmount: number
  active: boolean
  service: { id: string; name: string } | null
}

export interface CommissionData {
  period: string
  total: number
  summary: Array<{ userId: string; name: string; count: number; total: number }>
  entries: Array<{
    id: string
    periodKey: string
    baseAmount: number
    percent: number
    amount: number
    status: string
    user: { id: string; name: string }
    rule: { id: string; name: string; basis: string } | null
    payment: { id: string; code: string; paidAt: string } | null
  }>
}

export interface KpiRow {
  definitionId: string
  code: string
  name: string
  group: string
  unit: string
  higherIsBetter: boolean
  userId: string | null
  userName: string | null
  target: number
  actual: number
  percent: number
  achieved: boolean
}

export async function fetchAttendances(
  params: { period?: string; userId?: string } = {}
): Promise<{
  period: string
  items: AttendanceRow[]
  stats: { present: number; late: number; absent: number; onLeave: number }
}> {
  const { data } = await api.get('/hr/attendances', { params })
  return data
}

export async function checkInAttendance(payload: { userId?: string; note?: string } = {}): Promise<AttendanceRow & { hadShift: boolean }> {
  const { data } = await api.post('/hr/attendances/check-in', payload)
  return data
}

export async function checkOutAttendance(payload: { userId?: string } = {}): Promise<AttendanceRow> {
  const { data } = await api.post('/hr/attendances/check-out', payload)
  return data
}

export async function fetchLeaves(params: { status?: string } = {}): Promise<LeaveRow[]> {
  const { data } = await api.get('/hr/leaves', { params })
  return data
}

export async function createLeave(payload: {
  type?: string
  fromDate: string
  toDate: string
  reason: string
  userId?: string
}): Promise<LeaveRow> {
  const { data } = await api.post('/hr/leaves', payload)
  return data
}

export async function decideLeave(id: string, status: string, note?: string): Promise<LeaveRow> {
  const { data } = await api.post(`/hr/leaves/${id}/decide`, { status, note })
  return data
}

export async function fetchCommissionRules(): Promise<CommissionRuleRow[]> {
  const { data } = await api.get('/hr/commission-rules')
  return data
}

export async function createCommissionRule(payload: Record<string, unknown>): Promise<CommissionRuleRow> {
  const { data } = await api.post('/hr/commission-rules', payload)
  return data
}

export async function calculateCommissions(period?: string): Promise<{ period: string; created: number; total: number }> {
  const { data } = await api.post('/hr/commissions/calculate', { period })
  return data
}

export async function fetchCommissions(params: { period?: string } = {}): Promise<CommissionData> {
  const { data } = await api.get('/hr/commissions', { params })
  return data
}

export async function closeCommissions(period: string): Promise<{ approved: number }> {
  const { data } = await api.post('/hr/commissions/close', { period })
  return data
}

export async function fetchKpi(
  params: { period?: string; group?: string } = {}
): Promise<{
  period: string
  definitions: Array<{ id: string; code: string; name: string; group: string; unit: string }>
  rows: KpiRow[]
}> {
  const { data } = await api.get('/hr/kpi', { params })
  return data
}

export async function createKpiDefinition(payload: Record<string, unknown>): Promise<{ id: string }> {
  const { data } = await api.post('/hr/kpi/definitions', payload)
  return data
}

export async function saveKpiValue(payload: {
  definitionId: string
  userId: string
  periodKey: string
  target?: number
  actual?: number
}): Promise<void> {
  await api.put('/hr/kpi/values', payload)
}

/* ------------------------------------------------- PANCAKE (đa kênh) + ADS */

export interface PancakePageRow {
  id: string
  pageId: string
  name: string
  platform: string
  active: boolean
  lastSyncAt: string | null
  channel: { id: string; name: string } | null
}

export interface PancakeConfigRow {
  id: string
  label: string
  active: boolean
  connected: boolean
  lastSyncAt: string | null
  lastSyncNote: string | null
  branch: { id: string; name: string } | null
  pages: PancakePageRow[]
}

export async function fetchPancakeConfigs(): Promise<PancakeConfigRow[]> {
  const { data } = await api.get('/pancake/configs')
  return data
}

export async function savePancakeConfig(payload: {
  id?: string
  label: string
  accessToken?: string
  webhookSecret?: string
  branchId?: string | null
}): Promise<{ id: string }> {
  const { data } = await api.put('/pancake/configs', payload)
  return data
}

export async function discoverPancakePages(configId: string): Promise<{ found: number; created: number }> {
  const { data } = await api.post(`/pancake/${configId}/discover-pages`)
  return data
}

/** F5: đồng bộ tay chạy nền, máy chủ trả 202 ngay; kết quả ghi ở lastSyncNote của kết nối. */
export async function syncPancake(configId: string): Promise<{
  started?: boolean
  running?: boolean
  conversations?: number
  messages?: number
  errors?: string[]
}> {
  const { data } = await api.post(`/pancake/${configId}/sync`)
  return data
}

export async function updatePancakePage(
  id: string,
  payload: { channelId?: string | null; branchId?: string | null; active?: boolean }
): Promise<PancakePageRow> {
  const { data } = await api.patch(`/pancake/pages/${id}`, payload)
  return data
}

export async function saveCampaignCost(
  campaignId: string,
  payload: { date: string; amount: number; note?: string }
): Promise<void> {
  await api.post(`/leads/campaigns/${campaignId}/costs`, payload)
}

export interface ResponseTimeRow {
  key: string
  label: string
  replies: number
  avgMinutes: number
  slowReplies: number
  unanswered: number
}

export async function fetchResponseTime(
  params: { period?: string } = {}
): Promise<{ slowThresholdMinutes: number; byUser: ResponseTimeRow[]; byChannel: ResponseTimeRow[] }> {
  const { data } = await api.get('/reports/response-time', { params })
  return data
}

export interface ChannelRoasRow {
  channelId: string
  name: string
  kind: string
  leads: number
  spent: number
  revenue: number
  collected: number
  cpl: number
  roas: number | null
}

export async function fetchChannelRoas(params: { period?: string } = {}): Promise<ChannelRoasRow[]> {
  const { data } = await api.get('/reports/channel-roas', { params })
  return data
}

/* ------------------------------------------------------- CÀI ĐẶT HỆ THỐNG */

export interface SettingRow {
  key: string
  group: string
  label: string
  type: 'number' | 'percent' | 'text' | 'boolean' | 'select'
  options?: Array<{ value: string; label: string }>
  defaultValue: string
  description: string
  usedIn: string
  min?: number
  max?: number
  value: string
  isDefault: boolean
}

export interface AdminTable {
  key: string
  label: string
  group: string
  deletable: boolean
  reason?: string
  count: number
}

export async function fetchSettings(): Promise<SettingRow[]> {
  const { data } = await api.get('/settings')
  return data
}

export async function saveSettings(values: Record<string, string>): Promise<{ changed: number }> {
  const { data } = await api.put('/settings', { values })
  return data
}

export async function fetchAdminTables(): Promise<AdminTable[]> {
  const { data } = await api.get('/settings/data/tables')
  return data
}

export async function fetchAdminRows(
  table: string,
  params: { q?: string; limit?: number } = {}
): Promise<{ table: AdminTable; total: number; items: Record<string, unknown>[] }> {
  const { data } = await api.get(`/settings/data/${table}`, { params })
  return data
}

export async function fetchDeleteImpact(
  table: string,
  id: string
): Promise<{
  deletable: boolean
  reason?: string
  dependents: Array<{ label: string; count: number }>
  totalAffected: number
}> {
  const { data } = await api.get(`/settings/data/${table}/${id}/impact`)
  return data
}

export async function deleteAdminRow(
  table: string,
  id: string,
  reason: string,
  force = false
): Promise<void> {
  await api.delete(`/settings/data/${table}/${id}`, {
    params: { reason, ...(force ? { force: '1' } : {}) }
  })
}

export async function fetchDataStats(): Promise<{
  customers: number
  messages: number
  audits: number
  accessLogs: number
  photos: number
}> {
  const { data } = await api.get('/settings/data/stats/overview')
  return data
}

/* ------------------------------------------------------- KHO NÂNG CẤP */

export interface WarehouseRow {
  id: string
  code: string
  name: string
  kind: string
  parentId: string | null
  parent: { id: string; name: string } | null
  onHand: number
  lotCount: number
  childCount: number
  active: boolean
}

export interface TransferRow {
  id: string
  code: string
  status: string
  reason: string | null
  createdAt: string
  approvedAt: string | null
  completedAt: string | null
  rejectNote: string | null
  fromWarehouse: { id: string; name: string }
  toWarehouse: { id: string; name: string }
  requestedBy: { id: string; name: string } | null
  approvedBy: { id: string; name: string } | null
  items: Array<{
    id: string
    quantity: number
    product: { id: string; name: string; unit: string }
    lot: { id: string; lotNumber: string; expiryDate: string | null; quantity: number } | null
  }>
}

export interface ServiceMaterialRow {
  id: string
  quantity: number
  required: boolean
  note: string | null
  service: { id: string; name: string; code: string }
  product: { id: string; name: string; unit: string; isImplant: boolean }
}

export interface StockCardData {
  product: { id: string; name: string; unit: string } | null
  openingBalance: number
  closingBalance: number
  totalIn: number
  totalOut: number
  rows: Array<{
    id: string
    at: string
    type: string
    lotNumber: string | null
    expiryDate: string | null
    warehouse: string
    inQty: number
    outQty: number
    balance: number
    reason: string | null
    actor: string | null
  }>
}

export interface ValuationData {
  totalValue: number
  expiringValue: number
  expiredValue: number
  expiringCount: number
  expiredCount: number
  lotCount: number
  byWarehouse: Array<{ warehouseId: string; name: string; kind: string; qty: number; value: number }>
  byKind: Array<{ kind: string; qty: number; value: number }>
  belowMin: Array<{ productId: string; name: string; unit: string; qty: number; min: number; shortage: number }>
  aboveMax: Array<{ productId: string; name: string; unit: string; qty: number; max: number; excess: number }>
}

export async function fetchWarehouses(): Promise<WarehouseRow[]> {
  const { data } = await api.get('/inventory/warehouses')
  return data
}

export async function createWarehouse(payload: {
  code: string
  name: string
  kind?: string
  parentId?: string | null
}): Promise<WarehouseRow> {
  const { data } = await api.post('/inventory/warehouses', payload)
  return data
}

export async function fetchTransfers(params: { status?: string } = {}): Promise<TransferRow[]> {
  const { data } = await api.get('/inventory/transfers', { params })
  return data
}

export async function createTransfer(payload: {
  fromWarehouseId: string
  toWarehouseId: string
  reason?: string
  items: Array<{ productId: string; lotId?: string; quantity: number }>
}): Promise<TransferRow> {
  const { data } = await api.post('/inventory/transfers', payload)
  return data
}

export async function decideTransfer(id: string, status: string, note?: string): Promise<TransferRow> {
  const { data } = await api.post(`/inventory/transfers/${id}/decide`, { status, note })
  return data
}

export async function executeTransfer(id: string): Promise<void> {
  await api.post(`/inventory/transfers/${id}/execute`)
}

export async function fetchServiceMaterials(serviceId?: string): Promise<ServiceMaterialRow[]> {
  const { data } = await api.get('/inventory/service-materials', {
    params: serviceId ? { serviceId } : {}
  })
  return data
}

export async function saveServiceMaterials(
  serviceId: string,
  materials: Array<{ productId: string; quantity: number; required?: boolean; note?: string }>
): Promise<{ count: number }> {
  const { data } = await api.put('/inventory/service-materials', { serviceId, materials })
  return data
}

export async function fetchStockCard(params: {
  productId: string
  warehouseId?: string
  from?: string
  to?: string
}): Promise<StockCardData> {
  const { data } = await api.get('/inventory/stock-card', { params })
  return data
}

export async function fetchValuation(): Promise<ValuationData> {
  const { data } = await api.get('/inventory/reports/valuation')
  return data
}

/* -------------------------------------------- THAO TÁC NHANH CHO NHÂN VIÊN KHO */

export async function updateProduct(id: string, payload: Record<string, unknown>): Promise<ProductRow> {
  const { data } = await api.patch(`/inventory/products/${id}`, payload)
  return data
}

export async function deleteProduct(id: string): Promise<void> {
  await api.delete(`/inventory/products/${id}`)
}

export async function updateSupplier(id: string, payload: Record<string, unknown>): Promise<SupplierRow> {
  const { data } = await api.patch(`/inventory/suppliers/${id}`, payload)
  return data
}

export async function deleteSupplier(id: string): Promise<void> {
  await api.delete(`/inventory/suppliers/${id}`)
}

export async function updateLot(id: string, payload: Record<string, unknown>): Promise<StockLotRow> {
  const { data } = await api.patch(`/inventory/lots/${id}`, payload)
  return data
}

export async function deleteLot(id: string): Promise<void> {
  await api.delete(`/inventory/lots/${id}`)
}

/** Xuất nội bộ — hỏng vỡ, dùng thử, cấp cho phòng khác. Không gắn khách. */
export async function issueStock(payload: {
  lotId: string
  quantity: number
  reason: string
}): Promise<void> {
  await api.post('/inventory/issue', payload)
}

/** Cộng/trừ nhanh ngay trên dòng tồn khi kiểm đếm thấy lệch. */
export async function quickAdjust(payload: {
  lotId: string
  delta: number
  reason?: string
}): Promise<{ quantity: number }> {
  const { data } = await api.post('/inventory/quick-adjust', payload)
  return data
}
