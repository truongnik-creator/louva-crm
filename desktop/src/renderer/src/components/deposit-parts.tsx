import React, { useEffect, useState } from 'react'
import { getApiErrorMessage } from '../lib/api'
import { confirmDeposit, fetchDepositQr, fetchOpenDeposits, setAppointmentDeposit, type DepositQr } from '../lib/api-nova'
import { useAuth } from '../lib/auth-context'
import { vnd } from '../lib/format'
import { DEPOSIT_STATUS, tagStyleOf } from '../lib/ui'
import { Modal, Tag, useToast } from './ui'
import type { Appointment } from '../lib/types'

/* F25 + F12: khối cọc trong ngăn chi tiết lịch hẹn: số tiền cọc, mã VietQR
   (nội dung chuyển khoản = mã lịch), nút "Đã nhận cọc" một chạm cho lễ tân. */

export function DepositPanel({ appointment, onChanged }: { appointment: Appointment; onChanged: () => void }): React.JSX.Element {
  const { can } = useAuth()
  const { say, fail } = useToast()
  const [showQr, setShowQr] = useState(false)
  const [busy, setBusy] = useState(false)
  const status = appointment.depositStatus ?? null
  const amount = appointment.depositAmount ?? 0

  const setAmount = async (): Promise<void> => {
    const raw = window.prompt('Số tiền cọc (đồng):', amount ? String(amount) : '')
    if (raw == null) return
    const n = Number(raw.replace(/\D/g, ''))
    if (!Number.isFinite(n) || n < 0) {
      fail('Số tiền không hợp lệ.')
      return
    }
    try {
      await setAppointmentDeposit(appointment.id, n)
      say(n ? `Đã đặt tiền cọc ${vnd(n)}.` : 'Đã bỏ yêu cầu cọc.')
      onChanged()
    } catch (err) {
      fail(getApiErrorMessage(err))
    }
  }

  const confirm = async (): Promise<void> => {
    if (!window.confirm(`Xác nhận đã nhận cọc ${vnd(amount)} cho lịch ${appointment.code ?? ''}?`)) return
    setBusy(true)
    try {
      await confirmDeposit(appointment.id)
      say('Đã ghi nhận cọc. Khách chuyển sang bước Lịch cọc.')
      onChanged()
    } catch (err) {
      fail(getApiErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="card" style={{ marginTop: 12, padding: 10 }}>
      <div className="row">
        <b style={{ fontSize: 13 }}>Đặt cọc</b>
        {status ? (
          <span style={{ marginLeft: 8 }}>
            <Tag style={tagStyleOf(DEPOSIT_STATUS, status)} />
          </span>
        ) : (
          <span className="muted" style={{ marginLeft: 8, fontSize: 12 }}>Không yêu cầu cọc</span>
        )}
        <span style={{ marginLeft: 'auto', fontWeight: 700 }}>{amount ? vnd(amount) : ''}</span>
      </div>
      {appointment.code ? (
        <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>Mã lịch (nội dung chuyển khoản): {appointment.code}</div>
      ) : null}
      <div style={{ display: 'grid', gap: 6, marginTop: 8 }}>
        {status !== 'DA_COC' && status !== 'HOAN_COC' && can('appointment.update') ? (
          <button className="btn sec block" onClick={() => void setAmount()}>
            {amount ? 'Sửa tiền cọc' : 'Yêu cầu đặt cọc'}
          </button>
        ) : null}
        {amount > 0 && status === 'CHO_COC' ? (
          <button className="btn sec block" onClick={() => setShowQr(true)}>
            Mã QR chuyển khoản cọc
          </button>
        ) : null}
        {amount > 0 && status === 'CHO_COC' && can('finance.create') ? (
          <button className="btn block" disabled={busy} onClick={() => void confirm()}>
            {busy ? 'Đang ghi…' : `Đã nhận cọc ${vnd(amount)}`}
          </button>
        ) : null}
      </div>
      {showQr ? <DepositQrModal appointmentId={appointment.id} onClose={() => setShowQr(false)} /> : null}
    </div>
  )
}

function DepositQrModal({ appointmentId, onClose }: { appointmentId: string; onClose: () => void }): React.JSX.Element {
  const { fail, say } = useToast()
  const [qr, setQr] = useState<DepositQr | null>(null)
  useEffect(() => {
    fetchDepositQr(appointmentId)
      .then(setQr)
      .catch((err) => fail(getApiErrorMessage(err)))
  }, [appointmentId, fail])

  return (
    <Modal title="Mã VietQR đặt cọc" onClose={onClose} width={420}>
      {!qr ? (
        <div className="muted">Đang tạo mã…</div>
      ) : !qr.bankConfigured ? (
        <div>
          Chưa khai tài khoản ngân hàng nhận cọc. Quản trị vào Cài đặt hệ thống, nhóm Đặt cọc (hoặc thông tin cơ sở) để khai mã
          BIN, số tài khoản, tên chủ tài khoản.
        </div>
      ) : qr.url ? (
        <div style={{ textAlign: 'center' }}>
          <img src={qr.url} alt={`VietQR ${qr.code}`} style={{ maxWidth: '100%', borderRadius: 8 }} />
          <div style={{ marginTop: 8 }}>
            <b>{vnd(qr.amount)}</b> · nội dung <b>{qr.code}</b>
          </div>
          <div className="muted" style={{ fontSize: 12 }}>
            {qr.bank?.accountName} · {qr.bank?.accountNo}
          </div>
          <button
            className="btn sec sm"
            style={{ marginTop: 8 }}
            onClick={() => void navigator.clipboard?.writeText(qr.url!).then(() => say('Đã chép link ảnh QR để gửi khách.'))}
          >
            Chép link ảnh QR
          </button>
        </div>
      ) : (
        <div>Lịch chưa có số tiền cọc.</div>
      )}
    </Modal>
  )
}

/** F25: trong màn thu tiền, hiện cọc đã nhận sẽ được tự trừ vào hoá đơn. */
export function useOpenDeposit(customerId: string, remaining: number, setAmount: (n: number) => void): {
  deposit: number
  usable: number
  note: React.ReactNode
} {
  const [deposit, setDeposit] = useState(0)
  useEffect(() => {
    let cancelled = false
    fetchOpenDepositsSafe(customerId).then((total) => {
      if (cancelled) return
      setDeposit(total)
      const usable = Math.min(total, remaining)
      if (usable > 0) setAmount(Math.max(0, remaining - usable))
    })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customerId, remaining])
  const usable = Math.min(deposit, remaining)
  return {
    deposit,
    usable,
    note:
      usable > 0 ? (
        <div className="alert ok" style={{ marginTop: 8 }}>
          Khách đã cọc <b>{vnd(deposit)}</b>. Hệ thống tự trừ {vnd(usable)} vào hoá đơn này, chỉ cần thu thêm phần còn lại.
        </div>
      ) : null
  }
}

async function fetchOpenDepositsSafe(customerId: string): Promise<number> {
  try {
    return (await fetchOpenDeposits(customerId)).total
  } catch {
    return 0
  }
}
