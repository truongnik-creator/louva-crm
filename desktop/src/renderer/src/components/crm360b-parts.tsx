import React, { useCallback, useEffect, useRef, useState } from 'react'
import { createAppointment, fetchServices, getApiErrorMessage } from '../lib/api'
import { useAuth } from '../lib/auth-context'
import { useClinic } from '../lib/clinic-context'
import { dateTimeVi, dateVi, toISODate, vnd, vndShort } from '../lib/format'
import {
  cancelPackage,
  consumePackageSession,
  createPackage,
  fetchCustomerQuotations,
  fetchDropPlan,
  fetchNeeds,
  fetchOpportunities,
  fetchPackages,
  fetchTimeline,
  logCall,
  openOpportunity,
  saveNeeds,
  setQuotationStatus,
  suggestNeeds,
  updateOpportunity,
  type DropPlan,
  type NeedsOptions,
  type NeedsProfile,
  type OpportunityRow,
  type PackageRow,
  type QuotationRow,
  type TimelineItem,
  type TimelineKind
} from '../lib/api-lo8'
import type { Appointment } from '../lib/types'
import { DepositPanel } from './deposit-parts'
import { DealModal } from './clinical-forms'
import { QuoteOptionsPanel, ageClass, daysText, useMoneyVisible } from './crm360-parts'
import { useStageChanger, type StageChangeRequest } from './stage-parts'
import { Empty, Modal, Tag, useToast } from './ui'

/* Lô 8 · CRM 360 Lô B: mảnh giao diện dùng chung cho bảng bước khách (thả thẻ
   mở form) và hồ sơ khách (cơ hội, hồ sơ nhu cầu, dòng thời gian đa kênh, gói
   liệu trình, báo giá bị từ chối). */

function errorAction(err: unknown): string | null {
  const data = (err as { response?: { data?: { action?: string } } })?.response?.data
  return data?.action ?? null
}

/* ----------------------------------------------------------- ĐẶT LỊCH NHANH */

