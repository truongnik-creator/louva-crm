import { api } from './api'

/* API của Lô 6 (SAU 90 NGÀY): phiếu tư vấn, phác đồ, thư viện case (F30),
   nháp tin chăm lại (AI5), bản tin sáng (AI6 nằm trong /api/home). */

// ------------------------------------------------------------ F30 TƯ VẤN

export interface ConsultMeta {
  faceAreas: Array<{ value: string; label: string }>
  services: Array<{ id: string; code: string; name: string; category: string | null; listPrice: number | null }>
  products: Array<{ id: string; name: string; unit: string }>
}

export interface Proposal {
  serviceId: string
  serviceName?: string
  productId?: string | null
  productName?: string | null
  productUnit?: string | null
  /** Liều theo 0,1 đơn vị: 15 = 1,5. */
  doseTenths?: number | null
  quantity?: number | null
  faceArea?: string | null
  listPrice?: number | null
  note?: string | null
}

export interface PlanItem {
  id: string
  name: string
  serviceId: string | null
  productName: string | null
  doseTenths: number | null
  quantity: number
  listPrice: number | null
  faceArea: string | null
  note: string | null
}

export interface TreatmentPlan {
  id: string
  title: string
  status: string
  quotationId: string | null
  quotation?: { id: string; code: string; status: string; total: number; approvalStatus: string } | null
  items?: PlanItem[]
  createdAt: string
}

export interface ConsultationSession {
  id: string
  branchId: string
  customerId: string
  heldAt: string
  faceAreas: string[]
  proposals: Proposal[]
  expectation: string | null
  budgetNote: string | null
  readiness: string | null
  contraindicationNote: string | null
  note: string | null
  photoSetId: string | null
  customer?: { id: string; code: string; name: string; phone: string | null } | null
  doctor?: { id: string; name: string } | null
  consultant?: { id: string; name: string } | null
  plans?: TreatmentPlan[]
  photoSet?: { id: string; photos: Array<{ id: string; angle: string | null }> } | null
}

export type ConsultationInput = {
  customerId: string
  faceAreas: string[]
  proposals: Proposal[]
  expectation?: string | null
  budgetNote?: string | null
  readiness?: string | null
  contraindicationNote?: string | null
  note?: string | null
}

export async function fetchConsultMeta(): Promise<ConsultMeta> {
  return (await api.get('/consultations/meta')).data
}
export async function fetchConsultations(params: { customerId?: string; limit?: number } = {}): Promise<ConsultationSession[]> {
  return (await api.get('/consultations', { params })).data
}
export async function fetchConsultation(id: string): Promise<ConsultationSession> {
  return (await api.get(`/consultations/${id}`)).data
}
export async function createConsultation(body: ConsultationInput): Promise<ConsultationSession> {
  return (await api.post('/consultations', body)).data
}
export async function updateConsultation(id: string, body: Partial<ConsultationInput>): Promise<ConsultationSession> {
  return (await api.patch(`/consultations/${id}`, body)).data
}
export async function uploadConsultPhotos(id: string, files: File[], angle?: string): Promise<{ photoSetId: string; added: number }> {
  const form = new FormData()
  for (const f of files) form.append('photos', f)
  if (angle) form.append('angle', angle)
  return (await api.post(`/consultations/${id}/photos`, form, { timeout: 120_000 })).data
}
export async function createPlan(id: string, body: { title?: string; method?: string; expectedResult?: string; riskNote?: string } = {}): Promise<TreatmentPlan> {
  return (await api.post(`/consultations/${id}/plans`, body)).data
}
export async function updatePlan(planId: string, body: { status?: string }): Promise<TreatmentPlan> {
  return (await api.patch(`/consultations/plans/${planId}`, body)).data
}
export async function quoteFromPlan(planId: string): Promise<{ quotation: { id: string; code: string; total: number } }> {
  return (await api.post(`/consultations/plans/${planId}/quote`)).data
}

/** "15" -> "1,5". */
export function tenths(v: number | null | undefined): string {
  if (v == null) return ''
  const whole = Math.trunc(v / 10)
  const frac = Math.abs(v % 10)
  return frac ? `${whole},${frac}` : String(whole)
}
/** "1,5" hoặc "1.5" -> 15. Sai định dạng trả null. */
export function parseTenths(text: string): number | null {
  const t = text.trim().replace(',', '.')
  if (!t) return null
  if (!/^\d+(\.\d)?$/.test(t)) return null
  return Math.round(Number(t) * 10)
}

// ------------------------------------------------------------ F30 THƯ VIỆN CASE

export interface CaseItem {
  id: string
  title: string
  anonymLabel: string
  summary: string | null
  beforeNote: string | null
  afterNote: string | null
  status: string
  service: { id: string; name: string } | null
  doctor: { id: string; name: string } | null
  branch: { id: string; name: string } | null
  publishedAt: string | null
  medicalApprovedAt: string | null
  marketingApprovedAt: string | null
  photos: Array<{ id: string; stage: string; angle: string | null }>
}

export async function fetchCases(params: { serviceId?: string } = {}): Promise<{ items: CaseItem[]; services: Array<{ id: string; name: string }>; canManage: boolean }> {
  return (await api.get('/cases', { params })).data
}
export async function fetchCasePhoto(caseId: string, photoId: string): Promise<string> {
  const { data } = await api.get(`/cases/${caseId}/photos/${photoId}`, { responseType: 'blob' })
  return URL.createObjectURL(data as Blob)
}
export async function createCase(body: { customerId: string; procedureId?: string | null; serviceId?: string | null; title: string; summary?: string; beforeNote?: string; afterNote?: string }): Promise<{ id: string }> {
  return (await api.post('/cases', body)).data
}
export async function approveCase(id: string, gate: 'MEDICAL' | 'MARKETING'): Promise<{ status: string }> {
  return (await api.post(`/cases/${id}/approve`, { gate })).data
}
export async function withdrawCase(id: string, reason: string): Promise<void> {
  await api.post(`/cases/${id}/withdraw`, { reason })
}

// ------------------------------------------------------------ AI5 NHÁP CHĂM LẠI

export interface ReengageDraft {
  id: string
  customerId: string
  content: string
  finalContent: string | null
  status: string
  createdAt: string
  reviewedByName: string | null
  rejectReason: string | null
  customer: { id: string; code: string; name: string; phone: string | null; optOut: boolean; lastContactAt: string | null; stage: string } | null
}

export async function fetchReengageDrafts(status = 'PENDING'): Promise<{ total: number; aiConfigured: boolean; enabled: boolean; items: ReengageDraft[] }> {
  return (await api.get('/reengage/drafts', { params: { status, limit: 100 } })).data
}
export async function approveReengage(id: string, content?: string): Promise<{ broadcastId: string; recipientStatus: string }> {
  return (await api.post(`/reengage/drafts/${id}/approve`, content ? { content } : {})).data
}
export async function rejectReengage(id: string, reason?: string): Promise<void> {
  await api.post(`/reengage/drafts/${id}/reject`, reason ? { reason } : {})
}
