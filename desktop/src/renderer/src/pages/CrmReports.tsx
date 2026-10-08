import React, { useCallback, useEffect, useState } from 'react'
import { getApiErrorMessage } from '../lib/api'
import { useClinic } from '../lib/clinic-context'
import { vnd, vndShort } from '../lib/format'
import { useMoneyVisible } from '../components/crm360-parts'
import { Empty, useToast } from '../components/ui'
import {
  fetchAovReport,
  fetchForecast,
  fetchJourneyReport,
  fetchPackageSummary,
  type AovReport,
  type ForecastBucket,
  type ForecastReport,
  type JourneyReport,
  type PackageSummary
} from '../lib/api-lo8'

/* Lô 8 · BÁO CÁO CRM 360: J2 hành trình (thời gian TB mỗi bước, bước rơi nhiều
   nhất), V4 giá trị đơn trung bình (chỉ đo, không nối lương), V7 dự báo pipeline
   (xác suất từ lịch sử bước thật, thiếu dữ liệu thì nói thẳng), V3 tổng gói liệu trình. */

type Tab = 'journey' | 'aov' | 'forecast' | 'packages'

const pct = (r: number | null | undefined) => (r == null ? '–' : `${Math.round(r * 100)}%`)

export default function CrmReports(): React.JSX.Element {
  const money = useMoneyVisible()
  const [tab, setTab] = useState<Tab>('journey')
  const [days, setDays] = useState<number | ''>('')
  const tabs: Array<{ key: Tab; label: string; money?: boolean }> = [
    { key: 'journey', label: 'Hành trình' },
    { key: 'aov', label: 'Giá trị đơn', money: true },
    { key: 'forecast', label: 'Dự báo pipeline', money: true },
    { key: 'packages', label: 'Gói liệu trình', money: true }
  ]
  return (
    <>
      <div className="pl-toolbar">
        <div className="seg" role="tablist">
          {tabs
            .filter((t) => !t.money || money)
            .map((t) => (
              <button key={t.key} className={tab === t.key ? 'on' : ''} onClick={() => setTab(t.key)}>
                {t.label}
              </button>
            ))}
        </div>
        {tab === 'journey' || tab === 'aov' ? (
          <select className="fchip-select" value={days} onChange={(e) => setDays(e.target.value ? Number(e.target.value) : '')}>
            <option value="">Kỳ mặc định</option>
            <option value={30}>30 ngày</option>
            <option value={90}>90 ngày</option>
            <option value={180}>180 ngày</option>
            <option value={365}>365 ngày</option>
          </select>
        ) : null}
      </div>
      {tab === 'journey' ? <JourneyTab days={days || undefined} /> : null}
      {tab === 'aov' && money ? <AovTab days={days || undefined} /> : null}
      {tab === 'forecast' && money ? <ForecastTab /> : null}
      {tab === 'packages' && money ? <PackagesTab /> : null}
      {!money ? <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>Báo cáo có số tiền chỉ hiện với quản lý, kế toán, giám đốc.</div> : null}
    </>
  )
}

