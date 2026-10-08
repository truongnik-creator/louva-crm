import React, { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { fetchHome, getApiErrorMessage, type HomeData } from '../lib/api'
import { useAuth } from '../lib/auth-context'
import { hhmm, relativeVi } from '../lib/format'
import { APPOINTMENT_STATUS, PROCEDURE_STATUS, VISIT_STATUS, tagStyleOf } from '../lib/ui'
import { Empty, Tag, useToast } from './ui'
import RoleHomeLo5 from './RoleHomeLo5'
import RoleHomeLo6, { type HomeLo6Sections } from './RoleHomeLo6'

/* TRANG CHỦ THEO VAI (B15, bản tối thiểu).
 *
 * Vai không xem được số liệu kinh doanh (bác sĩ, điều dưỡng, lễ tân, marketing,
 * telesale) thấy "việc hôm nay" của mình thay vì màn trống. Mỗi khối chỉ hiện
 * khi máy chủ trả về (tức là vai có quyền tương ứng), nên thêm khối mới cho F29
 * chỉ cần: thêm section ở routes/home.ts + một <Block> ở đây. */

function Block({
  title,
  action,
  onAction,
  children
}: {
  title: string
  action?: string
  onAction?: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="card">
      <div className="row" style={{ marginBottom: 8 }}>
        <div className="sec-title" style={{ margin: 0 }}>
          {title}
        </div>
        {action && onAction ? (
          <button className="btn sec sm" style={{ marginLeft: 'auto' }} onClick={onAction}>
            {action}
          </button>
        ) : null}
      </div>
      {children}
    </div>
  )
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: 'bad' }): React.JSX.Element {
  return (
    <div className="kpi">
      <div className="lab">{label}</div>
      <div className="val" style={tone === 'bad' && value > 0 ? { color: 'var(--danger)' } : undefined}>
        {value}
      </div>
    </div>
  )
}

