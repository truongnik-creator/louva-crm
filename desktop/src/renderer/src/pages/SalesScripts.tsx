import React, { useCallback, useEffect, useState } from 'react'
import { getApiErrorMessage } from '../lib/api'
import { activateSalesScript, fetchSalesScripts, saveSalesScript, type SalesScriptRow } from '../lib/api-lo4'
import { dateTimeVi } from '../lib/format'
import { Empty, useToast } from '../components/ui'

/* AI2: KỊCH BẢN BÁN HÀNG CHUẨN. Quản lý dán kịch bản "win" vào; mỗi lần lưu là
   một phiên bản mới. AI gợi ý trả lời ở hộp thư dùng phiên bản đang dùng. */

export default function SalesScripts(): React.JSX.Element {
  const { say, fail } = useToast()
  const [rows, setRows] = useState<SalesScriptRow[]>([])
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [note, setNote] = useState('')
  const [viewing, setViewing] = useState<SalesScriptRow | null>(null)
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    try {
      const data = await fetchSalesScripts()
      setRows(data)
      const active = data.find((r) => r.isActive)
      if (active && !title && !content) {
        setTitle(active.title)
        setContent(active.content)
      }
    } catch (err) {
      fail(getApiErrorMessage(err))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fail])

  useEffect(() => {
    void load()
  }, [load])

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      const r = await saveSalesScript({ title, content, note: note || undefined, activate: true })
      say(`Đã lưu phiên bản ${r.version} và chuyển sang dùng.`)
      setNote('')
      void load()
    } catch (err) {
      fail(getApiErrorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
      <div className="card" style={{ flex: 2, minWidth: 420 }}>
        <div className="sec-title">Soạn phiên bản mới</div>
        <div className="alert wr" style={{ marginBottom: 10 }}>
          AI chỉ gợi ý theo kịch bản này; sale luôn đọc, sửa rồi tự bấm gửi. Không đưa lời khuyên y khoa hay mức giảm giá ngoài đợt ưu đãi vào kịch bản.
        </div>
        <div className="field">
          <label>Tên kịch bản</label>
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Kịch bản tư vấn filler, botox" />
        </div>
        <div className="field">
          <label>Nội dung kịch bản (dán nguyên văn)</label>
          <textarea className="input" rows={18} value={content} onChange={(e) => setContent(e.target.value)} />
        </div>
        <div className="field">
          <label>Ghi chú thay đổi</label>
          <input className="input" value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
        <button className="btn" disabled={saving || title.trim().length < 2 || content.trim().length < 20} onClick={() => void save()}>
          {saving ? 'Đang lưu…' : 'Lưu phiên bản mới và dùng ngay'}
        </button>
      </div>
      <div className="card" style={{ flex: 1, minWidth: 300 }}>
        <div className="sec-title">Các phiên bản</div>
        {!rows.length ? (
          <Empty>Chưa có kịch bản nào.</Empty>
        ) : (
          rows.map((r) => (
            <div key={r.id} style={{ padding: '8px 0', borderBottom: '1px dashed var(--border)' }}>
              <div className="row">
                <b>Phiên bản {r.version}</b>
                {r.isActive ? <span className="tag" style={{ marginLeft: 6, background: '#DCFCE7', color: '#15803D' }}>Đang dùng</span> : null}
                <span style={{ marginLeft: 'auto' }} />
                <button className="btn sec sm" onClick={() => setViewing(viewing?.id === r.id ? null : r)}>Xem</button>
                {!r.isActive ? (
                  <button
                    className="btn sec sm"
                    style={{ marginLeft: 4 }}
                    onClick={async () => {
                      try {
                        await activateSalesScript(r.id)
                        say(`Đã chuyển sang phiên bản ${r.version}.`)
                        void load()
                      } catch (err) {
                        fail(getApiErrorMessage(err))
                      }
                    }}
                  >
                    Dùng bản này
                  </button>
                ) : null}
              </div>
              <div className="muted" style={{ fontSize: 12 }}>
                {r.title} · {r.createdByName ?? ''} · {dateTimeVi(r.createdAt)}
                {r.note ? ` · ${r.note}` : ''}
              </div>
              {viewing?.id === r.id ? <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12 }}>{r.content}</pre> : null}
            </div>
          ))
        )}
      </div>
    </div>
  )
}
