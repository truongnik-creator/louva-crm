import React, { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { fetchAppointments, getApiErrorMessage, setAppointmentStatus } from '../lib/api'
import {
  contactAftercare,
  fetchAftercare,
  setRetreatDays,
  type AftercareResult,
  type AftercareTask,
  type AftercareView
} from '../lib/api-lo4'
import { useAuth } from '../lib/auth-context'
import { useClinic } from '../lib/clinic-context'
import { dateTimeVi, dateVi, hhmm } from '../lib/format'
import { APPOINTMENT_STATUS, tagStyleOf } from '../lib/ui'
import { Empty, Modal, Tag, useToast } from '../components/ui'
import type { Appointment } from '../lib/types'

/* F10: CHĂM SÓC SAU ĐIỀU TRỊ.
 *
 * Danh sách việc chăm sóc (D0, D1, D3, D7, D14, D30) và việc tái tiêm, LỌC Ở MÁY
 * CHỦ theo phạm vi quyền. Quá hạn tính theo Cài đặt followup.overdueDays. Nút
 * "Đã liên hệ" ghi kết quả: liên hệ được thì xong việc, không nghe máy hoặc hẹn
 * gọi lại thì dời hạn, khách có vấn đề thì báo bác sĩ. */

const TABS: Array<{ key: AftercareView; t: string }> = [
  { key: 'due', t: 'Cần gọi hôm nay' },
  { key: 'overdue', t: 'Quá hạn' },
  { key: 'upcoming', t: 'Sắp tới' },
  { key: 'done', t: 'Đã liên hệ' }
]

const RESULT_LABEL: Record<string, string> = {
  REACHED_OK: 'Liên hệ được, khách ổn',
  REACHED_ISSUE: 'Liên hệ được, khách có vấn đề (báo bác sĩ)',
  NO_ANSWER: 'Không nghe máy, không trả lời',
  CALL_BACK_LATER: 'Khách hẹn gọi lại'
}

export default function FollowUp(): React.JSX.Element {
  const { branchId, can } = useAuth()
  const clinic = useClinic()
  const { say, fail } = useToast()
  const navigate = useNavigate()

  const [view, setView] = useState<AftercareView>('due')
  const [kind, setKind] = useState('')
  const [mine, setMine] = useState(false)
  const [items, setItems] = useState<AftercareTask[]>([])
  const [counts, setCounts] = useState({ due: 0, overdue: 0, upcoming: 0 })
  const [overdueDays, setOverdueDays] = useState(3)
  const [followAppts, setFollowAppts] = useState<Appointment[]>([])
  const [loading, setLoading] = useState(true)
  const [contactFor, setContactFor] = useState<AftercareTask | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetchAftercare({ view, kind: kind || undefined, mine: mine ? '1' : undefined, limit: 200 })
      setItems(res.items)
      setCounts(res.counts)
      setOverdueDays(res.overdueDays)
      if (!clinic.isInjection && can('appointment.read')) {
        const from = new Date()
        from.setHours(0, 0, 0, 0)
        const to = new Date(from.getTime() + 14 * 86_400_000)
        const appts = await fetchAppointments({ from: from.toISOString(), to: to.toISOString() })
        setFollowAppts(appts.items.filter((a) => a.type === 'FOLLOW_UP' && !['CANCELLED', 'DONE'].includes(a.status)))
      }
    } catch (err) {
      fail(getApiErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }, [view, kind, mine, clinic.isInjection, can, fail])

  useEffect(() => {
    void load()
  }, [load, branchId])

  const editRetreat = async (t: AftercareTask): Promise<void> => {
    if (!t.procedure) return
    const current = t.procedure.retreatDays ?? t.procedure.service?.retreatDays ?? ''
    const raw = window.prompt('Số ngày tái tiêm cho lần làm này (để trống = theo dịch vụ):', String(current))
    if (raw === null) return
    const days = raw.trim() ? Number(raw) : null
    if (days !== null && (!Number.isInteger(days) || days < 1)) {
      fail('Số ngày phải là số nguyên dương.')
      return
    }
    try {
      const r = await setRetreatDays(t.procedure.id, days)
      say(r.retreatDueAt ? `Mốc tái tiêm mới: ${dateVi(r.retreatDueAt)}` : 'Đã bỏ mốc tái tiêm.')
      void load()
    } catch (err) {
      fail(getApiErrorMessage(err))
    }
  }

  return (
    <>
      <div className="grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)', marginBottom: 12 }}>
        <div className="kpi">
          <div className="lab">Cần gọi hôm nay</div>
          <div className="val">{counts.due}</div>
        </div>
        <div className="kpi">
          <div className="lab">Quá hạn trên {overdueDays} ngày</div>
          <div className="val" style={{ color: counts.overdue ? 'var(--danger)' : undefined }}>{counts.overdue}</div>
        </div>
        <div className="kpi">
          <div className="lab">Sắp tới</div>
          <div className="val">{counts.upcoming}</div>
        </div>
      </div>

      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <div className="row" style={{ padding: '10px 14px', gap: 8, flexWrap: 'wrap' }}>
          {TABS.map((t) => (
            <button key={t.key} className={`btn sm${view === t.key ? '' : ' sec'}`} onClick={() => setView(t.key)}>
              {t.t}
            </button>
          ))}
          <select className="input" style={{ maxWidth: 180, marginLeft: 'auto' }} value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="">Chăm sóc và tái tiêm</option>
            <option value="AFTERCARE">Chỉ chăm sóc theo mốc</option>
            <option value="RETREAT">Chỉ tái tiêm</option>
          </select>
          <label className="row" style={{ gap: 6, fontSize: 13 }}>
            <input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} /> Của tôi
          </label>
        </div>
        {loading ? (
          <Empty>Đang tải…</Empty>
        ) : items.length === 0 ? (
          <Empty>Không có việc nào trong mục này.</Empty>
        ) : (
          <table>
            <thead>
              <tr>
                <th style={{ width: 70 }}>Mốc</th>
                <th>Khách hàng</th>
                <th>Dịch vụ</th>
                <th style={{ width: 140 }}>Hạn gọi</th>
                <th style={{ width: 130 }}>Phụ trách</th>
                <th>Kết quả</th>
                <th style={{ width: 150 }} />
              </tr>
            </thead>
            <tbody>
              {items.map((t) => (
                <tr key={t.id}>
                  <td>
                    <b>{t.kind === 'RETREAT' ? 'Tái tiêm' : t.milestone}</b>
                  </td>
                  <td style={{ cursor: 'pointer' }} onClick={() => t.customer && navigate(`/khach-hang/${t.customer.id}`)}>
                    <b>{t.customer?.name ?? ''}</b>
                    <div className="muted" style={{ fontSize: 11.5 }}>{t.customer?.phone ?? ''}</div>
                  </td>
                  <td>
                    {t.procedure?.service?.name ?? t.procedure?.title ?? t.title}
                    {t.procedure?.retreatDueAt ? (
                      <div className="muted" style={{ fontSize: 11.5 }}>Tái tiêm: {dateVi(t.procedure.retreatDueAt)}</div>
                    ) : null}
                  </td>
                  <td style={{ color: t.overdue ? 'var(--danger)' : undefined }}>
                    {t.dueAt ? dateTimeVi(t.dueAt) : ''}
                    {t.overdue ? <div style={{ fontSize: 11.5 }}>Quá hạn</div> : null}
                  </td>
                  <td>{t.assignee?.name ?? 'Chưa giao'}</td>
                  <td style={{ fontSize: 12, whiteSpace: 'pre-line' }}>{t.resultNote ?? ''}</td>
                  <td>
                    {t.status !== 'DONE' ? (
                      <button className="btn sm" onClick={() => setContactFor(t)}>
                        Đã liên hệ
                      </button>
                    ) : null}
                    {t.procedure && can('followup.update') ? (
                      <button className="btn sec sm" style={{ marginLeft: 4 }} onClick={() => void editRetreat(t)} title="Bác sĩ chỉnh số ngày tái tiêm">
                        Ngày tái tiêm
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {followAppts.length ? (
        <div className="card" style={{ padding: 0, overflow: 'hidden', marginTop: 12 }}>
          <div className="sec-title" style={{ padding: '12px 14px 0' }}>Lịch tái khám 14 ngày tới</div>
          <table>
            <tbody>
              {followAppts.map((a) => (
                <tr key={a.id}>
                  <td>{dateVi(a.startAt)} {hhmm(a.startAt)}</td>
                  <td>{a.customer.name}</td>
                  <td>{a.title}</td>
                  <td>
                    <Tag style={tagStyleOf(APPOINTMENT_STATUS, a.status)} />
                  </td>
                  <td>
                    <button
                      className="btn sec sm"
                      onClick={async () => {
                        await setAppointmentStatus(a.id, 'DONE')
                        void load()
                      }}
                    >
                      Hoàn tất
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <div className="muted" style={{ fontSize: 12, marginTop: 10 }}>
        Việc chăm sóc được sinh tự động khi hoàn tất một lần thực hiện (quy tắc 7). Việc tái tiêm được tạo trước mốc tái tiêm (quy tắc 8).
      </div>

      {contactFor ? (
        <ContactModal
          task={contactFor}
          onClose={() => setContactFor(null)}
          onDone={() => {
            setContactFor(null)
            void load()
          }}
        />
      ) : null}
    </>
  )
}

function ContactModal({ task, onClose, onDone }: { task: AftercareTask; onClose: () => void; onDone: () => void }): React.JSX.Element {
  const { say, fail } = useToast()
  const [result, setResult] = useState<AftercareResult>('REACHED_OK')
  const [note, setNote] = useState('')
  const [next, setNext] = useState('')
  const [saving, setSaving] = useState(false)

  const submit = async (): Promise<void> => {
    setSaving(true)
    try {
      await contactAftercare(task.id, {
        result,
        note: note || undefined,
        nextDueAt: next ? new Date(next).toISOString() : undefined
      })
      say('Đã ghi kết quả liên hệ.')
      onDone()
    } catch (err) {
      fail(getApiErrorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      title={`Đã liên hệ: ${task.customer?.name ?? ''} (${task.kind === 'RETREAT' ? 'tái tiêm' : task.milestone})`}
      onClose={onClose}
      footer={
        <>
          <button className="btn sec" onClick={onClose}>Huỷ</button>
          <button className="btn" disabled={saving} onClick={() => void submit()}>
            {saving ? 'Đang lưu…' : 'Lưu kết quả'}
          </button>
        </>
      }
    >
      <div className="field">
        <label>Kết quả</label>
        <select className="input" value={result} onChange={(e) => setResult(e.target.value as AftercareResult)}>
          {Object.entries(RESULT_LABEL).map(([k, v]) => (
            <option key={k} value={k}>{v}</option>
          ))}
        </select>
      </div>
      {result === 'CALL_BACK_LATER' || result === 'NO_ANSWER' ? (
        <div className="field">
          <label>Gọi lại lúc {result === 'NO_ANSWER' ? '(để trống = ngày mai)' : '*'}</label>
          <input className="input" type="datetime-local" value={next} onChange={(e) => setNext(e.target.value)} />
        </div>
      ) : null}
      <div className="field">
        <label>Ghi chú</label>
        <textarea className="input" rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Khách nói gì, cần làm gì tiếp" />
      </div>
    </Modal>
  )
}
