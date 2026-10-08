import React, { useCallback, useEffect, useState } from 'react'
import { getApiErrorMessage } from '../lib/api'
import { useAuth } from '../lib/auth-context'
import { useClinic } from '../lib/clinic-context'
import { dateVi, vnd, vndShort } from '../lib/format'
import { initialOf } from '../lib/ui'
import {
  chooseQuoteOption,
  fetchUpsell,
  previewQuoteOptions,
  recordUpsellOffer,
  type AgeLevel,
  type Customer360,
  type Heat,
  type Milestone,
  type QuoteOption,
  type QuoteOptions,
  type UpsellContext,
  type UpsellSuggestion
} from '../lib/api-lo7'
import { Empty, useToast } from './ui'

/* Lô 7 · CRM 360 Lô A: mảnh giao diện dùng chung cho bảng bước khối, hồ sơ
   khách, màn chốt tại quầy, phiếu tư vấn và hộp thư. */

export const HEAT_LABEL: Record<Heat, string> = { HOT: 'Nóng', WARM: 'Ấm', COLD: 'Lạnh' }

export function HeatChip({ heat, title }: { heat: Heat; title?: string }): React.JSX.Element {
  return (
    <span className={`hchip ${heat}`} title={title}>
      {HEAT_LABEL[heat]}
    </span>
  )
}

export function DepositChip({ deposit }: { deposit: 'PAID' | 'UNPAID' | null }): React.JSX.Element | null {
  if (!deposit) return null
  return <span className={`hchip ${deposit}`}>{deposit === 'PAID' ? 'Đã cọc' : 'Chưa cọc'}</span>
}

export function ageClass(level: AgeLevel): string {
  return level === 'OVERDUE' ? 't-over' : level === 'WARN' ? 't-warn' : ''
}

export function daysText(days: number): string {
  return days === 0 ? 'Vào bước hôm nay' : `${days} ngày ở bước`
}

/** Quyết định 3: vai có finance.read phạm vi cơ sở hoặc toàn hệ thống mới thấy tiền. */
export function useMoneyVisible(): boolean {
  const { scopeOf } = useAuth()
  const s = scopeOf('finance.read')
  return s === 'ALL' || s === 'BRANCH'
}

/* --------------------------------------------------------------- THANH 360 */

