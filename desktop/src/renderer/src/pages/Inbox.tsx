import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  assignConversation,
  fetchConversation,
  fetchConversations,
  fetchMessages,
  fetchQuickReplies,
  fetchStaff,
  getApiErrorMessage,
  markConversationRead,
  sendMessage
} from '../lib/api'
import { getSocket, onSocket } from '../lib/socket'
import { useAuth } from '../lib/auth-context'
import { hhmm, relativeVi, vnd, dateTimeVi } from '../lib/format'
import { initialOf, stageStyle } from '../lib/ui'
import { Empty, Field, Tag, useToast } from '../components/ui'
import type {
  ChatMessage,
  Conversation,
  ConversationDetail,
  QuickReply,
  StaffUser
} from '../lib/types'

/* HỘP THƯ ZALO — màn hình lõi, ba cột đúng prototype:
   cột 1 danh sách hội thoại · cột 2 khung chat · cột 3 hồ sơ khách. */

export default function Inbox(): React.JSX.Element {
  const { can, user } = useAuth()
  const { say, fail } = useToast()
  const navigate = useNavigate()

  const [tab, setTab] = useState<'CUSTOMER' | 'GROUP'>('CUSTOMER')
  const [query, setQuery] = useState('')
  const [list, setList] = useState<Conversation[]>([])
  const [currentId, setCurrentId] = useState<string | null>(null)
  const [detail, setDetail] = useState<ConversationDetail | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [quickReplies, setQuickReplies] = useState<QuickReply[]>([])
  const [showQuick, setShowQuick] = useState(false)
  const [staff, setStaff] = useState<StaffUser[]>([])
  const [loading, setLoading] = useState(true)

  const msgsRef = useRef<HTMLDivElement>(null)

  const loadList = useCallback(async () => {
    try {
      const rows = await fetchConversations({ kind: tab, q: query || undefined })
      setList(rows)
      setCurrentId((prev) => (prev && rows.some((r) => r.id === prev) ? prev : (rows[0]?.id ?? null)))
    } catch (err) {
      fail(getApiErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }, [tab, query, fail])

  useEffect(() => {
    void loadList()
  }, [loadList])

  useEffect(() => {
    fetchQuickReplies().then(setQuickReplies).catch(() => undefined)
    if (can('hr.read')) fetchStaff().then(setStaff).catch(() => undefined)
  }, [can])

  // Nạp hội thoại đang chọn + vào room realtime của nó.
  useEffect(() => {
    if (!currentId) {
      setDetail(null)
      setMessages([])
      return
    }
    let cancelled = false
    const socket = getSocket()
    socket?.emit('conversation:join', currentId)

    Promise.all([fetchConversation(currentId), fetchMessages(currentId, { limit: 80 })])
      .then(([conv, msgs]) => {
        if (cancelled) return
        setDetail(conv)
        setMessages(msgs.items)
        if (conv.unreadCount > 0) {
          void markConversationRead(currentId).then(() => {
            setList((prev) => prev.map((c) => (c.id === currentId ? { ...c, unreadCount: 0 } : c)))
          })
        }
      })
      .catch((err) => !cancelled && fail(getApiErrorMessage(err)))

    return () => {
      cancelled = true
      socket?.emit('conversation:leave', currentId)
    }
  }, [currentId, fail])

  // Tin mới đẩy thẳng vào khung chat đang mở, và cập nhật dòng xem trước ở cột 1.
  useEffect(() => {
    const offMessage = onSocket('message:new', (message) => {
      if (message.conversationId === currentId) {
        setMessages((prev) => (prev.some((m) => m.id === message.id) ? prev : [...prev, message]))
        void markConversationRead(message.conversationId)
      }
      setList((prev) =>
        prev.map((c) =>
          c.id === message.conversationId
            ? {
                ...c,
                lastMessagePreview: message.content.slice(0, 160),
                lastMessageAt: message.createdAt,
                unreadCount: c.id === currentId ? 0 : c.unreadCount + (message.direction === 'IN' ? 1 : 0)
              }
            : c
        )
      )
    })
    return offMessage
  }, [currentId])

  useEffect(() => {
    const el = msgsRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages])

  const send = useCallback(async () => {
    const text = draft.trim()
    if (!text || !currentId || sending) return
    setSending(true)
    try {
      const message = await sendMessage(currentId, text)
      setMessages((prev) => [...prev, message])
      setDraft('')
      if (message.status === 'FAILED') {
        fail(message.errorMessage ?? 'Không gửi được tin qua Zalo — tin đã lưu để gửi lại.')
      }
      void loadList()
      const conv = await fetchConversation(currentId)
      setDetail(conv)
    } catch (err) {
      fail(getApiErrorMessage(err))
    } finally {
      setSending(false)
    }
  }, [draft, currentId, sending, fail, loadList])

  const assign = useCallback(
    async (userId: string | null) => {
      if (!currentId) return
      try {
        await assignConversation(currentId, userId)
        say(userId ? 'Đã gán người phụ trách hội thoại.' : 'Đã bỏ phân công hội thoại.')
        const conv = await fetchConversation(currentId)
        setDetail(conv)
        void loadList()
      } catch (err) {
        fail(getApiErrorMessage(err))
      }
    },
    [currentId, say, fail, loadList]
  )

  if (loading) {
    return (
      <div className="zalo">
        <Empty>Đang tải hộp thư…</Empty>
      </div>
    )
  }

  return (
    <div className="zalo">
      {/* ------------------------------------------------------- CỘT 1 */}
      <div className="zcol1">
        <div className="zc1-head">
          <div className="sec-title" style={{ margin: '0 0 8px' }}>
            Hộp thư
          </div>
          <div className="ztabs">
            <button className={`ztab${tab === 'CUSTOMER' ? ' on' : ''}`} onClick={() => setTab('CUSTOMER')}>
              Khách
            </button>
            <button className={`ztab${tab === 'GROUP' ? ' on' : ''}`} onClick={() => setTab('GROUP')}>
              Nhóm
            </button>
          </div>
          <input
            className="input"
            style={{ marginTop: 8 }}
            placeholder="Tìm theo tên hoặc số điện thoại"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>

        <div className="zlist">
          {list.length === 0 ? (
            <div className="empty">
              {query ? (
                <>
                  Không tìm thấy hội thoại nào khớp «{query}».
                  <br />
                  Thử tìm bằng số điện thoại.
                </>
              ) : (
                'Chưa có hội thoại nào.'
              )}
            </div>
          ) : (
            list.map((c) => (
              <div
                key={c.id}
                className={`zitem${c.id === currentId ? ' on' : ''}`}
                onClick={() => setCurrentId(c.id)}
              >
                <div className="ava">{initialOf(c.title)}</div>
                <div className="zmid">
                  <div className="ztop">
                    <b>{c.title}</b>
                    <span className="zgio">{relativeVi(c.lastMessageAt)}</span>
                  </div>
                  <div className="zprev">{c.lastMessagePreview ?? '—'}</div>
                  <div style={{ marginTop: 4 }}>
                    {c.kind === 'CUSTOMER' && c.customer ? (
                      <Tag style={stageStyle(c.customer.stage)} />
                    ) : (
                      <span className="tag out">Nội bộ</span>
                    )}
                    {c.kind === 'CUSTOMER' && !c.assignedTo ? (
                      <span className="tag" style={{ background: '#FEF3C7', color: '#B45309', marginLeft: 4 }}>
                        Chưa phân công
                      </span>
                    ) : null}
                  </div>
                </div>
                {c.unreadCount > 0 ? <span className="zdot">{c.unreadCount}</span> : null}
              </div>
            ))
          )}
        </div>
      </div>

      {/* ------------------------------------------------------- CỘT 2 */}
      {!detail ? (
        <div className="zcol2">
          <Empty>Chọn một hội thoại ở bên trái để bắt đầu trả lời.</Empty>
        </div>
      ) : (
        <>
          <div className="zcol2">
            <div className="zchead">
              <div>
                <b>{detail.title}</b>{' '}
                {detail.customer ? <span className="muted">· {detail.customer.phone ?? '—'}</span> : null}
                <br />
                {detail.kind === 'CUSTOMER' && detail.customer ? (
                  <Tag style={stageStyle(detail.customer.stage)} />
                ) : (
                  <span className="tag out">Nhóm nội bộ · {detail.memberCount ?? 0} thành viên</span>
                )}
              </div>
              {can('inbox.update') ? (
                <button
                  className="btn sec sm"
                  style={{ marginLeft: 'auto' }}
                  onClick={() => assign(user?.id ?? null)}
                >
                  Gán tôi phụ trách
                </button>
              ) : null}
            </div>

            <div className="zmsgs" ref={msgsRef}>
              {messages.length === 0 ? (
                <Empty>Chưa có tin nhắn nào trong hội thoại này.</Empty>
              ) : (
                messages.map((m) => (
                  <div
                    key={m.id}
                    className={`zm ${m.direction === 'IN' ? 'in' : 'out'}${m.status === 'FAILED' ? ' failed' : ''}`}
                  >
                    <div className="zbub">{m.content}</div>
                    <div className="zmeta">
                      {hhmm(m.createdAt)}
                      {m.senderName ? ` · ${m.senderName}` : ''}
                      {m.status === 'FAILED' ? ` · ✕ ${m.errorMessage ?? 'gửi lỗi'}` : ''}
                    </div>
                  </div>
                ))
              )}
            </div>

            <div className="zinput">
              <textarea
                className="input"
                rows={2}
                placeholder="Nhập tin nhắn…"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    void send()
                  }
                }}
                disabled={!can('inbox.update')}
              />
              <div className="zbar">
                <span className="muted" style={{ fontSize: 11.5 }}>
                  Enter gửi · Shift+Enter xuống dòng
                </span>
                <button className="btn sec sm" onClick={() => setShowQuick((v) => !v)}>
                  ⚡ Mẫu
                </button>
                <button
                  className="btn sm"
                  style={{ marginLeft: 'auto' }}
                  onClick={() => void send()}
                  disabled={sending || !draft.trim() || !can('inbox.update')}
                >
                  {sending ? 'Đang gửi…' : 'Gửi'}
                </button>
              </div>

              {showQuick ? (
                <div className="card" style={{ marginTop: 8, padding: 8 }}>
                  {quickReplies.length === 0 ? (
                    <div className="muted" style={{ fontSize: 12 }}>
                      Chưa có mẫu tin nhanh nào.
                    </div>
                  ) : (
                    quickReplies.map((q) => (
                      <div
                        key={q.id}
                        style={{
                          padding: '6px 4px',
                          borderBottom: '1px dashed var(--border)',
                          cursor: 'pointer',
                          fontSize: 12.5
                        }}
                        onClick={() => {
                          setDraft(q.content)
                          setShowQuick(false)
                        }}
                      >
                        <b>{q.title}</b>
                        {q.category ? <span className="muted"> · {q.category}</span> : null}
                        <div className="muted">{q.content.slice(0, 90)}…</div>
                      </div>
                    ))
                  )}
                </div>
              ) : null}
            </div>
          </div>

          {/* ----------------------------------------------------- CỘT 3 */}
          <div className="zcol3">
            <div className="sec-title">Hồ sơ khách</div>
            <div className="prof">
              <div className="pava">{initialOf(detail.title)}</div>
              <div>
                <b>{detail.title}</b>
                <div className="muted" style={{ fontSize: 12 }}>
                  {detail.customer?.phone ?? (detail.kind === 'GROUP' ? 'Nhóm nội bộ' : 'Chưa có số')}
                </div>
              </div>
            </div>

            {!detail.customer ? (
              <>
                <Field
                  label="Tên trong hồ sơ"
                  value={<span className="muted">Chưa gắn hồ sơ khách</span>}
                />
                {can('inbox.update') && detail.kind === 'CUSTOMER' ? (
                  <button
                    className="btn sec block"
                    style={{ marginTop: 12 }}
                    onClick={() => navigate('/khach-hang')}
                  >
                    Tìm và gắn hồ sơ khách →
                  </button>
                ) : null}
              </>
            ) : (
              <>
                <Field label="Tên trong hồ sơ" value={detail.customer.name} />
                <Field
                  label="Dịch vụ quan tâm"
                  value={
                    detail.customer.interest?.length ? (
                      detail.customer.interest.map((d) => (
                        <span
                          key={d}
                          className="tag"
                          style={{ background: 'var(--green-50)', color: 'var(--green-700)', marginRight: 4 }}
                        >
                          {d}
                        </span>
                      ))
                    ) : (
                      <span className="muted">Chưa ghi nhận</span>
                    )
                  }
                />
                <Field label="Giai đoạn phễu" value={<Tag style={stageStyle(detail.customer.stage)} />} />
                <Field
                  label="Tư vấn viên phụ trách"
                  value={detail.customer.assignedTo?.name ?? <span className="muted">— Chưa phân công —</span>}
                />
                <Field
                  label="Telesale phụ trách"
                  value={
                    can('inbox.update') && staff.length ? (
                      <select
                        className="input"
                        value={detail.assignedTo?.id ?? ''}
                        onChange={(e) => void assign(e.target.value || null)}
                      >
                        <option value="">— Chưa phân công —</option>
                        {staff.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.name}
                          </option>
                        ))}
                      </select>
                    ) : (
                      (detail.assignedTo?.name ?? '—')
                    )
                  }
                />
                <Field
                  label="Lịch hẹn kế tiếp"
                  value={
                    detail.nextAppointment ? (
                      <>
                        {dateTimeVi(detail.nextAppointment.startAt)}
                        <br />
                        <span className="muted">
                          {detail.nextAppointment.title}
                          {detail.nextAppointment.doctor ? ` · ${detail.nextAppointment.doctor.name}` : ''}
                        </span>
                      </>
                    ) : (
                      <span className="muted">Chưa có lịch</span>
                    )
                  }
                />
                <Field
                  label="Công nợ"
                  value={
                    detail.debt && detail.debt > 0 ? (
                      <>
                        <b style={{ color: 'var(--danger)' }}>{vnd(detail.debt)}</b>
                        {detail.debtDueDate ? (
                          <span className="muted"> · hạn {new Date(detail.debtDueDate).toLocaleDateString('vi-VN')}</span>
                        ) : null}
                      </>
                    ) : (
                      <span className="muted">Không có công nợ</span>
                    )
                  }
                />
                <Field label="Tổng đã chi tiêu" value={vnd(detail.totalPaid ?? 0)} />
                <Field
                  label="Nguồn khách"
                  value={<span className="tag out">{detail.customer.channel?.name ?? 'Không rõ'}</span>}
                />

                <div style={{ display: 'grid', gap: 7, marginTop: 12 }}>
                  <button
                    className="btn block"
                    onClick={() => navigate(`/khach-hang/${detail.customer!.id}`)}
                  >
                    Mở hồ sơ khách →
                  </button>
                  {can('appointment.create') ? (
                    <button
                      className="btn sec block"
                      onClick={() => navigate(`/lich-hen?customerId=${detail.customer!.id}`)}
                    >
                      Đặt lịch khám →
                    </button>
                  ) : null}
                </div>
              </>
            )}
          </div>
        </>
      )}
    </div>
  )
}
