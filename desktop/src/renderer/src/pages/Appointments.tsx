import React, { useCallback, useEffect, useMemo, useState } from 'react'
import {
  checkIn,
  createAppointment,
  fetchAppointments,
  fetchCustomers,
  fetchRooms,
  fetchServices,
  fetchStaff,
  getApiErrorMessage,
  setAppointmentStatus
} from '../lib/api'
import { useAuth } from '../lib/auth-context'
import { hhmm, toISODate, weekdayLongVi } from '../lib/format'
import { APPOINTMENT_STATUS, tagStyleOf } from '../lib/ui'
import { Drawer, Empty, Modal, Row, Tag, useToast } from '../components/ui'
import type { Appointment, CustomerListItem, Room, Service, StaffUser } from '../lib/types'

/* LỄ TÂN · LỊCH HẸN — lưới thời gian × (bác sĩ + phòng tư vấn), đúng bố cục
   prototype. Cột lịch dựng động từ bác sĩ và phòng tư vấn đang hoạt động, thay
   vì danh sách cứng như bản tĩnh. */

const SLOT_MINUTES = 30
const DAY_START = 7 * 60 + 30 // 07:30
const DAY_END = 17 * 60 + 30 // 17:30

function slots(): string[] {
  const out: string[] = []
  for (let m = DAY_START; m < DAY_END; m += SLOT_MINUTES) {
    out.push(`${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`)
  }
  return out
}

function minutesOf(iso: string): number {
  const d = new Date(iso)
  return d.getHours() * 60 + d.getMinutes()
}

interface Column {
  key: string
  label: string
  kind: 'doctor' | 'room'
}

