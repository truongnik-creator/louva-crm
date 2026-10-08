import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { getApiErrorMessage } from '../lib/api'
import {
  createWorkReportSource,
  deleteWorkReportSource,
  fetchWorkReportAppsScript,
  fetchWorkReportEntries,
  fetchWorkReportOverview,
  fetchWorkReportUnlinked,
  previewWorkReportSheet,
  syncWorkReportSource,
  updateWorkReportSource
} from '../lib/api'
import type {
  WorkReportEntry,
  WorkReportOverview,
  WorkReportOverviewRow,
  WorkReportSource,
  WorkTaskStatus
} from '../lib/types'
import { useAuth } from '../lib/auth-context'
import { dateTimeVi, dateVi } from '../lib/format'
import { Empty, Modal, useToast } from '../components/ui'

/* F36: BÁO CÁO CÔNG VIỆC — media, mkt, design, content.

   Mục đích của màn này: KHÔNG phải mở 20 trang tính và đi nhắc gửi link nữa.
   Dữ liệu do Apps Script trong chính trang tính của nhân viên đẩy về, nên trang
   tính vẫn ẩn như cũ.

   Ba phần:
     · Lưới tháng  — mỗi người một dòng, mỗi ngày một ô: thấy ngay ai bỏ trống.
     · Chi tiết    — bấm vào một người để xem từng dòng việc, mở được đúng dòng
                     trong trang tính gốc.
     · Trang tính  — gắn link, lấy mã Apps Script, cấp lại token, ngắt kết nối.
*/

const STATUS_LABEL: Record<WorkTaskStatus, { t: string; bg: string; fg: string }> = {
  DONE: { t: 'Hoàn thành', bg: '#DCFCE7', fg: '#15803D' },
  IN_PROGRESS: { t: 'Đang làm', bg: '#DBEAFE', fg: '#1D4ED8' },
  LATE: { t: 'Trễ', bg: '#FEE2E2', fg: '#B91C1C' },
  PENDING: { t: 'Chưa làm', bg: '#FEF3C7', fg: '#B45309' },
  CANCELLED: { t: 'Huỷ', bg: '#F1F5F9', fg: '#64748B' },
  DAY_OFF: { t: 'Nghỉ', bg: '#EDE9FE', fg: '#6D28D9' },
  UNKNOWN: { t: 'Không rõ', bg: '#F1F5F9', fg: '#475569' }
}

const RATING_LABEL: Record<string, string> = {
  BAD: 'Chưa tốt (<5k)',
  AVERAGE: 'Trung bình (≥5k)',
  GOOD: 'Tốt (≥10k)',
  EXCELLENT: 'Xuất sắc (≥50k)'
}

const SYNC_LABEL: Record<string, { t: string; bg: string; fg: string }> = {
  OK: { t: 'Đang chạy', bg: '#DCFCE7', fg: '#15803D' },
  ERROR: { t: 'Lỗi', bg: '#FEE2E2', fg: '#B91C1C' },
  NEVER: { t: 'Chưa nhận dữ liệu', bg: '#FEF3C7', fg: '#B45309' }
}

function Tag({ s, children }: { s: { bg: string; fg: string }; children: React.ReactNode }): React.JSX.Element {
  return (
    <span className="tag" style={{ background: s.bg, color: s.fg }}>
      {children}
    </span>
  )
}

