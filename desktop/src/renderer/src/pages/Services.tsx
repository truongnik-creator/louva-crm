import React, { useCallback, useEffect, useState } from 'react'
import {
  createService,
  fetchServiceCategories,
  fetchServices,
  getApiErrorMessage,
  setServicePrice
} from '../lib/api'
import { useAuth } from '../lib/auth-context'
import { minutesLabel, vnd } from '../lib/format'
import { ANESTHESIA_LABEL } from '../lib/ui'
import { Empty, Modal, useToast } from '../components/ui'
import type { Service } from '../lib/types'

/* DANH MỤC DỊCH VỤ & BẢNG GIÁ.
   Giá gắn với CƠ SỞ đang làm việc và có hiệu lực theo thời gian: đặt giá mới
   không ghi đè giá cũ mà đóng bản ghi cũ lại, để hợp đồng đã ký vẫn đối chiếu
   được với giá tại thời điểm ký. */

const KIND_LABEL: Record<string, string> = {
  SURGERY: 'Phẫu thuật',
  MINOR_PROCEDURE: 'Tiểu phẫu',
  INJECTION: 'Tiêm',
  LASER: 'Laser',
  SKIN_CARE: 'Chăm sóc da',
  CONSULT: 'Tư vấn',
  OTHER: 'Khác'
}

