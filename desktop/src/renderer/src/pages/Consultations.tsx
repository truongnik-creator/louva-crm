import { QuoteOptionsPanel, UpsellPanel } from '../components/crm360-parts'
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { fetchCustomers, fetchPhotoBlob, getApiErrorMessage } from '../lib/api'
import {
  createConsultation,
  createPlan,
  fetchConsultMeta,
  fetchConsultation,
  fetchConsultations,
  parseTenths,
  quoteFromPlan,
  tenths,
  updatePlan,
  uploadConsultPhotos,
  type ConsultMeta,
  type ConsultationSession,
  type Proposal
} from '../lib/api-lo6'
import { useAuth } from '../lib/auth-context'
import { dateTimeVi, vnd } from '../lib/format'
import { Empty, useToast } from '../components/ui'

/* F30: PHIẾU TƯ VẤN TRÊN MÁY TÍNH BẢNG.
   Chọn vùng mặt bằng ô chạm to, đề xuất dịch vụ từ bảng giá, sản phẩm, liều theo
   0,1 đơn vị, chụp ảnh "trước" bằng camera máy tính bảng. Từ phiếu lập phác đồ,
   từ phác đồ lập báo giá theo giá niêm yết. */

const PLAN_STATUS: Record<string, string> = {
  DRAFT: 'Nháp',
  PROPOSED: 'Đã đề xuất',
  ACCEPTED: 'Khách đồng ý',
  REJECTED: 'Khách từ chối'
}

interface Row extends Proposal {
  key: number
  doseText: string
}

export function CustomerPicker({ onPick }: { onPick: (c: { id: string; name: string; code: string }) => void }): React.JSX.Element {
  const [q, setQ] = useState('')
  const [items, setItems] = useState<Array<{ id: string; name: string; code: string; phone: string | null }>>([])
  useEffect(() => {
    if (q.trim().length < 2) {
      setItems([])
      return
    }
    const t = window.setTimeout(() => {
      fetchCustomers({ q: q.trim(), limit: 8 })
        .then((r) => setItems(r.items))
        .catch(() => setItems([]))
    }, 300)
    return () => window.clearTimeout(t)
  }, [q])
  return (
    <div>
      <input className="input" placeholder="Tìm khách theo tên, SĐT, mã" value={q} onChange={(e) => setQ(e.target.value)} />
      {items.map((c) => (
        <div key={c.id} className="zitem" onClick={() => onPick(c)}>
          <b>{c.name}</b>
          <span className="muted" style={{ marginLeft: 8 }}>
            {c.code} · {c.phone ?? 'chưa có SĐT'}
          </span>
        </div>
      ))}
    </div>
  )
}

