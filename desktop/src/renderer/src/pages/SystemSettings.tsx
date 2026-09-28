import React, { useCallback, useEffect, useMemo, useState } from 'react'
import {
  deleteAdminRow,
  fetchAdminRows,
  fetchAdminTables,
  fetchDataStats,
  fetchDeleteImpact,
  fetchSettings,
  getApiErrorMessage,
  saveSettings,
  type AdminTable,
  type SettingRow
} from '../lib/api'
import { useAuth } from '../lib/auth-context'
import { Empty, Modal, useToast } from '../components/ui'

/* ⚙️ CÀI ĐẶT HỆ THỐNG — chỉ Quản trị hệ thống.
 *
 * Hai phần tách bạch có chủ đích:
 *   1. THAM SỐ VẬN HÀNH — đổi chính sách kinh doanh mà không cần lập trình
 *      viên (tỉ lệ cọc, ngưỡng trả lời chậm, hạn mức xuất dữ liệu…). Mỗi tham
 *      số ghi rõ "dùng ở đâu" để người sửa biết mình đang đổi cái gì.
 *   2. QUẢN TRỊ DỮ LIỆU — duyệt và xoá bản ghi gốc. Đây là vùng nguy hiểm nên
 *      có ba lớp chặn: bảng bị khoá, bắt buộc lý do, và gõ XOA để xác nhận. */

export default function SystemSettings(): React.JSX.Element {
  const { user } = useAuth()
  const [tab, setTab] = useState<'params' | 'data'>('params')

  const isAdmin = user?.roles.some((r) => r.code === 'QUAN_LY_HE_THONG')
  if (!isAdmin) {
    return (
      <div className="card">
        <div className="empty">
          <div style={{ fontSize: 34 }}>🔒</div>
          <h3 style={{ marginTop: 10 }}>Khu vực dành riêng cho Quản trị hệ thống</h3>
          <p className="muted">
            Khu này sửa được tham số vận hành và xoá được dữ liệu gốc, nên chỉ mở cho vai trò Quản trị
            hệ thống — kể cả Giám đốc cũng không vào được nếu chưa được gán vai trò đó.
          </p>
        </div>
      </div>
    )
  }

  return (
    <>
      <div className="tabs">
        <button className={tab === 'params' ? 'on' : ''} onClick={() => setTab('params')}>
          Tham số vận hành
        </button>
        <button className={tab === 'data' ? 'on' : ''} onClick={() => setTab('data')}>
          Quản trị dữ liệu
        </button>
      </div>
      {tab === 'params' ? <ParamsPanel /> : <DataPanel />}
    </>
  )
}

/* ------------------------------------------------------ THAM SỐ VẬN HÀNH */

