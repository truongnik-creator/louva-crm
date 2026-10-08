import { api } from './api'
import type { AgeLevel } from './api-lo7'

/* API của Lô 8 (CRM 360 Lô B): cơ hội bán, bước con và điều kiện kéo thẻ, hồ sơ
   nhu cầu, dòng thời gian đa kênh, việc theo bước, gói liệu trình, báo giá bị
   từ chối, báo cáo hành trình, giá trị đơn, dự báo. */

// ------------------------------------------------------------- P6 CƠ HỘI

export interface OpportunityRow {
  id: string
  title: string
  stage: string
  stageLabel: string
  subStage: string | null
  status: 'OPEN' | 'WON' | 'LOST'
  source: string
  serviceId: string | null
  serviceName: string | null
  owner: { id: string; name: string } | null
  expectedValue: number | null
  manualValue: number | null
  valueSource: string | null
  expectedCloseAt: string | null
  lostReason: string | null
  lostNote: string | null
  daysInStage: number
  ageLevel: AgeLevel
  createdAt: string
  closedAt: string | null
  history: Array<{ id: string; fromStage: string | null; toStage: string; source: string; event: string | null; note: string | null; userName: string | null; createdAt: string }>
}

export async function fetchOpportunities(customerId: string): Promise<{ moneyVisible: boolean; currentId: string | null; items: OpportunityRow[] }> {
  const { data } = await api.get(`/crm360/customers/${customerId}/opportunities`)
  return data
}

export async function openOpportunity(
  customerId: string,
  payload: { serviceId?: string | null; title?: string | null; stage?: string; expectedValue?: number | null; expectedCloseAt?: string | null; note?: string | null }
): Promise<{ id: string }> {
  const { data } = await api.post(`/crm360/customers/${customerId}/opportunities`, payload)
  return data
}

export async function updateOpportunity(
  id: string,
  payload: { title?: string; serviceId?: string | null; expectedValue?: number | null; expectedCloseAt?: string | null; ownerId?: string | null; subStage?: string | null }
): Promise<void> {
  await api.patch(`/crm360/opportunities/${id}`, payload)
}

export async function changeOpportunityStage(id: string, payload: { stage: string; lostReason?: string; reason?: string }): Promise<{ customerStage: string }> {
  const { data } = await api.post(`/crm360/opportunities/${id}/stage`, payload)
  return data
}

export type DropAction = 'BOOK' | 'DEPOSIT' | 'LOST_REASON' | 'QUOTE' | 'CONTRACT'

export interface DropPlan {
  missing: Array<'APPOINTMENT' | 'CONTRACT'>
  action: DropAction | null
  blocking: boolean
  appointment: { id: string; startAt: string; depositStatus: string | null; depositAmount: number; code: string | null } | null
  message: string | null
}

export async function fetchDropPlan(target: { opportunityId?: string | null; customerId: string }, to: string): Promise<DropPlan> {
  const url = target.opportunityId ? `/crm360/opportunities/${target.opportunityId}/drop-check` : `/crm360/customers/${target.customerId}/drop-check`
  const { data } = await api.get(url, { params: { to } })
  return data
}

// ------------------------------------------------------------- C3 NHU CẦU

export interface NeedsProfile {
  areas: string[]
  budget: string | null
  fears: string[]
  decisionMaker: string | null
  occasion: string | null
  occasionDate: string | null
  comparing: string[]
  note: string | null
  updatedAt?: string
  updatedBy?: string
}

export interface NeedsOptions {
  areas: Array<{ key: string; label: string }>
  budgets: string[]
  fears: string[]
  decisionMakers: string[]
  occasions: string[]
}

export async function fetchNeeds(customerId: string): Promise<{ needs: NeedsProfile; options: NeedsOptions }> {
  const { data } = await api.get(`/crm360/customers/${customerId}/needs`)
  return data
}

export async function saveNeeds(customerId: string, needs: NeedsProfile): Promise<{ needs: NeedsProfile }> {
  const { updatedAt: _a, updatedBy: _b, ...body } = needs
  const { data } = await api.put(`/crm360/customers/${customerId}/needs`, body)
  return data
}

export async function suggestNeeds(customerId: string): Promise<{ status: string; suggestion: Partial<NeedsProfile>; message?: string }> {
  const { data } = await api.post(`/crm360/customers/${customerId}/needs/suggest`)
  return data
}

// ------------------------------------------------------------- C4 DÒNG THỜI GIAN

export type TimelineKind = 'MESSAGE' | 'CALL' | 'VISIT' | 'APPOINTMENT' | 'QUOTE' | 'PAYMENT' | 'CONTRACT' | 'STAGE' | 'NOTE' | 'PACKAGE'

export interface TimelineItem {
  id: string
  at: string
  kind: TimelineKind
  channel: string | null
  direction: string | null
  title: string
  text: string | null
  by: string | null
  amount: number | null
}

export async function fetchTimeline(
  customerId: string,
  params: { kinds?: string; channel?: string; before?: string; limit?: number }
): Promise<{ items: TimelineItem[]; nextBefore: string | null; channels: Array<{ key: string; label: string }>; moneyVisible: boolean }> {
  const { data } = await api.get(`/crm360/customers/${customerId}/timeline`, { params })
  return data
}

export async function logCall(customerId: string, payload: { direction: 'IN' | 'OUT'; result: string; durationSec?: number; note?: string }): Promise<void> {
  await api.post(`/crm360/customers/${customerId}/calls`, payload)
}

