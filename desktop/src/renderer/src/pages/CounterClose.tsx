import React, { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { createContract, getApiErrorMessage } from '../lib/api'
import { useAuth } from '../lib/auth-context'
import { useClinic } from '../lib/clinic-context'
import { hhmm, vnd } from '../lib/format'
import { fetchCasePhoto, fetchCases, fetchConsultations, tenths, type CaseItem, type ConsultationSession } from '../lib/api-lo6'
import { fetchCounter, fetchCustomer360, type CounterVisit, type Customer360 } from '../lib/api-lo7'
import { Customer360Header, QuoteOptionsPanel, UpsellPanel } from '../components/crm360-parts'
import { Empty, useToast } from '../components/ui'

/* Lô 7 · V5: MÀN CHỐT TẠI QUẦY. Tư vấn viên mở khách vừa check-in: thanh 360,
   phác đồ gợi ý (phiếu tư vấn gần nhất), case ảnh tương tự từ thư viện (lọc
   theo dịch vụ), gợi ý bán kèm, báo giá 3 phương án và nút chốt. */

const VISIT_LABEL: Record<string, string> = {
  WAITING: 'Đang chờ',
  CONSULTING: 'Đang tư vấn',
  IN_SERVICE: 'Đang làm',
  PAYING: 'Chờ thanh toán'
}

export default function CounterClose(): React.JSX.Element {
  const { fail } = useToast()
  const [visits, setVisits] = useState<CounterVisit[] | null>(null)
  const [sel, setSel] = useState<string | null>(null)
  const [onlyMine, setOnlyMine] = useState(false)

  const load = useCallback(() => {
    fetchCounter()
      .then((r) => {
        setVisits(r.items)
        setSel((cur) => cur ?? r.items.find((v) => v.mine)?.customer.id ?? r.items[0]?.customer.id ?? null)
      })
      .catch((err) => {
        setVisits([])
        fail(getApiErrorMessage(err))
      })
  }, [fail])

  useEffect(() => {
    load()
    const t = window.setInterval(load, 30_000)
    return () => window.clearInterval(t)
  }, [load])

  const list = (visits ?? []).filter((v) => !onlyMine || v.mine)
  return (
    <div className="counter">
      <div className="card vlist">
        <div className="row" style={{ marginBottom: 8 }}>
          <div className="sec-title" style={{ margin: 0 }}>Khách tại quầy hôm nay</div>
          <button className="btn sec sm" style={{ marginLeft: 'auto' }} onClick={load}>
            Tải lại
          </button>
        </div>
        <label style={{ fontSize: 12.5, display: 'block', marginBottom: 8 }}>
          <input type="checkbox" checked={onlyMine} onChange={(e) => setOnlyMine(e.target.checked)} /> Chỉ khách tôi tiếp
        </label>
        {visits === null ? <div className="muted">Đang tải…</div> : null}
        {visits && !list.length ? <Empty>Chưa có khách check-in.</Empty> : null}
        {list.map((v) => (
          <div key={v.id} className={`vi ${sel === v.customer.id ? 'on' : ''}`} onClick={() => setSel(v.customer.id)}>
            <div className="row" style={{ gap: 6 }}>
              <b>#{v.queueNumber}</b>
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{v.customer.name}</span>
              {v.mine ? <span className="hchip PAID">Của tôi</span> : null}
            </div>
            <div className="muted" style={{ fontSize: 11.5, marginTop: 2 }}>
              {hhmm(v.checkedInAt)} · {VISIT_LABEL[v.status] ?? v.status}
              {v.consultant ? ` · ${v.consultant.name}` : ' · chưa giao tư vấn'}
            </div>
          </div>
        ))}
      </div>
      <div style={{ minWidth: 0 }}>{sel ? <CounterCustomer key={sel} customerId={sel} /> : <div className="card"><Empty>Chọn một khách bên trái.</Empty></div>}</div>
    </div>
  )
}

function CounterCustomer({ customerId }: { customerId: string }): React.JSX.Element {
  const { can } = useAuth()
  const clinic = useClinic()
  const navigate = useNavigate()
  const { say, fail } = useToast()
  const [data, setData] = useState<Customer360 | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [session, setSession] = useState<ConsultationSession | null | undefined>(undefined)
  const [cases, setCases] = useState<CaseItem[]>([])
  const [closed, setClosed] = useState<{ id: string; code: string; total: number; status: string } | null>(null)
  const [reload, setReload] = useState(0)

  useEffect(() => {
    fetchCustomer360(customerId)
      .then(setData)
      .catch((e) => setErr(getApiErrorMessage(e)))
    fetchConsultations({ customerId, limit: 1 })
      .then((r) => setSession(r[0] ?? null))
      .catch(() => setSession(null))
  }, [customerId, reload])

  const firstService = session?.proposals[0]?.serviceId ?? null
  useEffect(() => {
    if (!firstService || !can('case_study.read')) return setCases([])
    fetchCases({ serviceId: firstService })
      .then((r) => setCases(r.items.filter((c) => c.status === 'PUBLISHED').slice(0, 4)))
      .catch(() => setCases([]))
  }, [firstService, can])

  const makeContract = async (): Promise<void> => {
    if (!closed) return
    try {
      const c = await createContract({ customerId, quotationId: closed.id })
      say(`Đã lập hợp đồng ${c.code}.`)
      navigate(`/khach-hang/${customerId}`)
    } catch (e) {
      fail(getApiErrorMessage(e))
    }
  }

  if (err) return <div className="card"><Empty>{err}</Empty></div>
  if (!data) return <div className="card"><Empty>Đang tải khách…</Empty></div>
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <Customer360Header
        data={data}
        actions={
          <button className="btn sec sm" onClick={() => navigate(`/khach-hang/${customerId}`)}>
            Mở hồ sơ
          </button>
        }
      />

      <div className="card">
        <div className="row" style={{ marginBottom: 6 }}>
          <div className="sec-title" style={{ margin: 0 }}>Phác đồ gợi ý</div>
          {can('consultation.read') ? (
            <button className="btn sec sm" style={{ marginLeft: 'auto' }} onClick={() => navigate(`/tu-van?customerId=${customerId}`)}>
              {session ? 'Mở phiếu tư vấn' : 'Lập phiếu tư vấn'}
            </button>
          ) : null}
        </div>
        {session === undefined ? <div className="muted">Đang tải…</div> : null}
        {session === null ? <div className="muted">Khách chưa có phiếu tư vấn (hoặc phiếu nằm ngoài phạm vi của bạn). Báo giá 3 phương án bên dưới đọc phác đồ gần nhất nếu có.</div> : null}
        {session ? (
          <table>
            <tbody>
              {session.proposals.map((p, i) => {
                const name = p.serviceName ?? ''
                return (
                  <tr key={i}>
                    <td>{name}</td>
                    <td className="muted">{p.doseTenths ? `liều ${tenths(p.doseTenths)}` : ''}</td>
                    <td style={{ textAlign: 'right' }}>{p.listPrice != null ? `${vnd(p.listPrice)} × ${p.quantity ?? 1}` : ''}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        ) : null}
        {session?.contraindicationNote && data.medicalVisible ? (
          <div className="alert dg" style={{ marginTop: 8 }}>Chống chỉ định ghi ở phiếu: {session.contraindicationNote}</div>
        ) : null}
      </div>

      {can('case_study.read') ? (
        <div className="card">
          <div className="sec-title">Case ảnh tương tự</div>
          {!cases.length ? (
            <div className="muted" style={{ fontSize: 12.5 }}>Chưa có case đã duyệt cho dịch vụ này.</div>
          ) : (
            <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 8 }}>
              {cases.map((c) => (
                <div key={c.id} className="upsell-item" style={{ margin: 0, cursor: 'pointer' }} onClick={() => navigate(`/thu-vien-case?caseId=${c.id}`)}>
                  {c.photos[0] ? <CaseThumb caseId={c.id} photoId={c.photos[0].id} /> : null}
                  <b>{c.title}</b>
                  <div className="muted" style={{ fontSize: 11.5 }}>
                    {c.anonymLabel}
                    {c.service ? ` · ${c.service.name}` : ''} · {c.photos.length} ảnh
                  </div>
                  {c.summary ? <div style={{ fontSize: 12, marginTop: 3 }}>{c.summary}</div> : null}
                </div>
              ))}
            </div>
          )}
        </div>
      ) : null}

      <div className="card">
        <div className="sec-title">Gợi ý bán kèm</div>
        <UpsellPanel customerId={customerId} context="COUNTER" reloadKey={reload} />
      </div>

      {can('sales_order.read') ? (
        <div className="card">
          <div className="sec-title">Báo giá 3 phương án</div>
          {closed ? (
            <div className="alert ok" style={{ marginBottom: 8 }}>
              Đã {closed.status === 'ACCEPTED' ? 'chốt' : 'lập'} báo giá <b>{closed.code}</b>: {vnd(closed.total)}.{' '}
              {can('finance.create') && closed.status === 'ACCEPTED' ? (
                <button className="btn sm" onClick={() => void makeContract()}>
                  Lập hợp đồng từ báo giá
                </button>
              ) : null}
            </div>
          ) : null}
          <QuoteOptionsPanel
            key={`q-${reload}`}
            customerId={customerId}
            customerName={data.customer.name}
            context="COUNTER"
            allowAccept
            onChosen={(q) => {
              setClosed(q)
              setReload((n) => n + 1)
            }}
          />
          <div className="muted" style={{ fontSize: 11.5, marginTop: 8 }}>
            {clinic.isInjection ? 'Liều và chỉ định cuối cùng do bác sĩ quyết định.' : 'Chỉ định cuối cùng do bác sĩ quyết định.'} Giảm thêm luôn trong trần giảm theo vai của bạn.
          </div>
        </div>
      ) : null}
    </div>
  )
}

function CaseThumb({ caseId, photoId }: { caseId: string; photoId: string }): React.JSX.Element | null {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    let u: string | null = null
    fetchCasePhoto(caseId, photoId)
      .then((x) => {
        u = x
        setUrl(x)
      })
      .catch(() => setUrl(null))
    return () => {
      if (u) URL.revokeObjectURL(u)
    }
  }, [caseId, photoId])
  if (!url) return null
  return <img src={url} alt="Ảnh case" style={{ width: '100%', height: 120, objectFit: 'cover', borderRadius: 8, marginBottom: 6 }} />
}
