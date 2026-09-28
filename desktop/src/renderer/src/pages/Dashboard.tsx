import React, { useEffect, useMemo, useState } from 'react'
import {
  fetchClinicOperations,
  fetchDashboard,
  fetchDepartmentScores,
  getApiErrorMessage,
  type DepartmentScore,
  type HeadlineStat,
  type MetricUnit,
  type ScoreColumn,
  type ScoreRow
} from '../lib/api'
import { useAuth } from '../lib/auth-context'
import { ddmm, percent, vnd, vndShort } from '../lib/format'
import { Empty, useToast } from '../components/ui'
import type { DashboardData } from '../lib/types'

/* TỔNG QUAN — một màn, hai tầng.
 *
 *   Tầng 1 "Toàn phòng khám": tiền, phễu, cảnh báo, và MỘT THẺ CHO MỖI BỘ PHẬN
 *           kèm điểm trung bình, người dẫn đầu, người đang đuối.
 *   Tầng 2 "Từng bộ phận": bấm vào thẻ là mở bảng điểm chi tiết của bộ phận đó.
 *
 * Vì sao chia hai tầng thay vì đổ hết ra một trang: câu hỏi của chủ đầu tư luôn
 * đi theo thứ tự "bộ phận nào đang đuối?" rồi mới "ai trong đó?". Bày cả 40
 * dòng nhân sự cùng lúc là bắt người đọc tự lọc — đúng việc mà màn này phải làm
 * thay họ.
 */

const PERIODS: Array<{ key: string; label: string }> = [
  { key: 'today', label: 'Hôm nay' },
  { key: '7d', label: '7 ngày' },
  { key: 'month', label: 'Tháng này' },
  { key: 'quarter', label: 'Quý' }
]

/** Định dạng một con số theo đơn vị của cột. */
function fmt(value: number, unit?: MetricUnit): string {
  if (unit === 'đ') return vndShort(value)
  if (unit === '%') return `${value}%`
  if (unit === 'phút') return `${value} phút`
  if (unit === 'giờ') return `${value} giờ`
  return value.toLocaleString('vi-VN')
}

function scoreClass(score: number): string {
  return score >= 70 ? '' : score >= 40 ? 'mid' : 'low'
}

function ScoreBar({ score }: { score: number | null | undefined }): React.JSX.Element {
  if (score == null) return <span className="muted" style={{ fontSize: 12 }}>chưa phát sinh</span>
  return (
    <div className={`score ${scoreClass(score)}`}>
      <div className="track">
        <i style={{ width: `${score}%` }} />
      </div>
      <b>{score}</b>
    </div>
  )
}

function StatStrip({ stats }: { stats: HeadlineStat[] }): React.JSX.Element {
  return (
    <div className="stat-strip">
      {stats.map((s) => (
        <div className={`stat ${s.tone ?? ''}`} key={s.label} title={s.hint ?? ''}>
          <div className="lab">{s.label}</div>
          <div className="val">{fmt(s.value, s.unit)}</div>
          {s.hint ? <div className="hint">{s.hint}</div> : null}
        </div>
      ))}
    </div>
  )
}

