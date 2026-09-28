import React, { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { fetchProcedures, getApiErrorMessage } from '../lib/api'
import { useAuth } from '../lib/auth-context'
import { dateTimeVi, minutesLabel, toISODate, vnd } from '../lib/format'
import { ANESTHESIA_LABEL, PROCEDURE_STATUS, tagStyleOf } from '../lib/ui'
import { Empty, Tag, useToast } from '../components/ui'
import type { Procedure } from '../lib/types'

/* HỒ SƠ PHẪU THUẬT — danh sách ca mổ và tường trình.
 *
 * Khác màn "Phòng mổ · Lịch mổ": màn kia là LƯỚI THỜI GIAN để xếp phòng trong
 * ngày; màn này là SỔ HỒ SƠ tra cứu theo khoảng thời gian — bác sĩ tìm lại ca
 * đã mổ, đọc tường trình, kiểm tra ca nào chưa ghi tường trình. */

export default function ProcedureRecords(): React.JSX.Element {
  const { branchId } = useAuth()
  const { fail } = useToast()
  const navigate = useNavigate()

  const [items, setItems] = useState<Procedure[]>([])
  const [status, setStatus] = useState('')
  const [days, setDays] = useState(30)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const from = new Date()
      from.setDate(from.getDate() - days)
      from.setHours(0, 0, 0, 0)
      const to = new Date()
      to.setDate(to.getDate() + days)

      const data = await fetchProcedures({ from: from.toISOString(), to: to.toISOString() })
      setItems(data.items)
    } catch (err) {
      fail(getApiErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }, [days, fail])

  useEffect(() => {
    void load()
  }, [load, branchId])

  const shown = status ? items.filter((p) => p.status === status) : items
  const completed = items.filter((p) => p.status === 'COMPLETED')
  const missingReport = completed.filter((p) => !p.report)

  return (
    <>
      <div className="grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)', marginBottom: 12 }}>
        <div className="kpi">
          <div className="lab">Tổng ca trong kỳ</div>
          <div className="val">{items.length}</div>
        </div>
        <div className="kpi">
          <div className="lab">Đã mổ xong</div>
          <div className="val">{completed.length}</div>
        </div>
        <div className="kpi">
          <div className="lab">Chưa đủ điều kiện</div>
          <div className="val" style={{ color: items.filter((p) => !p.checklistReady).length ? 'var(--warn)' : undefined }}>
            {items.filter((p) => !p.checklistReady).length}
          </div>
        </div>
        <div className="kpi">
          <div className="lab">Thiếu tường trình</div>
          <div className="val" style={{ color: missingReport.length ? 'var(--danger)' : undefined }}>
            {missingReport.length}
          </div>
          {missingReport.length ? <div className="dt down">Hồ sơ chưa hoàn chỉnh</div> : null}
        </div>
      </div>

      <div className="row" style={{ marginBottom: 12, flexWrap: 'wrap' }}>
        <select className="input" style={{ width: 'auto' }} value={days} onChange={(e) => setDays(Number(e.target.value))}>
          <option value={7}>±7 ngày</option>
          <option value={30}>±30 ngày</option>
          <option value={90}>±90 ngày</option>
          <option value={365}>±1 năm</option>
        </select>
        <select className="input" style={{ width: 'auto' }} value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">Mọi trạng thái</option>
          {Object.entries(PROCEDURE_STATUS).map(([k, v]) => (
            <option key={k} value={k}>
              {v.t}
            </option>
          ))}
        </select>
        <span className="muted" style={{ fontSize: 12 }}>
          Xếp ca mới ở màn Phòng mổ · Lịch mổ.
        </span>
      </div>

      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        {loading ? (
          <Empty>Đang tải…</Empty>
        ) : shown.length === 0 ? (
          <Empty>Không có ca nào khớp bộ lọc.</Empty>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Mã</th>
                <th>Thời gian</th>
                <th>Khách hàng</th>
                <th>Thủ thuật</th>
                <th>Bác sĩ</th>
                <th>Vô cảm</th>
                <th>Thời lượng</th>
                <th>Trạng thái</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((p) => (
                <React.Fragment key={p.id}>
                  <tr className="clickable" onClick={() => setExpanded(expanded === p.id ? null : p.id)}>
                    <td className="muted">{p.code}</td>
                    <td>{dateTimeVi(p.scheduledAt)}</td>
                    <td>
                      <b>{p.customer.name}</b>
                      <div className="muted" style={{ fontSize: 11.5 }}>
                        {p.customer.code}
                      </div>
                    </td>
                    <td>{p.title}</td>
                    <td>{p.surgeon?.name ?? '—'}</td>
                    <td className="muted">{ANESTHESIA_LABEL[p.anesthesia] ?? p.anesthesia}</td>
                    <td>{minutesLabel(p.durationMin)}</td>
                    <td>
                      <Tag style={tagStyleOf(PROCEDURE_STATUS, p.status)} />
                      {p.status === 'COMPLETED' && !p.report ? (
                        <div className="down" style={{ fontSize: 11 }}>
                          thiếu tường trình
                        </div>
                      ) : null}
                    </td>
                  </tr>
                  {expanded === p.id ? (
                    <tr>
                      <td colSpan={8} style={{ background: 'var(--surface-2)' }}>
                        <div style={{ display: 'grid', gap: 8, padding: '4px 0' }}>
                          <div>
                            <span className="pl">Kíp mổ</span>
                            <div>{p.teamNote ?? '—'}</div>
                          </div>
                          <div>
                            <span className="pl">Vật tư dự trù</span>
                            <div>{p.materialNote ?? '—'}</div>
                          </div>
                          {p.contract ? (
                            <div>
                              <span className="pl">Hợp đồng</span>
                              <div>
                                {p.contract.code} — đã thu {vnd(p.contract.paidAmount)} /{' '}
                                {vnd(p.contract.total)}
                              </div>
                            </div>
                          ) : null}
                          <div>
                            <span className="pl">Tường trình phẫu thuật</span>
                            <div style={{ whiteSpace: 'pre-wrap' }}>
                              {p.report ?? (
                                <span className="muted">
                                  Chưa ghi. Tường trình được nhập khi bấm “Kết thúc mổ”.
                                </span>
                              )}
                            </div>
                          </div>
                          <div className="row">
                            <button
                              className="btn sec sm"
                              onClick={(e) => {
                                e.stopPropagation()
                                navigate(`/khach-hang/${p.customer.id}`)
                              }}
                            >
                              Mở hồ sơ khách
                            </button>
                            <button
                              className="btn sec sm"
                              onClick={(e) => {
                                e.stopPropagation()
                                navigate(`/phong-mo?date=${toISODate(new Date(p.scheduledAt))}`)
                              }}
                            >
                              Xem trên lịch mổ
                            </button>
                          </div>
                        </div>
                      </td>
                    </tr>
                  ) : null}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  )
}
