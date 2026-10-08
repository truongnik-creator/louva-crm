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
  renderTemplate,
  sendMessage
} from '../lib/api'
import { getSocket, onSocket } from '../lib/socket'
import { useAuth } from '../lib/auth-context'
import { hhmm, relativeVi, vnd, dateTimeVi } from '../lib/format'
import { initialOf } from '../lib/ui'
import { useClinic } from '../lib/clinic-context'
import { CannedMessageModal, ExtractSuggestionCard } from '../components/inbox-nova'
import { Empty, Field, Tag, useToast } from '../components/ui'
import { ChatAttachments, LinkCustomerPanel } from '../components/inbox-parts'
import { ChannelBadge, ConversationExtras, InboxFilterBar, WaitingTimer, type InboxFilter } from '../components/inbox-lo4'
import { suggestReply } from '../lib/api-lo4'
import { DepositPanel } from '../components/deposit-parts'
import { UpsellPanel, useMoneyVisible } from '../components/crm360-parts'
import type {
  Appointment,
  ChatMessage,
  Conversation,
  ConversationDetail,
  QuickReply,
  StaffUser
} from '../lib/types'

/* HỘP THƯ ZALO — màn hình lõi, ba cột đúng prototype:
   cột 1 danh sách hội thoại · cột 2 khung chat · cột 3 hồ sơ khách. */

const CONV_PAGE = 50
const MSG_PAGE = 50

