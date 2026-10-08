import React, { useCallback, useEffect, useRef, useState } from 'react'
import {
  createQuickReply,
  deleteQuickReply,
  fetchQuickReplies,
  fetchTemplateVariables,
  getApiErrorMessage,
  updateQuickReply
} from '../lib/api'
import { Empty, Modal, useToast } from '../components/ui'
import type { QuickReply, TemplateVariable } from '../lib/types'

/* MẪU TIN NHANH (B12): trang quản lý cho vai có quyền inbox.manage_templates.
 *
 * Mẫu có thể chứa biến {{...}}. Khi nhân viên chọn mẫu trong Hộp thư, hệ thống
 * điền biến từ hồ sơ khách, bảng giá, lịch hẹn. Biến không có dữ liệu thì giữ
 * nguyên và máy chủ chặn gửi, nên khách không bao giờ nhận "Chào {{ten_khach}}". */

interface Draft {
  id?: string
  title: string
  category: string
  content: string
}

const EMPTY: Draft = { title: '', category: '', content: '' }

export default function QuickReplies(): React.JSX.Element {
  const { say, fail } = useToast()
  const [rows, setRows] = useState<QuickReply[]>([])
  const [variables, setVariables] = useState<TemplateVariable[]>([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<Draft | null>(null)
  const [query, setQuery] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setRows(await fetchQuickReplies({ includeInactive: true }))
    } catch (err) {
      fail(getApiErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }, [fail])

  useEffect(() => {
    void load()
    fetchTemplateVariables().then(setVariables).catch(() => undefined)
  }, [load])

  const toggle = async (row: QuickReply): Promise<void> => {
    try {
      if (row.active === false) await updateQuickReply(row.id, { active: true })
      else await deleteQuickReply(row.id)
      say(row.active === false ? 'Đã bật lại mẫu.' : 'Đã tắt mẫu. Nhân viên không còn thấy mẫu này.')
      void load()
    } catch (err) {
      fail(getApiErrorMessage(err))
    }
  }

  const q = query.trim().toLowerCase()
  const visible = q
    ? rows.filter((r) => `${r.title} ${r.category ?? ''} ${r.content}`.toLowerCase().includes(q))
    : rows

  return (
    <>
      <div className="row" style={{ flexWrap: 'wrap', marginBottom: 12 }}>
        <input
          className="input"
          style={{ width: 260 }}
          placeholder="Tìm theo tên, nhóm, nội dung"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <span className="muted" style={{ fontSize: 12.5 }}>
          {rows.filter((r) => r.active !== false).length} mẫu đang dùng
        </span>
        <button className="btn" style={{ marginLeft: 'auto' }} onClick={() => setEditing({ ...EMPTY })}>
          + Thêm mẫu
        </button>
      </div>

      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        {loading ? (
          <Empty>Đang tải mẫu tin…</Empty>
        ) : visible.length === 0 ? (
          <Empty>{q ? 'Không có mẫu nào khớp.' : 'Chưa có mẫu tin nhanh nào. Bấm Thêm mẫu để tạo.'}</Empty>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Tên mẫu</th>
                <th>Nhóm</th>
                <th>Nội dung</th>
                <th>Trạng thái</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => (
                <tr key={r.id} style={r.active === false ? { opacity: 0.55 } : undefined}>
                  <td>
                    <b>{r.title}</b>
                  </td>
                  <td>{r.category ? <span className="tag out">{r.category}</span> : <span className="muted">Chưa phân nhóm</span>}</td>
                  <td style={{ maxWidth: 420, whiteSpace: 'pre-wrap', fontSize: 12.5 }}>{r.content}</td>
                  <td>{r.active === false ? <span className="muted">Đã tắt</span> : 'Đang dùng'}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button
                      className="btn sec sm"
                      onClick={() =>
                        setEditing({ id: r.id, title: r.title, category: r.category ?? '', content: r.content })
                      }
                    >
                      Sửa
                    </button>{' '}
                    <button className="btn sec sm" onClick={() => void toggle(r)}>
                      {r.active === false ? 'Bật lại' : 'Tắt'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {editing ? (
        <EditModal
          draft={editing}
          variables={variables}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            void load()
          }}
        />
      ) : null}
    </>
  )
}

function EditModal({
  draft,
  variables,
  onClose,
  onSaved
}: {
  draft: Draft
  variables: TemplateVariable[]
  onClose: () => void
  onSaved: () => void
}): React.JSX.Element {
  const { say, fail } = useToast()
  const [form, setForm] = useState<Draft>(draft)
  const [saving, setSaving] = useState(false)
  const contentRef = useRef<HTMLTextAreaElement>(null)

  /** Chèn biến vào đúng vị trí con trỏ trong ô nội dung. */
  const insert = (key: string): void => {
    const token = `{{${key === 'gia:MA_DICH_VU' ? 'gia:' : key}}}`
    const el = contentRef.current
    const start = el?.selectionStart ?? form.content.length
    const end = el?.selectionEnd ?? form.content.length
    const next = form.content.slice(0, start) + token + form.content.slice(end)
    setForm({ ...form, content: next })
    window.setTimeout(() => {
      el?.focus()
      const pos = key === 'gia:MA_DICH_VU' ? start + token.length - 2 : start + token.length
      el?.setSelectionRange(pos, pos)
    }, 0)
  }

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      const payload = { title: form.title, content: form.content, category: form.category.trim() || null }
      if (form.id) await updateQuickReply(form.id, payload)
      else await createQuickReply(payload)
      say(form.id ? 'Đã lưu mẫu.' : 'Đã thêm mẫu.')
      onSaved()
    } catch (err) {
      fail(getApiErrorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      title={form.id ? 'Sửa mẫu tin nhanh' : 'Thêm mẫu tin nhanh'}
      onClose={onClose}
      footer={
        <>
          <button className="btn sec" onClick={onClose}>
            Huỷ
          </button>
          <button className="btn" onClick={() => void save()} disabled={saving}>
            {saving ? 'Đang lưu…' : 'Lưu mẫu'}
          </button>
        </>
      }
    >
      <div className="field">
        <label>Tên mẫu</label>
        <input className="input" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
      </div>
      <div className="field">
        <label>Nhóm (không bắt buộc)</label>
        <input
          className="input"
          value={form.category}
          placeholder="Mở đầu, Báo giá, Nhắc lịch…"
          onChange={(e) => setForm({ ...form, category: e.target.value })}
        />
      </div>
      <div className="field">
        <label>Nội dung</label>
        <textarea
          ref={contentRef}
          className="input"
          rows={6}
          value={form.content}
          onChange={(e) => setForm({ ...form, content: e.target.value })}
        />
      </div>
      <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
        Bấm để chèn biến. Khi gửi, hệ thống tự điền từ hồ sơ khách; biến thiếu dữ liệu sẽ bị chặn gửi cho tới khi nhân viên sửa.
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {variables.map((v) => (
          <button
            key={v.key}
            className="btn sec sm"
            title={`${v.label}. Ví dụ: ${v.example}`}
            onClick={() => insert(v.key)}
            type="button"
          >
            {`{{${v.key}}}`}
          </button>
        ))}
      </div>
    </Modal>
  )
}
