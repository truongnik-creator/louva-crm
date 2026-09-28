import React, { useCallback, useEffect, useMemo, useState } from 'react'
import {
  fetchChecklist,
  fetchProcedures,
  fetchRooms,
  getApiErrorMessage,
  setProcedureStatus,
  updateProcedureChecklist
} from '../lib/api'
import { useAuth } from '../lib/auth-context'
import { hhmm, toISODate, weekdayLongVi, vnd } from '../lib/format'
import { ANESTHESIA_LABEL, PROCEDURE_STATUS, tagStyleOf } from '../lib/ui'
import { Drawer, Empty, Row, Tag, useToast } from '../components/ui'
import { ScheduleProcedureModal } from '../components/clinical-forms'
import type { ChecklistResult, Procedure, Room } from '../lib/types'

/* PHÒNG MỔ · LỊCH MỔ — lưới thời gian × phòng mổ.
   Khác prototype ở chỗ quan trọng nhất: mức "đủ / thiếu điều kiện" KHÔNG phải
   dữ liệu tĩnh mà do backend chấm lại từ dữ liệu thật (đã cọc đủ 30% chưa, đã
   ký cam kết chưa, đã chụp ảnh trước mổ chưa). Thiếu là không xác nhận được ca. */

const SLOT_MINUTES = 30
const DAY_START = 7 * 60 + 30
const DAY_END = 18 * 60

const READY_STYLE = { t: 'Đủ điều kiện', bg: '#DCFCE7', fg: '#15803D' }
const WARN_STYLE = { t: 'Thiếu điều kiện', bg: '#FEF3C7', fg: '#B45309' }
const BLOCK_STYLE = { t: 'Thiếu điều kiện', bg: '#FEE2E2', fg: '#B91C1C' }

function slots(): string[] {
  const out: string[] = []
  for (let m = DAY_START; m < DAY_END; m += SLOT_MINUTES) {
    out.push(`${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`)
  }
  return out
}

