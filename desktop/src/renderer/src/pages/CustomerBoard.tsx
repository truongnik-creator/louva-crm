import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { fetchCampaigns, fetchChannels, fetchServices, getApiErrorMessage } from '../lib/api'
import { useAuth } from '../lib/auth-context'
import { useClinic } from '../lib/clinic-context'
import { dateVi, vndShort } from '../lib/format'
import { Empty, useToast } from '../components/ui'
import { useDropActions } from '../components/crm360b-parts'
import { DepositChip, HeatChip, HEAT_LABEL, ageClass, daysText } from '../components/crm360-parts'
import {
  fetchBoardPrefs,
  fetchPipeline,
  saveBoardPrefs,
  type BoardFilters,
  type BoardView,
  type Pipeline,
  type PipelineCard,
  type PipelineColumn
} from '../lib/api-lo7'

/* Lô 7 · P1 P2 P3: BẢNG BƯỚC KHÁCH KHỐI.
   Dải phễu hình khối (6 khối Tiếp cận → Làm dịch vụ, cao theo số khách, tổng
   giá trị dưới khối, % chuyển giữa hai khối), ba kiểu xem (Kanban khối, Phễu,
   Bảng) và chip lọc nhanh, nhớ theo từng người dùng (lưu trên máy chủ).
   Kéo thẻ sang cột khác để đổi bước (Mất khách và lùi bước hỏi lý do). */

const VIEWS: Array<{ key: BoardView; label: string }> = [
  { key: 'kanban', label: 'Kanban khối' },
  { key: 'funnel', label: 'Phễu' },
  { key: 'table', label: 'Bảng' }
]

function pct(rate: number | null | undefined): string {
  return rate == null ? '–' : `${Math.round(rate * 100)}%`
}