// ------------------------------------------------------------- J3 VIỆC THEO BƯỚC

export interface ChecklistItem {
  id: string
  stage: string
  branchId: string | null
  title: string
  messageTemplate: string | null
  dueDays: number
  sortOrder: number
  active: boolean
  isSample: boolean
}

export async function fetchChecklist(): Promise<{ items: ChecklistItem[]; canManage: boolean }> {
  const { data } = await api.get('/crm360/stage-checklist')
  return data
}

export async function createChecklistItem(payload: Partial<ChecklistItem>): Promise<ChecklistItem> {
  const { data } = await api.post('/crm360/stage-checklist', payload)
  return data
}

export async function updateChecklistItem(id: string, payload: Partial<ChecklistItem>): Promise<ChecklistItem> {
  const { data } = await api.patch(`/crm360/stage-checklist/${id}`, payload)
  return data
}

// ------------------------------------------------------------- V3 GÓI LIỆU TRÌNH

export interface PackageRow {
  id: string
  name: string
  contractId: string
  totalSessions: number
  usedSessions: number
  remainingSessions: number
  status: 'ACTIVE' | 'COMPLETED' | 'CANCELLED'
  expiresAt: string | null
  expired: boolean
  intervalDays: number | null
  lastUsedAt: string | null
  cancelReason: string | null
  createdAt: string
  price: number | null
  usedValue: number | null
  remainingValue: number | null
  sessions: Array<{ id: string; sessionNo: number; usedAt: string; value: number | null; userName: string | null; note: string | null }>
}

export async function fetchPackages(customerId: string): Promise<{
  moneyVisible: boolean
  items: PackageRow[]
  candidates: Array<{ id: string; name: string; quantity: number; amount: number | null; contract: { id: string; code: string } }>
}> {
  const { data } = await api.get(`/crm360/customers/${customerId}/packages`)
  return data
}

export async function createPackage(payload: { contractItemId: string; sessions?: number; intervalDays?: number | null }): Promise<PackageRow> {
  const { data } = await api.post('/crm360/packages', payload)
  return data
}

export async function consumePackageSession(id: string, payload: { note?: string }): Promise<void> {
  await api.post(`/crm360/packages/${id}/sessions`, payload)
}

export async function cancelPackage(id: string, reason: string): Promise<void> {
  await api.post(`/crm360/packages/${id}/cancel`, { reason })
}

export interface PackageSummary {
  packages: number
  active: number
  completed: number
  cancelled: number
  soldValue: number
  usedValue: number
  remainingValue: number
  prepaidUnused: number
  note: string
}

export async function fetchPackageSummary(): Promise<PackageSummary> {
  const { data } = await api.get('/crm360/packages/summary')
  return data
}

// ------------------------------------------------------------- V6 BÁO GIÁ

export interface QuotationRow {
  id: string
  code: string
  status: 'DRAFT' | 'SENT' | 'ACCEPTED' | 'REJECTED' | 'EXPIRED'
  total: number
  createdAt: string
  rejectReason: string | null
  optionTier: string | null
  approvalStatus: string
  items: Array<{ name: string }>
  createdBy: { id: string; name: string } | null
}

export async function fetchCustomerQuotations(customerId: string): Promise<QuotationRow[]> {
  const { data } = await api.get('/sales/quotations', { params: { customerId, limit: 50 } })
  return data
}

export async function setQuotationStatus(id: string, status: string, reason?: string): Promise<{ followupTaskId?: string }> {
  const { data } = await api.post(`/sales/quotations/${id}/status`, { status, reason })
  return data
}

// ------------------------------------------------------------- BÁO CÁO

export interface JourneyStageStat {
  stage: string
  entered: number
  completed: number
  avgDays: number | null
  dropped: number
}

export interface JourneySummary {
  stages: JourneyStageStat[]
  units: number
  lost: number
  topDrop: { stage: string; dropped: number } | null
}

export interface JourneyReport {
  days: number
  groupBy: string
  stages: Array<{ key: string; label: string }>
  overall: JourneySummary
  groups: Array<JourneySummary & { key: string | null; label: string }>
}

export async function fetchJourneyReport(params: { days?: number; groupBy: string; branchId?: string }): Promise<JourneyReport> {
  const { data } = await api.get('/crm360/reports/journey', { params })
  return data
}

export interface AovRow {
  key: string | null
  label?: string
  orders: number
  revenue: number
  avg: number
  withUpsell: number
  upsellRate: number
}

export interface AovReport {
  days: number
  overall: AovRow
  by: Record<string, AovRow[]>
  upsellOffers: { total: { suggested: number; accepted: number; declined: number; acceptRate: number | null } }
  note: string
}

export async function fetchAovReport(params: { days?: number; branchId?: string }): Promise<AovReport> {
  const { data } = await api.get('/crm360/reports/aov', { params })
  return data
}

export interface ForecastBucket {
  key: string | null
  label?: string
  count: number
  pipelineValue: number
  weightedValue: number
  noDataCount: number
  noDataValue: number
}

export interface ForecastReport {
  minSamples: number
  lookbackDays: number
  probabilities: Array<{ stage: string; label: string; settled: number; won: number; probability: number | null }>
  total: ForecastBucket
  byMonth: ForecastBucket[]
  byOwner: ForecastBucket[]
  byStage: ForecastBucket[]
}

export async function fetchForecast(params: { branchId?: string } = {}): Promise<ForecastReport> {
  const { data } = await api.get('/crm360/reports/forecast', { params })
  return data
}
