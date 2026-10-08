import React, { useEffect, useState } from 'react'
import { getApiErrorMessage } from '../lib/api'
import {
  currentPeriod,
  downloadFile,
  fetchForecast,
  fetchLtv,
  fetchMargin,
  fetchResponseBuckets,
  fetchRetention,
  fetchRetreatDue,
  saveTarget,
  type BucketRow,
  type ForecastData,
  type MarginRow,
  type RetentionRow,
  type RetreatDueRow
} from '../lib/api-lo5'
import { useAuth } from '../lib/auth-context'
import { dateVi, toISODate, vnd } from '../lib/format'
import { Empty, useToast } from './ui'
import { ProgressBar } from './lo5-sales-parts'

/* Lô 5 · Đợt 3: tốc độ trả lời (F31), lãi gộp (F22), quay lại (F23), trọn đời
 * (F32), chỉ tiêu và dự báo (F34), xuất Excel kế toán (F33). */

const pct = (n: number | null | undefined): string => (n == null ? '-' : `${n}%`)

const PERIODS = [
  { key: 'month', label: 'Tháng này' },
  { key: '7d', label: '7 ngày' },
  { key: 'quarter', label: 'Quý' }
]

function PeriodButtons({ value, onChange }: { value: string; onChange: (v: string) => void }): React.JSX.Element {
  return (
    <div className="row" style={{ gap: 6, marginLeft: 'auto' }}>
      {PERIODS.map((p) => (
        <button key={p.key} className={`btn sm ${value === p.key ? '' : 'sec'}`} onClick={() => onChange(p.key)}>
          {p.label}
        </button>
      ))}
    </div>
  )
}

export function ResponsePanel(): React.JSX.Element {
  const { fail } = useToast()
  const { branchId } = useAuth()
  const [period, setPeriod] = useState('month')
  const [rows, setRows] = useState<BucketRow[]>([])
  useEffect(() => {
    fetchResponseBuckets({ period })
      .then((d) => setRows(d.rows))
      .catch((e) => fail(getApiErrorMessage(e)))
  }, [period, branchId, fail])
  return (
    <div className="card">
      <div className="row" style={{ marginBottom: 8 }}>
        <div className="sec-title" style={{ margin: 0 }}>Tốc độ trả lời đầu tiên so với tỉ lệ chốt</div>
        <PeriodButtons value={period} onChange={setPeriod} />
      </div>
      <table>
        <thead>
          <tr><th>Nhóm phản hồi đầu tiên</th><th>Hội thoại</th><th>Phút trung bình</th><th>Tỉ lệ có SĐT</th><th>Tỉ lệ đến</th><th>Tỉ lệ chốt</th></tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.bucket}>
              <td><b>{r.label}</b></td>
              <td>{r.conversations}</td>
              <td>{r.avgMinutes ?? '-'}</td>
              <td>{pct(r.phoneRate)}</td>
              <td>{pct(r.showRate)}</td>
              <td>{pct(r.closeRate)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>Ngưỡng phút chỉnh ở Cài đặt nhóm Báo cáo. Chốt là hợp đồng ký không huỷ sau tin đầu tiên.</div>
    </div>
  )
}

