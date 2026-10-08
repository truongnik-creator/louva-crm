import React, { useCallback, useEffect, useState } from 'react'
import { getApiErrorMessage } from '../lib/api'
import {
  addConversationNote,
  addConversationTag,
  CHANNEL_BADGE,
  fetchConversationNotes,
  fetchLatestSummary,
  removeConversationTag,
  setMedicalFlag,
  summarizeConversation,
  type ConvNote,
  type ConvTag
} from '../lib/api-lo4'
import { dateTimeVi } from '../lib/format'
import { useToast } from './ui'

/* F26 + AI3: mảnh giao diện hộp thư theo ca: huy hiệu kênh, đồng hồ khách chờ,
   nhãn và ghi chú nội bộ, cờ y khoa, tóm tắt AI và bước tiếp theo. */

export function ChannelBadge({ group }: { group?: string | null }): React.JSX.Element | null {
  if (!group) return null
  const b = CHANNEL_BADGE[group] ?? CHANNEL_BADGE.OTHER
  return (
    <span className="tag" style={{ background: b.bg, color: b.fg, marginRight: 4 }}>
      {b.t}
    </span>
  )
}

/** Đồng hồ khách chờ: tính lại mỗi 30 giây, đỏ khi quá ngưỡng Cài đặt. */
export function WaitingTimer({ since, alertMinutes }: { since?: string | null; alertMinutes: number }): React.JSX.Element | null {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(t)
  }, [])
  if (!since) return null
  const minutes = Math.max(0, Math.floor((now - new Date(since).getTime()) / 60_000))
  const late = minutes >= alertMinutes
  const text = minutes < 60 ? `${minutes} phút` : `${Math.floor(minutes / 60)} giờ ${minutes % 60} phút`
  return (
    <span
      className="tag"
      title="Khách đang chờ trả lời"
      style={{ background: late ? '#FEE2E2' : '#FEF3C7', color: late ? '#B91C1C' : '#B45309', marginLeft: 4 }}
    >
      Chờ {text}
    </span>
  )
}

export type InboxFilter = 'all' | 'mine' | 'unread' | 'unassigned'

export function InboxFilterBar({
  filter,
  channel,
  onFilter,
  onChannel
}: {
  filter: InboxFilter
  channel: string
  onFilter: (f: InboxFilter) => void
  onChannel: (c: string) => void
}): React.JSX.Element {
  const chips: Array<{ k: InboxFilter; t: string }> = [
    { k: 'all', t: 'Tất cả' },
    { k: 'mine', t: 'Của tôi' },
    { k: 'unread', t: 'Chưa đọc' },
    { k: 'unassigned', t: 'Chưa phân công' }
  ]
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 8 }}>
      {chips.map((c) => (
        <button key={c.k} className={`btn sm${filter === c.k ? '' : ' sec'}`} onClick={() => onFilter(c.k)}>
          {c.t}
        </button>
      ))}
      <select className="input" style={{ maxWidth: 110, padding: '2px 6px' }} value={channel} onChange={(e) => onChannel(e.target.value)}>
        <option value="">Mọi kênh</option>
        <option value="FB">Facebook</option>
        <option value="ZALO">Zalo</option>
        <option value="TIKTOK">TikTok</option>
      </select>
    </div>
  )
}

