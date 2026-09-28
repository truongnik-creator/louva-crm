import React, { useCallback, useEffect, useState } from 'react'
import {
  createStaff,
  deactivateStaff,
  fetchBranches,
  fetchPermissionCatalog,
  fetchRoles,
  fetchStaff,
  getApiErrorMessage,
  saveRolePermissions,
  type RoleWithPermissions
} from '../lib/api'
import { useAuth } from '../lib/auth-context'
import { relativeVi } from '../lib/format'
import { Empty, Modal, useToast } from '../components/ui'
import type { Branch, StaffUser } from '../lib/types'

/* NGƯỜI DÙNG & PHÂN QUYỀN — hai tab: tài khoản và ma trận vai trò × quyền.
   Ma trận có cột PHẠM VI (Toàn công ty / Trong cơ sở / Chỉ của mình) — đây là
   chiều thứ ba của mô hình phân quyền, không phải chỉ bật/tắt quyền. */

const SCOPE_LABEL: Record<string, string> = {
  ALL: 'Toàn công ty',
  BRANCH: 'Trong cơ sở',
  OWN: 'Chỉ của mình'
}

const STATUS_LABEL: Record<string, string> = {
  ACTIVE: 'Đang làm việc',
  SUSPENDED: 'Tạm khoá',
  RESIGNED: 'Đã nghỉ việc'
}

