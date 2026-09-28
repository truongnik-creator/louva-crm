import React, { useEffect, useState } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { useAuth } from '../lib/auth-context'

export default function Login(): React.JSX.Element {
  const { login, user, error, loading } = useAuth()
  const navigate = useNavigate()

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [backendStatus, setBackendStatus] = useState<string>('')

  // Máy chủ chạy kèm trong app Electron — nếu nó chưa lên thì báo rõ, thay vì
  // để người dùng nhìn thấy "đăng nhập thất bại" và tưởng sai mật khẩu.
  useEffect(() => {
    window.crm
      .getBackendStatus()
      .then(setBackendStatus)
      .catch(() => setBackendStatus(''))
  }, [])

  if (loading) {
    return (
      <div className="full-screen-center">
        <div className="spinner" />
      </div>
    )
  }
  if (user) return <Navigate to="/" replace />

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    setSubmitting(true)
    try {
      await login(email.trim(), password)
      navigate('/')
    } catch {
      // Thông báo lỗi đã nằm trong context.
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={submit}>
        <div className="brand">
          <div className="logo">✚</div>
          <h2 style={{ margin: 0, fontSize: 17 }}>Louva</h2>
          <div className="muted" style={{ fontSize: 12.5 }}>
            Đăng nhập bằng tài khoản nội bộ
          </div>
        </div>

        {backendStatus && backendStatus !== 'ready' && backendStatus !== 'running' ? (
          <div className="alert wr">Máy chủ đang khởi động ({backendStatus})… thử lại sau vài giây.</div>
        ) : null}

        {error ? <div className="alert dg">{error}</div> : null}

        <div className="field">
          <label>Email</label>
          <input
            className="input"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoFocus
            required
          />
        </div>
        <div className="field">
          <label>Mật khẩu</label>
          <input
            className="input"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </div>

        <button className="btn block" type="submit" disabled={submitting} style={{ marginTop: 6 }}>
          {submitting ? 'Đang đăng nhập…' : 'Đăng nhập'}
        </button>

        <div className="muted" style={{ fontSize: 11.5, marginTop: 14, textAlign: 'center' }}>
          Phiên đăng nhập có thể bị thu hồi từ xa khi quản trị đổi quyền hoặc khoá tài khoản.
        </div>
      </form>
    </div>
  )
}