export default function Dashboard(): React.JSX.Element {
  const { can, branchId } = useAuth()
  const { fail } = useToast()
  const [period, setPeriod] = useState('month')
  const [view, setView] = useState('OVERVIEW')
  const [data, setData] = useState<DashboardData | null>(null)
  const [ops, setOps] = useState<Awaited<ReturnType<typeof fetchClinicOperations>> | null>(null)
  const [depts, setDepts] = useState<DepartmentScore[]>([])
  const [loading, setLoading] = useState(true)

  const canSeeStaff = can('hr.read') || can('accounting.read')

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    Promise.all([
      fetchDashboard({ period }),
      can('appointment.read') ? fetchClinicOperations({ period }) : Promise.resolve(null),
      canSeeStaff ? fetchDepartmentScores({ period }).catch(() => null) : Promise.resolve(null)
    ])
      .then(([dash, operations, departments]) => {
        if (cancelled) return
        setData(dash)
        setOps(operations)
        setDepts(departments?.departments ?? [])
      })
      .catch((err) => !cancelled && fail(getApiErrorMessage(err)))
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [period, branchId, can, canSeeStaff, fail])

  if (!can('accounting.read') && !can('finance.read')) {
    return (
      <div className="card">
        <Empty>
          Vai trò của bạn không xem được số liệu kinh doanh tổng hợp.
          <br />
          Hãy dùng menu bên trái để vào phần việc của mình.
        </Empty>
      </div>
    )
  }

  if (loading && !data) {
    return (
      <div className="card">
        <Empty>Đang tải số liệu…</Empty>
      </div>
    )
  }
  if (!data) {
    return (
      <div className="card">
        <Empty>Không tải được số liệu.</Empty>
      </div>
    )
  }

  const active = depts.find((d) => d.key === view)

  return (
    <>
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
        <span className="muted" style={{ fontSize: 12, marginLeft: 'auto' }}>
          So sánh với kỳ trước liền kề
        </span>
      </div>

      {depts.length ? (
        <div className="tabs" style={{ flexWrap: 'wrap' }}>
          <button className={view === 'OVERVIEW' ? 'on' : ''} onClick={() => setView('OVERVIEW')}>
            📊 Toàn phòng khám
          </button>
          {depts.map((d) => (
            <button key={d.key} className={view === d.key ? 'on' : ''} onClick={() => setView(d.key)}>
              {d.icon} {d.name}
            </button>
          ))}
        </div>
      ) : null}

      {active ? (
        <DepartmentView dept={active} />
      ) : (
        <Overview data={data} ops={ops} depts={depts} onOpen={setView} />
      )}
    </>
  )
}

/* --------------------------------------------------------- TOÀN PHÒNG KHÁM */

