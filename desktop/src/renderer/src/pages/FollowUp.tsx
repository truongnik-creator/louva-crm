import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  fetchAppointments,
  fetchCustomers,
  getApiErrorMessage,
  setAppointmentStatus
} from '../lib/api'
import { useAuth } from '../lib/auth-context'
import { dateVi, hhmm, relativeVi, toISODate } from '../lib/format'
import { APPOINTMENT_STATUS, stageStyle, tagStyleOf } from '../lib/ui'
import { Empty, Tag, useToast } from '../components/ui'
import type { Appointment, CustomerListItem } from '../lib/types'

/* HẬU PHẪU & TÁI KHÁM.
 *
 * Hai câu hỏi mà điều dưỡng cần trả lời mỗi sáng:
 *   1. Hôm nay ai đến tái khám?
 *   2. Khách nào đang hậu phẫu mà QUÁ HẠN chưa được liên hệ?
 *
 * Câu 2 là chỗ dễ rơi nhất — lịch tái khám N1/N7/T1/T3 sinh tự động khi kết
 * thúc mổ, nhưng nếu không ai theo dõi thì khách trôi qua mốc mà không ai gọi. */

const OVERDUE_DAYS = 3

export default function FollowUp(): React.JSX.Element {
  const { branchId } = useAuth()
  const { say, fail } = useToast()
  const navigate = useNavigate()

  const [upcoming, setUpcoming] = useState<Appointment[]>([])
  const [postOp, setPostOp] = useState<CustomerListItem[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const from = new Date()
      from.setHours(0, 0, 0, 0)
      const to = new Date(from)
      to.setDate(to.getDate() + 14)

      const [appts, customers] = await Promise.all([
        fetchAppointments({ from: from.toISOString(), to: to.toISOString() }),
        fetchCustomers({ limit: 300 })
      ])

      // Chỉ giữ lịch tái khám / hậu phẫu, bỏ lịch tư vấn và tiền phẫu.
      setUpcoming(
        appts.items.filter(
          (a) => a.type === 'FOLLOW_UP' && !['CANCELLED', 'DONE'].includes(a.status)
        )
      )
      setPostOp(customers.items.filter((c) => ['PT', 'HAUPHAU'].includes(c.stage)))
    } catch (err) {
      fail(getApiErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }, [fail])

  useEffect(() => {
    void load()
  }, [load, branchId])

  const today = toISODate(new Date())

  const { todayList, laterList } = useMemo(() => {
    const t: Appointment[] = []
    const l: Appointment[] = []
    for (const a of upcoming) {
      if (toISODate(new Date(a.startAt)) === today) t.push(a)
      else l.push(a)
    }
    return { todayList: t, laterList: l }
  }, [upcoming, today])

  // "Quá hạn liên hệ": khách đang hậu phẫu mà đã hơn 3 ngày không có lần chạm nào.
  const stale = postOp.filter((c) => {
    if (!c.lastContactAt) return true
    const days = (Date.now() - new Date(c.lastContactAt).getTime()) / 86400000
    return days > OVERDUE_DAYS
  })

  const markDone = async (a: Appointment): Promise<void> => {
    try {
      await setAppointmentStatus(a.id, 'DONE')
      say('Đã đánh dấu hoàn tất tái khám.')
      void load()
    } catch (err) {
      fail(getApiErrorMessage(err))
    }
  }

  return (
    <>
      <div className="grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)', marginBottom: 12 }}>
        <div className="kpi">
          <div className="lab">Đang hậu phẫu</div>
          <div className="val">{postOp.length}</div>
        </div>
        <div className="kpi">
          <div className="lab">Tái khám hôm nay</div>
          <div className="val">{todayList.length}</div>
        </div>
        <div className="kpi">
          <div className="lab">Tái khám 14 ngày tới</div>
          <div className="val">{laterList.length}</div>
        </div>
        <div className="kpi">
          <div className="lab">Quá hạn liên hệ</div>
          <div className="val" style={{ color: stale.length ? 'var(--danger)' : undefined }}>
            {stale.length}
          </div>
          {stale.length ? <div className="dt down">Quá {OVERDUE_DAYS} ngày chưa chạm</div> : null}
        </div>
      </div>

      {loading ? (
        <div className="card">
          <Empty>Đang tải…</Empty>
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 460 }}>
            <div className="card" style={{ padding: 0, overflow: 'hidden', marginBottom: 12 }}>
              <div className="sec-title" style={{ padding: '12px 14px 0' }}>
                Tái khám hôm nay
              </div>
              {todayList.length === 0 ? (
                <Empty>Hôm nay không có lịch tái khám nào.</Empty>
              ) : (
                <table>
                  <thead>
                    <tr>
                      <th>Giờ</th>
                      <th>Khách hàng</th>
                      <th>Nội dung</th>
                      <th>Bác sĩ</th>
                      <th>Trạng thái</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {todayList.map((a) => (
                      <tr key={a.id}>
                        <td>
                          <b>{hhmm(a.startAt)}</b>
                        </td>
                        <td
                          style={{ cursor: 'pointer' }}
                          onClick={() => navigate(`/khach-hang/${a.customer.id}`)}
                        >
                          <b>{a.customer.name}</b>
                          <div className="muted" style={{ fontSize: 11.5 }}>
                            {a.customer.phone ?? '—'}
                          </div>
                        </td>
                        <td>{a.title}</td>
                        <td>{a.doctor?.name ?? '—'}</td>
                        <td>
                          <Tag style={tagStyleOf(APPOINTMENT_STATUS, a.status)} />
                        </td>
                        <td>
                          <button className="btn sec sm" onClick={() => void markDone(a)}>
                            Hoàn tất
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
              <div className="sec-title" style={{ padding: '12px 14px 0' }}>
                Tái khám sắp tới (14 ngày)
              </div>
              {laterList.length === 0 ? (
                <Empty>Không có lịch tái khám nào trong 14 ngày tới.</Empty>
              ) : (
                <table>
                  <thead>
                    <tr>
                      <th>Ngày</th>
                      <th>Giờ</th>
                      <th>Khách hàng</th>
                      <th>Nội dung</th>
                      <th>Bác sĩ</th>
                    </tr>
                  </thead>
                  <tbody>
                    {laterList.map((a) => (
                      <tr key={a.id}>
                        <td>{dateVi(a.startAt)}</td>
                        <td>{hhmm(a.startAt)}</td>
                        <td
                          style={{ cursor: 'pointer' }}
                          onClick={() => navigate(`/khach-hang/${a.customer.id}`)}
                        >
                          {a.customer.name}
                        </td>
                        <td>{a.title}</td>
                        <td className="muted">{a.doctor?.name ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>

          <div style={{ width: 340, flex: '0 0 340px' }}>
            <div className="card">
              <div className="sec-title">Khách hậu phẫu cần liên hệ</div>
              {stale.length === 0 ? (
                <div className="alert ok">Mọi khách hậu phẫu đều đã được chạm trong {OVERDUE_DAYS} ngày qua.</div>
              ) : (
                stale.map((c) => (
                  <div
                    key={c.id}
                    className="alert wr"
                    style={{ cursor: 'pointer' }}
                    onClick={() => navigate(`/khach-hang/${c.id}`)}
                  >
                    <b>{c.name}</b> — chạm gần nhất: {relativeVi(c.lastContactAt)}
                    <div style={{ marginTop: 4 }}>
                      <Tag style={stageStyle(c.stage)} />
                    </div>
                  </div>
                ))
              )}
            </div>

            <div className="card" style={{ marginTop: 12 }}>
              <div className="sec-title">Đang hậu phẫu ({postOp.length})</div>
              {postOp.length === 0 ? (
                <Empty>Chưa có khách nào trong giai đoạn hậu phẫu.</Empty>
              ) : (
                postOp.map((c) => (
                  <div
                    key={c.id}
                    style={{
                      padding: '8px 0',
                      borderBottom: '1px dashed var(--border)',
                      fontSize: 12.8,
                      cursor: 'pointer'
                    }}
                    onClick={() => navigate(`/khach-hang/${c.id}`)}
                  >
                    <b>{c.name}</b>
                    <div className="muted">
                      {c.interest.join(' · ') || '—'} · chạm: {relativeVi(c.lastContactAt)}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      <div className="muted" style={{ fontSize: 12, marginTop: 10 }}>
        Lịch tái khám N1 · N7 · T1 · T3 được sinh tự động khi bấm “Kết thúc mổ” ở màn Phòng mổ · Lịch mổ.
      </div>
    </>
  )
}