/** Một ô ngày trong lưới tháng. Màu đọc được không cần chú giải dài. */
function DayCell({
  row,
  dayKey,
  isFuture
}: {
  row: WorkReportOverviewRow
  dayKey: string
  isFuture: boolean
}): React.JSX.Element {
  const cell = row.byDay[dayKey]
  const title = `${dayVi(dayKey)}\n${
    cell
      ? cell.dayOff && !cell.tasks
        ? 'Nghỉ'
        : `${cell.tasks} việc, ${cell.done} hoàn thành`
      : isFuture
        ? 'Chưa tới'
        : 'Chưa ghi việc'
  }`

  let bg = '#F8FAFC'
  let text: React.ReactNode = ''
  if (cell?.dayOff && !cell.tasks) {
    bg = '#EDE9FE'
    text = 'N'
  } else if (cell?.tasks) {
    // Càng nhiều việc càng đậm; hoàn thành hết thì xanh, còn dở thì vàng.
    const full = cell.done >= cell.tasks
    bg = full ? (cell.tasks >= 3 ? '#16A34A' : '#86EFAC') : '#FDE68A'
    text = cell.tasks
  } else if (isFuture) {
    bg = '#FFFFFF'
  } else {
    bg = '#FEE2E2'
    text = '·'
  }

  const dark = bg === '#16A34A'
  return (
    <td
      title={title}
      style={{
        background: bg,
        // Nền ô là màu nhạt CỐ ĐỊNH nên chữ cũng phải cố định: dùng var(--text)
        // thì ở chế độ tối sẽ thành chữ sáng trên nền nhạt, không đọc được.
        color: dark ? '#fff' : '#1F2933',
        textAlign: 'center',
        padding: '2px 0',
        fontSize: 11,
        fontWeight: 600,
        border: '1px solid var(--border)'
      }}
    >
      {text}
    </td>
  )
}

function dayVi(dayKey: string): string {
  const [y, m, d] = dayKey.split('-')
  return `${d}/${m}/${y}`
}

function monthOptions(): number[] {
  return Array.from({ length: 12 }, (_, i) => i + 1)
}