function Overview({
  data,
  ops,
  depts,
  onOpen
}: {
  data: DashboardData
  ops: Awaited<ReturnType<typeof fetchClinicOperations>> | null
  depts: DepartmentScore[]
  onOpen: (key: string) => void
}): React.JSX.Element {
  const maxFunnel = data.funnel[0]?.count || 1
  const maxDaily = Math.max(1, ...data.daily.map((d) => Math.max(d.signed, d.collected)))

  return (
    <>
      <div className="grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)', marginBottom: 12 }}>
        {data.kpis.map((k) => {
          // Công nợ tăng là tin xấu — đảo chiều màu cho đúng nghĩa kinh doanh.
          const good = k.invert ? !k.delta.up : k.delta.up
          return (
            <div className="kpi" key={k.label}>
              <div className="lab">{k.label}</div>
              <div className="val">{k.unit === 'đ' ? vnd(k.value) : k.value.toLocaleString('vi-VN')}</div>
              <div className={`dt ${good ? 'up' : 'down'}`}>
                {k.delta.pct === null
                  ? 'Kỳ trước không có dữ liệu'
                  : `${k.delta.up ? '+' : ''}${percent(k.delta.pct)} so kỳ trước`}
              </div>
            </div>
          )
        })}
      </div>

      {depts.length ? (
        <>
          <div className="sec-title" style={{ marginBottom: 8 }}>
            Hiệu suất theo bộ phận — bấm vào một thẻ để xem từng người
          </div>
          <div className="dept-grid" style={{ marginBottom: 12 }}>
            {depts.map((d) => (
              <DeptCard key={d.key} dept={d} onOpen={() => onOpen(d.key)} />
            ))}
          </div>
        </>
      ) : null}

      <div className="grid" style={{ gridTemplateColumns: '1.2fr 1fr', marginBottom: 12 }}>
        <div className="card">
          <div className="sec-title">Phễu chuyển đổi</div>
          {data.funnel.map((step, i) => {
            const prev = i ? data.funnel[i - 1].count : step.count
            const drop = i && prev ? Math.round((1 - step.count / prev) * 100) : 0
            return (
              <div className="fun" key={step.stage}>
                <div className="fl">{step.label}</div>
                <div className="fb">
                  <i style={{ width: `${Math.round((step.count / maxFunnel) * 100)}%` }} />
                </div>
                <div className="fn">
                  {step.count}
                  {i ? (
                    <span className={drop > 45 ? 'down' : 'muted'} style={{ fontWeight: 400 }}>
                      {' '}
                      (-{drop}%)
                    </span>
                  ) : null}
                </div>
              </div>
            )
          })}
          {data.funnel.length >= 5 && data.funnel[0].count > 0 ? (
            <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
              Tỉ lệ đến {Math.round((data.funnel[3].count / data.funnel[0].count) * 100)}% · Tỉ lệ chốt{' '}
              {data.funnel[3].count ? Math.round((data.funnel[4].count / data.funnel[3].count) * 100) : 0}%
            </div>
          ) : null}
        </div>

        <div className="card">
          <div className="sec-title">Cảnh báo cần xử lý ngay</div>
          {data.alerts.length === 0 ? (
            <div className="alert ok">Không có cảnh báo nào. Mọi thứ đang trong tầm kiểm soát.</div>
          ) : (
            data.alerts.map((a, i) => (
              <div key={i} className={`alert ${a.level}`}>
                {a.text}
              </div>
            ))
          )}
        </div>
      </div>

      <div className="grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
        <div className="card">
          <div className="sec-title">Doanh thu theo ngày</div>
          {data.daily.length === 0 ? (
            <Empty>Chưa có giao dịch nào trong kỳ.</Empty>
          ) : (
            <>
              <div className="cols">
                {data.daily.slice(-10).map((d) => (
                  <div className="colb" key={d.date}>
                    <div className="pair">
                      <div
                        className="b1"
                        style={{ height: `${Math.round((d.signed / maxDaily) * 100)}%` }}
                        title={`Ký ${vnd(d.signed)}`}
                      />
                      <div
                        className="b2"
                        style={{ height: `${Math.round((d.collected / maxDaily) * 100)}%` }}
                        title={`Thực thu ${vnd(d.collected)}`}
                      />
                    </div>
                    <small>{ddmm(d.date)}</small>
                  </div>
                ))}
              </div>
              <div className="muted" style={{ fontSize: 11.5 }}>
                ■ Doanh số ký · □ Tiền thực thu · cột cao nhất = {vndShort(maxDaily)}
              </div>
            </>
          )}
        </div>

        <div className="card">
          <div className="sec-title">Công suất phòng mổ theo ngày</div>
          {!ops || ops.surgeryCapacity.length === 0 ? (
            <Empty>Chưa có ca mổ nào trong kỳ.</Empty>
          ) : (
            ops.surgeryCapacity.slice(-7).map((c) => (
              <div className="row" style={{ marginBottom: 7 }} key={c.date}>
                <span style={{ width: 44, fontSize: 12 }}>{ddmm(c.date)}</span>
                <div className="bar" style={{ flex: 1 }}>
                  <i style={{ width: `${c.utilization}%` }} />
                </div>
                <b style={{ width: 42, textAlign: 'right', fontSize: 12.5 }}>{c.utilization}%</b>
              </div>
            ))
          )}
          {ops ? (
            <div className="muted" style={{ fontSize: 11.5, marginTop: 8 }}>
              Vắng mặt {percent(ops.appointments.noShowRate)} · Chờ trung bình {ops.queue.avgWaitMinutes} phút ·
              Đang chờ {ops.queue.stillWaiting} khách
            </div>
          ) : null}
        </div>
      </div>
    </>
  )
}

/** Thẻ tóm tắt một bộ phận: điểm trung bình, người dẫn đầu, người đang đuối. */
function DeptCard({ dept, onOpen }: { dept: DepartmentScore; onOpen: () => void }): React.JSX.Element {
  const scored = dept.rows.filter((r) => r.score != null)
  const avg = scored.length
    ? Math.round(scored.reduce((s, r) => s + (r.score ?? 0), 0) / scored.length)
    : null
  const best = scored[0]
  const worst = scored.length > 1 ? scored[scored.length - 1] : null
  const danger = dept.alerts.filter((a) => a.level === 'dg').length
  const warn = dept.alerts.filter((a) => a.level === 'wr').length

  return (
    <button className="dept-card" onClick={onOpen}>
      <div className="head">
        <span className="ico">{dept.icon}</span>
        <b>{dept.name}</b>
        {danger ? (
          <span className="tag" style={{ marginLeft: 'auto', background: '#FEE2E2', color: '#B91C1C' }}>
            {danger}
          </span>
        ) : warn ? (
          <span className="tag" style={{ marginLeft: 'auto', background: '#FEF3C7', color: '#B45309' }}>
            {warn}
          </span>
        ) : null}
      </div>
      <ScoreBar score={avg} />
      {best ? (
        <div className="who">
          <span className="muted">Dẫn đầu</span>
          <span>
            {best.name} · {best.score}
          </span>
        </div>
      ) : (
        <div className="sub">{dept.note ?? 'Chưa có số liệu trong kỳ.'}</div>
      )}
      {worst ? (
        <div className="who">
          <span className="muted">Cần chú ý</span>
          <span style={{ color: 'var(--danger)' }}>
            {worst.name} · {worst.score}
          </span>
        </div>
      ) : null}
    </button>
  )
}

