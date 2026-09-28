import React, { useCallback, useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'
import {
  createTransfer,
  createWarehouse,
  decideTransfer,
  executeTransfer,
  fetchOnHand,
  fetchProducts,
  fetchServiceMaterials,
  fetchServices,
  fetchStockCard,
  fetchTransfers,
  fetchValuation,
  fetchWarehouses,
  getApiErrorMessage,
  saveServiceMaterials,
  type ProductRow,
  type ServiceMaterialRow,
  type StockCardData,
  type StockLotRow,
  type TransferRow,
  type ValuationData,
  type WarehouseRow
} from '../lib/api'
import { useAuth } from '../lib/auth-context'
import { dateTimeVi, dateVi, vnd, vndShort } from '../lib/format'
import { Empty, Modal, Tag, useToast } from '../components/ui'
import type { Service } from '../lib/types'

/* KHO NÂNG CẤP — ba màn: Chuyển kho · Định mức vật tư · Báo cáo kho.
   Dùng chung khung, phân biệt bằng đường dẫn. */

const TRANSFER_STATUS: Record<string, { t: string; bg: string; fg: string }> = {
  PENDING: { t: 'Chờ duyệt', bg: '#FEF3C7', fg: '#B45309' },
  APPROVED: { t: 'Đã duyệt — chờ xuất', bg: '#DBEAFE', fg: '#1D4ED8' },
  COMPLETED: { t: 'Đã xuất hàng', bg: '#DCFCE7', fg: '#15803D' },
  REJECTED: { t: 'Từ chối', bg: '#FEE2E2', fg: '#B91C1C' }
}

const KIND_LABEL: Record<string, string> = {
  CONSUMABLE: 'Tiêu hao',
  IMPLANT: 'Cấy ghép',
  MEDICINE: 'Thuốc',
  FILLER: 'Filler',
  INSTRUMENT: 'Dụng cụ',
  COSMETIC: 'Mỹ phẩm',
  OTHER: 'Khác'
}

export default function InventoryAdvanced(): React.JSX.Element {
  const location = useLocation()
  if (location.pathname.includes('dinh-muc')) return <MaterialsView />
  if (location.pathname.includes('bao-cao-kho')) return <ReportView />
  return <TransferView />
}

/* --------------------------------------------------------- CHUYỂN KHO */

function TransferView(): React.JSX.Element {
  const { can, branchId } = useAuth()
  const { say, fail } = useToast()

  const [rows, setRows] = useState<TransferRow[]>([])
  const [warehouses, setWarehouses] = useState<WarehouseRow[]>([])
  const [creating, setCreating] = useState(false)
  const [addingWarehouse, setAddingWarehouse] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [t, w] = await Promise.all([fetchTransfers(), fetchWarehouses()])
      setRows(t)
      setWarehouses(w)
    } catch (err) {
      fail(getApiErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }, [fail])

  useEffect(() => {
    void load()
  }, [load, branchId])

  const decide = async (t: TransferRow, status: string): Promise<void> => {
    const note = status === 'REJECTED' ? window.prompt('Lý do từ chối:') ?? undefined : undefined
    if (status === 'REJECTED' && !note) return
    setBusy(t.id)
    try {
      await decideTransfer(t.id, status, note)
      say(status === 'APPROVED' ? 'Đã duyệt. Bấm "Xuất hàng" khi thực sự chuyển.' : 'Đã từ chối phiếu.')
      void load()
    } catch (err) {
      fail(getApiErrorMessage(err))
    } finally {
      setBusy(null)
    }
  }

  const execute = async (t: TransferRow): Promise<void> => {
    setBusy(t.id)
    try {
      await executeTransfer(t.id)
      say('Đã xuất hàng. Tồn hai kho đã cập nhật, mã lô và hạn dùng giữ nguyên.')
      void load()
    } catch (err) {
      fail(getApiErrorMessage(err))
    } finally {
      setBusy(null)
    }
  }

  const pending = rows.filter((r) => r.status === 'PENDING')
  const approved = rows.filter((r) => r.status === 'APPROVED')

  return (
    <>
      <div className="grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)', marginBottom: 12 }}>
        <div className="kpi">
          <div className="lab">Kho đang quản lý</div>
          <div className="val">{warehouses.length}</div>
          <div className="dt muted">
            {warehouses.filter((w) => w.kind === 'MAIN').length} kho tổng ·{' '}
            {warehouses.filter((w) => w.kind === 'SUB').length} kho con
          </div>
        </div>
        <div className="kpi">
          <div className="lab">Phiếu chờ duyệt</div>
          <div className="val" style={{ color: pending.length ? 'var(--warn)' : undefined }}>
            {pending.length}
          </div>
        </div>
        <div className="kpi">
          <div className="lab">Đã duyệt, chờ xuất</div>
          <div className="val" style={{ color: approved.length ? 'var(--info)' : undefined }}>
            {approved.length}
          </div>
        </div>
        <div className="kpi">
          <div className="lab">Tổng phiếu</div>
          <div className="val">{rows.length}</div>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 12, padding: 0, overflow: 'hidden' }}>
        <div className="row" style={{ padding: '12px 14px 0' }}>
          <div className="sec-title" style={{ margin: 0 }}>
            Cây kho
          </div>
          {can('inventory.create') ? (
            <button className="btn sec sm" style={{ marginLeft: 'auto' }} onClick={() => setAddingWarehouse(true)}>
              + Thêm kho
            </button>
          ) : null}
        </div>
        <table>
          <thead>
            <tr>
              <th>Kho</th>
              <th>Loại</th>
              <th>Trực thuộc</th>
              <th>Tồn</th>
              <th>Số lô</th>
            </tr>
          </thead>
          <tbody>
            {warehouses.map((w) => (
              <tr key={w.id}>
                <td style={{ paddingLeft: w.kind === 'SUB' ? 32 : undefined }}>
                  {w.kind === 'SUB' ? '└ ' : ''}
                  <b>{w.name}</b>
                  <div className="muted" style={{ fontSize: 11.5 }}>
                    {w.code}
                  </div>
                </td>
                <td>
                  <span
                    className="tag"
                    style={
                      w.kind === 'MAIN'
                        ? { background: '#DCFCE7', color: '#15803D' }
                        : { background: '#EEF2FF', color: '#4338CA' }
                    }
                  >
                    {w.kind === 'MAIN' ? 'Kho tổng' : 'Kho con'}
                  </span>
                </td>
                <td className="muted">{w.parent?.name ?? '—'}</td>
                <td>
                  <b>{w.onHand}</b>
                </td>
                <td className="muted">{w.lotCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="row" style={{ marginBottom: 12 }}>
        <span className="muted" style={{ fontSize: 12.5 }}>
          Hàng chỉ rời kho khi bấm “Xuất hàng” — duyệt xong mà chưa xuất thì tồn chưa đổi, nhờ vậy thẻ
          kho luôn khớp hàng thật trên kệ.
        </span>
        {can('inventory.create') ? (
          <button className="btn" style={{ marginLeft: 'auto' }} onClick={() => setCreating(true)}>
            + Phiếu chuyển kho
          </button>
        ) : null}
      </div>

      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        {loading ? (
          <Empty>Đang tải…</Empty>
        ) : rows.length === 0 ? (
          <Empty>Chưa có phiếu chuyển kho nào.</Empty>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Mã phiếu</th>
                <th>Từ kho</th>
                <th>Sang kho</th>
                <th>Nội dung</th>
                <th>Người đề nghị</th>
                <th>Trạng thái</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => (
                <tr key={t.id}>
                  <td>
                    <b>{t.code}</b>
                    <div className="muted" style={{ fontSize: 11.5 }}>
                      {dateTimeVi(t.createdAt)}
                    </div>
                  </td>
                  <td>{t.fromWarehouse.name}</td>
                  <td>{t.toWarehouse.name}</td>
                  <td>
                    {t.items.map((i) => (
                      <div key={i.id} style={{ fontSize: 12.5 }}>
                        {i.quantity} {i.product.unit} {i.product.name}
                        {i.lot ? (
                          <span className="muted"> · lô {i.lot.lotNumber}</span>
                        ) : null}
                      </div>
                    ))}
                    {t.reason ? (
                      <div className="muted" style={{ fontSize: 11.5 }}>
                        {t.reason}
                      </div>
                    ) : null}
                  </td>
                  <td className="muted">{t.requestedBy?.name ?? '—'}</td>
                  <td>
                    <Tag style={TRANSFER_STATUS[t.status] ?? TRANSFER_STATUS.PENDING} />
                    {t.rejectNote ? (
                      <div className="down" style={{ fontSize: 11 }}>
                        {t.rejectNote}
                      </div>
                    ) : null}
                  </td>
                  <td>
                    <div className="row" style={{ gap: 4 }}>
                      {can('inventory.approve') && t.status === 'PENDING' ? (
                        <>
                          <button className="btn sm" disabled={busy === t.id} onClick={() => void decide(t, 'APPROVED')}>
                            Duyệt
                          </button>
                          <button
                            className="btn sec sm"
                            disabled={busy === t.id}
                            onClick={() => void decide(t, 'REJECTED')}
                          >
                            Từ chối
                          </button>
                        </>
                      ) : null}
                      {can('inventory.update') && t.status === 'APPROVED' ? (
                        <button className="btn sm" disabled={busy === t.id} onClick={() => void execute(t)}>
                          Xuất hàng
                        </button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {creating ? (
        <TransferModal
          warehouses={warehouses}
          onClose={() => setCreating(false)}
          onDone={() => {
            setCreating(false)
            void load()
          }}
        />
      ) : null}
      {addingWarehouse ? (
        <WarehouseModal
          warehouses={warehouses}
          onClose={() => setAddingWarehouse(false)}
          onDone={() => {
            setAddingWarehouse(false)
            void load()
          }}
        />
      ) : null}
    </>
  )
}

function WarehouseModal({
  warehouses,
  onClose,
  onDone
}: {
  warehouses: WarehouseRow[]
  onClose: () => void
  onDone: () => void
}): React.JSX.Element {
  const { say, fail } = useToast()
  const [form, setForm] = useState({ code: '', name: '', kind: 'SUB', parentId: '' })
  const [saving, setSaving] = useState(false)

  const mains = warehouses.filter((w) => w.kind === 'MAIN')

  const submit = async (): Promise<void> => {
    if (!form.code || !form.name) {
      fail('Nhập mã và tên kho.')
      return
    }
    if (form.kind === 'SUB' && !form.parentId) {
      fail('Kho con phải chọn kho tổng cấp trên.')
      return
    }
    setSaving(true)
    try {
      await createWarehouse({
        code: form.code.trim(),
        name: form.name.trim(),
        kind: form.kind,
        parentId: form.kind === 'SUB' ? form.parentId : null
      })
      say('Đã thêm kho.')
      onDone()
    } catch (err) {
      fail(getApiErrorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      title="Thêm kho"
      onClose={onClose}
      footer={
        <>
          <button className="btn sec" onClick={onClose}>
            Huỷ
          </button>
          <button className="btn" onClick={() => void submit()} disabled={saving}>
            {saving ? 'Đang lưu…' : 'Thêm kho'}
          </button>
        </>
      }
    >
      <div className="field">
        <label>Loại kho</label>
        <select
          className="input"
          value={form.kind}
          onChange={(e) => setForm((f) => ({ ...f, kind: e.target.value }))}
        >
          <option value="MAIN">Kho tổng — nhập hàng từ nhà cung cấp</option>
          <option value="SUB">Kho con — nhận hàng từ kho tổng</option>
        </select>
      </div>
      {form.kind === 'SUB' ? (
        <div className="field">
          <label>Trực thuộc kho tổng *</label>
          <select
            className="input"
            value={form.parentId}
            onChange={(e) => setForm((f) => ({ ...f, parentId: e.target.value }))}
          >
            <option value="">— Chọn kho tổng —</option>
            {mains.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      <div className="row" style={{ gap: 10 }}>
        <div className="field" style={{ flex: 1 }}>
          <label>Mã kho *</label>
          <input
            className="input"
            value={form.code}
            onChange={(e) => setForm((f) => ({ ...f, code: e.target.value }))}
            placeholder="KHO_PM"
          />
        </div>
        <div className="field" style={{ flex: 2 }}>
          <label>Tên kho *</label>
          <input
            className="input"
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            placeholder="Kho phòng mổ"
          />
        </div>
      </div>
    </Modal>
  )
}

function TransferModal({
  warehouses,
  onClose,
  onDone
}: {
  warehouses: WarehouseRow[]
  onClose: () => void
  onDone: () => void
}): React.JSX.Element {
  const { say, fail } = useToast()
  const [fromId, setFromId] = useState('')
  const [toId, setToId] = useState('')
  const [reason, setReason] = useState('')
  const [lots, setLots] = useState<StockLotRow[]>([])
  const [items, setItems] = useState<Array<{ lotId: string; productId: string; quantity: number; label: string; max: number }>>([])
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    fetchOnHand()
      .then((r) => setLots(r.items))
      .catch(() => undefined)
  }, [])

  const availableLots = lots.filter((l) => l.warehouse.id === fromId)

  const submit = async (): Promise<void> => {
    if (!fromId || !toId || !items.length) {
      fail('Chọn kho nguồn, kho đích và ít nhất một lô.')
      return
    }
    setSaving(true)
    try {
      const t = await createTransfer({
        fromWarehouseId: fromId,
        toWarehouseId: toId,
        reason: reason || undefined,
        items: items.map((i) => ({ productId: i.productId, lotId: i.lotId, quantity: i.quantity }))
      })
      say(`Đã lập phiếu ${t.code}, chờ duyệt.`)
      onDone()
    } catch (err) {
      fail(getApiErrorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      title="Phiếu chuyển kho"
      onClose={onClose}
      width={660}
      footer={
        <>
          <button className="btn sec" onClick={onClose}>
            Huỷ
          </button>
          <button className="btn" onClick={() => void submit()} disabled={saving || !items.length}>
            {saving ? 'Đang lưu…' : 'Lập phiếu'}
          </button>
        </>
      }
    >
      <div className="row" style={{ gap: 10 }}>
        <div className="field" style={{ flex: 1 }}>
          <label>Từ kho *</label>
          <select
            className="input"
            value={fromId}
            onChange={(e) => {
              setFromId(e.target.value)
              setItems([])
            }}
          >
            <option value="">— Chọn —</option>
            {warehouses.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field" style={{ flex: 1 }}>
          <label>Sang kho *</label>
          <select className="input" value={toId} onChange={(e) => setToId(e.target.value)}>
            <option value="">— Chọn —</option>
            {warehouses
              .filter((w) => w.id !== fromId)
              .map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
          </select>
        </div>
      </div>

      {fromId ? (
        <div className="field">
          <label>Thêm lô cần chuyển</label>
          <select
            className="input"
            value=""
            onChange={(e) => {
              const lot = availableLots.find((l) => l.id === e.target.value)
              if (!lot) return
              setItems((xs) => [
                ...xs,
                {
                  lotId: lot.id,
                  productId: lot.product.id,
                  quantity: 1,
                  label: `${lot.product.name} · lô ${lot.lotNumber}`,
                  max: lot.quantity
                }
              ])
              e.target.value = ''
            }}
          >
            <option value="">— Chọn lô —</option>
            {availableLots
              .filter((l) => !items.some((i) => i.lotId === l.id))
              .map((l) => (
                <option key={l.id} value={l.id}>
                  {l.product.name} · lô {l.lotNumber} (còn {l.quantity})
                  {l.expiryDate ? ` · HSD ${dateVi(l.expiryDate)}` : ''}
                </option>
              ))}
          </select>
        </div>
      ) : null}

      {items.length ? (
        <table style={{ marginBottom: 10 }}>
          <thead>
            <tr>
              <th>Lô</th>
              <th style={{ width: 110 }}>Số lượng</th>
              <th style={{ width: 32 }} />
            </tr>
          </thead>
          <tbody>
            {items.map((i, idx) => (
              <tr key={i.lotId}>
                <td>{i.label}</td>
                <td>
                  <input
                    className="input"
                    type="number"
                    min={1}
                    max={i.max}
                    value={i.quantity}
                    onChange={(e) =>
                      setItems((xs) =>
                        xs.map((x, n) => (n === idx ? { ...x, quantity: Number(e.target.value) } : x))
                      )
                    }
                  />
                  <div className="muted" style={{ fontSize: 11 }}>
                    còn {i.max}
                  </div>
                </td>
                <td>
                  <button
                    className="btn sec sm"
                    onClick={() => setItems((xs) => xs.filter((_, n) => n !== idx))}
                  >
                    ✕
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}

      <div className="field">
        <label>Lý do chuyển</label>
        <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} />
      </div>
      <div className="muted" style={{ fontSize: 11.5 }}>
        Phiếu phải được duyệt trước, hàng chỉ rời kho khi bấm “Xuất hàng”. Mã lô và hạn dùng được giữ
        nguyên sang kho đích để không đứt truy vết.
      </div>
    </Modal>
  )
}

/* ------------------------------------------------- ĐỊNH MỨC VẬT TƯ */

function MaterialsView(): React.JSX.Element {
  const { can } = useAuth()
  const { say, fail } = useToast()

  const [services, setServices] = useState<Service[]>([])
  const [products, setProducts] = useState<ProductRow[]>([])
  const [rows, setRows] = useState<ServiceMaterialRow[]>([])
  const [editing, setEditing] = useState<Service | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [s, p, m] = await Promise.all([fetchServices(), fetchProducts(), fetchServiceMaterials()])
      setServices(s)
      setProducts(p)
      setRows(m)
    } catch (err) {
      fail(getApiErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }, [fail])

  useEffect(() => {
    void load()
  }, [load])

  const byService = new Map<string, ServiceMaterialRow[]>()
  for (const r of rows) byService.set(r.service.id, [...(byService.get(r.service.id) ?? []), r])

  return (
    <>
      <div className="alert wr">
        Định mức gắn vật tư vào từng dịch vụ. Khi bấm <b>“Kết thúc mổ”</b>, hệ thống tự trừ kho theo
        định mức và ghi truy vết lô — điều dưỡng không phải nhập tay, chỗ hay sai số nhất.
      </div>

      <div className="grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)', marginBottom: 12 }}>
        <div className="kpi">
          <div className="lab">Dịch vụ có định mức</div>
          <div className="val">{byService.size}</div>
        </div>
        <div className="kpi">
          <div className="lab">Dịch vụ chưa đặt</div>
          <div className="val" style={{ color: services.length - byService.size ? 'var(--warn)' : undefined }}>
            {services.length - byService.size}
          </div>
        </div>
        <div className="kpi">
          <div className="lab">Dòng định mức</div>
          <div className="val">{rows.length}</div>
        </div>
      </div>

      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        {loading ? (
          <Empty>Đang tải…</Empty>
        ) : services.length === 0 ? (
          <Empty>Chưa có dịch vụ nào.</Empty>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Dịch vụ</th>
                <th>Định mức vật tư</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {services.map((s) => {
                const mats = byService.get(s.id) ?? []
                return (
                  <tr key={s.id}>
                    <td>
                      <b>{s.name}</b>
                      <div className="muted" style={{ fontSize: 11.5 }}>
                        {s.code}
                      </div>
                    </td>
                    <td>
                      {mats.length === 0 ? (
                        <span className="muted">Chưa đặt định mức — không tự trừ kho</span>
                      ) : (
                        mats.map((m) => (
                          <div key={m.id} style={{ fontSize: 12.8 }}>
                            {m.quantity} {m.product.unit} <b>{m.product.name}</b>
                            {m.product.isImplant ? (
                              <span className="tag" style={{ background: '#FAE8FF', color: '#A21CAF', marginLeft: 6 }}>
                                cấy ghép
                              </span>
                            ) : null}
                          </div>
                        ))
                      )}
                    </td>
                    <td>
                      {can('inventory.update') ? (
                        <button className="btn sec sm" onClick={() => setEditing(s)}>
                          {mats.length ? 'Sửa định mức' : 'Đặt định mức'}
                        </button>
                      ) : null}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      {editing ? (
        <MaterialModal
          service={editing}
          products={products}
          current={byService.get(editing.id) ?? []}
          onClose={() => setEditing(null)}
          onDone={() => {
            setEditing(null)
            void load()
          }}
        />
      ) : null}
    </>
  )
}

function MaterialModal({
  service,
  products,
  current,
  onClose,
  onDone
}: {
  service: Service
  products: ProductRow[]
  current: ServiceMaterialRow[]
  onClose: () => void
  onDone: () => void
}): React.JSX.Element {
  const { say, fail } = useToast()
  const [items, setItems] = useState(
    current.map((c) => ({ productId: c.product.id, name: c.product.name, unit: c.product.unit, quantity: c.quantity, required: c.required }))
  )
  const [saving, setSaving] = useState(false)

  const submit = async (): Promise<void> => {
    setSaving(true)
    try {
      const r = await saveServiceMaterials(
        service.id,
        items.map((i) => ({ productId: i.productId, quantity: i.quantity, required: i.required }))
      )
      say(`Đã lưu định mức: ${r.count} loại vật tư.`)
      onDone()
    } catch (err) {
      fail(getApiErrorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      title={`Định mức vật tư — ${service.name}`}
      onClose={onClose}
      width={620}
      footer={
        <>
          <button className="btn sec" onClick={onClose}>
            Huỷ
          </button>
          <button className="btn" onClick={() => void submit()} disabled={saving}>
            {saving ? 'Đang lưu…' : 'Lưu định mức'}
          </button>
        </>
      }
    >
      <div className="field">
        <label>Thêm vật tư</label>
        <select
          className="input"
          value=""
          onChange={(e) => {
            const p = products.find((x) => x.id === e.target.value)
            if (!p) return
            setItems((xs) => [...xs, { productId: p.id, name: p.name, unit: p.unit, quantity: 1, required: true }])
            e.target.value = ''
          }}
        >
          <option value="">— Chọn vật tư —</option>
          {products
            .filter((p) => !items.some((i) => i.productId === p.id))
            .map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.unit})
              </option>
            ))}
        </select>
      </div>

      {items.length === 0 ? (
        <Empty>Chưa có vật tư nào. Dịch vụ không có định mức thì sẽ không tự trừ kho.</Empty>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Vật tư</th>
              <th style={{ width: 110 }}>Định mức</th>
              <th style={{ width: 90 }}>Bắt buộc</th>
              <th style={{ width: 32 }} />
            </tr>
          </thead>
          <tbody>
            {items.map((i, idx) => (
              <tr key={i.productId}>
                <td>{i.name}</td>
                <td>
                  <input
                    className="input"
                    type="number"
                    min={1}
                    value={i.quantity}
                    onChange={(e) =>
                      setItems((xs) => xs.map((x, n) => (n === idx ? { ...x, quantity: Number(e.target.value) } : x)))
                    }
                  />
                  <div className="muted" style={{ fontSize: 11 }}>
                    {i.unit} / ca
                  </div>
                </td>
                <td>
                  <input
                    type="checkbox"
                    checked={i.required}
                    onChange={(e) =>
                      setItems((xs) => xs.map((x, n) => (n === idx ? { ...x, required: e.target.checked } : x)))
                    }
                  />
                </td>
                <td>
                  <button className="btn sec sm" onClick={() => setItems((xs) => xs.filter((_, n) => n !== idx))}>
                    ✕
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="muted" style={{ fontSize: 11.5, marginTop: 8 }}>
        Khi trừ kho, hệ thống chọn lô theo FEFO — lô sắp hết hạn dùng trước, và bỏ qua lô đã hết hạn.
      </div>
    </Modal>
  )
}

/* ---------------------------------------------------------- BÁO CÁO KHO */

function ReportView(): React.JSX.Element {
  const { branchId } = useAuth()
  const { fail } = useToast()

  const [data, setData] = useState<ValuationData | null>(null)
  const [products, setProducts] = useState<ProductRow[]>([])
  const [cardProduct, setCardProduct] = useState('')
  const [card, setCard] = useState<StockCardData | null>(null)
  const [tab, setTab] = useState<'valuation' | 'card'>('valuation')

  useEffect(() => {
    fetchValuation().then(setData).catch((err) => fail(getApiErrorMessage(err)))
    fetchProducts().then(setProducts).catch(() => undefined)
  }, [fail, branchId])

  useEffect(() => {
    if (!cardProduct) {
      setCard(null)
      return
    }
    fetchStockCard({ productId: cardProduct, from: '2020-01-01' })
      .then(setCard)
      .catch((err) => fail(getApiErrorMessage(err)))
  }, [cardProduct, fail])

  return (
    <>
      <div className="tabs">
        <button className={tab === 'valuation' ? 'on' : ''} onClick={() => setTab('valuation')}>
          Giá trị tồn &amp; cảnh báo định mức
        </button>
        <button className={tab === 'card' ? 'on' : ''} onClick={() => setTab('card')}>
          Thẻ kho
        </button>
      </div>

      {tab === 'valuation' ? (
        !data ? (
          <div className="card">
            <Empty>Đang tải…</Empty>
          </div>
        ) : (
          <>
            <div className="grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)', marginBottom: 12 }}>
              <div className="kpi">
                <div className="lab">Giá trị tồn kho</div>
                <div className="val">{vnd(data.totalValue)}</div>
                <div className="dt muted">{data.lotCount} lô</div>
              </div>
              <div className="kpi">
                <div className="lab">Lô cận hạn</div>
                <div className="val" style={{ color: data.expiringCount ? 'var(--warn)' : undefined }}>
                  {data.expiringCount} lô
                </div>
                <div className="dt muted">giá trị {vnd(data.expiringValue)}</div>
              </div>
              <div className="kpi">
                <div className="lab">Lô đã hết hạn</div>
                <div className="val" style={{ color: data.expiredCount ? 'var(--danger)' : undefined }}>
                  {data.expiredCount} lô
                </div>
                <div className={data.expiredCount ? 'dt down' : 'dt muted'}>
                  {data.expiredCount ? 'Cần xử lý huỷ' : `giá trị ${vnd(data.expiredValue)}`}
                </div>
              </div>
              <div className="kpi">
                <div className="lab">Cảnh báo định mức</div>
                <div className="val" style={{ color: data.belowMin.length ? 'var(--danger)' : undefined }}>
                  {data.belowMin.length + data.aboveMax.length}
                </div>
                <div className="dt muted">
                  {data.belowMin.length} thiếu · {data.aboveMax.length} thừa
                </div>
              </div>
            </div>

            {data.belowMin.length ? (
              <div className="card" style={{ marginBottom: 12 }}>
                <div className="sec-title">Dưới định mức tối thiểu — cần bổ sung gấp</div>
                {data.belowMin.map((p) => (
                  <div className="alert dg" key={p.productId}>
                    <b>{p.name}</b>: còn {p.qty} {p.unit}, định mức tối thiểu {p.min} — <b>thiếu {p.shortage}</b>
                  </div>
                ))}
              </div>
            ) : null}

            {data.aboveMax.length ? (
              <div className="card" style={{ marginBottom: 12 }}>
                <div className="sec-title">Vượt định mức tối đa — ứ đọng vốn</div>
                {data.aboveMax.map((p) => (
                  <div className="alert wr" key={p.productId}>
                    <b>{p.name}</b>: tồn {p.qty} {p.unit}, định mức tối đa {p.max} — thừa {p.excess}
                  </div>
                ))}
              </div>
            ) : null}

            <div className="grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
              <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
                <div className="sec-title" style={{ padding: '12px 14px 0' }}>
                  Giá trị tồn theo kho
                </div>
                <table>
                  <thead>
                    <tr>
                      <th>Kho</th>
                      <th>Loại</th>
                      <th>Số lượng</th>
                      <th>Giá trị</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.byWarehouse.map((w) => (
                      <tr key={w.warehouseId}>
                        <td>
                          <b>{w.name}</b>
                        </td>
                        <td className="muted">{w.kind === 'MAIN' ? 'Kho tổng' : 'Kho con'}</td>
                        <td>{w.qty}</td>
                        <td>
                          <b>{vndShort(w.value)}</b>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
                <div className="sec-title" style={{ padding: '12px 14px 0' }}>
                  Giá trị tồn theo nhóm vật tư
                </div>
                <table>
                  <thead>
                    <tr>
                      <th>Nhóm</th>
                      <th>Số lượng</th>
                      <th>Giá trị</th>
                      <th style={{ width: 120 }}>Tỉ trọng</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.byKind.map((k) => (
                      <tr key={k.kind}>
                        <td>{KIND_LABEL[k.kind] ?? k.kind}</td>
                        <td>{k.qty}</td>
                        <td>
                          <b>{vndShort(k.value)}</b>
                        </td>
                        <td>
                          <div className="bar">
                            <i style={{ width: `${data.totalValue ? (k.value / data.totalValue) * 100 : 0}%` }} />
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )
      ) : (
        <>
          <div className="row" style={{ marginBottom: 12 }}>
            <select
              className="input"
              style={{ width: 340 }}
              value={cardProduct}
              onChange={(e) => setCardProduct(e.target.value)}
            >
              <option value="">— Chọn vật tư để xem thẻ kho —</option>
              {products.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>

          {!card ? (
            <div className="card">
              <Empty>Chọn một vật tư ở trên để xem thẻ kho.</Empty>
            </div>
          ) : (
            <>
              <div className="grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)', marginBottom: 12 }}>
                <div className="kpi">
                  <div className="lab">Tồn đầu kỳ</div>
                  <div className="val">{card.openingBalance}</div>
                </div>
                <div className="kpi">
                  <div className="lab">Tổng nhập</div>
                  <div className="val up">+{card.totalIn}</div>
                </div>
                <div className="kpi">
                  <div className="lab">Tổng xuất</div>
                  <div className="val down">-{card.totalOut}</div>
                </div>
                <div className="kpi">
                  <div className="lab">Tồn cuối kỳ</div>
                  <div className="val">{card.closingBalance}</div>
                </div>
              </div>

              <div className="card" style={{ padding: 0, overflow: 'auto' }}>
                <table>
                  <thead>
                    <tr>
                      <th>Thời gian</th>
                      <th>Loại</th>
                      <th>Kho</th>
                      <th>Lô</th>
                      <th>Nhập</th>
                      <th>Xuất</th>
                      <th>Tồn</th>
                      <th>Diễn giải</th>
                      <th>Người thực hiện</th>
                    </tr>
                  </thead>
                  <tbody>
                    {card.rows.map((r) => (
                      <tr key={r.id}>
                        <td className="muted" style={{ whiteSpace: 'nowrap' }}>
                          {dateTimeVi(r.at)}
                        </td>
                        <td>
                          <span className="tag out">{r.type}</span>
                        </td>
                        <td>{r.warehouse}</td>
                        <td className="muted">{r.lotNumber ?? '—'}</td>
                        <td className={r.inQty ? 'up' : 'muted'}>{r.inQty || '—'}</td>
                        <td className={r.outQty ? 'down' : 'muted'}>{r.outQty || '—'}</td>
                        <td>
                          <b>{r.balance}</b>
                        </td>
                        <td style={{ fontSize: 12 }}>{r.reason ?? '—'}</td>
                        <td className="muted">{r.actor ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}
    </>
  )
}
