import React, { useCallback, useEffect, useState } from 'react'
import { fetchCampaigns, getApiErrorMessage } from '../lib/api'
import {
  fetchAdCosts,
  fetchEod,
  fetchLeaderboard,
  fetchWeekly,
  importAdCostCsv,
  saveAdCost,
  currentPeriod,
  type AdCostRow,
  type EodRow,
  type FunnelMetrics,
  type WeeklyRow
} from '../lib/api-lo5'
import { useAuth } from '../lib/auth-context'
import { toISODate, vnd } from '../lib/format'
import { Empty, useToast } from './ui'

/* Lô 5 · Đợt 3: chỉ số tuần Sales và MKT (F15), nhập chi phí quảng cáo, họp
 * cuối ngày (F16), bảng thi đua (F18). */

const money = (n: number | null | undefined): string => (n == null ? '-' : vnd(n))

export function HeadWith({ first }: { first: string[] }): React.JSX.Element {
  return (
    <tr>
      {first.map((f) => (
        <th key={f}>{f}</th>
      ))}
      <th>Chi phí</th>
      <th>Tin mới</th>
      <th>Có SĐT</th>
      <th>Chi phí/SĐT</th>
      <th>Lịch có cọc</th>
      <th>Chi phí/lịch cọc</th>
      <th>Khách đến</th>
      <th>Chi phí/khách đến</th>
      <th>Doanh thu</th>
      <th>ROAS</th>
    </tr>
  )
}

export function MetricsCells({ m }: { m: FunnelMetrics }): React.JSX.Element {
  return (
    <>
      <td>{money(m.cost)}</td>
      <td>{m.newMessages}</td>
      <td>{m.phones}</td>
      <td>{money(m.costPerPhone)}</td>
      <td>{m.depositBookings}</td>
      <td>{money(m.costPerDeposit)}</td>
      <td>{m.showups}</td>
      <td>{money(m.costPerShowup)}</td>
      <td>{money(m.revenue)}</td>
      <td>{m.roas == null ? '-' : m.roas}</td>
    </>
  )
}

