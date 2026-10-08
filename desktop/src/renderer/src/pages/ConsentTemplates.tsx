import React, { useEffect, useState } from 'react'
import { fetchConsentTemplates, type ConsentTemplateRow } from '../lib/api-nova'
import { getApiErrorMessage } from '../lib/api'
import { Empty, useToast } from '../components/ui'

/* Mẫu biểu & cam kết. Có sẵn mẫu đồng ý xử lý dữ liệu cá nhân theo Nghị định
   13/2023 (ghi rõ chuyển dữ liệu ra nước ngoài khi dùng AI). */

export default function ConsentTemplates(): React.JSX.Element {
  const { fail, say } = useToast()
  const [rows, setRows] = useState<ConsentTemplateRow[] | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)

  useEffect(() => {
    fetchConsentTemplates()
      .then((r) => {
        setRows(r)
        setOpenId(r.find((x) => x.code === 'ND13-XU-LY-DU-LIEU')?.id ?? r[0]?.id ?? null)
      })
      .catch((err) => fail(getApiErrorMessage(err)))
  }, [fail])

  if (!rows) return <div className="card"><Empty>Đang tải mẫu biểu…</Empty></div>
  const open = rows.find((r) => r.id === openId)

  return (
    <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
      <div className="card" style={{ width: 300, flex: '0 0 300px' }}>
        <div className="sec-title">Mẫu biểu</div>
        {rows.map((r) => (
          <div
            key={r.id}
            onClick={() => setOpenId(r.id)}
            style={{
              padding: '8px 6px',
              cursor: 'pointer',
              borderBottom: '1px dashed var(--border)',
              fontWeight: r.id === openId ? 700 : 400
            }}
          >
            {r.title}
            <div className="muted" style={{ fontSize: 11.5 }}>{r.code}</div>
          </div>
        ))}
      </div>
      <div className="card" style={{ flex: 1, minWidth: 420 }}>
        {open ? (
          <>
            <div className="row" style={{ marginBottom: 8 }}>
              <div className="sec-title" style={{ margin: 0 }}>{open.title}</div>
              <button
                className="btn sec sm"
                style={{ marginLeft: 'auto' }}
                onClick={() => {
                  void navigator.clipboard?.writeText(open.bodyText).then(() => say('Đã chép nội dung mẫu.'))
                }}
              >
                Chép nội dung
              </button>
              <button className="btn sec sm" onClick={() => window.print()}>
                In
              </button>
            </div>
            <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', fontSize: 13, lineHeight: 1.55, margin: 0 }}>
              {open.bodyText}
            </pre>
          </>
        ) : (
          <Empty>Chưa có mẫu biểu nào.</Empty>
        )}
      </div>
    </div>
  )
}
