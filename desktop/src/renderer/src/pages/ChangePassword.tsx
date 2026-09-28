import React, { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { changePassword, getApiErrorMessage } from '../lib/api'
import { useAuth } from '../lib/auth-context'
import { useToast } from '../components/ui'

export default function ChangePassword(): React.JSX.Element {
  const { user, refreshMe } = useAuth()
  const { say, fail } = useToast()
  const navigate = useNavigate()

  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [saving, setSaving] = useState(false)

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    if (next.length < 8) {
      fail('Mật khẩu mới phải từ 8 ký tự.')
      return
    }
    if (next !== confirm) {
      fail('Hai lần nhập mật khẩu mới không khớp.')
      return
    }
    setSaving(true)
    try {
      await changePassword(current, next)
      await refreshMe()
      say('Đã đổi mật khẩu. Các phiên đăng nhập khác đã bị thu hồi.')
      navigate('/')
    } catch (err) {
      fail(getApiErrorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{ maxWidth: 460 }}>
      {user?.mustChangePassword ? (
        <div className="alert wr">
          Tài khoản đang dùng mật khẩu tạm do quản trị cấp. Hãy đổi mật khẩu trước khi làm việc.
        </div>
      ) : null}

      <form className="card" onSubmit={submit}>
        <div className="sec-title">Đổi mật khẩu</div>
        <div className="field">
          <label>Mật khẩu hiện tại</label>
          <input
            className="input"
            type="password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            required
          />
        </div>
        <div className="field">
          <label>Mật khẩu mới (tối thiểu 8 ký tự)</label>
          <input
            className="input"
            type="password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            required
          />
        </div>
        <div className="field">
          <label>Nhập lại mật khẩu mới</label>
          <input
            className="input"
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            required
          />
        </div>
        <button className="btn block" type="submit" disabled={saving}>
          {saving ? 'Đang lưu…' : 'Đổi mật khẩu'}
        </button>
        <div className="muted" style={{ fontSize: 11.5, marginTop: 10 }}>
          Đổi mật khẩu sẽ đăng xuất mọi thiết bị khác đang dùng tài khoản này.
        </div>
      </form>
    </div>
  )
}
