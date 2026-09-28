import React from 'react'
import { Navigate } from 'react-router-dom'
import { useAuth } from '../lib/auth-context'
import { Spinner } from './ui'

/**
 * Chặn ở tầng điều hướng. Đây chỉ là lớp trải nghiệm — quyền THẬT được ép ở
 * backend (ba cổng trong middleware/rbac.ts); giấu menu không phải là bảo mật.
 */
export default function ProtectedRoute({
  children,
  permission
}: {
  children: React.ReactNode
  permission?: string
}): React.JSX.Element {
  const { user, loading, can } = useAuth()

  if (loading) return <Spinner />
  if (!user) return <Navigate to="/login" replace />

  if (permission && !can(permission)) {
    return (
      <div className="card">
        <div className="empty">
          <div style={{ fontSize: 34 }}>🔒</div>
          <h3 style={{ marginTop: 10 }}>Không có quyền truy cập</h3>
          <p>Vai trò của bạn không được phép mở màn hình này.</p>
          <p className="muted">
            Nếu bạn cho rằng đây là nhầm lẫn, liên hệ quản trị hệ thống để rà lại phân quyền.
          </p>
        </div>
      </div>
    )
  }

  return <>{children}</>
}