export function WeeklyPanel(): React.JSX.Element {
  const { fail } = useToast()
  const { branchId } = useAuth()
  const [weeks, setWeeks] = useState(4)
  const [data, setData] = useState<WeeklyRow[]>([])
  const [open, setOpen] = useState<string | null>(null)

  useEffect(() => {
    fetchWeekly({ weeks })
      .then((d) => {
        setData(d.weeks)
        setOpen(d.weeks[d.weeks.length - 1]?.weekKey ?? null)
      })
      .catch((e) => fail(getApiErrorMessage(e)))
  }, [weeks, branchId, fail])

  const current = data.find((w) => w.weekKey === open)
  return (
    <div className="card">
      <div className="row" style={{ marginBottom: 8 }}>
        <div className="sec-title" style={{ margin: 0 }}>Chỉ số tuần Sales và Marketing</div>
        <select style={{ marginLeft: 'auto', width: 140 }} value={weeks} onChange={(e) => setWeeks(Number(e.target.value))}>
          {[4, 8, 12].map((n) => (
            <option key={n} value={n}>{n} tuần gần nhất</option>
          ))}
        </select>
      </div>
      <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
        Khách đến là khách đến lần đầu. Doanh thu là tiền đã thu trong tuần, không gồm voucher. Quảng cáo là khách có chiến dịch hoặc mã quảng cáo.
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table>
          <thead>
            <HeadWith first={['Tuần', 'Nguồn']} />
          </thead>
          <tbody>
            {data.map((w) => (
              <React.Fragment key={w.weekKey}>
                {(['total', 'ads', 'organic'] as const).map((k) => (
                  <tr
                    key={k}
                    style={{ cursor: 'pointer', fontWeight: k === 'total' ? 600 : 400, background: open === w.weekKey && k === 'total' ? 'var(--bg2, #f3f6f4)' : undefined }}
                    onClick={() => setOpen(w.weekKey)}
                  >
                    <td>{k === 'total' ? w.weekKey : ''}</td>
                    <td>{k === 'total' ? 'Tổng' : k === 'ads' ? 'Quảng cáo' : 'Tự nhiên'}</td>
                    <MetricsCells m={w[k]} />
                  </tr>
                ))}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      </div>
      {current ? (
        <>
          <div className="sec-title">Tuần {current.weekKey} theo chiến dịch</div>
          {current.byCampaign.length === 0 ? (
            <Empty>Tuần này chưa có số liệu chiến dịch.</Empty>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table>
                <thead>
                  <HeadWith first={['Chiến dịch', 'Kênh']} />
                </thead>
                <tbody>
                  {current.byCampaign.map((c) => (
                    <tr key={c.campaignId}>
                      <td>{c.name}</td>
                      <td>{c.channel}</td>
                      <MetricsCells m={c} />
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="sec-title">Tuần {current.weekKey} theo kênh</div>
          <div style={{ overflowX: 'auto' }}>
            <table>
              <thead>
                <HeadWith first={['Kênh']} />
              </thead>
              <tbody>
                {current.byChannel.map((c) => (
                  <tr key={c.channelId ?? 'none'}>
                    <td>{c.name}</td>
                    <MetricsCells m={c} />
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </div>
  )
}

export function AdCostPanel(): React.JSX.Element {
  const { say, fail } = useToast()
  const { can } = useAuth()
  const [rows, setRows] = useState<AdCostRow[]>([])
  const [campaigns, setCampaigns] = useState<Array<{ id: string; name: string }>>([])
  const [form, setForm] = useState({ campaignId: '', date: toISODate(new Date()), amount: '' })
  const [platform, setPlatform] = useState<'AUTO' | 'META' | 'TIKTOK'>('AUTO')
  const [createMissing, setCreateMissing] = useState(true)
  const [report, setReport] = useState<string | null>(null)
  const canEdit = can('lead.update')

  const load = useCallback(() => {
    fetchAdCosts()
      .then(setRows)
      .catch((e) => fail(getApiErrorMessage(e)))
  }, [fail])

  useEffect(() => {
    load()
    fetchCampaigns()
      .then((c) => setCampaigns(c.map((x) => ({ id: x.id, name: x.name }))))
      .catch(() => undefined)
  }, [load])

  const save = async (): Promise<void> => {
    try {
      await saveAdCost({ campaignId: form.campaignId, date: form.date, amount: Math.round(Number(form.amount)) })
      say('Đã lưu chi phí ngày.')
      setForm({ ...form, amount: '' })
      load()
    } catch (e) {
      fail(getApiErrorMessage(e))
    }
  }

  const onFile = async (file: File | undefined): Promise<void> => {
    if (!file) return
    try {
      const content = await file.text()
      const r = await importAdCostCsv({ content, platform, createMissing, fileName: file.name })
      setReport(
        `Tệp ${r.platform}: nhập ${r.imported} dòng chiến dịch theo ngày.` +
          (r.createdCampaigns.length ? ` Tạo mới ${r.createdCampaigns.length} chiến dịch.` : '') +
          (r.unknownCampaigns.length ? ` Chưa khớp chiến dịch: ${r.unknownCampaigns.join(', ')}.` : '') +
          (r.errors.length ? ` Lỗi: ${r.errors.slice(0, 5).map((x) => `dòng ${x.line} ${x.message}`).join('; ')}.` : '')
      )
      load()
    } catch (e) {
      fail(getApiErrorMessage(e))
    }
  }

  return (
    <div className="card">
      <div className="sec-title">Chi phí quảng cáo theo ngày</div>
      {canEdit ? (
        <>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
            <select value={form.campaignId} onChange={(e) => setForm({ ...form, campaignId: e.target.value })} style={{ minWidth: 220 }}>
              <option value="">Chọn chiến dịch</option>
              {campaigns.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
            <input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} style={{ width: 160 }} />
            <input placeholder="Số tiền (đồng)" inputMode="numeric" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value.replace(/\D/g, '') })} style={{ width: 160 }} />
            <button className="btn sm" disabled={!form.campaignId || !form.amount} onClick={() => void save()}>Lưu chi phí</button>
          </div>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
            <span className="muted" style={{ fontSize: 12.5 }}>Nhập tệp CSV xuất từ Meta, TikTok (cột tên chiến dịch, ngày, số tiền đã chi):</span>
            <select value={platform} onChange={(e) => setPlatform(e.target.value as 'AUTO' | 'META' | 'TIKTOK')} style={{ width: 150 }}>
              <option value="AUTO">Tự nhận</option>
              <option value="META">Meta (Facebook)</option>
              <option value="TIKTOK">TikTok</option>
            </select>
            <label style={{ fontSize: 12.5 }}>
              <input type="checkbox" checked={createMissing} onChange={(e) => setCreateMissing(e.target.checked)} /> Tự tạo chiến dịch chưa có
            </label>
            <input type="file" accept=".csv,.txt" onChange={(e) => void onFile(e.target.files?.[0])} />
          </div>
          {report ? <div className="alert wr" style={{ marginBottom: 8 }}>{report}</div> : null}
        </>
      ) : null}
      {rows.length === 0 ? (
        <Empty>30 ngày qua chưa nhập chi phí.</Empty>
      ) : (
        <table>
          <thead>
            <tr><th>Ngày</th><th>Chiến dịch</th><th>Kênh</th><th>Chi phí</th><th>Nguồn nhập</th></tr>
          </thead>
          <tbody>
            {rows.slice(0, 200).map((r) => (
              <tr key={r.id}>
                <td>{r.day}</td>
                <td>{r.campaign.name}</td>
                <td>{r.campaign.channel?.name ?? '-'}</td>
                <td>{vnd(r.amount)}</td>
                <td>{r.source === 'MANUAL' ? 'Nhập tay' : r.source === 'CSV_META' ? 'Tệp Meta' : r.source === 'CSV_TIKTOK' ? 'Tệp TikTok' : 'Tệp CSV'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

export function EodPanel(): React.JSX.Element {
  const { fail } = useToast()
  const { branchId } = useAuth()
  const [date, setDate] = useState(toISODate(new Date()))
  const [rows, setRows] = useState<EodRow[]>([])
  const [onlyMe, setOnlyMe] = useState(false)

  useEffect(() => {
    fetchEod(date)
      .then((d) => {
        setRows(d.rows)
        setOnlyMe(d.onlyMe)
      })
      .catch((e) => fail(getApiErrorMessage(e)))
  }, [date, branchId, fail])

  const sum = (k: keyof EodRow) => rows.reduce((s, r) => s + (typeof r[k] === 'number' ? (r[k] as number) : 0), 0)
  return (
    <div className="card">
      <div className="row" style={{ marginBottom: 8 }}>
        <div className="sec-title" style={{ margin: 0 }}>Họp 30 phút cuối ngày{onlyMe ? ' (số của tôi)' : ''}</div>
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={{ marginLeft: 'auto', width: 160 }} />
      </div>
      {rows.length === 0 ? (
        <Empty>Chưa có sale nào trong cơ sở.</Empty>
      ) : (
        <table>
          <thead>
            <tr><th>Sale</th><th>Tin nhắn mới</th><th>SĐT thu được</th><th>Lịch có cọc</th><th>Khách đến</th><th>Việc quá hạn</th><th>Hội thoại chưa có SĐT</th></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.userId}>
                <td><b>{r.name}</b></td>
                <td>{r.newMessages}</td>
                <td>{r.phones}</td>
                <td>{r.depositBookings}</td>
                <td>{r.showups}</td>
                <td style={r.overdueTasks ? { color: 'var(--danger)' } : undefined}>{r.overdueTasks}</td>
                <td title={r.noPhoneList.map((c) => c.title).join('\n')}>{r.noPhoneConversations}</td>
              </tr>
            ))}
            {rows.length > 1 ? (
              <tr style={{ fontWeight: 600 }}>
                <td>Cả đội</td>
                <td>{sum('newMessages')}</td>
                <td>{sum('phones')}</td>
                <td>{sum('depositBookings')}</td>
                <td>{sum('showups')}</td>
                <td>{sum('overdueTasks')}</td>
                <td>{sum('noPhoneConversations')}</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      )}
      <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
        Hội thoại chưa có SĐT: hội thoại sale phụ trách có tin trong 7 ngày mà khách chưa có số điện thoại. Rê chuột vào con số để xem tên.
      </div>
    </div>
  )
}

export function ProgressBar({ percent }: { percent: number | null }): React.JSX.Element {
  const p = Math.max(0, Math.min(100, percent ?? 0))
  return (
    <div style={{ background: 'var(--line, #e3e8e5)', borderRadius: 6, height: 10, overflow: 'hidden' }}>
      <div style={{ width: `${p}%`, height: '100%', background: p >= 100 ? 'var(--ok, #177f4d)' : 'var(--brand, #177f4d)' }} />
    </div>
  )
}

export function LeaderboardPanel(): React.JSX.Element {
  const { fail } = useToast()
  const { branchId } = useAuth()
  const [period, setPeriod] = useState(currentPeriod())
  const [data, setData] = useState<Awaited<ReturnType<typeof fetchLeaderboard>> | null>(null)

  useEffect(() => {
    fetchLeaderboard(period)
      .then(setData)
      .catch((e) => fail(getApiErrorMessage(e)))
  }, [period, branchId, fail])

  return (
    <div className="card">
      <div className="row" style={{ marginBottom: 8 }}>
        <div className="sec-title" style={{ margin: 0 }}>Thi đua theo khách đến</div>
        <input type="month" value={period} onChange={(e) => setPeriod(e.target.value)} style={{ marginLeft: 'auto', width: 160 }} />
      </div>
      {data ? (
        <>
          <div style={{ marginBottom: 10 }}>
            <div className="row" style={{ fontSize: 13, marginBottom: 4 }}>
              <span>Mục tiêu cả đội: {data.target > 0 ? `${data.actual} / ${data.target} khách đến` : `${data.actual} khách đến (chưa đặt mục tiêu trong Cài đặt)`}</span>
              {data.percent != null ? <b style={{ marginLeft: 'auto' }}>{data.percent}%</b> : null}
            </div>
            <ProgressBar percent={data.percent} />
          </div>
          <table>
            <thead>
              <tr><th>Hạng</th><th>Sale</th><th>Khách đến</th><th>Ghi chú</th></tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.userId} style={r.disqualified ? { opacity: 0.6 } : undefined}>
                  <td>{r.rank ?? '-'}</td>
                  <td>{r.name}</td>
                  <td>{r.showups}</td>
                  <td style={{ fontSize: 12 }}>{r.disqualified ? `Bị loại: ${r.reasons.join('; ')}` : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
            Bị loại khỏi xếp hạng và thưởng thi đua khi trong tháng có báo giá dưới giá niêm yết chưa được duyệt, hoặc bị quản lý gắn cờ vi phạm chuyên môn.
          </div>
        </>
      ) : null}
    </div>
  )
}
