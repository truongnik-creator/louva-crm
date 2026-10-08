/* F29: các khối trang chủ theo vai thêm ở Lô 5 (khớp routes/home.ts). */

export interface HomeLo5Sections {
  myTasks?: { overdue: number; dueToday: number }
  teamTarget?: {
    target: number
    actual: number
    percent: number | null
    myShowups: number | null
    myRank: number | null
    myDisqualified: boolean
    top: Array<{ name: string; showups: number; rank: number | null }>
  }
  myDay?: {
    newMessages: number
    phones: number
    depositBookings: number
    showups: number
    overdueTasks: number
    noPhoneConversations: number
  }
  medicalFlags?: { total: number; items: Array<{ id: string; title: string; medicalFlagAt: string | null; lastMessagePreview: string | null }> }
  aftercare?: {
    total: number
    items: Array<{ id: string; title: string; dueAt: string | null; milestone: string | null; customer: { id: string; name: string; code: string } | null }>
  }
  deposits?: {
    waiting: number
    items: Array<{ id: string; startAt: string; title: string; depositAmount: number; customer: { id: string; name: string; code: string } }>
  }
  marketing?: {
    weekKey: string
    cost: number
    newMessages: number
    phones: number
    costPerPhone: number | null
    showups: number
    costPerShowup: number | null
    revenue: number
    roas: number | null
    adsCost: number
    organicMessages: number
  }
  accounting?: { collectedToday: number; paymentsToday: number; overdueInvoices: number; pendingReferralPayouts: number }
  director?: {
    periodKey: string
    actual: number
    forecast: number
    target: number | null
    progressPercent: number | null
    forecastVsTargetPercent: number | null
    vsPrevPercent: number | null
  }
}
