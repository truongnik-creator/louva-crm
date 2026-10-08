import { api } from './api'

/* API của Lô 5 (Đợt 3 NOVA): đo lường, lương thưởng, tăng trưởng. */

export interface FunnelMetrics {
  cost: number
  newMessages: number
  phones: number
  costPerPhone: number | null
  depositBookings: number
  costPerDeposit: number | null
  showups: number
  costPerShowup: number | null
  revenue: number
  roas: number | null
}

export interface WeeklyRow {
  weekKey: string
  from: string
  to: string
  total: FunnelMetrics
  ads: FunnelMetrics
  organic: FunnelMetrics
  byChannel: Array<{ channelId: string | null; name: string } & FunnelMetrics>
  byCampaign: Array<{ campaignId: string; code: string; name: string; channel: string } & FunnelMetrics>
}

export async function fetchWeekly(params: { weeks?: number; to?: string } = {}): Promise<{ weeks: WeeklyRow[] }> {
  return (await api.get('/analytics/weekly', { params })).data
}

export interface AdCostRow {
  id: string
  day: string
  amount: number
  source: string
  note: string | null
  campaign: { id: string; code: string; name: string; channel: { name: string } | null }
}

export async function fetchAdCosts(params: { from?: string; to?: string } = {}): Promise<AdCostRow[]> {
  return (await api.get('/analytics/ad-costs', { params })).data
}

export async function saveAdCost(body: { campaignId: string; date: string; amount: number; note?: string }): Promise<void> {
  await api.put('/analytics/ad-costs', body)
}

export interface AdImportResult {
  platform: string
  imported: number
  createdCampaigns: string[]
  unknownCampaigns: string[]
  errors: Array<{ line: number; message: string }>
}

export async function importAdCostCsv(body: {
  content: string
  platform: 'META' | 'TIKTOK' | 'AUTO'
  createMissing: boolean
  fileName?: string
}): Promise<AdImportResult> {
  return (await api.post('/analytics/ad-costs/import', body)).data
}

export interface EodRow {
  userId: string
  name: string
  newMessages: number
  phones: number
  depositBookings: number
  showups: number
  overdueTasks: number
  noPhoneConversations: number
  noPhoneList: Array<{ id: string; title: string; lastMessageAt: string | null }>
}

export async function fetchEod(date?: string): Promise<{ date: string; onlyMe: boolean; rows: EodRow[] }> {
  return (await api.get('/analytics/eod', { params: { date } })).data
}

export interface LeaderRow {
  userId: string
  name: string
  showups: number
  rank: number | null
  disqualified: boolean
  reasons: string[]
}

export async function fetchLeaderboard(period?: string): Promise<{
  period: string
  target: number
  actual: number
  percent: number | null
  rows: LeaderRow[]
}> {
  return (await api.get('/analytics/leaderboard', { params: { period } })).data
}

export interface BucketRow {
  bucket: string
  label: string
  conversations: number
  avgMinutes: number | null
  phoneRate: number | null
  showRate: number | null
  closeRate: number | null
}

export async function fetchResponseBuckets(params: { period?: string; from?: string; to?: string }): Promise<{ rows: BucketRow[] }> {
  return (await api.get('/analytics/response-buckets', { params })).data
}

export interface MarginRow {
  key: string
  label: string
  count: number
  revenue: number
  cost: number
  commission: number
  grossMargin: number
  marginPercent: number | null
}

export async function fetchMargin(params: { period?: string; groupBy: string }): Promise<{ rows: MarginRow[]; total: Omit<MarginRow, 'key' | 'label'> }> {
  return (await api.get('/analytics/margin', { params })).data
}

export interface RetentionCell {
  eligible: number
  returned: number
  rate: number | null
}

export interface RetentionRow {
  serviceId: string
  serviceName: string
  cohort: string
  customers: number
  d90: RetentionCell
  d180: RetentionCell
  d365: RetentionCell
}

export async function fetchRetention(params: { from?: string; to?: string } = {}): Promise<{ rows: RetentionRow[] }> {
  return (await api.get('/analytics/retention', { params })).data
}

export interface RetreatDueRow {
  procedureId: string
  customer: { id: string; code: string; name: string; phone: string | null; assignedTo: { name: string } | null }
  serviceName: string
  lastDoneAt: string
  retreatDueAt: string
  overdueDays: number
}

export async function fetchRetreatDue(): Promise<{ rows: RetreatDueRow[] }> {
  return (await api.get('/analytics/retreat-due')).data
}

export async function fetchLtv(params: { period?: string; groupBy: string }): Promise<{
  split: { newCustomers: number; newRevenue: number; returningCustomers: number; returningRevenue: number }
  rows: Array<{ key: string; label: string; customers: number; revenue: number; ltv: number }>
}> {
  return (await api.get('/analytics/ltv', { params })).data
}

