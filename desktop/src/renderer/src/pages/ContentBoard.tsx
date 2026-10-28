import React, { useCallback, useEffect, useMemo, useState } from 'react'
import {
  createContentPlan,
  createContentTask,
  deleteContentPlan,
  fetchCampaigns,
  fetchChannels,
  fetchContentByPerson,
  fetchContentMeasure,
  fetchContentPlans,
  linkEntryToPlan,
  fetchStaff,
  getApiErrorMessage,
  moveContentStage,
  updateContentPlan,
  updateContentTask
} from '../lib/api'
import type {
  Campaign,
  ContentMeasure,
  ContentPersonRow,
  ContentRating,
  ContentUnmatchedEntry,
  ContentFormat,
  ContentPlan,
  ContentStage,
  ContentTaskKind,
  StaffUser,
  WorkTaskStatus
} from '../lib/types'
import { useAuth } from '../lib/auth-context'
import { dateVi, toISODate } from '../lib/format'
import { Empty, Modal, useToast } from '../components/ui'

/* F37: BẢNG SẢN XUẤT NỘI DUNG — media, mkt, design, content.

   F36 kéo việc ĐÃ LÀM từ trang tính về. Màn này lo phần trang tính không làm
   được: bài sắp làm, ai đang giữ, bao giờ đăng.

   Hai tab cùng một dữ liệu, hai câu hỏi khác nhau:
     · Bảng — "việc đang tắc ở bước nào"
     · Lịch — "tuần này đăng những gì"

   Màn này KHÔNG đọc dữ liệu khách. Backend cũng không trả ra, nên không có gì
   phải che ở đây. */

const STAGES: Array<{ key: ContentStage; label: string; fg: string }> = [
  { key: 'Y_TUONG', label: 'Ý tưởng', fg: '#8b8b8b' },
  { key: 'DANG_LAM', label: 'Đang làm', fg: '#2f6fd0' },
  { key: 'CHO_DUYET', label: 'Chờ duyệt', fg: '#c98a00' },
  { key: 'DA_DUYET', label: 'Đã duyệt', fg: '#2f8f4e' },
  { key: 'DA_DANG', label: 'Đã đăng', fg: '#3c7a3c' }
]

const FORMAT_LABEL: Record<ContentFormat, string> = {
  VIDEO: 'Video',
  ANH: 'Ảnh',
  BAI_VIET: 'Bài viết',
  LIVE: 'Live'
}

const TASK_LABEL: Record<ContentTaskKind, string> = {
  QUAY: 'Quay',
  DUNG: 'Dựng',
  THIET_KE: 'Thiết kế',
  VIET: 'Viết',
  DANG: 'Đăng'
}

const TASK_KINDS = Object.keys(TASK_LABEL) as ContentTaskKind[]

/** Bước kế tiếp trong chuỗi, hoặc null nếu đã ở cuối. */
function nextStage(stage: ContentStage): ContentStage | null {
  const i = STAGES.findIndex((s) => s.key === stage)
  return i >= 0 && i < STAGES.length - 1 ? STAGES[i + 1].key : null
}

