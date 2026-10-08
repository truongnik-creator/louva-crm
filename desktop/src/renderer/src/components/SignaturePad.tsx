import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'

/* Ô KÝ TAY (B16). Khách ký bằng chuột, bút cảm ứng hoặc ngón tay; ảnh PNG gửi
 * lên API ký cam kết có sẵn (/medical/consents/:id/sign), máy chủ mã hoá như ảnh
 * trước-sau. Nền trắng để bản in, bản lưu đọc được ở cả chế độ tối. */

export interface SignaturePadHandle {
  isEmpty: () => boolean
  toBlob: () => Promise<Blob | null>
  clear: () => void
}

const WIDTH = 560
const HEIGHT = 180

export const SignaturePad = forwardRef<SignaturePadHandle, { onChange?: (empty: boolean) => void }>(
  function SignaturePad({ onChange }, ref) {
    const canvasRef = useRef<HTMLCanvasElement>(null)
    const drawing = useRef(false)
    const last = useRef<{ x: number; y: number } | null>(null)
    const [empty, setEmpty] = useState(true)

    const reset = (): void => {
      const c = canvasRef.current
      const g = c?.getContext('2d')
      if (!c || !g) return
      g.fillStyle = '#ffffff'
      g.fillRect(0, 0, c.width, c.height)
      setEmpty(true)
      onChange?.(true)
    }

    useEffect(reset, []) // eslint-disable-line react-hooks/exhaustive-deps

    useImperativeHandle(ref, () => ({
      isEmpty: () => empty,
      clear: reset,
      toBlob: () =>
        new Promise((resolve) => {
          const c = canvasRef.current
          if (!c || empty) return resolve(null)
          c.toBlob((b) => resolve(b), 'image/png')
        })
    }))

    const point = (e: React.PointerEvent<HTMLCanvasElement>): { x: number; y: number } => {
      const rect = e.currentTarget.getBoundingClientRect()
      return {
        x: ((e.clientX - rect.left) / rect.width) * WIDTH,
        y: ((e.clientY - rect.top) / rect.height) * HEIGHT
      }
    }

    const down = (e: React.PointerEvent<HTMLCanvasElement>): void => {
      e.currentTarget.setPointerCapture(e.pointerId)
      drawing.current = true
      last.current = point(e)
    }

    const move = (e: React.PointerEvent<HTMLCanvasElement>): void => {
      if (!drawing.current || !last.current) return
      const g = canvasRef.current?.getContext('2d')
      if (!g) return
      const p = point(e)
      g.strokeStyle = '#111827'
      g.lineWidth = 2.4
      g.lineCap = 'round'
      g.lineJoin = 'round'
      g.beginPath()
      g.moveTo(last.current.x, last.current.y)
      g.lineTo(p.x, p.y)
      g.stroke()
      last.current = p
      if (empty) {
        setEmpty(false)
        onChange?.(false)
      }
    }

    const up = (): void => {
      drawing.current = false
      last.current = null
    }

    return (
      <div>
        <canvas
          ref={canvasRef}
          width={WIDTH}
          height={HEIGHT}
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          onPointerLeave={up}
          style={{
            width: '100%',
            maxWidth: WIDTH,
            aspectRatio: `${WIDTH} / ${HEIGHT}`,
            border: '1px dashed var(--border)',
            borderRadius: 8,
            background: '#ffffff',
            touchAction: 'none',
            cursor: 'crosshair',
            display: 'block'
          }}
        />
        <div className="row" style={{ marginTop: 6 }}>
          <span className="muted" style={{ fontSize: 11.5 }}>
            {empty ? 'Khách ký vào khung trên' : 'Đã có chữ ký'}
          </span>
          <button type="button" className="btn sec sm" style={{ marginLeft: 'auto' }} onClick={reset}>
            Ký lại
          </button>
        </div>
      </div>
    )
  }
)
