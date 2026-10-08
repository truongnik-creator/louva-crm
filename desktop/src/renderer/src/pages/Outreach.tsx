import React, { useCallback, useEffect, useState } from 'react'
import { fetchServices, getApiErrorMessage } from '../lib/api'
import {
  cancelBroadcast,
  createBroadcast,
  fetchBroadcasts,
  fetchRecipients,
  fetchSegments,
  previewSegment,
  saveSegment,
  type BroadcastRow,
  type RecipientRow,
  type SegmentFilter,
  type SegmentPreview,
  type SegmentRow
} from '../lib/api-lo4'
import { dateTimeVi, relativeVi } from '../lib/format'
import { Empty, Modal, useToast } from '../components/ui'
import type { Service } from '../lib/types'

/* F11: NHÓM KHÁCH VÀ GỬI THEO KỊCH BẢN.
   Lọc nhóm (im lặng, đã làm dịch vụ, sắp tái tiêm, sinh nhật), xem trước, soạn
   tin có biến {{...}}, đưa vào hàng đợi. Hàng đợi gửi dần theo giới hạn mỗi giờ;
   khách từ chối nhận tin bị loại; khách Facebook ngoài 24 giờ thì tạo việc cho sale. */

const STATUS_LABEL: Record<string, string> = {
  QUEUED: 'Chờ gửi',
  RUNNING: 'Đang gửi',
  DONE: 'Xong',
  CANCELLED: 'Đã dừng',
  PENDING: 'Chờ',
  SENT: 'Đã gửi',
  FAILED: 'Lỗi',
  SKIPPED_OPT_OUT: 'Khách từ chối nhận',
  TASK_CREATED: 'Tạo việc cho sale'
}