export default function ContentBoard(): React.JSX.Element {
  const { can, scopeOf, user } = useAuth()
  const { say, fail } = useToast()

  const [tab, setTab] = useState<'bang' | 'lich' | 'dolo'>('bang')
  const [plans, setPlans] = useState<ContentPlan[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [channels, setChannels] = useState<Array<{ id: string; key: string; name: string }>>([])
  const [campaigns, setCampaigns] = useState<Campaign[]>([])
  const [staff, setStaff] = useState<StaffUser[]>([])

  const [filterChannel, setFilterChannel] = useState('')
  const [filterOwner, setFilterOwner] = useState('')
  const [creating, setCreating] = useState(false)
  const [detail, setDetail] = useState<ContentPlan | null>(null)

  const canCreate = can('content.create')
  const canApprove = can('content.approve')
  const canDelete = can('content.delete')

  /* Sửa được bài NÀO, chứ không phải có sửa được hay không.
     Media/Design/Content có content.update phạm vi OWN: chỉ bài mình phụ trách
     hoặc có việc gán cho mình. Nếu cứ hiện nút cho mọi thẻ thì người dùng bấm
     vào chỉ nhận 404 — đúng về bảo mật nhưng là giao diện gài bẫy. */
  const updateScope = scopeOf('content.update')
  const canEditPlan = useCallback(
    (p: ContentPlan) => {
      if (!updateScope) return false
      if (updateScope !== 'OWN') return true
      const me = user?.id
      return Boolean(me && (p.ownerId === me || p.tasks.some((t) => t.assigneeId === me)))
    },
    [updateScope, user?.id]
  )

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setPlans(
        await fetchContentPlans({
          ...(filterChannel ? { channelId: filterChannel } : {}),
          ...(filterOwner ? { ownerId: filterOwner } : {})
        })
      )
    } catch (e) {
      setError(getApiErrorMessage(e))
    } finally {
      setLoading(false)
    }
  }, [filterChannel, filterOwner])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    // Danh mục cho bộ lọc và biểu mẫu. Hỏng thì màn vẫn chạy, chỉ mất gợi ý.
    void (async () => {
      const [ch, cp, st] = await Promise.allSettled([fetchChannels(), fetchCampaigns(), fetchStaff({ status: 'ACTIVE' })])
      if (ch.status === 'fulfilled') setChannels(ch.value)
      if (cp.status === 'fulfilled') setCampaigns(cp.value)
      if (st.status === 'fulfilled') setStaff(st.value)
    })()
  }, [])

  const byStage = useMemo(() => {
    const m = new Map<ContentStage, ContentPlan[]>()
    for (const s of STAGES) m.set(s.key, [])
    for (const p of plans) m.get(p.stage)?.push(p)
    return m
  }, [plans])

  const huy = useMemo(() => plans.filter((p) => p.stage === 'HUY'), [plans])

  async function move(plan: ContentPlan, to: ContentStage) {
    // Đã đăng thì phải có link — hỏi ngay tại chỗ thay vì để backend trả 422.
    let postUrl: string | undefined
    if (to === 'DA_DANG' && !plan.postUrl) {
      const nhap = window.prompt('Dán link bài đã đăng:')
      if (!nhap) return
      postUrl = nhap.trim()
    }
    try {
      const updated = await moveContentStage(plan.id, to, postUrl)
      setPlans((prev) => prev.map((p) => (p.id === updated.id ? updated : p)))
      if (detail?.id === updated.id) setDetail(updated)
      fail(`"${updated.title}" → ${STAGES.find((s) => s.key === to)?.label ?? to}`)
    } catch (e) {
      say(getApiErrorMessage(e))
    }
  }

  return (
    <div>
      <div className="row" style={{ marginBottom: 10 }}>
        <div>
          <h2 style={{ margin: 0 }}>Sản xuất nội dung</h2>
          <div className="muted" style={{ fontSize: 12 }}>
            Kế hoạch bài đăng của Media, Design, Content và MKT. Bảng chung của đội.
          </div>
        </div>
        {canCreate ? (
          <button className="btn" style={{ marginLeft: 'auto' }} onClick={() => setCreating(true)}>
            + Bài mới
          </button>
        ) : null}
      </div>

      <div className="pl-toolbar">
        <div className="seg" role="tablist" aria-label="Kiểu xem">
          <button className={tab === 'bang' ? 'on' : ''} role="tab" onClick={() => setTab('bang')}>
            Bảng
          </button>
          <button className={tab === 'lich' ? 'on' : ''} role="tab" onClick={() => setTab('lich')}>
            Lịch
          </button>
          <button className={tab === 'dolo' ? 'on' : ''} role="tab" onClick={() => setTab('dolo')}>
            Đo lường
          </button>
        </div>

        <select className="input" style={{ width: 160 }} value={filterChannel} onChange={(e) => setFilterChannel(e.target.value)}>
          <option value="">Mọi kênh</option>
          {channels.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>

        <select className="input" style={{ width: 180 }} value={filterOwner} onChange={(e) => setFilterOwner(e.target.value)}>
          <option value="">Mọi người phụ trách</option>
          {staff.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>

        {filterChannel || filterOwner ? (
          <button
            className="btn sec sm"
            onClick={() => {
              setFilterChannel('')
              setFilterOwner('')
            }}
          >
            Bỏ lọc
          </button>
        ) : null}

        <button className="btn sec sm" style={{ marginLeft: 'auto' }} onClick={() => void load()}>
          Tải lại
        </button>
      </div>

      {error ? <div className="card t-over" style={{ marginBottom: 10 }}>{error}</div> : null}
      {loading && tab !== 'dolo' ? <Empty>Đang tải…</Empty> : null}

      {!loading && plans.length === 0 && tab !== 'dolo' ? (
        <Empty>
          Chưa có bài nào.
          {canCreate ? ' Bấm "Bài mới" để thêm bài đầu tiên.' : ' Chờ MKT hoặc quản lý lên kế hoạch.'}
        </Empty>
      ) : null}

      {!loading && plans.length > 0 && tab === 'bang' ? (
        <div className="kb">
          {STAGES.map((col) => {
            const items = byStage.get(col.key) ?? []
            return (
              <div className="kb-col" key={col.key}>
                <div className="kb-head">
                  <span className="dot" style={{ background: col.fg }} />
                  {col.label}
                </div>
                <div className="kb-sub">{items.length} bài</div>
                <div className="kb-list">
                  {items.length === 0 ? <div className="kb-empty">Trống</div> : null}
                  {items.map((p) => (
                    <PlanCard
                      key={p.id}
                      plan={p}
                      canUpdate={canEditPlan(p)}
                      canApprove={canApprove}
                      onOpen={() => setDetail(p)}
                      onMove={(to) => void move(p, to)}
                    />
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      ) : null}

      {!loading && plans.length > 0 && tab === 'lich' ? <LichDang plans={plans} onOpen={setDetail} /> : null}

      {tab === 'dolo' ? <DoLuong plans={plans} /> : null}

      {huy.length > 0 && tab !== 'dolo' ? (
        <div className="card" style={{ marginTop: 12 }}>
          <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
            Đã huỷ ({huy.length}) — giữ lại để tra lịch sử, không quay lại được
          </div>
          {huy.map((p) => (
            <div key={p.id} className="ln muted" style={{ textDecoration: 'line-through' }}>
              {p.title}
            </div>
          ))}
        </div>
      ) : null}

      {creating ? (
        <TaoBai
          channels={channels}
          campaigns={campaigns}
          staff={staff}
          meId={user?.id ?? null}
          onClose={() => setCreating(false)}
          onDone={(p) => {
            setPlans((prev) => [p, ...prev])
            setCreating(false)
            say('Đã tạo bài')
          }}
        />
      ) : null}

      {detail ? (
        <ChiTietBai
          plan={detail}
          staff={staff}
          canUpdate={canEditPlan(detail)}
          canApprove={canApprove}
          canDelete={canDelete}
          onClose={() => setDetail(null)}
          onChanged={(p) => {
            setPlans((prev) => prev.map((x) => (x.id === p.id ? p : x)))
            setDetail(p)
          }}
          onDeleted={(id) => {
            setPlans((prev) => prev.filter((x) => x.id !== id))
            setDetail(null)
            say('Đã xoá bài')
          }}
          onMove={(to) => void move(detail, to)}
        />
      ) : null}
    </div>
  )
}

function PlanCard({
  plan,
  canUpdate,
  canApprove,
  onOpen,
  onMove
}: {
  plan: ContentPlan
  canUpdate: boolean
  canApprove: boolean
  onOpen: () => void
  onMove: (to: ContentStage) => void
}): React.JSX.Element {
  const to = nextStage(plan.stage)
  const xong = plan.tasks.filter((t) => t.status === 'DONE').length
  // Bước "Đã duyệt" là cổng riêng: thấy nút mà không có quyền thì chỉ tổ bực.
  const duocDay = canUpdate && to !== null && (to !== 'DA_DUYET' || canApprove)

  return (
    <div className="kb-card" onClick={onOpen} style={{ cursor: 'pointer' }}>
      <div className="top strong">{plan.title}</div>
      <div className="ln">
        {FORMAT_LABEL[plan.format]}
        {plan.channel ? ` · ${plan.channel.name}` : ''}
      </div>
      {plan.owner ? <div className="ln">Phụ trách: {plan.owner.name}</div> : null}
      {plan.plannedDate ? <div className="ln">Dự kiến đăng {dateVi(plan.plannedDate)}</div> : null}
      {plan.campaign ? <div className="ln muted">Chiến dịch: {plan.campaign.name}</div> : null}
      {plan.tasks.length > 0 ? (
        <div className="ln muted">
          Việc: {xong}/{plan.tasks.length} xong
        </div>
      ) : null}
      {duocDay && to ? (
        <button
          className="btn sec sm"
          style={{ marginTop: 6 }}
          onClick={(e) => {
            e.stopPropagation()
            onMove(to)
          }}
        >
          → {STAGES.find((s) => s.key === to)?.label}
        </button>
      ) : null}
    </div>
  )
}

/** Tab Lịch — gom theo ngày dự kiến đăng. Bài chưa đặt ngày xếp riêng cuối. */
function LichDang({ plans, onOpen }: { plans: ContentPlan[]; onOpen: (p: ContentPlan) => void }): React.JSX.Element {
  const { theoNgay, chuaDatNgay } = useMemo(() => {
    const m = new Map<string, ContentPlan[]>()
    const trong: ContentPlan[] = []
    for (const p of plans) {
      if (p.stage === 'HUY') continue
      if (!p.plannedDate) {
        trong.push(p)
        continue
      }
      const key = toISODate(new Date(p.plannedDate))
      if (!m.has(key)) m.set(key, [])
      m.get(key)!.push(p)
    }
    return { theoNgay: [...m.entries()].sort((a, b) => a[0].localeCompare(b[0])), chuaDatNgay: trong }
  }, [plans])

  return (
    <div>
      {theoNgay.map(([ngay, items]) => (
        <div className="card" key={ngay} style={{ marginBottom: 8 }}>
          <div className="strong" style={{ marginBottom: 6 }}>
            {dateVi(ngay)} — {items.length} bài
          </div>
          {items.map((p) => (
            <div
              key={p.id}
              className="ln"
              onClick={() => onOpen(p)}
              style={{ cursor: 'pointer', display: 'flex', gap: 8, alignItems: 'center' }}
            >
              <span className="dot" style={{ background: STAGES.find((s) => s.key === p.stage)?.fg ?? '#999' }} />
              <span>{p.title}</span>
              <span className="muted" style={{ marginLeft: 'auto' }}>
                {p.channel?.name ?? FORMAT_LABEL[p.format]}
                {p.owner ? ` · ${p.owner.name}` : ''}
              </span>
            </div>
          ))}
        </div>
      ))}

      {chuaDatNgay.length > 0 ? (
        <div className="card">
          <div className="muted" style={{ marginBottom: 6 }}>
            Chưa đặt ngày đăng ({chuaDatNgay.length})
          </div>
          {chuaDatNgay.map((p) => (
            <div key={p.id} className="ln" onClick={() => onOpen(p)} style={{ cursor: 'pointer' }}>
              {p.title}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}

function TaoBai({
  channels,
  campaigns,
  staff,
  meId,
  onClose,
  onDone
}: {
  channels: Array<{ id: string; name: string }>
  campaigns: Campaign[]
  staff: StaffUser[]
  meId: string | null
  onClose: () => void
  onDone: (p: ContentPlan) => void
}): React.JSX.Element {
  const { say, fail } = useToast()
  const [title, setTitle] = useState('')
  const [format, setFormat] = useState<ContentFormat>('VIDEO')
  const [channelId, setChannelId] = useState('')
  const [campaignId, setCampaignId] = useState('')
  const [ownerId, setOwnerId] = useState(meId ?? '')
  const [plannedDate, setPlannedDate] = useState('')
  const [brief, setBrief] = useState('')
  const [saving, setSaving] = useState(false)

  async function save() {
    if (title.trim().length < 2) {
      fail('Nhập tên bài')
      return
    }
    setSaving(true)
    try {
      onDone(
        await createContentPlan({
          title: title.trim(),
          format,
          channelId: channelId || null,
          campaignId: campaignId || null,
          ownerId: ownerId || null,
          plannedDate: plannedDate || null,
          brief: brief.trim() || null
        })
      )
    } catch (e) {
      fail(getApiErrorMessage(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      title="Bài mới"
      onClose={onClose}
      footer={
        <>
          <button className="btn sec" onClick={onClose}>
            Huỷ
          </button>
          <button className="btn" disabled={saving} onClick={() => void save()}>
            {saving ? 'Đang lưu…' : 'Tạo bài'}
          </button>
        </>
      }
    >
      <label className="lbl">Tên bài</label>
      <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="VD: Review khách tiêm filler cằm" />

      <label className="lbl">Dạng</label>
      <select className="input" value={format} onChange={(e) => setFormat(e.target.value as ContentFormat)}>
        {(Object.keys(FORMAT_LABEL) as ContentFormat[]).map((f) => (
          <option key={f} value={f}>
            {FORMAT_LABEL[f]}
          </option>
        ))}
      </select>

      <label className="lbl">Kênh đăng</label>
      <select className="input" value={channelId} onChange={(e) => setChannelId(e.target.value)}>
        <option value="">— chưa chọn —</option>
        {channels.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>

      <label className="lbl">Chiến dịch (để nối kết quả về phễu)</label>
      <select className="input" value={campaignId} onChange={(e) => setCampaignId(e.target.value)}>
        <option value="">— nội dung thường ngày —</option>
        {campaigns.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>

      <label className="lbl">Người phụ trách</label>
      <select className="input" value={ownerId} onChange={(e) => setOwnerId(e.target.value)}>
        <option value="">— chưa giao —</option>
        {staff.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>

      <label className="lbl">Ngày dự kiến đăng</label>
      <input className="input" type="date" value={plannedDate} onChange={(e) => setPlannedDate(e.target.value)} />

      <label className="lbl">Yêu cầu nội dung</label>
      <textarea className="input" rows={3} value={brief} onChange={(e) => setBrief(e.target.value)} placeholder="Nói gì, cho ai, chốt gì" />
    </Modal>
  )
}

function ChiTietBai({
  plan,
  staff,
  canUpdate,
  canApprove,
  canDelete,
  onClose,
  onChanged,
  onDeleted,
  onMove
}: {
  plan: ContentPlan
  staff: StaffUser[]
  canUpdate: boolean
  canApprove: boolean
  canDelete: boolean
  onClose: () => void
  onChanged: (p: ContentPlan) => void
  onDeleted: (id: string) => void
  onMove: (to: ContentStage) => void
}): React.JSX.Element {
  const { say, fail } = useToast()
  const [kind, setKind] = useState<ContentTaskKind>('QUAY')
  const [assigneeId, setAssigneeId] = useState('')
  const [dueDate, setDueDate] = useState('')
  const to = nextStage(plan.stage)
  const duocDay = canUpdate && to !== null && (to !== 'DA_DUYET' || canApprove)

  async function themViec() {
    try {
      await createContentTask({
        planId: plan.id,
        kind,
        assigneeId: assigneeId || null,
        dueDate: dueDate || null
      })
      const moi = await updateContentPlan(plan.id, {})
      onChanged(moi)
      setAssigneeId('')
      setDueDate('')
      fail('Đã thêm việc')
    } catch (e) {
      say(getApiErrorMessage(e))
    }
  }

  async function doiTrangThai(taskId: string, status: WorkTaskStatus) {
    try {
      await updateContentTask(taskId, { status })
      onChanged(await updateContentPlan(plan.id, {}))
    } catch (e) {
      fail(getApiErrorMessage(e))
    }
  }

  async function xoa() {
    if (!window.confirm(`Xoá bài "${plan.title}"? Không khôi phục được.`)) return
    try {
      await deleteContentPlan(plan.id)
      onDeleted(plan.id)
    } catch (e) {
      fail(getApiErrorMessage(e))
    }
  }

  return (
    <Modal
      title={plan.title}
      onClose={onClose}
      width={620}
      footer={
        <>
          {canDelete ? (
            <button className="btn sec" style={{ marginRight: 'auto' }} onClick={() => void xoa()}>
              Xoá bài
            </button>
          ) : null}
          {canUpdate && plan.stage !== 'HUY' && plan.stage !== 'DA_DANG' ? (
            <button className="btn sec" onClick={() => onMove('HUY')}>
              Huỷ bài
            </button>
          ) : null}
          {duocDay && to ? (
            <button className="btn" onClick={() => onMove(to)}>
              → {STAGES.find((s) => s.key === to)?.label}
            </button>
          ) : null}
        </>
      }
    >
      <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>
        {FORMAT_LABEL[plan.format]}
        {plan.channel ? ` · ${plan.channel.name}` : ''}
        {plan.owner ? ` · phụ trách ${plan.owner.name}` : ''}
        {plan.plannedDate ? ` · dự kiến ${dateVi(plan.plannedDate)}` : ''}
      </div>

      {plan.brief ? (
        <div className="card" style={{ marginBottom: 10 }}>
          <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
            Yêu cầu nội dung
          </div>
          {plan.brief}
        </div>
      ) : null}

      {plan.approvedBy ? (
        <div className="ln muted">
          Duyệt bởi {plan.approvedBy.name} · {dateVi(plan.approvedAt)}
        </div>
      ) : null}
      {plan.postUrl ? (
        <div className="ln">
          Link bài:{' '}
          <a href={plan.postUrl} target="_blank" rel="noreferrer">
            {plan.postUrl}
          </a>
        </div>
      ) : null}

      <div className="strong" style={{ marginTop: 12, marginBottom: 6 }}>
        Việc ({plan.tasks.filter((t) => t.status === 'DONE').length}/{plan.tasks.length} xong)
      </div>
      {plan.tasks.length === 0 ? <div className="muted">Chưa chia việc.</div> : null}
      {plan.tasks.map((t) => (
        <div key={t.id} className="ln" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span className="strong">{TASK_LABEL[t.kind]}</span>
          <span className="muted">{t.assignee?.name ?? 'chưa giao'}</span>
          {t.dueDate ? <span className="muted">hạn {dateVi(t.dueDate)}</span> : null}
          {canUpdate ? (
            <select
              className="input sm"
              style={{ marginLeft: 'auto', width: 130 }}
              value={t.status}
              onChange={(e) => void doiTrangThai(t.id, e.target.value as WorkTaskStatus)}
            >
              <option value="PENDING">Chưa làm</option>
              <option value="IN_PROGRESS">Đang làm</option>
              <option value="DONE">Xong</option>
              <option value="LATE">Trễ</option>
              <option value="CANCELLED">Bỏ</option>
            </select>
          ) : (
            <span style={{ marginLeft: 'auto' }}>{t.status}</span>
          )}
        </div>
      ))}

      {canUpdate ? (
        <div className="row" style={{ gap: 6, marginTop: 10, flexWrap: 'wrap' }}>
          <select className="input sm" style={{ width: 110 }} value={kind} onChange={(e) => setKind(e.target.value as ContentTaskKind)}>
            {TASK_KINDS.map((k) => (
              <option key={k} value={k}>
                {TASK_LABEL[k]}
              </option>
            ))}
          </select>
          <select className="input sm" style={{ width: 160 }} value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)}>
            <option value="">— giao cho —</option>
            {staff.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <input className="input sm" type="date" style={{ width: 150 }} value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          <button className="btn sec sm" onClick={() => void themViec()}>
            + Thêm việc
          </button>
        </div>
      ) : null}
    </Modal>
  )
}

/* ---- F38: TAB ĐO LƯỜNG ----
   Số liệu ở đây KHÔNG do ai gõ vào CRM. Cột "Đánh giá bài đăng" của trang tính
   đã phân bậc theo view (<5k / ≥5k / ≥10k / ≥50k) và F36 đã kéo về; màn này chỉ
   đọc lên. Nhờ vậy khối sáng tạo không phải nhập hai lần. */

const RATING_LABEL: Record<ContentRating, string> = {
  BAD: 'Chưa tốt <5k',
  AVERAGE: 'Trung bình ≥5k',
  GOOD: 'Tốt ≥10k',
  EXCELLENT: 'Xuất sắc ≥50k'
}
const RATING_FG: Record<ContentRating, string> = {
  BAD: '#b23b3b',
  AVERAGE: '#c98a00',
  GOOD: '#2f8f4e',
  EXCELLENT: '#1d6b38'
}
const RATING_KEYS: ContentRating[] = ['BAD', 'AVERAGE', 'GOOD', 'EXCELLENT']

function RatingBar({ ratings }: { ratings: Record<string, number> }): React.JSX.Element {
  const tong = RATING_KEYS.reduce((s, k) => s + (ratings[k] ?? 0), 0)
  if (tong === 0) return <span className="muted">chưa có kết quả</span>
  return (
    <span style={{ display: 'inline-flex', gap: 2, alignItems: 'center' }}>
      {RATING_KEYS.map((k) =>
        ratings[k] ? (
          <span
            key={k}
            title={`${RATING_LABEL[k]}: ${ratings[k]} bài`}
            style={{
              background: RATING_FG[k],
              color: '#fff',
              borderRadius: 3,
              padding: '0 5px',
              fontSize: 11
            }}
          >
            {ratings[k]}
          </span>
        ) : null
      )}
    </span>
  )
}

function DoLuong({ plans }: { plans: ContentPlan[] }): React.JSX.Element {
  const { can } = useAuth()
  const { say, fail } = useToast()
  const [data, setData] = useState<ContentMeasure | null>(null)
  const [people, setPeople] = useState<ContentPersonRow[]>([])
  const [loading, setLoading] = useState(true)
  const [ghep, setGhep] = useState<ContentUnmatchedEntry | null>(null)
  const xemTheoNguoi = can('content.view_team_output')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setData(await fetchContentMeasure())
      if (xemTheoNguoi) setPeople(await fetchContentByPerson())
    } catch (e) {
      fail(getApiErrorMessage(e))
    } finally {
      setLoading(false)
    }
  }, [xemTheoNguoi, fail])

  useEffect(() => {
    void load()
  }, [load])

  if (loading) return <Empty>Đang tải…</Empty>
  if (!data) return <Empty>Chưa có số liệu.</Empty>

  const t = data.tong
  const tyLeDang = t.keHoach > 0 ? Math.round((t.daDang / t.keHoach) * 100) : 0

  return (
    <div>
      {data.canhBao.thieuLink ? (
        <div className="card" style={{ marginBottom: 10, borderLeft: '3px solid #c98a00' }}>
          <b>Còn {data.canhBao.nguonKeo} trang tính chạy đường KÉO.</b>{' '}
          <span className="muted">
            Đường kéo không lấy được địa chỉ trong ô “Link hoàn thành” (chỉ còn chữ “Link”), nên bài của những
            người đó không tự ghép được. Chuyển sang đường ĐẨY ở màn “Báo cáo công việc (trang tính)”.
          </span>
        </div>
      ) : null}

      <div className="grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)', marginBottom: 10 }}>
        <div className="card">
          <div className="muted" style={{ fontSize: 11.5 }}>KẾ HOẠCH</div>
          <div style={{ fontSize: 26, fontWeight: 700 }}>{t.keHoach}</div>
        </div>
        <div className="card">
          <div className="muted" style={{ fontSize: 11.5 }}>ĐÃ ĐĂNG</div>
          <div style={{ fontSize: 26, fontWeight: 700 }}>
            {t.daDang} <span className="muted" style={{ fontSize: 13 }}>{tyLeDang}%</span>
          </div>
        </div>
        <div className="card">
          <div className="muted" style={{ fontSize: 11.5 }}>CÓ KẾT QUẢ TỪ TRANG TÍNH</div>
          <div style={{ fontSize: 26, fontWeight: 700 }}>{t.coKetQua}</div>
        </div>
        <div className="card">
          <div className="muted" style={{ fontSize: 11.5 }}>BÀI TỐT (≥10k view)</div>
          <div style={{ fontSize: 26, fontWeight: 700 }}>
            {(t.ratings.GOOD ?? 0) + (t.ratings.EXCELLENT ?? 0)}
          </div>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 10 }}>
        <div className="sec-title">Theo kênh</div>
        <table>
          <thead>
            <tr>
              <th>Kênh</th>
              <th>Kế hoạch</th>
              <th>Đã đăng</th>
              <th>Phân bố đánh giá</th>
            </tr>
          </thead>
          <tbody>
            {data.theoKenh.map((k) => (
              <tr key={k.id}>
                <td><b>{k.name}</b></td>
                <td>{k.keHoach}</td>
                <td>{k.daDang}</td>
                <td><RatingBar ratings={k.ratings} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {xemTheoNguoi && people.length > 0 ? (
        <div className="card" style={{ marginBottom: 10 }}>
          <div className="sec-title">Theo người</div>
          <table>
            <thead>
              <tr>
                <th>Người</th>
                <th>Bài có kết quả</th>
                <th>Bài tốt</th>
                <th>Phân bố</th>
              </tr>
            </thead>
            <tbody>
              {people.map((p) => (
                <tr key={p.id}>
                  <td><b>{p.name}</b></td>
                  <td>{p.soBai}</td>
                  <td>{p.baiTot}</td>
                  <td><RatingBar ratings={p.ratings} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <div className="card" style={{ marginBottom: 10 }}>
        <div className="sec-title">Bài đã có kết quả ({data.coKetQua.length})</div>
        {data.coKetQua.length === 0 ? (
          <div className="muted">
            Chưa bài nào ghép được với trang tính. Bài phải có link, và link đó phải xuất hiện ở cột “Link hoàn
            thành” trong trang tính của người làm.
          </div>
        ) : (
          <table>
            <tbody>
              {data.coKetQua.map((r) => (
                <tr key={r.id}>
                  <td>
                    <b>{r.title}</b>
                    <div className="muted" style={{ fontSize: 11.5 }}>
                      {r.channel?.name ?? '—'}
                      {r.owner ? ` · ${r.owner.name}` : ''}
                      {r.campaign ? ` · ${r.campaign.name}` : ''}
                    </div>
                  </td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {r.rating ? (
                      <span style={{ color: RATING_FG[r.rating], fontWeight: 600 }}>{RATING_LABEL[r.rating]}</span>
                    ) : null}
                  </td>
                  <td className="muted" style={{ fontSize: 11.5, whiteSpace: 'nowrap' }}>
                    trang tính {dateVi(r.ngayBaoCao)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {data.chuaCoKetQua.length > 0 ? (
        <div className="card" style={{ marginBottom: 10 }}>
          <div className="sec-title">Đã đăng nhưng trang tính chưa báo ({data.chuaCoKetQua.length})</div>
          {data.chuaCoKetQua.map((r) => (
            <div key={r.id} className="ln">
              {r.title}
              <span className="muted"> · {r.channel?.name ?? '—'}</span>
            </div>
          ))}
        </div>
      ) : null}

      {data.chuaGhep.length > 0 ? (
        <div className="card">
          <div className="sec-title">Dòng trang tính chưa ứng với bài nào ({data.chuaGhep.length})</div>
          <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
            Thường là do link rút gọn, hoặc bài chưa được dán link vào CRM. Ghép tay để kết quả về đúng bài.
          </div>
          <table>
            <tbody>
              {data.chuaGhep.map((e) => (
                <tr key={e.id}>
                  <td>
                    <b>{e.taskName ?? '(không tên)'}</b>
                    <div className="muted" style={{ fontSize: 11.5 }}>
                      {e.user.name} · {e.channel ?? '—'} · {dateVi(e.workDate)}
                    </div>
                  </td>
                  <td style={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {e.linkUrl ? (
                      <a href={e.linkUrl} target="_blank" rel="noreferrer" className="muted" style={{ fontSize: 11.5 }}>
                        {e.linkUrl}
                      </a>
                    ) : null}
                  </td>
                  <td>
                    <button className="btn sec sm" onClick={() => setGhep(e)}>
                      Ghép vào bài…
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {ghep ? (
        <GhepTay
          entry={ghep}
          plans={plans}
          onClose={() => setGhep(null)}
          onDone={() => {
            setGhep(null)
            say('Đã ghép')
            void load()
          }}
        />
      ) : null}
    </div>
  )
}

/** Chọn bài để ghép tay. Gợi ý theo tên việc, nhưng người bấm mới quyết. */
function GhepTay({
  entry,
  plans,
  onClose,
  onDone
}: {
  entry: ContentUnmatchedEntry
  plans: ContentPlan[]
  onClose: () => void
  onDone: () => void
}): React.JSX.Element {
  const { fail } = useToast()
  const [q, setQ] = useState(entry.taskName ?? '')
  const [saving, setSaving] = useState(false)

  const ungVien = useMemo(() => {
    const tu = q.toLowerCase().split(/\s+/).filter((w) => w.length > 2)
    return plans
      .filter((p) => p.stage !== 'HUY')
      .map((p) => ({ p, diem: tu.filter((w) => p.title.toLowerCase().includes(w)).length }))
      .sort((a, b) => b.diem - a.diem || a.p.title.localeCompare(b.p.title))
      .slice(0, 12)
  }, [plans, q])

  async function ghep(planId: string) {
    setSaving(true)
    try {
      await linkEntryToPlan(planId, entry.id)
      onDone()
    } catch (e) {
      fail(getApiErrorMessage(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal title="Ghép dòng trang tính vào bài" onClose={onClose} width={560}>
      <div className="card" style={{ marginBottom: 10 }}>
        <b>{entry.taskName ?? '(không tên)'}</b>
        <div className="muted" style={{ fontSize: 12 }}>
          {entry.user.name} · {entry.channel ?? '—'} · {dateVi(entry.workDate)}
        </div>
        {entry.linkUrl ? (
          <div className="muted" style={{ fontSize: 11.5, wordBreak: 'break-all' }}>{entry.linkUrl}</div>
        ) : null}
      </div>

      <label className="lbl">Tìm bài</label>
      <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Gõ tên bài" />

      <div style={{ marginTop: 8 }}>
        {ungVien.length === 0 ? <div className="muted">Không có bài nào.</div> : null}
        {ungVien.map(({ p, diem }) => (
          <div key={p.id} className="ln" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span>
              {p.title}
              {diem > 0 ? <span className="muted" style={{ fontSize: 11 }}> · có thể là bài này</span> : null}
            </span>
            <button className="btn sec sm" style={{ marginLeft: 'auto' }} disabled={saving} onClick={() => void ghep(p.id)}>
              Ghép
            </button>
          </div>
        ))}
      </div>
    </Modal>
  )
}