export default function RoleHome(): React.JSX.Element {
  const { user, branchId } = useAuth()
  const { fail } = useToast()
  const navigate = useNavigate()
  const [data, setData] = useState<HomeData | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    fetchHome()
      .then((d) => !cancelled && setData(d))
      .catch((err) => !cancelled && fail(getApiErrorMessage(err)))
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [branchId, fail])

  if (loading && !data) {
    return (
      <div className="card">
        <Empty>Đang tải việc hôm nay…</Empty>
      </div>
    )
  }

  const s = data?.sections ?? {}
  const hasAny = Object.keys(s).length > 0

  return (
    <>
      <div className="sec-title" style={{ marginTop: 0 }}>
        Chào {user?.name ?? 'bạn'}, đây là việc hôm nay
      </div>

      {!hasAny ? (
        <div className="card">
          <Empty>
            Vai trò của bạn chưa có khối việc nào trên trang chủ.
            <br />
            Hãy dùng menu bên trái để vào phần việc của mình.
          </Empty>
        </div>
      ) : null}

      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 12 }}>
        <RoleHomeLo6 s={s as HomeLo6Sections} />
        <RoleHomeLo5 s={s} />
        {s.appointments ? (
          <Block title="Lịch hẹn hôm nay" action="Mở lịch hẹn" onAction={() => navigate('/lich-hen')}>
            <div className="grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)', marginBottom: 8 }}>
              <Stat label="Tổng lịch" value={s.appointments.total} />
              <Stat label="Đã đến" value={s.appointments.arrived} />
              <Stat label="Chờ khách" value={s.appointments.pending} />
            </div>
            {s.appointments.items.length === 0 ? (
              <div className="muted" style={{ fontSize: 12.5 }}>
                Hôm nay chưa có lịch hẹn.
              </div>
            ) : (
              <table>
                <tbody>
                  {s.appointments.items.map((a) => (
                    <tr key={a.id}>
                      <td style={{ width: 52 }}>
                        <b>{hhmm(a.startAt)}</b>
                      </td>
                      <td>
                        {a.customer.name}
                        <div className="muted" style={{ fontSize: 11.5 }}>
                          {a.title}
                          {a.doctor ? ` · ${a.doctor.name}` : ''}
                        </div>
                      </td>
                      <td>
                        <Tag style={tagStyleOf(APPOINTMENT_STATUS, a.status)} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Block>
        ) : null}

        {s.queue ? (
          <Block title="Khách tại quầy" action="Mở hàng đợi" onAction={() => navigate('/khach-da-den')}>
            <div className="grid" style={{ gridTemplateColumns: 'repeat(2, 1fr)', marginBottom: 8 }}>
              <Stat label="Đang chờ gọi" value={s.queue.waiting} tone="bad" />
              <Stat label="Đang phục vụ" value={s.queue.inProgress} />
            </div>
            {s.queue.items.length === 0 ? (
              <div className="muted" style={{ fontSize: 12.5 }}>
                Không có khách đang chờ.
              </div>
            ) : (
              <table>
                <tbody>
                  {s.queue.items.map((v) => (
                    <tr key={v.id}>
                      <td style={{ width: 40 }}>
                        <b>#{v.queueNumber}</b>
                      </td>
                      <td>
                        {v.customer.name}
                        <div className="muted" style={{ fontSize: 11.5 }}>
                          đến lúc {hhmm(v.checkedInAt)}
                        </div>
                      </td>
                      <td>
                        <Tag style={tagStyleOf(VISIT_STATUS, v.status)} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Block>
        ) : null}

        {s.procedures ? (
          <Block title="Ca thủ thuật hôm nay" action="Mở lịch" onAction={() => navigate('/phong-mo')}>
            <div className="grid" style={{ gridTemplateColumns: 'repeat(2, 1fr)', marginBottom: 8 }}>
              <Stat label="Tổng ca" value={s.procedures.total} />
              <Stat label="Ca của tôi" value={s.procedures.mine} />
            </div>
            {s.procedures.items.length === 0 ? (
              <div className="muted" style={{ fontSize: 12.5 }}>
                Hôm nay chưa có ca nào.
              </div>
            ) : (
              <table>
                <tbody>
                  {s.procedures.items.map((p) => (
                    <tr key={p.id}>
                      <td style={{ width: 52 }}>
                        <b>{hhmm(p.scheduledAt)}</b>
                      </td>
                      <td>
                        {p.customer.name}
                        <div className="muted" style={{ fontSize: 11.5 }}>
                          {p.title}
                          {p.surgeon ? ` · ${p.surgeon.name}` : ''}
                        </div>
                      </td>
                      <td>
                        <Tag style={tagStyleOf(PROCEDURE_STATUS, p.status)} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Block>
        ) : null}

        {s.leads ? (
          <Block title="Lead mới hôm nay" action="Mở lead" onAction={() => navigate('/lead')}>
            <div className="grid" style={{ gridTemplateColumns: 'repeat(2, 1fr)', marginBottom: 8 }}>
              <Stat label="Lead mới" value={s.leads.total} />
              <Stat label="Chưa phân công" value={s.leads.unassigned} tone="bad" />
            </div>
            {s.leads.byChannel.length === 0 ? (
              <div className="muted" style={{ fontSize: 12.5 }}>
                Hôm nay chưa có lead nào.
              </div>
            ) : (
              <table>
                <tbody>
                  {s.leads.byChannel.map((c) => (
                    <tr key={c.channel}>
                      <td>{c.channel}</td>
                      <td style={{ textAlign: 'right' }}>
                        <b>{c.count}</b>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Block>
        ) : null}

        {s.conversations ? (
          <Block title="Hội thoại tôi phụ trách" action="Mở hộp thư" onAction={() => navigate('/hop-thu')}>
            <div className="grid" style={{ gridTemplateColumns: 'repeat(2, 1fr)', marginBottom: 8 }}>
              <Stat label="Hội thoại chưa đọc" value={s.conversations.unread} tone="bad" />
            </div>
            {s.conversations.items.length === 0 ? (
              <div className="muted" style={{ fontSize: 12.5 }}>
                Chưa có hội thoại nào gán cho bạn.
              </div>
            ) : (
              <table>
                <tbody>
                  {s.conversations.items.map((c) => (
                    <tr key={c.id} style={{ cursor: 'pointer' }} onClick={() => navigate('/hop-thu')}>
                      <td>
                        <b>{c.title}</b>
                        <div className="muted" style={{ fontSize: 11.5 }}>
                          {c.lastMessagePreview ?? 'Chưa có tin'}
                        </div>
                      </td>
                      <td className="muted" style={{ fontSize: 11.5, whiteSpace: 'nowrap' }}>
                        {relativeVi(c.lastMessageAt)}
                      </td>
                      <td>{c.unreadCount > 0 ? <span className="zdot">{c.unreadCount}</span> : null}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Block>
        ) : null}
      </div>
    </>
  )
}
