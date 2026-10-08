import React from 'react'
import { useNavigate } from 'react-router-dom'
import type { HomeLo5Sections } from '../lib/api-lo5-home'
import { hhmm, relativeVi, vnd } from '../lib/format'
import { ProgressBar } from './lo5-sales-parts'

/* F29: khối trang chủ theo vai (bác sĩ, điều dưỡng, lễ tân, sale, marketing, kế
 * toán, giám đốc). Mỗi khối chỉ hiện khi máy chủ trả về. */

function Card({ title, action, to, children }: { title: string; action?: string; to?: string; children: React.ReactNode }): React.JSX.Element {
  const navigate = useNavigate()
  return (
    <div className="card">
      <div className="row" style={{ marginBottom: 8 }}>
        <div className="sec-title" style={{ margin: 0 }}>{title}</div>
        {action && to ? (
          <button className="btn sec sm" style={{ marginLeft: 'auto' }} onClick={() => navigate(to)}>{action}</button>
        ) : null}
      </div>
      {children}
    </div>
  )
}

function Num({ label, value, bad }: { label: string; value: React.ReactNode; bad?: boolean }): React.JSX.Element {
  return (
    <div className="kpi">
      <div className="lab">{label}</div>
      <div className="val" style={bad ? { color: 'var(--danger)' } : undefined}>{value}</div>
    </div>
  )
}

const grid = (n: number): React.CSSProperties => ({ gridTemplateColumns: `repeat(${n}, 1fr)`, marginBottom: 8 })
const money = (n: number | null | undefined): string => (n == null ? '-' : vnd(n))

