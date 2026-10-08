import React, { useCallback, useEffect, useState } from 'react'
import { getApiErrorMessage } from '../lib/api'
import {
  computePayroll,
  currentPeriod,
  downloadFile,
  fetchPayroll,
  lockPayroll,
  updatePayrollLine,
  type PayrollLineRow,
  type PayrollPeriodData
} from '../lib/api-lo5'
import { useAuth } from '../lib/auth-context'
import { dateTimeVi, vnd } from '../lib/format'
import { Drawer, Empty, useToast } from '../components/ui'

/* F17: KỲ LƯƠNG THEO BIÊN BẢN COACHING. Tính, xem căn cứ từng người, sửa phụ
 * cấp và khấu trừ, khoá kỳ, xuất Excel. Mọi mức lương thưởng chỉnh ở Cài đặt
 * hệ thống, nhóm "Lương thưởng". */

const KIND: Record<string, string> = {
  SALE_FULL: 'Bán full',
  SALE_PARTIAL: 'Bán phần (sale)',
  DOCTOR_CLOSE: 'Bác sĩ chốt',
  UPSELL: 'Upsale'
}

export default function Payroll(): React.JSX.Element {
  const { say, fail } = useToast()
  const { can, branchId } = useAuth()
  const [period, setPeriod] = useState(currentPeriod())
  const [data, setData] = useState<PayrollPeriodData | null>(null)
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState<PayrollLineRow | null>(null)
  const [edit, setEdit] = useState({ allowance: '', deduction: '', baseSalary: '', note: '' })
  const canEdit = can('hr.update')
  const locked = data?.status === 'CLOSED'

  const load = useCallback(() => {
    fetchPayroll(period)
      .then(setData)
      .catch((e) => fail(getApiErrorMessage(e)))
  }, [period, fail])

  useEffect(load, [load, branchId])

  const act = async (fn: () => Promise<void>, ok: string): Promise<void> => {
    setBusy(true)
    try {
      await fn()
      say(ok)
      load()
    } catch (e) {
      fail(getApiErrorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const openLine = (l: PayrollLineRow): void => {
    setOpen(l)
    setEdit({ allowance: String(l.allowance), deduction: String(l.deduction), baseSalary: String(l.baseSalary), note: l.note ?? '' })
  }

  const saveLine = async (): Promise<void> => {
    if (!open) return
    await act(
      () =>
        updatePayrollLine(open.id, {
          allowance: Number(edit.allowance || 0),
          deduction: Number(edit.deduction || 0),
          baseSalary: Number(edit.baseSalary || 0),
          note: edit.note || null
        }),
      'Đã lưu dòng lương.'
    )
    setOpen(null)
  }

  const total = (data?.lines ?? []).reduce((s, l) => s + l.total, 0)

  return (
    <div className="card">
      <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
        <div className="sec-title" style={{ margin: 0 }}>Kỳ lương</div>
        <input type="month" value={period} onChange={(e) => setPeriod(e.target.value)} style={{ width: 160 }} />
        <span className="muted" style={{ fontSize: 12.5 }}>
          {locked
            ? `Đã khoá ${data?.closedAt ? dateTimeVi(data.closedAt) : ''}${data?.closedBy ? ` bởi ${data.closedBy.name}` : ''}`
            : data?.computedAt
              ? `Tính lần cuối ${dateTimeVi(data.computedAt)}`
              : 'Chưa tính'}
        </span>
        {canEdit ? (
          <div className="row" style={{ gap: 6, marginLeft: 'auto' }}>
            <button className="btn sm" disabled={busy || locked} onClick={() => void act(() => computePayroll(period), 'Đã tính kỳ lương.')}>
              Tính kỳ lương
            </button>
            <button
              className="btn sm sec"
              disabled={busy || locked || !data?.computedAt}
              onClick={() => {
                if (window.confirm('Khoá kỳ lương? Sau khi khoá không tính lại và không sửa được.')) void act(() => lockPayroll(period), 'Đã khoá kỳ lương.')
              }}
            >
              Khoá kỳ
            </button>
            <button
              className="btn sm sec"
              disabled={busy || !data?.computedAt}
              onClick={() => void act(() => downloadFile(`/payroll/${period}/export`, {}, `ky-luong_${period}.xlsx`), 'Đã tải tệp Excel.')}
            >
              Xuất Excel
            </button>
          </div>
        ) : null}
      </div>
      <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
        Chỉ tính trên tiền đã thu trong kỳ (không gồm voucher). Lương cứng theo bậc khách đến, thưởng doanh số theo phương án đang chọn, bán phần chia theo tỉ lệ, upsale và % quảng cáo theo Cài đặt. Bấm một dòng để xem căn cứ.
      </div>
      {!data || data.lines.length === 0 ? (
        <Empty>Kỳ này chưa có dòng lương. {canEdit ? 'Bấm "Tính kỳ lương".' : ''}</Empty>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table>
            <thead>
              <tr>
                <th>Nhân viên</th><th>Khách đến</th><th>Doanh thu tính thưởng</th><th>Lương cứng</th><th>Thưởng doanh số</th>
                <th>Bác sĩ chốt</th><th>Upsale</th><th>% quảng cáo</th><th>Phụ cấp</th><th>Khấu trừ</th><th>Tổng</th>
              </tr>
            </thead>
            <tbody>
              {data.lines.map((l) => (
                <tr key={l.id} style={{ cursor: 'pointer' }} onClick={() => openLine(l)}>
                  <td><b>{l.user.name}</b> <span className="muted" style={{ fontSize: 11 }}>{l.roleCode ?? ''}</span></td>
                  <td>{l.showups}</td>
                  <td>{vnd(l.revenue)}</td>
                  <td>{vnd(l.baseSalary)}</td>
                  <td>{vnd(l.salesBonus)}</td>
                  <td>{vnd(l.commission)}</td>
                  <td>{vnd(l.upsellBonus)}</td>
                  <td>{vnd(l.adsBonus)}</td>
                  <td>{vnd(l.allowance)}</td>
                  <td>{vnd(l.deduction)}</td>
                  <td><b>{vnd(l.total)}</b></td>
                </tr>
              ))}
              <tr style={{ fontWeight: 600 }}>
                <td colSpan={10}>Tổng kỳ</td>
                <td>{vnd(total)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}

      {open ? (
        <Drawer title={`Căn cứ lương: ${open.user.name}`} onClose={() => setOpen(null)}>
          {open.detail ? (
            <table style={{ marginTop: 10 }}>
              <tbody>
                <tr><td>Doanh thu tính cho sale</td><td>{vnd(open.detail.saleRevenue)}</td></tr>
                <tr><td>Doanh thu bác sĩ chốt (bán phần)</td><td>{vnd(open.detail.doctorRevenue)}</td></tr>
                <tr><td>Doanh thu upsale</td><td>{vnd(open.detail.upsellRevenue)}</td></tr>
                {open.detail.adsStaffCount ? (
                  <tr><td>Doanh thu quảng cáo Facebook của cơ sở</td><td>{vnd(open.detail.adsRevenue)} (chia {open.detail.adsStaffCount} người)</td></tr>
                ) : null}
                <tr><td>Phương án thưởng</td><td>{open.detail.bonusScheme === 'PERCENT_TIER' ? '% theo bậc' : 'Theo mốc'}</td></tr>
              </tbody>
            </table>
          ) : null}
          {canEdit && !locked ? (
            <div style={{ marginTop: 12 }}>
              <div className="sec-title">Nhập tay</div>
              {(['baseSalary', 'allowance', 'deduction'] as const).map((k) => (
                <div className="field" key={k}>
                  <label>{k === 'baseSalary' ? 'Lương cứng (vai ngoài bảng bậc)' : k === 'allowance' ? 'Phụ cấp' : 'Khấu trừ'}</label>
                  <input inputMode="numeric" value={edit[k]} onChange={(e) => setEdit({ ...edit, [k]: e.target.value.replace(/\D/g, '') })} />
                </div>
              ))}
              <div className="field">
                <label>Ghi chú</label>
                <input value={edit.note} onChange={(e) => setEdit({ ...edit, note: e.target.value })} />
              </div>
              <button className="btn" disabled={busy} onClick={() => void saveLine()}>Lưu dòng lương</button>
            </div>
          ) : null}
          <div className="sec-title">Phiếu thu được tính</div>
          {!open.detail?.contributions.length ? (
            <Empty>Không có phiếu thu nào.</Empty>
          ) : (
            <table>
              <thead><tr><th>Phiếu</th><th>Khách</th><th>Loại</th><th>Số tiền</th><th>Phần tính</th></tr></thead>
              <tbody>
                {open.detail.contributions.map((c, i) => (
                  <tr key={`${c.paymentCode}${i}`}>
                    <td>{c.paymentCode}<div className="muted" style={{ fontSize: 11 }}>{c.paidAt}</div></td>
                    <td>{c.customer}</td>
                    <td>{KIND[c.kind] ?? c.kind}</td>
                    <td>{vnd(c.amount)}</td>
                    <td>{vnd(c.credited)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Drawer>
      ) : null}
    </div>
  )
}