export default function Services(): React.JSX.Element {
  const { can, branchId, user } = useAuth()
  const { say, fail } = useToast()

  const [services, setServices] = useState<Service[]>([])
  const [categories, setCategories] = useState<Array<{ id: string; name: string; code: string }>>([])
  const [categoryId, setCategoryId] = useState('')
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [pricing, setPricing] = useState<Service | null>(null)
  const [creating, setCreating] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [rows, cats] = await Promise.all([
        fetchServices({ q: query || undefined, categoryId: categoryId || undefined }),
        fetchServiceCategories().catch(() => [])
      ])
      setServices(rows)
      setCategories(cats)
    } catch (err) {
      fail(getApiErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }, [query, categoryId, fail])

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 250)
    return () => window.clearTimeout(timer)
  }, [load, branchId])

  const branchName = user?.branches.find((b) => b.id === branchId)?.shortName ?? 'cơ sở hiện tại'

  return (
    <>
      <div className="row" style={{ flexWrap: 'wrap', marginBottom: 12 }}>
        <input
          className="input"
          style={{ width: 240 }}
          placeholder="Tìm dịch vụ"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select
          className="input"
          style={{ width: 'auto' }}
          value={categoryId}
          onChange={(e) => setCategoryId(e.target.value)}
        >
          <option value="">Mọi nhóm</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <span className="muted" style={{ fontSize: 12.5 }}>
          Giá hiển thị theo cơ sở: <b>{branchName}</b>
        </span>
        {can('service.create') ? (
          <button className="btn" style={{ marginLeft: 'auto' }} onClick={() => setCreating(true)}>
            + Thêm dịch vụ
          </button>
        ) : null}
      </div>

      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        {loading ? (
          <Empty>Đang tải bảng giá…</Empty>
        ) : services.length === 0 ? (
          <Empty>Chưa có dịch vụ nào.</Empty>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Mã</th>
                <th>Dịch vụ</th>
                <th>Nhóm</th>
                <th>Loại</th>
                <th>Thời lượng</th>
                <th>Nghỉ dưỡng</th>
                <th>Vô cảm</th>
                <th>Giá niêm yết</th>
                <th>Giá sàn</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {services.map((s) => (
                <tr key={s.id}>
                  <td className="muted">{s.code}</td>
                  <td>
                    <b>{s.name}</b>
                    {s.requiresPreOpLab ? (
                      <div className="muted" style={{ fontSize: 11.5 }}>
                        Cần xét nghiệm tiền phẫu
                      </div>
                    ) : null}
                  </td>
                  <td>{s.category?.name ?? '—'}</td>
                  <td>
                    <span className="tag out">{KIND_LABEL[s.kind] ?? s.kind}</span>
                  </td>
                  <td>{minutesLabel(s.durationMin)}</td>
                  <td>{s.recoveryDays != null ? `${s.recoveryDays} ngày` : '—'}</td>
                  <td className="muted">{s.anesthesia ? (ANESTHESIA_LABEL[s.anesthesia] ?? s.anesthesia) : '—'}</td>
                  <td>
                    <b>{s.price != null ? vnd(s.price) : <span className="muted">chưa đặt giá</span>}</b>
                  </td>
                  <td className="muted">{s.minPrice != null ? vnd(s.minPrice) : '—'}</td>
                  <td>
                    {can('service.update') ? (
                      <button className="btn sec sm" onClick={() => setPricing(s)}>
                        Đặt giá
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="muted" style={{ fontSize: 12, marginTop: 9 }}>
        Báo giá thấp hơn giá sàn sẽ bị hệ thống chặn khi lập báo giá — đây là hàng rào chống phá giá.
      </div>

      {pricing ? (
        <PriceModal
          service={pricing}
          branchId={branchId ?? ''}
          onClose={() => setPricing(null)}
          onSaved={() => {
            setPricing(null)
            void load()
          }}
        />
      ) : null}

      {creating ? (
        <NewServiceModal
          categories={categories}
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false)
            void load()
          }}
        />
      ) : null}
    </>
  )
}

function PriceModal({
  service,
  branchId,
  onClose,
  onSaved
}: {
  service: Service
  branchId: string
  onClose: () => void
  onSaved: () => void
}): React.JSX.Element {
  const { say, fail } = useToast()
  const [price, setPrice] = useState(service.price ?? 0)
  const [minPrice, setMinPrice] = useState(service.minPrice ?? 0)
  const [saving, setSaving] = useState(false)

  const submit = async (): Promise<void> => {
    setSaving(true)
    try {
      await setServicePrice({ serviceId: service.id, branchId, price, minPrice: minPrice || undefined })
      say('Đã cập nhật giá. Giá cũ được lưu lại để đối chiếu hợp đồng đã ký.')
      onSaved()
    } catch (err) {
      fail(getApiErrorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      title={`Đặt giá — ${service.name}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn sec" onClick={onClose}>
            Huỷ
          </button>
          <button className="btn" onClick={() => void submit()} disabled={saving}>
            {saving ? 'Đang lưu…' : 'Lưu giá'}
          </button>
        </>
      }
    >
      <div className="field">
        <label>Giá niêm yết (đồng)</label>
        <input className="input" type="number" value={price} onChange={(e) => setPrice(Number(e.target.value))} />
      </div>
      <div className="field">
        <label>Giá sàn — thấp hơn mức này hệ thống sẽ chặn</label>
        <input
          className="input"
          type="number"
          value={minPrice}
          onChange={(e) => setMinPrice(Number(e.target.value))}
        />
      </div>
    </Modal>
  )
}

function NewServiceModal({
  categories,
  onClose,
  onCreated
}: {
  categories: Array<{ id: string; name: string }>
  onClose: () => void
  onCreated: () => void
}): React.JSX.Element {
  const { say, fail } = useToast()
  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const [categoryId, setCategoryId] = useState('')
  const [kind, setKind] = useState('SURGERY')
  const [durationMin, setDurationMin] = useState(60)
  const [saving, setSaving] = useState(false)

  const submit = async (): Promise<void> => {
    if (code.trim().length < 2 || name.trim().length < 2) {
      fail('Nhập đủ mã và tên dịch vụ.')
      return
    }
    setSaving(true)
    try {
      await createService({
        code: code.trim(),
        name: name.trim(),
        categoryId: categoryId || null,
        kind,
        durationMin
      })
      say('Đã thêm dịch vụ. Nhớ đặt giá cho cơ sở.')
      onCreated()
    } catch (err) {
      fail(getApiErrorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      title="Thêm dịch vụ"
      onClose={onClose}
      footer={
        <>
          <button className="btn sec" onClick={onClose}>
            Huỷ
          </button>
          <button className="btn" onClick={() => void submit()} disabled={saving}>
            {saving ? 'Đang lưu…' : 'Thêm'}
          </button>
        </>
      }
    >
      <div className="field">
        <label>Mã dịch vụ *</label>
        <input className="input" value={code} onChange={(e) => setCode(e.target.value)} placeholder="DV-MUI-CT" />
      </div>
      <div className="field">
        <label>Tên dịch vụ *</label>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="field">
        <label>Nhóm</label>
        <select className="input" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
          <option value="">— Không xếp nhóm —</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label>Loại</label>
        <select className="input" value={kind} onChange={(e) => setKind(e.target.value)}>
          {Object.entries(KIND_LABEL).map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label>Thời lượng (phút) — quyết định độ dài ô lịch hẹn</label>
        <input
          className="input"
          type="number"
          value={durationMin}
          onChange={(e) => setDurationMin(Number(e.target.value))}
        />
      </div>
    </Modal>
  )
}
