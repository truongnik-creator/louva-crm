import React, { useCallback, useEffect, useState } from 'react'
import { getApiErrorMessage } from '../lib/api'
import { fetchConversationScores, runScoringNow, type ScoreRow } from '../lib/api-lo5'
import { Empty, useToast } from '../components/ui'

/* AI4: ĐIỂM HỘI THOẠI THEO KỊCH BẢN MỖI TUẦN, cho quản lý kèm cặp sale. Chỉ
 * chấm hội thoại của khách đã đồng ý xử lý dữ liệu. Không nối vào lương. */

export default function ConversationScores(): React.JSX.Element {
  const { say, fail } = useToast()
  const [week, setWeek] = useState<string | undefined>(undefined)
  const [data, setData] = useState<Awaited<ReturnType<typeof fetchConversationScores>> | null>(null)
  const [open, setOpen] = useState<ScoreRow | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => {
    fetchConversationScores(week)
      .then(setData)
      .catch((e) => fail(getApiErrorMessage(e)))
  }, [week, fail])
  useEffect(load, [load])

  const run = async (): Promise<void> => {
    setBusy(true)
    try {
      const r = await runScoringNow()
      if (r.status === 'SUCCESS') say(r.message ?? 'Đã chạy chấm hội thoại.')
      else fail(r.error ?? r.message ?? `Không chạy được (${r.status})`)
      load()
    } catch (e) {
      fail(getApiErrorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="card">
      <div className="row" style={{ gap: 8, marginBottom: 8 }}>
        <div className="sec-title" style={{ margin: 0 }}>Chấm hội thoại theo kịch bản</div>
        <select value={data?.week ?? ''} onChange={(e) => setWeek(e.target.value)} style={{ marginLeft: 'auto', width: 150 }}>
          {(data?.weeks ?? []).map((w) => (
            <option key={w} value={w}>Tuần {w}</option>
          ))}
        </select>
        <button className="btn sm" disabled={busy || !data?.aiConfigured} onClick={() => void run()}>Chấm tuần trước ngay</button>
      </div>
      {data && !data.aiConfigured ? <div className="alert wr" style={{ marginBottom: 8 }}>AI chưa cấu hình (thiếu khoá API). Tác vụ chấm tự tắt.</div> : null}
      <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
        Tác vụ nền tự chấm hội thoại tuần trước theo kịch bản đang dùng, chỉ với khách đã đồng ý xử lý dữ liệu. Điểm dùng để kèm cặp, không tự trừ lương.
      </div>
      {!data || data.rows.length === 0 ? (
        <Empty>Chưa có điểm chấm.</Empty>
      ) : (
        <>
          <div className="sec-title">Điểm trung bình theo sale</div>
          <table>
            <thead><tr><th>Sale</th><th>Số hội thoại</th><th>Điểm trung bình</th></tr></thead>
            <tbody>
              {data.summary.map((s) => (
                <tr key={s.userId ?? 'none'}><td>{s.name}</td><td>{s.count}</td><td><b>{s.avgScore}</b></td></tr>
              ))}
            </tbody>
          </table>
          <div className="sec-title">Từng hội thoại (điểm thấp lên trước)</div>
          <table>
            <thead><tr><th>Hội thoại</th><th>Sale</th><th>Điểm</th><th>Nhận xét</th></tr></thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.id} style={{ cursor: 'pointer' }} onClick={() => setOpen(open?.id === r.id ? null : r)}>
                  <td>{r.conversationTitle ?? '-'}</td>
                  <td>{r.userName ?? '-'}</td>
                  <td>{r.status === 'SCORED' ? <b>{r.score}</b> : <span className="muted">lỗi</span>}</td>
                  <td style={{ fontSize: 12.5 }}>
                    {r.summary ?? r.error ?? ''}
                    {open?.id === r.id ? (
                      <ul style={{ margin: '6px 0 0 16px' }}>
                        {r.criteria.map((c, i) => (
                          <li key={i}>{c.name}: {c.score ?? '-'}/10. {c.comment}</li>
                        ))}
                      </ul>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  )
}
