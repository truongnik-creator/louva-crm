import React, { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  fetchDuplicateGroups,
  getApiErrorMessage,
  mergeCustomers,
  type DuplicateGroupCustomer
} from '../lib/api'
import { dateVi } from '../lib/format'
import { stageStyle } from '../lib/ui'
import { Empty, Tag, useToast } from '../components/ui'

/* GỘP HỒ SƠ TRÙNG (B17).
   Nhóm các hồ sơ có cùng số điện thoại sau chuẩn hoá (+84, dấu cách, dấu chấm
   đều quy về 0xxxxxxxxx). Chọn một hồ sơ giữ lại, các hồ sơ còn lại được gộp
   vào: lịch hẹn, hợp đồng, phiếu thu, tin nhắn, bệnh án, ảnh chuyển sang hồ sơ
   giữ lại; hồ sơ bị gộp chỉ bị ẩn, không xoá. Mọi lần gộp đều ghi nhật ký. */

interface GroupState {
  key: string | null
  customers: DuplicateGroupCustomer[]
  primaryId: string
  selected: string[]
  reason: string
  merging: boolean
}

const PAGE_SIZE = 30

export default function CustomerDuplicates(): React.JSX.Element {
  const { say, fail } = useToast()
  const navigate = useNavigate()
  const [groups, setGroups] = useState<GroupState[]>([])
  const [loading, setLoading] = useState(true)
  const [nextOffset, setNextOffset] = useState<number | null>(null)

  const toState = (g: { key: string | null; customers: DuplicateGroupCustomer[] }): GroupState => ({
    key: g.key,
    customers: g.customers,
    // Mặc định giữ hồ sơ tạo sớm nhất (backend đã sắp theo ngày tạo).
    primaryId: g.customers[0]?.id ?? '',
    selected: g.customers.slice(1).map((c) => c.id),
    reason: '',
    merging: false
  })

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await fetchDuplicateGroups({ limit: PAGE_SIZE })
      setGroups(data.groups.map(toState))
      setNextOffset(data.nextOffset)
    } catch (err) {
      fail(getApiErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }, [fail])

  useEffect(() => {
    void load()
  }, [load])

  const loadMore = async (): Promise<void> => {
    if (nextOffset == null) return
    try {
      const data = await fetchDuplicateGroups({ limit: PAGE_SIZE, offset: nextOffset })
      setGroups((prev) => [...prev, ...data.groups.map(toState)])
      setNextOffset(data.nextOffset)
    } catch (err) {
      fail(getApiErrorMessage(err))
    }
  }

  const patch = (index: number, change: Partial<GroupState>): void =>
    setGroups((prev) => prev.map((g, i) => (i === index ? { ...g, ...change } : g)))

  const merge = async (index: number): Promise<void> => {
    const g = groups[index]
    const duplicateIds = g.selected.filter((id) => id !== g.primaryId)
    if (!duplicateIds.length) {
      fail('Chọn ít nhất một hồ sơ cần gộp.')
      return
    }
    if (g.reason.trim().length < 5) {
      fail('Nhập lý do gộp (tối thiểu 5 ký tự).')
      return
    }
    const primary = g.customers.find((c) => c.id === g.primaryId)
    const ok = window.confirm(
      `Gộp ${duplicateIds.length} hồ sơ vào ${primary?.name} (${primary?.code})?\n` +
        'Lịch sử được chuyển sang hồ sơ giữ lại, hồ sơ bị gộp sẽ bị ẩn. Thao tác này được ghi nhật ký.'
    )
    if (!ok) return
    patch(index, { merging: true })
    try {
      await mergeCustomers({ primaryId: g.primaryId, duplicateIds, reason: g.reason.trim() })
      say(`Đã gộp vào hồ sơ ${primary?.code}.`)
      setGroups((prev) => prev.filter((_, i) => i !== index))
    } catch (err) {
      fail(getApiErrorMessage(err))
      patch(index, { merging: false })
    }
  }

  return (
    <>
      <div className="row" style={{ marginBottom: 12, flexWrap: 'wrap' }}>
        <button className="btn sec" onClick={() => navigate('/khach-hang')}>
          ← Danh sách khách
        </button>
        <span className="muted" style={{ fontSize: 12.5 }}>
          Các nhóm hồ sơ có cùng số điện thoại. Chọn hồ sơ giữ lại, tick hồ sơ cần gộp, ghi lý do rồi bấm Gộp.
        </span>
      </div>

      {loading ? (
        <div className="card">
          <Empty>Đang tìm hồ sơ trùng…</Empty>
        </div>
      ) : groups.length === 0 ? (
        <div className="card">
          <Empty>Không có hồ sơ nào trùng số điện thoại.</Empty>
        </div>
      ) : (
        groups.map((g, index) => (
          <div className="card" key={g.key ?? index} style={{ marginBottom: 12 }}>
            <div className="sec-title">
              SĐT {g.key ?? 'không rõ'} · {g.customers.length} hồ sơ
            </div>
            <table>
              <thead>
                <tr>
                  <th>Giữ lại</th>
                  <th>Gộp</th>
                  <th>Mã KH</th>
                  <th>Họ tên</th>
                  <th>Giai đoạn</th>
                  <th>Ngày tạo</th>
                  <th>Phụ trách</th>
                  <th>Lịch hẹn · HĐ · Phiếu thu · Hội thoại</th>
                </tr>
              </thead>
              <tbody>
                {g.customers.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <input
                        type="radio"
                        name={`primary-${index}`}
                        checked={g.primaryId === c.id}
                        onChange={() =>
                          patch(index, {
                            primaryId: c.id,
                            selected: g.customers.filter((x) => x.id !== c.id).map((x) => x.id)
                          })
                        }
                      />
                    </td>
                    <td>
                      <input
                        type="checkbox"
                        disabled={g.primaryId === c.id}
                        checked={g.primaryId !== c.id && g.selected.includes(c.id)}
                        onChange={(e) =>
                          patch(index, {
                            selected: e.target.checked
                              ? [...g.selected, c.id]
                              : g.selected.filter((id) => id !== c.id)
                          })
                        }
                      />
                    </td>
                    <td className="muted">
                      <a href="#" onClick={(e) => { e.preventDefault(); navigate(`/khach-hang/${c.id}`) }}>
                        {c.code}
                      </a>
                    </td>
                    <td>
                      <b>{c.name}</b>
                      {c.hidden ? <span className="muted"> (đang ẩn)</span> : null}
                    </td>
                    <td>
                      <Tag style={stageStyle(c.stage)} />
                    </td>
                    <td className="muted">{dateVi(c.createdAt)}</td>
                    <td>{c.assignedTo?.name ?? <span className="muted">chưa gán</span>}</td>
                    <td className="muted">
                      {c._count.appointments} · {c._count.contracts} · {c._count.payments} · {c._count.conversations}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="row" style={{ marginTop: 10, gap: 8 }}>
              <input
                className="input"
                style={{ flex: 1 }}
                placeholder="Lý do gộp (ví dụ: cùng một khách, nhập hai lần từ Zalo và Facebook)"
                value={g.reason}
                onChange={(e) => patch(index, { reason: e.target.value })}
              />
              <button className="btn" disabled={g.merging} onClick={() => void merge(index)}>
                {g.merging ? 'Đang gộp…' : 'Gộp vào hồ sơ giữ lại'}
              </button>
            </div>
          </div>
        ))
      )}

      {!loading && nextOffset != null ? (
        <div style={{ textAlign: 'center' }}>
          <button className="btn sec" onClick={() => void loadMore()}>
            Tải thêm nhóm
          </button>
        </div>
      ) : null}
    </>
  )
}
