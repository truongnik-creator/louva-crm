import React, { useCallback, useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { fetchServices, getApiErrorMessage } from '../lib/api'
import {
  createPromotion,
  decideDiscount,
  fetchDiscountApprovals,
  fetchLeakage,
  fetchPromotions,
  updatePromotion,
  vndText,
  type ApprovalRow,
  type LeakageRow,
  type PromotionRow
} from '../lib/api-lo4'
import { useAuth } from '../lib/auth-context'
import { dateVi, dateTimeVi } from '../lib/format'
import { Empty, Modal, useToast } from '../components/ui'
import type { Service } from '../lib/types'

/* F13 + F21: ĐỢT ƯU ĐÃI, DUYỆT GIẢM GIÁ, RÒ RỈ CHIẾT KHẤU.
   Sale chỉ giảm được qua đợt ưu đãi đang chạy; giảm ngoài đợt vượt trần của vai
   thì báo giá chờ quản lý duyệt. Báo cáo rò rỉ cho thấy ai, dịch vụ nào, tháng
   nào đang giảm ngoài ưu đãi. */

const STATE_LABEL: Record<string, { t: string; bg: string; fg: string }> = {
  ACTIVE: { t: 'Đang chạy', bg: '#DCFCE7', fg: '#15803D' },
  UPCOMING: { t: 'Sắp chạy', bg: '#DBEAFE', fg: '#1D4ED8' },
  ENDED: { t: 'Đã kết thúc', bg: '#F1F5F9', fg: '#475569' },
  FULL: { t: 'Hết suất (khoá)', bg: '#FEE2E2', fg: '#B91C1C' },
  PAUSED: { t: 'Tạm dừng', bg: '#FEF3C7', fg: '#B45309' }
}

type Tab = 'promotions' | 'approvals' | 'leakage'

export default function Promotions(): React.JSX.Element {
  const { can } = useAuth()
  const location = useLocation()
  const navigate = useNavigate()
  const initial: Tab = location.pathname.startsWith('/duyet-giam-gia') ? 'approvals' : 'promotions'
  const [tab, setTab] = useState<Tab>(initial)

  const tabs: Array<{ key: Tab; t: string; show: boolean }> = [
    { key: 'promotions', t: 'Đợt ưu đãi', show: true },
    { key: 'approvals', t: 'Duyệt giảm giá', show: can('sales_order.approve_discount') },
    { key: 'leakage', t: 'Rò rỉ chiết khấu', show: can('sales_order.approve_discount') || can('accounting.read') }
  ]

  return (
    <>
      <div className="row" style={{ gap: 6, marginBottom: 12 }}>
        {tabs.filter((t) => t.show).map((t) => (
          <button
            key={t.key}
            className={`btn sm${tab === t.key ? '' : ' sec'}`}
            onClick={() => {
              setTab(t.key)
              navigate(t.key === 'approvals' ? '/duyet-giam-gia' : '/uu-dai', { replace: true })
            }}
          >
            {t.t}
          </button>
        ))}
      </div>
      {tab === 'promotions' ? <PromotionList /> : tab === 'approvals' ? <Approvals /> : <Leakage />}
    </>
  )
}

function PromotionList(): React.JSX.Element {
  const { can } = useAuth()
  const { say, fail } = useToast()
  const [rows, setRows] = useState<PromotionRow[]>([])
  const [creating, setCreating] = useState(false)

  const load = useCallback(async () => {
    try {
      setRows(await fetchPromotions())
    } catch (err) {
      fail(getApiErrorMessage(err))
    }
  }, [fail])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
      <div className="row" style={{ padding: '10px 14px' }}>
        <b>Đợt ưu đãi</b>
        {can('promotion.manage') ? (
          <button className="btn sm" style={{ marginLeft: 'auto' }} onClick={() => setCreating(true)}>
            Tạo đợt ưu đãi
          </button>
        ) : null}
      </div>
      {!rows.length ? (
        <Empty>Chưa có đợt ưu đãi nào. Không có đợt nào thì sale không giảm được giá nếu không có quản lý duyệt.</Empty>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Mã, tên</th>
              <th>Mức giảm</th>
              <th>Suất</th>
              <th>Thời gian</th>
              <th>Dịch vụ</th>
              <th>Trạng thái</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => {
              const st = STATE_LABEL[p.state]
              return (
                <tr key={p.id}>
                  <td>
                    <b>{p.code}</b>
                    <div className="muted" style={{ fontSize: 12 }}>{p.name}</div>
                  </td>
                  <td>{p.kind === 'PERCENT' ? `${p.value}%` : `${vndText(p.value)} mỗi đơn vị`}</td>
                  <td>{p.maxSlots != null ? `${p.usedSlots}/${p.maxSlots}` : `${p.usedSlots} (không giới hạn)`}</td>
                  <td style={{ fontSize: 12 }}>{dateVi(p.startAt)} đến {dateVi(p.endAt)}</td>
                  <td style={{ fontSize: 12 }}>{p.services.length ? p.services.map((s) => s.service.name).join(', ') : 'Mọi dịch vụ'}</td>
                  <td>
                    <span className="tag" style={{ background: st.bg, color: st.fg }}>{st.t}</span>
                  </td>
                  <td>
                    {can('promotion.manage') ? (
                      <button
                        className="btn sec sm"
                        onClick={async () => {
                          try {
                            await updatePromotion(p.id, { active: !p.active })
                            say(p.active ? 'Đã tạm dừng.' : 'Đã chạy lại.')
                            void load()
                          } catch (err) {
                            fail(getApiErrorMessage(err))
                          }
                        }}
                      >
                        {p.active ? 'Tạm dừng' : 'Chạy lại'}
                      </button>
                    ) : null}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
      {creating ? <PromotionForm onClose={() => setCreating(false)} onDone={() => { setCreating(false); void load() }} /> : null}
    </div>
  )
}

function PromotionForm({ onClose, onDone }: { onClose: () => void; onDone: () => void }): React.JSX.Element {
  const { say, fail } = useToast()
  const [services, setServices] = useState<Service[]>([])
  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const [kind, setKind] = useState<'PERCENT' | 'AMOUNT'>('PERCENT')
  const [value, setValue] = useState(10)
  const [slots, setSlots] = useState('')
  const [start, setStart] = useState(() => new Date().toISOString().slice(0, 10))
  const [end, setEnd] = useState(() => new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10))
  const [picked, setPicked] = useState<string[]>([])

  useEffect(() => {
    fetchServices().then(setServices).catch(() => undefined)
  }, [])

  const submit = async (): Promise<void> => {
    try {
      await createPromotion({
        code,
        name,
        kind,
        value,
        maxSlots: slots ? Number(slots) : null,
        startAt: new Date(`${start}T00:00:00+07:00`).toISOString(),
        endAt: new Date(`${end}T23:59:59+07:00`).toISOString(),
        serviceIds: picked
      })
      say('Đã tạo đợt ưu đãi.')
      onDone()
    } catch (err) {
      fail(getApiErrorMessage(err))
    }
  }

  return (
    <Modal
      title="Tạo đợt ưu đãi"
      onClose={onClose}
      width={640}
      footer={
        <>
          <button className="btn sec" onClick={onClose}>Huỷ</button>
          <button className="btn" onClick={() => void submit()} disabled={!code || !name || value <= 0}>Tạo</button>
        </>
      }
    >
      <div className="grid" style={{ gridTemplateColumns: '1fr 2fr', gap: 8 }}>
        <div className="field"><label>Mã</label><input className="input" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="THANG10" /></div>
        <div className="field"><label>Tên đợt</label><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></div>
        <div className="field">
          <label>Kiểu giảm</label>
          <select className="input" value={kind} onChange={(e) => setKind(e.target.value as 'PERCENT' | 'AMOUNT')}>
            <option value="PERCENT">Theo %</option>
            <option value="AMOUNT">Số tiền mỗi đơn vị</option>
          </select>
        </div>
        <div className="field"><label>{kind === 'PERCENT' ? 'Giảm (%)' : 'Giảm (đồng)'}</label><input className="input" type="number" value={value} onChange={(e) => setValue(Number(e.target.value))} /></div>
        <div className="field"><label>Số suất (trống = không giới hạn)</label><input className="input" type="number" min={1} value={slots} onChange={(e) => setSlots(e.target.value)} /></div>
        <div className="field"><label>Từ ngày, đến ngày</label>
          <div className="row" style={{ gap: 6 }}>
            <input className="input" type="date" value={start} onChange={(e) => setStart(e.target.value)} />
            <input className="input" type="date" value={end} onChange={(e) => setEnd(e.target.value)} />
          </div>
        </div>
      </div>
      <div className="field">
        <label>Dịch vụ áp dụng (không chọn = mọi dịch vụ)</label>
        <div style={{ maxHeight: 200, overflow: 'auto', border: '1px solid var(--border)', borderRadius: 6, padding: 6 }}>
          {services.map((s) => (
            <label key={s.id} className="row" style={{ gap: 6, fontSize: 13 }}>
              <input
                type="checkbox"
                checked={picked.includes(s.id)}
                onChange={(e) => setPicked((p) => (e.target.checked ? [...p, s.id] : p.filter((x) => x !== s.id)))}
              />
              {s.name}
            </label>
          ))}
        </div>
      </div>
    </Modal>
  )
}

function Approvals(): React.JSX.Element {
  const { say, fail } = useToast()
  const navigate = useNavigate()
  const [status, setStatus] = useState('PENDING')
  const [rows, setRows] = useState<ApprovalRow[]>([])

  const load = useCallback(async () => {
    try {
      setRows(await fetchDiscountApprovals(status))
    } catch (err) {
      fail(getApiErrorMessage(err))
    }
  }, [status, fail])

  useEffect(() => {
    void load()
  }, [load])

  const decide = async (r: ApprovalRow, decision: 'APPROVE' | 'REJECT'): Promise<void> => {
    const note = window.prompt(decision === 'APPROVE' ? 'Ghi chú duyệt (không bắt buộc):' : 'Lý do từ chối:') ?? undefined
    try {
      await decideDiscount(r.id, decision, note || undefined)
      say(decision === 'APPROVE' ? 'Đã duyệt.' : 'Đã từ chối.')
      void load()
    } catch (err) {
      fail(getApiErrorMessage(err))
    }
  }

  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
      <div className="row" style={{ padding: '10px 14px', gap: 6 }}>
        <b>Báo giá giảm vượt trần</b>
        <select className="input" style={{ marginLeft: 'auto', maxWidth: 180 }} value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="PENDING">Chờ duyệt</option>
          <option value="APPROVED">Đã duyệt</option>
          <option value="REJECTED">Đã từ chối</option>
        </select>
      </div>
      {!rows.length ? (
        <Empty>Không có báo giá nào.</Empty>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Báo giá</th>
              <th>Khách</th>
              <th>Dòng giảm</th>
              <th>Giảm ngoài ưu đãi</th>
              <th>Người lập</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>
                  <b>{r.code}</b>
                  <div className="muted" style={{ fontSize: 11.5 }}>{dateTimeVi(r.createdAt)} · {vndText(r.total)}</div>
                </td>
                <td style={{ cursor: 'pointer' }} onClick={() => navigate(`/khach-hang/${r.customer.id}`)}>{r.customer.name}</td>
                <td style={{ fontSize: 12 }}>
                  {r.items
                    .filter((i) => i.discountAmount > i.promotionDiscount)
                    .map((i) => (
                      <div key={i.id}>
                        {i.name}: niêm yết {vndText((i.listPrice ?? i.unitPrice) * i.quantity)}, bán {vndText(i.amount)}
                        {i.discountReason ? <span className="muted"> ({i.discountReason})</span> : null}
                      </div>
                    ))}
                </td>
                <td><b>{r.maxExcessPercent}%</b></td>
                <td>{r.createdBy?.name ?? ''}</td>
                <td>
                  {r.approvalStatus === 'PENDING' ? (
                    <>
                      <button className="btn sm" onClick={() => void decide(r, 'APPROVE')}>Duyệt</button>
                      <button className="btn sec sm" style={{ marginLeft: 4 }} onClick={() => void decide(r, 'REJECT')}>Từ chối</button>
                    </>
                  ) : (
                    <span className="muted" style={{ fontSize: 12 }}>{r.approvalNote ?? ''}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

function Leakage(): React.JSX.Element {
  const { fail } = useToast()
  const [groupBy, setGroupBy] = useState<'sales' | 'service' | 'month'>('sales')
  const [period, setPeriod] = useState('month')
  const [data, setData] = useState<{ rows: LeakageRow[]; total: LeakageRow } | null>(null)

  useEffect(() => {
    fetchLeakage({ groupBy, period })
      .then(setData)
      .catch((err) => fail(getApiErrorMessage(err)))
  }, [groupBy, period, fail])

  const line = (r: LeakageRow, bold = false): React.JSX.Element => (
    <tr key={r.key} style={bold ? { fontWeight: 700 } : undefined}>
      <td>{r.label}</td>
      <td>{r.lines}</td>
      <td>{vndText(r.listTotal)}</td>
      <td>{vndText(r.netTotal)}</td>
      <td>{vndText(r.promotionDiscount)}</td>
      <td style={{ color: r.leakage ? 'var(--danger)' : undefined }}>{vndText(r.leakage)}</td>
      <td>{vndText(r.approvedLeakage)}</td>
      <td>{r.leakagePercent}%</td>
    </tr>
  )

  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
      <div className="row" style={{ padding: '10px 14px', gap: 6 }}>
        <b>Rò rỉ chiết khấu (giảm ngoài đợt ưu đãi, hợp đồng đã ký)</b>
        <select className="input" style={{ marginLeft: 'auto', maxWidth: 150 }} value={period} onChange={(e) => setPeriod(e.target.value)}>
          <option value="month">Tháng này</option>
          <option value="quarter">Quý này</option>
          <option value="7d">7 ngày</option>
        </select>
        <select className="input" style={{ maxWidth: 150 }} value={groupBy} onChange={(e) => setGroupBy(e.target.value as 'sales' | 'service' | 'month')}>
          <option value="sales">Theo sale</option>
          <option value="service">Theo dịch vụ</option>
          <option value="month">Theo tháng</option>
        </select>
      </div>
      {!data ? (
        <Empty>Đang tải…</Empty>
      ) : (
        <table>
          <thead>
            <tr>
              <th>{groupBy === 'sales' ? 'Sale' : groupBy === 'service' ? 'Dịch vụ' : 'Tháng'}</th>
              <th>Dòng</th>
              <th>Giá niêm yết</th>
              <th>Thực bán</th>
              <th>Giảm qua ưu đãi</th>
              <th>Rò rỉ</th>
              <th>Trong đó có duyệt</th>
              <th>% rò rỉ</th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map((r) => line(r))}
            {line(data.total, true)}
          </tbody>
        </table>
      )}
    </div>
  )
}
