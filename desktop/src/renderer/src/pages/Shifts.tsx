import React, { useCallback, useEffect, useMemo, useState } from 'react'
import {
  bulkAssignShifts,
  deleteShiftAssignment,
  fetchShiftCalendar,
  fetchShiftTemplates,
  fetchStaff,
  getApiErrorMessage
} from '../lib/api'
import { useAuth } from '../lib/auth-context'
import { toISODate, weekdayVi } from '../lib/format'
import { Empty, Modal, useToast } from '../components/ui'
import type { ShiftAssignment, ShiftTemplate, StaffUser } from '../lib/types'

/* PHÂN LỊCH LÀM VIỆC — lưới nhân viên × 7 ngày trong tuần.
   Bấm vào ô trống để xếp ca, bấm vào ca đã xếp để gỡ. Xếp cả tuần gửi một lần
   qua API bulk nên không tạo ra hàng chục request. */

function startOfWeek(date: Date): Date {
  const d = new Date(date)
  const day = d.getDay()
  // Tuần bắt đầu Thứ Hai theo thói quen Việt Nam, không phải Chủ nhật.
  d.setDate(d.getDate() - (day === 0 ? 6 : day - 1))
  d.setHours(0, 0, 0, 0)
  return d
}

export default function Shifts(): React.JSX.Element {
  const { can, branchId } = useAuth()
  const { say, fail } = useToast()

  const [weekStart, setWeekStart] = useState(() => startOfWeek(new Date()))
  const [assignments, setAssignments] = useState<ShiftAssignment[]>([])
  const [templates, setTemplates] = useState<ShiftTemplate[]>([])
  const [staff, setStaff] = useState<StaffUser[]>([])
  const [picking, setPicking] = useState<{ userId: string; userName: string; date: Date } | null>(null)
  const [loading, setLoading] = useState(true)

  const days = useMemo(() => {
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(weekStart)
      d.setDate(d.getDate() + i)
      return d
    })
  }, [weekStart])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const to = new Date(weekStart)
      to.setDate(to.getDate() + 7)
      const [rows, tpls, users] = await Promise.all([
        fetchShiftCalendar({ from: weekStart.toISOString(), to: to.toISOString() }),
        fetchShiftTemplates().catch(() => []),
        fetchStaff().catch(() => [])
      ])
      setAssignments(rows)
      setTemplates(tpls)
      setStaff(users.filter((u) => u.status === 'ACTIVE'))
    } catch (err) {
      fail(getApiErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }, [weekStart, fail])

  useEffect(() => {
    void load()
  }, [load, branchId])

  // Tra cứu nhanh: userId + ngày -> danh sách ca đã xếp.
  const byCell = useMemo(() => {
    const map = new Map<string, ShiftAssignment[]>()
    for (const a of assignments) {
      const key = `${a.user.id}:${toISODate(new Date(a.date))}`
      map.set(key, [...(map.get(key) ?? []), a])
    }
    return map
  }, [assignments])

  const assign = useCallback(
    async (userId: string, date: Date, templateId: string) => {
      try {
        await bulkAssignShifts({
          branchId: branchId ?? '',
          assignments: [{ userId, templateId, date: date.toISOString() }]
        })
        say('Đã xếp ca.')
        setPicking(null)
        void load()
      } catch (err) {
        fail(getApiErrorMessage(err))
      }
    },
    [branchId, say, fail, load]
  )

  const remove = useCallback(
    async (id: string) => {
      try {
        await deleteShiftAssignment(id)
        void load()
      } catch (err) {
        fail(getApiErrorMessage(err))
      }
    },
    [fail, load]
  )

  const shiftWeek = (delta: number): void => {
    const d = new Date(weekStart)
    d.setDate(d.getDate() + delta * 7)
    setWeekStart(d)
  }

  return (
    <>
      <div className="row" style={{ flexWrap: 'wrap', marginBottom: 12 }}>
        <button className="btn sec sm" onClick={() => shiftWeek(-1)}>
          ◀ Tuần trước
        </button>
        <b>
          {days[0].toLocaleDateString('vi-VN')} – {days[6].toLocaleDateString('vi-VN')}
        </b>
        <button className="btn sec sm" onClick={() => shiftWeek(1)}>
          Tuần sau ▶
        </button>
        <button className="btn sec sm" onClick={() => setWeekStart(startOfWeek(new Date()))}>
          Tuần này
        </button>
        <span className="muted" style={{ fontSize: 12, marginLeft: 'auto' }}>
          {templates.length} loại ca · {assignments.length} ca đã xếp
        </span>
      </div>

      {templates.length ? (
        <div className="row" style={{ flexWrap: 'wrap', marginBottom: 12 }}>
          {templates.map((t) => (
            <span
              key={t.id}
              className="tag"
              style={{ background: `${t.color}22`, color: t.color, border: `1px solid ${t.color}55` }}
            >
              {t.name} · {t.startTime}–{t.endTime}
            </span>
          ))}
        </div>
      ) : null}

      {loading ? (
        <div className="card">
          <Empty>Đang tải lịch làm việc…</Empty>
        </div>
      ) : staff.length === 0 ? (
        <div className="card">
          <Empty>Chưa có nhân viên nào ở cơ sở này.</Empty>
        </div>
      ) : (
        <div className="calwrap">
          <table>
            <thead>
              <tr>
                <th style={{ minWidth: 180 }}>Nhân viên</th>
                {days.map((d) => (
                  <th key={d.toISOString()} style={{ textAlign: 'center' }}>
                    {weekdayVi(d)}
                    <div className="muted" style={{ fontWeight: 400 }}>
                      {d.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' })}
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {staff.map((u) => (
                <tr key={u.id}>
                  <td>
                    <b>
                      {u.title ? `${u.title} ` : ''}
                      {u.name}
                    </b>
                    <div className="muted" style={{ fontSize: 11.5 }}>
                      {u.department?.name ?? u.roles[0]?.name ?? ''}
                    </div>
                  </td>
                  {days.map((d) => {
                    const cell = byCell.get(`${u.id}:${toISODate(d)}`) ?? []
                    return (
                      <td
                        key={d.toISOString()}
                        style={{ textAlign: 'center', cursor: can('shift.create') ? 'pointer' : 'default' }}
                        onClick={() =>
                          cell.length === 0 &&
                          can('shift.create') &&
                          setPicking({ userId: u.id, userName: u.name, date: d })
                        }
                      >
                        {cell.length === 0 ? (
                          <span className="muted" style={{ fontSize: 18, opacity: 0.3 }}>
                            +
                          </span>
                        ) : (
                          cell.map((a) => (
                            <span
                              key={a.id}
                              className="tag"
                              style={{
                                background: `${a.template?.color ?? '#177f4d'}22`,
                                color: a.template?.color ?? '#177f4d',
                                cursor: can('shift.delete') ? 'pointer' : 'default',
                                display: 'block',
                                marginBottom: 2
                              }}
                              title={can('shift.delete') ? 'Bấm để gỡ ca' : undefined}
                              onClick={(e) => {
                                e.stopPropagation()
                                if (can('shift.delete')) void remove(a.id)
                              }}
                            >
                              {a.template?.code ?? 'Ca'}
                            </span>
                          ))
                        )}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {picking ? (
        <Modal title={`Xếp ca — ${picking.userName}`} onClose={() => setPicking(null)}>
          <div className="muted" style={{ fontSize: 12.5, marginBottom: 10 }}>
            Ngày {picking.date.toLocaleDateString('vi-VN')}
          </div>
          {templates.length === 0 ? (
            <Empty>Cơ sở chưa khai báo loại ca nào.</Empty>
          ) : (
            <div style={{ display: 'grid', gap: 7 }}>
              {templates.map((t) => (
                <button
                  key={t.id}
                  className="btn sec block"
                  onClick={() => void assign(picking.userId, picking.date, t.id)}
                >
                  {t.name} · {t.startTime}–{t.endTime}
                </button>
              ))}
            </div>
          )}
        </Modal>
      ) : null}
    </>
  )
}
