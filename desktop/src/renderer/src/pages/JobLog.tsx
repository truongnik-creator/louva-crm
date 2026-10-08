import React, { useCallback, useEffect, useState } from 'react'
import { getApiErrorMessage } from '../lib/api'
import { fetchJobRuns, fetchJobs, runJobNow, saveSettings, type JobRow, type JobRunRow } from '../lib/api-lo4'
import { useAuth } from '../lib/auth-context'
import { dateTimeVi } from '../lib/format'
import { Empty, useToast } from '../components/ui'

/* F8: CÀI ĐẶT › NHẬT KÝ TÁC VỤ.
   Bật tắt từng quy tắc tự động (lưu vào Cài đặt hệ thống), xem lần chạy gần
   nhất và nhật ký từng lần chạy, bấm chạy ngay để thử. */

const STATUS_STYLE: Record<string, { t: string; bg: string; fg: string }> = {
  SUCCESS: { t: 'Thành công', bg: '#DCFCE7', fg: '#15803D' },
  FAILED: { t: 'Lỗi', bg: '#FEE2E2', fg: '#B91C1C' },
  RUNNING: { t: 'Đang chạy', bg: '#FEF3C7', fg: '#B45309' }
}

function StatusTag({ status }: { status: string }): React.JSX.Element {
  const s = STATUS_STYLE[status] ?? { t: status, bg: '#F1F5F9', fg: '#475569' }
  return (
    <span className="tag" style={{ background: s.bg, color: s.fg }}>
      {s.t}
    </span>
  )
}

export default function JobLog(): React.JSX.Element {
  const { user } = useAuth()
  const { say, fail } = useToast()
  const isAdmin = Boolean(user?.roles.some((r) => r.code === 'QUAN_LY_HE_THONG'))
  const [jobs, setJobs] = useState<JobRow[]>([])
  const [globalEnabled, setGlobalEnabled] = useState(true)
  const [runs, setRuns] = useState<JobRunRow[]>([])
  const [filter, setFilter] = useState('')
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const [j, r] = await Promise.all([fetchJobs(), fetchJobRuns({ jobKey: filter || undefined, limit: 100 })])
      setJobs(j.jobs)
      setGlobalEnabled(j.globalEnabled)
      setRuns(r.items)
    } catch (err) {
      fail(getApiErrorMessage(err))
    }
  }, [filter, fail])

  useEffect(() => {
    void load()
  }, [load])

  const toggle = async (key: string, on: boolean): Promise<void> => {
    try {
      await saveSettings({ [key]: on ? 'true' : 'false' })
      say(on ? 'Đã bật.' : 'Đã tắt.')
      await load()
    } catch (err) {
      fail(getApiErrorMessage(err))
    }
  }

  const runNow = async (job: JobRow): Promise<void> => {
    setBusy(job.key)
    try {
      const r = await runJobNow(job.key)
      if (r.status === 'SUCCESS') say(`Xong: tạo ${r.created ?? 0}. ${r.message ?? ''}`)
      else fail(`Chạy lỗi: ${r.error ?? r.status}`)
      await load()
    } catch (err) {
      fail(getApiErrorMessage(err))
    } finally {
      setBusy(null)
    }
  }

  const labelOf = (key: string): string => jobs.find((j) => j.key === key)?.label ?? key

  return (
    <div>
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="row" style={{ marginBottom: 10 }}>
          <b>Tác vụ nền và quy tắc tự động</b>
          <label className="row" style={{ marginLeft: 'auto', gap: 6, fontSize: 13 }}>
            <input
              type="checkbox"
              checked={globalEnabled}
              disabled={!isAdmin}
              onChange={(e) => void toggle('jobs.enabled', e.target.checked)}
            />
            Bật bộ chạy tác vụ nền
          </label>
        </div>
        {!isAdmin ? (
          <div className="alert wr" style={{ marginBottom: 10 }}>
            Chỉ Quản trị hệ thống bật tắt và chạy tay được. Ngưỡng của từng quy tắc sửa ở Cài đặt hệ thống, nhóm Tự động hoá.
          </div>
        ) : null}
        <table>
          <thead>
            <tr>
              <th>Tác vụ</th>
              <th style={{ width: 90 }}>Chu kỳ</th>
              <th style={{ width: 90 }}>Bật</th>
              <th style={{ width: 200 }}>Lần chạy gần nhất</th>
              <th style={{ width: 120 }} />
            </tr>
          </thead>
          <tbody>
            {jobs.map((j) => (
              <tr key={j.key}>
                <td>
                  {j.label}
                  {!j.enabled && j.switchOn ? <div className="muted" style={{ fontSize: 12 }}>Đang dừng vì bộ chạy nền tắt</div> : null}
                </td>
                <td>{j.intervalMinutes} phút</td>
                <td>
                  {j.settingKey ? (
                    <input
                      type="checkbox"
                      checked={j.switchOn}
                      disabled={!isAdmin}
                      onChange={(e) => void toggle(j.settingKey!, e.target.checked)}
                    />
                  ) : (
                    'Luôn bật'
                  )}
                </td>
                <td>
                  {j.lastRun ? (
                    <>
                      <StatusTag status={j.lastRun.status} /> {dateTimeVi(j.lastRun.startedAt)}
                      <div className="muted" style={{ fontSize: 12 }}>Tạo {j.lastRun.createdCount}</div>
                    </>
                  ) : (
                    <span className="muted">Chưa chạy</span>
                  )}
                </td>
                <td>
                  {isAdmin ? (
                    <button className="btn sec sm" disabled={busy === j.key} onClick={() => void runNow(j)}>
                      {busy === j.key ? 'Đang chạy…' : 'Chạy ngay'}
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <div className="row" style={{ marginBottom: 10 }}>
          <b>Nhật ký chạy</b>
          <select className="input" style={{ marginLeft: 'auto', maxWidth: 360 }} value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="">Tất cả tác vụ</option>
            {jobs.map((j) => (
              <option key={j.key} value={j.key}>
                {j.label}
              </option>
            ))}
          </select>
        </div>
        {runs.length ? (
          <table>
            <thead>
              <tr>
                <th style={{ width: 150 }}>Bắt đầu</th>
                <th>Tác vụ</th>
                <th style={{ width: 100 }}>Kết quả</th>
                <th style={{ width: 70 }}>Tạo</th>
                <th style={{ width: 80 }}>Thời gian</th>
                <th>Ghi chú</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id}>
                  <td>{dateTimeVi(r.startedAt)}</td>
                  <td>
                    {labelOf(r.jobKey)}
                    {r.trigger === 'MANUAL' ? <span className="muted"> (chạy tay)</span> : null}
                  </td>
                  <td>
                    <StatusTag status={r.status} />
                  </td>
                  <td>{r.createdCount}</td>
                  <td>{r.durationMs != null ? `${r.durationMs} ms` : ''}</td>
                  <td style={{ fontSize: 12 }}>{r.error ?? r.message ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty>Chưa có lần chạy nào.</Empty>
        )}
      </div>
    </div>
  )
}
