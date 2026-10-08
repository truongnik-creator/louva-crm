import React, { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { fetchServices, getApiErrorMessage, getDuplicateFromError } from '../lib/api'
import {
  applyExtraction,
  extractFromChat,
  previewCanned,
  sendCanned,
  type CannedPreview,
  type ExtractionResult
} from '../lib/api-nova'
import { useClinic } from '../lib/clinic-context'
import { vnd } from '../lib/format'
import { Modal, useToast } from './ui'
import type { ChatMessage, Service } from '../lib/types'

/* Hộp thư Lô 3:
 *   CannedMessageModal   F24 "Gửi vị trí", "Gửi bảng giá chuẩn" (xem trước rồi người bấm gửi)
 *   ExtractSuggestionCard AI1 thẻ gợi ý SĐT, tên, nhu cầu, khu vực ở cột 3 (bấm "Áp dụng" mới ghi) */

export function CannedMessageModal({
  conversationId,
  kind,
  onClose,
  onSent
}: {
  conversationId: string
  kind: 'location' | 'price'
  onClose: () => void
  onSent: (m: ChatMessage) => void
}): React.JSX.Element {
  const { fail, say } = useToast()
  const [preview, setPreview] = useState<CannedPreview | null>(null)
  const [services, setServices] = useState<Service[]>([])
  const [picked, setPicked] = useState<string[]>([])
  const [filter, setFilter] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(
    async (ids?: string[]) => {
      try {
        setPreview(await previewCanned(conversationId, kind, ids))
      } catch (err) {
        fail(getApiErrorMessage(err))
      }
    },
    [conversationId, kind, fail]
  )

  useEffect(() => {
    void load()
    if (kind === 'price') fetchServices().then((r) => setServices(r.filter((s) => s.active))).catch(() => undefined)
  }, [load, kind])

  const toggle = (id: string): void => {
    const next = picked.includes(id) ? picked.filter((x) => x !== id) : [...picked, id]
    setPicked(next)
    void load(next.length ? next : undefined)
  }

  const send = async (): Promise<void> => {
    setBusy(true)
    try {
      const m = await sendCanned(conversationId, kind, picked.length ? picked : undefined)
      if (m.status === 'FAILED') fail(m.errorMessage ?? 'Không gửi được tin, tin đã lưu để gửi lại.')
      else say(kind === 'location' ? 'Đã gửi vị trí cơ sở.' : 'Đã gửi bảng giá chuẩn.')
      onSent(m)
      onClose()
    } catch (err) {
      fail(getApiErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const shown = services.filter((s) => !filter || s.name.toLowerCase().includes(filter.toLowerCase())).slice(0, 60)

  return (
    <Modal
      title={kind === 'location' ? 'Gửi vị trí cơ sở' : 'Gửi bảng giá chuẩn'}
      onClose={onClose}
      width={560}
      footer={
        <>
          <button className="btn sec" onClick={onClose}>
            Huỷ
          </button>
          <button className="btn" disabled={busy || !preview?.content} onClick={() => void send()}>
            {busy ? 'Đang gửi…' : 'Gửi cho khách'}
          </button>
        </>
      }
    >
      {kind === 'price' ? (
        <div className="field">
          <label>Chọn dịch vụ (để trống thì lấy dịch vụ khách quan tâm)</label>
          <input className="input" placeholder="Lọc tên dịch vụ" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <div style={{ maxHeight: 160, overflowY: 'auto', marginTop: 6, fontSize: 12.5 }}>
            {shown.map((s) => (
              <label key={s.id} style={{ display: 'block', padding: '2px 0' }}>
                <input type="checkbox" checked={picked.includes(s.id)} onChange={() => toggle(s.id)} /> {s.name}
                {s.price != null ? <span className="muted"> · {vnd(s.price)}</span> : null}
              </label>
            ))}
          </div>
        </div>
      ) : null}
      <div className="sec-title" style={{ marginTop: 6 }}>Nội dung sẽ gửi</div>
      {!preview ? (
        <div className="muted">Đang soạn…</div>
      ) : preview.content ? (
        <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', background: 'var(--green-50)', padding: 10, borderRadius: 8, margin: 0 }}>
          {preview.content}
        </pre>
      ) : (
        <div className="muted">Chưa đủ dữ liệu để soạn tin.</div>
      )}
      {preview?.missing.length ? (
        <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
          Còn thiếu: {preview.missing.join(', ')}. Quản lý bổ sung ở Cài đặt hệ thống, Thông tin cơ sở hoặc Bảng giá.
        </div>
      ) : null}
    </Modal>
  )
}

const AI_STATUS_TEXT: Record<string, string> = {
  OK: 'AI đã đọc tin nhắn.',
  NOT_CONFIGURED: 'AI chưa cấu hình (máy chủ chưa có khoá). Chỉ tách SĐT bằng mẫu số.',
  DISABLED: 'AI đang tắt trong Cài đặt. Chỉ tách SĐT bằng mẫu số.',
  NO_CONSENT: 'Khách chưa đồng ý xử lý dữ liệu bằng AI (Nghị định 13/2023). Chỉ tách SĐT bằng mẫu số.',
  SKIPPED: 'Tin nhắn chưa có số hoặc từ khoá, chưa cần gọi AI.',
  ERROR: 'Không gọi được AI lúc này.'
}

export function ExtractSuggestionCard({
  conversationId,
  linked,
  lastInboundId,
  canApply,
  onApplied,
  onPrefill
}: {
  conversationId: string
  linked: boolean
  /** Đổi khi có tin khách mới: thẻ tự tách lại. */
  lastInboundId: string | null
  canApply: boolean
  onApplied: () => void
  /** Hội thoại chưa gắn hồ sơ: đưa gợi ý sang ô Tạo nhanh. */
  onPrefill: (v: { name: string | null; phone: string | null }) => void
}): React.JSX.Element | null {
  const clinic = useClinic()
  const navigate = useNavigate()
  const { say, fail } = useToast()
  const [result, setResult] = useState<ExtractionResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [dismissed, setDismissed] = useState(false)

  const run = useCallback(async () => {
    setLoading(true)
    try {
      setResult(await extractFromChat(conversationId))
      setDismissed(false)
    } catch {
      setResult(null)
    } finally {
      setLoading(false)
    }
  }, [conversationId])

  useEffect(() => {
    if (!lastInboundId) {
      setResult(null)
      return
    }
    const t = window.setTimeout(() => void run(), 400)
    return () => window.clearTimeout(t)
  }, [run, lastInboundId])

  if (!lastInboundId || dismissed) return null
  const s = result?.suggestion
  const hasAny = Boolean(s && (s.phone || s.name || s.interest || s.area))

  const apply = async (): Promise<void> => {
    if (!s) return
    if (!linked) {
      onPrefill({ name: s.name, phone: s.phone })
      return
    }
    setBusy(true)
    try {
      const r = await applyExtraction(conversationId, s)
      say(r.changed.length ? `Đã cập nhật hồ sơ: ${r.changed.join(', ')}.` : 'Hồ sơ đã có sẵn các thông tin này.')
      setDismissed(true)
      onApplied()
    } catch (err) {
      const dup = getDuplicateFromError(err)
      fail(dup ? `Số này đã thuộc hồ sơ ${dup.name} (${dup.code}). Không tự gộp.` : getApiErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="card" style={{ marginTop: 12, padding: 10, borderColor: '#A5B4FC' }}>
      <div className="row" style={{ marginBottom: 6 }}>
        <b style={{ fontSize: 13 }}>Gợi ý từ tin nhắn</b>
        <button className="btn sec sm" style={{ marginLeft: 'auto' }} disabled={loading} onClick={() => void run()}>
          {loading ? 'Đang đọc…' : 'Đọc lại'}
        </button>
      </div>
      {!result ? (
        <div className="muted" style={{ fontSize: 12 }}>{loading ? 'Đang tách thông tin…' : 'Chưa có gợi ý.'}</div>
      ) : (
        <>
          {hasAny ? (
            <table style={{ fontSize: 12.5 }}>
              <tbody>
                {s!.phone ? <tr><td className="muted" style={{ width: 80 }}>SĐT</td><td><b>{s!.phone}</b></td></tr> : null}
                {s!.name ? <tr><td className="muted">Tên</td><td>{s!.name}</td></tr> : null}
                {s!.interest ? <tr><td className="muted">Quan tâm</td><td>{s!.interest}</td></tr> : null}
                {s!.area ? <tr><td className="muted">Khu vực</td><td>{s!.area}</td></tr> : null}
              </tbody>
            </table>
          ) : (
            <div className="muted" style={{ fontSize: 12 }}>Chưa thấy SĐT, tên hay nhu cầu trong tin khách.</div>
          )}
          {result.duplicate ? (
            <div className="card" style={{ padding: 8, marginTop: 6, background: '#FFFBEB', fontSize: 12.5 }}>
              Số này đã có hồ sơ <b>{result.duplicate.name}</b> ({result.duplicate.code}). Hệ thống không tự gộp.
              <button className="btn sec sm" style={{ display: 'block', marginTop: 4 }} onClick={() => navigate(`/khach-hang/${result.duplicate!.id}`)}>
                Mở hồ sơ đó
              </button>
            </div>
          ) : null}
          <div className="muted" style={{ fontSize: 11.5, marginTop: 6 }}>
            {AI_STATUS_TEXT[result.ai.status] ?? ''}
            {!clinic.ai.configured && result.ai.status !== 'NOT_CONFIGURED' ? ' AI chưa cấu hình.' : ''}
          </div>
          {hasAny && canApply ? (
            <div className="row" style={{ marginTop: 8, gap: 6 }}>
              <button className="btn sm" disabled={busy} onClick={() => void apply()}>
                {linked ? 'Áp dụng vào hồ sơ' : 'Áp dụng vào ô Tạo nhanh'}
              </button>
              <button className="btn sec sm" onClick={() => setDismissed(true)}>
                Bỏ qua
              </button>
            </div>
          ) : null}
        </>
      )}
    </div>
  )
}
