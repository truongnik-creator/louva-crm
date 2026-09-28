import React, { useCallback, useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'
import {
  exportDataset,
  fetchClinicOperations,
  fetchMarketingFunnel,
  fetchRevenueReport,
  fetchStaffPerformance,
  getApiErrorMessage
} from '../lib/api'
import { useAuth } from '../lib/auth-context'
import { ddmm, percent, vnd } from '../lib/format'
import { Empty, useToast } from '../components/ui'
import type { MarketingFunnelRow, StaffPerformanceRow } from '../lib/types'

/* Ba màn báo cáo dùng chung một khung, phân biệt bằng đường dẫn:
   /bao-cao/doanh-thu · /bao-cao/van-hanh · /bao-cao/marketing
   và màn Xuất dữ liệu (/xuat-du-lieu) có hạn mức + ghi nhật ký truy cập. */

const PERIODS = [
  { key: 'today', label: 'Hôm nay' },
  { key: '7d', label: '7 ngày' },
  { key: 'month', label: 'Tháng này' },
  { key: 'quarter', label: 'Quý' }
]

export default function Reports(): React.JSX.Element {
  const location = useLocation()
  const [period, setPeriod] = useState('month')

  const kind = location.pathname.includes('marketing')
    ? 'marketing'
    : location.pathname.includes('van-hanh')
      ? 'operations'
      : location.pathname.includes('xuat-du-lieu')
        ? 'export'
        : location.pathname.includes('kpi-tu-van')
          ? 'staff'
          : 'revenue'

  return (
    <>
      {kind !== 'export' ? (
        <div className="row" style={{ flexWrap: 'wrap', marginBottom: 12 }}>
          {PERIODS.map((p) => (
            <button
              key={p.key}
              className={`btn ${period === p.key ? '' : 'sec'} sm`}
              onClick={() => setPeriod(p.key)}
            >
              {p.label}
            </button>
          ))}
        </div>
      ) : null}

      {kind === 'staff' ? <StaffKpiReport period={period} /> : null}
      {kind === 'revenue' ? <RevenueReport period={period} /> : null}
      {kind === 'operations' ? <OperationsReport period={period} /> : null}
      {kind === 'marketing' ? <MarketingReport period={period} /> : null}
      {kind === 'export' ? <ExportPanel /> : null}
    </>
  )
}

/**
 * KPI TƯ VẤN VIÊN — tách khỏi báo cáo doanh thu vì người xem khác nhau:
 * báo cáo doanh thu để chủ đầu tư nhìn tiền, màn này để quản lý kinh doanh
 * nhìn NGƯỜI. Xếp theo TIỀN THỰC THU chứ không phải doanh số ký, đúng nguyên
 * tắc "hoa hồng tính trên tiền đã vào tài khoản".
 */
function StaffKpiReport({ period }: { period: string }): React.JSX.Element {
  const { fail } = useToast()
  const { branchId } = useAuth()
  const [rows, setRows] = useState<StaffPerformanceRow[] | null>(null)

  useEffect(() => {
    fetchStaffPerformance({ period })
      .then(setRows)
      .catch((err) => fail(getApiErrorMessage(err)))
  }, [period, fail, branchId])

  if (!rows) return <div className="card"><Empty>Đang tải…</Empty></div>

  // Chỉ giữ vai trò bán hàng; bác sĩ và điều dưỡng có KPI riêng, không gắn tiền.
  const sales = rows.filter((r) =>
    r.roles.some((x) => ['TU_VAN_VIEN', 'TELESALE', 'QUAN_LY_CO_SO', 'LE_TAN'].includes(x))
  )
  const best = Math.max(1, ...sales.map((s) => s.collected))
  const totalCollected = sales.reduce((s, r) => s + r.collected, 0)
  const totalWon = sales.reduce((s, r) => s + r.contractsWon, 0)

  return (
    <>
      <div className="grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)', marginBottom: 12 }}>
        <div className="kpi">
          <div className="lab">Người có doanh số</div>
          <div className="val">{sales.filter((s) => s.collected > 0).length}</div>
        </div>
        <div className="kpi">
          <div className="lab">Tổng tiền thực thu</div>
          <div className="val">{vnd(totalCollected)}</div>
        </div>
        <div className="kpi">
          <div className="lab">Hợp đồng chốt</div>
          <div className="val">{totalWon}</div>
        </div>
        <div className="kpi">
          <div className="lab">Thực thu bình quân / người</div>
          <div className="val">{sales.length ? vnd(Math.round(totalCollected / sales.length)) : '—'}</div>
        </div>
      </div>

      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <div className="sec-title" style={{ padding: '12px 14px 0' }}>
          Xếp hạng theo tiền thực thu
        </div>
        {sales.length === 0 ? (
          <Empty>Chưa có dữ liệu trong kỳ.</Empty>
        ) : (
          <table>
            <thead>
              <tr>
                <th style={{ width: 40 }}>#</th>
                <th>Nhân viên</th>
                <th>Khách được giao</th>
                <th>Chốt</th>
                <th>Tỉ lệ chốt</th>
                <th>Doanh số ký</th>
                <th>Tiền thực thu</th>
                <th style={{ width: 180 }}>So với người dẫn đầu</th>
              </tr>
            </thead>
            <tbody>
              {sales.map((r, i) => (
                <tr key={r.userId}>
                  <td className="muted">{i + 1}</td>
                  <td>
                    <b>{r.name}</b>
                    <div className="muted" style={{ fontSize: 11.5 }}>
                      {r.messagesSent} tin nhắn đã gửi
                    </div>
                  </td>
                  <td>{r.customersAssigned}</td>
                  <td>{r.contractsWon}</td>
                  <td>{percent(r.closeRate)}</td>
                  <td className="muted">{vnd(r.signed)}</td>
                  <td>
                    <b>{vnd(r.collected)}</b>
                  </td>
                  <td>
                    <div className="bar">
                      <i style={{ width: `${Math.round((r.collected / best) * 100)}%` }} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="muted" style={{ fontSize: 12, marginTop: 9 }}>
        Xếp hạng theo TIỀN THỰC THU, không phải doanh số ký — hợp đồng ký rồi không thu được tiền thì
        không tính là thành tích. Bác sĩ và điều dưỡng không xuất hiện ở đây vì KPI chuyên môn cố ý tách
        khỏi doanh số.
      </div>
    </>
  )
}

function RevenueReport({ period }: { period: string }): React.JSX.Element {
  const { fail } = useToast()
  const { branchId } = useAuth()
  const [byService, setByService] = useState<Array<{ key: string; revenue: number; count: number }>>([])
  const [byConsultant, setByConsultant] = useState<
    Array<{ key: string; revenue: number; collected?: number; count: number }>
  >([])
  const [staff, setStaff] = useState<StaffPerformanceRow[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [svc, cons, perf] = await Promise.all([
        fetchRevenueReport({ period, groupBy: 'service' }),
        fetchRevenueReport({ period, groupBy: 'consultant' }),
        fetchStaffPerformance({ period }).catch(() => [])
      ])
      setByService(svc)
      setByConsultant(cons)
      setStaff(perf)
    } catch (err) {
      fail(getApiErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }, [period, fail])

  useEffect(() => {
    void load()
  }, [load, branchId])

  if (loading) return <div className="card"><Empty>Đang tải báo cáo…</Empty></div>

  const totalRevenue = byService.reduce((s, r) => s + r.revenue, 0)

  return (
    <>
      <div className="grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)', marginBottom: 12 }}>
        <div className="kpi">
          <div className="lab">Tổng doanh thu ký</div>
          <div className="val">{vnd(totalRevenue)}</div>
        </div>
        <div className="kpi">
          <div className="lab">Tiền thực thu</div>
          <div className="val">{vnd(byConsultant.reduce((s, r) => s + (r.collected ?? 0), 0))}</div>
        </div>
        <div className="kpi">
          <div className="lab">Số ca dịch vụ</div>
          <div className="val">{byService.reduce((s, r) => s + r.count, 0)}</div>
        </div>
      </div>

      <div className="card" style={{ padding: 0, overflow: 'hidden', marginBottom: 12 }}>
        <div className="sec-title" style={{ padding: '12px 14px 0' }}>
          Doanh thu theo dịch vụ
        </div>
        {byService.length === 0 ? (
          <Empty>Chưa có hợp đồng nào trong kỳ.</Empty>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Dịch vụ</th>
                <th>Số ca</th>
                <th>Doanh thu</th>
                <th style={{ width: 220 }}>Tỉ trọng</th>
              </tr>
            </thead>
            <tbody>
              {byService.map((r) => (
                <tr key={r.key}>
                  <td>{r.key}</td>
                  <td>{r.count}</td>
                  <td>
                    <b>{vnd(r.revenue)}</b>
                  </td>
                  <td>
                    <div className="bar">
                      <i style={{ width: `${totalRevenue ? (r.revenue / totalRevenue) * 100 : 0}%` }} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <div className="sec-title" style={{ padding: '12px 14px 0' }}>
          Hiệu suất nhân viên
        </div>
        {staff.length === 0 ? (
          <Empty>Chưa có dữ liệu hiệu suất trong kỳ.</Empty>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Nhân viên</th>
                <th>Khách được giao</th>
                <th>Hợp đồng chốt</th>
                <th>Tỉ lệ chốt</th>
                <th>Doanh số ký</th>
                <th>Tiền thực thu</th>
                <th>Tin nhắn gửi</th>
              </tr>
            </thead>
            <tbody>
              {staff.map((s) => (
                <tr key={s.userId}>
                  <td>
                    <b>{s.name}</b>
                  </td>
                  <td>{s.customersAssigned}</td>
                  <td>{s.contractsWon}</td>
                  <td>{percent(s.closeRate)}</td>
                  <td>{vnd(s.signed)}</td>
                  <td>
                    <b>{vnd(s.collected)}</b>
                  </td>
                  <td className="muted">{s.messagesSent}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  )
}

function OperationsReport({ period }: { period: string }): React.JSX.Element {
  const { fail } = useToast()
  const [data, setData] = useState<Awaited<ReturnType<typeof fetchClinicOperations>> | null>(null)

  useEffect(() => {
    fetchClinicOperations({ period })
      .then(setData)
      .catch((err) => fail(getApiErrorMessage(err)))
  }, [period, fail])

  if (!data) return <div className="card"><Empty>Đang tải…</Empty></div>

  return (
    <>
      <div className="grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)', marginBottom: 12 }}>
        <div className="kpi">
          <div className="lab">Tổng lịch hẹn</div>
          <div className="val">{data.appointments.total}</div>
        </div>
        <div className="kpi">
          <div className="lab">Vắng mặt</div>
          <div className="val" style={{ color: data.appointments.noShow ? 'var(--danger)' : undefined }}>
            {data.appointments.noShow}
          </div>
          <div className="dt muted">{percent(data.appointments.noShowRate)} tổng lịch</div>
        </div>
        <div className="kpi">
          <div className="lab">Lượt check-in</div>
          <div className="val">{data.queue.visits}</div>
        </div>
        <div className="kpi">
          <div className="lab">Thời gian chờ trung bình</div>
          <div className="val">{data.queue.avgWaitMinutes} phút</div>
        </div>
      </div>

      <div className="card">
        <div className="sec-title">Công suất phòng mổ theo ngày</div>
        {data.surgeryCapacity.length === 0 ? (
          <Empty>Chưa có ca mổ nào trong kỳ.</Empty>
        ) : (
          data.surgeryCapacity.map((c) => (
            <div className="row" style={{ marginBottom: 7 }} key={c.date}>
              <span style={{ width: 60, fontSize: 12 }}>{ddmm(c.date)}</span>
              <div className="bar" style={{ flex: 1 }}>
                <i style={{ width: `${c.utilization}%` }} />
              </div>
              <b style={{ width: 90, textAlign: 'right', fontSize: 12.5 }}>
                {c.utilization}% · {Math.round((c.minutes / 60) * 10) / 10}h
              </b>
            </div>
          ))
        )}
        <div className="muted" style={{ fontSize: 11.5, marginTop: 8 }}>
          Mốc 100% = 8 giờ mổ mỗi ngày cho mỗi phòng.
        </div>
      </div>
    </>
  )
}

function MarketingReport({ period }: { period: string }): React.JSX.Element {
  const { fail } = useToast()
  const [rows, setRows] = useState<MarketingFunnelRow[] | null>(null)

  useEffect(() => {
    fetchMarketingFunnel({ period })
      .then(setRows)
      .catch((err) => fail(getApiErrorMessage(err)))
  }, [period, fail])

  if (!rows) return <div className="card"><Empty>Đang tải…</Empty></div>

  const totalSpent = rows.reduce((s, r) => s + r.spent, 0)
  const totalRevenue = rows.reduce((s, r) => s + r.revenue, 0)
  const totalLeads = rows.reduce((s, r) => s + r.leads, 0)

  return (
    <>
      <div className="grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)', marginBottom: 12 }}>
        <div className="kpi">
          <div className="lab">Tổng lead</div>
          <div className="val">{totalLeads}</div>
        </div>
        <div className="kpi">
          <div className="lab">Chi phí quảng cáo</div>
          <div className="val">{vnd(totalSpent)}</div>
        </div>
        <div className="kpi">
          <div className="lab">CPL trung bình</div>
          <div className="val">{totalLeads ? vnd(Math.round(totalSpent / totalLeads)) : '—'}</div>
        </div>
        <div className="kpi">
          <div className="lab">ROAS tổng</div>
          <div className="val">
            {totalSpent ? `${(totalRevenue / totalSpent).toFixed(1).replace('.', ',')}x` : '—'}
          </div>
        </div>
      </div>

      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <div className="sec-title" style={{ padding: '12px 14px 0' }}>
          Phễu theo chiến dịch
        </div>
        {rows.length === 0 ? (
          <Empty>Chưa có chiến dịch nào có dữ liệu trong kỳ.</Empty>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Chiến dịch</th>
                <th>Kênh</th>
                <th>Lead</th>
                <th>Thành khách</th>
                <th>Tỉ lệ chuyển</th>
                <th>Chi phí</th>
                <th>CPL</th>
                <th>Doanh thu</th>
                <th>ROAS</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.campaignId}>
                  <td>
                    <b>{r.name}</b>
                    <div className="muted" style={{ fontSize: 11.5 }}>
                      {r.code}
                    </div>
                  </td>
                  <td>
                    <span className="tag out">{r.channel}</span>
                  </td>
                  <td>{r.leads}</td>
                  <td>{r.won}</td>
                  <td>{percent(r.conversionRate)}</td>
                  <td>{vnd(r.spent)}</td>
                  <td>{r.cpl ? vnd(r.cpl) : '—'}</td>
                  <td>
                    <b>{vnd(r.revenue)}</b>
                  </td>
                  <td>
                    {r.roas != null ? (
                      <span className={r.roas >= 3 ? 'up' : 'down'}>
                        {r.roas.toFixed(1).replace('.', ',')}x
                      </span>
                    ) : (
                      '—'
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  )
}

function ExportPanel(): React.JSX.Element {
  const { say, fail } = useToast()
  const [dataset, setDataset] = useState('customers')
  const [result, setResult] = useState<{ rowCount: number; rows: Record<string, unknown>[] } | null>(null)
  const [busy, setBusy] = useState(false)

  const run = async (): Promise<void> => {
    setBusy(true)
    try {
      const data = await exportDataset({ dataset })
      setResult(data)
      say(`Đã lấy ${data.rowCount} dòng. Lần xuất này đã được ghi vào nhật ký truy cập.`)
    } catch (err) {
      fail(getApiErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const downloadCsv = (): void => {
    if (!result?.rows.length) return
    const headers = Object.keys(result.rows[0])
    const csv = [
      headers.join(','),
      ...result.rows.map((r) =>
        headers.map((h) => `"${String(r[h] ?? '').replace(/"/g, '""')}"`).join(',')
      )
    ].join('\n')
    // BOM để Excel trên Windows đọc đúng tiếng Việt.
    const blob = new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${dataset}-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <>
      <div className="alert wr">
        Xuất dữ liệu ra ngoài là đường rò rỉ dữ liệu khách lớn nhất. Mỗi lần xuất đều bị giới hạn số dòng
        và được ghi vào nhật ký truy cập kèm tên người xuất.
      </div>

      <div className="card" style={{ marginBottom: 12 }}>
        <div className="field">
          <label>Chọn bộ dữ liệu</label>
          <select className="input" value={dataset} onChange={(e) => setDataset(e.target.value)}>
            <option value="customers">Khách hàng</option>
            <option value="contracts">Hợp đồng</option>
            <option value="payments">Phiếu thu</option>
            <option value="invoices">Hoá đơn / công nợ</option>
          </select>
        </div>
        <div className="row">
          <button className="btn" onClick={() => void run()} disabled={busy}>
            {busy ? 'Đang lấy dữ liệu…' : 'Lấy dữ liệu'}
          </button>
          {result?.rows.length ? (
            <button className="btn sec" onClick={downloadCsv}>
              Tải CSV ({result.rowCount} dòng)
            </button>
          ) : null}
        </div>
      </div>

      {result ? (
        <div className="card" style={{ padding: 0, overflow: 'auto' }}>
          {result.rows.length === 0 ? (
            <Empty>Không có dòng nào.</Empty>
          ) : (
            <table>
              <thead>
                <tr>
                  {Object.keys(result.rows[0]).map((h) => (
                    <th key={h}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {result.rows.slice(0, 100).map((r, i) => (
                  <tr key={i}>
                    {Object.keys(result.rows[0]).map((h) => (
                      <td key={h}>{String(r[h] ?? '—')}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ) : null}
    </>
  )
}