export default function CustomerBoard(): React.JSX.Element {
  const { can, user } = useAuth()
  const clinic = useClinic()
  const { fail } = useToast()
  const navigate = useNavigate()
  const [data, setData] = useState<Pipeline | null>(null)
  const [view, setView] = useState<BoardView>('kanban')
  const [filters, setFilters] = useState<BoardFilters>({})
  const [q, setQ] = useState('')
  const [prefsLoaded, setPrefsLoaded] = useState(false)
  const [services, setServices] = useState<Array<{ id: string; name: string }>>([])
  const [channels, setChannels] = useState<Array<{ id: string; name: string }>>([])
  const [campaigns, setCampaigns] = useState<Array<{ id: string; name: string }>>([])
  const [dragging, setDragging] = useState<{ card: PipelineCard; from: string } | null>(null)
  const [over, setOver] = useState<string | null>(null)
  const colRefs = useRef<Record<string, HTMLDivElement | null>>({})

  // Lựa chọn đã lưu của người dùng (P3).
  useEffect(() => {
    fetchBoardPrefs()
      .then((p) => {
        setView(p.view)
        setFilters(p.filters ?? {})
      })
      .catch(() => undefined)
      .finally(() => setPrefsLoaded(true))
    fetchServices().then((s) => setServices(s.map((x) => ({ id: x.id, name: x.name })))).catch(() => undefined)
    fetchChannels().then((c) => setChannels(c)).catch(() => undefined)
    fetchCampaigns().then((c) => setCampaigns(c.map((x) => ({ id: x.id, name: x.name })))).catch(() => undefined)
  }, [])

  useEffect(() => {
    if (!prefsLoaded) return
    const t = window.setTimeout(() => void saveBoardPrefs({ view, filters }).catch(() => undefined), 400)
    return () => window.clearTimeout(t)
  }, [view, filters, prefsLoaded])

  const load = useCallback(async () => {
    try {
      setData(await fetchPipeline({ ...filters, q: q.trim() || undefined, perStage: 30 }))
    } catch (err) {
      fail(getApiErrorMessage(err))
    }
  }, [filters, q, fail])

  useEffect(() => {
    if (!prefsLoaded) return
    const t = window.setTimeout(() => void load(), q ? 300 : 0)
    return () => window.clearTimeout(t)
  }, [load, prefsLoaded, clinic.mode, q])

  // Lô 8 · P4 + P5: thả thẻ hỏi máy chủ điều kiện của cột, mở sẵn form tương ứng.
  const { drop, modals } = useDropActions(() => void load())
  const canMove = can('customer.update')
  const toggle = (k: 'mine' | 'hot' | 'overdue') => setFilters((f) => ({ ...f, [k]: !f[k] || undefined }))
  const pick = (k: 'branchId' | 'serviceId' | 'channelId' | 'campaignId', v: string) => setFilters((f) => ({ ...f, [k]: v || undefined }))
  const branches = user?.branches ?? []
  const activeCount = Object.values(filters).filter(Boolean).length

  const funnelCols = useMemo(() => (data ? data.columns.filter((c) => c.inFunnel) : []), [data])

  const jumpTo = (key: string) => {
    setView('kanban')
    window.setTimeout(() => colRefs.current[key]?.scrollIntoView({ behavior: 'smooth', inline: 'start', block: 'nearest' }), 50)
  }

  return (
    <>
      <div className="card" style={{ marginBottom: 10, padding: '10px 12px' }}>
        {data ? <FunnelStrip cols={funnelCols} money={data.moneyVisible} onPick={jumpTo} /> : <Empty>Đang tải bảng bước khách…</Empty>}
      </div>

      <div className="pl-toolbar">
        <div className="seg" role="tablist" aria-label="Kiểu xem">
          {VIEWS.map((v) => (
            <button key={v.key} className={view === v.key ? 'on' : ''} onClick={() => setView(v.key)}>
              {v.label}
            </button>
          ))}
        </div>
        <button className={`fchip ${filters.mine ? 'on' : ''}`} onClick={() => toggle('mine')}>
          Của tôi
        </button>
        <button className={`fchip ${filters.hot ? 'on' : ''}`} onClick={() => toggle('hot')}>
          Nóng
        </button>
        <button className={`fchip ${filters.overdue ? 'on' : ''}`} onClick={() => toggle('overdue')}>
          Quá hạn
        </button>
        {branches.length > 1 ? (
          <select className={`fchip-select ${filters.branchId ? 'on' : ''}`} value={filters.branchId ?? ''} onChange={(e) => pick('branchId', e.target.value)}>
            <option value="">Mọi cơ sở</option>
            {branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.shortName ?? b.name}
              </option>
            ))}
          </select>
        ) : null}
        <select className={`fchip-select ${filters.serviceId ? 'on' : ''}`} value={filters.serviceId ?? ''} onChange={(e) => pick('serviceId', e.target.value)}>
          <option value="">Mọi dịch vụ</option>
          {services.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        {channels.length ? (
          <select className={`fchip-select ${filters.channelId ? 'on' : ''}`} value={filters.channelId ?? ''} onChange={(e) => pick('channelId', e.target.value)}>
            <option value="">Mọi nguồn</option>
            {channels.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        ) : null}
        {campaigns.length ? (
          <select className={`fchip-select ${filters.campaignId ? 'on' : ''}`} value={filters.campaignId ?? ''} onChange={(e) => pick('campaignId', e.target.value)}>
            <option value="">Mọi quảng cáo</option>
            {campaigns.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        ) : null}
        {activeCount ? (
          <button className="btn sec sm" onClick={() => setFilters({})}>
            Bỏ lọc ({activeCount})
          </button>
        ) : null}
        <input className="input" style={{ width: 180, marginLeft: 'auto' }} placeholder="Tìm tên, mã, SĐT" value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="btn sec sm" onClick={() => void load()}>
          Tải lại
        </button>
      </div>

      {!data ? null : view === 'kanban' ? (
        <>
          <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
            {canMove ? 'Kéo thẻ sang cột khác để đổi bước: cột cần lịch hoặc hợp đồng sẽ mở sẵn form đặt lịch, tạo hợp đồng; mỗi thẻ là một cơ hội.' : 'Chỉ xem: bạn không có quyền đổi bước khách.'}
            {!data.moneyVisible ? ' Số tiền chỉ hiện với quản lý, kế toán.' : ''}
          </div>
          <div className="kb">
            {data.columns.map((col) => (
              <div
                key={col.key}
                ref={(el) => {
                  colRefs.current[col.key] = el
                }}
                className={`kb-col ${over === col.key ? 'drop' : ''} ${col.overWip ? 'over-wip' : ''}`}
                onDragOver={(e) => {
                  if (!dragging || !canMove) return
                  e.preventDefault()
                  setOver(col.key)
                }}
                onDragLeave={() => setOver((o) => (o === col.key ? null : o))}
                onDrop={(e) => {
                  e.preventDefault()
                  setOver(null)
                  if (!dragging || !canMove) return
                  drop({ customerId: dragging.card.id, customerName: dragging.card.name, opportunityId: dragging.card.opportunityId, from: dragging.from, to: col.key })
                  setDragging(null)
                }}
              >
                <div className="kb-head">
                  <span className="dot" style={{ background: col.fg }} />
                  {col.label} · {col.count}
                </div>
                <div className="kb-sub">
                  {data.moneyVisible && col.totalValue ? vndShort(col.totalValue) : ''}
                  {data.moneyVisible && col.totalValue && col.overdueCount ? ' · ' : ''}
                  {col.overdueCount ? <span className="t-over">{col.overdueCount} quá hạn</span> : null}
                  {!col.overdueCount && col.warnCount ? <span className="t-warn">{col.warnCount} sắp quá hạn</span> : null}
                  {col.overWip ? <span className="t-wip" title="Giới hạn số thẻ của cột (Cài đặt pipeline.wipLimits)"> · vượt giới hạn {col.wipLimit}</span> : null}
                </div>
                {col.subStages.length ? (
                  <div className="subst">
                    {col.subStages.map((s) => (
                      <span key={s.key}>
                        {s.label}: {s.count}
                      </span>
                    ))}
                  </div>
                ) : null}
                <div className="kb-list">
                  {col.items.length === 0 ? <div className="kb-empty">Trống</div> : null}
                  {col.items.map((c) => (
                    <KanbanCard
                      key={c.opportunityId ?? c.id}
                      card={c}
                      col={col}
                      draggable={canMove}
                      onDragStart={() => setDragging({ card: c, from: col.key })}
                      onDragEnd={() => setDragging(null)}
                      onOpen={() => navigate(`/khach-hang/${c.id}`)}
                      lostLabel={col.lost && c.lostReason ? clinic.lostReasonLabel(c.lostReason) : null}
                    />
                  ))}
                  {col.count > col.items.length ? (
                    <button className="btn sec sm" onClick={() => navigate(`/khach-hang?stage=${col.key}`)}>
                      Xem tất cả {col.count}
                    </button>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        </>
      ) : view === 'funnel' ? (
        <FunnelView data={data} />
      ) : (
        <TableView data={data} onOpen={(id) => navigate(`/khach-hang/${id}`)} />
      )}
      {modals}
    </>
  )
}

function KanbanCard({
  card: c,
  col,
  draggable,
  onDragStart,
  onDragEnd,
  onOpen,
  lostLabel
}: {
  card: PipelineCard
  col: PipelineColumn
  draggable: boolean
  onDragStart: () => void
  onDragEnd: () => void
  onOpen: () => void
  lostLabel: string | null
}): React.JSX.Element {
  const depositCol = col.key === 'LICH_COC' || col.key === 'HEN'
  // Tên dịch vụ lấy từ cơ hội; cơ hội không có dịch vụ (dữ liệu cũ) mới dùng dịch vụ quan tâm.
  const service = c.serviceName ?? (c.opportunityCount > 1 ? null : c.interest[0]) ?? (c.valueSource === 'QUOTE' ? 'Có báo giá' : c.valueSource === 'PLAN' ? 'Có phác đồ' : null)
  return (
    <div className={`kb-card ${c.ageLevel}`} draggable={draggable} onDragStart={onDragStart} onDragEnd={onDragEnd} onClick={onOpen}>
      <div className="top">
        <b title={c.name}>{c.name}</b>
        {depositCol && c.deposit ? <DepositChip deposit={c.deposit} /> : <HeatChip heat={c.heat} title={c.heatFactors.join(', ') || HEAT_LABEL[c.heat]} />}
      </div>
      {c.opportunityCount > 1 && c.opportunityTitle ? <div className="opp">Cơ hội: {c.opportunityTitle}</div> : null}
      {c.subStage ? <div className="ln">{col.subStages.find((s) => s.key === c.subStage)?.label ?? c.subStage}</div> : null}
      <div className="ln strong">
        {service ?? 'Chưa rõ dịch vụ'}
        {c.expectedValue != null ? ` · ${vndShort(c.expectedValue)}` : ''}
      </div>
      {col.lost ? (
        lostLabel ? <div className="ln t-over">{lostLabel}</div> : null
      ) : (
        <div className={`ln ${ageClass(c.ageLevel)}`} title={c.maxDays ? `Tối đa ${c.maxDays} ngày ở bước này` : 'Bước này không tính quá hạn'}>
          {daysText(c.daysInStage)}
          {c.ageLevel === 'OVERDUE' ? ' · quá hạn' : c.ageLevel === 'WARN' ? ' · sắp quá hạn' : ''}
        </div>
      )}
      {c.nextTask ? (
        <div className={`ln ${c.nextTask.overdue ? 't-over' : ''}`} title={c.nextTask.title}>
          → {c.nextTask.title}
          {c.nextTask.dueAt ? ` · ${dateVi(c.nextTask.dueAt)}` : ''}
        </div>
      ) : c.nextAppointmentAt ? (
        <div className="ln">→ Hẹn {dateVi(c.nextAppointmentAt)}</div>
      ) : (
        <div className="ln">→ Chưa có việc kế tiếp</div>
      )}
      {c.upsellHint?.length ? <div className="upsell">Gợi ý kèm: {c.upsellHint.join(', ')}</div> : null}
      <div className="ln" style={{ fontSize: 11 }}>
        {[c.assignedTo?.name ?? c.telesale?.name ?? 'Chưa phân công', c.channel?.name].filter(Boolean).join(' · ')}
      </div>
    </div>
  )
}

/* Dải phễu hình khối: khối cao theo số khách, tiền dưới khối, % chuyển giữa hai khối. */
function FunnelStrip({
  cols,
  money,
  onPick,
  big
}: {
  cols: PipelineColumn[]
  money: boolean
  onPick?: (key: string) => void
  big?: boolean
}): React.JSX.Element {
  const max = Math.max(1, ...cols.map((c) => c.count))
  const H = big ? 150 : 84
  return (
    <div className={`fstrip ${big ? 'big' : ''}`} aria-label="Dải phễu bước khách">
      {cols.map((c, i) => (
        <React.Fragment key={c.key}>
          {i > 0 ? (
            <div className={`fconv ${cols[i - 1].conversion?.rate == null ? 'nil' : ''}`} title={cols[i - 1].conversion ? `${cols[i - 1].conversion!.moved}/${cols[i - 1].conversion!.entered} khách vào bước trong kỳ đã đi tiếp` : undefined}>
              → {pct(cols[i - 1].conversion?.rate)}
            </div>
          ) : null}
          <div className="fb" onClick={() => onPick?.(c.key)} title={`${c.label}: ${c.count} khách`}>
            <div className="blk" style={{ height: Math.max(18, Math.round((c.count / max) * H)), background: c.fg }}>
              {c.count}
            </div>
            <div className="nm">{c.label}</div>
            <div className="val">{money ? (c.totalValue ? vndShort(c.totalValue) : '0đ') : c.overdueCount ? `${c.overdueCount} quá hạn` : ' '}</div>
          </div>
        </React.Fragment>
      ))}
    </div>
  )
}

function FunnelView({ data }: { data: Pipeline }): React.JSX.Element {
  const cols = data.columns.filter((c) => c.inFunnel)
  return (
    <div className="card">
      <div className="sec-title">Phễu bước khách · tỉ lệ chuyển {data.periodDays} ngày gần nhất</div>
      <FunnelStrip cols={cols} money={data.moneyVisible} big />
      <div style={{ overflowX: 'auto', marginTop: 10 }}>
        <table>
          <thead>
            <tr>
              <th>Bước</th>
              <th>Số khách</th>
              {data.moneyVisible ? <th>Giá trị dự kiến</th> : null}
              <th>Quá hạn</th>
              <th>Sắp quá hạn</th>
              <th>Vào bước trong kỳ</th>
              <th>Đã đi tiếp</th>
              <th>Tỉ lệ chuyển</th>
            </tr>
          </thead>
          <tbody>
            {data.columns.map((c) => (
              <tr key={c.key}>
                <td>
                  <span className="tag" style={{ background: c.bg, color: c.fg }}>
                    {c.label}
                  </span>
                </td>
                <td>{c.count}</td>
                {data.moneyVisible ? <td>{c.totalValue != null ? vndShort(c.totalValue) : '—'}</td> : null}
                <td className={c.overdueCount ? 't-over' : ''}>{c.overdueCount}</td>
                <td className={c.warnCount ? 't-warn' : ''}>{c.warnCount}</td>
                <td>{c.conversion?.entered ?? '—'}</td>
                <td>{c.conversion?.moved ?? '—'}</td>
                <td>
                  <b>{c.conversion ? pct(c.conversion.rate) : '—'}</b>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="muted" style={{ fontSize: 11.5, marginTop: 8 }}>
        Tỉ lệ chuyển đọc lịch sử bước thật: khách vào bước trong kỳ rồi đã sang một bước sau. Chưa có ai vào bước trong kỳ thì hiện “–”.
      </div>
    </div>
  )
}

function TableView({ data, onOpen }: { data: Pipeline; onOpen: (id: string) => void }): React.JSX.Element {
  const clinic = useClinic()
  const rows = data.columns.flatMap((c) => c.items)
  if (!rows.length) return <div className="card"><Empty>Không có khách khớp bộ lọc.</Empty></div>
  return (
    <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
      <table>
        <thead>
          <tr>
            <th>Khách</th>
            <th>Bước</th>
            <th>Ở bước</th>
            <th>Nhiệt độ</th>
            <th>Cọc</th>
            {data.moneyVisible ? <th>Giá trị dự kiến</th> : null}
            <th>Việc kế tiếp</th>
            <th>Phụ trách</th>
            <th>Nguồn</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => {
            const st = clinic.stageStyle(c.stage)
            return (
              <tr key={c.opportunityId ?? c.id} className="clickable" onClick={() => onOpen(c.id)}>
                <td>
                  <b>{c.name}</b>
                  <div className="muted" style={{ fontSize: 11.5 }}>{c.code}</div>
                </td>
                <td>
                  <span className="tag" style={{ background: st.bg, color: st.fg }}>
                    {st.t}
                  </span>
                </td>
                <td className={ageClass(c.ageLevel)}>{c.daysInStage} ngày</td>
                <td>
                  <HeatChip heat={c.heat} />
                </td>
                <td>
                  <DepositChip deposit={c.deposit} />
                </td>
                {data.moneyVisible ? <td>{c.expectedValue != null ? vndShort(c.expectedValue) : '—'}</td> : null}
                <td className={c.nextTask?.overdue ? 't-over' : ''}>
                  {c.nextTask ? `${c.nextTask.title}${c.nextTask.dueAt ? ` · ${dateVi(c.nextTask.dueAt)}` : ''}` : '—'}
                </td>
                <td>{c.assignedTo?.name ?? c.telesale?.name ?? '—'}</td>
                <td>{c.channel?.name ?? '—'}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <div className="muted" style={{ fontSize: 11.5, padding: '8px 12px' }}>
        Bảng hiện tối đa 30 khách mỗi bước, quá hạn và nóng xếp trước. Xem đủ ở màn Khách hàng.
      </div>
    </div>
  )
}