export default function Appointments(): React.JSX.Element {
  const { can, user, branchId } = useAuth()
  const { say, fail } = useToast()

  const [date, setDate] = useState(() => toISODate(new Date()))
  const [items, setItems] = useState<Appointment[]>([])
  const [counts, setCounts] = useState<Record<string, number>>({})
  const [filter, setFilter] = useState<string>('all')
  const [doctors, setDoctors] = useState<StaffUser[]>([])
  const [rooms, setRooms] = useState<Room[]>([])
  const [selected, setSelected] = useState<Appointment | null>(null)
  const [creating, setCreating] = useState<{ startAt: string; column: Column } | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await fetchAppointments({ date })
      setItems(data.items)
      setCounts(data.counts)
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
    if (can('hr.read')) {
      fetchStaff()
        .then((all) => setDoctors(all.filter((s) => s.roles.some((r) => r.code === 'BAC_SI'))))
        .catch(() => undefined)
    }
    fetchRooms({ type: 'CONSULT' }).then(setRooms).catch(() => undefined)
  }, [can, branchId])

  // Cột = bác sĩ có lịch hôm nay (hoặc mọi bác sĩ) + phòng tư vấn.
  const columns = useMemo<Column[]>(() => {
    const doctorCols = new Map<string, Column>()
    for (const d of doctors) {
      doctorCols.set(d.id, { key: d.id, label: `${d.title ? `${d.title} ` : ''}${d.name}`, kind: 'doctor' })
    }
    for (const a of items) {
      if (a.doctor && !doctorCols.has(a.doctor.id)) {
        doctorCols.set(a.doctor.id, {
          key: a.doctor.id,
          label: `${a.doctor.title ? `${a.doctor.title} ` : ''}${a.doctor.name}`,
          kind: 'doctor'
        })
      }
    }
    const roomCols: Column[] = rooms.map((r) => ({ key: r.id, label: r.name, kind: 'room' }))
    return [...doctorCols.values(), ...roomCols]
  }, [doctors, rooms, items])

  const visible = useMemo(
    () => (filter === 'all' ? items : items.filter((a) => a.status === filter)),
    [items, filter]
  )

  const timeSlots = useMemo(slots, [])

  /** Ô lưới nào bị lịch nào chiếm — tính một lần để render nhanh và không vẽ chồng. */
  const grid = useMemo(() => {
    const map = new Map<string, { appointment: Appointment; span: number }>()
    const occupied = new Set<string>()

    for (const a of visible) {
      const colKey = a.doctor?.id ?? a.room?.id
      if (!colKey) continue
      const start = minutesOf(a.startAt)
      const end = minutesOf(a.endAt)
      const rowIndex = Math.floor((start - DAY_START) / SLOT_MINUTES)
      if (rowIndex < 0 || rowIndex >= timeSlots.length) continue

      const span = Math.max(1, Math.round((end - start) / SLOT_MINUTES))
      map.set(`${rowIndex}:${colKey}`, { appointment: a, span })
      for (let i = 1; i < span; i++) occupied.add(`${rowIndex + i}:${colKey}`)
    }
    return { map, occupied }
  }, [visible, timeSlots])

  const changeStatus = useCallback(
    async (appointment: Appointment, status: string) => {
      let reason: string | undefined
      if (status === 'CANCELLED') {
        reason = window.prompt('Lý do huỷ hẹn (bắt buộc):') ?? undefined
        if (!reason) return
      }
      try {
        await setAppointmentStatus(appointment.id, status, reason)
        say('Đã cập nhật trạng thái lịch hẹn.')
        setSelected(null)
        void load()
      } catch (err) {
        fail(getApiErrorMessage(err))
      }
    },
    [say, fail, load]
  )

  const doCheckIn = useCallback(
    async (appointment: Appointment) => {
      try {
        const visit = await checkIn({
          customerId: appointment.customer.id,
          appointmentId: appointment.id,
          purpose: appointment.title
        })
        say(`Đã check-in ${appointment.customer.name} — số thứ tự ${visit.queueNumber}.`)
        setSelected(null)
        void load()
      } catch (err) {
        fail(getApiErrorMessage(err))
      }
    },
    [say, fail, load]
  )

  const shiftDate = (delta: number): void => {
    const d = new Date(date)
    d.setDate(d.getDate() + delta)
    setDate(toISODate(d))
  }

  const chips: Array<{ key: string; label: string; count: number }> = [
    { key: 'all', label: 'Tổng hẹn trong ngày', count: items.length },
    { key: 'CONFIRMED', label: 'Đã xác nhận', count: counts.CONFIRMED ?? 0 },
    { key: 'PENDING', label: 'Chưa xác nhận', count: counts.PENDING ?? 0 },
    { key: 'ARRIVED', label: 'Đã đến', count: counts.ARRIVED ?? 0 },
    { key: 'NO_SHOW', label: 'Vắng mặt', count: counts.NO_SHOW ?? 0 }
  ]

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
        <button className="btn sec sm" onClick={() => setDate(toISODate(new Date()))}>
          Hôm nay
        </button>
        <input className="input" type="date" style={{ width: 'auto' }} value={date} onChange={(e) => setDate(e.target.value)} />
        {can('appointment.create') ? (
          <button
            className="btn"
            style={{ marginLeft: 'auto' }}
            onClick={() =>
              setCreating({
                startAt: `${date}T09:00`,
                column: columns[0] ?? { key: '', label: '', kind: 'doctor' }
              })
            }
          >
            + Đặt lịch hẹn
          </button>
        ) : null}
      </div>

      <div className="grid" style={{ gridTemplateColumns: 'repeat(5, 1fr)', marginBottom: 12 }}>
        {chips.map((c) => (
          <div
            key={c.key}
            className="kpi"
            style={{
              cursor: 'pointer',
              ...(filter === c.key
                ? { borderColor: 'var(--green-600)', boxShadow: '0 0 0 2px var(--green-100)' }
                : {})
            }}
            onClick={() => setFilter(c.key)}
          >
            <div className="lab">{c.label}</div>
            <div className="val">{c.count}</div>
          </div>
        ))}
      </div>

      {loading ? (
        <div className="card">
          <Empty>Đang tải lịch hẹn…</Empty>
        </div>
      ) : columns.length === 0 ? (
        <div className="card">
          <Empty>
            Chưa có bác sĩ hoặc phòng tư vấn nào ở cơ sở này.
            <br />
            Vào Cài đặt › Phòng &amp; Thiết bị để thêm phòng trước khi xếp lịch.
          </Empty>
        </div>
      ) : visible.length === 0 ? (
        <div className="card">
          <Empty>
            Chưa có lịch hẹn nào khớp bộ lọc trong ngày {new Date(date).toLocaleDateString('vi-VN')}.
            <br />
            Bấm vào khung giờ trống trên lưới để đặt lịch.
          </Empty>
        </div>
      ) : (
        <div className="calwrap">
          <div className="cal" style={{ gridTemplateColumns: `64px repeat(${columns.length}, 1fr)` }}>
            <div className="hd" />
            {columns.map((c) => (
              <div className="hd" key={c.key}>
                {c.label}
              </div>
            ))}

            {timeSlots.map((time, ri) => (
              <React.Fragment key={time}>
                <div className="tm" style={{ gridRow: ri + 2, gridColumn: 1 }}>
                  {time}
                </div>
                {columns.map((col, ci) => {
                  const cell = grid.map.get(`${ri}:${col.key}`)
                  if (cell) {
                    const s = tagStyleOf(APPOINTMENT_STATUS, cell.appointment.status)
                    return (
                      <div
                        className="cell"
                        key={col.key}
                        style={{ gridRow: `${ri + 2} / span ${cell.span}`, gridColumn: ci + 2 }}
                      >
                        <div
                          className="ev"
                          style={{ background: s.bg, color: s.fg, borderLeftColor: s.fg }}
                          onClick={() => setSelected(cell.appointment)}
                        >
                          <b>
                            {hhmm(cell.appointment.startAt)} · {cell.appointment.customer.name}
                          </b>
                          {cell.appointment.title}
                          <div style={{ opacity: 0.8, marginTop: 2 }}>{s.t}</div>
                        </div>
                      </div>
                    )
                  }
                  if (grid.occupied.has(`${ri}:${col.key}`)) return null
                  return (
                    <div
                      className={`cell${can('appointment.create') ? ' free' : ''}`}
                      key={col.key}
                      style={{ gridRow: ri + 2, gridColumn: ci + 2 }}
                      onClick={() =>
                        can('appointment.create') &&
                        setCreating({ startAt: `${date}T${time}`, column: col })
                      }
                    />
                  )
                })}
              </React.Fragment>
            ))}
          </div>
        </div>
      )}

      <div className="muted" style={{ fontSize: 12, marginTop: 9 }}>
        Ca phẫu thuật không đặt tại đây — phải qua Phòng mổ · Lịch mổ để kiểm tra checklist tiền phẫu.
      </div>

      {selected ? (
        <Drawer title={`Lịch hẹn · ${hhmm(selected.startAt)}`} onClose={() => setSelected(null)}>
          <div style={{ margin: '9px 0' }}>
            <Tag style={tagStyleOf(APPOINTMENT_STATUS, selected.status)} />
          </div>
          <table>
            <tbody>
              <Row label="Khách hàng" value={`${selected.customer.name} (${selected.customer.code})`} />
              <Row label="Số điện thoại" value={selected.customer.phone ?? '—'} />
              <Row label="Nội dung" value={selected.title} />
              <Row label="Bác sĩ" value={selected.doctor?.name ?? '—'} />
              <Row label="Phòng" value={selected.room?.name ?? '—'} />
              <Row label="Giờ" value={`${hhmm(selected.startAt)} – ${hhmm(selected.endAt)}`} />
              <Row label="Ghi chú" value={selected.note ?? '—'} />
            </tbody>
          </table>

          <div style={{ display: 'grid', gap: 7, marginTop: 14 }}>
            {can('visit.create') && selected.status !== 'ARRIVED' && !selected.visit ? (
              <button className="btn block" onClick={() => void doCheckIn(selected)}>
                Check-in (khách đã đến)
              </button>
            ) : null}
            {can('appointment.update') ? (
              <>
                {selected.status === 'PENDING' ? (
                  <button className="btn sec block" onClick={() => void changeStatus(selected, 'CONFIRMED')}>
                    Xác nhận lịch
                  </button>
                ) : null}
                <button className="btn sec block" onClick={() => void changeStatus(selected, 'NO_SHOW')}>
                  Đánh dấu vắng mặt
                </button>
                <button className="btn sec block" onClick={() => void changeStatus(selected, 'CANCELLED')}>
                  Huỷ hẹn (bắt buộc lý do)
                </button>
              </>
            ) : null}
          </div>
        </Drawer>
      ) : null}

      {creating ? (
        <NewAppointmentModal
          startAt={creating.startAt}
          column={creating.column}
          onClose={() => setCreating(null)}
          onCreated={() => {
            setCreating(null)
            void load()
          }}
        />
      ) : null}
    </>
  )
}