export interface ForecastData {
  periodKey: string
  daysInMonth: number
  elapsedDays: number
  actual: number
  runRatePerDay: number
  runRateForecast: number
  bookedValue: number
  bookedCount: number
  forecast: number
  prevSameDays: number
  vsPrevPercent: number | null
  target: number | null
  progressPercent: number | null
  forecastVsTargetPercent: number | null
  byBranch: Array<{ branchId: string; name: string; target: number | null; actual: number; progressPercent: number | null }>
  byService: Array<{ serviceId: string; name: string; target: number | null; actual: number; progressPercent: number | null }>
  unassignedRevenue: number
}

export async function fetchForecast(period?: string): Promise<ForecastData> {
  return (await api.get('/analytics/forecast', { params: { period } })).data
}

export async function saveTarget(body: { periodKey: string; branchId?: string | null; serviceId?: string | null; targetRevenue: number }): Promise<void> {
  await api.put('/analytics/targets', body)
}

/** Tải tệp nhị phân và mở hộp lưu của trình duyệt. */
export async function downloadFile(url: string, params: Record<string, string>, fileName: string): Promise<void> {
  const { data } = await api.get(url, { params, responseType: 'blob', timeout: 300000 })
  const href = URL.createObjectURL(data as Blob)
  const a = document.createElement('a')
  a.href = href
  a.download = fileName
  a.click()
  setTimeout(() => URL.revokeObjectURL(href), 5000)
}

/* ------------------------------------------------------------ KỲ LƯƠNG (F17) */

export interface PayrollLineRow {
  id: string
  userId: string
  user: { id: string; name: string }
  roleCode: string | null
  showups: number
  revenue: number
  baseSalary: number
  salesBonus: number
  commission: number
  upsellBonus: number
  adsBonus: number
  allowance: number
  deduction: number
  total: number
  note: string | null
  detail: {
    saleRevenue: number
    doctorRevenue: number
    upsellRevenue: number
    adsRevenue: number
    adsStaffCount: number
    bonusScheme: string
    contributions: Array<{ paymentCode: string; paidAt: string; customer: string; contract: string | null; kind: string; amount: number; credited: number }>
  } | null
}

export interface PayrollPeriodData {
  id?: string
  periodKey: string
  status: 'OPEN' | 'CLOSED'
  computedAt: string | null
  closedAt?: string | null
  closedBy?: { name: string } | null
  lines: PayrollLineRow[]
}

export async function fetchPayroll(period: string): Promise<PayrollPeriodData> {
  return (await api.get(`/payroll/${period}`)).data
}
export async function computePayroll(period: string): Promise<void> {
  await api.post(`/payroll/${period}/compute`, {})
}
export async function lockPayroll(period: string): Promise<void> {
  await api.post(`/payroll/${period}/lock`, {})
}
export async function updatePayrollLine(id: string, body: { allowance?: number; deduction?: number; baseSalary?: number; note?: string | null }): Promise<void> {
  await api.patch(`/payroll/lines/${id}`, body)
}

/* ------------------------------------------------- GIỚI THIỆU, VOUCHER, QUÀ */

export interface ReferralInfo {
  referralCode: string | null
  referrer: { id: string; code: string; name: string } | null
  referees: Array<{ id: string; code: string; name: string; rewarded: boolean }>
  rewards: Array<{ id: string; kind: string; amount: number; status: string; createdAt: string }>
  rewardForThisCustomer: { id: string } | null
}

export async function fetchReferral(customerId: string): Promise<ReferralInfo> {
  return (await api.get(`/growth/customers/${customerId}/referral`)).data
}
export async function createReferralCode(customerId: string): Promise<string> {
  return (await api.post(`/growth/customers/${customerId}/referral-code`, {})).data.referralCode
}
export async function setReferrer(customerId: string, body: { code?: string; referrerId?: string }): Promise<void> {
  await api.post(`/growth/customers/${customerId}/referrer`, body)
}

export async function fetchReferralReport(period: string): Promise<{
  totals: { referees: number; rewarded: number; rewardTotal: number; refereeRevenue: number }
  rows: Array<{ referrerId: string; referrer: { code: string; name: string } | null; referees: number; rewarded: number; rewardTotal: number; refereeRevenue: number }>
  pendingCash: Array<{ id: string; amount: number; createdAt: string; referrer: { name: string } | null; referee: { name: string } | null }>
}> {
  return (await api.get('/growth/referrals/report', { params: { period } })).data
}
export async function markRewardPaid(id: string): Promise<void> {
  await api.post(`/growth/referral-rewards/${id}/paid`, {})
}