/* --------------------------------------------------------- TỪNG BỘ PHẬN */

function DepartmentView({ dept }: { dept: DepartmentScore }): React.JSX.Element {
  // Cột để vẽ biểu đồ so sánh: mặc định lấy cột có trọng số cao nhất, vì đó là
  // thứ quyết định điểm — nhìn biểu đồ phải giải thích được thứ hạng.
  const defaultChart = useMemo(() => {
    // Chọn theo trọng số trước, nhưng khi nhiều cột cùng trọng số thì lấy cột
    // CHÊNH LỆCH NHIỀU NHẤT — biểu đồ mà ai cũng bằng nhau thì không nói lên gì.
    const spread = (key: string): number => {
      const vals = dept.rows.map((r) => r.metrics[key] ?? 0)
      const max = Math.max(0, ...vals)
      return max ? (max - Math.min(...vals)) / max : 0
    }
    const weighted = [...dept.columns].filter((c) => c.weight)
    weighted.sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0) || spread(b.key) - spread(a.key))
    return (weighted[0] ?? dept.columns[0])?.key
  }, [dept])
  const [chartKey, setChartKey] = useState(defaultChart)

  useEffect(() => setChartKey(defaultChart), [defaultChart])

  const chartCol = dept.columns.find((c) => c.key === chartKey) ?? dept.columns[0]

  // Giá trị tốt nhất / tệ nhất từng cột, để tô màu ô trong bảng.
  const extremes = useMemo(() => {
    const out: Record<string, { top: number; bottom: number }> = {}
    for (const col of dept.columns) {
      // Ở cột "càng thấp càng tốt" mà số 0 là thành tích (0 sự cố, 0 ca huỷ),
      // số 0 PHẢI được đưa vào so sánh — bỏ ra thì người sạch lỗi không bao giờ
      // được tô là người dẫn đầu cột đó.
      const zeroCounts = !col.goodHigh && !col.zeroMeansNoData
      const vals = dept.rows
        .filter((r) => r.score != null)
        .map((r) => r.metrics[col.key] ?? 0)
        .filter((v) => zeroCounts || v > 0)
      if (vals.length < 2) continue
      out[col.key] = col.goodHigh
        ? { top: Math.max(...vals), bottom: Math.min(...vals) }
        : { top: Math.min(...vals), bottom: Math.max(...vals) }
    }
    return out
  }, [dept])

  const chartZeroIsResult = chartCol && !chartCol.goodHigh && !chartCol.zeroMeansNoData
  const chartRows = [...dept.rows]
    .filter((r) => r.score != null && (chartZeroIsResult || (r.metrics[chartCol?.key] ?? 0) > 0))
    .sort((a, b) => (b.metrics[chartCol.key] ?? 0) - (a.metrics[chartCol.key] ?? 0))
  const chartMax = Math.max(1, ...chartRows.map((r) => r.metrics[chartCol?.key] ?? 0))

  return (
    <>
      <div className="row" style={{ marginBottom: 10 }}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 700 }}>
            {dept.icon} {dept.name}
          </div>
          <div className="muted" style={{ fontSize: 12.5 }}>
            {dept.subtitle}
          </div>
        </div>
      </div>

      <StatStrip stats={dept.headline} />

      {dept.alerts.length ? (
        <div className="card" style={{ marginBottom: 12 }}>
          <div className="sec-title">Việc cần xử lý ở bộ phận này</div>
          {dept.alerts.map((a, i) => (
            <div className={`alert ${a.level}`} key={i}>
              {a.text}
            </div>
          ))}
        </div>
      ) : null}

      <div className="grid" style={{ gridTemplateColumns: '1fr', marginBottom: 12 }}>
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <div className="row" style={{ padding: '12px 14px 0' }}>
            <div className="sec-title" style={{ marginBottom: 0 }}>
              Bảng điểm {dept.entityLabel.toLowerCase()}
            </div>
            <span className="muted" style={{ fontSize: 11.5, marginLeft: 'auto' }}>
              Điểm 0–100 so với người dẫn đầu chính bộ phận này, không so với bộ phận khác
            </span>
          </div>

          {dept.rows.length === 0 ? (
            <Empty>{dept.note ?? 'Chưa có số liệu trong kỳ.'}</Empty>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table>
                <thead>
                  <tr>
                    <th style={{ width: 34 }} />
                    <th>{dept.entityLabel}</th>
                    <th style={{ width: 130 }}>Điểm</th>
                    {dept.columns.map((c) => (
                      <th key={c.key} style={{ textAlign: 'right' }} title={c.hint ?? ''}>
                        {c.label}
                        {c.weight ? <span className="muted"> ×{c.weight}</span> : null}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {dept.rows.map((r, i) => (
                    <tr key={r.key}>
                      <td>
                        {r.score != null ? (
                          <span className={`rank ${i < 3 ? `r${i + 1}` : ''}`}>{i + 1}</span>
                        ) : null}
                      </td>
                      <td>
                        <b>{r.name}</b>
                        {r.sub ? (
                          <div className="muted" style={{ fontSize: 11.5 }}>
                            {r.sub}
                          </div>
                        ) : null}
                      </td>
                      <td>
                        <ScoreBar score={r.score} />
                      </td>
                      {dept.columns.map((c) => {
                        const v = r.metrics[c.key] ?? 0
                        // 0 ở cột lỗi/sự cố là con số THẬT và đáng khoe; 0 ở cột
                        // "phút phản hồi" chỉ nghĩa là chưa trả lời tin nào.
                        const zeroIsResult = !c.goodHigh && !c.zeroMeansNoData
                        const ex = extremes[c.key]
                        const comparable = r.score != null && (v > 0 || zeroIsResult)
                        const cls =
                          !ex || !comparable ? '' : v === ex.top ? 'top' : v === ex.bottom ? 'bottom' : ''
                        return (
                          <td className={`metric ${cls}`} key={c.key}>
                            {v === 0 && !zeroIsResult ? <span className="muted">—</span> : fmt(v, c.unit)}
                          </td>
                        )
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {chartRows.length ? (
        <div className="card">
          <div className="row" style={{ marginBottom: 10 }}>
            <div className="sec-title" style={{ marginBottom: 0 }}>
              So sánh trực tiếp
            </div>
            <select
              className="input"
              style={{ marginLeft: 'auto', width: 'auto', fontSize: 12.5 }}
              value={chartKey}
              onChange={(e) => setChartKey(e.target.value)}
            >
              {dept.columns.map((c) => (
                <option key={c.key} value={c.key}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>
          {chartRows.map((r) => {
            const v = r.metrics[chartCol.key] ?? 0
            const share = Math.round((v / chartMax) * 100)
            // Cột "càng thấp càng tốt" thì người có thanh dài nhất là người tệ nhất.
            const tone = chartCol.goodHigh ? '' : share > 66 ? 'bad' : share > 33 ? 'warn' : ''
            return (
              <div className="hbar" key={r.key}>
                <span className="nm" title={r.name}>
                  {r.name}
                </span>
                <div className="tr">
                  <i className={tone} style={{ width: `${share}%` }} />
                </div>
                <span className="vl">{fmt(v, chartCol.unit)}</span>
              </div>
            )
          })}
          <div className="muted" style={{ fontSize: 11.5, marginTop: 8 }}>
            {chartCol.hint ??
              (chartCol.goodHigh ? 'Thanh càng dài càng tốt.' : 'Thanh càng dài càng đáng lo.')}
          </div>
        </div>
      ) : null}
    </>
  )
}

export type { ScoreColumn, ScoreRow }