export default function SurgerySchedule(): React.JSX.Element {
  const { can, branchId } = useAuth()
  const { say, fail } = useToast()

  const [date, setDate] = useState(() => toISODate(new Date()))
  const [items, setItems] = useState<Procedure[]>([])
  const [stats, setStats] = useState({ count: 0, totalHours: 0, notReady: 0 })
  const [rooms, setRooms] = useState<Room[]>([])
  const [selected, setSelected] = useState<Procedure | null>(null)
  const [scheduling, setScheduling] = useState(false)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const from = new Date(`${date}T00:00:00`)
      const to = new Date(from)
      to.setDate(to.getDate() + 1)
      const data = await fetchProcedures({ from: from.toISOString(), to: to.toISOString() })
      setItems(data.items)
      setStats(data.stats)
    } catch (err) {
      fail(getApiErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }, [date, fail])

  useEffect(() => {
    void load()
  }, [load, branchId])

  useEffect(() => {
    fetchRooms()
      .then((all) => setRooms(all.filter((r) => r.type === 'OPERATING' || r.type === 'MINOR_OP')))
      .catch(() => undefined)
  }, [branchId])

  const timeSlots = useMemo(slots, [])

  const grid = useMemo(() => {
    const map = new Map<string, { procedure: Procedure; span: number }>()
    const occupied = new Set<string>()

    for (const p of items) {
      if (!p.room) continue
      const start = new Date(p.scheduledAt)
      const startMin = start.getHours() * 60 + start.getMinutes()
      const rowIndex = Math.floor((startMin - DAY_START) / SLOT_MINUTES)
      if (rowIndex < 0 || rowIndex >= timeSlots.length) continue

      const span = Math.max(1, Math.round(p.durationMin / SLOT_MINUTES))
      map.set(`${rowIndex}:${p.room.id}`, { procedure: p, span })
      for (let i = 1; i < span; i++) occupied.add(`${rowIndex + i}:${p.room.id}`)
    }
    return { map, occupied }
  }, [items, timeSlots])

  const shiftDate = (delta: number): void => {
    const d = new Date(date)
    d.setDate(d.getDate() + delta)
    setDate(toISODate(d))
  }

  const styleFor = (p: Procedure): typeof READY_STYLE =>
    p.checklistReady ? READY_STYLE : p.checklistMissing > 1 ? BLOCK_STYLE : WARN_STYLE

  return (
    <>
      <div className="row" style={{ flexWrap: 'wrap', marginBottom: 12 }}>
        <button className="btn sec sm" onClick={() => shiftDate(-1)}>
          ◀
        </button>
        <b>
          {weekdayLongVi(new Date(date))}, {new Date(date).toLocaleDateString('vi-VN')}
        </b>
        <button className="btn sec sm" onClick={() => shiftDate(1)}>
          ▶
        </button>
        <input className="input" type="date" style={{ width: 'auto' }} value={date} onChange={(e) => setDate(e.target.value)} />
        {can('surgery_schedule.create') ? (
          <button className="btn" style={{ marginLeft: 'auto' }} onClick={() => setScheduling(true)}>
            + Xếp ca mổ
          </button>
        ) : null}
      </div>

      <div className="grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)', marginBottom: 12 }}>
        <div className="kpi">
          <div className="lab">Số ca trong ngày</div>
          <div className="val">{stats.count}</div>
        </div>
        <div className="kpi">
          <div className="lab">Tổng giờ mổ</div>
          <div className="val">{String(stats.totalHours).replace('.', ',')} giờ</div>
        </div>
        <div className="kpi">
          <div className="lab">Công suất phòng</div>
          <div className="val">
            {rooms.length ? Math.min(100, Math.round((stats.totalHours / (rooms.length * 8)) * 100)) : 0}%
          </div>
          <div className="dt muted">Trên {rooms.length} phòng × 8 giờ</div>
        </div>
        <div className="kpi">
          <div className="lab">Ca thiếu điều kiện</div>
          <div className="val" style={{ color: stats.notReady ? 'var(--danger)' : undefined }}>
            {stats.notReady}
          </div>
          {stats.notReady ? <div className="dt down">Chưa xác nhận được</div> : null}
        </div>
      </div>

      {loading ? (
        <div className="card">
          <Empty>Đang tải lịch mổ…</Empty>
        </div>
      ) : rooms.length === 0 ? (
        <div className="card">
          <Empty>
            Cơ sở này chưa khai báo phòng mổ nào.
            <br />
            Vào Cài đặt › Phòng &amp; Thiết bị để thêm phòng loại “Phòng mổ”.
          </Empty>
        </div>
      ) : (
        <div className="calwrap">
          <div className="cal" style={{ gridTemplateColumns: `64px repeat(${rooms.length}, 1fr)` }}>
            <div className="hd" />
            {rooms.map((r) => (
              <div className="hd" key={r.id}>
                {r.name}
              </div>
            ))}

            {timeSlots.map((time, ri) => (
              <React.Fragment key={time}>
                <div className="tm" style={{ gridRow: ri + 2, gridColumn: 1 }}>
                  {time}
                </div>
                {rooms.map((room, ci) => {
                  const cell = grid.map.get(`${ri}:${room.id}`)
                  if (cell) {
                    const s = styleFor(cell.procedure)
                    return (
                      <div
                        className="cell"
                        key={room.id}
                        style={{ gridRow: `${ri + 2} / span ${cell.span}`, gridColumn: ci + 2 }}
                      >
                        <div
                          className="ev"
                          style={{ background: s.bg, color: s.fg, borderLeftColor: s.fg }}
                          onClick={() => setSelected(cell.procedure)}
                        >
                          <b>
                            {hhmm(cell.procedure.scheduledAt)} · {cell.procedure.customer.name}
                          </b>
                          {cell.procedure.title}
                          <div style={{ opacity: 0.85, marginTop: 2 }}>
                            {cell.procedure.surgeon?.name ?? '—'} ·{' '}
                            {ANESTHESIA_LABEL[cell.procedure.anesthesia] ?? cell.procedure.anesthesia}
                          </div>
                          <div style={{ marginTop: 3, fontWeight: 700 }}>{s.t}</div>
                        </div>
                      </div>
                    )
                  }
                  if (grid.occupied.has(`${ri}:${room.id}`)) return null
                  return (
                    <div
                      className="cell"
                      key={room.id}
                      style={{ gridRow: ri + 2, gridColumn: ci + 2 }}
                    />
                  )
                })}
              </React.Fragment>
            ))}
          </div>
        </div>
      )}

      <div className="muted" style={{ fontSize: 12, marginTop: 9 }}>
        Hệ thống tự chèn 30 phút dọn phòng giữa hai ca · Cọc tối thiểu 30% mới xác nhận được ca · Bấm vào
        một ca để xem checklist tiền phẫu.
      </div>

      {scheduling ? (
        <ScheduleProcedureModal
          onClose={() => setScheduling(false)}
          onDone={() => {
            setScheduling(false)
            void load()
          }}
        />
      ) : null}

      {selected ? (
        <ProcedureDrawer
          procedure={selected}
          onClose={() => setSelected(null)}
          onChanged={() => {
            setSelected(null)
            void load()
          }}
        />
      ) : null}
    </>
  )
}

