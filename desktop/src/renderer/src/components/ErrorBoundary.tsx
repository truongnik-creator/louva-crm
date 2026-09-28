import React from 'react'

/* Không có lớp này, một lỗi ở BẤT KỲ màn nào cũng làm React tháo toàn bộ cây
   và người dùng nhìn thấy màn hình trắng cho tới khi khởi động lại app. Với
   phòng khám đang tiếp khách thì đó là sự cố vận hành, không phải lỗi nhỏ.

   Đặt boundary ở tầng nội dung: thanh bên và menu vẫn dùng được, người dùng
   chuyển sang màn khác là làm việc tiếp. */

interface Props {
  children: React.ReactNode
  /** Đổi giá trị này (ví dụ theo đường dẫn) để tự phục hồi khi đổi màn. */
  resetKey?: string
}

interface State {
  error: Error | null
}

export default class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidUpdate(prev: Props): void {
    if (this.state.error && prev.resetKey !== this.props.resetKey) {
      this.setState({ error: null })
    }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('[ErrorBoundary]', error, info.componentStack)
  }

  render(): React.ReactNode {
    if (!this.state.error) return this.props.children

    return (
      <div className="card">
        <div className="empty">
          <div style={{ fontSize: 34 }}>⚠️</div>
          <h3 style={{ marginTop: 10 }}>Màn hình này gặp lỗi</h3>
          <p className="muted">
            Dữ liệu của bạn vẫn an toàn. Chọn một mục khác ở menu bên trái để làm việc tiếp, hoặc thử
            tải lại màn hình này.
          </p>
          <pre
            style={{
              textAlign: 'left',
              fontSize: 11.5,
              background: 'var(--surface-2)',
              border: '1px solid var(--border)',
              borderRadius: 8,
              padding: 10,
              marginTop: 12,
              overflow: 'auto',
              maxHeight: 160
            }}
          >
            {this.state.error.message}
          </pre>
          <div className="row" style={{ justifyContent: 'center', marginTop: 12 }}>
            <button className="btn sm" onClick={() => this.setState({ error: null })}>
              Thử lại
            </button>
            <button className="btn sec sm" onClick={() => window.location.reload()}>
              Tải lại ứng dụng
            </button>
          </div>
        </div>
      </div>
    )
  }
}