export interface VoucherRow {
  id: string
  code: string
  value: number
  expiresAt: string
  state: 'ACTIVE' | 'REDEEMED' | 'CANCELLED' | 'EXPIRED'
  source: string
  note: string | null
  customer: { id: string; code: string; name: string } | null
}

export async function fetchVouchers(params: { customerId?: string; status?: string; q?: string } = {}): Promise<VoucherRow[]> {
  return (await api.get('/growth/vouchers', { params })).data
}
export async function createVoucher(body: { customerId?: string | null; value: number; expiresAt: string; note?: string }): Promise<VoucherRow> {
  return (await api.post('/growth/vouchers', body)).data
}
export async function cancelVoucher(id: string): Promise<void> {
  await api.post(`/growth/vouchers/${id}/cancel`, {})
}
export async function redeemVoucher(body: { code: string; customerId: string; invoiceId?: string; contractId?: string }): Promise<{ amount: number }> {
  return (await api.post('/growth/vouchers/redeem', body)).data
}

export interface GiftItem {
  id: string
  name: string
  cost: number
  active: boolean
}
export async function fetchGiftItems(all = false): Promise<GiftItem[]> {
  return (await api.get('/growth/gift-items', { params: all ? { all: '1' } : {} })).data
}
export async function saveGiftItem(body: { id?: string; name?: string; cost?: number; active?: boolean }): Promise<void> {
  if (body.id) await api.patch(`/growth/gift-items/${body.id}`, { name: body.name, cost: body.cost, active: body.active })
  else await api.post('/growth/gift-items', body)
}
export async function logGift(body: { customerId: string; giftItemId: string; quantity: number; note?: string }): Promise<void> {
  await api.post('/growth/gifts', body)
}
export async function fetchGifts(params: { period?: string; customerId?: string }): Promise<{
  rows: Array<{ id: string; giftName: string; quantity: number; totalCost: number; createdAt: string; givenByName: string | null; customer: { name: string; code: string } | null }>
  byItem: Array<{ giftName: string; quantity: number; totalCost: number }>
  totalCost: number
}> {
  return (await api.get('/growth/gifts', { params })).data
}

export interface ViolationRow {
  id: string
  userId: string
  userName: string | null
  periodKey: string
  reason: string
  flaggedByName: string | null
  createdAt: string
  revokedAt: string | null
}
export async function fetchViolations(period: string): Promise<ViolationRow[]> {
  return (await api.get('/growth/violations', { params: { period } })).data
}
export async function flagViolation(body: { userId: string; periodKey: string; reason: string }): Promise<void> {
  await api.post('/growth/violations', body)
}
export async function revokeViolation(id: string): Promise<void> {
  await api.post(`/growth/violations/${id}/revoke`, {})
}

/* ----------------------------------------------------- AI4 CHẤM HỘI THOẠI */

export interface ScoreRow {
  id: string
  conversationId: string
  conversationTitle: string | null
  userName: string | null
  status: string
  score: number | null
  summary: string | null
  error: string | null
  scriptVersion: number | null
  criteria: Array<{ name: string; score: number | null; comment: string }>
}

export async function fetchConversationScores(week?: string): Promise<{
  aiConfigured: boolean
  weeks: string[]
  week: string | null
  summary: Array<{ userId: string | null; name: string; count: number; avgScore: number }>
  rows: ScoreRow[]
}> {
  return (await api.get('/analytics/conversation-scores', { params: { week } })).data
}
export async function runScoringNow(): Promise<{ status: string; message?: string; error?: string }> {
  return (await api.post('/analytics/conversation-scores/run', {})).data
}

/** Kỳ tháng hiện tại "YYYY-MM" theo giờ máy người dùng. */
export function currentPeriod(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

/* ------------------------------------------- F17 GHI NHẬN AI CHỐT HỢP ĐỒNG */

export interface ContractLite {
  id: string
  code: string
  status: string
  total: number
  paidAmount: number
  closeType: 'FULL' | 'PARTIAL'
  closingDoctorId: string | null
  items: Array<{ id: string; name: string; amount: number; upsellById: string | null }>
}

export async function fetchCustomerContracts(customerId: string): Promise<ContractLite[]> {
  return (await api.get('/sales/contracts', { params: { customerId } })).data
}

export async function saveContractAttribution(
  id: string,
  body: { closeType?: 'FULL' | 'PARTIAL'; closingDoctorId?: string | null; upsell?: Array<{ itemId: string; upsellById: string | null }> }
): Promise<void> {
  await api.patch(`/sales/contracts/${id}/attribution`, body)
}