export default function WorkReports(): React.JSX.Element {
  const { can } = useAuth()
  const { say, fail } = useToast()
  const canManage = can('work_report.manage_source')
  const canSync = can('work_report.sync')

  const now = new Date()
  const [year, setYear] = useState(now.getFullYear())
  const [month, setMonth] = useState(now.getMonth() + 1)
  const [overview, setOverview] = useState<WorkReportOverview | null>(null)
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<'grid' | 'sources'>('grid')

  const [detailOf, setDetailOf] = useState<WorkReportOverviewRow | null>(null)
  const [entries, setEntries] = useState<WorkReportEntry[]>([])
  const [entriesLoading, setEntriesLoading] = useState(false)

  const [linkFor, setLinkFor] = useState<{ id: string; name: string } | null>(null)
  const [script, setScript] = useState<{ name: string; code: string } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setOverview(await fetchWorkReportOverview({ year, month }))
    } catch (err) {
      fail(getApiErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }, [year, month, fail])

  useEffect(() => {
    void load()
  }, [load])

  const openDetail = async (row: WorkReportOverviewRow): Promise<void> => {
    setDetailOf(row)
    setEntriesLoading(true)
    try {
      const r = await fetchWorkReportEntries({ userId: row.source.userId, year, month, limit: 500 })
      setEntries(r.entries)
    } catch (err) {
      fail(getApiErrorMessage(err))
    } finally {
      setEntriesLoading(false)
    }
  }

  const getScript = async (source: WorkReportSource): Promise<void> => {
    setBusy(source.id)
    try {
      const code = await fetchWorkReportAppsScript(source.id)
      setScript({ name: source.user.name, code })
      await load()
    } catch (err) {
      fail(getApiErrorMessage(err))
    } finally {
      setBusy(null)
    }
  }

  const pull = async (source: WorkReportSource): Promise<void> => {
    setBusy(source.id)
    try {
      const r = await syncWorkReportSource(source.id, [month])
      if (r.errors.length) fail(r.errors.join(' | '))
      else say(`Đã kéo ${r.entries} dòng việc từ ${r.tabs} sheet.`)
      await load()
    } catch (err) {
      fail(getApiErrorMessage(err))
    } finally {
      setBusy(null)
    }
  }

  const unlink = async (source: WorkReportSource): Promise<void> => {
    if (
      !window.confirm(
        `Ngắt trang tính của ${source.user.name}?\n\nTrang tính trên Google KHÔNG bị xoá, nhưng ${source.rowCount} dòng việc đã đồng bộ vào CRM sẽ bị xoá và Apps Script trong trang tính sẽ nhận lỗi 401.`
      )
    ) {
      return
    }
    setBusy(source.id)
    try {
      await deleteWorkReportSource(source.id)
      say('Đã ngắt kết nối.')
      await load()
    } catch (err) {
      fail(getApiErrorMessage(err))
    } finally {
      setBusy(null)
    }
  }

  const toggleActive = async (source: WorkReportSource): Promise<void> => {
    setBusy(source.id)
    try {
      await updateWorkReportSource(source.id, { active: !source.active })
      await load()
    } catch (err) {
      fail(getApiErrorMessage(err))
    } finally {
      setBusy(null)
    }
  }

  const rows = overview?.rows ?? []
  const days = overview?.days ?? []

  const kpis = useMemo(() => {
    const s = overview?.summary
    return [
      { label: 'Nhân viên đã gắn trang tính', value: s?.people ?? 0 },
      { label: 'Việc trong tháng', value: s?.tasks ?? 0 },
      { label: 'Đã hoàn thành', value: s?.done ?? 0 },
      { label: 'Ngày bỏ trống báo cáo', value: s?.daysMissing ?? 0, warn: (s?.daysMissing ?? 0) > 0 },
      { label: 'Nguồn đang lỗi', value: (s?.syncErrors ?? 0) + (s?.neverSynced ?? 0), warn: true }
    ]
  }, [overview])

  return (
    <div>
      {/* ------------------------------------------------------------ ĐẦU TRANG */}
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
          <b>Báo cáo công việc theo trang tính</b>
          <div className="row" style={{ gap: 6, marginLeft: 'auto' }}>
            <select className="input" style={{ maxWidth: 110 }} value={month} onChange={(e) => setMonth(Number(e.target.value))}>
              {monthOptions().map((m) => (
                <option key={m} value={m}>
                  Tháng {m}
                </option>
              ))}
            </select>
            <select className="input" style={{ maxWidth: 100 }} value={year} onChange={(e) => setYear(Number(e.target.value))}>
              {[year - 1, year, year + 1].map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
            <button className="btn sec sm" onClick={() => void load()}>
              Tải lại
            </button>
          </div>
        </div>

        <div className="row" style={{ gap: 18, marginTop: 12, flexWrap: 'wrap' }}>
          {kpis.map((k) => (
            <div key={k.label}>
              <div className="muted" style={{ fontSize: 12 }}>
                {k.label}
              </div>
              <div style={{ fontSize: 22, fontWeight: 700, color: k.warn && k.value > 0 ? '#B91C1C' : undefined }}>
                {k.value}
              </div>
            </div>
          ))}
        </div>

        <div className="row" style={{ gap: 6, marginTop: 12 }}>
          <button className={`btn ${tab === 'grid' ? '' : 'sec'} sm`} onClick={() => setTab('grid')}>
            Lưới tháng
          </button>
          <button className={`btn ${tab === 'sources' ? '' : 'sec'} sm`} onClick={() => setTab('sources')}>
            Trang tính &amp; kết nối
          </button>
        </div>
      </div>

      {/* Nhân viên khối báo cáo chưa gắn trang tính — nửa còn lại của tiến độ:
          không thấy ai trống nghĩa là không biết mình đang thiếu báo cáo của ai. */}
      {overview?.unlinked.length ? (
        <div className="alert wr" style={{ marginBottom: 14 }}>
          <b>{overview.unlinked.length} nhân viên chưa gắn trang tính:</b>{' '}
          {overview.unlinked.map((u) => `${u.name}${u.department ? ` (${u.department.name})` : ''}`).join(', ')}.
          {canManage ? ' Mở thẻ “Trang tính & kết nối” để gắn.' : ''}
        </div>
      ) : null}

      {loading ? (
        <div className="card">
          <Empty>Đang tải…</Empty>
        </div>
      ) : tab === 'grid' ? (
        <div className="card">
          {!rows.length ? (
            <Empty>
              Chưa có trang tính nào được gắn. {canManage ? 'Mở thẻ “Trang tính & kết nối” để bắt đầu.' : ''}
            </Empty>
          ) : (
            <>
              <div className="row muted" style={{ fontSize: 12, gap: 14, marginBottom: 10, flexWrap: 'wrap' }}>
                <span>
                  <span style={{ display: 'inline-block', width: 12, height: 12, background: '#16A34A', marginRight: 4 }} />
                  xong hết (≥3 việc)
                </span>
                <span>
                  <span style={{ display: 'inline-block', width: 12, height: 12, background: '#86EFAC', marginRight: 4 }} />
                  xong hết
                </span>
                <span>
                  <span style={{ display: 'inline-block', width: 12, height: 12, background: '#FDE68A', marginRight: 4 }} />
                  còn việc dở
                </span>
                <span>
                  <span style={{ display: 'inline-block', width: 12, height: 12, background: '#EDE9FE', marginRight: 4 }} />
                  nghỉ
                </span>
                <span>
                  <span style={{ display: 'inline-block', width: 12, height: 12, background: '#FEE2E2', marginRight: 4 }} />
                  chưa ghi việc
                </span>
              </div>

              <div style={{ overflowX: 'auto' }}>
                <table style={{ minWidth: 980 }}>
                  <thead>
                    <tr>
                      <th style={{ minWidth: 180, position: 'sticky', left: 0, background: 'var(--surface)' }}>Nhân viên</th>
                      {days.map((d) => (
                        <th key={d.dayKey} style={{ width: 22, textAlign: 'center', fontSize: 11, padding: '4px 0' }}>
                          {d.day}
                        </th>
                      ))}
                      <th style={{ width: 62, textAlign: 'right' }}>Việc</th>
                      <th style={{ width: 62, textAlign: 'right' }}>Xong</th>
                      <th style={{ width: 54, textAlign: 'right' }}>Công</th>
                      <th style={{ width: 70, textAlign: 'right' }}>Trống</th>
                      <th style={{ width: 150 }}>Kết nối</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.source.id}>
                        <td style={{ position: 'sticky', left: 0, background: 'var(--surface)' }}>
                          <button
                            onClick={() => void openDetail(r)}
                            style={{
                              background: 'none',
                              border: 0,
                              padding: 0,
                              color: 'var(--green-700)',
                              font: 'inherit',
                              fontWeight: 600,
                              cursor: 'pointer',
                              textAlign: 'left'
                            }}
                          >
                            {r.source.user.name}
                          </button>
                          <div className="muted" style={{ fontSize: 11 }}>
                            {r.source.user.department?.name ?? 'Chưa gán bộ phận'}
                          </div>
                        </td>
                        {days.map((d) => (
                          <DayCell key={d.dayKey} row={r} dayKey={d.dayKey} isFuture={d.isFuture} />
                        ))}
                        <td style={{ textAlign: 'right' }}>{r.totals.tasks}</td>
                        <td style={{ textAlign: 'right' }}>{r.totals.DONE}</td>
                        <td style={{ textAlign: 'right' }}>{r.dayCredit ?? '—'}</td>
                        <td style={{ textAlign: 'right', color: r.daysMissing ? '#B91C1C' : undefined, fontWeight: r.daysMissing ? 700 : 400 }}>
                          {r.daysMissing}
                        </td>
                        <td>
                          <Tag s={SYNC_LABEL[r.source.lastSyncStatus] ?? SYNC_LABEL.NEVER}>
                            {(SYNC_LABEL[r.source.lastSyncStatus] ?? SYNC_LABEL.NEVER).t}
                          </Tag>
                          <div className="muted" style={{ fontSize: 11 }}>
                            {r.source.lastSyncAt ? dateTimeVi(r.source.lastSyncAt) : 'chưa lần nào'}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      ) : (
        <SourcesCard
          rows={rows}
          canManage={canManage}
          canSync={canSync}
          busy={busy}
          onLink={() => setLinkFor({ id: '', name: '' })}
          onScript={getScript}
          onPull={pull}
          onUnlink={unlink}
          onToggle={toggleActive}
        />
      )}

      {detailOf ? (
        <DetailModal
          row={detailOf}
          entries={entries}
          loading={entriesLoading}
          year={year}
          month={month}
          onClose={() => setDetailOf(null)}
        />
      ) : null}

      {linkFor ? (
        <LinkModal
          onClose={() => setLinkFor(null)}
          onDone={async (name) => {
            setLinkFor(null)
            say(`Đã gắn trang tính cho ${name}. Bấm “Lấy mã Apps Script” rồi dán vào trang tính đó.`)
            await load()
          }}
        />
      ) : null}

      {script ? <ScriptModal name={script.name} code={script.code} onClose={() => setScript(null)} /> : null}
    </div>
  )
}

/* ------------------------------------------------------- TRANG TÍNH & KẾT NỐI */

function SourcesCard({
  rows,
  canManage,
  canSync,
  busy,
  onLink,
  onScript,
  onPull,
  onUnlink,
  onToggle
}: {
  rows: WorkReportOverviewRow[]
  canManage: boolean
  canSync: boolean
  busy: string | null
  onLink: () => void
  onScript: (s: WorkReportSource) => Promise<void>
  onPull: (s: WorkReportSource) => Promise<void>
  onUnlink: (s: WorkReportSource) => Promise<void>
  onToggle: (s: WorkReportSource) => Promise<void>
}): React.JSX.Element {
  return (
    <div className="card">
      <div className="row" style={{ marginBottom: 10 }}>
        <b>Trang tính của từng nhân viên</b>
        {canManage ? (
          <button className="btn sm" style={{ marginLeft: 'auto' }} onClick={onLink}>
            + Gắn trang tính
          </button>
        ) : null}
      </div>

      <div className="alert" style={{ marginBottom: 12 }}>
        <b>Trang tính ẩn vẫn chạy được.</b> Chế độ <b>ĐẨY</b> dùng Apps Script nằm trong chính trang tính, chạy bằng quyền
        của chủ trang tính — không phải chia sẻ công khai, không phải cấp quyền cho CRM. Chế độ <b>KÉO</b> chỉ dùng được khi
        trang tính đã chia sẻ “bất kỳ ai có liên kết”.
      </div>

      {!rows.length ? (
        <Empty>Chưa gắn trang tính nào.</Empty>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Nhân viên</th>
              <th style={{ width: 90 }}>Chế độ</th>
              <th style={{ width: 150 }}>Trạng thái</th>
              <th style={{ width: 110 }}>Sheet / Dòng</th>
              <th style={{ width: 130 }}>Việc gần nhất</th>
              <th style={{ width: 280 }} />
            </tr>
          </thead>
          <tbody>
            {rows.map(({ source: s }) => (
              <tr key={s.id} style={{ opacity: s.active ? 1 : 0.55 }}>
                <td>
                  <div>
                    {s.user.name}
                    {!s.active ? <span className="muted"> · đã tắt</span> : null}
                  </div>
                  <div className="muted" style={{ fontSize: 11 }}>
                    {s.user.department?.name ?? 'Chưa gán bộ phận'} ·{' '}
                    <a href={s.url} target="_blank" rel="noreferrer">
                      {s.title ?? 'Mở trang tính'}
                    </a>{' '}
                    · năm {s.year}
                  </div>
                </td>
                <td>{s.syncMode === 'PUSH' ? 'Đẩy' : 'Kéo'}</td>
                <td>
                  <Tag s={SYNC_LABEL[s.lastSyncStatus] ?? SYNC_LABEL.NEVER}>
                    {(SYNC_LABEL[s.lastSyncStatus] ?? SYNC_LABEL.NEVER).t}
                  </Tag>
                  {s.lastSyncError ? (
                    <div style={{ fontSize: 11, color: '#B91C1C', marginTop: 2 }}>{s.lastSyncError}</div>
                  ) : (
                    <div className="muted" style={{ fontSize: 11 }}>
                      {s.lastSyncAt ? dateTimeVi(s.lastSyncAt) : 'chưa nhận dữ liệu'}
                    </div>
                  )}
                  {s.hasToken ? (
                    <div className="muted" style={{ fontSize: 11 }}>
                      token {s.tokenPrefix}… {s.tokenLastUsedAt ? `· dùng ${dateTimeVi(s.tokenLastUsedAt)}` : '· chưa dùng'}
                    </div>
                  ) : (
                    <div style={{ fontSize: 11, color: '#B45309' }}>chưa có token</div>
                  )}
                </td>
                <td>
                  {s.tabs.filter((t) => t.month !== null).length}/12 · {s.rowCount}
                </td>
                <td>{s.lastEntryDate ? dateVi(s.lastEntryDate) : <span className="muted">—</span>}</td>
                <td>
                  <div className="row" style={{ gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                    {canManage ? (
                      <button className="btn sec sm" disabled={busy === s.id} onClick={() => void onScript(s)}>
                        Lấy mã Apps Script
                      </button>
                    ) : null}
                    {canSync && s.syncMode === 'PULL' ? (
                      <button className="btn sec sm" disabled={busy === s.id} onClick={() => void onPull(s)}>
                        {busy === s.id ? 'Đang kéo…' : 'Kéo ngay'}
                      </button>
                    ) : null}
                    {canManage ? (
                      <>
                        <button className="btn sec sm" disabled={busy === s.id} onClick={() => void onToggle(s)}>
                          {s.active ? 'Tắt' : 'Bật'}
                        </button>
                        <button className="btn danger sm" disabled={busy === s.id} onClick={() => void onUnlink(s)}>
                          Ngắt
                        </button>
                      </>
                    ) : null}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

/* -------------------------------------------------------------- CHI TIẾT */

function DetailModal({
  row,
  entries,
  loading,
  year,
  month,
  onClose
}: {
  row: WorkReportOverviewRow
  entries: WorkReportEntry[]
  loading: boolean
  year: number
  month: number
  onClose: () => void
}): React.JSX.Element {
  const [status, setStatus] = useState<'' | WorkTaskStatus>('')
  const shown = entries.filter((e) => !status || e.statusCode === status)

  return (
    <Modal title={`${row.source.user.name} · tháng ${month}/${year}`} onClose={onClose} width={1100}>
      <div className="row" style={{ gap: 18, marginBottom: 12, flexWrap: 'wrap' }}>
        <div>
          <div className="muted" style={{ fontSize: 12 }}>
            Việc / Hoàn thành
          </div>
          <div style={{ fontSize: 18, fontWeight: 700 }}>
            {row.totals.tasks} / {row.totals.DONE}
          </div>
        </div>
        <div>
          <div className="muted" style={{ fontSize: 12 }}>
            Số công
          </div>
          <div style={{ fontSize: 18, fontWeight: 700 }}>{row.dayCredit ?? '—'}</div>
        </div>
        <div>
          <div className="muted" style={{ fontSize: 12 }}>
            Ngày có báo cáo / nghỉ / bỏ trống
          </div>
          <div style={{ fontSize: 18, fontWeight: 700 }}>
            {row.daysReported} / {row.daysOff} /{' '}
            <span style={{ color: row.daysMissing ? '#B91C1C' : undefined }}>{row.daysMissing}</span>
          </div>
        </div>
        <div>
          <div className="muted" style={{ fontSize: 12 }}>
            Đánh giá bài đăng
          </div>
          <div style={{ fontSize: 13 }}>
            {Object.entries(row.ratings)
              .filter(([, n]) => n > 0)
              .map(([k, n]) => `${RATING_LABEL[k] ?? k}: ${n}`)
              .join(' · ') || '—'}
          </div>
        </div>
        <div>
          <div className="muted" style={{ fontSize: 12 }}>
            Kênh
          </div>
          <div style={{ fontSize: 13 }}>{row.channels.map((c) => `${c.name} ${c.count}`).join(' · ') || '—'}</div>
        </div>
      </div>

      <div className="row" style={{ gap: 6, marginBottom: 10 }}>
        <select className="input" style={{ maxWidth: 180 }} value={status} onChange={(e) => setStatus(e.target.value as WorkTaskStatus | '')}>
          <option value="">Mọi tiến độ</option>
          {(Object.keys(STATUS_LABEL) as WorkTaskStatus[]).map((k) => (
            <option key={k} value={k}>
              {STATUS_LABEL[k].t}
            </option>
          ))}
        </select>
        <span className="muted" style={{ fontSize: 12, marginLeft: 'auto' }}>
          {shown.length} dòng · bấm số dòng để mở đúng chỗ trong trang tính
        </span>
      </div>

      {loading ? (
        <Empty>Đang tải…</Empty>
      ) : !shown.length ? (
        <Empty>Không có dòng việc nào.</Empty>
      ) : (
        <div style={{ maxHeight: '52vh', overflowY: 'auto' }}>
          <table>
            <thead>
              <tr>
                <th style={{ width: 86 }}>Ngày</th>
                <th style={{ width: 80 }}>Kênh</th>
                <th>Công việc</th>
                <th style={{ width: 110 }}>Tiến độ</th>
                <th style={{ width: 120 }}>Đánh giá</th>
                <th style={{ width: 90 }}>Kết quả</th>
                <th style={{ width: 54 }}>Dòng</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((e) => (
                <tr key={e.id}>
                  <td>
                    {e.dayKey ? dayVi(e.dayKey) : <span className="muted">—</span>}
                    {e.weekday ? (
                      <div className="muted" style={{ fontSize: 11 }}>
                        {e.weekday}
                      </div>
                    ) : null}
                  </td>
                  <td>{e.channel ?? <span className="muted">—</span>}</td>
                  <td>
                    {e.taskName ?? <span className="muted">(chưa ghi việc)</span>}
                    {e.note ? (
                      <div className="muted" style={{ fontSize: 11 }}>
                        {e.note}
                      </div>
                    ) : null}
                  </td>
                  <td>
                    <Tag s={STATUS_LABEL[e.statusCode]}>{STATUS_LABEL[e.statusCode].t}</Tag>
                  </td>
                  <td style={{ fontSize: 12 }}>{e.ratingCode ? RATING_LABEL[e.ratingCode] : <span className="muted">—</span>}</td>
                  <td>
                    {e.linkUrl ? (
                      <a href={e.linkUrl} target="_blank" rel="noreferrer">
                        {e.linkText || 'Mở'}
                      </a>
                    ) : e.linkText ? (
                      /* Chế độ kéo chỉ nhận được CHỮ của ô ("Link"), mất URL. */
                      <span className="muted" title="Chế độ kéo không lấy được đường dẫn — chuyển sang chế độ đẩy để có link">
                        {e.linkText}
                      </span>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td>
                    <a href={e.sheetUrl} target="_blank" rel="noreferrer">
                      {e.rowIndex}
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  )
}

/* --------------------------------------------------------- GẮN TRANG TÍNH */

function LinkModal({
  onClose,
  onDone
}: {
  onClose: () => void
  onDone: (name: string) => Promise<void>
}): React.JSX.Element {
  const { fail } = useToast()
  const [people, setPeople] = useState<Array<{ id: string; name: string; department: { name: string } | null }>>([])
  const [userId, setUserId] = useState('')
  const [url, setUrl] = useState('')
  const [year, setYear] = useState(new Date().getFullYear())
  const [mode, setMode] = useState<'PUSH' | 'PULL'>('PUSH')
  const [preview, setPreview] = useState<{ title: string | null; tabs: Array<{ name: string; month: number | null }> } | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    fetchWorkReportUnlinked()
      .then(setPeople)
      .catch((err) => fail(getApiErrorMessage(err)))
  }, [fail])

  const tryPreview = async (): Promise<void> => {
    setBusy(true)
    try {
      const r = await previewWorkReportSheet(url)
      setPreview({ title: r.title, tabs: r.tabs })
    } catch (err) {
      setPreview(null)
      fail(getApiErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const submit = async (): Promise<void> => {
    setBusy(true)
    try {
      const r = await createWorkReportSource({ userId, url, year, syncMode: mode })
      await onDone(r.source.user.name)
    } catch (err) {
      fail(getApiErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title="Gắn trang tính báo cáo cho nhân viên"
      onClose={onClose}
      width={660}
      footer={
        <>
          <button className="btn sec" onClick={onClose}>
            Huỷ
          </button>
          <button className="btn" disabled={busy || !userId || !url} onClick={() => void submit()}>
            {busy ? 'Đang lưu…' : 'Gắn trang tính'}
          </button>
        </>
      }
    >
      <div className="pf" style={{ marginBottom: 10 }}>
        <div className="pl">Nhân viên</div>
        <select className="input" value={userId} onChange={(e) => setUserId(e.target.value)}>
          <option value="">— Chọn nhân viên —</option>
          {people.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
              {p.department ? ` · ${p.department.name}` : ''}
            </option>
          ))}
        </select>
        {!people.length ? (
          <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
            Mọi nhân viên của Media / MKT / Design / Content đã có trang tính. Thêm người mới ở Người dùng &amp; Phân quyền
            rồi gán bộ phận tương ứng.
          </div>
        ) : null}
      </div>

      <div className="pf" style={{ marginBottom: 10 }}>
        <div className="pl">Liên kết trang tính</div>
        <div className="row" style={{ gap: 6 }}>
          <input
            className="input"
            placeholder="https://docs.google.com/spreadsheets/d/..."
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
          <button className="btn sec sm" disabled={busy || !url} onClick={() => void tryPreview()}>
            Thử đọc
          </button>
        </div>
        <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
          “Thử đọc” chỉ chạy được với trang tính đã chia sẻ công khai. Trang tính ẩn thì bỏ qua bước này — dùng chế độ đẩy.
        </div>
        {preview ? (
          <div className="alert" style={{ marginTop: 8 }}>
            <b>{preview.title ?? 'Trang tính'}</b> — {preview.tabs.filter((t) => t.month !== null).length} sheet tháng:{' '}
            {preview.tabs.map((t) => t.name).join(', ')}
          </div>
        ) : null}
      </div>

      <div className="row" style={{ gap: 10 }}>
        <div className="pf" style={{ flex: 1 }}>
          <div className="pl">12 sheet T1..T12 là năm nào</div>
          <input className="input" type="number" value={year} onChange={(e) => setYear(Number(e.target.value))} />
        </div>
        <div className="pf" style={{ flex: 1 }}>
          <div className="pl">Cách lấy dữ liệu</div>
          <select className="input" value={mode} onChange={(e) => setMode(e.target.value as 'PUSH' | 'PULL')}>
            <option value="PUSH">Đẩy — Apps Script trong trang tính (trang tính ẩn)</option>
            <option value="PULL">Kéo — CRM tự đọc (trang tính công khai)</option>
          </select>
        </div>
      </div>
    </Modal>
  )
}

/* ------------------------------------------------------- MÃ APPS SCRIPT */

function ScriptModal({ name, code, onClose }: { name: string; code: string; onClose: () => void }): React.JSX.Element {
  const { say, fail } = useToast()
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(code)
      say('Đã copy. Dán vào Apps Script của trang tính rồi chạy hàm setup().')
    } catch {
      fail('Không copy được — bấm vào ô mã rồi Ctrl+A, Ctrl+C.')
    }
  }

  return (
    <Modal
      title={`Mã Apps Script — ${name}`}
      onClose={onClose}
      width={880}
      footer={
        <>
          <button className="btn sec" onClick={onClose}>
            Đóng
          </button>
          <button className="btn" onClick={() => void copy()}>
            Copy mã
          </button>
        </>
      }
    >
      <div className="alert wr" style={{ marginBottom: 10 }}>
        <b>Mã này chứa token và chỉ hiện một lần.</b> Mỗi lần mở lại là CẤP TOKEN MỚI và token cũ chết ngay — nên hãy dán
        xong mới đóng. Không gửi mã này qua nhóm chat chung.
      </div>
      <ol style={{ margin: '0 0 10px 18px', fontSize: 13, lineHeight: 1.7 }}>
        <li>Mở trang tính của {name} › <b>Tiện ích mở rộng › Apps Script</b>.</li>
        <li>Xoá hết mã đang có, dán mã bên dưới vào.</li>
        <li>
          Chọn hàm <code>setup</code> ở thanh trên rồi bấm <b>Chạy</b>, chấp nhận cấp quyền khi Google hỏi.
        </li>
        <li>Quay lại màn này bấm “Tải lại” — trạng thái phải chuyển sang “Đang chạy”.</li>
      </ol>
      <textarea
        className="input"
        readOnly
        value={code}
        onFocus={(e) => e.currentTarget.select()}
        style={{ height: '46vh', fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 12, whiteSpace: 'pre' }}
      />
    </Modal>
  )
}
