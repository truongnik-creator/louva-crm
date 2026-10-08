import React, { useCallback, useEffect, useState } from 'react'
import { fetchStaff, getApiErrorMessage } from '../lib/api'
import {
  createReferralCode,
  createVoucher,
  fetchCustomerContracts,
  fetchGiftItems,
  fetchGifts,
  fetchReferral,
  fetchVouchers,
  logGift,
  redeemVoucher,
  saveContractAttribution,
  setReferrer,
  type ContractLite,
  type GiftItem,
  type ReferralInfo,
  type VoucherRow
} from '../lib/api-lo5'
import { useAuth } from '../lib/auth-context'
import { dateTimeVi, dateVi, vnd } from '../lib/format'
import { Empty, useToast } from './ui'

/* Hồ sơ khách: giới thiệu (F19), voucher và quà (F20), ghi nhận ai chốt hợp
 * đồng cho lương thưởng (F17). */

const STATE: Record<string, string> = { ACTIVE: 'Còn dùng', REDEEMED: 'Đã dùng', CANCELLED: 'Đã huỷ', EXPIRED: 'Hết hạn' }

export default function CustomerGrowthTab({ customerId }: { customerId: string }): React.JSX.Element {
  const { say, fail } = useToast()
  const { can } = useAuth()
  const [ref, setRef] = useState<ReferralInfo | null>(null)
  const [code, setCode] = useState('')
  const [vouchers, setVouchers] = useState<VoucherRow[]>([])
  const [contracts, setContracts] = useState<ContractLite[]>([])
  const [items, setItems] = useState<GiftItem[]>([])
  const [gifts, setGifts] = useState<Awaited<ReturnType<typeof fetchGifts>> | null>(null)
  const [staff, setStaff] = useState<Array<{ id: string; name: string }>>([])
  const [vForm, setVForm] = useState({ value: '', expiresAt: '' })
  const [redeem, setRedeem] = useState({ code: '', contractId: '' })
  const [gift, setGift] = useState({ giftItemId: '', quantity: '1' })

  const load = useCallback(() => {
    fetchReferral(customerId).then(setRef).catch((e) => fail(getApiErrorMessage(e)))
    fetchVouchers({ customerId }).then(setVouchers).catch(() => undefined)
    if (can('finance.read')) fetchCustomerContracts(customerId).then(setContracts).catch(() => undefined)
    if (can('visit.read') || can('finance.read')) {
      fetchGifts({ customerId }).then(setGifts).catch(() => undefined)
      fetchGiftItems().then(setItems).catch(() => undefined)
    }
  }, [customerId, can, fail])

  useEffect(load, [load])
  useEffect(() => {
    if (can('finance.update')) fetchStaff({ status: 'ACTIVE' }).then((s) => setStaff(s.map((u) => ({ id: u.id, name: u.name })))).catch(() => undefined)
  }, [can])

  const run = async (fn: () => Promise<unknown>, ok: string): Promise<void> => {
    try {
      await fn()
      say(ok)
      load()
    } catch (e) {
      fail(getApiErrorMessage(e))
    }
  }

  const open = contracts.filter((c) => c.status !== 'CANCELLED')

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div className="card">
        <div className="sec-title">Giới thiệu khách</div>
        {ref ? (
          <>
            <div style={{ marginBottom: 8 }}>
              Mã giới thiệu của khách: {ref.referralCode ? <b>{ref.referralCode}</b> : <span className="muted">chưa có</span>}{' '}
              {!ref.referralCode && can('customer.update') ? (
                <button className="btn sm" onClick={() => void run(() => createReferralCode(customerId), 'Đã tạo mã giới thiệu.')}>Tạo mã</button>
              ) : null}
            </div>
            <div style={{ marginBottom: 8 }}>
              Người giới thiệu: {ref.referrer ? `${ref.referrer.name} (${ref.referrer.code})` : <span className="muted">chưa có</span>}
              {!ref.rewardForThisCustomer && can('customer.update') ? (
                <span className="row" style={{ gap: 6, display: 'inline-flex', marginLeft: 8 }}>
                  <input placeholder="Nhập mã giới thiệu" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} style={{ width: 160 }} />
                  <button className="btn sm sec" disabled={code.length < 3} onClick={() => void run(() => setReferrer(customerId, { code }), 'Đã ghi nhận người giới thiệu.')}>Lưu</button>
                </span>
              ) : null}
            </div>
            {ref.referees.length ? (
              <div className="muted" style={{ fontSize: 12.5 }}>
                Đã giới thiệu: {ref.referees.map((r) => `${r.name}${r.rewarded ? ' (đã thưởng)' : ''}`).join(', ')}
              </div>
            ) : null}
          </>
        ) : null}
      </div>

      <div className="card">
        <div className="sec-title">Voucher của khách</div>
        {vouchers.length === 0 ? (
          <Empty>Khách chưa có voucher.</Empty>
        ) : (
          <table>
            <thead><tr><th>Mã</th><th>Giá trị</th><th>Hạn dùng</th><th>Trạng thái</th></tr></thead>
            <tbody>
              {vouchers.map((v) => (
                <tr key={v.id}><td><b>{v.code}</b></td><td>{vnd(v.value)}</td><td>{dateVi(v.expiresAt)}</td><td>{STATE[v.state]}</td></tr>
              ))}
            </tbody>
          </table>
        )}
        {can('promotion.manage') ? (
          <div className="row" style={{ gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
            <input placeholder="Giá trị (đồng)" value={vForm.value} onChange={(e) => setVForm({ ...vForm, value: e.target.value.replace(/\D/g, '') })} style={{ width: 140 }} />
            <label style={{ fontSize: 12.5 }}>Hạn <input type="date" value={vForm.expiresAt} onChange={(e) => setVForm({ ...vForm, expiresAt: e.target.value })} /></label>
            <button
              className="btn sm"
              disabled={!vForm.value || !vForm.expiresAt}
              onClick={() => void run(() => createVoucher({ customerId, value: Number(vForm.value), expiresAt: vForm.expiresAt }), 'Đã tạo voucher cho khách.')}
            >
              Tạo voucher cho khách
            </button>
          </div>
        ) : null}
        {can('finance.create') && open.length ? (
          <div className="row" style={{ gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
            <input placeholder="Mã voucher" value={redeem.code} onChange={(e) => setRedeem({ ...redeem, code: e.target.value.toUpperCase() })} style={{ width: 140 }} />
            <select value={redeem.contractId} onChange={(e) => setRedeem({ ...redeem, contractId: e.target.value })} style={{ width: 240 }}>
              <option value="">Trừ vào hợp đồng</option>
              {open.map((c) => (
                <option key={c.id} value={c.id}>{c.code} (còn {vnd(c.total - c.paidAmount)})</option>
              ))}
            </select>
            <button
              className="btn sm sec"
              disabled={!redeem.code || !redeem.contractId}
              onClick={() => void run(() => redeemVoucher({ code: redeem.code, customerId, contractId: redeem.contractId }), 'Đã dùng voucher khi thanh toán.')}
            >
              Dùng voucher
            </button>
          </div>
        ) : null}
      </div>

      {gifts ? (
        <div className="card">
          <div className="sec-title">Quà tặng khi ra về</div>
          {can('visit.update') && items.length ? (
            <div className="row" style={{ gap: 8, marginBottom: 8 }}>
              <select value={gift.giftItemId} onChange={(e) => setGift({ ...gift, giftItemId: e.target.value })} style={{ width: 220 }}>
                <option value="">Chọn quà</option>
                {items.map((i) => (
                  <option key={i.id} value={i.id}>{i.name} ({vnd(i.cost)})</option>
                ))}
              </select>
              <input type="number" min={1} value={gift.quantity} onChange={(e) => setGift({ ...gift, quantity: e.target.value })} style={{ width: 70 }} />
              <button
                className="btn sm"
                disabled={!gift.giftItemId}
                onClick={() => void run(() => logGift({ customerId, giftItemId: gift.giftItemId, quantity: Math.max(1, Number(gift.quantity) || 1) }), 'Đã ghi nhận tặng quà.')}
              >
                Ghi nhận tặng quà
              </button>
            </div>
          ) : null}
          {gifts.rows.length === 0 ? (
            <Empty>Chưa tặng quà cho khách.</Empty>
          ) : (
            <table>
              <tbody>
                {gifts.rows.map((g) => (
                  <tr key={g.id}><td>{dateTimeVi(g.createdAt)}</td><td>{g.giftName} x{g.quantity}</td><td>{vnd(g.totalCost)}</td><td>{g.givenByName ?? '-'}</td></tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ) : null}

      {can('finance.update') && open.length ? (
        <div className="card">
          <div className="sec-title">Ghi nhận ai chốt hợp đồng (tính lương thưởng)</div>
          {open.map((c) => (
            <div key={c.id} style={{ borderTop: '1px solid var(--line, #e3e8e5)', padding: '8px 0' }}>
              <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                <b>{c.code}</b>
                <select
                  value={c.closeType}
                  onChange={(e) => setContracts(contracts.map((x) => (x.id === c.id ? { ...x, closeType: e.target.value as 'FULL' | 'PARTIAL' } : x)))}
                  style={{ width: 230 }}
                >
                  <option value="FULL">Bán full (sale chốt từ A đến Z)</option>
                  <option value="PARTIAL">Bán phần (sale kéo đến, bác sĩ chốt)</option>
                </select>
                {c.closeType === 'PARTIAL' ? (
                  <select
                    value={c.closingDoctorId ?? ''}
                    onChange={(e) => setContracts(contracts.map((x) => (x.id === c.id ? { ...x, closingDoctorId: e.target.value || null } : x)))}
                    style={{ width: 200 }}
                  >
                    <option value="">Bác sĩ chốt</option>
                    {staff.map((s) => (
                      <option key={s.id} value={s.id}>{s.name}</option>
                    ))}
                  </select>
                ) : null}
              </div>
              {c.items.map((i) => (
                <div key={i.id} className="row" style={{ gap: 8, marginTop: 4, fontSize: 12.5 }}>
                  <span style={{ minWidth: 220 }}>{i.name} ({vnd(i.amount)})</span>
                  <select
                    value={i.upsellById ?? ''}
                    onChange={(e) =>
                      setContracts(contracts.map((x) => (x.id === c.id ? { ...x, items: x.items.map((y) => (y.id === i.id ? { ...y, upsellById: e.target.value || null } : y)) } : x)))
                    }
                    style={{ width: 220 }}
                  >
                    <option value="">Không phải upsale</option>
                    {staff.map((s) => (
                      <option key={s.id} value={s.id}>Upsale của {s.name}</option>
                    ))}
                  </select>
                </div>
              ))}
              <button
                className="btn sm"
                style={{ marginTop: 6 }}
                onClick={() =>
                  void run(
                    () =>
                      saveContractAttribution(c.id, {
                        closeType: c.closeType,
                        closingDoctorId: c.closingDoctorId,
                        upsell: c.items.map((i) => ({ itemId: i.id, upsellById: i.upsellById }))
                      }),
                    'Đã lưu ghi nhận chốt hợp đồng.'
                  )
                }
              >
                Lưu
              </button>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}
