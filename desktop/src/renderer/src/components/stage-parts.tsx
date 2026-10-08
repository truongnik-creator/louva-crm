import React, { useState } from 'react'
import { changeStage } from '../lib/api-nova'
import { changeOpportunityStage } from '../lib/api-lo8'
import { getApiErrorMessage } from '../lib/api'
import { useClinic } from '../lib/clinic-context'
import { Modal, useToast } from './ui'

/* F1/F3: đổi bước của khách dùng chung cho hồ sơ khách và bảng kéo thả.
   Sang bước Mất khách thì hỏi lý do (bắt buộc, theo danh sách); lùi bước thì
   hỏi ghi chú lý do (bắt buộc). Máy chủ kiểm lại cả hai luật. */

export interface StageChangeRequest {
  customerId: string
  customerName: string
  from: string
  to: string
  /** Lô 8 · P6: đổi bước một cơ hội cụ thể (bảng kéo thả); trống = cơ hội hiện tại của khách. */
  opportunityId?: string | null
}

export function useStageChanger(
  onDone: () => void,
  onBlocked?: (r: StageChangeRequest, err: unknown) => boolean
): {
  request: (r: StageChangeRequest) => void
  modal: React.ReactNode
} {
  const clinic = useClinic()
  const { say, fail } = useToast()
  const [pending, setPending] = useState<StageChangeRequest | null>(null)
  const [lostReason, setLostReason] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)

  const rank = (key: string) => {
    const idx = clinic.stages.findIndex((s) => s.key === key)
    return idx < 0 || clinic.stages[idx].lost ? -1 : idx
  }

  const submit = async (r: StageChangeRequest, extra: { lostReason?: string; reason?: string }) => {
    setBusy(true)
    try {
      if (r.opportunityId) await changeOpportunityStage(r.opportunityId, { stage: r.to, ...extra })
      else await changeStage(r.customerId, { stage: r.to, ...extra })
      say(`Đã chuyển ${r.customerName} sang ${clinic.stageStyle(r.to).t}.`)
      setPending(null)
      onDone()
    } catch (err) {
      // Lô 8 · P4: thiếu điều kiện (lịch hẹn, hợp đồng) thì nơi gọi mở form bổ sung.
      if (onBlocked?.(r, err)) {
        setPending(null)
        return
      }
      fail(getApiErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const request = (r: StageChangeRequest) => {
    if (r.from === r.to) return
    const toLost = clinic.lostStage?.key === r.to
    const isBack = !toLost && r.from !== clinic.lostStage?.key && rank(r.from) >= 0 && rank(r.to) < rank(r.from)
    if (toLost || isBack) {
      setLostReason('')
      setNote('')
      setPending(r)
      return
    }
    void submit(r, {})
  }

  const toLost = pending ? clinic.lostStage?.key === pending.to : false
  const modal = pending ? (
    <Modal
      title={toLost ? `Mất khách: ${pending.customerName}` : `Lùi bước: ${pending.customerName}`}
      onClose={() => setPending(null)}
      width={460}
      footer={
        <>
          <button className="btn sec" onClick={() => setPending(null)}>
            Huỷ
          </button>
          <button
            className="btn"
            disabled={busy || (toLost ? !lostReason : note.trim().length < 3)}
            onClick={() => void submit(pending, toLost ? { lostReason, reason: note.trim() || undefined } : { reason: note.trim() })}
          >
            {busy ? 'Đang lưu…' : 'Xác nhận'}
          </button>
        </>
      }
    >
      <div className="muted" style={{ fontSize: 12.5, marginBottom: 8 }}>
        {clinic.stageStyle(pending.from).t} → {clinic.stageStyle(pending.to).t}
      </div>
      {toLost ? (
        <div className="field">
          <label>Lý do mất khách (bắt buộc)</label>
          <select className="input" value={lostReason} onChange={(e) => setLostReason(e.target.value)}>
            <option value="">Chọn lý do</option>
            {clinic.lostReasons.map((r) => (
              <option key={r.key} value={r.key}>
                {r.label}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      <div className="field">
        <label>{toLost ? 'Ghi chú thêm' : 'Lý do lùi bước (bắt buộc)'}</label>
        <textarea className="input" rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
    </Modal>
  ) : null

  return { request, modal }
}

/** Ô chọn bước trong hồ sơ khách. */
export function StageSelect({
  customerId,
  customerName,
  stage,
  onChanged
}: {
  customerId: string
  customerName: string
  stage: string
  onChanged: () => void
}): React.JSX.Element {
  const clinic = useClinic()
  const { request, modal } = useStageChanger(onChanged)
  const known = clinic.stages.some((s) => s.key === stage)
  return (
    <>
      <select
        className="input"
        style={{ width: 'auto' }}
        value={stage}
        onChange={(e) => request({ customerId, customerName, from: stage, to: e.target.value })}
      >
        {!known ? <option value={stage}>{clinic.stageStyle(stage).t}</option> : null}
        {clinic.stages.map((s) => (
          <option key={s.key} value={s.key}>
            {s.label}
          </option>
        ))}
      </select>
      {modal}
    </>
  )
}