export default function UsersPage(): React.JSX.Element {
  const { can } = useAuth()
  const { say, fail } = useToast()

  const [tab, setTab] = useState<'users' | 'roles'>('users')
  const [staff, setStaff] = useState<StaffUser[]>([])
  const [roles, setRoles] = useState<RoleWithPermissions[]>([])
  const [branches, setBranches] = useState<Branch[]>([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [deactivating, setDeactivating] = useState<StaffUser | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [users, roleRows, branchRows] = await Promise.all([
        fetchStaff(),
        can('settings.read') ? fetchRoles() : Promise.resolve([]),
        fetchBranches()
      ])
      setStaff(users)
      setRoles(roleRows)
      setBranches(branchRows)
    } catch (err) {
      fail(getApiErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }, [can, fail])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <>
      <div className="tabs">
        <button className={tab === 'users' ? 'on' : ''} onClick={() => setTab('users')}>
          Tài khoản ({staff.length})
        </button>
        {can('settings.read') ? (
          <button className={tab === 'roles' ? 'on' : ''} onClick={() => setTab('roles')}>
            Vai trò &amp; quyền ({roles.length})
          </button>
        ) : null}
      </div>

      {tab === 'users' ? (
        <>
          <div className="row" style={{ marginBottom: 12 }}>
            <span className="muted" style={{ fontSize: 12.5 }}>
              Vô hiệu hoá tài khoản sẽ thu hồi mọi phiên đăng nhập ngay lập tức và bàn giao khách cho
              người khác.
            </span>
            {can('hr.create') ? (
              <button className="btn" style={{ marginLeft: 'auto' }} onClick={() => setCreating(true)}>
                + Thêm nhân viên
              </button>
            ) : null}
          </div>

          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            {loading ? (
              <Empty>Đang tải…</Empty>
            ) : staff.length === 0 ? (
              <Empty>Chưa có nhân viên nào.</Empty>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Họ tên</th>
                    <th>Email</th>
                    <th>Vai trò</th>
                    <th>Phòng ban</th>
                    <th>Cơ sở</th>
                    <th>Trạng thái</th>
                    <th>Đăng nhập gần nhất</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {staff.map((u) => (
                    <tr key={u.id}>
                      <td>
                        <b>
                          {u.title ? `${u.title} ` : ''}
                          {u.name}
                        </b>
                      </td>
                      <td className="muted">{u.email}</td>
                      <td>
                        {u.roles.map((r) => (
                          <span key={r.id} className="tag out" style={{ marginRight: 4 }}>
                            {r.name}
                          </span>
                        ))}
                      </td>
                      <td>{u.department?.name ?? '—'}</td>
                      <td className="muted">{u.branches.map((b) => b.shortName ?? b.code).join(', ')}</td>
                      <td>
                        <span
                          className="tag"
                          style={
                            u.status === 'ACTIVE'
                              ? { background: '#DCFCE7', color: '#15803D' }
                              : { background: '#FEE2E2', color: '#B91C1C' }
                          }
                        >
                          {STATUS_LABEL[u.status] ?? u.status}
                        </span>
                      </td>
                      <td className="muted">{relativeVi(u.lastLoginAt)}</td>
                      <td>
                        {can('hr.update') && u.status === 'ACTIVE' ? (
                          <button className="btn sec sm" onClick={() => setDeactivating(u)}>
                            Vô hiệu hoá
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
      ) : (
        <RoleMatrix roles={roles} onSaved={load} />
      )}

      {creating ? (
        <NewStaffModal
          roles={roles}
          branches={branches}
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false)
            void load()
          }}
        />
      ) : null}

      {deactivating ? (
        <DeactivateModal
          user={deactivating}
          staff={staff.filter((s) => s.id !== deactivating.id && s.status === 'ACTIVE')}
          onClose={() => setDeactivating(null)}
          onDone={() => {
            setDeactivating(null)
            void load()
          }}
        />
      ) : null}
    </>
  )
}

function RoleMatrix({
  roles,
  onSaved
}: {
  roles: RoleWithPermissions[]
  onSaved: () => void
}): React.JSX.Element {
  const { can } = useAuth()
  const { say, fail } = useToast()
  const [selected, setSelected] = useState<string>(roles[0]?.id ?? '')
  const [catalog, setCatalog] = useState<
    Array<{ id: string; code: string; module: string; action: string; name: string; isSpecial: boolean }>
  >([])
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    fetchPermissionCatalog()
      .then((r) => setCatalog(r.permissions))
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    const role = roles.find((r) => r.id === selected)
    if (!role) return
    setDraft(Object.fromEntries(role.permissions.map((p) => [p.code, p.scope])))
  }, [selected, roles])

  useEffect(() => {
    if (!selected && roles.length) setSelected(roles[0].id)
  }, [roles, selected])

  const role = roles.find((r) => r.id === selected)
  if (!role) return <div className="card"><Empty>Chưa có vai trò nào.</Empty></div>

  const byModule = catalog.reduce<Record<string, typeof catalog>>((acc, p) => {
    ;(acc[p.module] ??= []).push(p)
    return acc
  }, {})

  const submit = async (): Promise<void> => {
    setSaving(true)
    try {
      const result = await saveRolePermissions(
        role.id,
        Object.entries(draft).map(([code, scope]) => ({ code, scope }))
      )
      say(
        `Đã lưu quyền cho vai trò ${role.name}. ${result.affectedUsers} người dùng bị thu hồi phiên và phải đăng nhập lại.`
      )
      onSaved()
    } catch (err) {
      fail(getApiErrorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <div className="row" style={{ marginBottom: 12, flexWrap: 'wrap' }}>
        <select className="input" style={{ width: 260 }} value={selected} onChange={(e) => setSelected(e.target.value)}>
          {roles.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name} ({r.userCount} người)
            </option>
          ))}
        </select>
        <span className="muted" style={{ fontSize: 12.5, flex: 1 }}>
          {role.description}
        </span>
        {can('settings.update') ? (
          <button className="btn" onClick={() => void submit()} disabled={saving}>
            {saving ? 'Đang lưu…' : 'Lưu phân quyền'}
          </button>
        ) : null}
      </div>

      <div className="alert wr">
        Đổi quyền của một vai trò sẽ thu hồi phiên đăng nhập của mọi người mang vai trò đó — họ phải đăng
        nhập lại để nhận quyền mới. Đây là chủ ý: quyền phải có hiệu lực ngay, không chờ token hết hạn.
      </div>

      {Object.entries(byModule).map(([module, perms]) => (
        <div className="card" key={module} style={{ marginBottom: 12, padding: 0, overflow: 'hidden' }}>
          <div className="sec-title" style={{ padding: '12px 14px 0' }}>
            Module {module}
          </div>
          <table>
            <thead>
              <tr>
                <th>Quyền</th>
                <th style={{ width: 90 }}>Có quyền</th>
                <th style={{ width: 180 }}>Phạm vi dữ liệu</th>
              </tr>
            </thead>
            <tbody>
              {perms.map((p) => {
                const granted = draft[p.code]
                return (
                  <tr key={p.code}>
                    <td>
                      {p.name}
                      {p.isSpecial ? (
                        <span className="tag" style={{ background: '#FEF3C7', color: '#B45309', marginLeft: 6 }}>
                          quyền đặc biệt
                        </span>
                      ) : null}
                      <div className="muted" style={{ fontSize: 11.5 }}>
                        {p.code}
                      </div>
                    </td>
                    <td>
                      <input
                        type="checkbox"
                        disabled={!can('settings.update')}
                        checked={Boolean(granted)}
                        onChange={(e) =>
                          setDraft((prev) => {
                            const next = { ...prev }
                            if (e.target.checked) next[p.code] = 'BRANCH'
                            else delete next[p.code]
                            return next
                          })
                        }
                      />
                    </td>
                    <td>
                      {granted ? (
                        <select
                          className="input"
                          disabled={!can('settings.update')}
                          value={granted}
                          onChange={(e) => setDraft((prev) => ({ ...prev, [p.code]: e.target.value }))}
                        >
                          {Object.entries(SCOPE_LABEL).map(([key, label]) => (
                            <option key={key} value={key}>
                              {label}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      ))}
    </>
  )
}

function NewStaffModal({
  roles,
  branches,
  onClose,
  onCreated
}: {
  roles: RoleWithPermissions[]
  branches: Branch[]
  onClose: () => void
  onCreated: () => void
}): React.JSX.Element {
  const { say, fail } = useToast()
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [title, setTitle] = useState('')
  const [password, setPassword] = useState('')
  const [roleId, setRoleId] = useState(roles[0]?.id ?? '')
  const [branchIds, setBranchIds] = useState<string[]>(branches[0] ? [branches[0].id] : [])
  const [saving, setSaving] = useState(false)

  const submit = async (): Promise<void> => {
    if (!email || !name || password.length < 8 || !roleId || !branchIds.length) {
      fail('Điền đủ email, họ tên, mật khẩu tối thiểu 8 ký tự, vai trò và cơ sở.')
      return
    }
    setSaving(true)
    try {
      await createStaff({
        email: email.trim(),
        name: name.trim(),
        title: title.trim() || undefined,
        password,
        roleIds: [roleId],
        branchIds
      })
      say('Đã tạo tài khoản. Người dùng sẽ được yêu cầu đổi mật khẩu ở lần đăng nhập đầu.')
      onCreated()
    } catch (err) {
      fail(getApiErrorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      title="Thêm nhân viên"
      onClose={onClose}
      footer={
        <>
          <button className="btn sec" onClick={onClose}>
            Huỷ
          </button>
          <button className="btn" onClick={() => void submit()} disabled={saving}>
            {saving ? 'Đang lưu…' : 'Tạo tài khoản'}
          </button>
        </>
      }
    >
      <div className="field">
        <label>Email đăng nhập *</label>
        <input className="input" value={email} onChange={(e) => setEmail(e.target.value)} />
      </div>
      <div className="field">
        <label>Họ và tên *</label>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="field">
        <label>Học hàm / chức danh (BS, ĐD, Ths. BS…)</label>
        <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
      </div>
      <div className="field">
        <label>Mật khẩu tạm (tối thiểu 8 ký tự) *</label>
        <input className="input" type="text" value={password} onChange={(e) => setPassword(e.target.value)} />
      </div>
      <div className="field">
        <label>Vai trò *</label>
        <select className="input" value={roleId} onChange={(e) => setRoleId(e.target.value)}>
          {roles.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label>Cơ sở làm việc *</label>
        {branches.map((b) => (
          <label key={b.id} className="row" style={{ fontSize: 13, gap: 6, marginBottom: 4 }}>
            <input
              type="checkbox"
              checked={branchIds.includes(b.id)}
              onChange={(e) =>
                setBranchIds((prev) => (e.target.checked ? [...prev, b.id] : prev.filter((x) => x !== b.id)))
              }
            />
            {b.name}
          </label>
        ))}
      </div>
    </Modal>
  )
}

function DeactivateModal({
  user,
  staff,
  onClose,
  onDone
}: {
  user: StaffUser
  staff: StaffUser[]
  onClose: () => void
  onDone: () => void
}): React.JSX.Element {
  const { say, fail } = useToast()
  const [reason, setReason] = useState('')
  const [handoverToUserId, setHandoverToUserId] = useState('')
  const [status, setStatus] = useState('RESIGNED')
  const [saving, setSaving] = useState(false)

  const submit = async (): Promise<void> => {
    if (reason.trim().length < 3) {
      fail('Ghi lý do vô hiệu hoá.')
      return
    }
    setSaving(true)
    try {
      const result = await deactivateStaff(user.id, {
        reason: reason.trim(),
        handoverToUserId: handoverToUserId || undefined,
        status
      })
      say(
        `Đã vô hiệu hoá ${user.name}: thu hồi ${result.revokedSessions} phiên, bàn giao ${result.handedOverCustomers} khách.`
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
      title={`Vô hiệu hoá — ${user.name}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn sec" onClick={onClose}>
            Huỷ
          </button>
          <button className="btn danger" onClick={() => void submit()} disabled={saving}>
            {saving ? 'Đang xử lý…' : 'Vô hiệu hoá'}
          </button>
        </>
      }
    >
      <div className="alert dg">
        Mọi phiên đăng nhập của người này bị thu hồi ngay lập tức. Nếu không chọn người nhận bàn giao,
        khách đang phụ trách sẽ không có ai chăm.
      </div>
      <div className="field">
        <label>Hình thức</label>
        <select className="input" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="RESIGNED">Nghỉ việc</option>
          <option value="SUSPENDED">Tạm khoá</option>
        </select>
      </div>
      <div className="field">
        <label>Lý do *</label>
        <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} />
      </div>
      <div className="field">
        <label>Bàn giao khách cho</label>
        <select
          className="input"
          value={handoverToUserId}
          onChange={(e) => setHandoverToUserId(e.target.value)}
        >
          <option value="">— Không bàn giao —</option>
          {staff.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </div>
    </Modal>
  )
}