function NewAppointmentModal({
  startAt,
  column,
  onClose,
  onCreated
}: {
  startAt: string
  column: Column
  onClose: () => void
  onCreated: () => void
}): React.JSX.Element {
  const { say, fail } = useToast()
  const [query, setQuery] = useState('')
  const [customers, setCustomers] = useState<CustomerListItem[]>([])
  const [customerId, setCustomerId] = useState('')
  const [services, setServices] = useState<Service[]>([])
  const [serviceId, setServiceId] = useState('')
  const [title, setTitle] = useState('Tư vấn lần đầu')
  const [when, setWhen] = useState(startAt)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    fetchServices().then(setServices).catch(() => undefined)
  }, [])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      fetchCustomers({ q: query || undefined, limit: 20 })
        .then((r) => setCustomers(r.items))
        .catch(() => undefined)
    }, 250)
    return () => window.clearTimeout(timer)
  }, [query])

  const submit = async (): Promise<void> => {
    if (!customerId) {
      fail('Chọn khách hàng trước khi đặt lịch.')
      return
    }
    setSaving(true)
    try {
      await createAppointment({
        customerId,
        title,
        serviceId: serviceId || undefined,
        startAt: new Date(when).toISOString(),
        ...(column.kind === 'doctor' ? { doctorId: column.key } : { roomId: column.key })
      })
      say('Đã đặt lịch hẹn.')
      onCreated()
    } catch (err) {
      fail(getApiErrorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      title={`Đặt lịch hẹn — ${column.label}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn sec" onClick={onClose}>
            Huỷ
          </button>
          <button className="btn" onClick={() => void submit()} disabled={saving}>
            {saving ? 'Đang lưu…' : 'Đặt lịch'}
          </button>
        </>
      }
    >
      <div className="field">
        <label>Tìm khách theo tên / số điện thoại</label>
        <input className="input" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Nhập để tìm…" />
      </div>
      <div className="field">
        <label>Khách hàng</label>
        <select className="input" value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
          <option value="">— Chọn khách —</option>
          {customers.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name} · {c.phone ?? 'chưa có SĐT'} · {c.code}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label>Dịch vụ (quyết định thời lượng)</label>
        <select
          className="input"
          value={serviceId}
          onChange={(e) => {
            setServiceId(e.target.value)
            const svc = services.find((s) => s.id === e.target.value)
            if (svc) setTitle(`Tư vấn — ${svc.name}`)
          }}
        >
          <option value="">— Không chọn —</option>
          {services.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} ({s.durationMin} phút)
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label>Nội dung lịch hẹn</label>
        <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
      </div>
      <div className="field">
        <label>Thời gian bắt đầu</label>
        <input className="input" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
      </div>
    </Modal>
  )
}
