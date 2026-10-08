import React, { useCallback, useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useClinic } from '../lib/clinic-context'
import {
  checkCustomerDuplicates,
  createCustomer,
  fetchCustomers,
  fetchStaff,
  getApiErrorMessage,
  type DuplicateRef
} from '../lib/api'
import { useAuth } from '../lib/auth-context'
import { relativeVi } from '../lib/format'
import { Empty, Modal, Tag, useToast } from '../components/ui'
import type { CustomerListItem, StaffUser } from '../lib/types'

const PAGE_SIZE = 50

/* KHÁCH HÀNG — danh sách, lọc theo giai đoạn phễu và người phụ trách.
   Telesale chỉ nhận về khách của mình do backend lọc theo phạm vi OWN, nên ở
   đây không cần (và không được) tự lọc lại theo user. */

export default function Customers(): React.JSX.Element {
  const { can } = useAuth()
  const { fail } = useToast()
  const navigate = useNavigate()
  const clinic = useClinic()
  const [searchParams] = useSearchParams()

  const [query, setQuery] = useState('')
  const [stage, setStage] = useState(searchParams.get('stage') ?? '')
  const [assignedToId, setAssignedToId] = useState('')
  const [items, setItems] = useState<CustomerListItem[]>([])
  const [total, setTotal] = useState(0)
  const [staff, setStaff] = useState<StaffUser[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [nextOffset, setNextOffset] = useState<number | null>(null)
  const [creating, setCreating] = useState(false)

  // T3: tải từng trang PAGE_SIZE khách, bấm "Tải thêm" để lấy trang kế tiếp.
  const filters = useCallback(
    () => ({
      q: query || undefined,
      stage: stage || undefined,
      assignedToId: assignedToId || undefined
    }),
    [query, stage, assignedToId]
  )

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await fetchCustomers({ ...filters(), limit: PAGE_SIZE })
      setItems(data.items)
      setTotal(data.total)
      setNextOffset(data.nextOffset ?? null)
    } catch (err) {
      fail(getApiErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }, [filters, fail])

  const loadMore = async (): Promise<void> => {
    if (nextOffset == null) return
    setLoadingMore(true)
    try {
      const data = await fetchCustomers({ ...filters(), limit: PAGE_SIZE, offset: nextOffset })
      setItems((prev) => [...prev, ...data.items.filter((c) => !prev.some((p) => p.id === c.id))])
      setTotal(data.total)
      setNextOffset(data.nextOffset ?? null)
    } catch (err) {
      fail(getApiErrorMessage(err))
    } finally {
      setLoadingMore(false)
    }
  }

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
          <option value="">Mọi bước</option>
          {clinic.stages.map((s) => (
            <option key={s.key} value={s.key}>
              {s.label}
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
          {items.length < total ? `${items.length} / ${total} khách` : `${total} khách`}
        </span>
        <span style={{ marginLeft: 'auto' }} />
        <button className="btn sec" onClick={() => navigate('/bang-buoc-khach')}>
          Bảng kéo thả
        </button>
        {can('customer.import') ? (
          <button className="btn sec" onClick={() => navigate('/nhap-khach')}>
            Nhập từ Excel
          </button>
        ) : null}
        {can('customer.merge') ? (
          <button className="btn sec" onClick={() => navigate('/khach-hang/trung-lap')}>
            Gộp hồ sơ trùng
          </button>
        ) : null}
        {can('customer.create') ? (
          <button className="btn" onClick={() => setCreating(true)}>
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
                    <Tag style={clinic.stageStyle(c.stage)} />
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
        {!loading && nextOffset != null ? (
          <div style={{ padding: 12, textAlign: 'center' }}>
            <button className="btn sec" onClick={() => void loadMore()} disabled={loadingMore}>
              {loadingMore ? 'Đang tải…' : `Tải thêm (còn ${total - items.length} khách)`}
            </button>
          </div>
        ) : null}
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
  const [dups, setDups] = useState<{ phoneMatches: DuplicateRef[]; similarNames: DuplicateRef[] }>({
    phoneMatches: [],
    similarNames: []
  })

  // B17: kiểm tra trùng khi đang gõ (chờ 400ms sau lần gõ cuối).
  useEffect(() => {
    const n = name.trim()
    const p = phone.trim()
    if (n.length < 3 && p.replace(/\D/g, '').length < 8) {
      setDups({ phoneMatches: [], similarNames: [] })
      return
    }
    const timer = window.setTimeout(() => {
      checkCustomerDuplicates({ name: n || undefined, phone: p || undefined })
        .then(setDups)
        .catch(() => undefined)
    }, 400)
    return () => window.clearTimeout(timer)
  }, [name, phone])

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
      {dups.phoneMatches.length ? (
        <div className="alert dg">
          Số điện thoại này đã có hồ sơ:{' '}
          {dups.phoneMatches.map((d) => `${d.name} (${d.code})`).join(', ')}. Mở hồ sơ cũ thay vì tạo mới.
        </div>
      ) : null}
      {dups.similarNames.length ? (
        <div className="alert wr">
          Có khách tên gần giống: {dups.similarNames.map((d) => `${d.name} (${d.code}${d.phone ? `, ${d.phone}` : ''})`).join('; ')}.
          Kiểm tra lại để tránh gõ sai tên hoặc tạo trùng hồ sơ.
        </div>
      ) : null}
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
