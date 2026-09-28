import React, { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { createCustomer, fetchCustomers, fetchStaff, getApiErrorMessage } from '../lib/api'
import { useAuth } from '../lib/auth-context'
import { relativeVi } from '../lib/format'
import { STAGES, stageStyle } from '../lib/ui'
import { Empty, Modal, Tag, useToast } from '../components/ui'
import type { CustomerListItem, StaffUser } from '../lib/types'

/* KHÁCH HÀNG — danh sách, lọc theo giai đoạn phễu và người phụ trách.
   Telesale chỉ nhận về khách của mình do backend lọc theo phạm vi OWN, nên ở
   đây không cần (và không được) tự lọc lại theo user. */

export default function Customers(): React.JSX.Element {
  const { can } = useAuth()
  const { fail } = useToast()
  const navigate = useNavigate()

  const [query, setQuery] = useState('')
  const [stage, setStage] = useState('')
  const [assignedToId, setAssignedToId] = useState('')
  const [items, setItems] = useState<CustomerListItem[]>([])
  const [total, setTotal] = useState(0)
  const [staff, setStaff] = useState<StaffUser[]>([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await fetchCustomers({
        q: query || undefined,
        stage: stage || undefined,
        assignedToId: assignedToId || undefined,
        limit: 200
      })
      setItems(data.items)
      setTotal(data.total)
    } catch (err) {
      fail(getApiErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }, [query, stage, assignedToId, fail])

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 250)
    return () => window.clearTimeout(timer)
  }, [load])

  useEffect(() => {
    if (can('hr.read')) fetchStaff().then(setStaff).catch(() => undefined)
  }, [can])

  return (
    <>
      <div className="row" style={{ flexWrap: 'wrap', marginBottom: 12 }}>
        <input
          className="input"
          style={{ width: 260 }}
          placeholder="Tìm theo tên, số điện thoại hoặc mã KH"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select className="input" style={{ width: 'auto' }} value={stage} onChange={(e) => setStage(e.target.value)}>
          <option value="">Mọi giai đoạn</option>
          {Object.entries(STAGES).map(([key, s]) => (
            <option key={key} value={key}>
              {s.t}
            </option>
          ))}
        </select>
        {staff.length ? (
          <select
            className="input"
            style={{ width: 'auto' }}
            value={assignedToId}
            onChange={(e) => setAssignedToId(e.target.value)}
          >
            <option value="">Mọi người phụ trách</option>
            {staff.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        ) : null}
        <span className="muted" style={{ fontSize: 12.5 }}>
          {total} khách
        </span>
        {can('customer.create') ? (
          <button className="btn" style={{ marginLeft: 'auto' }} onClick={() => setCreating(true)}>
            + Thêm khách
          </button>
        ) : null}
      </div>

      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        {loading ? (
          <Empty>Đang tải danh sách khách…</Empty>
        ) : items.length === 0 ? (
          <Empty>
            Không tìm thấy khách nào khớp bộ lọc.
            <br />
            Thử xoá bớt điều kiện lọc hoặc tìm bằng số điện thoại.
          </Empty>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Mã KH</th>
                <th>Họ tên</th>
                <th>Số điện thoại</th>
                <th>Giai đoạn</th>
                <th>Dịch vụ quan tâm</th>
                <th>Nguồn</th>
                <th>Tư vấn viên</th>
                <th>Chạm gần nhất</th>
              </tr>
            </thead>
            <tbody>
              {items.map((c) => (
                <tr key={c.id} className="clickable" onClick={() => navigate(`/khach-hang/${c.id}`)}>
                  <td className="muted">{c.code}</td>
                  <td>
                    <b>{c.name}</b>
                  </td>
                  <td>{c.phone ?? '—'}</td>
                  <td>
                    <Tag style={stageStyle(c.stage)} />
                  </td>
                  <td>{c.interest.length ? c.interest.join(', ') : <span className="muted">—</span>}</td>
                  <td>
                    <span className="tag out">{c.channel?.name ?? 'Không rõ'}</span>
                  </td>
                  <td>{c.assignedTo?.name ?? <span className="muted">— chưa gán —</span>}</td>
                  <td className="muted">{relativeVi(c.lastContactAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {creating ? (
        <NewCustomerModal
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false)
            navigate(`/khach-hang/${id}`)
          }}
        />
      ) : null}
    </>
  )
}

function NewCustomerModal({
  onClose,
  onCreated
}: {
  onClose: () => void
  onCreated: (id: string) => void
}): React.JSX.Element {
  const { fail, say } = useToast()
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [interest, setInterest] = useState('')
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)

  const submit = async (): Promise<void> => {
    if (name.trim().length < 2) {
      fail('Nhập họ tên khách.')
      return
    }
    setSaving(true)
    try {
      const customer = await createCustomer({
        name: name.trim(),
        phone: phone.trim() || null,
        interest: interest.trim() ? interest.split(',').map((s) => s.trim()) : undefined,
        note: note.trim() || null
      })
      say(`Đã tạo khách ${customer.code}.`)
      onCreated(customer.id)
    } catch (err) {
      // Trùng số điện thoại là lỗi hay gặp nhất — backend trả 409 kèm tên khách cũ.
      fail(getApiErrorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      title="Thêm khách hàng"
      onClose={onClose}
      footer={
        <>
          <button className="btn sec" onClick={onClose}>
            Huỷ
          </button>
          <button className="btn" onClick={() => void submit()} disabled={saving}>
            {saving ? 'Đang lưu…' : 'Tạo khách'}
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
        <input className="input" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="09xxxxxxxx" />
      </div>
      <div className="field">
        <label>Dịch vụ quan tâm (phân tách bằng dấu phẩy)</label>
        <input
          className="input"
          value={interest}
          onChange={(e) => setInterest(e.target.value)}
          placeholder="Nâng mũi cấu trúc, Cắt mí trên"
        />
      </div>
      <div className="field">
        <label>Ghi chú</label>
        <textarea className="input" rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
    </Modal>
  )
}
