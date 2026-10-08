import React, { useEffect, useState } from 'react'
import { getApiErrorMessage } from '../lib/api'
import { fetchPancakeAgentReport, type PancakeAgentReport } from '../lib/api-lo5'
import { useAuth } from '../lib/auth-context'
import { dateTimeVi, dateVi } from '../lib/format'
import { Empty, useToast } from './ui'

/* F35: HIỆU SUẤT NHÂN VIÊN TRÊN PANCAKE.
 *
 * Số liệu do CHÍNH PANCAKE đo, CRM kéo về mỗi 10 phút. Vì sao không tự đếm:
 * nhân viên trả lời khách ngay trong app Pancake thì CRM chỉ có bản sao tin
 * nhắn và không biết ai bấm gửi — Pancake thì biết.
 *
 * Màn này KHÁC thẻ "Tốc độ trả lời": thẻ kia đo theo tin đã vào CRM và chỉ quy
 * được về người gửi khi tin gửi TỪ CRM. Hai thẻ bổ sung cho nhau.
 */

const PERIODS = [
  { key: 'today', label: 'Hôm nay' },
  { key: '7d', label: '7 ngày' },
  { key: 'month', label: 'Tháng này' }
]

/** 75 -> "1 phút 15 giây"; null -> "—" (Pancake không đo được, KHÔNG phải 0 giây). */
function dur(seconds: number | null): string {
  if (seconds == null) return '—'
  if (seconds < 60) return `${seconds} giây`
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  if (m < 60) return s ? `${m} phút ${s} giây` : `${m} phút`
  const h = Math.floor(m / 60)
  return `${h} giờ ${m % 60} phút`
}

/** Phản hồi nhanh thì xanh, chậm thì đỏ. Ngưỡng 5 phút / 15 phút. */
function tone(seconds: number | null): React.CSSProperties | undefined {
  if (seconds == null) return undefined
  if (seconds <= 300) return { color: 'var(--ok, #0a7c42)', fontWeight: 600 }
  if (seconds > 900) return { color: 'var(--dg, #c0392b)', fontWeight: 600 }
  return undefined
}

function Kpi({ label, value, hint }: { label: string; value: string; hint?: string }): React.JSX.Element {
  return (
    <div className="card" style={{ flex: '1 1 160px', margin: 0 }}>
      <div className="muted" style={{ fontSize: 12 }}>
        {label}
      </div>
      <div style={{ fontSize: 22, fontWeight: 700, lineHeight: 1.3 }}>{value}</div>
      {hint ? (
        <div className="muted" style={{ fontSize: 11.5 }}>
          {hint}
        </div>
      ) : null}
    </div>
  )
}