export function QuickBookModal({
  customerId,
  customerName,
  onClose,
  onDone
}: {
  customerId: string
  customerName: string
  onClose: () => void
  onDone: () => void
}): React.JSX.Element {
  const clinic = useClinic()
  const { say, fail } = useToast()
  const tomorrow = new Date(Date.now() + 86_400_000)
  const [date, setDate] = useState(toISODate(tomorrow))
  const [time, setTime] = useState('10:00')
  const [title, setTitle] = useState('Hẹn tư vấn')
  const [serviceId, setServiceId] = useState('')
  const [deposit, setDeposit] = useState(String(clinic.deposit.defaultAmount || 0))
  const [services, setServices] = useState<Array<{ id: string; name: string }>>([])
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    fetchServices().then((s) => setServices(s.map((x) => ({ id: x.id, name: x.name })))).catch(() => undefined)
  }, [])
  const submit = async (): Promise<void> => {
    setBusy(true)
    try {
      await createAppointment({
        customerId,
        title: title.trim() || 'Hẹn tư vấn',
        serviceId: serviceId || null,
        startAt: new Date(`${date}T${time}:00+07:00`).toISOString(),
        depositAmount: Number(deposit.replace(/\D/g, '')) || 0
      })
      say(`Đã đặt lịch cho ${customerName}.`)
      onDone()
    } catch (err) {
      fail(getApiErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal
      title={`Đặt lịch: ${customerName}`}
      onClose={onClose}
      width={460}
      footer={
        <>
          <button className="btn sec" onClick={onClose}>
            Huỷ
          </button>
          <button className="btn" disabled={busy || !date || !time} onClick={() => void submit()}>
            {busy ? 'Đang lưu…' : 'Đặt lịch'}
          </button>
        </>
      }
    >
      <div className="alert" style={{ marginBottom: 10 }}>Sang bước này phải có lịch hẹn. Đặt lịch xong thẻ tự chuyển bước.</div>
      <div className="grid2">
        <div className="field">
          <label>Ngày</label>
          <input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        <div className="field">
          <label>Giờ</label>
          <input className="input" type="time" value={time} onChange={(e) => setTime(e.target.value)} />
        </div>
      </div>
      <div className="field">
        <label>Nội dung</label>
        <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
      </div>
      <div className="field">
        <label>Dịch vụ</label>
        <select className="input" value={serviceId} onChange={(e) => setServiceId(e.target.value)}>
          <option value="">Chưa chọn</option>
          {services.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label>Tiền cọc yêu cầu (đồng, 0 = không cọc)</label>
        <input className="input" inputMode="numeric" value={deposit} onChange={(e) => setDeposit(e.target.value)} />
      </div>
    </Modal>
  )
}

/* ---------------------------------------------------- P5 THẢ THẺ MỞ HÀNH ĐỘNG */

export interface DropTarget {
  customerId: string
  customerName: string
  opportunityId?: string | null
  from: string
  to: string
}

/**
 * P4 + P5: thả thẻ vào cột thì hỏi máy chủ cột đó cần gì. Thiếu lịch: mở đặt lịch,
 * đặt xong tự chuyển; thiếu hợp đồng: mở tạo hợp đồng; mất khách hoặc lùi bước: hỏi
 * lý do; có lịch chưa cọc: chuyển rồi mở khối cọc (VietQR); vào cột đến quầy:
 * chuyển rồi mở báo giá 3 phương án.
 */
export function useDropActions(onReload: () => void): { drop: (t: DropTarget) => void; modals: React.ReactNode } {
  const { fail } = useToast()
  const { can } = useAuth()
  const [book, setBook] = useState<DropTarget | null>(null)
  const [contract, setContract] = useState<DropTarget | null>(null)
  const [after, setAfter] = useState<{ t: DropTarget; plan: DropPlan } | null>(null)
  const pendingAfter = useRef<{ t: DropTarget; plan: DropPlan } | null>(null)

  const onDone = useCallback(() => {
    onReload()
    if (pendingAfter.current) {
      setAfter(pendingAfter.current)
      pendingAfter.current = null
    }
  }, [onReload])

  const toTarget = (r: StageChangeRequest): DropTarget => ({ customerId: r.customerId, customerName: r.customerName, opportunityId: r.opportunityId, from: r.from, to: r.to })
  const { request, modal } = useStageChanger(onDone, (r, err) => {
    const action = errorAction(err)
    if (action === 'BOOK') {
      setBook(toTarget(r))
      return true
    }
    if (action === 'CONTRACT') {
      fail(getApiErrorMessage(err))
      if (can('finance.create')) setContract(toTarget(r))
      return true
    }
    return false
  })

  const move = useCallback(
    (t: DropTarget) => request({ customerId: t.customerId, customerName: t.customerName, opportunityId: t.opportunityId, from: t.from, to: t.to }),
    [request]
  )

  const drop = useCallback(
    (t: DropTarget) => {
      if (t.from === t.to) return
      fetchDropPlan({ opportunityId: t.opportunityId, customerId: t.customerId }, t.to)
        .then((plan) => {
          if (plan.action === 'BOOK') return setBook(t)
          if (plan.action === 'CONTRACT') {
            if (!can('finance.create')) return fail(plan.message ?? 'Sang bước này phải có hợp đồng')
            return setContract(t)
          }
          if ((plan.action === 'DEPOSIT' || plan.action === 'QUOTE') && !plan.blocking) pendingAfter.current = { t, plan }
          move(t)
        })
        .catch((err) => fail(getApiErrorMessage(err)))
    },
    [move, fail, can]
  )

  const modals = (
    <>
      {modal}
      {book ? (
        <QuickBookModal
          customerId={book.customerId}
          customerName={book.customerName}
          onClose={() => setBook(null)}
          onDone={() => {
            const t = book
            setBook(null)
            move(t)
          }}
        />
      ) : null}
      {contract ? (
        <DealModal
          customerId={contract.customerId}
          mode="contract"
          onClose={() => setContract(null)}
          onDone={() => {
            const t = contract
            setContract(null)
            move(t)
          }}
        />
      ) : null}
      {after?.plan.action === 'DEPOSIT' && after.plan.appointment ? (
        <Modal title={`Thu cọc: ${after.t.customerName}`} onClose={() => setAfter(null)} width={480}>
          <div className="muted" style={{ fontSize: 12.5, marginBottom: 8 }}>
            Lịch {dateTimeVi(after.plan.appointment.startAt)} chưa cọc. Gửi mã VietQR hoặc xác nhận đã nhận cọc.
          </div>
          <DepositPanel appointment={after.plan.appointment as unknown as Appointment} onChanged={onReload} />
        </Modal>
      ) : null}
      {after?.plan.action === 'QUOTE' ? (
        <Modal title={`Lập báo giá: ${after.t.customerName}`} onClose={() => setAfter(null)} width={980}>
          <QuoteOptionsPanel customerId={after.t.customerId} customerName={after.t.customerName} onChosen={onReload} />
        </Modal>
      ) : null}
    </>
  )
  return { drop, modals }
}

/* ------------------------------------------------------------- P6 CƠ HỘI */

const OPP_STATUS: Record<string, { t: string; bg: string; fg: string }> = {
  OPEN: { t: 'Đang mở', bg: 'var(--chip-cold-bg)', fg: 'var(--chip-cold-fg)' },
  WON: { t: 'Đã làm dịch vụ', bg: 'var(--chip-paid-bg)', fg: 'var(--chip-paid-fg)' },
  LOST: { t: 'Mất', bg: 'var(--chip-hot-bg)', fg: 'var(--chip-hot-fg)' }
}

export function OpportunitiesCard({ customerId, customerName, onChanged }: { customerId: string; customerName: string; onChanged: () => void }): React.JSX.Element {
  const clinic = useClinic()
  const { can } = useAuth()
  const { say, fail } = useToast()
  const money = useMoneyVisible()
  const [data, setData] = useState<{ currentId: string | null; items: OpportunityRow[] } | null>(null)
  const [adding, setAdding] = useState(false)
  const [open, setOpen] = useState<string | null>(null)
  const load = useCallback(() => {
    fetchOpportunities(customerId)
      .then(setData)
      .catch((err) => fail(getApiErrorMessage(err)))
  }, [customerId, fail])
  useEffect(() => load(), [load])
  const reload = () => {
    load()
    onChanged()
  }
  const { drop, modals } = useDropActions(reload)

  const setValue = async (o: OpportunityRow) => {
    const raw = window.prompt('Giá trị dự kiến (đồng). Để trống = tính tự động từ báo giá, phác đồ, bảng giá:', o.manualValue != null ? String(o.manualValue) : '')
    if (raw == null) return
    const n = raw.trim() ? Number(raw.replace(/\D/g, '')) : null
    try {
      await updateOpportunity(o.id, { expectedValue: n })
      say('Đã lưu giá trị dự kiến.')
      load()
    } catch (err) {
      fail(getApiErrorMessage(err))
    }
  }
  const setClose = async (o: OpportunityRow, v: string) => {
    try {
      await updateOpportunity(o.id, { expectedCloseAt: v ? new Date(`${v}T12:00:00+07:00`).toISOString() : null })
      load()
    } catch (err) {
      fail(getApiErrorMessage(err))
    }
  }

  return (
    <div className="card">
      <div className="row" style={{ marginBottom: 6 }}>
        <div className="sec-title" style={{ margin: 0 }}>Cơ hội bán</div>
        {can('customer.update') ? (
          <button className="btn sec sm" style={{ marginLeft: 'auto' }} onClick={() => setAdding(true)}>
            + Mở cơ hội mới
          </button>
        ) : null}
      </div>
      {!data ? (
        <Empty>Đang tải…</Empty>
      ) : data.items.length === 0 ? (
        <Empty>Chưa có cơ hội nào. Đổi bước lần đầu sẽ tự tạo cơ hội từ bước hiện tại của khách.</Empty>
      ) : (
        <div className="opp-list">
          {data.items.map((o) => (
            <div key={o.id} className={`opp-row ${o.id === data.currentId ? 'current' : ''}`}>
              <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                <b>{o.title}</b>
                <span className="hchip" style={{ background: OPP_STATUS[o.status].bg, color: OPP_STATUS[o.status].fg }}>
                  {OPP_STATUS[o.status].t}
                </span>
                {o.id === data.currentId ? <span className="muted" style={{ fontSize: 11 }}>bước của khách lấy theo cơ hội này</span> : null}
                <span style={{ marginLeft: 'auto' }}>
                  {can('customer.update') ? (
                    <select
                      className="input"
                      style={{ width: 'auto', padding: '2px 6px' }}
                      value={o.stage}
                      onChange={(e) => drop({ customerId, customerName, opportunityId: o.id, from: o.stage, to: e.target.value })}
                    >
                      {clinic.stages.map((s) => (
                        <option key={s.key} value={s.key}>
                          {s.label}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <Tag style={clinic.stageStyle(o.stage)} />
                  )}
                </span>
              </div>
              <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                <span className={ageClass(o.ageLevel)}>{daysText(o.daysInStage)}</span>
                {o.subStage ? ` · ${o.subStage === 'DA_COC' ? 'Đã cọc' : o.subStage === 'HEN_CHUA_COC' ? 'Đã hẹn chưa cọc' : o.subStage}` : ''}
                {o.owner ? ` · ${o.owner.name}` : ''}
                {money && o.expectedValue != null ? ` · ${vndShort(o.expectedValue)}${o.valueSource === 'MANUAL' ? ' (nhập tay)' : ''}` : ''}
                {o.lostReason ? ` · Lý do mất: ${clinic.lostReasonLabel(o.lostReason)}` : ''}
                {` · mở ${dateVi(o.createdAt)}`}
              </div>
              <div className="row" style={{ gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
                {money && can('customer.update') ? (
                  <button className="btn sec sm" onClick={() => void setValue(o)}>
                    Giá trị dự kiến
                  </button>
                ) : null}
                {can('customer.update') && o.status === 'OPEN' ? (
                  <label className="muted" style={{ fontSize: 12 }}>
                    Dự kiến chốt{' '}
                    <input className="input" type="date" style={{ width: 150, padding: '2px 6px' }} value={o.expectedCloseAt ? o.expectedCloseAt.slice(0, 10) : ''} onChange={(e) => void setClose(o, e.target.value)} />
                  </label>
                ) : null}
                <button className="btn sec sm" onClick={() => setOpen(open === o.id ? null : o.id)}>
                  {open === o.id ? 'Ẩn lịch sử' : `Lịch sử bước (${o.history.length})`}
                </button>
              </div>
              {open === o.id ? (
                <div style={{ marginTop: 6, fontSize: 12 }}>
                  {o.history.map((h) => (
                    <div key={h.id} className="muted" style={{ padding: '3px 0', borderBottom: '1px dashed var(--border)' }}>
                      {dateTimeVi(h.createdAt)} · {h.fromStage ? clinic.stageStyle(h.fromStage).t : 'Mở'} → {clinic.stageStyle(h.toStage).t}
                      {h.userName ? ` · ${h.userName}` : h.source === 'AUTO' ? ' · tự động' : ''}
                      {h.note ? ` · ${h.note}` : ''}
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      )}
      {adding ? (
        <OpenOpportunityModal
          customerId={customerId}
          onClose={() => setAdding(false)}
          onDone={() => {
            setAdding(false)
            reload()
          }}
        />
      ) : null}
      {modals}
    </div>
  )
}

function OpenOpportunityModal({ customerId, onClose, onDone }: { customerId: string; onClose: () => void; onDone: () => void }): React.JSX.Element {
  const clinic = useClinic()
  const { say, fail } = useToast()
  const [services, setServices] = useState<Array<{ id: string; name: string }>>([])
  const [serviceId, setServiceId] = useState('')
  const [title, setTitle] = useState('')
  const [stage, setStage] = useState(clinic.stages[0]?.key ?? '')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    fetchServices().then((s) => setServices(s.map((x) => ({ id: x.id, name: x.name })))).catch(() => undefined)
  }, [])
  const startStages = clinic.stages.filter((s) => !s.lost).slice(0, 5)
  const submit = async () => {
    setBusy(true)
    try {
      await openOpportunity(customerId, { serviceId: serviceId || null, title: title.trim() || null, stage, note: note.trim() || null })
      say('Đã mở cơ hội mới.')
      onDone()
    } catch (err) {
      fail(getApiErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal
      title="Mở cơ hội mới"
      onClose={onClose}
      width={460}
      footer={
        <>
          <button className="btn sec" onClick={onClose}>
            Huỷ
          </button>
          <button className="btn" disabled={busy || (!serviceId && !title.trim())} onClick={() => void submit()}>
            {busy ? 'Đang lưu…' : 'Mở cơ hội'}
          </button>
        </>
      }
    >
      <div className="muted" style={{ fontSize: 12.5, marginBottom: 8 }}>Dùng khi khách đã làm dịch vụ quay lại hỏi dịch vụ mới. Cơ hội cũ giữ nguyên lịch sử.</div>
      <div className="field">
        <label>Dịch vụ quan tâm</label>
        <select className="input" value={serviceId} onChange={(e) => setServiceId(e.target.value)}>
          <option value="">Chưa chọn</option>
          {services.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label>Tên cơ hội (khi chưa chọn dịch vụ)</label>
        <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Ví dụ: Trẻ hoá vùng mắt" />
      </div>
      <div className="field">
        <label>Bắt đầu ở bước</label>
        <select className="input" value={stage} onChange={(e) => setStage(e.target.value)}>
          {startStages.map((s) => (
            <option key={s.key} value={s.key}>
              {s.label}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label>Ghi chú</label>
        <input className="input" value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
    </Modal>
  )
}

/* ------------------------------------------------------- C3 HỒ SƠ NHU CẦU */

const EMPTY_NEEDS: NeedsProfile = { areas: [], budget: null, fears: [], decisionMaker: null, occasion: null, occasionDate: null, comparing: [], note: null }

export function NeedsCard({ customerId }: { customerId: string }): React.JSX.Element {
  const { can } = useAuth()
  const { say, fail } = useToast()
  const [opts, setOpts] = useState<NeedsOptions | null>(null)
  const [needs, setNeeds] = useState<NeedsProfile>(EMPTY_NEEDS)
  const [saved, setSaved] = useState<NeedsProfile>(EMPTY_NEEDS)
  const [compare, setCompare] = useState('')
  const [busy, setBusy] = useState(false)
  const [aiNote, setAiNote] = useState<string | null>(null)
  const edit = can('customer.update')
  useEffect(() => {
    fetchNeeds(customerId)
      .then((r) => {
        setOpts(r.options)
        setNeeds(r.needs)
        setSaved(r.needs)
      })
      .catch((err) => fail(getApiErrorMessage(err)))
  }, [customerId, fail])
  if (!opts) return <div className="card"><Empty>Đang tải hồ sơ nhu cầu…</Empty></div>
  const dirty = JSON.stringify({ ...needs, updatedAt: null, updatedBy: null }) !== JSON.stringify({ ...saved, updatedAt: null, updatedBy: null })
  const toggleMany = (k: 'areas' | 'fears', v: string) =>
    setNeeds((n) => ({ ...n, [k]: n[k].includes(v) ? n[k].filter((x) => x !== v) : [...n[k], v] }))
  const pickOne = (k: 'budget' | 'decisionMaker' | 'occasion', v: string) => setNeeds((n) => ({ ...n, [k]: n[k] === v ? null : v }))
  const save = async () => {
    setBusy(true)
    try {
      const r = await saveNeeds(customerId, needs)
      setNeeds(r.needs)
      setSaved(r.needs)
      say('Đã lưu hồ sơ nhu cầu.')
    } catch (err) {
      fail(getApiErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }
  const suggest = async () => {
    setAiNote(null)
    try {
      const r = await suggestNeeds(customerId)
      if (r.status !== 'OK') {
        setAiNote(
          r.status === 'NO_CONSENT'
            ? 'Khách chưa đồng ý xử lý dữ liệu bằng AI nên không gợi ý.'
            : r.status === 'NOT_CONFIGURED'
              ? 'Máy chủ chưa cấu hình AI.'
              : r.status === 'DISABLED'
                ? 'AI tách thông tin đang tắt trong Cài đặt.'
                : r.status === 'NO_MESSAGES'
                  ? 'Khách chưa có tin nhắn để gợi ý.'
                  : (r.message ?? 'Không gợi ý được.')
        )
        return
      }
      const s = r.suggestion
      const keys = Object.keys(s)
      if (!keys.length) return setAiNote('AI không thấy thông tin nào khớp danh sách lựa chọn.')
      setNeeds((n) => ({
        ...n,
        areas: [...new Set([...n.areas, ...(s.areas ?? [])])],
        fears: [...new Set([...n.fears, ...(s.fears ?? [])])],
        comparing: [...new Set([...n.comparing, ...(s.comparing ?? [])])],
        budget: n.budget ?? s.budget ?? null,
        decisionMaker: n.decisionMaker ?? s.decisionMaker ?? null,
        occasion: n.occasion ?? s.occasion ?? null
      }))
      setAiNote('AI đã điền gợi ý (chưa lưu). Kiểm tra lại rồi bấm Lưu.')
    } catch (err) {
      fail(getApiErrorMessage(err))
    }
  }
  const chips = (list: string[], active: (v: string) => boolean, onClick: (v: string) => void, label?: (v: string) => string) => (
    <div className="qpick">
      {list.map((v) => (
        <button key={v} type="button" disabled={!edit} className={`fchip ${active(v) ? 'on' : ''}`} onClick={() => onClick(v)}>
          {label ? label(v) : v}
        </button>
      ))}
    </div>
  )
  return (
    <div className="card">
      <div className="row" style={{ marginBottom: 6 }}>
        <div className="sec-title" style={{ margin: 0 }}>Hồ sơ nhu cầu</div>
        {edit ? (
          <button className="btn sec sm" style={{ marginLeft: 'auto' }} onClick={() => void suggest()} title="AI1 đọc tin khách nhắn và điền gợi ý, không tự lưu">
            AI gợi ý điền
          </button>
        ) : null}
      </div>
      {aiNote ? <div className="alert" style={{ marginBottom: 8 }}>{aiNote}</div> : null}
      <div className="needs-grid">
        <div className="lbl">Vùng muốn làm</div>
        {chips(opts.areas.map((a) => a.key), (v) => needs.areas.includes(v), (v) => toggleMany('areas', v), (v) => opts.areas.find((a) => a.key === v)?.label ?? v)}
        <div className="lbl">Ngân sách</div>
        {chips(opts.budgets, (v) => needs.budget === v, (v) => pickOne('budget', v))}
        <div className="lbl">Nỗi sợ, băn khoăn</div>
        {chips(opts.fears, (v) => needs.fears.includes(v), (v) => toggleMany('fears', v))}
        <div className="lbl">Người quyết định</div>
        {chips(opts.decisionMakers, (v) => needs.decisionMaker === v, (v) => pickOne('decisionMaker', v))}
        <div className="lbl">Dịp</div>
        <div>
          {chips(opts.occasions, (v) => needs.occasion === v, (v) => pickOne('occasion', v))}
          {needs.occasion ? (
            <input className="input" type="date" disabled={!edit} style={{ width: 160, marginTop: 4 }} value={needs.occasionDate ?? ''} onChange={(e) => setNeeds((n) => ({ ...n, occasionDate: e.target.value || null }))} />
          ) : null}
        </div>
        <div className="lbl">Nơi đang so sánh</div>
        <div>
          <div className="qpick">
            {needs.comparing.map((c) => (
              <span key={c} className="fchip on">
                {c}
                {edit ? (
                  <button type="button" className="x" onClick={() => setNeeds((n) => ({ ...n, comparing: n.comparing.filter((x) => x !== c) }))}>
                    ✕
                  </button>
                ) : null}
              </span>
            ))}
            {edit ? (
              <input
                className="input"
                style={{ width: 170, padding: '2px 8px' }}
                placeholder="Thêm nơi, Enter"
                value={compare}
                onChange={(e) => setCompare(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && compare.trim()) {
                    setNeeds((n) => ({ ...n, comparing: [...new Set([...n.comparing, compare.trim()])] }))
                    setCompare('')
                  }
                }}
              />
            ) : null}
          </div>
        </div>
        <div className="lbl">Ghi chú</div>
        <div>
          {edit ? (
            <textarea
              className="input"
              rows={2}
              maxLength={500}
              placeholder="Ghi chú thêm về nhu cầu (tối đa 500 ký tự)"
              value={needs.note ?? ''}
              onChange={(e) => setNeeds((n) => ({ ...n, note: e.target.value || null }))}
            />
          ) : needs.note ? (
            <div style={{ whiteSpace: 'pre-wrap', fontSize: 13 }}>{needs.note}</div>
          ) : (
            <span className="muted">Chưa có</span>
          )}
        </div>
      </div>
      {edit ? (
        <div className="row" style={{ marginTop: 10 }}>
          <span className="muted" style={{ fontSize: 11.5 }}>{saved.updatedAt ? `Cập nhật ${dateTimeVi(saved.updatedAt)}${saved.updatedBy ? ` bởi ${saved.updatedBy}` : ''}` : 'Chưa lưu lần nào'}</span>
          <button className="btn sm" style={{ marginLeft: 'auto' }} disabled={!dirty || busy} onClick={() => void save()}>
            {busy ? 'Đang lưu…' : 'Lưu'}
          </button>
        </div>
      ) : null}
    </div>
  )
}

/* ---------------------------------------------------- C4 DÒNG THỜI GIAN */

const KIND_LABEL: Record<TimelineKind, string> = {
  MESSAGE: 'Tin nhắn',
  CALL: 'Cuộc gọi',
  VISIT: 'Lần đến',
  APPOINTMENT: 'Lịch hẹn',
  QUOTE: 'Báo giá',
  PAYMENT: 'Thanh toán',
  CONTRACT: 'Hợp đồng',
  STAGE: 'Bước, cơ hội',
  NOTE: 'Ghi chú',
  PACKAGE: 'Gói liệu trình'
}
const KIND_ICON: Record<TimelineKind, string> = {
  MESSAGE: '💬',
  CALL: '📞',
  VISIT: '🏥',
  APPOINTMENT: '📅',
  QUOTE: '🧾',
  PAYMENT: '💵',
  CONTRACT: '📄',
  STAGE: '🗂',
  NOTE: '📝',
  PACKAGE: '🎟'
}

export function TimelineCard({ customerId }: { customerId: string }): React.JSX.Element {
  const { can } = useAuth()
  const { fail } = useToast()
  const [kinds, setKinds] = useState<TimelineKind[]>([])
  const [channel, setChannel] = useState('')
  const [items, setItems] = useState<TimelineItem[] | null>(null)
  const [next, setNext] = useState<string | null>(null)
  const [channels, setChannels] = useState<Array<{ key: string; label: string }>>([])
  const [calling, setCalling] = useState(false)
  const load = useCallback(
    async (before?: string) => {
      try {
        const r = await fetchTimeline(customerId, { kinds: kinds.length ? kinds.join(',') : undefined, channel: channel || undefined, before, limit: 50 })
        setItems((cur) => (before && cur ? [...cur, ...r.items] : r.items))
        setNext(r.nextBefore)
        setChannels(r.channels)
      } catch (err) {
        fail(getApiErrorMessage(err))
      }
    },
    [customerId, kinds, channel, fail]
  )
  useEffect(() => {
    void load()
  }, [load])
  const toggle = (k: TimelineKind) => setKinds((ks) => (ks.includes(k) ? ks.filter((x) => x !== k) : [...ks, k]))
  return (
    <div className="card">
      <div className="row" style={{ marginBottom: 6 }}>
        <div className="sec-title" style={{ margin: 0 }}>Dòng thời gian đa kênh</div>
        {can('customer.update') ? (
          <button className="btn sec sm" style={{ marginLeft: 'auto' }} onClick={() => setCalling(true)}>
            + Ghi cuộc gọi
          </button>
        ) : null}
      </div>
      <div className="qpick" style={{ marginBottom: 8 }}>
        {(Object.keys(KIND_LABEL) as TimelineKind[]).map((k) => (
          <button key={k} className={`fchip ${kinds.includes(k) ? 'on' : ''}`} disabled={Boolean(channel) && k !== 'MESSAGE'} onClick={() => toggle(k)}>
            {KIND_ICON[k]} {KIND_LABEL[k]}
          </button>
        ))}
        {channels.length ? (
          <select className={`fchip-select ${channel ? 'on' : ''}`} value={channel} onChange={(e) => setChannel(e.target.value)}>
            <option value="">Mọi kênh chat</option>
            {channels.map((c) => (
              <option key={c.key} value={c.key}>
                Chỉ {c.label}
              </option>
            ))}
          </select>
        ) : null}
        {kinds.length || channel ? (
          <button
            className="btn sec sm"
            onClick={() => {
              setKinds([])
              setChannel('')
            }}
          >
            Bỏ lọc
          </button>
        ) : null}
      </div>
      {!items ? (
        <Empty>Đang tải…</Empty>
      ) : items.length === 0 ? (
        <Empty>Không có hoạt động nào khớp bộ lọc.</Empty>
      ) : (
        <div className="tl">
          {items.map((e) => (
            <div key={e.id} className={`tl-row ${e.kind} ${e.direction === 'IN' ? 'in' : ''}`}>
              <span className="tl-ic" title={KIND_LABEL[e.kind]}>
                {KIND_ICON[e.kind]}
              </span>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div className="tl-head">
                  <b>{e.title}</b>
                  {e.amount != null ? <span> · {vnd(e.amount)}</span> : null}
                  <span className="muted"> · {dateTimeVi(e.at)}</span>
                  {e.by ? <span className="muted"> · {e.by}</span> : null}
                </div>
                {e.text ? <div className="tl-text">{e.text}</div> : null}
              </div>
            </div>
          ))}
          {next ? (
            <button className="btn sec sm" style={{ marginTop: 8 }} onClick={() => void load(next)}>
              Tải thêm
            </button>
          ) : null}
        </div>
      )}
      {calling ? (
        <CallModal
          customerId={customerId}
          onClose={() => setCalling(false)}
          onDone={() => {
            setCalling(false)
            void load()
          }}
        />
      ) : null}
    </div>
  )
}

function CallModal({ customerId, onClose, onDone }: { customerId: string; onClose: () => void; onDone: () => void }): React.JSX.Element {
  const { fail } = useToast()
  const [direction, setDirection] = useState<'OUT' | 'IN'>('OUT')
  const [result, setResult] = useState('ANSWERED')
  const [minutes, setMinutes] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async () => {
    setBusy(true)
    try {
      await logCall(customerId, { direction, result, durationSec: minutes ? Math.round(Number(minutes) * 60) : undefined, note: note.trim() || undefined })
      onDone()
    } catch (err) {
      fail(getApiErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal
      title="Ghi cuộc gọi"
      onClose={onClose}
      width={420}
      footer={
        <>
          <button className="btn sec" onClick={onClose}>
            Huỷ
          </button>
          <button className="btn" disabled={busy} onClick={() => void submit()}>
            Lưu
          </button>
        </>
      }
    >
      <div className="grid2">
        <div className="field">
          <label>Chiều</label>
          <select className="input" value={direction} onChange={(e) => setDirection(e.target.value as 'OUT' | 'IN')}>
            <option value="OUT">Gọi cho khách</option>
            <option value="IN">Khách gọi đến</option>
          </select>
        </div>
        <div className="field">
          <label>Kết quả</label>
          <select className="input" value={result} onChange={(e) => setResult(e.target.value)}>
            <option value="ANSWERED">Nghe máy</option>
            <option value="NO_ANSWER">Không nghe máy</option>
            <option value="BUSY">Máy bận</option>
            <option value="WRONG_NUMBER">Sai số</option>
          </select>
        </div>
      </div>
      <div className="field">
        <label>Thời lượng (phút)</label>
        <input className="input" inputMode="decimal" value={minutes} onChange={(e) => setMinutes(e.target.value)} />
      </div>
      <div className="field">
        <label>Nội dung</label>
        <textarea className="input" rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
      <div className="muted" style={{ fontSize: 11.5 }}>Chưa nối tổng đài: cuộc gọi ghi tay để hiện trên dòng thời gian.</div>
    </Modal>
  )
}

/* ---------------------------------------------------- V6 BÁO GIÁ ĐANG MỞ */

const QUOTE_STATUS: Record<string, string> = { DRAFT: 'Nháp', SENT: 'Đã gửi khách', ACCEPTED: 'Khách đồng ý', REJECTED: 'Khách từ chối', EXPIRED: 'Hết hạn' }

export function QuotesCard({ customerId, onChanged }: { customerId: string; onChanged?: () => void }): React.JSX.Element | null {
  const { can } = useAuth()
  const { say, fail } = useToast()
  const money = useMoneyVisible()
  const [rows, setRows] = useState<QuotationRow[] | null>(null)
  const [reject, setReject] = useState<QuotationRow | null>(null)
  const [reason, setReason] = useState('')
  const load = useCallback(() => {
    fetchCustomerQuotations(customerId)
      .then(setRows)
      .catch(() => setRows([]))
  }, [customerId])
  useEffect(() => load(), [load])
  if (!rows) return null
  const edit = can('sales_order.update')
  const set = async (q: QuotationRow, status: string, why?: string) => {
    try {
      await setQuotationStatus(q.id, status, why)
      say(status === 'REJECTED' ? 'Đã ghi khách từ chối và tạo việc chăm lại.' : 'Đã cập nhật báo giá.')
      setReject(null)
      setReason('')
      load()
      onChanged?.()
    } catch (err) {
      fail(getApiErrorMessage(err))
    }
  }
  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
      <div className="sec-title" style={{ padding: '12px 14px 0' }}>Báo giá</div>
      {rows.length === 0 ? (
        <Empty>Khách chưa có báo giá.</Empty>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Mã</th>
              <th>Nội dung</th>
              {money ? <th>Giá trị</th> : null}
              <th>Trạng thái</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((q) => (
              <tr key={q.id}>
                <td className="muted">{q.code}</td>
                <td>{q.items.map((i) => i.name).join(', ')}</td>
                {money ? <td>{vnd(q.total)}</td> : null}
                <td>
                  {QUOTE_STATUS[q.status] ?? q.status}
                  {q.rejectReason ? <div className="muted" style={{ fontSize: 11.5 }}>Lý do: {q.rejectReason}</div> : null}
                </td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  {edit && (q.status === 'DRAFT' || q.status === 'SENT') && q.approvalStatus !== 'PENDING' && q.approvalStatus !== 'REJECTED' ? (
                    <>
                      {q.status === 'DRAFT' ? (
                        <button className="btn sec sm" onClick={() => void set(q, 'SENT')}>
                          Đã gửi
                        </button>
                      ) : null}{' '}
                      <button className="btn sec sm" onClick={() => void set(q, 'ACCEPTED')}>
                        Đồng ý
                      </button>{' '}
                      <button className="btn sec sm" onClick={() => setReject(q)}>
                        Từ chối
                      </button>
                    </>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {reject ? (
        <Modal
          title={`Khách từ chối báo giá ${reject.code}`}
          onClose={() => setReject(null)}
          width={440}
          footer={
            <>
              <button className="btn sec" onClick={() => setReject(null)}>
                Huỷ
              </button>
              <button className="btn" disabled={reason.trim().length < 3} onClick={() => void set(reject, 'REJECTED', reason.trim())}>
                Xác nhận
              </button>
            </>
          }
        >
          <div className="field">
            <label>Lý do khách từ chối (bắt buộc)</label>
            <textarea className="input" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Ví dụ: chê giá, muốn so sánh thêm nơi khác" />
          </div>
          <div className="muted" style={{ fontSize: 12 }}>Hệ thống tự tạo việc chăm lại cho sale phụ trách sau số ngày trong Cài đặt.</div>
        </Modal>
      ) : null}
    </div>
  )
}

/* ---------------------------------------------------- V3 GÓI LIỆU TRÌNH */

const PKG_STATUS: Record<string, string> = { ACTIVE: 'Đang dùng', COMPLETED: 'Đã dùng hết', CANCELLED: 'Đã huỷ' }

export function PackagesCard({ customerId }: { customerId: string }): React.JSX.Element | null {
  const { can } = useAuth()
  const { say, fail } = useToast()
  const [data, setData] = useState<Awaited<ReturnType<typeof fetchPackages>> | null>(null)
  const load = useCallback(() => {
    fetchPackages(customerId)
      .then(setData)
      .catch(() => setData(null))
  }, [customerId])
  useEffect(() => load(), [load])
  if (!data) return null
  if (!data.items.length && !data.candidates.length) return null
  const make = async (itemId: string, qty: number) => {
    const raw = window.prompt('Số buổi của gói:', String(qty))
    if (raw == null) return
    try {
      await createPackage({ contractItemId: itemId, sessions: Number(raw) })
      say('Đã lập gói liệu trình.')
      load()
    } catch (err) {
      fail(getApiErrorMessage(err))
    }
  }
  const use = async (p: PackageRow) => {
    const note = window.prompt(`Trừ buổi ${p.usedSessions + 1}/${p.totalSessions} gói "${p.name}". Ghi chú (có thể bỏ trống):`, '')
    if (note == null) return
    try {
      await consumePackageSession(p.id, { note: note.trim() || undefined })
      say('Đã trừ một buổi.')
      load()
    } catch (err) {
      fail(getApiErrorMessage(err))
    }
  }
  const cancel = async (p: PackageRow) => {
    const reason = window.prompt('Lý do huỷ gói (hoàn tiền làm ở màn thanh toán):', '')
    if (!reason) return
    try {
      await cancelPackage(p.id, reason)
      load()
    } catch (err) {
      fail(getApiErrorMessage(err))
    }
  }
  return (
    <div className="card">
      <div className="sec-title">Gói liệu trình</div>
      {data.items.map((p) => (
        <div key={p.id} className="pkg-row">
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <b>{p.name}</b>
            <span className="hchip COLD">{PKG_STATUS[p.status]}</span>
            {p.expired ? <span className="hchip HOT">Hết hạn</span> : null}
            <span style={{ marginLeft: 'auto' }}>
              {p.status === 'ACTIVE' && !p.expired && can('customer.update') ? (
                <button className="btn sm" onClick={() => void use(p)}>
                  Dùng 1 buổi
                </button>
              ) : null}{' '}
              {p.status === 'ACTIVE' && can('finance.update') ? (
                <button className="btn sec sm" onClick={() => void cancel(p)}>
                  Huỷ gói
                </button>
              ) : null}
            </span>
          </div>
          <div className="pkg-bar" aria-label={`Đã dùng ${p.usedSessions}/${p.totalSessions} buổi`}>
            {Array.from({ length: p.totalSessions }, (_, i) => (
              <span key={i} className={i < p.usedSessions ? 'on' : ''} />
            ))}
          </div>
          <div className="muted" style={{ fontSize: 12 }}>
            Đã dùng {p.usedSessions}/{p.totalSessions} buổi · còn {p.remainingSessions}
            {p.lastUsedAt ? ` · buổi gần nhất ${dateVi(p.lastUsedAt)}` : ''}
            {p.expiresAt ? ` · hạn ${dateVi(p.expiresAt)}` : ''}
            {p.price != null ? ` · giá gói ${vnd(p.price)}, giá trị đã dùng ${vnd(p.usedValue)}` : ''}
            {p.cancelReason ? ` · huỷ: ${p.cancelReason}` : ''}
          </div>
        </div>
      ))}
      {data.candidates.length && can('finance.create') ? (
        <div style={{ marginTop: 8 }}>
          <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>Dòng hợp đồng nhiều buổi chưa lập gói:</div>
          {data.candidates.map((c) => (
            <div key={c.id} className="row" style={{ gap: 8, fontSize: 12.5, padding: '3px 0' }}>
              <span>
                {c.contract.code} · {c.name} × {c.quantity}
                {c.amount != null ? ` · ${vnd(c.amount)}` : ''}
              </span>
              <button className="btn sec sm" style={{ marginLeft: 'auto' }} onClick={() => void make(c.id, c.quantity)}>
                Lập gói
              </button>
            </div>
          ))}
        </div>
      ) : null}
      <div className="muted" style={{ fontSize: 11.5, marginTop: 8 }}>
        Doanh số ghi theo hợp đồng ký, tiền thu ghi khi thu (như cũ). Giá trị buổi đã dùng chỉ để tham khảo.
      </div>
    </div>
  )
}