function NewConsultation({ meta, presetCustomer, onSaved }: { meta: ConsultMeta; presetCustomer: { id: string; name: string; code: string } | null; onSaved: (id: string) => void }): React.JSX.Element {
  const { fail } = useToast()
  const [customer, setCustomer] = useState(presetCustomer)
  const [areas, setAreas] = useState<string[]>([])
  const [rows, setRows] = useState<Row[]>([])
  const [expectation, setExpectation] = useState('')
  const [contra, setContra] = useState('')
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  const serviceById = useMemo(() => new Map(meta.services.map((s) => [s.id, s])), [meta])

  const toggleArea = (v: string): void => setAreas((a) => (a.includes(v) ? a.filter((x) => x !== v) : [...a, v]))
  const addRow = (): void => setRows((r) => [...r, { key: Date.now(), serviceId: meta.services[0]?.id ?? '', doseText: '', faceArea: areas[0] ?? null }])
  const patch = (key: number, p: Partial<Row>): void => setRows((r) => r.map((x) => (x.key === key ? { ...x, ...p } : x)))

  const total = rows.reduce((s, r) => {
    const price = serviceById.get(r.serviceId)?.listPrice ?? 0
    const dose = parseTenths(r.doseText)
    const qty = r.quantity ?? (dose ? Math.max(1, Math.ceil(dose / 10)) : 1)
    return s + price * qty
  }, 0)

  const save = async (): Promise<void> => {
    if (!customer) return fail('Chọn khách trước')
    const proposals: Proposal[] = []
    for (const r of rows) {
      const dose = parseTenths(r.doseText)
      if (r.doseText.trim() && dose === null) return fail('Liều nhập dạng số, tối đa một chữ số thập phân (ví dụ 1,5)')
      proposals.push({ serviceId: r.serviceId, productId: r.productId || null, doseTenths: dose, quantity: r.quantity ?? null, faceArea: r.faceArea || null, note: r.note || null })
    }
    setSaving(true)
    try {
      const s = await createConsultation({ customerId: customer.id, faceAreas: areas, proposals, expectation: expectation || null, contraindicationNote: contra || null, note: note || null })
      onSaved(s.id)
    } catch (err) {
      fail(getApiErrorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="card">
      <div className="sec-title">Phiếu tư vấn mới</div>
      {customer ? (
        <div className="row" style={{ marginBottom: 10 }}>
          <b>{customer.name}</b>
          <span className="muted">{customer.code}</span>
          <button className="btn sec sm" onClick={() => setCustomer(null)}>
            Đổi khách
          </button>
        </div>
      ) : (
        <div style={{ marginBottom: 10 }}>
          <CustomerPicker onPick={setCustomer} />
        </div>
      )}

      <div className="field">
        <label>Vùng quan tâm (chạm để chọn)</label>
        <div className="face-grid">
          {meta.faceAreas.map((a) => (
            <button key={a.value} type="button" className={`face-chip${areas.includes(a.value) ? ' on' : ''}`} onClick={() => toggleArea(a.value)}>
              {a.label}
            </button>
          ))}
        </div>
      </div>

      <div className="field">
        <label>Dịch vụ đề xuất, sản phẩm, liều</label>
        {rows.map((r) => (
          <div key={r.key} className="grid" style={{ gridTemplateColumns: 'repeat(5, 1fr)', gap: 6, marginBottom: 6, alignItems: 'end' }}>
            <select className="input" value={r.serviceId} onChange={(e) => patch(r.key, { serviceId: e.target.value })}>
              {meta.services.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                  {s.listPrice != null ? ` · ${vnd(s.listPrice)}` : ''}
                </option>
              ))}
            </select>
            <select className="input" value={r.productId ?? ''} onChange={(e) => patch(r.key, { productId: e.target.value || null })}>
              <option value="">Sản phẩm (tuỳ chọn)</option>
              {meta.products.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.unit})
                </option>
              ))}
            </select>
            <input className="input" inputMode="decimal" placeholder="Liều, ví dụ 1,5" value={r.doseText} onChange={(e) => patch(r.key, { doseText: e.target.value })} />
            <select className="input" value={r.faceArea ?? ''} onChange={(e) => patch(r.key, { faceArea: e.target.value || null })}>
              <option value="">Vùng</option>
              {meta.faceAreas.map((a) => (
                <option key={a.value} value={a.value}>
                  {a.label}
                </option>
              ))}
            </select>
            <button className="btn sec" onClick={() => setRows((x) => x.filter((y) => y.key !== r.key))}>
              Bỏ dòng
            </button>
          </div>
        ))}
        <div className="row">
          <button className="btn sec" onClick={addRow} disabled={!meta.services.length}>
            + Thêm dịch vụ
          </button>
          {rows.length ? <span className="muted">Tạm tính theo giá niêm yết: {vnd(total)}</span> : null}
        </div>
      </div>

      <div className="field">
        <label>Mong muốn của khách</label>
        <textarea className="input" rows={2} value={expectation} onChange={(e) => setExpectation(e.target.value)} />
      </div>
      <div className="field">
        <label>Lưu ý chống chỉ định (bác sĩ ghi)</label>
        <textarea className="input" rows={2} value={contra} onChange={(e) => setContra(e.target.value)} />
      </div>
      <div className="field">
        <label>Ghi chú</label>
        <textarea className="input" rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
      <button className="btn block" onClick={() => void save()} disabled={saving || !customer}>
        {saving ? 'Đang lưu…' : 'Lưu phiếu tư vấn'}
      </button>
    </div>
  )
}

function Thumb({ photoId }: { photoId: string }): React.JSX.Element {
  const [src, setSrc] = useState<string | null>(null)
  useEffect(() => {
    let url: string | null = null
    fetchPhotoBlob(photoId)
      .then((u) => {
        url = u
        setSrc(u)
      })
      .catch(() => setSrc(null))
    return () => {
      if (url) URL.revokeObjectURL(url)
    }
  }, [photoId])
  return src ? <img src={src} alt="Ảnh trước" /> : <div className="empty" style={{ padding: 8 }}>Ảnh</div>
}

