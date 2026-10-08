import React, { useCallback, useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import {
  adjustStock,
  createProduct,
  createSupplier,
  deleteLot,
  deleteProduct,
  deleteSupplier,
  issueStock,
  quickAdjust,
  updateLot,
  updateProduct,
  updateSupplier,
  fetchCustomers,
  fetchMovements,
  fetchOnHand,
  fetchProducts,
  fetchSuppliers,
  fetchTraceability,
  getApiErrorMessage,
  receiveStock,
  useStock,
  type ProductRow,
  type StockLotRow,
  type StockMovementRow,
  type SupplierRow,
  type TraceabilityResult
} from '../lib/api'
import { useAuth } from '../lib/auth-context'
import { dateTimeVi, dateVi, toISODate, vnd } from '../lib/format'
import { Empty, Modal, Tag, useToast } from '../components/ui'
import type { CustomerListItem } from '../lib/types'

/* KHO VẬT TƯ THEO LÔ — 4 màn dùng chung một khung, phân biệt bằng đường dẫn:
   /ton-kho · /xuat-nhap-kho · /truy-vet-lo · /nha-cung-cap

   Lý do gộp: cả bốn đều xoay quanh cùng một bộ dữ liệu (vật tư · lô · biến
   động), tách file chỉ làm phải nạp lại danh mục bốn lần. */

const KIND_LABEL: Record<string, string> = {
  CONSUMABLE: 'Vật tư tiêu hao',
  IMPLANT: 'Vật tư cấy ghép',
  MEDICINE: 'Thuốc',
  FILLER: 'Filler / chất làm đầy',
  INSTRUMENT: 'Dụng cụ',
  COSMETIC: 'Mỹ phẩm',
  OTHER: 'Khác'
}

const MOVE_LABEL: Record<string, { t: string; bg: string; fg: string }> = {
  IN: { t: 'Nhập', bg: '#DCFCE7', fg: '#15803D' },
  OUT: { t: 'Xuất dùng', bg: '#DBEAFE', fg: '#1D4ED8' },
  TRANSFER: { t: 'Chuyển kho', bg: '#EEF2FF', fg: '#4338CA' },
  ADJUST: { t: 'Điều chỉnh', bg: '#FEF3C7', fg: '#B45309' },
  DISPOSE: { t: 'Huỷ', bg: '#FEE2E2', fg: '#B91C1C' }
}

export default function Inventory(): React.JSX.Element {
  const location = useLocation()
  const kind = location.pathname.includes('xuat-nhap')
    ? 'movements'
    : location.pathname.includes('truy-vet')
      ? 'trace'
      : location.pathname.includes('nha-cung-cap')
        ? 'suppliers'
        : 'stock'

  if (kind === 'movements') return <MovementsView />
  if (kind === 'trace') return <TraceView />
  if (kind === 'suppliers') return <SuppliersView />
  return <StockView />
}

/* ------------------------------------------------------------- TỒN KHO */

function StockView(): React.JSX.Element {
  const { can, branchId } = useAuth()
  const { say, fail } = useToast()

  const [lots, setLots] = useState<StockLotRow[]>([])
  const [stats, setStats] = useState({ lotCount: 0, expired: 0, expiringSoon: 0, totalValue: 0 })
  const [products, setProducts] = useState<ProductRow[]>([])
  const [tab, setTab] = useState<'lots' | 'products'>('lots')
  const [receiving, setReceiving] = useState<StockLotRow | true | null>(null)
  const [addingProduct, setAddingProduct] = useState(false)
  const [using, setUsing] = useState<StockLotRow | null>(null)
  const [issuing, setIssuing] = useState<StockLotRow | null>(null)
  const [editingLot, setEditingLot] = useState<StockLotRow | null>(null)
  const [editingProduct, setEditingProduct] = useState<ProductRow | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [showEmpty, setShowEmpty] = useState(false)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [onHand, prods] = await Promise.all([
        fetchOnHand(showEmpty ? { all: '1' } : {}),
        fetchProducts()
      ])
      setLots(onHand.items)
      setStats(onHand.stats)
      setProducts(prods)
    } catch (err) {
      fail(getApiErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }, [fail, showEmpty])

  useEffect(() => {
    void load()
  }, [load, branchId])

  /** Cộng/trừ 1 đơn vị ngay tại dòng — dùng khi kiểm đếm thấy lệch. */
  const bump = async (lot: StockLotRow, delta: number): Promise<void> => {
    setBusy(lot.id)
    try {
      const r = await quickAdjust({ lotId: lot.id, delta })
      say(`${lot.product.name} · lô ${lot.lotNumber}: còn ${r.quantity} ${lot.product.unit}`)
      void load()
    } catch (err) {
      fail(getApiErrorMessage(err))
    } finally {
      setBusy(null)
    }
  }

  const removeLot = async (lot: StockLotRow): Promise<void> => {
    if (!window.confirm(`Xoá lô rỗng ${lot.lotNumber}?`)) return
    try {
      await deleteLot(lot.id)
      say('Đã xoá lô.')
      void load()
    } catch (err) {
      fail(getApiErrorMessage(err))
    }
  }

  const removeProduct = async (p: ProductRow): Promise<void> => {
    if (!window.confirm(`Xoá vật tư "${p.name}"?`)) return
    try {
      await deleteProduct(p.id)
      say('Đã xoá vật tư.')
      void load()
    } catch (err) {
      fail(getApiErrorMessage(err))
    }
  }

  const toggleProduct = async (p: ProductRow): Promise<void> => {
    try {
      await updateProduct(p.id, { active: !p.active })
      say(p.active ? 'Đã ngưng dùng vật tư.' : 'Đã dùng lại vật tư.')
      void load()
    } catch (err) {
      fail(getApiErrorMessage(err))
    }
  }

  const dispose = async (lot: StockLotRow): Promise<void> => {
    const reason = window.prompt(`Huỷ lô ${lot.lotNumber} — nhập lý do (bắt buộc):`)
    if (!reason || reason.length < 3) return
    try {
      await adjustStock({ lotId: lot.id, quantity: -lot.quantity, type: 'DISPOSE', reason })
      say('Đã huỷ lô và ghi vào sổ kho.')
      void load()
    } catch (err) {
      fail(getApiErrorMessage(err))
    }
  }

  return (
    <>
      <div className="grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)', marginBottom: 12 }}>
        <div className="kpi">
          <div className="lab">Lô còn hàng</div>
          <div className="val">{stats.lotCount}</div>
        </div>
        <div className="kpi">
          <div className="lab">Giá trị tồn</div>
          <div className="val">{vnd(stats.totalValue)}</div>
        </div>
        <div className="kpi">
          <div className="lab">Cận hạn (90 ngày)</div>
          <div className="val" style={{ color: stats.expiringSoon ? 'var(--warn)' : undefined }}>
            {stats.expiringSoon}
          </div>
        </div>
        <div className="kpi">
          <div className="lab">Đã hết hạn</div>
          <div className="val" style={{ color: stats.expired ? 'var(--danger)' : undefined }}>
            {stats.expired}
          </div>
          {stats.expired ? <div className="dt down">Không được dùng cho khách</div> : null}
        </div>
      </div>

      <div className="tabs">
        <button className={tab === 'lots' ? 'on' : ''} onClick={() => setTab('lots')}>
          Tồn theo lô ({lots.length})
        </button>
        <button className={tab === 'products' ? 'on' : ''} onClick={() => setTab('products')}>
          Danh mục vật tư ({products.length})
        </button>
      </div>

      <div className="row" style={{ marginBottom: 12 }}>
        <span className="muted" style={{ fontSize: 12.5 }}>
          Vật tư cấy ghép bắt buộc theo lô — đó là điều kiện để truy vết khi có thu hồi.
        </span>
        <label className="row" style={{ marginLeft: 'auto', gap: 6, fontSize: 12.5 }}>
          <input type="checkbox" checked={showEmpty} onChange={(e) => setShowEmpty(e.target.checked)} />
          Hiện cả lô đã hết
        </label>
        {can('inventory.create') ? (
          <>
            <button className="btn sec sm" onClick={() => setAddingProduct(true)}>
              + Vật tư mới
            </button>
            <button className="btn sm" onClick={() => setReceiving(true)}>
              + Nhập kho
            </button>
          </>
        ) : null}
      </div>

      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        {loading ? (
          <Empty>Đang tải…</Empty>
        ) : tab === 'products' ? (
          products.length === 0 ? (
            <Empty>Chưa khai báo vật tư nào.</Empty>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Mã</th>
                  <th>Tên vật tư</th>
                  <th>Loại</th>
                  <th>Tồn</th>
                  <th>Số lô</th>
                  <th>Định mức</th>
                  <th>Cảnh báo</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {products.map((p) => (
                  <tr key={p.id}>
                    <td className="muted">{p.code}</td>
                    <td>
                      <b>{p.name}</b>
                      {p.isImplant ? (
                        <span className="tag" style={{ background: '#FAE8FF', color: '#A21CAF', marginLeft: 6 }}>
                          cấy ghép
                        </span>
                      ) : null}
                    </td>
                    <td>
                      <span className="tag out">{KIND_LABEL[p.kind] ?? p.kind}</span>
                    </td>
                    <td>
                      <b>
                        {p.onHand} {p.unit}
                      </b>
                    </td>
                    <td>{p.lotCount}</td>
                    <td className="muted">
                      {p.minStock || p.maxStock ? (
                        <>
                          min {p.minStock || '—'} / max {p.maxStock || '—'}
                        </>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td>
                      {p.belowMin ? (
                        <span className="tag" style={{ background: '#FEE2E2', color: '#B91C1C' }}>
                          dưới mức tối thiểu
                        </span>
                      ) : null}
                      {p.aboveMax ? (
                        <span className="tag" style={{ background: '#FEF3C7', color: '#B45309', marginLeft: 4 }}>
                          vượt mức tối đa
                        </span>
                      ) : null}
                      {p.expiringSoon ? (
                        <span className="tag" style={{ background: '#FEF3C7', color: '#B45309', marginLeft: 4 }}>
                          {p.expiringSoon} lô cận hạn
                        </span>
                      ) : null}
                      {p.expiredLots ? (
                        <span className="tag" style={{ background: '#FEE2E2', color: '#B91C1C', marginLeft: 4 }}>
                          {p.expiredLots} lô đã hết hạn
                        </span>
                      ) : null}
                      {!p.active ? <span className="tag out">ngưng dùng</span> : null}
                    </td>
                    <td>
                      {can('inventory.update') ? (
                        <div className="row" style={{ gap: 3, flexWrap: 'wrap' }}>
                          <button className="btn sec sm" onClick={() => setEditingProduct(p)}>
                            Sửa
                          </button>
                          <button className="btn sec sm" onClick={() => void toggleProduct(p)}>
                            {p.active ? 'Ngưng dùng' : 'Dùng lại'}
                          </button>
                          {can('inventory.delete') ? (
                            <button className="btn sec sm" onClick={() => void removeProduct(p)}>
                              Xoá
                            </button>
                          ) : null}
                        </div>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        ) : lots.length === 0 ? (
          <Empty>Kho trống. Bấm “+ Nhập kho” để nhập lô đầu tiên.</Empty>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Vật tư</th>
                <th>Mã lô</th>
                <th>Số seri</th>
                <th>Tồn</th>
                <th>Hạn dùng</th>
                <th>Nhà cung cấp</th>
                <th>Giá vốn</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {lots.map((l) => (
                <tr key={l.id}>
                  <td>
                    <b>{l.product.name}</b>
                    {l.product.isImplant ? (
                      <div className="muted" style={{ fontSize: 11.5 }}>
                        cấy ghép — bắt buộc truy vết
                      </div>
                    ) : null}
                  </td>
                  <td>
                    <b>{l.lotNumber}</b>
                  </td>
                  <td className="muted">{l.serialNumber ?? '—'}</td>
                  <td>
                    <b>
                      {l.quantity} {l.product.unit}
                    </b>
                  </td>
                  <td>
                    {l.expiryDate ? (
                      <>
                        {dateVi(l.expiryDate)}
                        {l.expired ? (
                          <div className="down" style={{ fontSize: 11 }}>
                            đã hết hạn
                          </div>
                        ) : l.expiringSoon ? (
                          <div style={{ fontSize: 11, color: 'var(--warn)' }}>
                            còn {l.daysToExpiry} ngày
                          </div>
                        ) : null}
                      </>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td className="muted">{l.supplier?.name ?? '—'}</td>
                  <td className="muted">{vnd(l.unitCost)}</td>
                  <td>
                    {can('inventory.update') ? (
                      <div className="row" style={{ gap: 3, flexWrap: 'wrap' }}>
                        {/* Cộng trừ tại chỗ — thao tác hay dùng nhất khi kiểm đếm */}
                        <button
                          className="btn sec sm"
                          title="Giảm 1"
                          disabled={busy === l.id || l.quantity <= 0}
                          onClick={() => void bump(l, -1)}
                        >
                          −
                        </button>
                        <button
                          className="btn sec sm"
                          title="Tăng 1"
                          disabled={busy === l.id}
                          onClick={() => void bump(l, 1)}
                        >
                          +
                        </button>
                        <button className="btn sec sm" title="Nhập thêm vào lô này" onClick={() => setReceiving(l)}>
                          ⤵ Nhập
                        </button>
                        {l.quantity > 0 && !l.expired ? (
                          <button className="btn sm" title="Xuất cho khách" onClick={() => setUsing(l)}>
                            Xuất khách
                          </button>
                        ) : null}
                        {l.quantity > 0 ? (
                          <button
                            className="btn sec sm"
                            title="Xuất nội bộ: hỏng vỡ, dùng thử, cấp phòng khác"
                            onClick={() => setIssuing(l)}
                          >
                            Xuất nội bộ
                          </button>
                        ) : null}
                        <button className="btn sec sm" title="Sửa hạn dùng, giá vốn" onClick={() => setEditingLot(l)}>
                          Sửa
                        </button>
                        {l.quantity > 0 ? (
                          <button className="btn sec sm" onClick={() => void dispose(l)}>
                            Huỷ
                          </button>
                        ) : can('inventory.delete') ? (
                          <button className="btn sec sm" onClick={() => void removeLot(l)}>
                            Xoá lô
                          </button>
                        ) : null}
                      </div>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {receiving ? (
        <ReceiveModal
          products={products}
          preset={receiving === true ? null : receiving}
          onClose={() => setReceiving(null)}
          onDone={() => {
            setReceiving(null)
            void load()
          }}
        />
      ) : null}
      {addingProduct ? (
        <ProductModal
          onClose={() => setAddingProduct(false)}
          onDone={() => {
            setAddingProduct(false)
            void load()
          }}
        />
      ) : null}
      {issuing ? (
        <IssueModal
          lot={issuing}
          onClose={() => setIssuing(null)}
          onDone={() => {
            setIssuing(null)
            void load()
          }}
        />
      ) : null}
      {editingLot ? (
        <EditLotModal
          lot={editingLot}
          onClose={() => setEditingLot(null)}
          onDone={() => {
            setEditingLot(null)
            void load()
          }}
        />
      ) : null}
      {editingProduct ? (
        <EditProductModal
          product={editingProduct}
          onClose={() => setEditingProduct(null)}
          onDone={() => {
            setEditingProduct(null)
            void load()
          }}
        />
      ) : null}
      {using ? (
        <UseModal
          lot={using}
          onClose={() => setUsing(null)}
          onDone={() => {
            setUsing(null)
            void load()
          }}
        />
      ) : null}
    </>
  )
}

/* --------------------------------------------------------- XUẤT NHẬP KHO */

function MovementsView(): React.JSX.Element {
  const { branchId } = useAuth()
  const { fail } = useToast()
  const [rows, setRows] = useState<StockMovementRow[]>([])
  const [type, setType] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    fetchMovements({ type: type || undefined, limit: 300 })
      .then(setRows)
      .catch((err) => fail(getApiErrorMessage(err)))
      .finally(() => setLoading(false))
  }, [type, fail, branchId])

  const totalIn = rows.filter((r) => r.quantity > 0).reduce((s, r) => s + r.quantity, 0)
  const totalOut = rows.filter((r) => r.quantity < 0).reduce((s, r) => s + Math.abs(r.quantity), 0)

  return (
    <>
      <div className="grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)', marginBottom: 12 }}>
        <div className="kpi">
          <div className="lab">Số bút toán</div>
          <div className="val">{rows.length}</div>
        </div>
        <div className="kpi">
          <div className="lab">Tổng nhập</div>
          <div className="val up">+{totalIn}</div>
        </div>
        <div className="kpi">
          <div className="lab">Tổng xuất</div>
          <div className="val down">-{totalOut}</div>
        </div>
      </div>

      <div className="row" style={{ marginBottom: 12 }}>
        <select className="input" style={{ width: 'auto' }} value={type} onChange={(e) => setType(e.target.value)}>
          <option value="">Mọi loại bút toán</option>
          {Object.entries(MOVE_LABEL).map(([k, v]) => (
            <option key={k} value={k}>
              {v.t}
            </option>
          ))}
        </select>
        <span className="muted" style={{ fontSize: 12 }}>
          Sổ này không sửa được. Mọi thay đổi tồn kho đều sinh một dòng ở đây.
        </span>
      </div>

      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        {loading ? (
          <Empty>Đang tải…</Empty>
        ) : rows.length === 0 ? (
          <Empty>Chưa có bút toán nào.</Empty>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Thời gian</th>
                <th>Loại</th>
                <th>Vật tư</th>
                <th>Lô</th>
                <th>Số lượng</th>
                <th>Lý do</th>
                <th>Người thực hiện</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((m) => {
                const s = MOVE_LABEL[m.type] ?? { t: m.type, bg: '#F1F5F9', fg: '#475569' }
                return (
                  <tr key={m.id}>
                    <td className="muted" style={{ whiteSpace: 'nowrap' }}>
                      {dateTimeVi(m.createdAt)}
                    </td>
                    <td>
                      <Tag style={s} />
                    </td>
                    <td>{m.product.name}</td>
                    <td className="muted">{m.lot?.lotNumber ?? '—'}</td>
                    <td>
                      <b className={m.quantity > 0 ? 'up' : 'down'}>
                        {m.quantity > 0 ? '+' : ''}
                        {m.quantity} {m.product.unit}
                      </b>
                    </td>
                    <td>{m.reason ?? '—'}</td>
                    <td className="muted">{m.actor?.name ?? '—'}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </>
  )
}

/* ------------------------------------------------------------- TRUY VẾT */

function TraceView(): React.JSX.Element {
  const { branchId } = useAuth()
  const { fail } = useToast()
  const navigate = useNavigate()

  const [lots, setLots] = useState<StockLotRow[]>([])
  const [selected, setSelected] = useState<string>('')
  const [result, setResult] = useState<TraceabilityResult | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    fetchOnHand()
      .then((r) => setLots(r.items))
      .catch((err) => fail(getApiErrorMessage(err)))
  }, [fail, branchId])

  useEffect(() => {
    if (!selected) {
      setResult(null)
      return
    }
    setLoading(true)
    fetchTraceability(selected)
      .then(setResult)
      .catch((err) => fail(getApiErrorMessage(err)))
      .finally(() => setLoading(false))
  }, [selected, fail])

  return (
    <>
      <div className="alert wr">
        Khi nhà sản xuất thu hồi một lô, đây là màn trả lời câu hỏi <b>“lô đó đã dùng cho những khách
        nào”</b>. Chọn lô để xem danh sách khách và ca mổ liên quan.
      </div>

      <div className="row" style={{ marginBottom: 12 }}>
        <select
          className="input"
          style={{ width: 420 }}
          value={selected}
          onChange={(e) => setSelected(e.target.value)}
        >
          <option value="">— Chọn lô cần truy vết —</option>
          {lots.map((l) => (
            <option key={l.id} value={l.id}>
              {l.product.name} · lô {l.lotNumber}
              {l.serialNumber ? ` · seri ${l.serialNumber}` : ''} (còn {l.quantity})
            </option>
          ))}
        </select>
      </div>

      {loading ? (
        <div className="card">
          <Empty>Đang truy vết…</Empty>
        </div>
      ) : !result ? (
        <div className="card">
          <Empty>Chọn một lô ở trên để bắt đầu truy vết.</Empty>
        </div>
      ) : (
        <>
          <div className="grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)', marginBottom: 12 }}>
            <div className="kpi">
              <div className="lab">Mã lô</div>
              <div className="val" style={{ fontSize: 16 }}>
                {result.lot.lotNumber}
              </div>
            </div>
            <div className="kpi">
              <div className="lab">Còn trong kho</div>
              <div className="val">{result.lot.quantity}</div>
            </div>
            <div className="kpi">
              <div className="lab">Đã dùng</div>
              <div className="val">{result.usedQuantity}</div>
            </div>
            <div className="kpi">
              <div className="lab">Số khách liên quan</div>
              <div className="val" style={{ color: result.customerCount ? 'var(--danger)' : undefined }}>
                {result.customerCount}
              </div>
              {result.customerCount ? <div className="dt down">Cần liên hệ nếu thu hồi</div> : null}
            </div>
          </div>

          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            <div className="sec-title" style={{ padding: '12px 14px 0' }}>
              Khách đã dùng lô này
            </div>
            {result.usages.length === 0 ? (
              <Empty>Lô này chưa dùng cho khách nào — thu hồi không ảnh hưởng bệnh nhân.</Empty>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Khách hàng</th>
                    <th>Số điện thoại</th>
                    <th>Số lượng</th>
                    <th>Ca mổ</th>
                    <th>Thời điểm dùng</th>
                    <th>Người ghi</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {result.usages.map((u) => (
                    <tr key={u.id}>
                      <td>
                        <b>{u.customer?.name ?? '—'}</b>
                        <div className="muted" style={{ fontSize: 11.5 }}>
                          {u.customer?.code ?? ''}
                        </div>
                      </td>
                      <td>{u.customer?.phone ?? '—'}</td>
                      <td>{u.quantity}</td>
                      <td>
                        {u.procedure ? (
                          <>
                            {u.procedure.title}
                            <div className="muted" style={{ fontSize: 11.5 }}>
                              {u.procedure.code}
                            </div>
                          </>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                      <td className="muted">{dateTimeVi(u.usedAt)}</td>
                      <td className="muted">{u.recordedBy?.name ?? '—'}</td>
                      <td>
                        {u.customer ? (
                          <button
                            className="btn sec sm"
                            onClick={() => navigate(`/khach-hang/${u.customer!.id}`)}
                          >
                            Mở hồ sơ
                          </button>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </>
  )
}

/* --------------------------------------------------------- NHÀ CUNG CẤP */

function SuppliersView(): React.JSX.Element {
  const { can } = useAuth()
  const { fail } = useToast()
  const { say } = useToast()
  const [rows, setRows] = useState<SupplierRow[]>([])
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<SupplierRow | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(() => {
    setLoading(true)
    fetchSuppliers()
      .then(setRows)
      .catch((err) => fail(getApiErrorMessage(err)))
      .finally(() => setLoading(false))
  }, [fail])

  useEffect(() => {
    load()
  }, [load])

  async function remove(s: SupplierRow): Promise<void> {
    if (!window.confirm(`Xoá nhà cung cấp "${s.name}"?`)) return
    try {
      await deleteSupplier(s.id)
      say('Đã xoá nhà cung cấp')
      load()
    } catch (err) {
      fail(getApiErrorMessage(err))
    }
  }

  return (
    <>
      <div className="row" style={{ marginBottom: 12 }}>
        <span className="muted" style={{ fontSize: 12.5 }}>
          Nhà cung cấp gắn với từng lô nhập — cần khi truy nguồn gốc vật tư.
        </span>
        {can('inventory.create') ? (
          <button className="btn" style={{ marginLeft: 'auto' }} onClick={() => setAdding(true)}>
            + Nhà cung cấp
          </button>
        ) : null}
      </div>

      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        {loading ? (
          <Empty>Đang tải…</Empty>
        ) : rows.length === 0 ? (
          <Empty>Chưa có nhà cung cấp nào.</Empty>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Mã</th>
                <th>Tên</th>
                <th>Người liên hệ</th>
                <th>Điện thoại</th>
                <th>Mã số thuế</th>
                <th>Số lô đã cấp</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.id}>
                  <td className="muted">{s.code}</td>
                  <td>
                    <b>{s.name}</b>
                    {s.address ? (
                      <div className="muted" style={{ fontSize: 11.5 }}>
                        {s.address}
                      </div>
                    ) : null}
                  </td>
                  <td>{s.contactName ?? '—'}</td>
                  <td>{s.phone ?? '—'}</td>
                  <td className="muted">{s.taxCode ?? '—'}</td>
                  <td>{s._count.lots}</td>
                  <td>
                    {can('inventory.update') ? (
                      <div className="row" style={{ gap: 3 }}>
                        <button className="btn sec sm" onClick={() => setEditing(s)}>
                          Sửa
                        </button>
                        {can('inventory.delete') ? (
                          <button className="btn sec sm" onClick={() => void remove(s)}>
                            Xoá
                          </button>
                        ) : null}
                      </div>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {adding || editing ? (
        <SupplierModal
          edit={editing}
          onClose={() => {
            setAdding(false)
            setEditing(null)
          }}
          onDone={() => {
            setAdding(false)
            setEditing(null)
            load()
          }}
        />
      ) : null}
    </>
  )
}

/* ------------------------------------------------------------- BIỂU MẪU */

function ReceiveModal({
  products,
  preset,
  onClose,
  onDone
}: {
  products: ProductRow[]
  /** Nhập THÊM vào lô sẵn có: điền trước vật tư, mã lô và hạn dùng. */
  preset: StockLotRow | null
  onClose: () => void
  onDone: () => void
}): React.JSX.Element {
  const { say, fail } = useToast()
  const [suppliers, setSuppliers] = useState<SupplierRow[]>([])
  const [form, setForm] = useState({
    productId: preset?.product.id ?? '',
    lotNumber: preset?.lotNumber ?? '',
    serialNumber: preset?.serialNumber ?? '',
    expiryDate: preset?.expiryDate ? preset.expiryDate.slice(0, 10) : '',
    quantity: 1,
    unitCost: preset?.unitCost ?? 0,
    supplierId: preset?.supplier?.id ?? '',
    note: ''
  })
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    fetchSuppliers().then(setSuppliers).catch(() => undefined)
  }, [])

  const submit = async (): Promise<void> => {
    if (!form.productId || !form.lotNumber) {
      fail('Chọn vật tư và nhập mã lô.')
      return
    }
    setSaving(true)
    try {
      await receiveStock({
        productId: form.productId,
        lotNumber: form.lotNumber.trim(),
        serialNumber: form.serialNumber || undefined,
        expiryDate: form.expiryDate || undefined,
        quantity: form.quantity,
        unitCost: form.unitCost || undefined,
        supplierId: form.supplierId || undefined,
        note: form.note || undefined
      })
      say('Đã nhập kho và ghi vào sổ.')
      onDone()
    } catch (err) {
      fail(getApiErrorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      title={preset ? `Nhập thêm — lô ${preset.lotNumber}` : "Nhập kho theo lô"}
      onClose={onClose}
      footer={
        <>
          <button className="btn sec" onClick={onClose}>
            Huỷ
          </button>
          <button className="btn" onClick={() => void submit()} disabled={saving}>
            {saving ? 'Đang lưu…' : 'Nhập kho'}
          </button>
        </>
      }
    >
      <div className="field">
        <label>Vật tư *</label>
        <select
          className="input"
          value={form.productId}
          onChange={(e) => setForm((f) => ({ ...f, productId: e.target.value }))}
        >
          <option value="">— Chọn vật tư —</option>
          {products.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} ({p.unit})
            </option>
          ))}
        </select>
      </div>
      <div className="row" style={{ gap: 10 }}>
        <div className="field" style={{ flex: 1 }}>
          <label>Mã lô *</label>
          <input
            className="input"
            value={form.lotNumber}
            onChange={(e) => setForm((f) => ({ ...f, lotNumber: e.target.value }))}
            placeholder="MT-88120"
          />
        </div>
        <div className="field" style={{ flex: 1 }}>
          <label>Số seri (nếu có)</label>
          <input
            className="input"
            value={form.serialNumber}
            onChange={(e) => setForm((f) => ({ ...f, serialNumber: e.target.value }))}
          />
        </div>
      </div>
      <div className="row" style={{ gap: 10 }}>
        <div className="field" style={{ flex: 1 }}>
          <label>Số lượng *</label>
          <input
            className="input"
            type="number"
            min={1}
            value={form.quantity}
            onChange={(e) => setForm((f) => ({ ...f, quantity: Number(e.target.value) }))}
          />
        </div>
        <div className="field" style={{ flex: 1 }}>
          <label>Hạn dùng</label>
          <input
            className="input"
            type="date"
            value={form.expiryDate}
            onChange={(e) => setForm((f) => ({ ...f, expiryDate: e.target.value }))}
          />
        </div>
        <div className="field" style={{ flex: 1 }}>
          <label>Giá vốn / đơn vị</label>
          <input
            className="input"
            type="number"
            value={form.unitCost}
            onChange={(e) => setForm((f) => ({ ...f, unitCost: Number(e.target.value) }))}
          />
        </div>
      </div>
      <div className="field">
        <label>Nhà cung cấp</label>
        <select
          className="input"
          value={form.supplierId}
          onChange={(e) => setForm((f) => ({ ...f, supplierId: e.target.value }))}
        >
          <option value="">— Không ghi —</option>
          {suppliers.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label>Ghi chú</label>
        <input
          className="input"
          value={form.note}
          onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))}
        />
      </div>
    </Modal>
  )
}

/* Xuất nội bộ: hỏng vỡ, dùng thử, cấp phòng khác — không gắn khách nào. */
function IssueModal({
  lot,
  onClose,
  onDone
}: {
  lot: StockLotRow
  onClose: () => void
  onDone: () => void
}): React.JSX.Element {
  const { say, fail } = useToast()
  const [quantity, setQuantity] = useState(1)
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)

  const REASONS = ['Hỏng vỡ', 'Hết hạn phải bỏ', 'Dùng thử / đào tạo', 'Cấp cho phòng khác', 'Hao hụt kiểm kê']

  async function submit(): Promise<void> {
    if (!reason.trim()) return fail('Nhập lý do xuất')
    setSaving(true)
    try {
      await issueStock({ lotId: lot.id, quantity, reason: reason.trim() })
      say(`Đã xuất nội bộ ${quantity} ${lot.product.unit}`)
      onDone()
    } catch (e) {
      fail(getApiErrorMessage(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      title={`Xuất nội bộ — ${lot.product.name}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn sec" onClick={onClose}>
            Đóng
          </button>
          <button className="btn" disabled={saving} onClick={() => void submit()}>
            {saving ? 'Đang lưu…' : 'Xuất kho'}
          </button>
        </>
      }
    >
      <p className="muted" style={{ marginTop: 0, fontSize: 12.5 }}>
        Lô {lot.lotNumber} · còn {lot.quantity} {lot.product.unit}
      </p>
      <div className="field">
        <label>Số lượng xuất</label>
        <input
          className="input"
          type="number"
          min={1}
          max={lot.quantity}
          value={quantity}
          onChange={(e) => setQuantity(Math.min(lot.quantity, Math.max(1, Number(e.target.value))))}
        />
      </div>
      <div className="field">
        <label>Lý do *</label>
        <input
          className="input"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Vì sao xuất lô này?"
        />
      </div>
      <div className="row" style={{ gap: 4, flexWrap: 'wrap' }}>
        {REASONS.map((r) => (
          <button key={r} className="btn sec sm" onClick={() => setReason(r)}>
            {r}
          </button>
        ))}
      </div>
    </Modal>
  )
}

/* Sửa thông tin lô. Số lượng cố ý KHÔNG sửa ở đây — đổi tồn phải đi qua
   nhập/xuất/điều chỉnh để thẻ kho có bút toán. */
function EditLotModal({
  lot,
  onClose,
  onDone
}: {
  lot: StockLotRow
  onClose: () => void
  onDone: () => void
}): React.JSX.Element {
  const { say, fail } = useToast()
  const [form, setForm] = useState({
    expiryDate: lot.expiryDate ? lot.expiryDate.slice(0, 10) : '',
    serialNumber: lot.serialNumber ?? '',
    unitCost: lot.unitCost,
    note: ''
  })
  const [saving, setSaving] = useState(false)

  async function submit(): Promise<void> {
    setSaving(true)
    try {
      await updateLot(lot.id, {
        expiryDate: form.expiryDate ? new Date(form.expiryDate).toISOString() : null,
        serialNumber: form.serialNumber.trim() || null,
        unitCost: Number(form.unitCost) || 0,
        note: form.note.trim() || undefined
      })
      say('Đã cập nhật lô')
      onDone()
    } catch (e) {
      fail(getApiErrorMessage(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      title={`Sửa lô ${lot.lotNumber}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn sec" onClick={onClose}>
            Đóng
          </button>
          <button className="btn" disabled={saving} onClick={() => void submit()}>
            {saving ? 'Đang lưu…' : 'Lưu'}
          </button>
        </>
      }
    >
      <p className="muted" style={{ marginTop: 0 }}>
        {lot.product.name} · tồn {lot.quantity} {lot.product.unit} (muốn đổi tồn hãy dùng nút +/− hoặc nhập/xuất
        để sổ kho ghi đủ bút toán)
      </p>
      <div className="row" style={{ gap: 10 }}>
        <div className="field" style={{ flex: 1 }}>
          <label>Hạn sử dụng</label>
          <input
            className="input"
            type="date"
            value={form.expiryDate}
            onChange={(e) => setForm({ ...form, expiryDate: e.target.value })}
          />
        </div>
        <div className="field" style={{ flex: 1 }}>
          <label>Giá vốn / đơn vị</label>
          <input
            className="input"
            type="number"
            min={0}
            value={form.unitCost}
            onChange={(e) => setForm({ ...form, unitCost: Number(e.target.value) })}
          />
        </div>
      </div>
      <div className="field">
        <label>Số serial (vật tư cấy ghép)</label>
        <input
          className="input"
          value={form.serialNumber}
          onChange={(e) => setForm({ ...form, serialNumber: e.target.value })}
        />
      </div>
      <div className="field">
        <label>Ghi chú</label>
        <input className="input" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
      </div>
    </Modal>
  )
}

function EditProductModal({
  product,
  onClose,
  onDone
}: {
  product: ProductRow
  onClose: () => void
  onDone: () => void
}): React.JSX.Element {
  const { say, fail } = useToast()
  const [form, setForm] = useState({
    name: product.name,
    unit: product.unit,
    kind: product.kind,
    minStock: product.minStock,
    maxStock: product.maxStock ?? 0,
    isImplant: product.isImplant
  })
  const [saving, setSaving] = useState(false)

  async function submit(): Promise<void> {
    if (form.maxStock > 0 && form.minStock > form.maxStock) return fail('Tồn tối thiểu không được lớn hơn tối đa')
    setSaving(true)
    try {
      await updateProduct(product.id, {
        name: form.name.trim(),
        unit: form.unit.trim(),
        kind: form.kind,
        minStock: Number(form.minStock) || 0,
        maxStock: Number(form.maxStock) || 0,
        isImplant: form.isImplant
      })
      say('Đã cập nhật vật tư')
      onDone()
    } catch (e) {
      fail(getApiErrorMessage(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      title={`Sửa vật tư — ${product.code}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn sec" onClick={onClose}>
            Đóng
          </button>
          <button className="btn" disabled={saving} onClick={() => void submit()}>
            {saving ? 'Đang lưu…' : 'Lưu'}
          </button>
        </>
      }
    >
      <div className="field">
        <label>Tên vật tư</label>
        <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
      </div>
      <div className="row" style={{ gap: 10 }}>
        <div className="field" style={{ flex: 1 }}>
          <label>Đơn vị tính</label>
          <input className="input" value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value })} />
        </div>
        <div className="field" style={{ flex: 1 }}>
          <label>Loại</label>
          <select className="input" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
            {Object.entries(KIND_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="row" style={{ gap: 10 }}>
        <div className="field" style={{ flex: 1 }}>
          <label>Tồn tối thiểu (dưới mức này cảnh báo)</label>
          <input
            className="input"
            type="number"
            min={0}
            value={form.minStock}
            onChange={(e) => setForm({ ...form, minStock: Number(e.target.value) })}
          />
        </div>
        <div className="field" style={{ flex: 1 }}>
          <label>Tồn tối đa (0 = không giới hạn)</label>
          <input
            className="input"
            type="number"
            min={0}
            value={form.maxStock}
            onChange={(e) => setForm({ ...form, maxStock: Number(e.target.value) })}
          />
        </div>
      </div>
      <label className="row" style={{ fontSize: 13, gap: 6 }}>
        <input
          type="checkbox"
          checked={form.isImplant}
          onChange={(e) => setForm({ ...form, isImplant: e.target.checked })}
        />
        Là vật tư cấy ghép (bắt buộc ghi serial khi xuất dùng)
      </label>
    </Modal>
  )
}

function UseModal({
  lot,
  onClose,
  onDone
}: {
  lot: StockLotRow
  onClose: () => void
  onDone: () => void
}): React.JSX.Element {
  const { say, fail } = useToast()
  const [customers, setCustomers] = useState<CustomerListItem[]>([])
  const [customerId, setCustomerId] = useState('')
  const [quantity, setQuantity] = useState(1)
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    fetchCustomers({ limit: 300 })
      .then((r) => setCustomers(r.items))
      .catch(() => undefined)
  }, [])

  const submit = async (): Promise<void> => {
    if (!customerId) {
      fail('Chọn khách được dùng vật tư này.')
      return
    }
    setSaving(true)
    try {
      await useStock({ lotId: lot.id, customerId, quantity, note: note || undefined })
      say('Đã xuất dùng và gắn lô vào hồ sơ khách.')
      onDone()
    } catch (err) {
      fail(getApiErrorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      title={`Xuất dùng — ${lot.product.name}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn sec" onClick={onClose}>
            Huỷ
          </button>
          <button className="btn" onClick={() => void submit()} disabled={saving}>
            {saving ? 'Đang lưu…' : 'Xuất dùng'}
          </button>
        </>
      }
    >
      <div className="alert wr">
        Lô <b>{lot.lotNumber}</b> — còn {lot.quantity} {lot.product.unit}
        {lot.expiryDate ? ` · hạn ${dateVi(lot.expiryDate)}` : ''}
      </div>
      <div className="field">
        <label>Dùng cho khách *</label>
        <select className="input" value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
          <option value="">— Chọn khách —</option>
          {customers.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name} ({c.code})
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label>Số lượng</label>
        <input
          className="input"
          type="number"
          min={0.1}
          step={0.1}
          max={lot.quantity}
          value={quantity}
          onChange={(e) => setQuantity(Number(e.target.value))}
        />
        <div className="muted" style={{ fontSize: 11.5 }}>
          Nhập lẻ theo 0,1 đơn vị (0,5 ống). Kho trừ theo số ống đã mở; giá vốn tính theo lượng dùng thật.
        </div>
      </div>
      <div className="field">
        <label>Ghi chú (ca mổ, vị trí…)</label>
        <input className="input" value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
      <div className="muted" style={{ fontSize: 11.5 }}>
        Thao tác này gắn lô vào hồ sơ khách vĩnh viễn — đó là căn cứ truy vết khi có thu hồi.
      </div>
    </Modal>
  )
}

function ProductModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }): React.JSX.Element {
  const { say, fail } = useToast()
  const [form, setForm] = useState({
    code: '',
    name: '',
    kind: 'CONSUMABLE',
    unit: 'cái',
    isImplant: false,
    minStock: 0
  })
  const [saving, setSaving] = useState(false)

  const submit = async (): Promise<void> => {
    if (!form.code || !form.name) {
      fail('Nhập mã và tên vật tư.')
      return
    }
    setSaving(true)
    try {
      await createProduct({ ...form, requiresLot: true })
      say('Đã thêm vật tư.')
      onDone()
    } catch (err) {
      fail(getApiErrorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      title="Thêm vật tư"
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
      <div className="row" style={{ gap: 10 }}>
        <div className="field" style={{ flex: 1 }}>
          <label>Mã vật tư *</label>
          <input
            className="input"
            value={form.code}
            onChange={(e) => setForm((f) => ({ ...f, code: e.target.value }))}
            placeholder="VT-TUI-275"
          />
        </div>
        <div className="field" style={{ flex: 1 }}>
          <label>Đơn vị</label>
          <input
            className="input"
            value={form.unit}
            onChange={(e) => setForm((f) => ({ ...f, unit: e.target.value }))}
          />
        </div>
      </div>
      <div className="field">
        <label>Tên vật tư *</label>
        <input
          className="input"
          value={form.name}
          onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
        />
      </div>
      <div className="field">
        <label>Loại</label>
        <select
          className="input"
          value={form.kind}
          onChange={(e) =>
            setForm((f) => ({ ...f, kind: e.target.value, isImplant: e.target.value === 'IMPLANT' }))
          }
        >
          {Object.entries(KIND_LABEL).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label>Tồn tối thiểu (dưới mức này sẽ cảnh báo)</label>
        <input
          className="input"
          type="number"
          value={form.minStock}
          onChange={(e) => setForm((f) => ({ ...f, minStock: Number(e.target.value) }))}
        />
      </div>
      <label className="row" style={{ fontSize: 13, gap: 6 }}>
        <input
          type="checkbox"
          checked={form.isImplant}
          onChange={(e) => setForm((f) => ({ ...f, isImplant: e.target.checked }))}
        />
        Là vật tư cấy ghép (bắt buộc truy vết theo lô)
      </label>
    </Modal>
  )
}

function SupplierModal({
  edit,
  onClose,
  onDone
}: {
  /** Có giá trị = đang sửa; null = thêm mới. */
  edit?: SupplierRow | null
  onClose: () => void
  onDone: () => void
}): React.JSX.Element {
  const { say, fail } = useToast()
  const [form, setForm] = useState({
    code: edit?.code ?? '',
    name: edit?.name ?? '',
    contactName: edit?.contactName ?? '',
    phone: edit?.phone ?? '',
    email: edit?.email ?? '',
    taxCode: edit?.taxCode ?? '',
    address: edit?.address ?? ''
  })
  const [saving, setSaving] = useState(false)

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }))

  const submit = async (): Promise<void> => {
    if (!form.code || !form.name) {
      fail('Nhập mã và tên nhà cung cấp.')
      return
    }
    setSaving(true)
    try {
      if (edit) {
        // Mã nhà cung cấp không đổi được — nó đã in trên các lô đã nhập.
        const { code: _code, ...rest } = form
        await updateSupplier(edit.id, rest)
        say('Đã cập nhật nhà cung cấp.')
      } else {
        await createSupplier(form)
        say('Đã thêm nhà cung cấp.')
      }
      onDone()
    } catch (err) {
      fail(getApiErrorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      title={edit ? `Sửa nhà cung cấp — ${edit.code}` : 'Thêm nhà cung cấp'}
      onClose={onClose}
      footer={
        <>
          <button className="btn sec" onClick={onClose}>
            Huỷ
          </button>
          <button className="btn" onClick={() => void submit()} disabled={saving}>
            {saving ? 'Đang lưu…' : edit ? 'Lưu' : 'Thêm'}
          </button>
        </>
      }
    >
      <div className="row" style={{ gap: 10 }}>
        <div className="field" style={{ flex: 1 }}>
          <label>Mã *</label>
          <input
            className="input"
            value={form.code}
            onChange={set('code')}
            placeholder="NCC-MOTIVA"
            disabled={Boolean(edit)}
          />
        </div>
        <div className="field" style={{ flex: 2 }}>
          <label>Tên nhà cung cấp *</label>
          <input className="input" value={form.name} onChange={set('name')} />
        </div>
      </div>
      <div className="row" style={{ gap: 10 }}>
        <div className="field" style={{ flex: 1 }}>
          <label>Người liên hệ</label>
          <input className="input" value={form.contactName} onChange={set('contactName')} />
        </div>
        <div className="field" style={{ flex: 1 }}>
          <label>Điện thoại</label>
          <input className="input" value={form.phone} onChange={set('phone')} />
        </div>
      </div>
      <div className="field">
        <label>Mã số thuế</label>
        <input className="input" value={form.taxCode} onChange={set('taxCode')} />
      </div>
      <div className="field">
        <label>Địa chỉ</label>
        <input className="input" value={form.address} onChange={set('address')} />
      </div>
    </Modal>
  )
}