export default function Inbox(): React.JSX.Element {
  const { can, user } = useAuth()
  const { say, fail } = useToast()
  const navigate = useNavigate()
  const clinic = useClinic()
  const moneyVisible = useMoneyVisible()
  const [canned, setCanned] = useState<'location' | 'price' | null>(null)
  const [prefill, setPrefill] = useState<{ name: string | null; phone: string | null; at: number } | null>(null)

  const [tab, setTab] = useState<'CUSTOMER' | 'GROUP'>('CUSTOMER')
  // F26: bộ lọc hộp thư theo ca.
  const [filter, setFilter] = useState<InboxFilter>('all')
  const [channel, setChannel] = useState('')
  // AI2: câu gợi ý đang nằm trong ô soạn (để đối chiếu câu gợi ý và câu thực gửi).
  const [suggestionId, setSuggestionId] = useState<string | null>(null)
  const [suggesting, setSuggesting] = useState(false)
  const alertMinutes = clinic.inbox?.waitingAlertMinutes ?? 15
  const [query, setQuery] = useState('')
  const [list, setList] = useState<Conversation[]>([])
  const [currentId, setCurrentId] = useState<string | null>(null)
  // F28: trên điện thoại chỉ hiện một cột: danh sách, hội thoại hoặc hồ sơ khách.
  const [mPane, setMPane] = useState<'list' | 'chat' | 'panel'>('list')
  const [detail, setDetail] = useState<ConversationDetail | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [quickReplies, setQuickReplies] = useState<QuickReply[]>([])
  const [showQuick, setShowQuick] = useState(false)
  const [staff, setStaff] = useState<StaffUser[]>([])
  const [loading, setLoading] = useState(true)

  const msgsRef = useRef<HTMLDivElement>(null)
  // T3: phân trang hội thoại (Tải thêm) và tin nhắn (cuộn lên để tải tin cũ).
  const [convHasMore, setConvHasMore] = useState(false)
  const [loadingMoreConv, setLoadingMoreConv] = useState(false)
  const [olderCursor, setOlderCursor] = useState<string | null>(null)
  const [loadingOlder, setLoadingOlder] = useState(false)
  /** Chỉ tự cuộn xuống đáy khi tin mới thêm vào CUỐI, không phải khi nạp tin cũ lên đầu. */
  const keepScrollRef = useRef<number | null>(null)

  const listParams = useCallback(
    () => ({
      kind: tab,
      q: query || undefined,
      ...(filter === 'mine' ? { mine: '1' } : filter === 'unread' ? { unread: '1' } : filter === 'unassigned' ? { unassigned: '1' } : {}),
      ...(channel ? { channel } : {})
    }),
    [tab, query, filter, channel]
  )

  const loadList = useCallback(async () => {
    try {
      const rows = await fetchConversations({ ...listParams(), limit: CONV_PAGE })
      setConvHasMore(rows.length === CONV_PAGE)
      setList(rows)
      setCurrentId((prev) => (prev && rows.some((r) => r.id === prev) ? prev : (rows[0]?.id ?? null)))
    } catch (err) {
      fail(getApiErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }, [listParams, fail])

  useEffect(() => {
    void loadList()
  }, [loadList])

  const loadMoreConversations = async (): Promise<void> => {
    setLoadingMoreConv(true)
    try {
      const rows = await fetchConversations({ ...listParams(), limit: CONV_PAGE, offset: list.length })
      setConvHasMore(rows.length === CONV_PAGE)
      setList((prev) => [...prev, ...rows.filter((r) => !prev.some((p) => p.id === r.id))])
    } catch (err) {
      fail(getApiErrorMessage(err))
    } finally {
      setLoadingMoreConv(false)
    }
  }

  const loadOlderMessages = async (): Promise<void> => {
    if (!currentId || !olderCursor || loadingOlder) return
    const el = msgsRef.current
    setLoadingOlder(true)
    try {
      const page = await fetchMessages(currentId, { limit: MSG_PAGE, cursor: olderCursor })
      // Giữ nguyên vị trí đang đọc sau khi chèn tin cũ lên đầu.
      keepScrollRef.current = el ? el.scrollHeight - el.scrollTop : null
      setMessages((prev) => [...page.items.filter((m) => !prev.some((p) => p.id === m.id)), ...prev])
      setOlderCursor(page.nextCursor)
    } catch (err) {
      fail(getApiErrorMessage(err))
    } finally {
      setLoadingOlder(false)
    }
  }

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

    setOlderCursor(null)
    setSuggestionId(null)
    Promise.all([fetchConversation(currentId), fetchMessages(currentId, { limit: MSG_PAGE })])
      .then(([conv, msgs]) => {
        if (cancelled) return
        setDetail(conv)
        setMessages(msgs.items)
        setOlderCursor(msgs.nextCursor)
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
    if (!el) return
    if (keepScrollRef.current != null) {
      el.scrollTop = el.scrollHeight - keepScrollRef.current
      keepScrollRef.current = null
    } else {
      el.scrollTop = el.scrollHeight
    }
  }, [messages])

  const send = useCallback(async () => {
    const text = draft.trim()
    if (!text || !currentId || sending) return
    // B12: backend cũng chặn, nhưng báo ngay tại chỗ cho nhân viên sửa.
    if (text.includes('{{')) {
      fail('Tin còn biến chưa điền dạng {{...}}. Sửa phần đó trước khi gửi.')
      return
    }
    setSending(true)
    try {
      const message = await sendMessage(currentId, text, suggestionId ?? undefined)
      setMessages((prev) => [...prev, message])
      setDraft('')
      setSuggestionId(null)
      if (message.status === 'FAILED') {
        fail(message.errorMessage ?? 'Không gửi được tin qua kênh chat, tin đã lưu để gửi lại.')
      }
      void loadList()
      const conv = await fetchConversation(currentId)
      setDetail(conv)
    } catch (err) {
      fail(getApiErrorMessage(err))
    } finally {
      setSending(false)
    }
  }, [draft, currentId, sending, fail, loadList, suggestionId])

  /** AI2: gợi ý câu trả lời theo kịch bản; sale đọc, sửa rồi tự bấm Gửi. */
  const suggest = async (): Promise<void> => {
    if (!currentId) return
    setSuggesting(true)
    try {
      const r = await suggestReply(currentId)
      if ((r.status === 'OK' || r.status === 'BLOCKED_MEDICAL') && r.suggestion) {
        setDraft(r.suggestion)
        setSuggestionId(r.id)
        if (r.status === 'BLOCKED_MEDICAL') fail(r.reason ?? 'Khách hỏi vấn đề y khoa: chuyển bác sĩ.')
        else say('Đã điền câu gợi ý. Đọc, sửa rồi bấm Gửi.')
      } else {
        fail(r.reason ?? 'Không có câu gợi ý phù hợp.')
      }
    } catch (err) {
      fail(getApiErrorMessage(err))
    } finally {
      setSuggesting(false)
    }
  }

  /** B12: chọn mẫu thì điền biến {{...}} từ hồ sơ khách, bảng giá, lịch hẹn. */
  const pickQuickReply = async (content: string): Promise<void> => {
    setShowQuick(false)
    if (!currentId || !content.includes('{{')) {
      setDraft(content)
      return
    }
    try {
      const r = await renderTemplate(currentId, content)
      setDraft(r.content)
      if (r.unresolved.length) {
        fail(`Chưa có dữ liệu cho ${r.unresolved.map((u) => `{{${u}}}`).join(', ')}. Sửa trong ô soạn trước khi gửi.`)
      }
    } catch (err) {
      setDraft(content)
      fail(getApiErrorMessage(err))
    }
  }

  const reloadDetail = useCallback(async () => {
    if (!currentId) return
    try {
      setDetail(await fetchConversation(currentId))
      void loadList()
    } catch (err) {
      fail(getApiErrorMessage(err))
    }
  }, [currentId, fail, loadList])

  const markSaved = (attachmentId: string, photoSetId: string): void => {
    setMessages((prev) =>
      prev.map((m) =>
        m.attachments?.some((a) => a.id === attachmentId)
          ? {
              ...m,
              attachments: m.attachments.map((a) => (a.id === attachmentId ? { ...a, savedPhotoSetId: photoSetId } : a))
            }
          : m
      )
    )
  }

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

  const lastInboundId = [...messages].reverse().find((m) => m.direction === 'IN')?.id ?? null

  if (loading) {
    return (
      <div className="zalo">
        <Empty>Đang tải hộp thư…</Empty>
      </div>
    )
  }

  return (
    <div className={`zalo m-${detail ? mPane : 'list'}`}>
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
          {tab === 'CUSTOMER' ? (
            <InboxFilterBar filter={filter} channel={channel} onFilter={setFilter} onChannel={setChannel} />
          ) : null}
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
                onClick={() => {
                  setCurrentId(c.id)
                  setMPane('chat')
                }}
              >
                <div className="ava">{initialOf(c.title)}</div>
                <div className="zmid">
                  <div className="ztop">
                    <b>{c.title}</b>
                    <span className="zgio">{relativeVi(c.lastMessageAt)}</span>
                  </div>
                  <div className="zprev">{c.lastMessagePreview ?? '—'}</div>
                  <div style={{ marginTop: 4 }}>
                    {c.kind === 'CUSTOMER' ? <ChannelBadge group={c.channelGroup} /> : null}
                    {c.kind === 'CUSTOMER' && c.customer ? (
                      <Tag style={clinic.stageStyle(c.customer.stage)} />
                    ) : (
                      <span className="tag out">Nội bộ</span>
                    )}
                    {c.kind === 'CUSTOMER' && !c.assignedTo ? (
                      <span className="tag" style={{ background: '#FEF3C7', color: '#B45309', marginLeft: 4 }}>
                        Chưa phân công
                      </span>
                    ) : null}
                    {c.medicalFlag ? (
                      <span className="tag" style={{ background: '#FEE2E2', color: '#B91C1C', marginLeft: 4 }}>Y khoa</span>
                    ) : null}
                    {c.kind === 'CUSTOMER' ? <WaitingTimer since={c.waitingSince} alertMinutes={alertMinutes} /> : null}
                    {c.tags?.map((t) => (
                      <span key={t.id} className="tag" style={{ background: `${t.color}22`, color: t.color, marginLeft: 4 }}>
                        {t.name}
                      </span>
                    ))}
                  </div>
                </div>
                {c.unreadCount > 0 ? <span className="zdot">{c.unreadCount}</span> : null}
              </div>
            ))
          )}
          {convHasMore ? (
            <div style={{ padding: 10, textAlign: 'center' }}>
              <button className="btn sec sm" onClick={() => void loadMoreConversations()} disabled={loadingMoreConv}>
                {loadingMoreConv ? 'Đang tải…' : 'Tải thêm hội thoại'}
              </button>
            </div>
          ) : null}
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
              <button className="btn sec sm m-only" onClick={() => setMPane('list')} aria-label="Về danh sách hội thoại">
                ‹ Danh sách
              </button>
              <div>
                <b>{detail.title}</b>{' '}
                {detail.customer ? <span className="muted">· {detail.customer.phone ?? '—'}</span> : null}
                <br />
                {detail.kind === 'CUSTOMER' && detail.customer ? (
                  <Tag style={clinic.stageStyle(detail.customer.stage)} />
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
              <button className="btn sm m-only" onClick={() => setMPane('panel')}>
                Hồ sơ ›
              </button>
            </div>

            <div
              className="zmsgs"
              ref={msgsRef}
              onScroll={(e) => {
                if (e.currentTarget.scrollTop < 40 && olderCursor) void loadOlderMessages()
              }}
            >
              {olderCursor ? (
                <div style={{ textAlign: 'center', padding: 6 }}>
                  <button className="btn sec sm" onClick={() => void loadOlderMessages()} disabled={loadingOlder}>
                    {loadingOlder ? 'Đang tải tin cũ…' : 'Xem tin cũ hơn'}
                  </button>
                </div>
              ) : null}
              {messages.length === 0 ? (
                <Empty>Chưa có tin nhắn nào trong hội thoại này.</Empty>
              ) : (
                messages.map((m) => (
                  <div
                    key={m.id}
                    className={`zm ${m.direction === 'IN' ? 'in' : 'out'}${m.status === 'FAILED' ? ' failed' : ''}`}
                  >
                    <div className="zbub">
                      {m.content}
                      <ChatAttachments
                        conversationId={m.conversationId}
                        attachments={m.attachments}
                        canSave={can('photo.create') && Boolean(detail.customer)}
                        onSaved={markSaved}
                      />
                    </div>
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
                onChange={(e) => {
                  setDraft(e.target.value)
                  if (!e.target.value) setSuggestionId(null)
                }}
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
                {can('inbox.update') && detail.kind === 'CUSTOMER' ? (
                  <>
                    <button
                      className="btn sec sm"
                      disabled={suggesting}
                      title="AI gợi ý theo kịch bản bán hàng chuẩn. Luôn đọc và sửa trước khi gửi."
                      onClick={() => void suggest()}
                    >
                      {suggesting ? 'Đang gợi ý…' : '✨ Gợi ý trả lời'}
                    </button>
                    <button className="btn sec sm" onClick={() => setCanned('location')}>
                      📍 Gửi vị trí
                    </button>
                    <button className="btn sec sm" onClick={() => setCanned('price')}>
                      🏷 Gửi bảng giá chuẩn
                    </button>
                  </>
                ) : null}
                <button
                  className="btn sm"
                  style={{ marginLeft: 'auto' }}
                  onClick={() => void send()}
                  disabled={sending || !draft.trim() || !can('inbox.update')}
                >
                  {sending ? 'Đang gửi…' : 'Gửi'}
                </button>
              </div>

              {canned ? (
                <CannedMessageModal
                  conversationId={detail.id}
                  kind={canned}
                  onClose={() => setCanned(null)}
                  onSent={(m) => {
                    setMessages((prev) => (prev.some((x) => x.id === m.id) ? prev : [...prev, m]))
                    void loadList()
                  }}
                />
              ) : null}

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
                        onClick={() => void pickQuickReply(q.content)}
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
            <button className="btn sec sm m-only" style={{ marginBottom: 8 }} onClick={() => setMPane('chat')}>
              ‹ Về hội thoại
            </button>
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

            {detail.kind === 'CUSTOMER' ? (
              <ExtractSuggestionCard
                key={detail.id}
                conversationId={detail.id}
                linked={Boolean(detail.customer)}
                lastInboundId={lastInboundId}
                canApply={detail.customer ? can('customer.update') : can('customer.create')}
                onApplied={() => void reloadDetail()}
                onPrefill={(v) => setPrefill({ ...v, at: Date.now() })}
              />
            ) : null}
            {detail.adCampaign || detail.adId || detail.adPostId ? (
              <Field
                label="Nguồn quảng cáo"
                value={<span className="tag out">{detail.adCampaign ?? `Quảng cáo ${detail.adId ?? detail.adPostId ?? ''}`}</span>}
              />
            ) : null}

            {detail.kind === 'CUSTOMER' ? (
              <ConversationExtras
                key={`x-${detail.id}`}
                conversationId={detail.id}
                canEdit={can('inbox.update')}
                linked={Boolean(detail.customer)}
                aiReady={clinic.ai.configured}
              />
            ) : null}

            {!detail.customer ? (
              <>
                <Field
                  label="Tên trong hồ sơ"
                  value={<span className="muted">Chưa gắn hồ sơ khách</span>}
                />
                {can('inbox.update') && detail.kind === 'CUSTOMER' ? (
                  <LinkCustomerPanel
                    key={detail.id}
                    conversationId={detail.id}
                    suggestedName={detail.title}
                    canCreate={can('customer.create')}
                    onLinked={() => void reloadDetail()}
                    prefill={prefill}
                  />
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
                <Field label="Bước bán hàng" value={<Tag style={clinic.stageStyle(detail.customer.stage)} />} />
                <Field
                  label="Đồng ý xử lý dữ liệu bằng AI"
                  value={detail.customer.aiDataConsent ? 'Đã đồng ý' : <span className="muted">Chưa đồng ý</span>}
                />
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
                {/* Lô 7 · sửa lỗi tồn: thu cọc + VietQR ngay ở cột 3 hộp thư (lịch hẹn kế tiếp). */}
                {detail.nextAppointment ? (
                  <DepositPanel appointment={detail.nextAppointment as unknown as Appointment} onChanged={() => void reloadDetail()} />
                ) : can('appointment.create') ? (
                  <div className="muted" style={{ fontSize: 12, margin: '6px 0' }}>
                    Đặt lịch cho khách để thu cọc và gửi mã VietQR.
                  </div>
                ) : null}
                <Field
                  label="Công nợ"
                  value={
                    detail.debt && detail.debt > 0 ? (
                      moneyVisible ? (
                        <>
                          <b style={{ color: 'var(--danger)' }}>{vnd(detail.debt)}</b>
                          {detail.debtDueDate ? (
                            <span className="muted"> · hạn {new Date(detail.debtDueDate).toLocaleDateString('vi-VN')}</span>
                          ) : null}
                        </>
                      ) : (
                        <span className="hchip UNPAID">Có công nợ</span>
                      )
                    ) : (
                      <span className="muted">Không có công nợ</span>
                    )
                  }
                />
                {/* Lô 7 · Quyết định 3: số tiền chỉ hiện với quản lý, kế toán. */}
                {moneyVisible ? <Field label="Tổng đã chi tiêu" value={vnd(detail.totalPaid ?? 0)} /> : null}
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
                <UpsellPanel key={`up-${detail.customer.id}`} customerId={detail.customer.id} context="INBOX" compact />
              </>
            )}
          </div>
        </>
      )}
    </div>
  )
}
