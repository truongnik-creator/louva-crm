import React, { useCallback, useEffect, useState } from 'react'
import { fetchAuditLogs, fetchDataAccessLogs, getApiErrorMessage } from '../lib/api'
import { useAuth } from '../lib/auth-context'
import { dateTimeVi } from '../lib/format'
import { Empty, useToast } from '../components/ui'
import type { AuditLogEntry, DataAccessLogEntry } from '../lib/types'

/* NHẬT KÝ HỆ THỐNG — hai sổ tách bạch:
   · Nhật ký thay đổi (AuditLog): ai sửa gì, đổi từ giá trị nào sang giá trị nào.
   · Nhật ký truy cập (DataAccessLog): ai ĐỌC bệnh án / ảnh / SĐT của ai.
   Sổ thứ hai chỉ quản trị hệ thống và giám đốc mới xem được. */

const ACTION_LABEL: Record<string, string> = {
  CREATE: 'Tạo',
  UPDATE: 'Sửa',
  DELETE: 'Xoá',
  APPROVE: 'Phê duyệt',
  REJECT: 'Từ chối',
  LOGIN: 'Đăng nhập',
  LOGIN_FAILED: 'Đăng nhập thất bại',
  LOGOUT: 'Đăng xuất',
  BREAK_GLASS: 'Truy cập khẩn cấp',
  ACCOUNT_LOCKED: 'Khoá tạm tài khoản',
  MERGE: 'Gộp hồ sơ'
}

const RESOURCE_LABEL: Record<string, string> = {
  MEDICAL_RECORD: 'Bệnh án',
  PHOTO: 'Ảnh trước-sau',
  CUSTOMER_PHONE: 'Số điện thoại khách',
  CONSENT_FORM: 'Cam kết',
  PROCEDURE: 'Phiếu mổ',
  REPORT_EXPORT: 'Xuất dữ liệu'
}

const SEVERITY_STYLE: Record<string, { bg: string; fg: string; label: string }> = {
  NORMAL: { bg: '#F1F5F9', fg: '#475569', label: 'Bình thường' },
  ELEVATED: { bg: '#FEF3C7', fg: '#B45309', label: 'Vượt phạm vi' },
  CRITICAL: { bg: '#FEE2E2', fg: '#B91C1C', label: 'Nghiêm trọng' }
}

