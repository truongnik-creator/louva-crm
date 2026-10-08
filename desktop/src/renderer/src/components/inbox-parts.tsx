import React, { useEffect, useState } from 'react'
import {
  createCustomer,
  fetchAttachmentBlob,
  fetchCustomers,
  getApiErrorMessage,
  getDuplicateFromError,
  linkConversationCustomer,
  saveAttachmentToProfile
} from '../lib/api'
import { useToast } from './ui'
import type { CustomerListItem, MessageAttachment } from '../lib/types'

/* Các khối con của Hộp thư (Lô 2):
 *   ChatAttachments    ảnh, tệp khách gửi trong khung chat + nút "Lưu ảnh vào hồ sơ" (B13)
 *   LinkCustomerPanel  tìm hoặc tạo nhanh hồ sơ khách rồi gắn vào hội thoại (B11) */

/* ------------------------------------------------------------ TỆP ĐÍNH KÈM */

function AttachmentItem({
  conversationId,
  attachment,
  canSave,
  onSaved
}: {
  conversationId: string
  attachment: MessageAttachment
  canSave: boolean
  onSaved: (attachmentId: string, photoSetId: string) => void
}): React.JSX.Element {
  const { say, fail } = useToast()
  const [src, setSrc] = useState<string | null>(null)
  const [error, setError] = useState(false)
  const [saving, setSaving] = useState(false)
  const [big, setBig] = useState(false)
  const isImage = attachment.kind === 'IMAGE'

  useEffect(() => {
    if (!isImage) return
    let url: string | null = null
    let cancelled = false
    fetchAttachmentBlob(conversationId, attachment.id)
      .then((u) => {
        url = u
        if (!cancelled) setSrc(u)
      })
      .catch(() => !cancelled && setError(true))
    return () => {
      cancelled = true
      if (url) URL.revokeObjectURL(url)
    }
  }, [conversationId, attachment.id, isImage])

  const openFile = async (): Promise<void> => {
    try {
      const url = await fetchAttachmentBlob(conversationId, attachment.id)
      const a = document.createElement('a')
      a.href = url
      a.download = attachment.fileName
      a.click()
      window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
    } catch (err) {
      fail(getApiErrorMessage(err))
    }
  }

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      const r = await saveAttachmentToProfile(conversationId, attachment.id)
      say('Đã lưu ảnh vào bộ ảnh của hồ sơ khách.')
      onSaved(attachment.id, r.photoSetId)
    } catch (err) {
      fail(getApiErrorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  if (!isImage) {
    return (
      <button className="btn sec sm" style={{ marginTop: 4 }} onClick={() => void openFile()}>
        📎 {attachment.fileName}
      </button>
    )
  }

  return (
    <div style={{ marginTop: 4 }}>
      {error ? (
        <div className="muted" style={{ fontSize: 12 }}>
          Không tải được ảnh (tệp gốc có thể đã hết hạn bên kênh chat).
        </div>
      ) : src ? (
        <img
          src={src}
          alt={attachment.fileName}
          style={{
            maxWidth: big ? '100%' : 220,
            maxHeight: big ? 600 : 220,
            borderRadius: 8,
            display: 'block',
            cursor: big ? 'zoom-out' : 'zoom-in'
          }}
          onClick={() => setBig((v) => !v)}
        />
      ) : (
        <div className="muted" style={{ fontSize: 12 }}>
          Đang tải ảnh…
        </div>
      )}
      {attachment.savedPhotoSetId ? (
        <div className="muted" style={{ fontSize: 11.5, marginTop: 3 }}>
          ✓ Đã lưu vào hồ sơ
        </div>
      ) : canSave && !error ? (
        <button className="btn sec sm" style={{ marginTop: 4 }} onClick={() => void save()} disabled={saving}>
          {saving ? 'Đang lưu…' : 'Lưu ảnh vào hồ sơ'}
        </button>
      ) : null}
    </div>
  )
}

export function ChatAttachments({
  conversationId,
  attachments,
  canSave,
  onSaved
}: {
  conversationId: string
  attachments: MessageAttachment[] | undefined
  /** Có quyền photo.create và hội thoại đã gắn hồ sơ khách. */
  canSave: boolean
  onSaved: (attachmentId: string, photoSetId: string) => void
}): React.JSX.Element | null {
  if (!attachments?.length) return null
  return (
    <div>
      {attachments.map((a) => (
        <AttachmentItem key={a.id} conversationId={conversationId} attachment={a} canSave={canSave} onSaved={onSaved} />
      ))}
    </div>
  )
}

/* ------------------------------------------------------- GẮN HỒ SƠ KHÁCH */

export function LinkCustomerPanel({
  conversationId,
  suggestedName,
  canCreate,
  onLinked,
  prefill
}: {
  conversationId: string
  suggestedName: string
  canCreate: boolean
  onLinked: () => void
  /** AI1: gợi ý tách từ tin nhắn, người bấm "Áp dụng" thì điền sẵn vào Tạo nhanh. */
  prefill?: { name: string | null; phone: string | null; at: number } | null
}): React.JSX.Element {
  const { say, fail } = useToast()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<CustomerListItem[]>([])
  const [searching, setSearching] = useState(false)
  const [mode, setMode] = useState<'search' | 'create'>('search')
  const [name, setName] = useState(suggestedName)
  const [phone, setPhone] = useState('')
  const [busy, setBusy] = useState(false)
  const [duplicate, setDuplicate] = useState<{ id: string; code: string; name: string } | null>(null)

  useEffect(() => {
    if (!prefill || !canCreate) return
    setMode('create')
    if (prefill.name) setName(prefill.name)
    if (prefill.phone) setPhone(prefill.phone)
  }, [prefill, canCreate])

  useEffect(() => {
    const q = query.trim()
    if (q.length < 2) {
      setResults([])
      return
    }
    setSearching(true)
    const timer = window.setTimeout(() => {
      fetchCustomers({ q, limit: 8 })
        .then((r) => setResults(r.items))
        .catch(() => setResults([]))
        .finally(() => setSearching(false))
    }, 250)
    return () => window.clearTimeout(timer)
  }, [query])

  const link = async (customerId: string, label: string): Promise<void> => {
    setBusy(true)
    try {
      await linkConversationCustomer(conversationId, customerId)
      say(`Đã gắn hội thoại vào hồ sơ ${label}.`)
      onLinked()
    } catch (err) {
      fail(getApiErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const createAndLink = async (): Promise<void> => {
    const digits = phone.replace(/\D/g, '')
    if (name.trim().length < 2) {
      fail('Nhập tên khách (tối thiểu 2 ký tự).')
      return
    }
    if (digits.length < 9) {
      fail('Số điện thoại là bắt buộc khi tạo hồ sơ từ hộp thư.')
      return
    }
    setBusy(true)
    setDuplicate(null)
    try {
      const created = await createCustomer({ name: name.trim(), phone: phone.trim() })
      await linkConversationCustomer(conversationId, created.id)
      say(`Đã tạo hồ sơ ${created.code} và gắn vào hội thoại.`)
      onLinked()
    } catch (err) {
      const dup = getDuplicateFromError(err)
      if (dup) setDuplicate(dup)
      else fail(getApiErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="card" style={{ marginTop: 12, padding: 10 }}>
      <div className="ztabs" style={{ marginBottom: 8 }}>
        <button className={`ztab${mode === 'search' ? ' on' : ''}`} onClick={() => setMode('search')}>
          Tìm hồ sơ
        </button>
        {canCreate ? (
          <button className={`ztab${mode === 'create' ? ' on' : ''}`} onClick={() => setMode('create')}>
            Tạo nhanh
          </button>
        ) : null}
      </div>

      {mode === 'search' ? (
        <>
          <input
            className="input"
            placeholder="Tên, SĐT hoặc mã khách"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div style={{ marginTop: 6 }}>
            {searching ? (
              <div className="muted" style={{ fontSize: 12 }}>
                Đang tìm…
              </div>
            ) : query.trim().length >= 2 && results.length === 0 ? (
              <div className="muted" style={{ fontSize: 12 }}>
                Không thấy khách nào. {canCreate ? 'Chuyển sang Tạo nhanh để lập hồ sơ mới.' : ''}
              </div>
            ) : (
              results.map((c) => (
                <div
                  key={c.id}
                  style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 0', borderBottom: '1px dashed var(--border)' }}
                >
                  <div style={{ flex: 1, fontSize: 12.5 }}>
                    <b>{c.name}</b>
                    <div className="muted">
                      {c.phone ?? 'chưa có SĐT'} · {c.code}
                    </div>
                  </div>
                  <button className="btn sm" disabled={busy} onClick={() => void link(c.id, c.code)}>
                    Gắn
                  </button>
                </div>
              ))
            )}
          </div>
        </>
      ) : (
        <>
          <div className="field">
            <label>Tên khách</label>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="field">
            <label>Số điện thoại (bắt buộc)</label>
            <input className="input" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="09xx xxx xxx" />
          </div>
          {duplicate ? (
            <div className="card" style={{ padding: 8, background: 'var(--amber-50, #FFFBEB)', fontSize: 12.5 }}>
              Số này đã có hồ sơ <b>{duplicate.name}</b> ({duplicate.code}).
              <button
                className="btn sm"
                style={{ marginTop: 6, display: 'block' }}
                disabled={busy}
                onClick={() => void link(duplicate.id, duplicate.code)}
              >
                Gắn vào hồ sơ này
              </button>
            </div>
          ) : null}
          <button className="btn block" style={{ marginTop: 8 }} disabled={busy} onClick={() => void createAndLink()}>
            {busy ? 'Đang lưu…' : 'Tạo hồ sơ và gắn'}
          </button>
        </>
      )}
    </div>
  )
}