export default function Outreach(): React.JSX.Element {
  const { say, fail } = useToast()
  const [services, setServices] = useState<Service[]>([])
  const [segments, setSegments] = useState<SegmentRow[]>([])
  const [broadcasts, setBroadcasts] = useState<BroadcastRow[]>([])
  const [filter, setFilter] = useState<SegmentFilter>({ silentDays: 60 })
  const [preview, setPreview] = useState<SegmentPreview | null>(null)
  const [name, setName] = useState('')
  const [template, setTemplate] = useState('Chào {{ten_khach}}, lâu rồi {{co_so}} chưa gặp mình. Em gửi mình thông tin mới nhất ạ.')
  const [log, setLog] = useState<{ b: BroadcastRow; rows: RecipientRow[] } | null>(null)

  const load = useCallback(async () => {
    try {
      const [s, b] = await Promise.all([fetchSegments(), fetchBroadcasts()])
      setSegments(s)
      setBroadcasts(b)
    } catch (err) {
      fail(getApiErrorMessage(err))
    }
  }, [fail])

  useEffect(() => {
    void load()
    fetchServices().then(setServices).catch(() => undefined)
  }, [load])

  const setNum = (key: keyof SegmentFilter, v: string): void =>
    setFilter((f) => ({ ...f, [key]: v === '' ? undefined : Number(v) }))

  const doPreview = async (): Promise<void> => {
    try {
      setPreview(await previewSegment(filter))
    } catch (err) {
      fail(getApiErrorMessage(err))
    }
  }

  const send = async (): Promise<void> => {
    try {
      const r = await createBroadcast({ name, template, filter })
      say(`Đã đưa ${r.queued} khách vào hàng đợi (${r.optOut} khách từ chối nhận tin bị loại).`)
      setName('')
      void load()
    } catch (err) {
      fail(getApiErrorMessage(err))
    }
  }

  return (
    <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
      <div className="card" style={{ flex: 1, minWidth: 380 }}>
        <div className="sec-title">1. Chọn nhóm khách</div>
        {segments.length ? (
          <div className="field">
            <label>Nhóm đã lưu</label>
            <select className="input" value="" onChange={(e) => {
              const s = segments.find((x) => x.id === e.target.value)
              if (s) setFilter(s.filter)
            }}>
              <option value="">Chọn nhóm đã lưu</option>
              {segments.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
        ) : null}
        <div className="field">
          <label>Im lặng quá (ngày)</label>
          <input className="input" type="number" min={1} value={filter.silentDays ?? ''} onChange={(e) => setNum('silentDays', e.target.value)} />
        </div>
        <div className="field">
          <label>Đã làm dịch vụ</label>
          <select className="input" value={filter.serviceIds?.[0] ?? (filter.servedAny ? '*' : '')} onChange={(e) => {
            const v = e.target.value
            setFilter((f) => ({ ...f, serviceIds: v && v !== '*' ? [v] : undefined, servedAny: v === '*' ? true : undefined }))
          }}>
            <option value="">Không lọc</option>
            <option value="*">Dịch vụ bất kỳ</option>
            {services.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
        <div className="field">
          <label>Sắp đến mốc tái tiêm trong (ngày)</label>
          <input className="input" type="number" min={0} value={filter.retreatWithinDays ?? ''} onChange={(e) => setNum('retreatWithinDays', e.target.value)} />
        </div>
        <div className="field">
          <label>Sinh nhật trong tháng</label>
          <select className="input" value={filter.birthdayMonth ?? ''} onChange={(e) => setNum('birthdayMonth', e.target.value)}>
            <option value="">Không lọc</option>
            <option value="0">Tháng này</option>
            {Array.from({ length: 12 }, (_, i) => <option key={i + 1} value={i + 1}>Tháng {i + 1}</option>)}
          </select>
        </div>
        <div className="row" style={{ gap: 6 }}>
          <button className="btn sec" onClick={() => void doPreview()}>Xem trước</button>
          <button className="btn sec" onClick={async () => {
            const n = window.prompt('Tên nhóm khách:')
            if (!n) return
            try {
              await saveSegment(n, filter)
              say('Đã lưu nhóm.')
              void load()
            } catch (err) {
              fail(getApiErrorMessage(err))
            }
          }}>Lưu nhóm</button>
        </div>
        {preview ? (
          <div style={{ marginTop: 10 }}>
            <div className="alert ok">
              {preview.total} khách, {preview.optOut} khách từ chối nhận tin (bị loại), sẽ gửi {preview.willSend}.
              {preview.capped ? ' Nhóm lớn, chỉ lấy 5.000 khách đầu.' : ''}
            </div>
            <table>
              <tbody>
                {preview.sample.map((m) => (
                  <tr key={m.id}>
                    <td>{m.name}</td>
                    <td className="muted">{m.phone ?? ''}</td>
                    <td className="muted">{m.lastContactAt ? relativeVi(m.lastContactAt) : 'Chưa liên hệ'}</td>
                    <td>{m.optOut ? 'Từ chối nhận' : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>

      <div className="card" style={{ flex: 1, minWidth: 380 }}>
        <div className="sec-title">2. Soạn tin theo mẫu</div>
        <div className="field">
          <label>Tên đợt gửi</label>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Chăm lại khách im lặng tháng 10" />
        </div>
        <div className="field">
          <label>Nội dung (biến như {'{{ten_khach}}'}, {'{{co_so}}'}, {'{{ban_do}}'} tự điền theo từng khách)</label>
          <textarea className="input" rows={6} value={template} onChange={(e) => setTemplate(e.target.value)} />
        </div>
        <div className="alert wr" style={{ marginBottom: 8 }}>
          Tin gửi dần theo giới hạn mỗi giờ trong Cài đặt. Khách Facebook nhắn lần cuối quá 24 giờ sẽ không được tự gửi: hệ thống tạo việc cho sale phụ trách.
        </div>
        <button className="btn" disabled={name.trim().length < 2 || template.trim().length < 2} onClick={() => void send()}>
          Đưa vào hàng đợi gửi
        </button>

        <div className="sec-title" style={{ marginTop: 16 }}>Các đợt gửi</div>
        {!broadcasts.length ? (
          <Empty>Chưa có đợt gửi nào.</Empty>
        ) : (
          <table>
            <tbody>
              {broadcasts.map((b) => (
                <tr key={b.id}>
                  <td>
                    <b>{b.name}</b>
                    <div className="muted" style={{ fontSize: 11.5 }}>
                      {dateTimeVi(b.createdAt)} · {b.createdByName ?? ''}
                    </div>
                  </td>
                  <td>{STATUS_LABEL[b.status] ?? b.status}</td>
                  <td style={{ fontSize: 12 }}>
                    {Object.entries(b.counts).map(([k, v]) => `${STATUS_LABEL[k] ?? k}: ${v}`).join(' · ')}
                  </td>
                  <td>
                    <button className="btn sec sm" onClick={async () => setLog({ b, rows: (await fetchRecipients(b.id)).items })}>Nhật ký</button>
                    {b.status === 'QUEUED' || b.status === 'RUNNING' ? (
                      <button className="btn sec sm" style={{ marginLeft: 4 }} onClick={async () => {
                        await cancelBroadcast(b.id)
                        void load()
                      }}>Dừng</button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {log ? (
        <Modal title={`Nhật ký gửi: ${log.b.name}`} onClose={() => setLog(null)} width={820}>
          <table>
            <thead>
              <tr>
                <th>Khách</th>
                <th>Trạng thái</th>
                <th>Nội dung</th>
                <th>Lúc gửi</th>
              </tr>
            </thead>
            <tbody>
              {log.rows.map((r) => (
                <tr key={r.id}>
                  <td>{r.customer?.name ?? ''}</td>
                  <td>{STATUS_LABEL[r.status] ?? r.status}{r.error ? <div className="muted" style={{ fontSize: 11 }}>{r.error}</div> : null}</td>
                  <td style={{ fontSize: 12 }}>{r.content ?? ''}</td>
                  <td>{r.sentAt ? dateTimeVi(r.sentAt) : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Modal>
      ) : null}
    </div>
  )
}
