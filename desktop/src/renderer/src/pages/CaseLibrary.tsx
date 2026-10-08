import React, { useCallback, useEffect, useState } from 'react'
import { fetchServices, getApiErrorMessage } from '../lib/api'
import { approveCase, createCase, fetchCasePhoto, fetchCases, withdrawCase, type CaseItem } from '../lib/api-lo6'
import { CustomerPicker } from './Consultations'
import { useAuth } from '../lib/auth-context'
import { dateVi } from '../lib/format'
import { Empty, Modal, useToast } from '../components/ui'

/* F30: THƯ VIỆN CASE. Chỉ ảnh khách đã đồng ý dùng làm marketing, ẩn danh
   (không tên, không SĐT). Sale xem case đã xuất bản để tư vấn khách mới; bác sĩ
   duyệt chuyên môn, quản lý duyệt truyền thông. Bác sĩ, quản lý tạo case bằng
   nút "Tạo case" (khách phải có bộ ảnh đã đồng ý marketing). */

function NewCase({ services, onClose, onDone }: { services: Array<{ id: string; name: string }>; onClose: () => void; onDone: () => void }): React.JSX.Element {
  const { fail } = useToast()
  const [customer, setCustomer] = useState<{ id: string; name: string; code: string } | null>(null)
  const [title, setTitle] = useState('')
  const [serviceId, setServiceId] = useState('')
  const [summary, setSummary] = useState('')
  const save = async (): Promise<void> => {
    if (!customer) return fail('Chọn khách có ảnh đã đồng ý marketing')
    try {
      await createCase({ customerId: customer.id, title: title.trim(), serviceId: serviceId || null, summary: summary.trim() || undefined })
      onDone()
    } catch (err) {
      fail(getApiErrorMessage(err))
    }
  }
  return (
    <Modal title="Tạo case" onClose={onClose} footer={<button className="btn" onClick={() => void save()} disabled={!customer || title.trim().length < 3}>Tạo case</button>}>
      {customer ? (
        <div className="row" style={{ marginBottom: 8 }}>
          <b>{customer.code}</b>
          <button className="btn sec sm" onClick={() => setCustomer(null)}>Đổi khách</button>
        </div>
      ) : (
        <CustomerPicker onPick={setCustomer} />
      )}
      <div className="field">
        <label>Tiêu đề (không ghi tên, SĐT khách)</label>
        <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Filler môi 1cc, dáng tự nhiên" />
      </div>
      <div className="field">
        <label>Dịch vụ</label>
        <select className="input" value={serviceId} onChange={(e) => setServiceId(e.target.value)}>
          <option value="">Theo lần thực hiện (nếu có)</option>
          {services.map((s) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>
      </div>
      <div className="field">
        <label>Tóm tắt</label>
        <textarea className="input" rows={3} value={summary} onChange={(e) => setSummary(e.target.value)} />
      </div>
    </Modal>
  )
}

const STATUS: Record<string, string> = {
  DRAFT: 'Nháp',
  PENDING_MEDICAL: 'Chờ duyệt chuyên môn',
  PENDING_MARKETING: 'Chờ duyệt truyền thông',
  PUBLISHED: 'Đã xuất bản'
}
const STAGE: Record<string, string> = { D0: 'Trước', PRE_OP: 'Trước', CONSULT: 'Tư vấn', D7: 'Sau 7 ngày', D30: 'Sau 30 ngày', M1: 'Sau 1 tháng', M3: 'Sau 3 tháng', M6: 'Sau 6 tháng' }

function CasePhoto({ caseId, photoId, label }: { caseId: string; photoId: string; label: string }): React.JSX.Element {
  const [src, setSrc] = useState<string | null>(null)
  useEffect(() => {
    let url: string | null = null
    fetchCasePhoto(caseId, photoId)
      .then((u) => {
        url = u
        setSrc(u)
      })
      .catch(() => setSrc(null))
    return () => {
      if (url) URL.revokeObjectURL(url)
    }
  }, [caseId, photoId])
  return (
    <figure style={{ margin: 0 }}>
      {src ? <img src={src} alt={label} /> : <div className="empty" style={{ padding: 8 }}>Ảnh</div>}
      <figcaption className="muted" style={{ fontSize: 11, textAlign: 'center' }}>{label}</figcaption>
    </figure>
  )
}

export default function CaseLibrary(): React.JSX.Element {
  const { can } = useAuth()
  const { say, fail } = useToast()
  const [serviceId, setServiceId] = useState('')
  const [data, setData] = useState<{ items: CaseItem[]; services: Array<{ id: string; name: string }>; canManage: boolean } | null>(null)
  const [creating, setCreating] = useState(false)
  const [allServices, setAllServices] = useState<Array<{ id: string; name: string }>>([])
  useEffect(() => {
    if (!can('case_study.create')) return
    fetchServices()
      .then((rows) => setAllServices(rows.map((r) => ({ id: r.id, name: r.name }))))
      .catch(() => setAllServices([]))
  }, [can])

  const load = useCallback(async () => {
    try {
      setData(await fetchCases(serviceId ? { serviceId } : {}))
    } catch (err) {
      fail(getApiErrorMessage(err))
    }
  }, [serviceId, fail])
  useEffect(() => {
    void load()
  }, [load])

  const act = async (fn: () => Promise<unknown>, ok: string): Promise<void> => {
    try {
      await fn()
      say(ok)
      void load()
    } catch (err) {
      fail(getApiErrorMessage(err))
    }
  }

  if (!data) return <Empty>Đang tải thư viện…</Empty>
  return (
    <>
      <div className="row" style={{ marginBottom: 12 }}>
        <select className="input" style={{ maxWidth: 320 }} value={serviceId} onChange={(e) => setServiceId(e.target.value)}>
          <option value="">Tất cả dịch vụ</option>
          {data.services.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <span className="muted" style={{ fontSize: 12.5 }}>
          Chỉ hiện ảnh khách đã đồng ý dùng làm marketing. Không có tên, SĐT khách.
        </span>
        {can('case_study.create') ? (
          <button className="btn sm" style={{ marginLeft: 'auto' }} onClick={() => setCreating(true)}>
            + Tạo case
          </button>
        ) : null}
      </div>
      {creating ? (
        <NewCase
          services={allServices}
          onClose={() => setCreating(false)}
          onDone={() => {
            setCreating(false)
            say('Đã tạo case, chờ duyệt chuyên môn và truyền thông')
            void load()
          }}
        />
      ) : null}
      {!data.items.length ? <Empty>Chưa có case nào{serviceId ? ' cho dịch vụ này' : ''}.</Empty> : null}
      <div className="case-grid">
        {data.items.map((c) => (
          <div key={c.id} className="card">
            <div className="row">
              <b>{c.title}</b>
              {data.canManage ? <span className="tag" style={{ marginLeft: 'auto' }}>{STATUS[c.status] ?? c.status}</span> : null}
            </div>
            <div className="muted" style={{ fontSize: 12.5 }}>
              {c.anonymLabel}
              {c.service ? ` · ${c.service.name}` : ''}
              {c.doctor ? ` · BS ${c.doctor.name}` : ''}
            </div>
            {c.photos.length ? (
              <div className="case-photos">
                {c.photos.slice(0, 6).map((p) => (
                  <CasePhoto key={p.id} caseId={c.id} photoId={p.id} label={STAGE[p.stage] ?? p.stage} />
                ))}
              </div>
            ) : (
              <div className="muted" style={{ margin: '8px 0' }}>Chưa có ảnh được đồng ý.</div>
            )}
            {c.summary ? <p style={{ margin: '4px 0', fontSize: 13 }}>{c.summary}</p> : null}
            {c.publishedAt ? <div className="muted" style={{ fontSize: 11.5 }}>Xuất bản {dateVi(c.publishedAt)}</div> : null}
            {data.canManage && can('case_study.approve') && c.status !== 'PUBLISHED' ? (
              <div className="row" style={{ marginTop: 6 }}>
                {!c.medicalApprovedAt ? (
                  <button className="btn sm" onClick={() => void act(() => approveCase(c.id, 'MEDICAL'), 'Đã duyệt chuyên môn')}>
                    Duyệt chuyên môn
                  </button>
                ) : null}
                {!c.marketingApprovedAt ? (
                  <button className="btn sm" onClick={() => void act(() => approveCase(c.id, 'MARKETING'), 'Đã duyệt truyền thông')}>
                    Duyệt truyền thông
                  </button>
                ) : null}
              </div>
            ) : null}
            {data.canManage && can('case_study.update') ? (
              <button
                className="btn sec sm"
                style={{ marginTop: 6 }}
                onClick={() => {
                  const reason = window.prompt('Lý do gỡ case (ví dụ khách rút đồng ý):')
                  if (reason && reason.trim().length >= 3) void act(() => withdrawCase(c.id, reason.trim()), 'Đã gỡ case')
                }}
              >
                Gỡ case
              </button>
            ) : null}
          </div>
        ))}
      </div>
    </>
  )
}
