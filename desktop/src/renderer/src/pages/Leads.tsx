import React, { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  assignLead,
  convertLead,
  createLead,
  fetchCampaigns,
  fetchChannels,
  fetchLeads,
  fetchStaff,
  getApiErrorMessage,
  saveCampaignCost
} from '../lib/api'
import { useAuth } from '../lib/auth-context'
import { relativeVi, toISODate, vnd } from '../lib/format'
import { LEAD_STAGE, tagStyleOf } from '../lib/ui'
import { Empty, Modal, Tag, useToast } from '../components/ui'
import type { Campaign, Lead, StaffUser } from '../lib/types'

/* LEAD & CHIẾN DỊCH — hai khối: hiệu quả chiến dịch (CPL/ROAS) và danh sách lead.
   Nút "Chuyển thành khách" gọi API convert; nếu SĐT đã có khách thì backend GỘP
   vào hồ sơ cũ thay vì tạo bản trùng, và trả về cờ merged để báo cho người dùng. */

export default function Leads(): React.JSX.Element {
  const { can } = useAuth()
  const { say, fail } = useToast()
  const navigate = useNavigate()

  const [leads, setLeads] = useState<Lead[]>([])
  const [campaigns, setCampaigns] = useState<Campaign[]>([])
  const [staff, setStaff] = useState<StaffUser[]>([])
  const [stage, setStage] = useState('')
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [costFor, setCostFor] = useState<Campaign | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [rows, camps] = await Promise.all([
        fetchLeads({ stage: stage || undefined, q: query || undefined }),
        fetchCampaigns().catch(() => [])
      ])
      setLeads(rows)
      setCampaigns(camps)
    } catch (err) {
      fail(getApiErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }, [stage, query, fail])

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 250)
    return () => window.clearTimeout(timer)
  }, [load])

  useEffect(() => {
    if (can('hr.read')) fetchStaff().then(setStaff).catch(() => undefined)
  }, [can])

  const convert = useCallback(
    async (lead: Lead) => {
      try {
        const result = await convertLead(lead.id)
        say(
          result.merged
            ? `Số điện thoại đã có hồ sơ — đã gộp lead vào khách ${result.customer.code}.`
            : `Đã tạo khách ${result.customer.code}.`
        )
        navigate(`/khach-hang/${result.customer.id}`)
      } catch (err) {
        fail(getApiErrorMessage(err))
      }
    },
    [say, fail, navigate]
  )

  const totalSpent = campaigns.reduce((s, c) => s + c.spentAmount, 0)
  const totalLeads = campaigns.reduce((s, c) => s + c.leadCount, 0)

  return (
    <>
      <div className="grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)', marginBottom: 12 }}>
        <div className="kpi">
          <div className="lab">Lead đang theo</div>
          <div className="val">{leads.filter((l) => !['WON', 'LOST', 'SPAM'].includes(l.stage)).length}</div>
        </div>
        <div className="kpi">
          <div className="lab">Chưa phân công</div>
          <div className="val" style={{ color: leads.some((l) => !l.assignedTo) ? 'var(--warn)' : undefined }}>
            {leads.filter((l) => !l.assignedTo && l.stage === 'NEW').length}
          </div>
        </div>
        <div className="kpi">
          <div className="lab">Chi phí quảng cáo</div>
          <div className="val">{vnd(totalSpent)}</div>
        </div>
        <div className="kpi">
          <div className="lab">Chi phí mỗi lead (CPL)</div>
          <div className="val">{totalLeads ? vnd(Math.round(totalSpent / totalLeads)) : '—'}</div>
        </div>
      </div>

      {campaigns.length ? (
        <div className="card" style={{ padding: 0, overflow: 'hidden', marginBottom: 12 }}>
          <div className="sec-title" style={{ padding: '12px 14px 0' }}>
            Hiệu quả chiến dịch
          </div>
          <table>
            <thead>
              <tr>
                <th>Chiến dịch</th>
                <th>Kênh</th>
                <th>Lead</th>
                <th>Thành khách</th>
                <th>Chi phí</th>
                <th>CPL</th>
              </tr>
            </thead>
            <tbody>
              {campaigns.map((c) => (
                <tr key={c.id}>
                  <td>
                    <b>{c.name}</b>
                    <div className="muted" style={{ fontSize: 11.5 }}>
                      {c.code}
                    </div>
                  </td>
                  <td>
                    <span className="tag out">{c.channel?.name ?? '—'}</span>
                  </td>
                  <td>{c.leadCount}</td>
                  <td>{c.customerCount}</td>
                  <td>{vnd(c.spentAmount)}</td>
                  <td>{c.leadCount ? vnd(Math.round(c.spentAmount / c.leadCount)) : '—'}</td>
                  <td>
                    {can('lead.update') ? (
                      <button className="btn sec sm" onClick={() => setCostFor(c)}>
                        + Chi phí
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <div className="row" style={{ flexWrap: 'wrap', marginBottom: 12 }}>
        <input
          className="input"
          style={{ width: 240 }}
          placeholder="Tìm lead theo tên / số điện thoại"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select className="input" style={{ width: 'auto' }} value={stage} onChange={(e) => setStage(e.target.value)}>
          <option value="">Mọi trạng thái</option>
          {Object.entries(LEAD_STAGE).map(([key, s]) => (
            <option key={key} value={key}>
              {s.t}
            </option>
          ))}
        </select>
        {can('lead.create') ? (
          <button className="btn" style={{ marginLeft: 'auto' }} onClick={() => setCreating(true)}>
            + Thêm lead
          </button>
        ) : null}
      </div>

      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        {loading ? (
          <Empty>Đang tải…</Empty>
        ) : leads.length === 0 ? (
          <Empty>Chưa có lead nào khớp bộ lọc.</Empty>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Họ tên</th>
                <th>Số điện thoại</th>
                <th>Quan tâm</th>
                <th>Nguồn</th>
                <th>Trạng thái</th>
                <th>Phụ trách</th>
                <th>Tạo lúc</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {leads.map((l) => (
                <tr key={l.id}>
                  <td>
                    <b>{l.name}</b>
                  </td>
                  <td>{l.phone ?? '—'}</td>
                  <td>{l.interest ?? '—'}</td>
                  <td>
                    <span className="tag out">{l.channel?.name ?? '—'}</span>
                  </td>
                  <td>
                    <Tag style={tagStyleOf(LEAD_STAGE, l.stage)} />
                    {l.lostReason ? (
                      <div className="muted" style={{ fontSize: 11.5 }}>
                        {l.lostReason}
                      </div>
                    ) : null}
                  </td>
                  <td>
                    {can('lead.update') && staff.length ? (
                      <select
                        className="input"
                        style={{ width: 150 }}
                        value={l.assignedTo?.id ?? ''}
                        onChange={async (e) => {
                          if (!e.target.value) return
                          try {
                            await assignLead(l.id, e.target.value)
                            say('Đã chia lead.')
                            void load()
                          } catch (err) {
                            fail(getApiErrorMessage(err))
                          }
                        }}
                      >
                        <option value="">— chưa chia —</option>
                        {staff.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.name}
                          </option>
                        ))}
                      </select>
                    ) : (
                      (l.assignedTo?.name ?? '—')
                    )}
                  </td>
                  <td className="muted">{relativeVi(l.createdAt)}</td>
                  <td>
                    {can('customer.create') && !['WON', 'SPAM'].includes(l.stage) ? (
                      <button className="btn sm" onClick={() => void convert(l)}>
                        Thành khách
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {costFor ? (
        <CostModal
          campaign={costFor}
          onClose={() => setCostFor(null)}
          onDone={() => {
            setCostFor(null)
            void load()
          }}
        />
      ) : null}

      {creating ? (
        <NewLeadModal
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false)
            void load()
          }}
        />
      ) : null}
    </>
  )
}

function NewLeadModal({
  onClose,
  onCreated
}: {
  onClose: () => void
  onCreated: () => void
}): React.JSX.Element {
  const { say, fail } = useToast()
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [interest, setInterest] = useState('')
  const [channelId, setChannelId] = useState('')
  const [channels, setChannels] = useState<Array<{ id: string; name: string }>>([])
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    fetchChannels().then(setChannels).catch(() => undefined)
  }, [])

  const submit = async (): Promise<void> => {
    if (name.trim().length < 2) {
      fail('Nhập tên lead.')
      return
    }
    setSaving(true)
    try {
      await createLead({
        name: name.trim(),
        phone: phone.trim() || null,
        interest: interest.trim() || null,
        channelId: channelId || null
      })
      say('Đã thêm lead.')
      onCreated()
    } catch (err) {
      fail(getApiErrorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      title="Thêm lead"
      onClose={onClose}
      footer={
        <>
          <button className="btn sec" onClick={onClose}>
            Huỷ
          </button>
          <button className="btn" onClick={() => void submit()} disabled={saving}>
            {saving ? 'Đang lưu…' : 'Thêm'}
          </button>
        </>
      }
    >
      <div className="field">
        <label>Họ và tên *</label>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="field">
        <label>Số điện thoại</label>
        <input className="input" value={phone} onChange={(e) => setPhone(e.target.value)} />
      </div>
      <div className="field">
        <label>Dịch vụ quan tâm</label>
        <input className="input" value={interest} onChange={(e) => setInterest(e.target.value)} />
      </div>
      <div className="field">
        <label>Nguồn</label>
        <select className="input" value={channelId} onChange={(e) => setChannelId(e.target.value)}>
          <option value="">— Chọn nguồn —</option>
          {channels.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>
    </Modal>
  )
}

/**
 * Nhập chi phí quảng cáo theo NGÀY cho một chiến dịch.
 *
 * Đây là nguồn số liệu cho ROAS và CPL trên Dashboard. Nhập tay chạy được ngay
 * hôm nay; khi nối được Facebook Ads API và TikTok Ads API thì số tự về và màn
 * này chỉ còn dùng để sửa tay khi cần.
 */
function CostModal({
  campaign,
  onClose,
  onDone
}: {
  campaign: Campaign
  onClose: () => void
  onDone: () => void
}): React.JSX.Element {
  const { say, fail } = useToast()
  const [date, setDate] = useState(toISODate(new Date()))
  const [amount, setAmount] = useState(0)
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)

  const submit = async (): Promise<void> => {
    if (amount <= 0) {
      fail('Nhập số tiền chi trong ngày.')
      return
    }
    setSaving(true)
    try {
      await saveCampaignCost(campaign.id, { date, amount, note: note || undefined })
      say(`Đã ghi chi phí ${vnd(amount)} cho ngày ${date}.`)
      onDone()
    } catch (err) {
      fail(getApiErrorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      title={`Chi phí quảng cáo — ${campaign.name}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn sec" onClick={onClose}>
            Huỷ
          </button>
          <button className="btn" onClick={() => void submit()} disabled={saving}>
            {saving ? 'Đang lưu…' : 'Ghi chi phí'}
          </button>
        </>
      }
    >
      <div className="alert wr">
        Nhập lại cùng một ngày sẽ GHI ĐÈ số cũ, không cộng dồn — để sửa sai không phải xoá.
      </div>
      <div className="row" style={{ gap: 10 }}>
        <div className="field" style={{ flex: 1 }}>
          <label>Ngày</label>
          <input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        <div className="field" style={{ flex: 1 }}>
          <label>Số tiền chi (đồng)</label>
          <input
            className="input"
            type="number"
            value={amount}
            onChange={(e) => setAmount(Number(e.target.value))}
          />
        </div>
      </div>
      <div className="field">
        <label>Ghi chú</label>
        <input className="input" value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
      <div className="muted" style={{ fontSize: 11.5 }}>
        Chi phí này chảy thẳng vào ROAS và CPL trên Dashboard và Báo cáo marketing.
      </div>
    </Modal>
  )
}