function Detail({ id, meta, onChanged }: { id: string; meta: ConsultMeta; onChanged: () => void }): React.JSX.Element {
  const { can } = useAuth()
  const { say, fail } = useToast()
  const [s, setS] = useState<ConsultationSession | null>(null)
  const [busy, setBusy] = useState(false)
  const areaLabel = useMemo(() => new Map(meta.faceAreas.map((a) => [a.value, a.label])), [meta])

  const load = useCallback(async () => {
    try {
      setS(await fetchConsultation(id))
    } catch (err) {
      fail(getApiErrorMessage(err))
    }
  }, [id, fail])
  useEffect(() => {
    void load()
  }, [load])

  const run = async (fn: () => Promise<unknown>, ok: string): Promise<void> => {
    setBusy(true)
    try {
      await fn()
      say(ok)
      await load()
      onChanged()
    } catch (err) {
      fail(getApiErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  if (!s) return <Empty>Đang tải phiếu…</Empty>
  return (
    <div className="card">
      <div className="row" style={{ marginBottom: 6 }}>
        <div className="sec-title" style={{ margin: 0 }}>
          Phiếu tư vấn {s.customer ? `· ${s.customer.name}` : ''}
        </div>
        <span className="muted" style={{ marginLeft: 'auto' }}>
          {dateTimeVi(s.heldAt)}
        </span>
      </div>
      <div className="muted" style={{ marginBottom: 8 }}>
        Vùng: {s.faceAreas.map((a) => areaLabel.get(a) ?? a).join(', ') || 'chưa chọn'}
        {s.doctor ? ` · Bác sĩ ${s.doctor.name}` : ''}
      </div>
      <table>
        <thead>
          <tr>
            <th>Dịch vụ</th>
            <th>Sản phẩm</th>
            <th>Liều</th>
            <th>Vùng</th>
            <th>Giá niêm yết</th>
          </tr>
        </thead>
        <tbody>
          {s.proposals.map((p, i) => (
            <tr key={i}>
              <td>{p.serviceName}</td>
              <td>{p.productName ?? ''}</td>
              <td>{p.doseTenths ? `${tenths(p.doseTenths)} ${p.productUnit ?? ''}` : ''}</td>
              <td>{p.faceArea ? areaLabel.get(p.faceArea) : ''}</td>
              <td>{p.listPrice != null ? `${vnd(p.listPrice)} x ${p.quantity ?? 1}` : 'Chưa có giá'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {s.expectation ? <p><b>Mong muốn:</b> {s.expectation}</p> : null}
      {s.contraindicationNote ? <p><b>Chống chỉ định:</b> {s.contraindicationNote}</p> : null}

      <div className="sec-title" style={{ marginTop: 12 }}>Ảnh trước</div>
      {s.photoSet?.photos.length ? (
        <div className="case-photos">
          {s.photoSet.photos.map((p) => (
            <Thumb key={p.id} photoId={p.id} />
          ))}
        </div>
      ) : (
        <div className="muted">Chưa có ảnh.</div>
      )}
      {can('consultation.update') && can('photo.create') ? (
        <label className="btn sec" style={{ marginTop: 6 }}>
          📷 Chụp hoặc chọn ảnh trước
          <input
            type="file"
            accept="image/*"
            capture="environment"
            multiple
            hidden
            onChange={(e) => {
              const files = Array.from(e.target.files ?? [])
              e.target.value = ''
              if (files.length) void run(() => uploadConsultPhotos(s.id, files), `Đã lưu ${files.length} ảnh vào hồ sơ`)
            }}
          />
        </label>
      ) : null}

      <div className="sec-title" style={{ marginTop: 14 }}>Phác đồ và báo giá</div>
      {(s.plans ?? []).map((p) => (
        <div key={p.id} className="card" style={{ marginBottom: 8, background: 'var(--surface-2)' }}>
          <div className="row">
            <b>{p.title}</b>
            <span className="tag">{PLAN_STATUS[p.status] ?? p.status}</span>
          </div>
          <div className="muted" style={{ fontSize: 12.5, margin: '4px 0' }}>
            {(p.items ?? []).map((i) => `${i.name}${i.doseTenths ? ` ${tenths(i.doseTenths)}` : ''}`).join(' · ')}
          </div>
          <div className="row">
            {p.quotation ? (
              <span>
                Báo giá <b>{p.quotation.code}</b>: {vnd(p.quotation.total)}
              </span>
            ) : can('consultation.update') ? (
              <button className="btn sm" disabled={busy} onClick={() => void run(() => quoteFromPlan(p.id), 'Đã lập báo giá theo giá niêm yết')}>
                Lập báo giá từ phác đồ
              </button>
            ) : null}
            {can('consultation.update') && p.status !== 'ACCEPTED' ? (
              <button className="btn sec sm" disabled={busy} onClick={() => void run(() => updatePlan(p.id, { status: 'ACCEPTED' }), 'Đã ghi khách đồng ý phác đồ')}>
                Khách đồng ý
              </button>
            ) : null}
          </div>
        </div>
      ))}
      {can('consultation.create') && s.proposals.length ? (
        <button className="btn" disabled={busy} onClick={() => void run(() => createPlan(s.id), 'Đã lập phác đồ từ đề xuất')}>
          + Lập phác đồ từ đề xuất
        </button>
      ) : null}

      {/* Lô 7 · V1 + V2: báo giá 3 phương án và gợi ý bán kèm ngay trên phiếu. */}
      {s.customer && can('sales_order.read') && s.proposals.length ? (
        <>
          <div className="sec-title" style={{ marginTop: 14 }}>Báo giá 3 phương án</div>
          <QuoteOptionsPanel
            key={`${s.id}-${(s.plans ?? []).length}`}
            customerId={s.customerId}
            customerName={s.customer.name}
            planId={s.plans?.length ? s.plans[s.plans.length - 1].id : null}
            sessionId={s.plans?.length ? null : s.id}
            context="CONSULT"
            onChosen={() => {
              void load()
              onChanged()
            }}
          />
        </>
      ) : null}
      {s.customer ? (
        <>
          <div className="sec-title" style={{ marginTop: 14 }}>Gợi ý bán kèm</div>
          <UpsellPanel customerId={s.customerId} context="CONSULT" reloadKey={(s.plans ?? []).length} />
        </>
      ) : null}
    </div>
  )
}

export default function Consultations(): React.JSX.Element {
  const { can } = useAuth()
  const { fail } = useToast()
  const [params, setParams] = useSearchParams()
  const [meta, setMeta] = useState<ConsultMeta | null>(null)
  const [list, setList] = useState<ConsultationSession[]>([])
  const [mode, setMode] = useState<'list' | 'new' | 'detail'>('list')
  const [openId, setOpenId] = useState<string | null>(null)
  const presetId = params.get('customerId')

  const load = useCallback(async () => {
    try {
      const [m, l] = await Promise.all([fetchConsultMeta(), fetchConsultations({ customerId: presetId ?? undefined, limit: 50 })])
      setMeta(m)
      setList(l)
    } catch (err) {
      fail(getApiErrorMessage(err))
    }
  }, [fail, presetId])
  useEffect(() => {
    void load()
  }, [load])

  if (!meta) return <Empty>Đang tải…</Empty>
  const preset = presetId && list[0]?.customer ? { id: presetId, name: list[0].customer.name, code: list[0].customer.code } : null

  return (
    <div className="grid" style={{ gridTemplateColumns: '1fr 2fr', alignItems: 'start' }}>
      <div className="card">
        <div className="row" style={{ marginBottom: 8 }}>
          <div className="sec-title" style={{ margin: 0 }}>Phiếu gần đây</div>
          {can('consultation.create') ? (
            <button className="btn sm" style={{ marginLeft: 'auto' }} onClick={() => setMode('new')}>
              + Phiếu mới
            </button>
          ) : null}
        </div>
        {presetId ? (
          <button className="btn sec sm" style={{ marginBottom: 8 }} onClick={() => setParams({})}>
            Bỏ lọc theo khách
          </button>
        ) : null}
        {!list.length ? <Empty>Chưa có phiếu tư vấn.</Empty> : null}
        {list.map((s) => (
          <div
            key={s.id}
            className={`zitem${openId === s.id && mode === 'detail' ? ' on' : ''}`}
            onClick={() => {
              setOpenId(s.id)
              setMode('detail')
            }}
          >
            <div className="zmid">
              <div className="ztop">
                <b>{s.customer?.name ?? 'Khách'}</b>
                <span className="zgio">{dateTimeVi(s.heldAt)}</span>
              </div>
              <div className="zprev">
                {s.proposals.map((p) => p.serviceName).join(', ') || 'Chưa có đề xuất'}
                {s.plans?.length ? ` · ${s.plans.length} phác đồ` : ''}
              </div>
            </div>
          </div>
        ))}
      </div>
      <div>
        {mode === 'new' ? (
          <NewConsultation
            meta={meta}
            presetCustomer={preset}
            onSaved={(id) => {
              setOpenId(id)
              setMode('detail')
              void load()
            }}
          />
        ) : mode === 'detail' && openId ? (
          <Detail id={openId} meta={meta} onChanged={() => void load()} />
        ) : (
          <Empty>Chọn một phiếu bên trái hoặc bấm "Phiếu mới". Màn này dùng tốt trên máy tính bảng.</Empty>
        )}
      </div>
    </div>
  )
}