export function PancakePerformancePanel(): React.JSX.Element {
  const { fail } = useToast()
  const { branchId } = useAuth()
  const [period, setPeriod] = useState('today')
  const [data, setData] = useState<PancakeAgentReport | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    fetchPancakeAgentReport({ period })
      .then(setData)
      .catch((e) => fail(getApiErrorMessage(e)))
      .finally(() => setLoading(false))
  }, [period, branchId, fail])

  const periodButtons = (
    <div className="row" style={{ gap: 6, marginLeft: 'auto' }}>
      {PERIODS.map((p) => (
        <button key={p.key} className={`btn sm ${period === p.key ? '' : 'sec'}`} onClick={() => setPeriod(p.key)}>
          {p.label}
        </button>
      ))}
    </div>
  )

  if (loading && !data) {
    return (
      <div className="card">
        <Empty>Đang tải…</Empty>
      </div>
    )
  }

  if (!data || (data.agents.length === 0 && data.pages.length === 0)) {
    return (
      <div className="card">
        <div className="row" style={{ marginBottom: 8 }}>
          <div className="sec-title" style={{ margin: 0 }}>
            Hiệu suất nhân viên trên Pancake
          </div>
          {periodButtons}
        </div>
        <Empty>
          Chưa có số liệu trong kỳ.
          <br />
          <span className="muted">
            Cần: kết nối Pancake đang bật, đã “Dò trang”, và bật “Pancake: tự kéo thống kê hiệu suất nhân viên” ở Cài
            đặt nhóm Tự động hoá. Muốn có số ngay thì bấm “Kéo thống kê” ở màn Kết nối.
          </span>
        </Empty>
      </div>
    )
  }

  const t = data.totals
  const peak = [...data.hours].sort((a, b) => b.messages - a.messages)[0]

  return (
    <>
      <div className="card" style={{ marginBottom: 12 }}>
        <div className="row" style={{ marginBottom: 10 }}>
          <div>
            <div className="sec-title" style={{ margin: 0 }}>
              Hiệu suất nhân viên trên Pancake
            </div>
            <div className="muted" style={{ fontSize: 12 }}>
              Số liệu do Pancake đo, kéo về mỗi 10 phút
              {data.lastSyncAt ? ` · lần kéo cuối ${dateTimeVi(data.lastSyncAt)}` : ' · chưa kéo lần nào'}
            </div>
          </div>
          {periodButtons}
        </div>

        <div className="row" style={{ gap: 10, flexWrap: 'wrap', alignItems: 'stretch' }}>
          <Kpi label="Tin đã xử lý" value={String(t.messages)} hint={`${t.inboxCount} hộp thư · ${t.commentCount} bình luận`} />
          <Kpi label="Hội thoại đã trả lời" value={String(t.conversations)} />
          <Kpi label="TB phản hồi" value={dur(t.avgResponseSeconds)} hint="Trung bình theo số tin" />
          <Kpi label="Nhân viên có số" value={String(t.agents)} hint={`${t.phones} SĐT lấy được`} />
          {peak ? <Kpi label="Giờ đông nhất" value={`${String(peak.hour).padStart(2, '0')}:00`} hint={`${peak.messages} tin`} /> : null}
        </div>

        {data.pagesNeverSynced.length ? (
          <div className="alert wr" style={{ marginTop: 10, marginBottom: 0 }}>
            Chưa kéo được số liệu của trang: <b>{data.pagesNeverSynced.join(', ')}</b>. Kiểm tra token trang ở màn Kết
            nối (Pancake: Cài đặt trang › Công cụ).
          </div>
        ) : null}
        {data.unmappedAgents > 0 ? (
          <div className="alert wr" style={{ marginTop: 10, marginBottom: 0 }}>
            {data.unmappedAgents} nhân viên Pancake chưa gắn với tài khoản CRM — số của họ vẫn hiện theo tên Pancake,
            nhưng chưa vào được bảng lương, bảng thi đua. Gắn ở màn Kết nối › Nhân viên Pancake.
          </div>
        ) : null}
      </div>

      <div className="card" style={{ marginBottom: 12 }}>
        <div className="sec-title" style={{ marginTop: 0 }}>
          Theo nhân viên
        </div>
        <table>
          <thead>
            <tr>
              <th>Nhân viên</th>
              <th>Tin đã xử lý</th>
              <th>Hộp thư</th>
              <th>Bình luận</th>
              <th>Hội thoại</th>
              <th>SĐT</th>
              <th>TB phản hồi</th>
            </tr>
          </thead>
          <tbody>
            {data.agents.map((a) => (
              <tr key={a.pancakeUserId}>
                <td>
                  <b>{a.userName ?? a.name}</b>
                  {a.userId ? null : (
                    <span className="tag wr" style={{ marginLeft: 6 }}>
                      chưa gắn
                    </span>
                  )}
                  {a.userName && a.userName !== a.name ? (
                    <div className="muted" style={{ fontSize: 11.5 }}>
                      Pancake: {a.name}
                    </div>
                  ) : null}
                </td>
                <td>
                  <b>{a.messages}</b>
                </td>
                <td>{a.inboxCount}</td>
                <td>{a.commentCount}</td>
                <td>{a.conversations}</td>
                <td>{a.phones}</td>
                <td style={tone(a.avgResponseSeconds)}>{dur(a.avgResponseSeconds)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
          “—” ở cột TB phản hồi nghĩa là Pancake không đo được trong kỳ, KHÔNG phải trả lời tức thì. Trung bình tính có
          trọng số theo số tin, nên một giờ ít tin không kéo lệch cả kỳ.
        </div>
      </div>

      <div className="card" style={{ marginBottom: 12 }}>
        <div className="sec-title" style={{ marginTop: 0 }}>
          Theo nền tảng
        </div>
        <table>
          <thead>
            <tr>
              <th>Nền tảng</th>
              <th>Tin đã xử lý</th>
              <th>Hộp thư</th>
              <th>Bình luận</th>
              <th>Hội thoại</th>
              <th>SĐT</th>
              <th>TB phản hồi</th>
              <th>Nhân viên</th>
            </tr>
          </thead>
          <tbody>
            {data.platforms.map((p) => (
              <tr key={p.key}>
                <td>
                  <b>{p.label}</b>
                </td>
                <td>{p.messages}</td>
                <td>{p.inboxCount}</td>
                <td>{p.commentCount}</td>
                <td>{p.conversations}</td>
                <td>{p.phones}</td>
                <td style={tone(p.avgResponseSeconds)}>{dur(p.avgResponseSeconds)}</td>
                <td>{p.agents}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card" style={{ marginBottom: 12 }}>
        <div className="sec-title" style={{ marginTop: 0 }}>
          Theo trang
        </div>
        <table>
          <thead>
            <tr>
              <th>Trang</th>
              <th>Tin đã xử lý</th>
              <th>Hội thoại</th>
              <th>SĐT</th>
              <th>TB phản hồi</th>
            </tr>
          </thead>
          <tbody>
            {data.pages.map((p) => (
              <tr key={p.key}>
                <td>{p.label}</td>
                <td>{p.messages}</td>
                <td>{p.conversations}</td>
                <td>{p.phones}</td>
                <td style={tone(p.avgResponseSeconds)}>{dur(p.avgResponseSeconds)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {data.days.length > 1 ? (
        <div className="card">
          <div className="sec-title" style={{ marginTop: 0 }}>
            Theo ngày
          </div>
          <table>
            <thead>
              <tr>
                <th>Ngày</th>
                <th>Tin đã xử lý</th>
                <th>Hội thoại</th>
                <th>SĐT</th>
                <th>TB phản hồi</th>
                <th>Nhân viên trực</th>
              </tr>
            </thead>
            <tbody>
              {data.days.map((d) => (
                <tr key={d.dayKey}>
                  <td>{dateVi(d.dayKey)}</td>
                  <td>{d.messages}</td>
                  <td>{d.conversations}</td>
                  <td>{d.phones}</td>
                  <td style={tone(d.avgResponseSeconds)}>{dur(d.avgResponseSeconds)}</td>
                  <td>{d.agents}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </>
  )
}
