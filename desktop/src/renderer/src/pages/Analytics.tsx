import React, { useState } from 'react'
import { useAuth } from '../lib/auth-context'
import { AdCostPanel, EodPanel, LeaderboardPanel, WeeklyPanel } from '../components/lo5-sales-parts'
import {
  AccountingExportPanel,
  ForecastPanel,
  LtvPanel,
  MarginPanel,
  ResponsePanel,
  RetentionPanel
} from '../components/lo5-finance-parts'
import { Empty } from '../components/ui'

/* ĐO LƯỜNG ĐỢT 3: một trang, nhiều thẻ; thẻ nào hiện tuỳ quyền của người xem
 * (khớp quyền phía máy chủ ở routes/analytics.ts). */

interface TabDef {
  key: string
  label: string
  show: (can: (p: string) => boolean, cross: (p: string) => boolean) => boolean
  render: () => React.JSX.Element
}

const TABS: TabDef[] = [
  { key: 'eod', label: 'Họp cuối ngày', show: (can) => can('customer.read') || can('inbox.read'), render: () => <EodPanel /> },
  { key: 'contest', label: 'Thi đua', show: (can) => can('customer.read') || can('hr.read') || can('inbox.read'), render: () => <LeaderboardPanel /> },
  { key: 'weekly', label: 'Chỉ số tuần', show: (_c, cross) => cross('lead.read') || cross('accounting.read'), render: () => <WeeklyPanel /> },
  { key: 'adcost', label: 'Chi phí quảng cáo', show: (can) => can('lead.read'), render: () => <AdCostPanel /> },
  { key: 'response', label: 'Tốc độ trả lời', show: (_c, cross) => cross('lead.read') || cross('hr.read') || cross('accounting.read'), render: () => <ResponsePanel /> },
  { key: 'margin', label: 'Lãi gộp', show: (_c, cross) => cross('accounting.read'), render: () => <MarginPanel /> },
  { key: 'retention', label: 'Quay lại & tái tiêm', show: (_c, cross) => cross('accounting.read') || cross('lead.read') || cross('customer.read'), render: () => <RetentionPanel /> },
  { key: 'ltv', label: 'Trọn đời', show: (_c, cross) => cross('accounting.read') || cross('lead.read'), render: () => <LtvPanel /> },
  { key: 'forecast', label: 'Chỉ tiêu & dự báo', show: (_c, cross) => cross('accounting.read'), render: () => <ForecastPanel /> },
  { key: 'export', label: 'Xuất kế toán', show: (can) => can('report.export') && can('accounting.read'), render: () => <AccountingExportPanel /> }
]

export default function Analytics(): React.JSX.Element {
  const { can, user } = useAuth()
  // Phạm vi "của tôi" (OWN) không xem được số liệu tổng hợp của người khác.
  const cross = (p: string): boolean => {
    const scope = (user?.permissions as Record<string, string> | undefined)?.[p]
    return Boolean(scope && scope !== 'OWN')
  }
  const tabs = TABS.filter((t) => t.show(can, cross))
  const [active, setActive] = useState(tabs[0]?.key ?? '')
  const tab = tabs.find((t) => t.key === active) ?? tabs[0]
  if (!tab) return <div className="card"><Empty>Vai trò của bạn chưa có báo cáo đo lường nào.</Empty></div>
  return (
    <>
      <div className="tabs" style={{ flexWrap: 'wrap' }}>
        {tabs.map((t) => (
          <button key={t.key} className={t.key === tab.key ? 'on' : ''} onClick={() => setActive(t.key)}>
            {t.label}
          </button>
        ))}
      </div>
      {tab.render()}
    </>
  )
}