export function MarginPanel(): React.JSX.Element {
  const { fail } = useToast()
  const { branchId } = useAuth()
  const [period, setPeriod] = useState('month')
  const [groupBy, setGroupBy] = useState('service')
  const [data, setData] = useState<{ rows: MarginRow[]; total: Omit<MarginRow, 'key' | 'label'> } | null>(null)
  useEffect(() => {
    fetchMargin({ period, groupBy })
      .then(setData)
      .catch((e) => fail(getApiErrorMessage(e)))
  }, [period, groupBy, branchId, fail])
  return (
    <div className="card">
      <div className="row" style={{ marginBottom: 8, gap: 8 }}>
        <div className="sec-title" style={{ margin: 0 }}>Lãi gộp</div>
        <select value={groupBy} onChange={(e) => setGroupBy(e.target.value)} style={{ width: 160 }}>
          <option value="service">Theo dịch vụ</option>
          <option value="doctor">Theo bác sĩ</option>
          <option value="branch">Theo cơ sở</option>
          <option value="month">Theo tháng</option>
        </select>
        <PeriodButtons value={period} onChange={setPeriod} />
      </div>
      {!data || data.rows.length === 0 ? (
        <Empty>Chưa có lần thực hiện hoàn tất trong kỳ.</Empty>
      ) : (
        <table>
          <thead>
            <tr><th>Nhóm</th><th>Lần làm</th><th>Doanh thu</th><th>Giá vốn vật tư</th><th>Hoa hồng</th><th>Lãi gộp</th><th>Tỉ lệ</th></tr>
          </thead>
          <tbody>
            {[...data.rows, { ...data.total, key: '_t', label: 'Tổng' }].map((r) => (
              <tr key={r.key} style={r.key === '_t' ? { fontWeight: 600 } : undefined}>
                <td>{r.label}</td>
                <td>{r.count}</td>
                <td>{vnd(r.revenue)}</td>
                <td>{vnd(r.cost)}</td>
                <td>{vnd(r.commission)}</td>
                <td>{vnd(r.grossMargin)}</td>
                <td>{pct(r.marginPercent)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
        Doanh thu ghi nhận theo lần làm (giá trị dòng hợp đồng chia số lần). Giá vốn lấy giá vốn lúc dùng vật tư, kể cả lượng lẻ 0,1 ống.
      </div>
    </div>
  )
}

export function RetentionPanel(): React.JSX.Element {
  const { fail } = useToast()
  const { branchId } = useAuth()
  const [rows, setRows] = useState<RetentionRow[]>([])
  const [due, setDue] = useState<RetreatDueRow[]>([])
  useEffect(() => {
    fetchRetention()
      .then((d) => setRows(d.rows))
      .catch((e) => fail(getApiErrorMessage(e)))
    fetchRetreatDue()
      .then((d) => setDue(d.rows))
      .catch(() => undefined)
  }, [branchId, fail])
  const cell = (c: { eligible: number; returned: number; rate: number | null }) =>
    c.eligible ? `${pct(c.rate)} (${c.returned}/${c.eligible})` : 'chưa đủ ngày'
  return (
    <>
      <div className="card">
        <div className="sec-title">Tỉ lệ quay lại theo tháng làm lần đầu</div>
        {rows.length === 0 ? (
          <Empty>Chưa có lần thực hiện hoàn tất.</Empty>
        ) : (
          <table>
            <thead>
              <tr><th>Dịch vụ</th><th>Tháng làm lần đầu</th><th>Số khách</th><th>Sau 90 ngày</th><th>Sau 180 ngày</th><th>Sau 365 ngày</th></tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={`${r.serviceId}${r.cohort}`}>
                  <td>{r.serviceName}</td>
                  <td>{r.cohort}</td>
                  <td>{r.customers}</td>
                  <td>{cell(r.d90)}</td>
                  <td>{cell(r.d180)}</td>
                  <td>{cell(r.d365)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div className="card" style={{ marginTop: 12 }}>
        <div className="sec-title">Khách đến hạn tái tiêm</div>
        {due.length === 0 ? (
          <Empty>Không có khách đến hạn.</Empty>
        ) : (
          <table>
            <thead>
              <tr><th>Khách</th><th>SĐT</th><th>Dịch vụ</th><th>Làm lần cuối</th><th>Hạn tái tiêm</th><th>Sale</th></tr>
            </thead>
            <tbody>
              {due.map((r) => (
                <tr key={r.procedureId}>
                  <td>{r.customer.name} <span className="muted">{r.customer.code}</span></td>
                  <td>{r.customer.phone ?? '-'}</td>
                  <td>{r.serviceName}</td>
                  <td>{dateVi(r.lastDoneAt)}</td>
                  <td style={r.overdueDays > 0 ? { color: 'var(--danger)' } : undefined}>
                    {dateVi(r.retreatDueAt)}{r.overdueDays > 0 ? ` (quá ${r.overdueDays} ngày)` : ''}
                  </td>
                  <td>{r.customer.assignedTo?.name ?? '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  )
}

export function LtvPanel(): React.JSX.Element {
  const { fail } = useToast()
  const { branchId } = useAuth()
  const [period, setPeriod] = useState('month')
  const [groupBy, setGroupBy] = useState('channel')
  const [data, setData] = useState<Awaited<ReturnType<typeof fetchLtv>> | null>(null)
  useEffect(() => {
    fetchLtv({ period, groupBy })
      .then(setData)
      .catch((e) => fail(getApiErrorMessage(e)))
  }, [period, groupBy, branchId, fail])
  return (
    <div className="card">
      <div className="row" style={{ marginBottom: 8, gap: 8 }}>
        <div className="sec-title" style={{ margin: 0 }}>Doanh thu khách mới, khách quay lại và trọn đời</div>
        <PeriodButtons value={period} onChange={setPeriod} />
      </div>
      {data ? (
        <>
          <div className="grid" style={{ gridTemplateColumns: 'repeat(2, 1fr)', marginBottom: 12 }}>
            <div className="kpi">
              <div className="lab">Khách mới (mua lần đầu trong kỳ)</div>
              <div className="val">{vnd(data.split.newRevenue)}</div>
              <div className="dt">{data.split.newCustomers} khách</div>
            </div>
            <div className="kpi">
              <div className="lab">Khách quay lại</div>
              <div className="val">{vnd(data.split.returningRevenue)}</div>
              <div className="dt">{data.split.returningCustomers} khách</div>
            </div>
          </div>
          <div className="row" style={{ marginBottom: 8 }}>
            <b>Giá trị trọn đời</b>
            <select value={groupBy} onChange={(e) => setGroupBy(e.target.value)} style={{ marginLeft: 'auto', width: 200 }}>
              <option value="channel">Theo kênh</option>
              <option value="campaign">Theo chiến dịch</option>
              <option value="month">Theo tháng mua đầu</option>
            </select>
          </div>
          <table>
            <thead>
              <tr><th>Nhóm</th><th>Số khách</th><th>Tổng đã thu</th><th>LTV trung bình</th></tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.key}>
                  <td>{r.label}</td>
                  <td>{r.customers}</td>
                  <td>{vnd(r.revenue)}</td>
                  <td><b>{vnd(r.ltv)}</b></td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : null}
    </div>
  )
}

export function ForecastPanel(): React.JSX.Element {
  const { say, fail } = useToast()
  const { can, branchId } = useAuth()
  const [period, setPeriod] = useState(currentPeriod())
  const [data, setData] = useState<ForecastData | null>(null)
  const [target, setTarget] = useState('')
  const [svcTarget, setSvcTarget] = useState<Record<string, string>>({})
  const canSet = can('finance.approve')

  const load = (): void => {
    fetchForecast(period)
      .then(setData)
      .catch((e) => fail(getApiErrorMessage(e)))
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [period, branchId])

  const saveBranch = async (id: string): Promise<void> => {
    try {
      await saveTarget({ periodKey: period, branchId: id, targetRevenue: Math.round(Number(target)) })
      say('Đã lưu chỉ tiêu cơ sở.')
      setTarget('')
      load()
    } catch (e) {
      fail(getApiErrorMessage(e))
    }
  }
  const saveService = async (serviceId: string): Promise<void> => {
    try {
      await saveTarget({ periodKey: period, branchId: null, serviceId, targetRevenue: Math.round(Number(svcTarget[serviceId] ?? 0)) })
      say('Đã lưu chỉ tiêu dịch vụ.')
      load()
    } catch (e) {
      fail(getApiErrorMessage(e))
    }
  }

  return (
    <div className="card">
      <div className="row" style={{ marginBottom: 8 }}>
        <div className="sec-title" style={{ margin: 0 }}>Chỉ tiêu và dự báo cuối tháng</div>
        <input type="month" value={period} onChange={(e) => setPeriod(e.target.value)} style={{ marginLeft: 'auto', width: 160 }} />
      </div>
      {data ? (
        <>
          <div className="grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)', marginBottom: 12 }}>
            <div className="kpi"><div className="lab">Đã thu ({data.elapsedDays}/{data.daysInMonth} ngày)</div><div className="val">{vnd(data.actual)}</div></div>
            <div className="kpi"><div className="lab">Dự báo cuối tháng</div><div className="val">{vnd(data.forecast)}</div><div className="dt">nhịp {vnd(data.runRateForecast)} + lịch hẹn {vnd(data.bookedValue)}</div></div>
            <div className="kpi"><div className="lab">Cùng {data.elapsedDays} ngày tháng trước</div><div className="val">{vnd(data.prevSameDays)}</div><div className="dt">{data.vsPrevPercent == null ? '' : `${data.vsPrevPercent > 0 ? '+' : ''}${data.vsPrevPercent}%`}</div></div>
            <div className="kpi"><div className="lab">Chỉ tiêu</div><div className="val">{data.target ? vnd(data.target) : 'Chưa đặt'}</div><div className="dt">{data.progressPercent == null ? '' : `đạt ${data.progressPercent}%, dự báo ${data.forecastVsTargetPercent}%`}</div></div>
          </div>
          {data.progressPercent != null ? <ProgressBar percent={data.progressPercent} /> : null}
          <div className="sec-title">Theo cơ sở</div>
          <table>
            <thead><tr><th>Cơ sở</th><th>Chỉ tiêu</th><th>Đã thu</th><th>Tiến độ</th>{canSet ? <th /> : null}</tr></thead>
            <tbody>
              {data.byBranch.map((b) => (
                <tr key={b.branchId}>
                  <td>{b.name}</td>
                  <td>{b.target == null ? '-' : vnd(b.target)}</td>
                  <td>{vnd(b.actual)}</td>
                  <td>{pct(b.progressPercent)}</td>
                  {canSet ? (
                    <td className="row" style={{ gap: 6 }}>
                      <input placeholder="Chỉ tiêu mới (đồng)" value={target} onChange={(e) => setTarget(e.target.value.replace(/\D/g, ''))} style={{ width: 170 }} />
                      <button className="btn sm" disabled={!target} onClick={() => void saveBranch(b.branchId)}>Lưu</button>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
          <div className="sec-title">Theo dịch vụ</div>
          {data.byService.length === 0 ? (
            <Empty>Chưa có doanh thu gắn dịch vụ trong tháng.</Empty>
          ) : (
            <table>
              <thead><tr><th>Dịch vụ</th><th>Chỉ tiêu</th><th>Đã thu</th><th>Tiến độ</th>{canSet ? <th /> : null}</tr></thead>
              <tbody>
                {data.byService.map((s) => (
                  <tr key={s.serviceId}>
                    <td>{s.name}</td>
                    <td>{s.target == null ? '-' : vnd(s.target)}</td>
                    <td>{vnd(s.actual)}</td>
                    <td>{pct(s.progressPercent)}</td>
                    {canSet ? (
                      <td className="row" style={{ gap: 6 }}>
                        <input value={svcTarget[s.serviceId] ?? ''} placeholder="Chỉ tiêu (đồng)" onChange={(e) => setSvcTarget({ ...svcTarget, [s.serviceId]: e.target.value.replace(/\D/g, '') })} style={{ width: 150 }} />
                        <button className="btn sm sec" disabled={!svcTarget[s.serviceId]} onClick={() => void saveService(s.serviceId)}>Lưu</button>
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
            Dự báo = đã thu chia số ngày đã qua nhân số ngày của tháng, cộng giá niêm yết của lịch đã hẹn từ nay tới cuối tháng (trừ cọc đã nhận).
            {data.unassignedRevenue ? ` Có ${vnd(data.unassignedRevenue)} tiền thu chưa gắn dịch vụ (cọc, thu lẻ).` : ''}
          </div>
        </>
      ) : null}
    </div>
  )
}

export function AccountingExportPanel(): React.JSX.Element {
  const { say, fail } = useToast()
  const today = new Date()
  const [from, setFrom] = useState(toISODate(new Date(today.getFullYear(), today.getMonth(), 1)))
  const [to, setTo] = useState(toISODate(today))
  const [busy, setBusy] = useState(false)
  const run = async (): Promise<void> => {
    setBusy(true)
    try {
      await downloadFile('/analytics/accounting-export', { from, to }, `ke-toan_${from}_${to}.xlsx`)
      say('Đã tải tệp Excel.')
    } catch (e) {
      fail(getApiErrorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="card">
      <div className="sec-title">Xuất Excel cho kế toán</div>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <label>Từ ngày <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label>Đến ngày <input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        <button className="btn" disabled={busy} onClick={() => void run()}>{busy ? 'Đang xuất...' : 'Tải tệp xlsx'}</button>
      </div>
      <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
        Trang Phiếu thu: mã phiếu, ngày giờ Việt Nam, khách, cơ sở, dịch vụ, người thu, phương thức, số tiền, số hoá đơn Misa. Trang Sổ doanh thu chia tiền theo dòng dịch vụ. Không giới hạn số dòng; mỗi lần xuất ghi nhật ký truy cập.
      </div>
    </div>
  )
}
