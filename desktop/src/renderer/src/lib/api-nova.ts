import { api } from './api'
import type { Appointment, ChatMessage, CustomerListItem, Payment } from './types'

/* API của Lô 3 (Đợt 1 NOVA): chế độ phòng khám, bước bán hàng, nhập khách,
   cọc lịch hẹn, tin vị trí và bảng giá, AI1 tách thông tin từ chat. */

export interface StageDef {
  key: string
  label: string
  bg: string
  fg: string
  lost?: boolean
}

export interface ClinicConfig {
  mode: 'INJECTION' | 'SURGERY'
  name: string
  stages: StageDef[]
  allStages: StageDef[]
  lostReasons: Array<{ key: string; label: string }>
  terms: Record<string, string>
  photoStages: string[]
  ai: { configured: boolean; extractEnabled: boolean; suggestEnabled?: boolean; summaryEnabled?: boolean }
  deposit: { defaultAmount: number }
  inbox?: { waitingAlertMinutes: number }
  pricing?: { singlePriceList: boolean }
}

export async function fetchClinicConfig(): Promise<ClinicConfig> {
  const { data } = await api.get('/clinic/config')
  return data
}

export interface ConsentTemplateRow {
  id: string
  code: string
  type: string
  title: string
  bodyText: string
}

export async function fetchConsentTemplates(): Promise<ConsentTemplateRow[]> {
  const { data } = await api.get('/clinic/consent-templates')
  return data
}

/* ------------------------------------------------------------ BƯỚC KHÁCH */

export async function changeStage(
  id: string,
  payload: { stage: string; lostReason?: string; reason?: string }
): Promise<CustomerListItem> {
  const { data } = await api.post(`/customers/${id}/stage`, payload)
  return data
}

export interface StageHistoryRow {
  id: string
  fromStage: string | null
  toStage: string
  source: 'MANUAL' | 'AUTO' | 'IMPORT' | 'MIGRATION'
  event: string | null
  lostReason: string | null
  note: string | null
  userName: string | null
  createdAt: string
}

export async function fetchStageHistory(id: string): Promise<StageHistoryRow[]> {
  const { data } = await api.get(`/customers/${id}/stage-history`)
  return data
}

export interface BoardColumn extends StageDef {
  count: number
  items: CustomerListItem[]
}

export async function fetchCustomerBoard(params: { perStage?: number; assignedToId?: string } = {}): Promise<{
  mode: string
  columns: BoardColumn[]
}> {
  const { data } = await api.get('/customers/board', { params })
  return data
}

export async function setAiConsent(
  id: string,
  consent: boolean,
  note?: string
): Promise<{ aiDataConsent: boolean; aiDataConsentAt: string }> {
  const { data } = await api.post(`/customers/${id}/ai-consent`, { consent, note })
  return data
}

/* ------------------------------------------------------------ NHẬP KHÁCH */

export type ImportField = 'name' | 'phone' | 'branch' | 'service' | 'serviceDate' | 'source' | 'note'

export interface ImportParseResult {
  token: string
  fileName: string
  headers: string[]
  totalRows: number
  preview: string[][]
  suggestedMapping: Record<ImportField, number | null>
}

export interface ImportReport {
  total: number
  created: number
  updated: number
  merged: number
  skipped: number
  duplicates: number
  errors: number
  errorRows: Array<{ row: number; error: string }>
  errorFileToken: string | null
}

export async function parseImportFile(file: File): Promise<ImportParseResult> {
  const form = new FormData()
  form.append('file', file)
  const { data } = await api.post('/customers/import/parse', form, { timeout: 120_000 })
  return data
}

export async function runImport(payload: {
  token: string
  mapping: Record<ImportField, number | null>
  duplicateMode: 'SKIP' | 'MERGE' | 'UPDATE'
  defaultBranchId?: string
}): Promise<ImportReport> {
  const { data } = await api.post('/customers/import/run', payload, { timeout: 600_000 })
  return data
}

