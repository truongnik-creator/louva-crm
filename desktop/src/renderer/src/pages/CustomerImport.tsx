import React, { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  downloadImportErrors,
  parseImportFile,
  runImport,
  type ImportField,
  type ImportParseResult,
  type ImportReport
} from '../lib/api-nova'
import { getApiErrorMessage } from '../lib/api'
import { useAuth } from '../lib/auth-context'
import { Empty, useToast } from '../components/ui'

/* F4: nạp dữ liệu khách cũ từ Excel, CSV.
   Bước 1 tải tệp · bước 2 ghép cột và xem trước 20 dòng · bước 3 chạy và xem
   báo cáo (tải được tệp các dòng lỗi). Chống trùng theo SĐT đã chuẩn hoá. */

const FIELDS: Array<{ key: ImportField; label: string; required?: boolean }> = [
  { key: 'name', label: 'Tên khách', required: true },
  { key: 'phone', label: 'Số điện thoại' },
  { key: 'branch', label: 'Cơ sở' },
  { key: 'service', label: 'Dịch vụ đã làm' },
  { key: 'serviceDate', label: 'Ngày làm (dd/mm/yyyy)' },
  { key: 'source', label: 'Nguồn' },
  { key: 'note', label: 'Ghi chú' }
]

const MODES: Array<{ key: 'SKIP' | 'MERGE' | 'UPDATE'; label: string; hint: string }> = [
  { key: 'SKIP', label: 'Bỏ qua', hint: 'Số đã có hồ sơ thì bỏ qua dòng đó, không đụng hồ sơ cũ.' },
  { key: 'MERGE', label: 'Gộp', hint: 'Chỉ điền ô còn trống, nối ghi chú và dịch vụ vào hồ sơ cũ.' },
  { key: 'UPDATE', label: 'Cập nhật', hint: 'Ghi đè tên, nguồn theo tệp; ghi chú và dịch vụ được nối thêm.' }
]

