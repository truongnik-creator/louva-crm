/* Định dạng theo chuẩn Việt Nam. Tiền trong hệ thống là số nguyên, đơn vị
   ĐỒNG — không có phần lẻ, nên mọi hàm dưới đây nhận và trả số nguyên. */

export function vnd(amount: number | null | undefined): string {
  if (amount == null) return '—'
  return `${amount.toLocaleString('vi-VN')}đ`
}

/** Rút gọn cho ô KPI hẹp: 1.482.000.000đ -> 1,48 tỷ */
export function vndShort(amount: number | null | undefined): string {
  if (amount == null) return '—'
  const abs = Math.abs(amount)
  if (abs >= 1_000_000_000) return `${(amount / 1_000_000_000).toFixed(2).replace('.', ',')} tỷ`
  if (abs >= 1_000_000) return `${(amount / 1_000_000).toFixed(1).replace('.', ',')} tr`
  return vnd(amount)
}

export function toISODate(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

export function hhmm(iso: string | Date | null | undefined): string {
  if (!iso) return '—'
  const d = typeof iso === 'string' ? new Date(iso) : iso
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })
}

export function ddmm(iso: string | Date | null | undefined): string {
  if (!iso) return '—'
  const d = typeof iso === 'string' ? new Date(iso) : iso
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' })
}

export function dateVi(iso: string | Date | null | undefined): string {
  if (!iso) return '—'
  const d = typeof iso === 'string' ? new Date(iso) : iso
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleDateString('vi-VN')
}

export function dateTimeVi(iso: string | Date | null | undefined): string {
  if (!iso) return '—'
  const d = typeof iso === 'string' ? new Date(iso) : iso
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString('vi-VN', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}

/** "Vừa xong" / "12 phút trước" / "Hôm qua" / ngày cụ thể — giống cột giờ của hộp thư. */
export function relativeVi(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'

  const diffMin = Math.floor((Date.now() - d.getTime()) / 60000)
  if (diffMin < 1) return 'Vừa xong'
  if (diffMin < 60) return `${diffMin} phút`

  const today = new Date()
  const isToday = d.toDateString() === today.toDateString()
  if (isToday) return hhmm(d)

  const yesterday = new Date(today)
  yesterday.setDate(yesterday.getDate() - 1)
  if (d.toDateString() === yesterday.toDateString()) return 'Hôm qua'

  return d.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' })
}

export function minutesLabel(minutes: number | null | undefined): string {
  if (minutes == null || Number.isNaN(minutes)) return '—'
  if (minutes < 60) return `${Math.round(minutes)} phút`
  const h = Math.floor(minutes / 60)
  const m = Math.round(minutes % 60)
  return m ? `${h} giờ ${m} phút` : `${h} giờ`
}

export function percent(value: number | null | undefined, digits = 1): string {
  if (value == null) return '—'
  return `${value.toFixed(digits).replace('.', ',')}%`
}

/** Thứ trong tuần viết tắt kiểu Việt: T2..T7, CN. */
export function weekdayVi(date: Date): string {
  const day = date.getDay()
  return day === 0 ? 'CN' : `T${day + 1}`
}

export function weekdayLongVi(date: Date): string {
  const names = ['Chủ nhật', 'Thứ Hai', 'Thứ Ba', 'Thứ Tư', 'Thứ Năm', 'Thứ Sáu', 'Thứ Bảy']
  return names[date.getDay()]
}