export async function downloadImportErrors(token: string): Promise<void> {
  const { data } = await api.get(`/customers/import/errors/${token}`, { responseType: 'blob' })
  const url = URL.createObjectURL(data as Blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'dong-loi-nhap-khach.csv'
  a.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

/* ------------------------------------------------------------------ CỌC */

export interface DepositQr {
  appointmentId: string
  code: string
  amount: number
  depositStatus: string | null
  bankConfigured: boolean
  bank: { bin: string; accountNo: string; accountName: string } | null
  url: string | null
}

export async function fetchDepositQr(appointmentId: string): Promise<DepositQr> {
  const { data } = await api.get(`/reception/appointments/${appointmentId}/deposit-qr`)
  return data
}

export async function confirmDeposit(
  appointmentId: string,
  payload: { amount?: number; method?: string; reference?: string } = {}
): Promise<{ appointment: Appointment; payment: Payment }> {
  const { data } = await api.post(`/reception/appointments/${appointmentId}/deposit/confirm`, payload)
  return data
}

export async function refundDeposit(appointmentId: string, reason: string): Promise<Payment> {
  const { data } = await api.post(`/reception/appointments/${appointmentId}/deposit/refund`, { reason })
  return data
}

export async function fetchOpenDeposits(customerId: string): Promise<{
  total: number
  items: Array<{ id: string; code: string; amount: number; paidAt: string; appointmentId: string | null }>
}> {
  const { data } = await api.get('/sales/open-deposits', { params: { customerId } })
  return data
}

export interface DepositReport {
  appointments: number
  withDeposit: number
  depositRate: number | null
  depositCollected: number
  noShow: {
    withDeposit: { due: number; noShow: number; rate: number | null }
    withoutDeposit: { due: number; noShow: number; rate: number | null }
  }
}

export async function fetchDepositReport(params: { period?: string; branchId?: string } = {}): Promise<DepositReport> {
  const { data } = await api.get('/reports/deposits', { params })
  return data
}

/* -------------------------------------------------------- HỘP THƯ (F24, AI1) */

export interface CannedPreview {
  content: string
  missing: string[]
  services: Array<{ id: string; name: string; price: number | null }>
}

export async function previewCanned(
  conversationId: string,
  kind: 'location' | 'price',
  serviceIds?: string[]
): Promise<CannedPreview> {
  const { data } = await api.get(`/conversations/${conversationId}/canned/${kind}`, {
    params: serviceIds?.length ? { serviceIds: serviceIds.join(',') } : {}
  })
  return data
}

export async function sendCanned(
  conversationId: string,
  kind: 'location' | 'price',
  serviceIds?: string[]
): Promise<ChatMessage> {
  const { data } = await api.post(`/conversations/${conversationId}/canned/${kind}`, { serviceIds })
  return data
}

export interface ExtractedInfo {
  phone: string | null
  name: string | null
  interest: string | null
  area: string | null
}

export interface ExtractionResult {
  regex: { phones: string[] }
  ai: { status: 'OK' | 'NOT_CONFIGURED' | 'DISABLED' | 'NO_CONSENT' | 'SKIPPED' | 'ERROR'; message?: string }
  suggestion: ExtractedInfo
  duplicate: { id: string; code: string; name: string } | null
  lastMessageId: string | null
}

export async function extractFromChat(conversationId: string): Promise<ExtractionResult> {
  const { data } = await api.post(`/conversations/${conversationId}/extract`)
  return data
}

export async function applyExtraction(conversationId: string, payload: Partial<ExtractedInfo>): Promise<{ changed: string[] }> {
  const { data } = await api.post(`/conversations/${conversationId}/extract/apply`, payload)
  return data
}

/* ------------------------------------------------------------- CƠ SỞ (F24) */

export interface BranchInfo {
  id: string
  code: string
  name: string
  shortName: string | null
  address: string | null
  phone: string | null
  mapUrl: string | null
  parkingGuide: string | null
  buildingGuide: string | null
  facadePhotoUrl: string | null
  bankBin: string | null
  bankAccountNo: string | null
  bankAccountName: string | null
}

export async function fetchBranchInfos(): Promise<BranchInfo[]> {
  const { data } = await api.get('/org/branches')
  return data
}

export async function updateBranchInfo(id: string, payload: Partial<BranchInfo>): Promise<BranchInfo> {
  const { data } = await api.patch(`/org/branches/${id}`, payload)
  return data
}

/* -------------------------------------------------------------- ẢNH (F2) */

export async function setPhotoMarketingConsent(photoSetId: string, consent: boolean): Promise<{ consentForMarketing: boolean }> {
  const { data } = await api.patch(`/medical/photo-sets/${photoSetId}/marketing-consent`, { consent })
  return data
}

export async function setAppointmentDeposit(appointmentId: string, depositAmount: number): Promise<Appointment> {
  const { data } = await api.patch(`/reception/appointments/${appointmentId}`, { depositAmount })
  return data
}