function ParamsPanel(): React.JSX.Element {
  const { say, fail } = useToast()
  const [rows, setRows] = useState<SettingRow[]>([])
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await fetchSettings()
      setRows(r)
      setDraft(Object.fromEntries(r.map((x) => [x.key, x.value])))
    } catch (err) {
      fail(getApiErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }, [fail])

  useEffect(() => {
    void load()
  }, [load])

  const groups = useMemo(() => {
    const m = new Map<string, SettingRow[]>()
    for (const r of rows) m.set(r.group, [...(m.get(r.group) ?? []), r])
    return [...m.entries()]
  }, [rows])

  const dirty = rows.filter((r) => draft[r.key] !== r.value).length

  const submit = async (): Promise<void> => {
    setSaving(true)
    try {
      const r = await saveSettings(draft)
      say(
        r.changed
          ? `Đã lưu ${r.changed} tham số. Có hiệu lực ngay, không cần khởi động lại.`
          : 'Không có thay đổi nào.'
      )
      void load()
    } catch (err) {
      fail(getApiErrorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <div className="card"><Empty>Đang tải…</Empty></div>

  return (
    <>
      <div className="alert wr">
        Các tham số dưới đây <b>tác động thẳng vào hành vi hệ thống</b> — không phải ghi chú. Đổi tỉ lệ
        cọc là đổi luôn điều kiện xác nhận ca mổ. Mọi thay đổi đều ghi vào Nhật ký hệ thống.
      </div>

      <div className="row" style={{ marginBottom: 12 }}>
        <span className="muted" style={{ fontSize: 12.5 }}>
          {dirty ? `${dirty} tham số đang sửa chưa lưu` : 'Chưa có thay đổi'}
        </span>
        <button className="btn sec sm" style={{ marginLeft: 'auto' }} onClick={() => void load()} disabled={saving}>
          Khôi phục
        </button>
        <button className="btn" onClick={() => void submit()} disabled={saving || !dirty}>
          {saving ? 'Đang lưu…' : 'Lưu thay đổi'}
        </button>
      </div>

      {groups.map(([group, items]) => (
        <div className="card" key={group} style={{ marginBottom: 12, padding: 0, overflow: 'hidden' }}>
          <div className="sec-title" style={{ padding: '12px 14px 0' }}>
            {group}
          </div>
          <table>
            <thead>
              <tr>
                <th style={{ width: '38%' }}>Tham số</th>
                <th style={{ width: 190 }}>Giá trị</th>
                <th>Dùng ở đâu</th>
              </tr>
            </thead>
            <tbody>
              {items.map((s) => (
                <tr key={s.key}>
                  <td>
                    <b>{s.label}</b>
                    <div className="muted" style={{ fontSize: 11.5 }}>
                      {s.description}
                    </div>
                  </td>
                  <td>
                    {s.type === 'boolean' ? (
                      <select
                        className="input"
                        value={draft[s.key] ?? 'false'}
                        onChange={(e) => setDraft((d) => ({ ...d, [s.key]: e.target.value }))}
                      >
                        <option value="true">Bật</option>
                        <option value="false">Tắt</option>
                      </select>
                    ) : (
                      <input
                        className="input"
                        type={s.type === 'text' ? 'text' : 'number'}
                        min={s.min}
                        max={s.max}
                        value={draft[s.key] ?? ''}
                        onChange={(e) => setDraft((d) => ({ ...d, [s.key]: e.target.value }))}
                      />
                    )}
                    {draft[s.key] !== s.value ? (
                      <div style={{ fontSize: 11, color: 'var(--warn)' }}>
                        chưa lưu (đang là {s.value})
                      </div>
                    ) : !s.isDefault ? (
                      <div className="muted" style={{ fontSize: 11 }}>
                        mặc định: {s.defaultValue}
                      </div>
                    ) : null}
                  </td>
                  <td className="muted" style={{ fontSize: 12 }}>
                    {s.usedIn}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </>
  )
}

/* ------------------------------------------------------ QUẢN TRỊ DỮ LIỆU */

function DataPanel(): React.JSX.Element {
  const { say, fail } = useToast()
  const [tables, setTables] = useState<AdminTable[]>([])
  const [stats, setStats] = useState<Awaited<ReturnType<typeof fetchDataStats>> | null>(null)
  const [selected, setSelected] = useState<AdminTable | null>(null)
  const [rows, setRows] = useState<Record<string, unknown>[]>([])
  const [total, setTotal] = useState(0)
  const [query, setQuery] = useState('')
  const [deleting, setDeleting] = useState<Record<string, unknown> | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [t, s] = await Promise.all([fetchAdminTables(), fetchDataStats().catch(() => null)])
      setTables(t)
      setStats(s)
    } catch (err) {
      fail(getApiErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }, [fail])

  useEffect(() => {
    void load()
  }, [load])

  const loadRows = useCallback(
    async (table: AdminTable, q: string) => {
      try {
        const r = await fetchAdminRows(table.key, { q: q || undefined, limit: 50 })
        setRows(r.items)
        setTotal(r.total)
      } catch (err) {
        fail(getApiErrorMessage(err))
      }
    },
    [fail]
  )

  useEffect(() => {
    if (selected) void loadRows(selected, query)
  }, [selected, query, loadRows])

  const groups = useMemo(() => {
    const m = new Map<string, AdminTable[]>()
    for (const t of tables) m.set(t.group, [...(m.get(t.group) ?? []), t])
    return [...m.entries()]
  }, [tables])

  // Cột hiển thị: chọn vài trường dễ đọc, bỏ id kỹ thuật và trường JSON dài.
  const columns = useMemo(() => {
    if (!rows.length) return []
    const skip = new Set(['id', 'createdAt', 'updatedAt', 'passwordHash', 'checklist'])
    return Object.keys(rows[0])
      .filter((k) => !skip.has(k))
      .filter((k) => {
        const v = rows[0][k]
        return v === null || ['string', 'number', 'boolean'].includes(typeof v)
      })
      .slice(0, 6)
  }, [rows])

  if (loading) return <div className="card"><Empty>Đang tải…</Empty></div>

  return (
    <>
      <div className="alert dg">
        <b>Vùng nguy hiểm.</b> Xoá ở đây là xoá thật khỏi cơ sở dữ liệu, không khôi phục được. Mọi lần
        xoá đều bắt buộc ghi lý do và để lại vết trong Nhật ký hệ thống kèm tên người xoá.
      </div>

      {stats ? (
        <div className="grid" style={{ gridTemplateColumns: 'repeat(5, 1fr)', marginBottom: 12 }}>
          <div className="kpi">
            <div className="lab">Khách hàng</div>
            <div className="val">{stats.customers}</div>
          </div>
          <div className="kpi">
            <div className="lab">Tin nhắn</div>
            <div className="val">{stats.messages}</div>
          </div>
          <div className="kpi">
            <div className="lab">Ảnh đã lưu</div>
            <div className="val">{stats.photos}</div>
          </div>
          <div className="kpi">
            <div className="lab">Nhật ký thay đổi</div>
            <div className="val">{stats.audits}</div>
          </div>
          <div className="kpi">
            <div className="lab">Nhật ký truy cập</div>
            <div className="val">{stats.accessLogs}</div>
          </div>
        </div>
      ) : null}

      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
        <div className="card" style={{ width: 280, flex: '0 0 280px', padding: 0, overflow: 'hidden' }}>
          <div className="sec-title" style={{ padding: '12px 14px 0' }}>
            Bảng dữ liệu
          </div>
          <div style={{ maxHeight: '65vh', overflowY: 'auto' }}>
            {groups.map(([group, items]) => (
              <div key={group}>
                <div className="nav-group" style={{ color: 'var(--muted)', margin: '10px 14px 4px' }}>
                  {group}
                </div>
                {items.map((t) => (
                  <div
                    key={t.key}
                    className={`zitem${selected?.key === t.key ? ' on' : ''}`}
                    style={{ padding: '8px 14px' }}
                    onClick={() => {
                      setSelected(t)
                      setQuery('')
                    }}
                  >
                    <div className="zmid">
                      <div className="ztop">
                        <b style={{ fontSize: 12.8 }}>{t.label}</b>
                        <span className="zgio">{t.count}</span>
                      </div>
                      {!t.deletable ? (
                        <div className="muted" style={{ fontSize: 11 }}>
                          🔒 chỉ xem
                        </div>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          {!selected ? (
            <div className="card">
              <Empty>Chọn một bảng ở cột trái để xem dữ liệu.</Empty>
            </div>
          ) : (
            <>
              <div className="row" style={{ marginBottom: 12 }}>
                <b>{selected.label}</b>
                <span className="muted" style={{ fontSize: 12 }}>
                  {total} bản ghi
                </span>
                <input
                  className="input"
                  style={{ width: 220, marginLeft: 'auto' }}
                  placeholder="Tìm trong bảng"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </div>

              {!selected.deletable ? (
                <div className="alert wr">
                  <b>Bảng này bị khoá xoá.</b> {selected.reason}
                </div>
              ) : null}

              <div className="card" style={{ padding: 0, overflow: 'auto' }}>
                {rows.length === 0 ? (
                  <Empty>Không có bản ghi nào.</Empty>
                ) : (
                  <table>
                    <thead>
                      <tr>
                        {columns.map((c) => (
                          <th key={c}>{c}</th>
                        ))}
                        <th style={{ width: 80 }} />
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r, i) => (
                        <tr key={String(r.id ?? i)}>
                          {columns.map((c) => (
                            <td key={c} style={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                              {r[c] === null || r[c] === undefined ? (
                                <span className="muted">—</span>
                              ) : typeof r[c] === 'boolean' ? (
                                r[c] ? 'có' : 'không'
                              ) : (
                                String(r[c]).slice(0, 60)
                              )}
                            </td>
                          ))}
                          <td>
                            {selected.deletable ? (
                              <button className="btn sec sm" onClick={() => setDeleting(r)}>
                                Xoá
                              </button>
                            ) : (
                              <span className="muted" style={{ fontSize: 11 }}>
                                🔒
                              </span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {deleting && selected ? (
        <DeleteModal
          table={selected}
          row={deleting}
          onClose={() => setDeleting(null)}
          onDone={() => {
            setDeleting(null)
            say('Đã xoá bản ghi và ghi vào nhật ký.')
            void loadRows(selected, query)
            void load()
          }}
        />
      ) : null}
    </>
  )
}

function DeleteModal({
  table,
  row,
  onClose,
  onDone
}: {
  table: AdminTable
  row: Record<string, unknown>
  onClose: () => void
  onDone: () => void
}): React.JSX.Element {
  const { fail } = useToast()
  const [reason, setReason] = useState('')
  const [confirm, setConfirm] = useState('')
  const [saving, setSaving] = useState(false)
  const [impact, setImpact] = useState<Awaited<ReturnType<typeof fetchDeleteImpact>> | null>(null)

  const label = String(row.name ?? row.title ?? row.code ?? row.id ?? '')

  // Hỏi trước hậu quả: xoá một "nguồn khách" có thể gỡ liên kết của hàng chục
  // khách và làm hỏng quy kết ROAS. Người xoá phải thấy con số đó trước.
  useEffect(() => {
    fetchDeleteImpact(table.key, String(row.id))
      .then(setImpact)
      .catch(() => setImpact(null))
  }, [table.key, row.id])

  const submit = async (): Promise<void> => {
    if (reason.trim().length < 5) {
      fail('Ghi lý do xoá, tối thiểu 5 ký tự.')
      return
    }
    if (confirm !== 'XOA') {
      fail('Gõ đúng chữ XOA để xác nhận.')
      return
    }
    setSaving(true)
    try {
      await deleteAdminRow(
        table.key,
        String(row.id),
        reason.trim(),
        (impact?.totalAffected ?? 0) > 0
      )
      onDone()
    } catch (err) {
      fail(getApiErrorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      title={`Xoá bản ghi — ${table.label}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn sec" onClick={onClose}>
            Huỷ
          </button>
          <button
            className="btn danger"
            onClick={() => void submit()}
            disabled={saving || confirm !== 'XOA' || reason.trim().length < 5}
          >
            {saving ? 'Đang xoá…' : 'Xoá vĩnh viễn'}
          </button>
        </>
      }
    >
      <div className="alert dg">
        Sắp xoá vĩnh viễn: <b>{label}</b>
        <br />
        Không khôi phục được.
      </div>

      {impact && impact.totalAffected > 0 ? (
        <div className="alert dg">
          <b>Xoá sẽ gỡ liên kết của:</b>
          <ul style={{ margin: '6px 0 0 18px' }}>
            {impact.dependents.map((d) => (
              <li key={d.label}>
                {d.count} {d.label}
              </li>
            ))}
          </ul>
          <div style={{ marginTop: 6 }}>
            Những bản ghi đó sẽ mất quy kết và <b>không khôi phục được</b>. Cân nhắc đánh dấu ngưng dùng
            thay vì xoá.
          </div>
        </div>
      ) : impact ? (
        <div className="alert ok">Không có dữ liệu nào đang tham chiếu tới bản ghi này.</div>
      ) : null}
      <div className="field">
        <label>Lý do xoá * (ghi vào nhật ký)</label>
        <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} />
      </div>
      <div className="field">
        <label>
          Gõ <b>XOA</b> để xác nhận
        </label>
        <input className="input" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
      </div>
    </Modal>
  )
}