export default function CustomerImport(): React.JSX.Element {
  const { user, branchId } = useAuth()
  const { fail, say } = useToast()
  const navigate = useNavigate()
  const [parsed, setParsed] = useState<ImportParseResult | null>(null)
  const [mapping, setMapping] = useState<Record<ImportField, number | null> | null>(null)
  const [mode, setMode] = useState<'SKIP' | 'MERGE' | 'UPDATE'>('SKIP')
  const [defaultBranch, setDefaultBranch] = useState(branchId ?? '')
  const [busy, setBusy] = useState(false)
  const [report, setReport] = useState<ImportReport | null>(null)

  const onFile = async (file: File | undefined): Promise<void> => {
    if (!file) return
    setBusy(true)
    setReport(null)
    try {
      const r = await parseImportFile(file)
      setParsed(r)
      setMapping(r.suggestedMapping)
    } catch (err) {
      fail(getApiErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const run = async (): Promise<void> => {
    if (!parsed || !mapping) return
    if (mapping.name == null) {
      fail('Phải ghép cột Tên khách.')
      return
    }
    if (!window.confirm(`Nhập ${parsed.totalRows} dòng từ ${parsed.fileName}? Cách xử lý trùng SĐT: ${MODES.find((m) => m.key === mode)?.label}.`)) return
    setBusy(true)
    try {
      const r = await runImport({ token: parsed.token, mapping, duplicateMode: mode, defaultBranchId: defaultBranch || undefined })
      setReport(r)
      setParsed(null)
      say(`Đã nhập xong: tạo mới ${r.created}, trùng ${r.duplicates}, lỗi ${r.errors}.`)
    } catch (err) {
      fail(getApiErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const mappedIdx = new Set(Object.values(mapping ?? {}).filter((v): v is number => v != null))

  return (
    <>
      <div className="card" style={{ marginBottom: 12 }}>
        <div className="sec-title">1. Chọn tệp khách cũ</div>
        <input type="file" accept=".xlsx,.csv" disabled={busy} onChange={(e) => void onFile(e.target.files?.[0])} />
        <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
          Nhận Excel .xlsx (trang tính đầu tiên) hoặc .csv. Dòng đầu là tiêu đề cột. Số điện thoại viết kiểu nào cũng được
          (+84, dấu cách, dấu chấm), hệ thống tự chuẩn hoá để chống trùng.
        </div>
      </div>

      {parsed && mapping ? (
        <>
          <div className="card" style={{ marginBottom: 12 }}>
            <div className="sec-title">2. Ghép cột ({parsed.totalRows} dòng trong {parsed.fileName})</div>
            <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 10 }}>
              {FIELDS.map((f) => (
                <div className="field" key={f.key}>
                  <label>
                    {f.label}
                    {f.required ? ' (bắt buộc)' : ''}
                  </label>
                  <select
                    className="input"
                    value={mapping[f.key] ?? ''}
                    onChange={(e) =>
                      setMapping({ ...mapping, [f.key]: e.target.value === '' ? null : Number(e.target.value) })
                    }
                  >
                    <option value="">Không dùng</option>
                    {parsed.headers.map((h, i) => (
                      <option key={i} value={i}>
                        {h}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
              <div className="field">
                <label>Cơ sở mặc định (dòng không ghi cơ sở)</label>
                <select className="input" value={defaultBranch} onChange={(e) => setDefaultBranch(e.target.value)}>
                  {user?.branches.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.shortName ?? b.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="sec-title" style={{ marginTop: 12 }}>Khi số điện thoại đã có hồ sơ</div>
            <div className="row" style={{ gap: 14, flexWrap: 'wrap' }}>
              {MODES.map((m) => (
                <label key={m.key} style={{ fontSize: 13 }}>
                  <input type="radio" name="dup" checked={mode === m.key} onChange={() => setMode(m.key)} /> <b>{m.label}</b>
                  <span className="muted"> · {m.hint}</span>
                </label>
              ))}
            </div>
          </div>

          <div className="card" style={{ marginBottom: 12, overflowX: 'auto' }}>
            <div className="sec-title">Xem trước 20 dòng đầu</div>
            <table>
              <thead>
                <tr>
                  <th>Dòng</th>
                  {parsed.headers.map((h, i) => (
                    <th key={i} style={{ opacity: mappedIdx.has(i) ? 1 : 0.45 }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {parsed.preview.map((row, r) => (
                  <tr key={r}>
                    <td className="muted">{r + 2}</td>
                    {row.map((c, i) => (
                      <td key={i} style={{ opacity: mappedIdx.has(i) ? 1 : 0.45 }}>
                        {c}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="row" style={{ marginTop: 12 }}>
              <button className="btn" style={{ marginLeft: 'auto' }} disabled={busy} onClick={() => void run()}>
                {busy ? 'Đang nhập…' : `3. Nhập ${parsed.totalRows} dòng`}
              </button>
            </div>
          </div>
        </>
      ) : null}

      {report ? (
        <div className="card">
          <div className="sec-title">Kết quả nhập</div>
          <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 10 }}>
            <Stat label="Tổng dòng" value={report.total} />
            <Stat label="Tạo mới" value={report.created} />
            <Stat label="Cập nhật" value={report.updated} />
            <Stat label="Gộp" value={report.merged} />
            <Stat label="Bỏ qua do trùng" value={report.skipped} />
            <Stat label="Lỗi" value={report.errors} danger={report.errors > 0} />
          </div>
          {report.errorRows.length ? (
            <>
              <table style={{ marginTop: 12 }}>
                <thead>
                  <tr>
                    <th>Dòng</th>
                    <th>Lỗi</th>
                  </tr>
                </thead>
                <tbody>
                  {report.errorRows.slice(0, 50).map((e) => (
                    <tr key={e.row}>
                      <td>{e.row}</td>
                      <td>{e.error}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {report.errorFileToken ? (
                <button
                  className="btn sec sm"
                  style={{ marginTop: 8 }}
                  onClick={() => void downloadImportErrors(report.errorFileToken!).catch((err) => fail(getApiErrorMessage(err)))}
                >
                  Tải tệp các dòng lỗi (CSV)
                </button>
              ) : null}
            </>
          ) : null}
          <div className="row" style={{ marginTop: 12 }}>
            <button className="btn sec" onClick={() => navigate('/khach-hang')}>
              Xem danh sách khách
            </button>
          </div>
        </div>
      ) : !parsed ? (
        <div className="card">
          <Empty>Chọn tệp để bắt đầu. Mỗi lần nhập được ghi vào nhật ký hệ thống.</Empty>
        </div>
      ) : null}
    </>
  )
}

function Stat({ label, value, danger }: { label: string; value: number; danger?: boolean }): React.JSX.Element {
  return (
    <div className="card" style={{ padding: 10 }}>
      <div className="muted" style={{ fontSize: 12 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 700, color: danger ? 'var(--danger)' : undefined }}>{value}</div>
    </div>
  )
}
