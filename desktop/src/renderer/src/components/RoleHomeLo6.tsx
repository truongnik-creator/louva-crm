import React from 'react'
import { useNavigate } from 'react-router-dom'
import { dateVi } from '../lib/format'

/* Lô 6: khối trang chủ AI6 (bản tin sáng cho giám đốc, quản lý) và AI5 (số nháp
   tin chăm lại chờ duyệt). Chỉ hiện khi máy chủ trả về khối đó. */

export interface HomeLo6Sections {
  briefing?: { id: string; dayKey: string; source: 'AI' | 'FALLBACK'; content: string; isToday: boolean } | null
  reengage?: { pending: number }
}

export default function RoleHomeLo6({ s }: { s: HomeLo6Sections }): React.JSX.Element {
  const navigate = useNavigate()
  return (
    <>
      {'briefing' in s ? (
        <div className="card">
          <div className="row" style={{ marginBottom: 8 }}>
            <div className="sec-title" style={{ margin: 0 }}>Bản tin sáng</div>
            {s.briefing ? (
              <span className="muted" style={{ marginLeft: 'auto', fontSize: 12 }}>
                {dateVi(s.briefing.dayKey)} · {s.briefing.source === 'AI' ? 'AI tóm tắt' : 'Số liệu thuần'}
                {s.briefing.isToday ? '' : ' · chưa có bản hôm nay'}
              </span>
            ) : null}
          </div>
          {s.briefing ? (
            <div className="briefing">{s.briefing.content}</div>
          ) : (
            <div className="muted">Bản tin tạo lúc 7h00 mỗi ngày (chỉ số liệu tổng, không có thông tin khách).</div>
          )}
        </div>
      ) : null}
      {s.reengage && s.reengage.pending > 0 ? (
        <div className="card">
          <div className="row">
            <div className="sec-title" style={{ margin: 0 }}>Nháp tin chăm lại chờ duyệt</div>
            <button className="btn sm" style={{ marginLeft: 'auto' }} onClick={() => navigate('/cham-lai-khach')}>
              Duyệt {s.reengage.pending} nháp
            </button>
          </div>
        </div>
      ) : null}
    </>
  )
}
