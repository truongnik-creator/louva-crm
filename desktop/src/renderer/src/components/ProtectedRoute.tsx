import React from 'react'
import { Navigate, useLocation } from 'react-router-dom'
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
  const location = useLocation()

  if (loading) return <Spinner />
  if (!user) return <Navigate to="/login" replace />

  // S1: mật khẩu tạm (tài khoản seed, quản trị cấp lại) phải đổi trước khi làm
  // việc. Backend cũng chặn mọi API nghiệp vụ, đây chỉ là lớp điều hướng.
  if (user.mustChangePassword && location.pathname !== '/doi-mat-khau') {
    return <Navigate to="/doi-mat-khau" replace />
  }

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
