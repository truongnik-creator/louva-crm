import React, { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { getApiErrorMessage } from '../lib/api'
import { approveReengage, fetchReengageDrafts, rejectReengage, type ReengageDraft } from '../lib/api-lo6'
import { dateTimeVi, dateVi } from '../lib/format'
import { Empty, useToast } from '../components/ui'

/* AI5: NHÁP TIN CHĂM LẠI KHÁCH IM LẶNG.
   Mỗi ngày AI soạn nháp cho khách lâu không liên lạc (đã đồng ý xử lý dữ liệu,
   không từ chối nhận tin). Sale đọc, sửa, bấm "Duyệt và đưa vào hàng đợi": tin
   đi qua hàng đợi gửi theo nhóm, tự bỏ khách từ chối nhận tin, ngoài cửa sổ
   24 giờ Facebook thì thành việc cho sale nhắn tay. Không có gì tự gửi. */

const TABS: Array<{ key: string; t: string }> = [
  { key: 'PENDING', t: 'Chờ duyệt' },
  { key: 'QUEUED', t: 'Đã đưa vào hàng đợi' },
  { key: 'REJECTED', t: 'Đã bỏ' },
  { key: 'EXPIRED', t: 'Hết hạn' }
]

function DraftCard({ d, onDone }: { d: ReengageDraft; onDone: () => void }): React.JSX.Element {
  const { say, fail } = useToast()
  const navigate = useNavigate()
  const [text, setText] = useState(d.finalContent ?? d.content)
  const [busy, setBusy] = useState(false)
  const pending = d.status === 'PENDING'
  const act = async (fn: () => Promise<unknown>, ok: string): Promise<void> => {
    setBusy(true)
    try {
      await fn()
      say(ok)
      onDone()
    } catch (err) {
      fail(getApiErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="card">
      <div className="row" style={{ marginBottom: 6 }}>
        <b style={{ cursor: 'pointer' }} onClick={() => d.customer && navigate(`/khach-hang/${d.customer.id}`)}>
          {d.customer?.name ?? 'Khách'}
        </b>
        <span className="muted" style={{ fontSize: 12 }}>
          {d.customer?.code} · {d.customer?.phone ?? ''}
          {d.customer?.lastContactAt ? ` · chạm lần cuối ${dateVi(d.customer.lastContactAt)}` : ''}
        </span>
        {d.customer?.optOut ? <span className="tag" style={{ background: '#fee2e2', color: '#991b1b' }}>Từ chối nhận tin</span> : null}
        <span className="muted" style={{ marginLeft: 'auto', fontSize: 12 }}>{dateTimeVi(d.createdAt)}</span>
      </div>
      <textarea className="input" rows={4} value={text} disabled={!pending} onChange={(e) => setText(e.target.value)} />
      <div className="muted" style={{ fontSize: 11.5, margin: '4px 0 8px' }}>
        Biến {'{{ten_khach}}'}, {'{{co_so}}'} được tự điền khi gửi. Nháp do AI soạn, hãy đọc kỹ trước khi duyệt.
      </div>
      {pending ? (
        <div className="row">
          <button className="btn" disabled={busy || text.trim().length < 2} onClick={() => void act(() => approveReengage(d.id, text.trim() !== d.content.trim() ? text.trim() : undefined), 'Đã duyệt, tin vào hàng đợi gửi')}>
            Duyệt và đưa vào hàng đợi
          </button>
          <button
            className="btn sec"
            disabled={busy}
            onClick={() => {
              const reason = window.prompt('Lý do bỏ nháp (không bắt buộc):') ?? undefined
              void act(() => rejectReengage(d.id, reason || undefined), 'Đã bỏ nháp')
            }}
          >
            Bỏ nháp
          </button>
        </div>
      ) : (
        <div className="muted" style={{ fontSize: 12 }}>
          {d.reviewedByName ? `Xử lý bởi ${d.reviewedByName}` : ''}
          {d.rejectReason ? `: ${d.rejectReason}` : ''}
        </div>
      )}
    </div>
  )
}

export default function Reengage(): React.JSX.Element {
  const { fail } = useToast()
  const [status, setStatus] = useState('PENDING')
  const [data, setData] = useState<Awaited<ReturnType<typeof fetchReengageDrafts>> | null>(null)

  const load = useCallback(async () => {
    try {
      setData(await fetchReengageDrafts(status))
    } catch (err) {
      fail(getApiErrorMessage(err))
    }
  }, [status, fail])
  useEffect(() => {
    void load()
  }, [load])

  return (
    <>
      <div className="tabs" style={{ marginBottom: 12 }}>
        {TABS.map((t) => (
          <button key={t.key} className={status === t.key ? 'on' : ''} onClick={() => setStatus(t.key)}>
            {t.t}
          </button>
        ))}
      </div>
      {data && !data.aiConfigured ? (
        <div className="alert wr" style={{ marginBottom: 12 }}>
          AI chưa cấu hình (thiếu ANTHROPIC_API_KEY) nên hệ thống chưa soạn nháp mới. Nháp cũ vẫn duyệt được.
        </div>
      ) : null}
      {data && data.aiConfigured && !data.enabled ? (
        <div className="alert wr" style={{ marginBottom: 12 }}>Tính năng đang tắt trong Cài đặt hệ thống (AI5).</div>
      ) : null}
      {!data ? <Empty>Đang tải…</Empty> : null}
      {data && !data.items.length ? <Empty>Không có nháp nào ở mục này.</Empty> : null}
      <div className="grid" style={{ gap: 12 }}>
        {data?.items.map((d) => <DraftCard key={d.id} d={d} onDone={() => void load()} />)}
      </div>
    </>
  )
}
