import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import {
  fetchMe,
  login as loginRequest,
  logoutRequest,
  setActiveBranch,
  setSessionLostHandler,
  setTokens
} from './api'
import { connectSocket, disconnectSocket } from './socket'
import type { CurrentUser, PermissionScope } from './types'

interface AuthContextValue {
  user: CurrentUser | null
  loading: boolean
  error: string | null
  branchId: string | null
  switchBranch: (branchId: string) => void
  login: (email: string, password: string) => Promise<void>
  logout: () => Promise<void>
  refreshMe: () => Promise<void>
  /** Có quyền `code` không (bất kể phạm vi). */
  can: (code: string) => boolean
  /** Phạm vi của quyền `code`, null nếu không có. */
  scopeOf: (code: string) => PermissionScope | null
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined)

export function AuthProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [user, setUser] = useState<CurrentUser | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [branchId, setBranchId] = useState<string | null>(null)

  const applySession = useCallback(
    (nextUser: CurrentUser | null, accessToken: string | null, activeBranch: string | null) => {
      setUser(nextUser)
      setBranchId(activeBranch)
      setActiveBranch(activeBranch)
      if (accessToken) connectSocket(accessToken)
      else disconnectSocket()
    },
    []
  )

  // Phiên bị thu hồi từ phía máy chủ (đổi quyền, nghỉ việc, refresh token bị
  // dùng lại) — đá về màn đăng nhập ngay thay vì để giao diện lỗi lặt vặt.
  useEffect(() => {
    setSessionLostHandler(() => {
      setUser(null)
      setError('Phiên làm việc đã kết thúc. Vui lòng đăng nhập lại.')
      disconnectSocket()
    })
    return () => setSessionLostHandler(null)
  }, [])

  useEffect(() => {
    let cancelled = false

    async function bootstrap(): Promise<void> {
      try {
        const { accessToken, refreshToken } = await window.crm.getTokens()
        if (!accessToken || !refreshToken) return

        setTokens(accessToken, refreshToken)
        const savedBranch = await window.crm.getBranch()
        setActiveBranch(savedBranch)

        const me = await fetchMe()
        if (cancelled) return

        const branch =
          savedBranch && me.branches.some((b) => b.id === savedBranch)
            ? savedBranch
            : (me.branches.find((b) => b.isPrimary)?.id ?? me.branches[0]?.id ?? null)
        applySession(me, accessToken, branch)
      } catch {
        setTokens(null, null)
        await window.crm.setTokens(null, null)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    bootstrap()
    return () => {
      cancelled = true
    }
  }, [applySession])

  const login = useCallback(
    async (email: string, password: string) => {
      setError(null)
      try {
        const result = await loginRequest(email, password)
        setTokens(result.accessToken, result.refreshToken)
        await window.crm.setTokens(result.accessToken, result.refreshToken)

        const branch =
          result.user.branches.find((b) => b.isPrimary)?.id ?? result.user.branches[0]?.id ?? null
        await window.crm.setBranch(branch)
        applySession(result.user, result.accessToken, branch)
      } catch (err) {
        const message =
          (err as { response?: { data?: { error?: string } } })?.response?.data?.error ||
          'Đăng nhập thất bại. Kiểm tra lại email và mật khẩu.'
        setError(message)
        throw err
      }
    },
    [applySession]
  )

  const logout = useCallback(async () => {
    await logoutRequest()
    setTokens(null, null)
    await window.crm.setTokens(null, null)
    applySession(null, null, null)
  }, [applySession])

  const refreshMe = useCallback(async () => {
    const me = await fetchMe()
    setUser(me)
  }, [])

  const switchBranch = useCallback((next: string) => {
    setBranchId(next)
    setActiveBranch(next)
    void window.crm.setBranch(next)
  }, [])

  const can = useCallback((code: string) => Boolean(user?.permissions[code]), [user])
  const scopeOf = useCallback(
    (code: string) => (user?.permissions[code] as PermissionScope | undefined) ?? null,
    [user]
  )

  const value = useMemo<AuthContextValue>(
    () => ({ user, loading, error, branchId, switchBranch, login, logout, refreshMe, can, scopeOf }),
    [user, loading, error, branchId, switchBranch, login, logout, refreshMe, can, scopeOf]
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth phải nằm trong AuthProvider')
  return ctx
}
