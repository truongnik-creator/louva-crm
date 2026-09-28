import React, { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { fetchContracts, getApiErrorMessage, signContract } from '../lib/api'
import { useAuth } from '../lib/auth-context'
import { dateVi, vnd } from '../lib/format'
import { CONTRACT_STATUS, tagStyleOf } from '../lib/ui'
import { Empty, Tag, useToast } from '../components/ui'
import type { Contract } from '../lib/types'

/* ĐƠN HÀNG · HỢP ĐỒNG */

export default function Contracts(): React.JSX.Element {
  const { can, branchId } = useAuth()
  const { say, fail } = useToast()
  const navigate = useNavigate()

  const [items, setItems] = useState<Contract[]>([])
  const [status, setStatus] = useState('')
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setItems(await fetchContracts({ status: status || undefined }))
    } catch (err) {
      fail(getApiErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }, [status, fail])

  useEffect(() => {
    void load()
  }, [load, branchId])

  const totalSigned = items.reduce((s, c) => s + c.total, 0)
  const totalPaid = items.reduce((s, c) => s + c.paidAmount, 0)

  return (
    <>
      <div className="grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)', marginBottom: 12 }}>
        <div className="kpi">
          <div className="lab">Số hợp đồng</div>
          <div className="val">{items.length}</div>
        </div>
        <div className="kpi">
          <div className="lab">Tổng giá trị ký</div>
          <div className="val">{vnd(totalSigned)}</div>
        </div>
        <div className="kpi">
          <div className="lab">Đã thu</div>
          <div className="val">{vnd(totalPaid)}</div>
        </div>
        <div className="kpi">
          <div className="lab">Còn phải thu</div>
          <div className="val" style={{ color: totalSigned - totalPaid > 0 ? 'var(--danger)' : undefined }}>
            {vnd(totalSigned - totalPaid)}
          </div>
        </div>
      </div>

      <div className="row" style={{ marginBottom: 12 }}>
        <select className="input" style={{ width: 'auto' }} value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">Mọi trạng thái</option>
          {Object.entries(CONTRACT_STATUS).map(([key, s]) => (
            <option key={key} value={key}>
              {s.t}
            </option>
          ))}
        </select>
        <span className="muted" style={{ fontSize: 12 }}>
          Hợp đồng lập từ hồ sơ khách — mở khách rồi bấm “Tạo báo giá / hợp đồng”.
        </span>
      </div>

      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        {loading ? (
          <Empty>Đang tải…</Empty>
        ) : items.length === 0 ? (
          <Empty>Chưa có hợp đồng nào.</Empty>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Mã</th>
                <th>Khách hàng</th>
                <th>Nội dung</th>
                <th>Giá trị</th>
                <th>Đã thu</th>
                <th>Còn lại</th>
                <th>Tư vấn viên</th>
                <th>Ngày ký</th>
                <th>Trạng thái</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {items.map((c) => (
                <tr key={c.id}>
                  <td className="muted">{c.code}</td>
                  <td
                    className="clickable"
                    style={{ cursor: 'pointer' }}
                    onClick={() => navigate(`/khach-hang/${c.customer.id}`)}
                  >
                    <b>{c.customer.name}</b>
                  </td>
                  <td>{c.items.map((i) => i.name).join(', ')}</td>
                  <td>{vnd(c.total)}</td>
                  <td>{vnd(c.paidAmount)}</td>
                  <td style={{ color: c.remaining > 0 ? 'var(--danger)' : undefined }}>{vnd(c.remaining)}</td>
                  <td>{c.consultant?.name ?? '—'}</td>
                  <td>{dateVi(c.signedAt)}</td>
                  <td>
                    <Tag style={tagStyleOf(CONTRACT_STATUS, c.status)} />
                  </td>
                  <td>
                    {can('finance.update') && c.status === 'DRAFT' ? (
                      <button
                        className="btn sm"
                        onClick={async () => {
                          try {
                            await signContract(c.id)
                            say(`Đã ký hợp đồng ${c.code}.`)
                            void load()
                          } catch (err) {
                            fail(getApiErrorMessage(err))
                          }
                        }}
                      >
                        Ký
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  )
}