export function Customer360Header({
  data,
  actions,
  phone
}: {
  data: Customer360
  actions?: React.ReactNode
  phone?: string | null
}): React.JSX.Element {
  const clinic = useClinic()
  const st = clinic.stageStyle(data.stage.key)
  const m = data.money
  const sale = [data.sale.assignedTo?.name, data.sale.telesale?.name].filter(Boolean).join(' / ')
  const source = [data.source.channel ?? 'Không rõ nguồn', data.source.firstAd].filter(Boolean).join(' · ')
  return (
    <div className="card c360">
      <div className="c360-top">
        <div className="c360-ava">{initialOf(data.customer.name)}</div>
        <div style={{ flex: 1, minWidth: 220 }}>
          <div className="c360-name">
            {data.customer.name} <small>{data.customer.code}</small>
          </div>
          <div className="c360-sub">
            {data.customer.profileLabel} · {source} · {sale ? `Sale ${sale}` : 'Chưa phân công'}
            {phone !== undefined ? ` · ${phone ?? 'chưa có SĐT'}` : ''}
          </div>
          <div className="c360-chips">
            <HeatChip heat={data.heat.heat} title={data.heat.factors.join(', ') || 'Chưa có dấu hiệu'} />
            <span className="tag" style={{ background: st.bg, color: st.fg }}>
              {st.t}
              {data.stage.lost ? '' : ` · ${data.stage.days} ngày`}
            </span>
            {data.stage.level === 'OVERDUE' ? <span className="t-over" style={{ fontSize: 11.5 }}>Quá hạn bước (tối đa {data.stage.maxDays} ngày)</span> : null}
            {data.stage.level === 'WARN' ? <span className="t-warn" style={{ fontSize: 11.5 }}>Sắp quá hạn bước</span> : null}
            {data.stage.lostReason ? <span className="hchip NEUTRAL">Lý do mất: {clinic.lostReasonLabel(data.stage.lostReason)}</span> : null}
          </div>
        </div>
        {actions ? <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginLeft: 'auto' }}>{actions}</div> : null}
      </div>

      <div className="c360-grid">
        <div className="c360-cell">
          <div className="lab">Chi trọn đời</div>
          <div className="v">{m ? vnd(m.lifetimeSpend) : '—'}</div>
          <div className="s">{m ? (m.expectedValue ? `Dự kiến ${vndShort(m.expectedValue)}` : 'Tiền thật, bỏ voucher') : 'Chỉ quản lý, kế toán xem'}</div>
        </div>
        <div className="c360-cell">
          <div className="lab">Số lần · TB đơn</div>
          <div className="v">
            {data.stats.serviceCount} lần{m && m.avgOrderValue != null ? ` · ${vndShort(m.avgOrderValue)}` : ''}
          </div>
          <div className="s">{data.stats.lastServiceAt ? `Lần cuối ${dateVi(data.stats.lastServiceAt)}` : 'Chưa làm dịch vụ'}</div>
        </div>
        <div className="c360-cell">
          <div className="lab">Báo giá mở</div>
          <div className="v">
            {data.stats.openQuoteCount}
            {m && data.stats.openQuoteCount ? ` · ${vndShort(m.openQuoteTotal)}` : ''}
          </div>
          <div className="s">{data.nextAppointment ? `Hẹn ${dateVi(data.nextAppointment.startAt)}` : 'Chưa có lịch hẹn'}</div>
        </div>
        <div className="c360-cell">
          <div className="lab">Hạn tái tiêm</div>
          <div className={`v ${data.stats.retreatOverdue ? 't-over' : ''}`}>{data.stats.retreatDueAt ? dateVi(data.stats.retreatDueAt) : '—'}</div>
          <div className="s">{data.stats.retreatOverdue ? 'Đã quá hạn' : data.stats.retreatDueAt ? 'Sắp tới' : 'Chưa có mốc'}</div>
        </div>
      </div>

      <div className="c360-chips" style={{ marginTop: 10 }}>
        {data.stats.voucherCount ? (
          <span className="hchip PAID">
            {data.stats.voucherCount} voucher{m ? ` · ${vndShort(m.voucherValue)}` : ''}
            {data.stats.nearestVoucherExpiry ? ` · hạn ${dateVi(data.stats.nearestVoucherExpiry)}` : ''}
          </span>
        ) : (
          <span className="hchip NEUTRAL">Không có voucher</span>
        )}
        {data.stats.hasDebt ? <span className="hchip UNPAID">Công nợ{m ? ` ${vndShort(m.debt)}` : ''}</span> : <span className="hchip NEUTRAL">Không công nợ</span>}
        {data.medical?.flags.map((f, i) => (
          <span key={i} className="hchip MED" title={f.blocking ? 'Chống chỉ định chặn thực hiện' : undefined}>
            {f.blocking ? '⛔ ' : ''}
            {f.text}
          </span>
        ))}
        {data.conversationScore?.score != null ? (
          <span className="hchip NEUTRAL" title={data.conversationScore.summary ?? undefined}>
            Điểm hội thoại {data.conversationScore.score} ({data.conversationScore.weekKey})
          </span>
        ) : null}
        {data.nextTask ? (
          <span className={`hchip ${data.nextTask.overdue ? 'HOT' : 'NEUTRAL'}`}>
            Việc: {data.nextTask.title}
            {data.nextTask.dueAt ? ` · ${dateVi(data.nextTask.dueAt)}` : ''}
          </span>
        ) : null}
      </div>

      <JourneyStrip items={data.journey} />
    </div>
  )
}