export default function RoleHomeLo5({ s }: { s: HomeLo5Sections }): React.JSX.Element {
  return (
    <>
      {s.director ? (
        <Card title={`Dự báo tháng ${s.director.periodKey}`} action="Chỉ tiêu & dự báo" to="/do-luong">
          <div className="grid" style={grid(3)}>
            <Num label="Đã thu" value={money(s.director.actual)} />
            <Num label="Dự báo cuối tháng" value={money(s.director.forecast)} />
            <Num label="Chỉ tiêu" value={s.director.target ? money(s.director.target) : 'Chưa đặt'} />
          </div>
          {s.director.progressPercent != null ? <ProgressBar percent={s.director.progressPercent} /> : null}
          <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
            {s.director.vsPrevPercent != null ? `So cùng số ngày tháng trước: ${s.director.vsPrevPercent > 0 ? '+' : ''}${s.director.vsPrevPercent}%. ` : ''}
            {s.director.forecastVsTargetPercent != null ? `Dự báo đạt ${s.director.forecastVsTargetPercent}% chỉ tiêu.` : ''}
          </div>
        </Card>
      ) : null}

      {s.teamTarget ? (
        <Card title="Mục tiêu khách đến tháng này" action="Bảng thi đua" to="/do-luong">
          <div className="row" style={{ fontSize: 13, marginBottom: 4 }}>
            <span>{s.teamTarget.target > 0 ? `${s.teamTarget.actual} / ${s.teamTarget.target} khách đến` : `${s.teamTarget.actual} khách đến (chưa đặt mục tiêu)`}</span>
            {s.teamTarget.percent != null ? <b style={{ marginLeft: 'auto' }}>{s.teamTarget.percent}%</b> : null}
          </div>
          <ProgressBar percent={s.teamTarget.percent} />
          {s.teamTarget.myShowups != null ? (
            <div style={{ fontSize: 13, marginTop: 8 }}>
              Của tôi: <b>{s.teamTarget.myShowups}</b> khách đến
              {s.teamTarget.myDisqualified ? ', đang bị loại khỏi thi đua tháng này' : s.teamTarget.myRank ? `, hạng ${s.teamTarget.myRank}` : ''}
            </div>
          ) : null}
          {s.teamTarget.top.length ? (
            <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
              Dẫn đầu: {s.teamTarget.top.map((t) => `${t.rank}. ${t.name} (${t.showups})`).join(' · ')}
            </div>
          ) : null}
        </Card>
      ) : null}

      {s.myDay ? (
        <Card title="Số của tôi hôm nay" action="Họp cuối ngày" to="/do-luong">
          <div className="grid" style={grid(3)}>
            <Num label="Tin nhắn mới" value={s.myDay.newMessages} />
            <Num label="SĐT thu được" value={s.myDay.phones} />
            <Num label="Lịch có cọc" value={s.myDay.depositBookings} />
            <Num label="Khách đến" value={s.myDay.showups} />
            <Num label="Việc quá hạn" value={s.myDay.overdueTasks} bad={s.myDay.overdueTasks > 0} />
            <Num label="Hội thoại chưa có SĐT" value={s.myDay.noPhoneConversations} bad={s.myDay.noPhoneConversations > 0} />
          </div>
        </Card>
      ) : null}

      {s.myTasks ? (
        <Card title="Việc của tôi" action="Mở việc" to="/viec-cua-toi">
          <div className="grid" style={grid(2)}>
            <Num label="Quá hạn" value={s.myTasks.overdue} bad={s.myTasks.overdue > 0} />
            <Num label="Đến hạn hôm nay" value={s.myTasks.dueToday} />
          </div>
        </Card>
      ) : null}

      {s.deposits ? (
        <Card title="Lịch hôm nay chờ cọc" action="Mở lịch hẹn" to="/lich-hen">
          {s.deposits.items.length === 0 ? (
            <div className="muted" style={{ fontSize: 12.5 }}>Không có lịch chờ cọc.</div>
          ) : (
            <table>
              <tbody>
                {s.deposits.items.map((a) => (
                  <tr key={a.id}><td style={{ width: 52 }}><b>{hhmm(a.startAt)}</b></td><td>{a.customer.name}<div className="muted" style={{ fontSize: 11.5 }}>{a.title}</div></td><td>{vnd(a.depositAmount)}</td></tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      ) : null}

      {s.medicalFlags ? (
        <Card title="Tin có nội dung y khoa chờ bác sĩ" action="Mở hộp thư" to="/hop-thu">
          {s.medicalFlags.items.length === 0 ? (
            <div className="muted" style={{ fontSize: 12.5 }}>3 ngày qua không có tin y khoa.</div>
          ) : (
            <table>
              <tbody>
                {s.medicalFlags.items.map((c) => (
                  <tr key={c.id}><td><b>{c.title}</b><div className="muted" style={{ fontSize: 11.5 }}>{c.lastMessagePreview ?? ''}</div></td><td className="muted" style={{ fontSize: 11.5 }}>{relativeVi(c.medicalFlagAt)}</td></tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      ) : null}

      {s.aftercare ? (
        <Card title={`Chăm sóc sau điều trị đến hạn (${s.aftercare.total})`} action="Mở chăm sóc" to="/hau-phau">
          {s.aftercare.items.length === 0 ? (
            <div className="muted" style={{ fontSize: 12.5 }}>Không có việc chăm sóc đến hạn.</div>
          ) : (
            <table>
              <tbody>
                {s.aftercare.items.map((t) => (
                  <tr key={t.id}><td>{t.milestone ?? ''}</td><td>{t.customer?.name ?? t.title}</td></tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      ) : null}

      {s.marketing ? (
        <Card title={`Marketing tuần ${s.marketing.weekKey}`} action="Chỉ số tuần" to="/do-luong">
          <div className="grid" style={grid(3)}>
            <Num label="Chi phí quảng cáo" value={money(s.marketing.adsCost)} />
            <Num label="SĐT" value={s.marketing.phones} />
            <Num label="Chi phí/SĐT" value={money(s.marketing.costPerPhone)} />
            <Num label="Khách đến lần đầu" value={s.marketing.showups} />
            <Num label="Chi phí/khách đến" value={money(s.marketing.costPerShowup)} />
            <Num label="ROAS" value={s.marketing.roas ?? '-'} />
          </div>
        </Card>
      ) : null}

      {s.accounting ? (
        <Card title="Kế toán hôm nay" action="Xuất kế toán" to="/do-luong">
          <div className="grid" style={grid(2)}>
            <Num label={`Đã thu hôm nay (${s.accounting.paymentsToday} phiếu)`} value={money(s.accounting.collectedToday)} />
            <Num label="Hoá đơn quá hạn" value={s.accounting.overdueInvoices} bad={s.accounting.overdueInvoices > 0} />
            <Num label="Thưởng giới thiệu chờ chi" value={s.accounting.pendingReferralPayouts} />
          </div>
        </Card>
      ) : null}
    </>
  )
}