function JourneyTab({ days }: { days?: number }): React.JSX.Element {
  const { fail } = useToast()
  const clinic = useClinic()
  const [groupBy, setGroupBy] = useState('sale')
  const [data, setData] = useState<JourneyReport | null>(null)
  useEffect(() => {
    setData(null)
    fetchJourneyReport({ days, groupBy })
      .then(setData)
      .catch((err) => fail(getApiErrorMessage(err)))
  }, [days, groupBy, fail])
  if (!data) return <div className="card"><Empty>Đang tải…</Empty></div>
  const label = (k: string) => clinic.stageStyle(k).t
  const cell = (s: { avgDays: number | null; completed: number; dropped: number } | undefined) =>
    !s ? '–' : (
      <>
        {s.avgDays == null ? '–' : `${s.avgDays} ngày`}
        {s.dropped ? <div className="t-over" style={{ fontSize: 11 }}>rơi {s.dropped}</div> : null}
      </>
    )
  return (
    <div className="card">
      <div className="row" style={{ marginBottom: 8 }}>
        <div className="sec-title" style={{ margin: 0 }}>Hành trình {data.days} ngày</div>
        <select className="fchip-select" style={{ marginLeft: 'auto' }} value={groupBy} onChange={(e) => setGroupBy(e.target.value)}>
          <option value="sale">Theo sale</option>
          <option value="channel">Theo kênh</option>
          <option value="service">Theo dịch vụ</option>
          <option value="branch">Theo cơ sở</option>
        </select>
      </div>
      <div className="rpt-kpis">
        <div className="k">
          <b>{data.overall.units}</b>
          <span>cơ hội có đổi bước trong kỳ</span>
        </div>
        <div className="k">
          <b>{data.overall.lost}</b>
          <span>lượt mất khách</span>
        </div>
        <div className="k">
          <b>{data.overall.topDrop ? label(data.overall.topDrop.stage) : '–'}</b>
          <span>bước rơi nhiều nhất{data.overall.topDrop ? ` (${data.overall.topDrop.dropped} lượt)` : ''}</span>
        </div>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table>
          <thead>
            <tr>
              <th>Nhóm</th>
              <th>Cơ hội</th>
              {data.stages.map((s) => (
                <th key={s.key}>{s.label}</th>
              ))}
              <th>Rơi nhiều nhất</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <b>Tất cả</b>
              </td>
              <td>{data.overall.units}</td>
              {data.stages.map((s) => (
                <td key={s.key}>{cell(data.overall.stages.find((x) => x.stage === s.key))}</td>
              ))}
              <td>{data.overall.topDrop ? label(data.overall.topDrop.stage) : '–'}</td>
            </tr>
            {data.groups.map((g) => (
              <tr key={g.key ?? '_'}>
                <td>{g.label}</td>
                <td>{g.units}</td>
                {data.stages.map((s) => (
                  <td key={s.key}>{cell(g.stages.find((x) => x.stage === s.key))}</td>
                ))}
                <td>{g.topDrop ? label(g.topDrop.stage) : '–'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="muted" style={{ fontSize: 11.5, marginTop: 8 }}>
        Mỗi ô: số ngày trung bình ở bước (chỉ tính lượt đã rời bước) và số lượt rơi sang Mất khách ngay từ bước đó. Đọc lịch sử bước thật theo từng cơ hội.
      </div>
    </div>
  )
}

const DIM_LABEL: Record<string, string> = { sale: 'Theo sale', doctor: 'Theo bác sĩ', branch: 'Theo cơ sở', entryService: 'Theo dịch vụ đầu vào', channel: 'Theo kênh' }

function AovTab({ days }: { days?: number }): React.JSX.Element {
  const { fail } = useToast()
  const [data, setData] = useState<AovReport | null>(null)
  useEffect(() => {
    setData(null)
    fetchAovReport({ days })
      .then(setData)
      .catch((err) => fail(getApiErrorMessage(err)))
  }, [days, fail])
  if (!data) return <div className="card"><Empty>Đang tải…</Empty></div>
  const up = data.upsellOffers.total
  return (
    <>
      <div className="card" style={{ marginBottom: 12 }}>
        <div className="sec-title">Giá trị đơn trung bình {data.days} ngày</div>
        <div className="rpt-kpis">
          <div className="k">
            <b>{vnd(data.overall.avg)}</b>
            <span>giá trị đơn TB ({data.overall.orders} đơn)</span>
          </div>
          <div className="k">
            <b>{vndShort(data.overall.revenue)}</b>
            <span>tổng giá trị đơn đã ký</span>
          </div>
          <div className="k">
            <b>{pct(data.overall.upsellRate)}</b>
            <span>đơn có bán kèm ({data.overall.withUpsell})</span>
          </div>
          <div className="k">
            <b>{pct(up.acceptRate)}</b>
            <span>khách nhận gợi ý bán kèm ({up.accepted}/{up.suggested})</span>
          </div>
        </div>
        <div className="muted" style={{ fontSize: 11.5 }}>{data.note} Đơn = hợp đồng đã ký chưa huỷ, theo ngày ký.</div>
      </div>
      {Object.entries(data.by).map(([dim, rows]) => (
        <div key={dim} className="card" style={{ marginBottom: 12, padding: 0, overflowX: 'auto' }}>
          <div className="sec-title" style={{ padding: '12px 14px 0' }}>{DIM_LABEL[dim] ?? dim}</div>
          {rows.length === 0 ? (
            <Empty>Chưa có đơn trong kỳ.</Empty>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Nhóm</th>
                  <th>Số đơn</th>
                  <th>Tổng</th>
                  <th>Đơn TB</th>
                  <th>Đơn có bán kèm</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.key ?? '_'}>
                    <td>{r.label}</td>
                    <td>{r.orders}</td>
                    <td>{vndShort(r.revenue)}</td>
                    <td>
                      <b>{vnd(r.avg)}</b>
                    </td>
                    <td>
                      {r.withUpsell} ({pct(r.upsellRate)})
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ))}
    </>
  )
}

function ForecastTab(): React.JSX.Element {
  const { fail } = useToast()
  const clinic = useClinic()
  const [data, setData] = useState<ForecastReport | null>(null)
  useEffect(() => {
    fetchForecast()
      .then(setData)
      .catch((err) => fail(getApiErrorMessage(err)))
  }, [fail])
  if (!data) return <div className="card"><Empty>Đang tải…</Empty></div>
  const table = (title: string, rows: ForecastBucket[], keyLabel: (b: ForecastBucket) => string) => (
    <div className="card" style={{ marginBottom: 12, padding: 0, overflowX: 'auto' }}>
      <div className="sec-title" style={{ padding: '12px 14px 0' }}>{title}</div>
      {rows.length === 0 ? (
        <Empty>Không có cơ hội đang mở.</Empty>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Nhóm</th>
              <th>Cơ hội</th>
              <th>Giá trị pipeline</th>
              <th>Dự báo (giá trị × xác suất)</th>
              <th>Chưa đủ dữ liệu</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((b) => (
              <tr key={b.key ?? '_'}>
                <td>{keyLabel(b)}</td>
                <td>{b.count}</td>
                <td>{vndShort(b.pipelineValue)}</td>
                <td>
                  <b>{vndShort(b.weightedValue)}</b>
                </td>
                <td className={b.noDataCount ? 'nodata' : ''}>{b.noDataCount ? `${b.noDataCount} cơ hội · ${vndShort(b.noDataValue)}` : '–'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
  return (
    <>
      <div className="card" style={{ marginBottom: 12 }}>
        <div className="sec-title">Dự báo pipeline</div>
        <div className="rpt-kpis">
          <div className="k">
            <b>{vndShort(data.total.weightedValue)}</b>
            <span>dự báo ({data.total.count} cơ hội đang mở)</span>
          </div>
          <div className="k">
            <b>{vndShort(data.total.pipelineValue)}</b>
            <span>tổng giá trị dự kiến</span>
          </div>
          <div className="k">
            <b className={data.total.noDataCount ? 'nodata' : ''}>{data.total.noDataCount}</b>
            <span>cơ hội ở bước chưa đủ dữ liệu (không cộng)</span>
          </div>
        </div>
        <table>
          <thead>
            <tr>
              <th>Bước</th>
              <th>Cơ hội đã có kết quả</th>
              <th>Thắng</th>
              <th>Xác suất</th>
            </tr>
          </thead>
          <tbody>
            {data.probabilities.map((p) => (
              <tr key={p.stage}>
                <td>{p.label}</td>
                <td>{p.settled}</td>
                <td>{p.won}</td>
                <td>{p.probability == null ? <span className="nodata">chưa đủ dữ liệu (cần {data.minSamples})</span> : <b>{pct(p.probability)}</b>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="muted" style={{ fontSize: 11.5, marginTop: 8 }}>
          Xác suất đo từ lịch sử bước {data.lookbackDays} ngày gần nhất: trong các cơ hội từng vào bước và đã có kết quả (làm dịch vụ hoặc mất), tỉ lệ làm dịch vụ. Dưới {data.minSamples} cơ hội thì không tính, không đoán.
          Tháng lấy theo ngày dự kiến chốt trên cơ hội, chưa có thì theo lịch hẹn sắp tới.
        </div>
      </div>
      {table('Theo tháng dự kiến chốt', data.byMonth, (b) => (b.key ? `Tháng ${b.key.slice(5)}/${b.key.slice(0, 4)}` : 'Chưa có ngày dự kiến'))}
      {table('Theo sale', data.byOwner, (b) => b.label ?? '–')}
      {table('Theo bước', data.byStage, (b) => (b.key ? clinic.stageStyle(b.key).t : '–'))}
    </>
  )
}

function PackagesTab(): React.JSX.Element {
  const { fail } = useToast()
  const [data, setData] = useState<PackageSummary | null>(null)
  const load = useCallback(() => {
    fetchPackageSummary()
      .then(setData)
      .catch((err) => fail(getApiErrorMessage(err)))
  }, [fail])
  useEffect(() => load(), [load])
  if (!data) return <div className="card"><Empty>Đang tải…</Empty></div>
  return (
    <div className="card">
      <div className="sec-title">Gói liệu trình</div>
      <div className="rpt-kpis">
        <div className="k">
          <b>{data.active}</b>
          <span>gói đang dùng (tổng {data.packages})</span>
        </div>
        <div className="k">
          <b>{vndShort(data.soldValue)}</b>
          <span>giá trị gói đã bán (trừ gói huỷ)</span>
        </div>
        <div className="k">
          <b>{vndShort(data.usedValue)}</b>
          <span>giá trị buổi đã dùng</span>
        </div>
        <div className="k">
          <b>{vndShort(data.prepaidUnused)}</b>
          <span>tiền đã thu trước, chưa thực hiện</span>
        </div>
      </div>
      <div className="alert">{data.note}</div>
    </div>
  )
}
