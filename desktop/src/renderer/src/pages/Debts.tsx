import React, { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { createPayment, fetchDebts, fetchPayments, getApiErrorMessage } from '../lib/api'
import { useAuth } from '../lib/auth-context'
import { dateTimeVi, dateVi, vnd } from '../lib/format'
import { INVOICE_STATUS, PAYMENT_METHOD_LABEL, tagStyleOf } from '../lib/ui'
import { Empty, Modal, Tag, useToast } from '../components/ui'
import type { DebtReport, Invoice, Payment } from '../lib/types'

/* THANH TOÁN & CÔNG NỢ — hai tab: danh sách công nợ và sổ phiếu thu. */

export default function Debts(): React.JSX.Element {
  const { can, branchId } = useAuth()
  const { fail } = useToast()
  const navigate = useNavigate()

  const [tab, setTab] = useState<'debt' | 'payment'>('debt')
  const [report, setReport] = useState<DebtReport | null>(null)
  const [payments, setPayments] = useState<Payment[]>([])
  const [overdueOnly, setOverdueOnly] = useState(false)
  const [collecting, setCollecting] = useState<Invoice | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [debts, pays] = await Promise.all([
        fetchDebts(overdueOnly ? { overdueDays: 1 } : {}),
        fetchPayments()
      ])
      setReport(debts)
      setPayments(pays)
    } catch (err) {
      fail(getApiErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }, [overdueOnly, fail])

  useEffect(() => {
    void load()
  }, [load, branchId])

  return (
    <>
      <div className="grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)', marginBottom: 12 }}>
        <div className="kpi">
          <div className="lab">Tổng công nợ</div>
          <div className="val">{vnd(report?.totalDebt ?? 0)}</div>
        </div>
        <div className="kpi">
          <div className="lab">Đơn quá hạn</div>
          <div className="val" style={{ color: report?.overdueCount ? 'var(--danger)' : undefined }}>
            {report?.overdueCount ?? 0}
          </div>
        </div>
        <div className="kpi">
          <div className="lab">Tiền quá hạn</div>
          <div className="val" style={{ color: report?.overdueAmount ? 'var(--danger)' : undefined }}>
            {vnd(report?.overdueAmount ?? 0)}
          </div>
        </div>
        <div className="kpi">
          <div className="lab">Thu trong danh sách</div>
          <div className="val">{vnd(payments.reduce((s, p) => s + p.amount, 0))}</div>
        </div>
      </div>

      <div className="tabs">
        <button className={tab === 'debt' ? 'on' : ''} onClick={() => setTab('debt')}>
          Công nợ phải thu
        </button>
        <button className={tab === 'payment' ? 'on' : ''} onClick={() => setTab('payment')}>
          Sổ phiếu thu
        </button>
      </div>

      {tab === 'debt' ? (
        <>
          <div className="row" style={{ marginBottom: 12 }}>
            <label className="row" style={{ fontSize: 12.5, gap: 6 }}>
              <input type="checkbox" checked={overdueOnly} onChange={(e) => setOverdueOnly(e.target.checked)} />
              Chỉ hiện đơn quá hạn
            </label>
          </div>

          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            {loading ? (
              <Empty>Đang tải…</Empty>
            ) : !report || report.items.length === 0 ? (
              <Empty>Không có công nợ nào. Rất tốt.</Empty>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Khách hàng</th>
                    <th>Đợt thu</th>
                    <th>Hợp đồng</th>
                    <th>Phải thu</th>
                    <th>Đã thu</th>
                    <th>Còn lại</th>
                    <th>Hạn</th>
                    <th>Trạng thái</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {report.items.map((i) => (
                    <tr key={i.id}>
                      <td style={{ cursor: 'pointer' }} onClick={() => navigate(`/khach-hang/${i.customer.id}`)}>
                        <b>{i.customer.name}</b>
                        <div className="muted" style={{ fontSize: 11.5 }}>
                          {i.customer.phone ?? '—'}
                        </div>
                      </td>
                      <td>{i.title ?? i.code}</td>
                      <td className="muted">{i.contract?.code ?? '—'}</td>
                      <td>{vnd(i.amount)}</td>
                      <td>{vnd(i.paidAmount)}</td>
                      <td style={{ color: 'var(--danger)', fontWeight: 600 }}>{vnd(i.remaining)}</td>
                      <td>
                        {dateVi(i.dueDate)}
                        {i.overdueDays > 0 ? <div className="down">quá {i.overdueDays} ngày</div> : null}
                      </td>
                      <td>
                        <Tag style={tagStyleOf(INVOICE_STATUS, i.status)} />
                      </td>
                      <td>
                        {can('finance.create') ? (
                          <button className="btn sm" onClick={() => setCollecting(i)}>
                            Thu
                          </button>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      ) : (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          {payments.length === 0 ? (
            <Empty>Chưa có phiếu thu nào.</Empty>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Mã phiếu</th>
                  <th>Khách hàng</th>
                  <th>Số tiền</th>
                  <th>Hình thức</th>
                  <th>Nội dung</th>
                  <th>Người thu</th>
                  <th>Thời gian</th>
                </tr>
              </thead>
              <tbody>
                {payments.map((p) => (
                  <tr key={p.id}>
                    <td className="muted">{p.code}</td>
                    <td>{p.customer.name}</td>
                    <td>
                      <b>{vnd(p.amount)}</b>
                    </td>
                    <td>
                      <span className="tag out">{PAYMENT_METHOD_LABEL[p.method] ?? p.method}</span>
                    </td>
                    <td>{p.invoice?.title ?? '—'}</td>
                    <td>{p.receivedBy?.name ?? '—'}</td>
                    <td className="muted">{dateTimeVi(p.paidAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {collecting ? (
        <CollectModal
          invoice={collecting}
          onClose={() => setCollecting(null)}
          onDone={() => {
            setCollecting(null)
            void load()
          }}
        />
      ) : null}
    </>
  )
}

function CollectModal({
  invoice,
  onClose,
  onDone
}: {
  invoice: Invoice
  onClose: () => void
  onDone: () => void
}): React.JSX.Element {
  const { say, fail } = useToast()
  const [amount, setAmount] = useState(invoice.remaining)
  const [method, setMethod] = useState('CASH')
  const [reference, setReference] = useState('')
  const [saving, setSaving] = useState(false)

  const submit = async (): Promise<void> => {
    setSaving(true)
    try {
      const payment = await createPayment({
        customerId: invoice.customer.id,
        invoiceId: invoice.id,
        amount,
        method,
        reference: reference || undefined
      })
      say(`Đã lập phiếu thu ${payment.code} — ${vnd(amount)}.`)
      onDone()
    } catch (err) {
      fail(getApiErrorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      title={`Thu tiền — ${invoice.customer.name}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn sec" onClick={onClose}>
            Huỷ
          </button>
          <button className="btn" onClick={() => void submit()} disabled={saving || amount <= 0}>
            {saving ? 'Đang lưu…' : 'Lập phiếu thu'}
          </button>
        </>
      }
    >
      <div className="alert wr">
        {invoice.title ?? invoice.code} — còn phải thu <b>{vnd(invoice.remaining)}</b>
      </div>
      <div className="field">
        <label>Số tiền thu (đồng)</label>
        <input
          className="input"
          type="number"
          value={amount}
          max={invoice.remaining}
          onChange={(e) => setAmount(Number(e.target.value))}
        />
      </div>
      <div className="field">
        <label>Hình thức</label>
        <select className="input" value={method} onChange={(e) => setMethod(e.target.value)}>
          {Object.entries(PAYMENT_METHOD_LABEL).map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label>Mã giao dịch / ghi chú</label>
        <input className="input" value={reference} onChange={(e) => setReference(e.target.value)} />
      </div>
    </Modal>
  )
}
