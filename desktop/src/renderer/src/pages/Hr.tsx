import React, { useCallback, useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'
import {
  calculateCommissions,
  checkInAttendance,
  checkOutAttendance,
  closeCommissions,
  createCommissionRule,
  createKpiDefinition,
  createLeave,
  decideLeave,
  fetchAttendances,
  fetchCommissionRules,
  fetchCommissions,
  fetchKpi,
  fetchLeaves,
  fetchStaff,
  getApiErrorMessage,
  saveKpiValue,
  type AttendanceRow,
  type CommissionData,
  type CommissionRuleRow,
  type KpiRow,
  type LeaveRow
} from '../lib/api'
import { useAuth } from '../lib/auth-context'
import { dateVi, hhmm, minutesLabel, toISODate, vnd } from '../lib/format'
import { Empty, Modal, Tag, useToast } from '../components/ui'
import type { StaffUser } from '../lib/types'

/* NHÂN SỰ — ba màn dùng chung khung: /cham-cong · /luong · /kpi-dieu-duong
 *
 * Nguyên tắc lấy từ tài liệu vận hành và cài cứng vào backend:
 *   · Hoa hồng tính trên TIỀN THỰC THU, không phải doanh số ký.
 *   · KPI điều dưỡng tách khỏi doanh số — không gắn tiền vào tay người chỉ
 *     định chuyên môn. */

function periodKeyOf(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

const ATT_STATUS: Record<string, { t: string; bg: string; fg: string }> = {
  PRESENT: { t: 'Có mặt', bg: '#DCFCE7', fg: '#15803D' },
  LATE: { t: 'Đi muộn', bg: '#FEF3C7', fg: '#B45309' },
  ABSENT: { t: 'Vắng', bg: '#FEE2E2', fg: '#B91C1C' },
  ON_LEAVE: { t: 'Nghỉ phép', bg: '#DBEAFE', fg: '#1D4ED8' },
  HOLIDAY: { t: 'Ngày nghỉ', bg: '#F1F5F9', fg: '#475569' }
}

const LEAVE_STATUS: Record<string, { t: string; bg: string; fg: string }> = {
  PENDING: { t: 'Chờ duyệt', bg: '#FEF3C7', fg: '#B45309' },
  APPROVED: { t: 'Đã duyệt', bg: '#DCFCE7', fg: '#15803D' },
  REJECTED: { t: 'Từ chối', bg: '#FEE2E2', fg: '#B91C1C' },
  CANCELLED: { t: 'Đã huỷ', bg: '#F1F5F9', fg: '#475569' }
}

const LEAVE_TYPE: Record<string, string> = {
  ANNUAL: 'Phép năm',
  SICK: 'Nghỉ ốm',
  UNPAID: 'Nghỉ không lương',
  MATERNITY: 'Thai sản',
  OTHER: 'Khác'
}

export default function Hr(): React.JSX.Element {
  const location = useLocation()
  if (location.pathname.includes('luong')) return <CommissionView />
  if (location.pathname.includes('kpi-dieu-duong')) return <KpiView />
  return <AttendanceView />
}

/* ------------------------------------------------------------- CHẤM CÔNG */

function AttendanceView(): React.JSX.Element {
  const { can, branchId } = useAuth()
  const { say, fail } = useToast()

  const [period, setPeriod] = useState(periodKeyOf())
  const [items, setItems] = useState<AttendanceRow[]>([])
  const [stats, setStats] = useState({ present: 0, late: 0, absent: 0, onLeave: 0 })
  const [leaves, setLeaves] = useState<LeaveRow[]>([])
  const [tab, setTab] = useState<'attendance' | 'leave'>('attendance')
  const [asking, setAsking] = useState(false)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [att, lv] = await Promise.all([fetchAttendances({ period }), fetchLeaves()])
      setItems(att.items)
      setStats(att.stats)
      setLeaves(lv)
    } catch (err) {
      fail(getApiErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }, [period, fail])

  useEffect(() => {
    void load()
  }, [load, branchId])

  const doCheckIn = async (): Promise<void> => {
    try {
      const r = await checkInAttendance()
      say(
        r.lateMinutes > 0
          ? `Đã chấm công vào — đi muộn ${r.lateMinutes} phút so với ca.`
          : r.hadShift
            ? 'Đã chấm công vào, đúng giờ ca.'
            : 'Đã chấm công vào (hôm nay không có ca được xếp).'
      )
      void load()
    } catch (err) {
      fail(getApiErrorMessage(err))
    }
  }

  const doCheckOut = async (): Promise<void> => {
    try {
      const r = await checkOutAttendance()
      say(`Đã chấm công ra — làm ${minutesLabel(r.workedMinutes)}.`)
      void load()
    } catch (err) {
      fail(getApiErrorMessage(err))
    }
  }

  const decide = async (leave: LeaveRow, status: string): Promise<void> => {
    try {
      await decideLeave(leave.id, status)
      say(status === 'APPROVED' ? 'Đã duyệt đơn nghỉ.' : 'Đã từ chối đơn nghỉ.')
      void load()
    } catch (err) {
      fail(getApiErrorMessage(err))
    }
  }

  const pending = leaves.filter((l) => l.status === 'PENDING')

  return (
    <>
      <div className="grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)', marginBottom: 12 }}>
        <div className="kpi">
          <div className="lab">Lượt chấm công</div>
          <div className="val">{items.length}</div>
        </div>
        <div className="kpi">
          <div className="lab">Đi muộn</div>
          <div className="val" style={{ color: stats.late ? 'var(--warn)' : undefined }}>
            {stats.late}
          </div>
        </div>
        <div className="kpi">
          <div className="lab">Nghỉ phép</div>
          <div className="val">{stats.onLeave}</div>
        </div>
        <div className="kpi">
          <div className="lab">Đơn chờ duyệt</div>
          <div className="val" style={{ color: pending.length ? 'var(--warn)' : undefined }}>
            {pending.length}
          </div>
        </div>
      </div>

      <div className="row" style={{ marginBottom: 12, flexWrap: 'wrap' }}>
        <input
          className="input"
          type="month"
          style={{ width: 'auto' }}
          value={period}
          onChange={(e) => setPeriod(e.target.value)}
        />
        <button className="btn sm" onClick={() => void doCheckIn()}>
          Chấm công vào
        </button>
        <button className="btn sec sm" onClick={() => void doCheckOut()}>
          Chấm công ra
        </button>
        <button className="btn sec sm" style={{ marginLeft: 'auto' }} onClick={() => setAsking(true)}>
          + Xin nghỉ
        </button>
      </div>

      <div className="tabs">
        <button className={tab === 'attendance' ? 'on' : ''} onClick={() => setTab('attendance')}>
          Bảng chấm công ({items.length})
        </button>
        <button className={tab === 'leave' ? 'on' : ''} onClick={() => setTab('leave')}>
          Đơn nghỉ phép ({leaves.length})
        </button>
      </div>

      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        {loading ? (
          <Empty>Đang tải…</Empty>
        ) : tab === 'leave' ? (
          leaves.length === 0 ? (
            <Empty>Chưa có đơn nghỉ nào.</Empty>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Nhân viên</th>
                  <th>Loại</th>
                  <th>Từ ngày</th>
                  <th>Đến ngày</th>
                  <th>Số ngày</th>
                  <th>Lý do</th>
                  <th>Trạng thái</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {leaves.map((l) => (
                  <tr key={l.id}>
                    <td>
                      <b>{l.user.name}</b>
                    </td>
                    <td>{LEAVE_TYPE[l.type] ?? l.type}</td>
                    <td>{dateVi(l.fromDate)}</td>
                    <td>{dateVi(l.toDate)}</td>
                    <td>{l.days}</td>
                    <td>{l.reason}</td>
                    <td>
                      <Tag style={LEAVE_STATUS[l.status] ?? LEAVE_STATUS.PENDING} />
                      {l.approver ? (
                        <div className="muted" style={{ fontSize: 11.5 }}>
                          {l.approver.name}
                        </div>
                      ) : null}
                    </td>
                    <td>
                      {can('shift.approve') && l.status === 'PENDING' ? (
                        <div className="row" style={{ gap: 4 }}>
                          <button className="btn sm" onClick={() => void decide(l, 'APPROVED')}>
                            Duyệt
                          </button>
                          <button className="btn sec sm" onClick={() => void decide(l, 'REJECTED')}>
                            Từ chối
                          </button>
                        </div>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        ) : items.length === 0 ? (
          <Empty>Chưa có bản ghi chấm công nào trong kỳ này.</Empty>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Ngày</th>
                <th>Nhân viên</th>
                <th>Giờ vào</th>
                <th>Giờ ra</th>
                <th>Đi muộn</th>
                <th>Về sớm</th>
                <th>Thời gian làm</th>
                <th>Trạng thái</th>
              </tr>
            </thead>
            <tbody>
              {items.map((a) => (
                <tr key={a.id}>
                  <td>{dateVi(a.date)}</td>
                  <td>
                    <b>
                      {a.user.title ? `${a.user.title} ` : ''}
                      {a.user.name}
                    </b>
                  </td>
                  <td>{a.checkInAt ? hhmm(a.checkInAt) : '—'}</td>
                  <td>{a.checkOutAt ? hhmm(a.checkOutAt) : '—'}</td>
                  <td style={{ color: a.lateMinutes ? 'var(--warn)' : undefined }}>
                    {a.lateMinutes ? `${a.lateMinutes} phút` : '—'}
                  </td>
                  <td style={{ color: a.earlyMinutes ? 'var(--warn)' : undefined }}>
                    {a.earlyMinutes ? `${a.earlyMinutes} phút` : '—'}
                  </td>
                  <td>{a.workedMinutes ? minutesLabel(a.workedMinutes) : '—'}</td>
                  <td>
                    <Tag style={ATT_STATUS[a.status] ?? ATT_STATUS.PRESENT} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {asking ? (
        <LeaveModal
          onClose={() => setAsking(false)}
          onDone={() => {
            setAsking(false)
            void load()
          }}
        />
      ) : null}
    </>
  )
}

function LeaveModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }): React.JSX.Element {
  const { say, fail } = useToast()
  const [type, setType] = useState('ANNUAL')
  const [fromDate, setFromDate] = useState(toISODate(new Date()))
  const [toDate, setToDate] = useState(toISODate(new Date()))
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)

  const submit = async (): Promise<void> => {
    if (reason.trim().length < 3) {
      fail('Nhập lý do nghỉ.')
      return
    }
    setSaving(true)
    try {
      await createLeave({ type, fromDate, toDate, reason: reason.trim() })
      say('Đã gửi đơn nghỉ, chờ quản lý duyệt.')
      onDone()
    } catch (err) {
      fail(getApiErrorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      title="Xin nghỉ phép"
      onClose={onClose}
      footer={
        <>
          <button className="btn sec" onClick={onClose}>
            Huỷ
          </button>
          <button className="btn" onClick={() => void submit()} disabled={saving}>
            {saving ? 'Đang gửi…' : 'Gửi đơn'}
          </button>
        </>
      }
    >
      <div className="field">
        <label>Loại nghỉ</label>
        <select className="input" value={type} onChange={(e) => setType(e.target.value)}>
          {Object.entries(LEAVE_TYPE).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
      </div>
      <div className="row" style={{ gap: 10 }}>
        <div className="field" style={{ flex: 1 }}>
          <label>Từ ngày</label>
          <input className="input" type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
        </div>
        <div className="field" style={{ flex: 1 }}>
          <label>Đến ngày</label>
          <input className="input" type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} />
        </div>
      </div>
      <div className="field">
        <label>Lý do *</label>
        <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} />
      </div>
    </Modal>
  )
}

/* ------------------------------------------------------ LƯƠNG & HOA HỒNG */

function CommissionView(): React.JSX.Element {
  const { can, branchId } = useAuth()
  const { say, fail } = useToast()

  const [period, setPeriod] = useState(periodKeyOf())
  const [data, setData] = useState<CommissionData | null>(null)
  const [rules, setRules] = useState<CommissionRuleRow[]>([])
  const [tab, setTab] = useState<'summary' | 'entries' | 'rules'>('summary')
  const [addingRule, setAddingRule] = useState(false)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const [c, r] = await Promise.all([fetchCommissions({ period }), fetchCommissionRules()])
      setData(c)
      setRules(r)
    } catch (err) {
      fail(getApiErrorMessage(err))
    }
  }, [period, fail])

  useEffect(() => {
    void load()
  }, [load, branchId])

  const recalc = async (): Promise<void> => {
    setBusy(true)
    try {
      const r = await calculateCommissions(period)
      say(`Đã tính lại kỳ ${r.period}: ${r.created} dòng mới, tổng ${vnd(r.total)}.`)
      void load()
    } catch (err) {
      fail(getApiErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const close = async (): Promise<void> => {
    if (!window.confirm(`Chốt hoa hồng kỳ ${period}? Sau khi chốt, tính lại sẽ không đổi các dòng đã duyệt.`)) return
    setBusy(true)
    try {
      const r = await closeCommissions(period)
      say(`Đã chốt kỳ ${period} — duyệt ${r.approved} dòng.`)
      void load()
    } catch (err) {
      fail(getApiErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="alert wr">
        Hoa hồng tính trên <b>TIỀN THỰC THU</b> trong kỳ, không phải doanh số ký. Hợp đồng ký rồi chưa
        thu được tiền thì chưa phát sinh hoa hồng.
      </div>

      <div className="grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)', marginBottom: 12 }}>
        <div className="kpi">
          <div className="lab">Tổng hoa hồng kỳ {period}</div>
          <div className="val">{vnd(data?.total ?? 0)}</div>
        </div>
        <div className="kpi">
          <div className="lab">Số người được hưởng</div>
          <div className="val">{data?.summary.length ?? 0}</div>
        </div>
        <div className="kpi">
          <div className="lab">Quy tắc đang áp dụng</div>
          <div className="val">{rules.filter((r) => r.active).length}</div>
        </div>
      </div>

      <div className="row" style={{ marginBottom: 12, flexWrap: 'wrap' }}>
        <input
          className="input"
          type="month"
          style={{ width: 'auto' }}
          value={period}
          onChange={(e) => setPeriod(e.target.value)}
        />
        {can('hr.update') ? (
          <>
            <button className="btn sec sm" onClick={() => void recalc()} disabled={busy}>
              Tính lại hoa hồng
            </button>
            <button className="btn sm" onClick={() => void close()} disabled={busy}>
              Chốt kỳ
            </button>
          </>
        ) : null}
        {can('hr.create') ? (
          <button className="btn sec sm" style={{ marginLeft: 'auto' }} onClick={() => setAddingRule(true)}>
            + Quy tắc hoa hồng
          </button>
        ) : null}
      </div>

      <div className="tabs">
        <button className={tab === 'summary' ? 'on' : ''} onClick={() => setTab('summary')}>
          Tổng hợp theo người
        </button>
        <button className={tab === 'entries' ? 'on' : ''} onClick={() => setTab('entries')}>
          Chi tiết từng khoản ({data?.entries.length ?? 0})
        </button>
        <button className={tab === 'rules' ? 'on' : ''} onClick={() => setTab('rules')}>
          Quy tắc ({rules.length})
        </button>
      </div>

      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        {!data ? (
          <Empty>Đang tải…</Empty>
        ) : tab === 'rules' ? (
          rules.length === 0 ? (
            <Empty>Chưa có quy tắc hoa hồng nào. Bấm “+ Quy tắc hoa hồng” để tạo.</Empty>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Tên quy tắc</th>
                  <th>Vai trò hưởng</th>
                  <th>Căn cứ tính</th>
                  <th>Tỉ lệ</th>
                  <th>Dịch vụ áp dụng</th>
                  <th>Trạng thái</th>
                </tr>
              </thead>
              <tbody>
                {rules.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <b>{r.name}</b>
                    </td>
                    <td>
                      <span className="tag out">{r.roleCode}</span>
                    </td>
                    <td>
                      {r.basis === 'COLLECTED' ? (
                        <span className="tag" style={{ background: '#DCFCE7', color: '#15803D' }}>
                          Tiền thực thu
                        </span>
                      ) : (
                        <span className="tag" style={{ background: '#FEF3C7', color: '#B45309' }}>
                          Doanh số ký
                        </span>
                      )}
                    </td>
                    <td>
                      <b>{(r.percent / 10).toString().replace('.', ',')}%</b>
                    </td>
                    <td className="muted">{r.service?.name ?? 'Mọi dịch vụ'}</td>
                    <td>{r.active ? 'Đang dùng' : 'Ngưng'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        ) : tab === 'entries' ? (
          data.entries.length === 0 ? (
            <Empty>Chưa có khoản hoa hồng nào trong kỳ. Bấm “Tính lại hoa hồng”.</Empty>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Nhân viên</th>
                  <th>Phiếu thu</th>
                  <th>Tiền thu</th>
                  <th>Tỉ lệ</th>
                  <th>Hoa hồng</th>
                  <th>Quy tắc</th>
                  <th>Trạng thái</th>
                </tr>
              </thead>
              <tbody>
                {data.entries.map((e) => (
                  <tr key={e.id}>
                    <td>
                      <b>{e.user.name}</b>
                    </td>
                    <td className="muted">{e.payment?.code ?? '—'}</td>
                    <td>{vnd(e.baseAmount)}</td>
                    <td>{(e.percent / 10).toString().replace('.', ',')}%</td>
                    <td>
                      <b>{vnd(e.amount)}</b>
                    </td>
                    <td className="muted">{e.rule?.name ?? '—'}</td>
                    <td>
                      <span className="tag out">{e.status}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        ) : data.summary.length === 0 ? (
          <Empty>Chưa có hoa hồng trong kỳ này.</Empty>
        ) : (
          <table>
            <thead>
              <tr>
                <th style={{ width: 40 }}>#</th>
                <th>Nhân viên</th>
                <th>Số khoản</th>
                <th>Tổng hoa hồng</th>
                <th style={{ width: 220 }}>Tỉ trọng</th>
              </tr>
            </thead>
            <tbody>
              {data.summary.map((s, i) => (
                <tr key={s.userId}>
                  <td className="muted">{i + 1}</td>
                  <td>
                    <b>{s.name}</b>
                  </td>
                  <td>{s.count}</td>
                  <td>
                    <b>{vnd(s.total)}</b>
                  </td>
                  <td>
                    <div className="bar">
                      <i style={{ width: `${data.total ? (s.total / data.total) * 100 : 0}%` }} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {addingRule ? (
        <RuleModal
          onClose={() => setAddingRule(false)}
          onDone={() => {
            setAddingRule(false)
            void load()
          }}
        />
      ) : null}
    </>
  )
}

function RuleModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }): React.JSX.Element {
  const { say, fail } = useToast()
  const [name, setName] = useState('')
  const [roleCode, setRoleCode] = useState('TU_VAN_VIEN')
  const [basis, setBasis] = useState('COLLECTED')
  const [percentDisplay, setPercentDisplay] = useState(3.5)
  const [saving, setSaving] = useState(false)

  const submit = async (): Promise<void> => {
    if (name.trim().length < 2) {
      fail('Nhập tên quy tắc.')
      return
    }
    setSaving(true)
    try {
      await createCommissionRule({
        name: name.trim(),
        roleCode,
        basis,
        percent: Math.round(percentDisplay * 10)
      })
      say('Đã tạo quy tắc hoa hồng.')
      onDone()
    } catch (err) {
      fail(getApiErrorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      title="Quy tắc hoa hồng"
      onClose={onClose}
      footer={
        <>
          <button className="btn sec" onClick={onClose}>
            Huỷ
          </button>
          <button className="btn" onClick={() => void submit()} disabled={saving}>
            {saving ? 'Đang lưu…' : 'Tạo quy tắc'}
          </button>
        </>
      }
    >
      <div className="field">
        <label>Tên quy tắc *</label>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Tư vấn viên 3,5% thực thu" />
      </div>
      <div className="field">
        <label>Vai trò được hưởng</label>
        <select className="input" value={roleCode} onChange={(e) => setRoleCode(e.target.value)}>
          <option value="TU_VAN_VIEN">Tư vấn viên</option>
          <option value="TELESALE">Telesale</option>
          <option value="LE_TAN">Lễ tân</option>
          <option value="QUAN_LY_CO_SO">Quản lý cơ sở</option>
        </select>
      </div>
      <div className="field">
        <label>Căn cứ tính</label>
        <select className="input" value={basis} onChange={(e) => setBasis(e.target.value)}>
          <option value="COLLECTED">Tiền thực thu (khuyến nghị)</option>
          <option value="SIGNED">Doanh số ký</option>
        </select>
        {basis === 'SIGNED' ? (
          <div className="alert wr" style={{ marginTop: 8 }}>
            Tính trên doanh số ký nghĩa là trả hoa hồng cho hợp đồng chưa thu được tiền. Chỉ chọn khi
            chủ đầu tư chấp nhận rủi ro đó.
          </div>
        ) : null}
      </div>
      <div className="field">
        <label>Tỉ lệ (%)</label>
        <input
          className="input"
          type="number"
          step="0.1"
          value={percentDisplay}
          onChange={(e) => setPercentDisplay(Number(e.target.value))}
        />
      </div>
    </Modal>
  )
}

/* --------------------------------------------------------- KPI ĐIỀU DƯỠNG */

function KpiView(): React.JSX.Element {
  const { can, branchId } = useAuth()
  const { say, fail } = useToast()

  const [period, setPeriod] = useState(periodKeyOf())
  const [group, setGroup] = useState('NURSING')
  const [rows, setRows] = useState<KpiRow[]>([])
  const [definitions, setDefinitions] = useState<Array<{ id: string; code: string; name: string; group: string; unit: string }>>([])
  const [staff, setStaff] = useState<StaffUser[]>([])
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState(false)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [k, s] = await Promise.all([fetchKpi({ period, group }), fetchStaff().catch(() => [])])
      setRows(k.rows)
      setDefinitions(k.definitions)
      setStaff(s)
    } catch (err) {
      fail(getApiErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }, [period, group, fail])

  useEffect(() => {
    void load()
  }, [load, branchId])

  const achieved = rows.filter((r) => r.achieved).length

  return (
    <>
      <div className="alert wr">
        KPI chuyên môn cố ý <b>tách khỏi doanh số</b>. Gắn tiền vào tay người chỉ định chuyên môn là mô
        hình tự huỷ — điều dưỡng và bác sĩ được đo bằng chất lượng chăm sóc, không bằng số hợp đồng.
      </div>

      <div className="grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)', marginBottom: 12 }}>
        <div className="kpi">
          <div className="lab">Chỉ tiêu đang theo dõi</div>
          <div className="val">{rows.length}</div>
        </div>
        <div className="kpi">
          <div className="lab">Đạt chỉ tiêu</div>
          <div className="val up">{achieved}</div>
        </div>
        <div className="kpi">
          <div className="lab">Chưa đạt</div>
          <div className="val" style={{ color: rows.length - achieved ? 'var(--warn)' : undefined }}>
            {rows.length - achieved}
          </div>
        </div>
      </div>

      <div className="row" style={{ marginBottom: 12, flexWrap: 'wrap' }}>
        <input
          className="input"
          type="month"
          style={{ width: 'auto' }}
          value={period}
          onChange={(e) => setPeriod(e.target.value)}
        />
        <select className="input" style={{ width: 'auto' }} value={group} onChange={(e) => setGroup(e.target.value)}>
          <option value="NURSING">Điều dưỡng</option>
          <option value="DOCTOR">Bác sĩ</option>
          <option value="RECEPTION">Lễ tân</option>
          <option value="SALES">Kinh doanh</option>
        </select>
        {can('nursing_kpi.create') ? (
          <>
            <button className="btn sec sm" style={{ marginLeft: 'auto' }} onClick={() => setAdding(true)}>
              + Chỉ tiêu mới
            </button>
            <button className="btn sm" onClick={() => setEditing(true)} disabled={!definitions.length}>
              Đặt chỉ tiêu / nhập kết quả
            </button>
          </>
        ) : null}
      </div>

      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        {loading ? (
          <Empty>Đang tải…</Empty>
        ) : rows.length === 0 ? (
          <Empty>
            Chưa đặt chỉ tiêu nào cho nhóm này trong kỳ {period}.
            <br />
            <span className="muted">
              Tạo chỉ tiêu (ví dụ “Tỉ lệ gọi hậu phẫu đúng mốc”), rồi đặt mức cho từng người.
            </span>
          </Empty>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Chỉ tiêu</th>
                <th>Nhân viên</th>
                <th>Mục tiêu</th>
                <th>Thực đạt</th>
                <th>Đạt (%)</th>
                <th style={{ width: 200 }}>Tiến độ</th>
                <th>Kết quả</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={`${r.definitionId}-${r.userId}-${i}`}>
                  <td>
                    <b>{r.name}</b>
                    <div className="muted" style={{ fontSize: 11.5 }}>
                      {r.code}
                    </div>
                  </td>
                  <td>{r.userName ?? '—'}</td>
                  <td>
                    {r.target} {r.unit}
                  </td>
                  <td>
                    <b>
                      {r.actual} {r.unit}
                    </b>
                  </td>
                  <td>{r.percent}%</td>
                  <td>
                    <div className="bar">
                      <i style={{ width: `${Math.min(100, r.percent)}%` }} />
                    </div>
                  </td>
                  <td>
                    {r.achieved ? (
                      <span className="tag" style={{ background: '#DCFCE7', color: '#15803D' }}>
                        Đạt
                      </span>
                    ) : (
                      <span className="tag" style={{ background: '#FEF3C7', color: '#B45309' }}>
                        Chưa đạt
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {adding ? (
        <KpiDefModal
          group={group}
          onClose={() => setAdding(false)}
          onDone={() => {
            setAdding(false)
            void load()
          }}
        />
      ) : null}
      {editing ? (
        <KpiValueModal
          period={period}
          definitions={definitions}
          staff={staff}
          onClose={() => setEditing(false)}
          onDone={() => {
            setEditing(false)
            void load()
          }}
        />
      ) : null}
    </>
  )
}

function KpiDefModal({
  group,
  onClose,
  onDone
}: {
  group: string
  onClose: () => void
  onDone: () => void
}): React.JSX.Element {
  const { say, fail } = useToast()
  const [form, setForm] = useState({ code: '', name: '', unit: 'số', higherIsBetter: true })
  const [saving, setSaving] = useState(false)

  const submit = async (): Promise<void> => {
    if (!form.code || !form.name) {
      fail('Nhập mã và tên chỉ tiêu.')
      return
    }
    setSaving(true)
    try {
      await createKpiDefinition({ ...form, group })
      say('Đã tạo chỉ tiêu.')
      onDone()
    } catch (err) {
      fail(getApiErrorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      title="Chỉ tiêu KPI mới"
      onClose={onClose}
      footer={
        <>
          <button className="btn sec" onClick={onClose}>
            Huỷ
          </button>
          <button className="btn" onClick={() => void submit()} disabled={saving}>
            {saving ? 'Đang lưu…' : 'Tạo'}
          </button>
        </>
      }
    >
      <div className="field">
        <label>Mã chỉ tiêu *</label>
        <input
          className="input"
          value={form.code}
          onChange={(e) => setForm((f) => ({ ...f, code: e.target.value }))}
          placeholder="DD_GOI_HAU_PHAU"
        />
      </div>
      <div className="field">
        <label>Tên chỉ tiêu *</label>
        <input
          className="input"
          value={form.name}
          onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
          placeholder="Số ca gọi hậu phẫu đúng mốc N1/N3"
        />
      </div>
      <div className="field">
        <label>Đơn vị</label>
        <input
          className="input"
          value={form.unit}
          onChange={(e) => setForm((f) => ({ ...f, unit: e.target.value }))}
        />
      </div>
      <label className="row" style={{ fontSize: 13, gap: 6 }}>
        <input
          type="checkbox"
          checked={form.higherIsBetter}
          onChange={(e) => setForm((f) => ({ ...f, higherIsBetter: e.target.checked }))}
        />
        Càng cao càng tốt (bỏ tích nếu là chỉ tiêu càng thấp càng tốt, ví dụ số ca biến chứng)
      </label>
    </Modal>
  )
}

function KpiValueModal({
  period,
  definitions,
  staff,
  onClose,
  onDone
}: {
  period: string
  definitions: Array<{ id: string; name: string; unit: string }>
  staff: StaffUser[]
  onClose: () => void
  onDone: () => void
}): React.JSX.Element {
  const { say, fail } = useToast()
  const [definitionId, setDefinitionId] = useState(definitions[0]?.id ?? '')
  const [userId, setUserId] = useState('')
  const [target, setTarget] = useState(0)
  const [actual, setActual] = useState(0)
  const [saving, setSaving] = useState(false)

  const submit = async (): Promise<void> => {
    if (!definitionId || !userId) {
      fail('Chọn chỉ tiêu và nhân viên.')
      return
    }
    setSaving(true)
    try {
      await saveKpiValue({ definitionId, userId, periodKey: period, target, actual })
      say('Đã lưu chỉ tiêu.')
      onDone()
    } catch (err) {
      fail(getApiErrorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      title={`Đặt chỉ tiêu kỳ ${period}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn sec" onClick={onClose}>
            Huỷ
          </button>
          <button className="btn" onClick={() => void submit()} disabled={saving}>
            {saving ? 'Đang lưu…' : 'Lưu'}
          </button>
        </>
      }
    >
      <div className="field">
        <label>Chỉ tiêu</label>
        <select className="input" value={definitionId} onChange={(e) => setDefinitionId(e.target.value)}>
          {definitions.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label>Nhân viên</label>
        <select className="input" value={userId} onChange={(e) => setUserId(e.target.value)}>
          <option value="">— Chọn —</option>
          {staff.map((s) => (
            <option key={s.id} value={s.id}>
              {s.title ? `${s.title} ` : ''}
              {s.name}
            </option>
          ))}
        </select>
      </div>
      <div className="row" style={{ gap: 10 }}>
        <div className="field" style={{ flex: 1 }}>
          <label>Mục tiêu</label>
          <input className="input" type="number" value={target} onChange={(e) => setTarget(Number(e.target.value))} />
        </div>
        <div className="field" style={{ flex: 1 }}>
          <label>Thực đạt</label>
          <input className="input" type="number" value={actual} onChange={(e) => setActual(Number(e.target.value))} />
        </div>
      </div>
    </Modal>
  )
}