export function ConversationExtras({
  conversationId,
  canEdit,
  linked,
  aiReady
}: {
  conversationId: string
  canEdit: boolean
  linked: boolean
  aiReady: boolean
}): React.JSX.Element {
  const { say, fail } = useToast()
  const [tags, setTags] = useState<ConvTag[]>([])
  const [notes, setNotes] = useState<ConvNote[]>([])
  const [medical, setMedical] = useState(false)
  const [newTag, setNewTag] = useState('')
  const [newNote, setNewNote] = useState('')
  const [summary, setSummary] = useState<{ summary: string; nextAction: string; createdAt?: string } | null>(null)
  const [summarizing, setSummarizing] = useState(false)

  const load = useCallback(async () => {
    try {
      const r = await fetchConversationNotes(conversationId)
      setTags(r.tags)
      setNotes(r.notes)
      setMedical(r.medicalFlag)
      setSummary(linked ? await fetchLatestSummary(conversationId) : null)
    } catch {
      // Phần phụ: lỗi thì để trống, không chặn hộp thư.
    }
  }, [conversationId, linked])

  useEffect(() => {
    void load()
  }, [load])

  const summarize = async (): Promise<void> => {
    setSummarizing(true)
    try {
      const r = await summarizeConversation(conversationId)
      if (r.status === 'OK') setSummary({ summary: r.summary ?? '', nextAction: r.nextAction ?? '' })
      else
        fail(
          r.status === 'NOT_CONFIGURED'
            ? 'AI chưa cấu hình trên máy chủ.'
            : r.status === 'NO_CONSENT'
              ? 'Khách chưa đồng ý cho xử lý dữ liệu bằng AI.'
              : r.status === 'DISABLED'
                ? 'Tóm tắt AI đang tắt trong Cài đặt.'
                : (r.message ?? 'Không tóm tắt được.')
        )
    } catch (err) {
      fail(getApiErrorMessage(err))
    } finally {
      setSummarizing(false)
    }
  }

  return (
    <div style={{ marginTop: 12 }}>
      {medical ? (
        <div className="alert" style={{ background: '#FEE2E2', color: '#B91C1C', marginBottom: 8 }}>
          Khách hỏi vấn đề y khoa: sale không tư vấn, chuyển bác sĩ.
          {canEdit ? (
            <button
              className="btn sec sm"
              style={{ marginLeft: 6 }}
              onClick={async () => {
                await setMedicalFlag(conversationId, false)
                setMedical(false)
              }}
            >
              Gỡ cờ
            </button>
          ) : null}
        </div>
      ) : null}

      {linked ? (
        <div className="card" style={{ padding: 8, marginBottom: 8 }}>
          <div className="row">
            <b style={{ fontSize: 12.5 }}>Tóm tắt và bước tiếp theo (AI)</b>
            {aiReady ? (
              <button className="btn sec sm" style={{ marginLeft: 'auto' }} disabled={summarizing} onClick={() => void summarize()}>
                {summarizing ? 'Đang tóm tắt…' : 'Tóm tắt'}
              </button>
            ) : (
              <span className="muted" style={{ marginLeft: 'auto', fontSize: 11 }}>AI chưa cấu hình</span>
            )}
          </div>
          {summary ? (
            <div style={{ fontSize: 12.5, marginTop: 6 }}>
              {summary.summary}
              {summary.nextAction ? (
                <div style={{ marginTop: 4 }}>
                  <b>Tiếp theo:</b> {summary.nextAction}
                </div>
              ) : null}
              {summary.createdAt ? <div className="muted" style={{ fontSize: 11 }}>{dateTimeVi(summary.createdAt)}</div> : null}
            </div>
          ) : (
            <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>Chưa có tóm tắt.</div>
          )}
        </div>
      ) : null}

      <div className="pf">
        <div className="pl">Nhãn</div>
        <div className="pv">
          {tags.map((t) => (
            <span key={t.id} className="tag" style={{ background: `${t.color}22`, color: t.color, marginRight: 4 }}>
              {t.name}
              {canEdit ? (
                <span
                  style={{ cursor: 'pointer', marginLeft: 4 }}
                  onClick={async () => {
                    await removeConversationTag(conversationId, t.id)
                    setTags((x) => x.filter((y) => y.id !== t.id))
                  }}
                >
                  ✕
                </span>
              ) : null}
            </span>
          ))}
          {canEdit ? (
            <input
              className="input"
              style={{ marginTop: 4 }}
              placeholder="Thêm nhãn rồi Enter"
              value={newTag}
              onChange={(e) => setNewTag(e.target.value)}
              onKeyDown={async (e) => {
                if (e.key !== 'Enter' || !newTag.trim()) return
                try {
                  const t = await addConversationTag(conversationId, newTag.trim())
                  setTags((x) => (x.some((y) => y.id === t.id) ? x : [...x, t]))
                  setNewTag('')
                } catch (err) {
                  fail(getApiErrorMessage(err))
                }
              }}
            />
          ) : null}
        </div>
      </div>

      <div className="pf">
        <div className="pl">Ghi chú nội bộ (khách không thấy)</div>
        <div className="pv">
          {canEdit ? (
            <div className="row" style={{ gap: 4 }}>
              <input className="input" value={newNote} onChange={(e) => setNewNote(e.target.value)} placeholder="Ghi chú cho ca sau" />
              <button
                className="btn sec sm"
                disabled={!newNote.trim()}
                onClick={async () => {
                  try {
                    await addConversationNote(conversationId, newNote.trim())
                    setNewNote('')
                    say('Đã ghi chú.')
                    void load()
                  } catch (err) {
                    fail(getApiErrorMessage(err))
                  }
                }}
              >
                Lưu
              </button>
            </div>
          ) : null}
          {notes.map((n) => (
            <div key={n.id} style={{ fontSize: 12, padding: '4px 0', borderBottom: '1px dashed var(--border)' }}>
              {n.content}
              <div className="muted" style={{ fontSize: 11 }}>
                {n.userName ?? ''} · {dateTimeVi(n.createdAt)}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