export default function AuditLog(): React.JSX.Element {
  const { scopeOf } = useAuth()
  const { fail } = useToast()

  const canSeeAccess = scopeOf('audit.read') === 'ALL'
  const [tab, setTab] = useState<'audit' | 'access'>('audit')
  const [audit, setAudit] = useState<AuditLogEntry[]>([])
  const [access, setAccess] = useState<DataAccessLogEntry[]>([])
  const [action, setAction] = useState('')
  const [severity, setSeverity] = useState('')
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      if (tab === 'audit') {
        const data = await fetchAuditLogs({ action: action || undefined, limit: 200 })
        setAudit(data.items)
      } else {
        const data = await fetchDataAccessLogs({ severity: severity || undefined, limit: 200 })
        setAccess(data.items)
      }
    } catch (err) {
      fail(getApiErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }, [tab, action, severity, fail])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <>
      <div className="tabs">
        <button className={tab === 'audit' ? 'on' : ''} onClick={() => setTab('audit')}>
          Nhật ký thay đổi
        </button>
        {canSeeAccess ? (
          <button className={tab === 'access' ? 'on' : ''} onClick={() => setTab('access')}>
            Nhật ký truy cập bệnh án
          </button>
        ) : null}
      </div>

      {tab === 'audit' ? (
        <>
          <div className="row" style={{ marginBottom: 12 }}>
            <select className="input" style={{ width: 'auto' }} value={action} onChange={(e) => setAction(e.target.value)}>
              <option value="">Mọi hành động</option>
              {Object.entries(ACTION_LABEL).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
          </div>

          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            {loading ? (
              <Empty>Đang tải…</Empty>
            ) : audit.length === 0 ? (
              <Empty>Chưa có bản ghi nào.</Empty>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Thời gian</th>
                    <th>Người thực hiện</th>
                    <th>Hành động</th>
                    <th>Đối tượng</th>
                    <th>Nội dung</th>
                    <th>Cơ sở</th>
                    <th>IP</th>
                  </tr>
                </thead>
                <tbody>
                  {audit.map((a) => (
                    <tr key={a.id}>
                      <td className="muted" style={{ whiteSpace: 'nowrap' }}>
                        {dateTimeVi(a.createdAt)}
                      </td>
                      <td>{a.actorName ?? '—'}</td>
                      <td>
                        <span
                          className="tag out"
                          style={
                            a.action === 'BREAK_GLASS' ||
                            a.action === 'LOGIN_FAILED' ||
                            a.action === 'ACCOUNT_LOCKED'
                              ? { borderColor: 'var(--danger)', color: 'var(--danger)' }
                              : undefined
                          }
                        >
                          {ACTION_LABEL[a.action] ?? a.action}
                        </span>
                      </td>
                      <td className="muted">{a.entity}</td>
                      <td>
                        {a.summary}
                        {a.changes ? (
                          <div className="muted" style={{ fontSize: 11.5 }}>
                            {Object.entries(a.changes)
                              .map(([field, [before, after]]) => `${field}: ${String(before)} → ${String(after)}`)
                              .join(' · ')}
                          </div>
                        ) : null}
                      </td>
                      <td className="muted">{a.branch?.shortName ?? a.branch?.code ?? '—'}</td>
                      <td className="muted">{a.ipAddress ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      ) : (
        <>
          <div className="alert wr">
            Sổ này ghi lại hành vi ĐỌC dữ liệu nhạy cảm, kể cả khi đọc hợp lệ. Đây là bằng chứng khi cần
            điều tra rò rỉ bệnh án hoặc ảnh khách.
          </div>
          <div className="row" style={{ marginBottom: 12 }}>
            <select
              className="input"
              style={{ width: 'auto' }}
              value={severity}
              onChange={(e) => setSeverity(e.target.value)}
            >
              <option value="">Mọi mức độ</option>
              {Object.entries(SEVERITY_STYLE).map(([key, s]) => (
                <option key={key} value={key}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>

          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            {loading ? (
              <Empty>Đang tải…</Empty>
            ) : access.length === 0 ? (
              <Empty>Chưa có lượt truy cập nào được ghi nhận.</Empty>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Thời gian</th>
                    <th>Người truy cập</th>
                    <th>Loại dữ liệu</th>
                    <th>Khách hàng</th>
                    <th>Mức độ</th>
                    <th>Lý do</th>
                    <th>Số dòng</th>
                  </tr>
                </thead>
                <tbody>
                  {access.map((a) => {
                    const s = SEVERITY_STYLE[a.severity] ?? SEVERITY_STYLE.NORMAL
                    return (
                      <tr key={a.id}>
                        <td className="muted" style={{ whiteSpace: 'nowrap' }}>
                          {dateTimeVi(a.createdAt)}
                        </td>
                        <td>{a.actorName ?? '—'}</td>
                        <td>{RESOURCE_LABEL[a.resourceType] ?? a.resourceType}</td>
                        <td>
                          {a.customer ? (
                            <>
                              {a.customer.name}
                              <div className="muted" style={{ fontSize: 11.5 }}>
                                {a.customer.code}
                              </div>
                            </>
                          ) : (
                            '—'
                          )}
                        </td>
                        <td>
                          <span className="tag" style={{ background: s.bg, color: s.fg }}>
                            {s.label}
                          </span>
                        </td>
                        <td>{a.reason ?? '—'}</td>
                        <td className="muted">{a.rowCount ?? '—'}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </>
  )
}