export function JourneyStrip({ items }: { items: Milestone[] }): React.JSX.Element | null {
  if (!items.length) return null
  return (
    <div className="journey" aria-label="Dải hành trình khách">
      {items.map((m, i) => (
        <div key={`${m.kind}-${i}`} className={`jstep ${m.future ? 'future' : ''}`} title={m.detail ?? undefined}>
          {m.gapDays != null ? <div className="jg">+{m.gapDays}n</div> : null}
          <div className="jdot" />
          <div className="jl">{m.label}</div>
          <div className="jd">{dateVi(m.at)}</div>
          {m.detail ? (
            <div className="jd" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {m.detail}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  )
}

/* --------------------------------------------------------------- BÁN KÈM */

const OFFER_LABEL: Record<string, string> = { SUGGESTED: 'Đã gợi ý', ACCEPTED: 'Khách nhận', DECLINED: 'Khách từ chối' }

export function UpsellPanel({
  customerId,
  context,
  compact,
  reloadKey
}: {
  customerId: string
  context: UpsellContext
  compact?: boolean
  reloadKey?: unknown
}): React.JSX.Element | null {
  const { can } = useAuth()
  const { say, fail } = useToast()
  const [items, setItems] = useState<UpsellSuggestion[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(() => {
    fetchUpsell(customerId)
      .then((r) => setItems(r.items))
      .catch(() => setItems([]))
  }, [customerId])
  useEffect(load, [load, reloadKey])

  const record = async (s: UpsellSuggestion, status: 'SUGGESTED' | 'ACCEPTED' | 'DECLINED'): Promise<void> => {
    let declineReason: string | null = null
    if (status === 'DECLINED') {
      const r = window.prompt('Lý do khách từ chối (để đo và chăm lại):', '')
      if (r === null) return
      declineReason = r.trim() || null
    }
    setBusy(s.ruleId)
    try {
      await recordUpsellOffer({ customerId, suggestServiceId: s.suggestServiceId, ruleId: s.ruleId, triggerServiceId: s.triggerServiceId, context, status, declineReason })
      say(status === 'SUGGESTED' ? 'Đã ghi nhận đã gợi ý.' : status === 'ACCEPTED' ? 'Đã ghi nhận khách nhận.' : 'Đã ghi nhận khách từ chối.')
      load()
    } catch (err) {
      fail(getApiErrorMessage(err))
    } finally {
      setBusy(null)
    }
  }

  if (items === null) return compact ? null : <div className="muted" style={{ fontSize: 12 }}>Đang tải gợi ý bán kèm…</div>
  if (!items.length) return compact ? null : <div className="muted" style={{ fontSize: 12 }}>Chưa có gợi ý bán kèm cho dịch vụ khách đang quan tâm.</div>
  const canRecord = can('customer.update')
  return (
    <div>
      {compact ? <div className="sec-title" style={{ marginTop: 12 }}>Gợi ý bán kèm</div> : null}
      {items.map((s) => (
        <div key={s.ruleId} className="upsell-item">
          <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
            <span className="nm">{s.suggestServiceName}</span>
            {s.listPrice != null ? <span className="muted">{vnd(s.listPrice)}</span> : null}
            {s.isSample ? <span className="hchip WARM">Mẫu, chờ bác sĩ duyệt</span> : null}
            {s.lastOffer ? <span className={`hchip ${s.lastOffer.status === 'ACCEPTED' ? 'PAID' : s.lastOffer.status === 'DECLINED' ? 'HOT' : 'NEUTRAL'}`}>{OFFER_LABEL[s.lastOffer.status]}</span> : null}
          </div>
          <div style={{ marginTop: 3 }}>{s.pitch}</div>
          <div className="muted" style={{ fontSize: 11.5, marginTop: 2 }}>
            Từ: {s.triggerServiceName}
            {s.conditionNote ? ` · Điều kiện: ${s.conditionNote}` : ''}
          </div>
          {canRecord ? (
            <div className="row" style={{ gap: 5, marginTop: 6, flexWrap: 'wrap' }}>
              <button className="btn sec sm" disabled={busy === s.ruleId} onClick={() => void record(s, 'SUGGESTED')}>
                Đã gợi ý
              </button>
              <button className="btn sm" disabled={busy === s.ruleId} onClick={() => void record(s, 'ACCEPTED')}>
                Khách nhận
              </button>
              <button className="btn sec sm" disabled={busy === s.ruleId} onClick={() => void record(s, 'DECLINED')}>
                Từ chối
              </button>
            </div>
          ) : null}
        </div>
      ))}
    </div>
  )
}

/* --------------------------------------------------------------- BÁO GIÁ 3 PHƯƠNG ÁN */

/** Vẽ báo giá một phương án thành ảnh PNG để gửi qua chat (không có SĐT khách). */
function drawQuotePng(opt: QuoteOption, meta: { clinicName: string; customerName: string }): HTMLCanvasElement {
  const W = 760
  const lineH = 30
  const H = 230 + opt.lines.length * lineH + 120
  const scale = 2
  const canvas = document.createElement('canvas')
  canvas.width = W * scale
  canvas.height = H * scale
  const g = canvas.getContext('2d')!
  g.scale(scale, scale)
  g.fillStyle = '#ffffff'
  g.fillRect(0, 0, W, H)
  g.fillStyle = '#0f5132'
  g.fillRect(0, 0, W, 78)
  g.fillStyle = '#ffffff'
  g.font = 'bold 22px -apple-system, Segoe UI, Roboto, Arial, sans-serif'
  g.fillText(meta.clinicName, 28, 36)
  g.font = '15px -apple-system, Segoe UI, Roboto, Arial, sans-serif'
  g.fillText(`Báo giá phương án ${opt.label}`, 28, 62)
  g.fillStyle = '#1f2933'
  g.font = '15px -apple-system, Segoe UI, Roboto, Arial, sans-serif'
  g.fillText(`Khách hàng: ${meta.customerName}`, 28, 110)
  g.fillStyle = '#6b7a80'
  g.fillText(`Ngày: ${new Date().toLocaleDateString('vi-VN')}`, W - 190, 110)
  let y = 150
  g.fillStyle = '#6b7a80'
  g.font = 'bold 12px -apple-system, Segoe UI, Roboto, Arial, sans-serif'
  g.fillText('DỊCH VỤ', 28, y)
  g.fillText('SL', 470, y)
  g.textAlign = 'right'
  g.fillText('THÀNH TIỀN', W - 28, y)
  g.textAlign = 'left'
  y += 12
  g.strokeStyle = '#e2e8e6'
  g.beginPath()
  g.moveTo(28, y)
  g.lineTo(W - 28, y)
  g.stroke()
  g.font = '14px -apple-system, Segoe UI, Roboto, Arial, sans-serif'
  for (const l of opt.lines) {
    y += lineH
    g.fillStyle = '#1f2933'
    const name = l.name.length > 52 ? `${l.name.slice(0, 51)}…` : l.name
    g.fillText(name, 28, y - 8)
    g.fillText(String(l.quantity), 470, y - 8)
    g.textAlign = 'right'
    g.fillText(vnd(l.amount), W - 28, y - 8)
    g.textAlign = 'left'
  }
  y += 18
  g.beginPath()
  g.moveTo(28, y)
  g.lineTo(W - 28, y)
  g.stroke()
  y += 28
  g.fillStyle = '#6b7a80'
  g.font = '14px -apple-system, Segoe UI, Roboto, Arial, sans-serif'
  g.fillText('Giá niêm yết', 28, y)
  g.textAlign = 'right'
  g.fillText(vnd(opt.subtotal), W - 28, y)
  g.textAlign = 'left'
  if (opt.discount > 0) {
    y += 24
    g.fillText('Ưu đãi', 28, y)
    g.textAlign = 'right'
    g.fillText(`-${vnd(opt.discount)}`, W - 28, y)
    g.textAlign = 'left'
  }
  y += 34
  g.fillStyle = '#0f5132'
  g.font = 'bold 20px -apple-system, Segoe UI, Roboto, Arial, sans-serif'
  g.fillText('Tổng thanh toán', 28, y)
  g.textAlign = 'right'
  g.fillText(vnd(opt.total), W - 28, y)
  g.textAlign = 'left'
  g.fillStyle = '#6b7a80'
  g.font = '12px -apple-system, Segoe UI, Roboto, Arial, sans-serif'
  g.fillText('Báo giá tham khảo theo bảng giá hiện hành; liều và chỉ định cuối cùng do bác sĩ quyết định sau khi khám.', 28, H - 20)
  return canvas
}

async function exportPng(opt: QuoteOption, meta: { clinicName: string; customerName: string }): Promise<'copied' | 'downloaded'> {
  const canvas = drawQuotePng(opt, meta)
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'))
  const fileName = `bao-gia-${opt.tier.toLowerCase()}-${Date.now()}.png`
  const a = document.createElement('a')
  a.href = canvas.toDataURL('image/png')
  a.download = fileName
  a.click()
  try {
    const CI = (window as unknown as { ClipboardItem?: new (items: Record<string, Blob>) => unknown }).ClipboardItem
    if (blob && CI && navigator.clipboard && 'write' in navigator.clipboard) {
      await (navigator.clipboard as unknown as { write: (items: unknown[]) => Promise<void> }).write([new CI({ 'image/png': blob })])
      return 'copied'
    }
  } catch {
    // Trình duyệt không cho chép ảnh: đã tải tệp về là đủ.
  }
  return 'downloaded'
}

export function QuoteOptionsPanel({
  customerId,
  customerName,
  planId,
  sessionId,
  context = 'QUOTE',
  allowAccept,
  onChosen
}: {
  customerId: string
  customerName: string
  planId?: string | null
  sessionId?: string | null
  context?: UpsellContext
  allowAccept?: boolean
  onChosen?: (q: { id: string; code: string; total: number; status: string }) => void
}): React.JSX.Element {
  const { can } = useAuth()
  const clinic = useClinic()
  const { say, fail } = useToast()
  const [data, setData] = useState<QuoteOptions | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => {
    setError(null)
    previewQuoteOptions({ customerId, planId, sessionId })
      .then(setData)
      .catch((err) => setError(getApiErrorMessage(err)))
  }, [customerId, planId, sessionId])
  useEffect(load, [load])

  const choose = async (opt: QuoteOption, accept: boolean): Promise<void> => {
    const verb = accept ? 'Chốt' : 'Lập báo giá'
    if (!window.confirm(`${verb} phương án ${opt.label}: ${vnd(opt.total)}?`)) return
    setBusy(true)
    try {
      const r = await chooseQuoteOption({ customerId, planId: data?.source.kind === 'PLAN' ? data.source.id : planId, sessionId: data?.source.kind === 'SESSION' ? data.source.id : sessionId, tier: opt.tier, accept, context })
      say(`${accept ? 'Đã chốt' : 'Đã lập'} báo giá ${r.quotation.code}${r.upsellAccepted ? `, ghi ${r.upsellAccepted} dịch vụ bán kèm khách nhận` : ''}.`)
      onChosen?.(r.quotation)
    } catch (err) {
      fail(getApiErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  if (error) return <Empty>{error}</Empty>
  if (!data) return <div className="muted" style={{ fontSize: 12.5 }}>Đang tính ba phương án…</div>
  const canCreate = can('sales_order.create')
  return (
    <div>
      <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
        Từ {data.source.kind === 'PLAN' ? `phác đồ "${data.source.title}"` : 'phiếu tư vấn gần nhất'} · giá niêm yết, tự áp ưu đãi đang chạy.
        {data.packageDiscountPercent > 0
          ? ` Trọn gói giảm thêm ${data.appliedPackagePercent}%${data.capLimited ? ` (cài đặt ${data.packageDiscountPercent}%, kẹp theo trần giảm của bạn ${data.capPercent}%)` : ''}.`
          : ''}
      </div>
      <div className="qopts">
        {data.options.map((o) => (
          <div key={o.tier} className={`qopt ${o.tier}`}>
            <div className="qh">
              {o.label}
              {o.tier === 'RECOMMENDED' ? <span className="hchip PAID">Khuyên dùng</span> : null}
            </div>
            <div className="qt">{vnd(o.total)}</div>
            {o.discount > 0 ? (
              <div className="muted" style={{ fontSize: 11.5 }}>
                Niêm yết {vnd(o.subtotal)} · ưu đãi {vnd(o.discount)}
              </div>
            ) : null}
            <div>
              {o.lines.map((l, i) => (
                <div key={i} className={`ql ${l.upsellRuleId ? 'up' : ''}`} title={l.promotionName ? `Ưu đãi: ${l.promotionName}` : undefined}>
                  <span>
                    {l.upsellRuleId ? '+ ' : ''}
                    {l.name} × {l.quantity}
                  </span>
                  <span>{vndShort(l.amount)}</span>
                </div>
              ))}
              {o.tier === 'PACKAGE'
                ? (data.skippedDeclined ?? []).map((d) => (
                    <div key={d.serviceId} className="muted" style={{ fontSize: 11.5 }} title={d.declineReason ?? undefined}>
                      Không cộng {d.name}: khách đã từ chối ngày {dateVi(d.declinedAt)}
                    </div>
                  ))
                : null}
            </div>
            <div style={{ display: 'grid', gap: 5, marginTop: 'auto', paddingTop: 6 }}>
              {canCreate && allowAccept ? (
                <button className="btn block" disabled={busy} onClick={() => void choose(o, true)}>
                  Chốt phương án này
                </button>
              ) : null}
              {canCreate ? (
                <button className={`btn ${allowAccept ? 'sec' : ''} block`} disabled={busy} onClick={() => void choose(o, false)}>
                  Chọn, lập báo giá
                </button>
              ) : null}
              <button
                className="btn sec block"
                onClick={() =>
                  void exportPng(o, { clinicName: clinic.name || 'Phòng khám', customerName }).then((r) =>
                    say(r === 'copied' ? 'Đã tải ảnh và chép vào bộ nhớ, dán vào khung chat.' : 'Đã tải ảnh báo giá PNG.')
                  )
                }
              >
                Xuất ảnh PNG
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