function ProcedureDrawer({
  procedure,
  onClose,
  onChanged
}: {
  procedure: Procedure
  onClose: () => void
  onChanged: () => void
}): React.JSX.Element {
  const { can } = useAuth()
  const { say, fail } = useToast()
  const [checklist, setChecklist] = useState<ChecklistResult | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => {
    fetchChecklist(procedure.id)
      .then(setChecklist)
      .catch((err) => fail(getApiErrorMessage(err)))
  }, [procedure.id, fail])

  useEffect(() => {
    load()
  }, [load])

  // Ba mục checklist chưa có nguồn dữ liệu tự động ở Giai đoạn 1 (xét nghiệm,
  // khám tiền mê, vật tư) — bác sĩ/điều dưỡng tự xác nhận, đánh dấu ở đây.
  const MANUAL_INDEXES = [2, 3, 5, 6]

  const toggleManual = async (index: number): Promise<void> => {
    if (!checklist) return
    const next = checklist.items.map((i) => i.ok)
    next[index] = !next[index]
    setBusy(true)
    try {
      await updateProcedureChecklist(procedure.id, next)
      load()
    } catch (err) {
      fail(getApiErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const changeStatus = async (status: string): Promise<void> => {
    let report: string | undefined
    let reason: string | undefined
    if (status === 'COMPLETED') {
      report = window.prompt('Tường trình phẫu thuật (bắt buộc):') ?? undefined
      if (!report) return
    }
    if (status === 'POSTPONED' || status === 'CANCELLED') {
      reason = window.prompt('Lý do (bắt buộc):') ?? undefined
      if (!reason) return
    }
    setBusy(true)
    try {
      await setProcedureStatus(procedure.id, { status, report, reason })
      say(
        status === 'COMPLETED'
          ? 'Đã kết thúc ca mổ. Khách chuyển sang “Đã phẫu thuật” và lịch tái khám N1/N7/T1/T3 đã được sinh.'
          : 'Đã cập nhật trạng thái ca mổ.'
      )
      onChanged()
    } catch (err) {
      fail(getApiErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const missing = checklist?.missing ?? 0
  const total = checklist?.items.length ?? 7

  return (
    <Drawer title={`Ca mổ · ${hhmm(procedure.scheduledAt)} · ${procedure.code}`} onClose={onClose}>
      <div style={{ margin: '9px 0' }}>
        <Tag style={tagStyleOf(PROCEDURE_STATUS, procedure.status)} />{' '}
        <span className="tag out">{procedure.room?.name ?? 'Chưa xếp phòng'}</span>
      </div>

      <table>
        <tbody>
          <Row label="Khách hàng" value={`${procedure.customer.name} (${procedure.customer.code})`} />
          <Row label="Thủ thuật" value={procedure.title} />
          <Row label="Bác sĩ chính" value={procedure.surgeon?.name ?? '—'} />
          <Row
            label="Loại vô cảm"
            value={ANESTHESIA_LABEL[procedure.anesthesia] ?? procedure.anesthesia}
          />
          <Row label="Thời lượng dự kiến" value={`${(procedure.durationMin / 60).toFixed(1).replace('.', ',')} giờ`} />
          <Row label="Kíp mổ" value={procedure.teamNote ?? '—'} />
          <Row label="Vật tư dự trù" value={procedure.materialNote ?? '—'} />
          {procedure.contract ? (
            <Row
              label="Hợp đồng"
              value={`${procedure.contract.code} — đã thu ${vnd(procedure.contract.paidAmount)} / ${vnd(procedure.contract.total)}`}
            />
          ) : null}
        </tbody>
      </table>

      <div className="sec-title" style={{ marginTop: 14 }}>
        Checklist tiền phẫu ({total - missing}/{total})
      </div>
      {!checklist ? (
        <Empty>Đang chấm checklist…</Empty>
      ) : (
        checklist.items.map((item, i) => (
          <div className="ck" key={item.label}>
            <span className={`m ${item.ok ? 'y' : 'n'}`}>{item.ok ? '✔' : '✕'}</span>
            <span style={{ flex: 1 }}>
              {item.label}
              {item.detail ? (
                <div className="muted" style={{ fontSize: 11.5 }}>
                  {item.detail}
                </div>
              ) : null}
            </span>
            {can('surgery_schedule.update') && MANUAL_INDEXES.includes(i) ? (
              <button className="btn sec sm" disabled={busy} onClick={() => void toggleManual(i)}>
                {item.ok ? 'Bỏ' : 'Xác nhận'}
              </button>
            ) : null}
          </div>
        ))
      )}

      {missing > 0 ? (
        <div className="alert dg" style={{ marginTop: 10 }}>
          Còn {missing} mục chưa đạt — chưa xác nhận được ca mổ.
        </div>
      ) : null}

      {can('surgery_schedule.update') ? (
        <div style={{ display: 'grid', gap: 7, marginTop: 12 }}>
          <button
            className="btn block"
            disabled={busy || missing > 0 || procedure.status !== 'SCHEDULED'}
            onClick={() => void changeStatus('CONFIRMED')}
          >
            Xác nhận ca
          </button>
          <button
            className="btn sec block"
            disabled={busy || !['SCHEDULED', 'CONFIRMED'].includes(procedure.status)}
            onClick={() => void changeStatus('IN_PROGRESS')}
          >
            Bắt đầu mổ
          </button>
          <button
            className="btn sec block"
            disabled={busy || procedure.status !== 'IN_PROGRESS'}
            onClick={() => void changeStatus('COMPLETED')}
          >
            Kết thúc mổ (ghi tường trình)
          </button>
          <button
            className="btn sec block"
            disabled={busy || ['COMPLETED', 'CANCELLED'].includes(procedure.status)}
            onClick={() => void changeStatus('POSTPONED')}
          >
            Dời ca (bắt buộc lý do)
          </button>
        </div>
      ) : null}

      {procedure.report ? (
        <>
          <div className="sec-title" style={{ marginTop: 14 }}>
            Tường trình phẫu thuật
          </div>
          <div style={{ fontSize: 12.8, whiteSpace: 'pre-wrap' }}>{procedure.report}</div>
        </>
      ) : null}
    </Drawer>
  )
}
