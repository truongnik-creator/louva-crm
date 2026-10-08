import React, { useCallback, useEffect, useState } from 'react'
import { fetchStaff, getApiErrorMessage } from '../lib/api'
import {
  cancelVoucher,
  createVoucher,
  currentPeriod,
  fetchGiftItems,
  fetchGifts,
  fetchReferralReport,
  fetchVouchers,
  fetchViolations,
  flagViolation,
  markRewardPaid,
  revokeViolation,
  saveGiftItem,
  type GiftItem,
  type VoucherRow,
  type ViolationRow
} from '../lib/api-lo5'
import { useAuth } from '../lib/auth-context'
import { dateTimeVi, dateVi, vnd } from '../lib/format'
import { Empty, useToast } from '../components/ui'

/* TĂNG TRƯỞNG ĐỢT 3: giới thiệu khách (F19), voucher và quà tặng (F20), cờ vi
 * phạm chuyên môn cho thi đua (F18). */

const VOUCHER_STATE: Record<string, string> = { ACTIVE: 'Còn dùng', REDEEMED: 'Đã dùng', CANCELLED: 'Đã huỷ', EXPIRED: 'Hết hạn' }

function ReferralTab(): React.JSX.Element {
  const { say, fail } = useToast()
  const { can } = useAuth()
  const [period, setPeriod] = useState('month')
  const [data, setData] = useState<Awaited<ReturnType<typeof fetchReferralReport>> | null>(null)
  const load = useCallback(() => {
    fetchReferralReport(period)
      .then(setData)
      .catch((e) => fail(getApiErrorMessage(e)))
  }, [period, fail])
  useEffect(load, [load])
  return (
    <div className="card">
      <div className="row" style={{ marginBottom: 8 }}>
        <div className="sec-title" style={{ margin: 0 }}>Báo cáo giới thiệu khách</div>
        <select value={period} onChange={(e) => setPeriod(e.target.value)} style={{ marginLeft: 'auto', width: 150 }}>
          <option value="month">Tháng này</option>
          <option value="quarter">Quý này</option>
          <option value="7d">7 ngày</option>
        </select>
      </div>
      {data ? (
        <>
          <div className="grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)', marginBottom: 12 }}>
            <div className="kpi"><div className="lab">Khách được giới thiệu</div><div className="val">{data.totals.referees}</div></div>
            <div className="kpi"><div className="lab">Đã thưởng</div><div className="val">{data.totals.rewarded}</div></div>
            <div className="kpi"><div className="lab">Tổng thưởng</div><div className="val">{vnd(data.totals.rewardTotal)}</div></div>
            <div className="kpi"><div className="lab">Doanh thu từ khách được giới thiệu</div><div className="val">{vnd(data.totals.refereeRevenue)}</div></div>
          </div>
          {data.rows.length === 0 ? (
            <Empty>Kỳ này chưa có khách được giới thiệu.</Empty>
          ) : (
            <table>
              <thead><tr><th>Người giới thiệu</th><th>Khách mới</th><th>Đã thưởng</th><th>Tiền thưởng</th><th>Doanh thu khách mới</th></tr></thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr key={r.referrerId}>
                    <td>{r.referrer ? `${r.referrer.name} (${r.referrer.code})` : '-'}</td>
                    <td>{r.referees}</td>
                    <td>{r.rewarded}</td>
                    <td>{vnd(r.rewardTotal)}</td>
                    <td>{vnd(r.refereeRevenue)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div className="sec-title">Thưởng tiền mặt chờ chi</div>
          {data.pendingCash.length === 0 ? (
            <Empty>Không có khoản chờ chi.</Empty>
          ) : (
            <table>
              <tbody>
                {data.pendingCash.map((p) => (
                  <tr key={p.id}>
                    <td>{p.referrer?.name ?? '-'} giới thiệu {p.referee?.name ?? '-'}</td>
                    <td>{vnd(p.amount)}</td>
                    <td>{dateVi(p.createdAt)}</td>
                    <td>
                      {can('finance.approve') ? (
                        <button className="btn sm" onClick={() => void markRewardPaid(p.id).then(() => { say('Đã ghi nhận chi thưởng.'); load() }).catch((e) => fail(getApiErrorMessage(e)))}>
                          Đã chi
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      ) : null}
    </div>
  )
}

function VoucherTab(): React.JSX.Element {
  const { say, fail } = useToast()
  const { can } = useAuth()
  const [rows, setRows] = useState<VoucherRow[]>([])
  const [status, setStatus] = useState('')
  const [form, setForm] = useState({ value: '', expiresAt: '', note: '' })
  const manage = can('promotion.manage')
  const load = useCallback(() => {
    fetchVouchers({ status: status || undefined })
      .then(setRows)
      .catch((e) => fail(getApiErrorMessage(e)))
  }, [status, fail])
  useEffect(load, [load])
  const create = async (): Promise<void> => {
    try {
      const v = await createVoucher({ value: Number(form.value), expiresAt: form.expiresAt, note: form.note || undefined })
      say(`Đã tạo voucher ${v.code}.`)
      setForm({ value: '', expiresAt: '', note: '' })
      load()
    } catch (e) {
      fail(getApiErrorMessage(e))
    }
  }
  return (
    <div className="card">
      <div className="row" style={{ marginBottom: 8 }}>
        <div className="sec-title" style={{ margin: 0 }}>Voucher</div>
        <select value={status} onChange={(e) => setStatus(e.target.value)} style={{ marginLeft: 'auto', width: 150 }}>
          <option value="">Tất cả</option>
          {Object.entries(VOUCHER_STATE).map(([k, v]) => (
            <option key={k} value={k}>{v}</option>
          ))}
        </select>
      </div>
      {manage ? (
        <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
          <input placeholder="Giá trị (đồng)" value={form.value} onChange={(e) => setForm({ ...form, value: e.target.value.replace(/\D/g, '') })} style={{ width: 150 }} />
          <label style={{ fontSize: 12.5 }}>Hạn dùng <input type="date" value={form.expiresAt} onChange={(e) => setForm({ ...form, expiresAt: e.target.value })} /></label>
          <input placeholder="Ghi chú" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} style={{ width: 220 }} />
          <button className="btn sm" disabled={!form.value || !form.expiresAt} onClick={() => void create()}>Tạo voucher chung</button>
          <span className="muted" style={{ fontSize: 12 }}>Voucher gắn khách tạo ở hồ sơ khách.</span>
        </div>
      ) : null}
      {rows.length === 0 ? (
        <Empty>Chưa có voucher.</Empty>
      ) : (
        <table>
          <thead><tr><th>Mã</th><th>Khách</th><th>Giá trị</th><th>Hạn dùng</th><th>Nguồn</th><th>Trạng thái</th><th /></tr></thead>
          <tbody>
            {rows.map((v) => (
              <tr key={v.id}>
                <td><b>{v.code}</b></td>
                <td>{v.customer ? `${v.customer.name} (${v.customer.code})` : 'Dùng chung'}</td>
                <td>{vnd(v.value)}</td>
                <td>{dateVi(v.expiresAt)}</td>
                <td>{v.source === 'REFERRAL' ? 'Thưởng giới thiệu' : v.source === 'BIRTHDAY' ? 'Sinh nhật' : v.source === 'GIFT' ? 'Quà tặng' : 'Tạo tay'}</td>
                <td>{VOUCHER_STATE[v.state]}</td>
                <td>
                  {manage && v.state === 'ACTIVE' ? (
                    <button className="btn sm sec" onClick={() => void cancelVoucher(v.id).then(load).catch((e) => fail(getApiErrorMessage(e)))}>Huỷ</button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

function GiftTab(): React.JSX.Element {
  const { say, fail } = useToast()
  const { can } = useAuth()
  const [items, setItems] = useState<GiftItem[]>([])
  const [report, setReport] = useState<Awaited<ReturnType<typeof fetchGifts>> | null>(null)
  const [form, setForm] = useState({ name: '', cost: '' })
  const manage = can('promotion.manage')
  const load = useCallback(() => {
    fetchGiftItems(true).then(setItems).catch((e) => fail(getApiErrorMessage(e)))
    fetchGifts({ period: 'month' }).then(setReport).catch(() => undefined)
  }, [fail])
  useEffect(load, [load])
  const add = async (): Promise<void> => {
    try {
      await saveGiftItem({ name: form.name, cost: Number(form.cost) })
      say('Đã thêm quà vào danh mục.')
      setForm({ name: '', cost: '' })
      load()
    } catch (e) {
      fail(getApiErrorMessage(e))
    }
  }
  return (
    <div className="card">
      <div className="sec-title">Danh mục quà tặng khi khách ra về</div>
      {manage ? (
        <div className="row" style={{ gap: 8, marginBottom: 10 }}>
          <input placeholder="Tên quà" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} style={{ width: 220 }} />
          <input placeholder="Chi phí mỗi món (đồng)" value={form.cost} onChange={(e) => setForm({ ...form, cost: e.target.value.replace(/\D/g, '') })} style={{ width: 180 }} />
          <button className="btn sm" disabled={!form.name || !form.cost} onClick={() => void add()}>Thêm quà</button>
        </div>
      ) : null}
      {items.length === 0 ? (
        <Empty>Chưa có quà trong danh mục.</Empty>
      ) : (
        <table>
          <thead><tr><th>Quà</th><th>Chi phí</th><th>Trạng thái</th><th /></tr></thead>
          <tbody>
            {items.map((i) => (
              <tr key={i.id}>
                <td>{i.name}</td>
                <td>{vnd(i.cost)}</td>
                <td>{i.active ? 'Đang dùng' : 'Đã tắt'}</td>
                <td>
                  {manage ? (
                    <button className="btn sm sec" onClick={() => void saveGiftItem({ id: i.id, active: !i.active }).then(load).catch((e) => fail(getApiErrorMessage(e)))}>
                      {i.active ? 'Tắt' : 'Bật'}
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="sec-title">Quà đã tặng tháng này</div>
      {!report || report.rows.length === 0 ? (
        <Empty>Tháng này chưa tặng quà. Ghi nhận tặng quà ở hồ sơ khách.</Empty>
      ) : (
        <>
          <div style={{ marginBottom: 8 }}>
            Tổng chi phí: <b>{vnd(report.totalCost)}</b>
            {report.byItem.map((b) => ` · ${b.giftName}: ${b.quantity} (${vnd(b.totalCost)})`).join('')}
          </div>
          <table>
            <thead><tr><th>Ngày</th><th>Khách</th><th>Quà</th><th>SL</th><th>Chi phí</th><th>Người tặng</th></tr></thead>
            <tbody>
              {report.rows.map((r) => (
                <tr key={r.id}>
                  <td>{dateTimeVi(r.createdAt)}</td>
                  <td>{r.customer?.name ?? '-'}</td>
                  <td>{r.giftName}</td>
                  <td>{r.quantity}</td>
                  <td>{vnd(r.totalCost)}</td>
                  <td>{r.givenByName ?? '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  )
}

function ViolationTab(): React.JSX.Element {
  const { say, fail } = useToast()
  const { can } = useAuth()
  const [period, setPeriod] = useState(currentPeriod())
  const [rows, setRows] = useState<ViolationRow[]>([])
  const [staff, setStaff] = useState<Array<{ id: string; name: string }>>([])
  const [form, setForm] = useState({ userId: '', reason: '' })
  const load = useCallback(() => {
    fetchViolations(period).then(setRows).catch((e) => fail(getApiErrorMessage(e)))
  }, [period, fail])
  useEffect(load, [load])
  useEffect(() => {
    fetchStaff({ status: 'ACTIVE' })
      .then((s) => setStaff(s.map((u) => ({ id: u.id, name: u.name }))))
      .catch(() => undefined)
  }, [])
  const flag = async (): Promise<void> => {
    try {
      await flagViolation({ userId: form.userId, periodKey: period, reason: form.reason })
      say('Đã gắn cờ. Nhân viên bị loại khỏi thi đua tháng này.')
      setForm({ userId: '', reason: '' })
      load()
    } catch (e) {
      fail(getApiErrorMessage(e))
    }
  }
  return (
    <div className="card">
      <div className="row" style={{ marginBottom: 8 }}>
        <div className="sec-title" style={{ margin: 0 }}>Cờ vi phạm chuyên môn (loại khỏi thi đua)</div>
        <input type="month" value={period} onChange={(e) => setPeriod(e.target.value)} style={{ marginLeft: 'auto', width: 160 }} />
      </div>
      {can('hr.update') ? (
        <div className="row" style={{ gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
          <select value={form.userId} onChange={(e) => setForm({ ...form, userId: e.target.value })} style={{ width: 220 }}>
            <option value="">Chọn nhân viên</option>
            {staff.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
          <input placeholder="Lý do (tối thiểu 5 ký tự)" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} style={{ width: 320 }} />
          <button className="btn sm" disabled={!form.userId || form.reason.trim().length < 5} onClick={() => void flag()}>Gắn cờ</button>
        </div>
      ) : null}
      {rows.length === 0 ? (
        <Empty>Tháng này không có cờ vi phạm.</Empty>
      ) : (
        <table>
          <thead><tr><th>Nhân viên</th><th>Lý do</th><th>Người gắn</th><th>Lúc</th><th /></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} style={r.revokedAt ? { opacity: 0.5 } : undefined}>
                <td>{r.userName ?? '-'}</td>
                <td>{r.reason}</td>
                <td>{r.flaggedByName ?? '-'}</td>
                <td>{dateTimeVi(r.createdAt)}</td>
                <td>
                  {r.revokedAt ? 'Đã gỡ' : can('hr.update') ? (
                    <button className="btn sm sec" onClick={() => void revokeViolation(r.id).then(load).catch((e) => fail(getApiErrorMessage(e)))}>Gỡ cờ</button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

export default function Growth(): React.JSX.Element {
  const { can } = useAuth()
  const tabs = [
    { key: 'referral', label: 'Giới thiệu khách', show: can('customer.read') || can('accounting.read') || can('lead.read'), el: <ReferralTab /> },
    { key: 'voucher', label: 'Voucher', show: can('finance.read'), el: <VoucherTab /> },
    { key: 'gift', label: 'Quà tặng', show: can('visit.read') || can('finance.read') || can('promotion.manage'), el: <GiftTab /> },
    { key: 'violation', label: 'Cờ vi phạm', show: can('hr.read'), el: <ViolationTab /> }
  ].filter((t) => t.show)
  const [active, setActive] = useState(tabs[0]?.key ?? '')
  const tab = tabs.find((t) => t.key === active) ?? tabs[0]
  if (!tab) return <div className="card"><Empty>Vai trò của bạn chưa dùng được màn này.</Empty></div>
  return (
    <>
      <div className="tabs">
        {tabs.map((t) => (
          <button key={t.key} className={t.key === tab.key ? 'on' : ''} onClick={() => setActive(t.key)}>{t.label}</button>
        ))}
      </div>
      {tab.el}
    </>
  )
}
