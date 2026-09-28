import React, { createContext, useCallback, useContext, useMemo, useState } from 'react'
import type { TagStyle } from '../lib/ui'

/* Các mảnh giao diện dùng lại — giữ đúng lớp CSS của prototype. */

export function Tag({ style, children }: { style: TagStyle; children?: React.ReactNode }): React.JSX.Element {
  return (
    <span className="tag" style={{ background: style.bg, color: style.fg }}>
      {children ?? style.t}
    </span>
  )
}

export function Field({ label, value }: { label: string; value: React.ReactNode }): React.JSX.Element {
  return (
    <div className="pf">
      <div className="pl">{label}</div>
      <div className="pv">{value}</div>
    </div>
  )
}

export function Row({ label, value }: { label: string; value: React.ReactNode }): React.JSX.Element {
  return (
    <tr>
      <td style={{ width: 200, color: 'var(--muted)' }}>{label}</td>
      <td>{value}</td>
    </tr>
  )
}

export function Empty({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="empty">{children}</div>
}

export function Spinner(): React.JSX.Element {
  return (
    <div className="full-screen-center">
      <div className="spinner" />
    </div>
  )
}

export function Modal({
  title,
  onClose,
  children,
  footer,
  width
}: {
  title: string
  onClose: () => void
  children: React.ReactNode
  footer?: React.ReactNode
  width?: number
}): React.JSX.Element {
  return (
    <div className="modal-ovl" onClick={onClose}>
      <div className="modal" style={width ? { maxWidth: width } : undefined} onClick={(e) => e.stopPropagation()}>
        <div className="row" style={{ marginBottom: 12 }}>
          <h3 style={{ margin: 0 }}>{title}</h3>
          <button className="btn sec sm" style={{ marginLeft: 'auto' }} onClick={onClose}>
            Đóng ✕
          </button>
        </div>
        {children}
        {footer ? (
          <div className="row" style={{ marginTop: 14, justifyContent: 'flex-end' }}>
            {footer}
          </div>
        ) : null}
      </div>
    </div>
  )
}

export function Drawer({
  title,
  onClose,
  children
}: {
  title: React.ReactNode
  onClose: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <>
      <div className="ovl" onClick={onClose} />
      <div className="drawer">
        <div className="row">
          <b style={{ fontSize: 15 }}>{title}</b>
          <button className="btn sec sm" style={{ marginLeft: 'auto' }} onClick={onClose}>
            Đóng ✕
          </button>
        </div>
        {children}
      </div>
    </>
  )
}

/* ------------------------------------------------------------------- TOAST */

interface ToastState {
  message: string
  error: boolean
}

interface ToastContextValue {
  say: (message: string) => void
  fail: (message: string) => void
}

const ToastContext = createContext<ToastContextValue | undefined>(undefined)

export function ToastProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [toast, setToast] = useState<ToastState | null>(null)

  const show = useCallback((message: string, error: boolean) => {
    setToast({ message, error })
    window.setTimeout(() => setToast(null), error ? 5000 : 3200)
  }, [])

  const value = useMemo<ToastContextValue>(
    () => ({ say: (m) => show(m, false), fail: (m) => show(m, true) }),
    [show]
  )

  return (
    <ToastContext.Provider value={value}>
      {children}
      {toast ? <div className={`toast${toast.error ? ' err' : ''}`}>{toast.message}</div> : null}
    </ToastContext.Provider>
  )
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast phải nằm trong ToastProvider')
  return ctx
}
