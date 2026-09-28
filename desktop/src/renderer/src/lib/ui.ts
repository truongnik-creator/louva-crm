import type { FunnelStage } from './types'

/* Bảng màu và nhãn — lấy nguyên từ biến STAGES / TTHEN / MUC trong
   crm-app/docs/prototype_tmv.html để giao diện thật khớp bản thiết kế. */

export interface TagStyle {
  t: string
  bg: string
  fg: string
}

export const STAGES: Record<FunnelStage, TagStyle> = {
  MOI: { t: 'Mới', bg: '#EEF2FF', fg: '#4338CA' },
  LIENHE: { t: 'Đã liên hệ', bg: '#FEF3C7', fg: '#B45309' },
  HEN: { t: 'Đã hẹn', bg: '#DBEAFE', fg: '#1D4ED8' },
  DEN: { t: 'Đã đến', bg: '#CFFAFE', fg: '#0E7490' },
  CHOT: { t: 'Đã chốt', bg: '#DCFCE7', fg: '#15803D' },
  PT: { t: 'Đã phẫu thuật', bg: '#D1FAE5', fg: '#047857' },
  HAUPHAU: { t: 'Hậu phẫu', bg: '#E0F2FE', fg: '#0369A1' },
  HOANTAT: { t: 'Hoàn tất', bg: '#F1F5F9', fg: '#475569' },
  TAIMUA: { t: 'Tái mua', bg: '#FAE8FF', fg: '#A21CAF' },
  MAT: { t: 'Mất khách', bg: '#FEE2E2', fg: '#B91C1C' }
}

export const APPOINTMENT_STATUS: Record<string, TagStyle> = {
  ARRIVED: { t: 'Đã đến', bg: '#CFFAFE', fg: '#0E7490' },
  CONFIRMED: { t: 'Đã xác nhận', bg: '#DBEAFE', fg: '#1D4ED8' },
  PENDING: { t: 'Chưa xác nhận', bg: '#F1F5F9', fg: '#475569' },
  NO_SHOW: { t: 'Vắng mặt', bg: '#FEE2E2', fg: '#B91C1C' },
  CANCELLED: { t: 'Đã huỷ', bg: '#FEE2E2', fg: '#B91C1C' },
  DONE: { t: 'Hoàn tất', bg: '#DCFCE7', fg: '#15803D' }
}

export const VISIT_STATUS: Record<string, TagStyle> = {
  WAITING: { t: 'Đang chờ', bg: '#FEF3C7', fg: '#B45309' },
  CONSULTING: { t: 'Đang tư vấn', bg: '#DBEAFE', fg: '#1D4ED8' },
  IN_SERVICE: { t: 'Đang làm dịch vụ', bg: '#CFFAFE', fg: '#0E7490' },
  PAYING: { t: 'Đang thanh toán', bg: '#FAE8FF', fg: '#A21CAF' },
  DONE: { t: 'Xong', bg: '#DCFCE7', fg: '#15803D' },
  LEFT: { t: 'Khách về', bg: '#F1F5F9', fg: '#475569' }
}

export const PROCEDURE_STATUS: Record<string, TagStyle> = {
  SCHEDULED: { t: 'Đã xếp lịch', bg: '#F1F5F9', fg: '#475569' },
  CONFIRMED: { t: 'Đã xác nhận', bg: '#DBEAFE', fg: '#1D4ED8' },
  IN_PROGRESS: { t: 'Đang mổ', bg: '#FEF3C7', fg: '#B45309' },
  COMPLETED: { t: 'Đã mổ xong', bg: '#DCFCE7', fg: '#15803D' },
  CANCELLED: { t: 'Đã huỷ', bg: '#FEE2E2', fg: '#B91C1C' },
  POSTPONED: { t: 'Đã dời', bg: '#FEE2E2', fg: '#B91C1C' }
}

export const CONTRACT_STATUS: Record<string, TagStyle> = {
  DRAFT: { t: 'Nháp', bg: '#F1F5F9', fg: '#475569' },
  SIGNED: { t: 'Đã ký', bg: '#DCFCE7', fg: '#15803D' },
  IN_PROGRESS: { t: 'Đang thực hiện', bg: '#DBEAFE', fg: '#1D4ED8' },
  COMPLETED: { t: 'Hoàn tất', bg: '#D1FAE5', fg: '#047857' },
  CANCELLED: { t: 'Đã huỷ', bg: '#FEE2E2', fg: '#B91C1C' }
}

export const INVOICE_STATUS: Record<string, TagStyle> = {
  DRAFT: { t: 'Nháp', bg: '#F1F5F9', fg: '#475569' },
  ISSUED: { t: 'Chờ thu', bg: '#FEF3C7', fg: '#B45309' },
  PARTIAL: { t: 'Thu một phần', bg: '#DBEAFE', fg: '#1D4ED8' },
  PAID: { t: 'Đã thu', bg: '#DCFCE7', fg: '#15803D' },
  OVERDUE: { t: 'Quá hạn', bg: '#FEE2E2', fg: '#B91C1C' },
  VOID: { t: 'Đã huỷ', bg: '#F1F5F9', fg: '#475569' }
}

export const LEAD_STAGE: Record<string, TagStyle> = {
  NEW: { t: 'Mới', bg: '#EEF2FF', fg: '#4338CA' },
  CONTACTING: { t: 'Đang liên hệ', bg: '#FEF3C7', fg: '#B45309' },
  APPOINTED: { t: 'Đã hẹn', bg: '#DBEAFE', fg: '#1D4ED8' },
  ARRIVED: { t: 'Đã đến', bg: '#CFFAFE', fg: '#0E7490' },
  WON: { t: 'Thành khách', bg: '#DCFCE7', fg: '#15803D' },
  LOST: { t: 'Thất bại', bg: '#FEE2E2', fg: '#B91C1C' },
  SPAM: { t: 'Rác', bg: '#F1F5F9', fg: '#475569' }
}

export const PHOTO_STAGE_LABEL: Record<string, string> = {
  PRE_OP: 'Trước mổ',
  INTRA_OP: 'Trong mổ',
  D1: 'Ngày 1',
  D7: 'Ngày 7',
  M1: 'Tháng 1',
  M3: 'Tháng 3',
  M6: 'Tháng 6',
  OTHER: 'Khác'
}

export const PAYMENT_METHOD_LABEL: Record<string, string> = {
  CASH: 'Tiền mặt',
  BANK_TRANSFER: 'Chuyển khoản',
  CARD: 'Thẻ',
  QR: 'QR',
  INSTALLMENT: 'Trả góp',
  OTHER: 'Khác'
}

export const ANESTHESIA_LABEL: Record<string, string> = {
  NONE: 'Không vô cảm',
  LOCAL: 'Tê tại chỗ',
  SEDATION: 'Tiền mê',
  GENERAL: 'Mê toàn thân'
}

export function stageStyle(stage: string | null | undefined): TagStyle {
  return STAGES[stage as FunnelStage] ?? { t: stage ?? '—', bg: '#F1F5F9', fg: '#475569' }
}

export function tagStyleOf(map: Record<string, TagStyle>, key: string | null | undefined): TagStyle {
  return map[key ?? ''] ?? { t: key ?? '—', bg: '#F1F5F9', fg: '#475569' }
}

/** Chữ cái đầu của tên riêng (chữ cuối trong họ tên) — giống hàm avatar của prototype. */
export function initialOf(name: string): string {
  const parts = name.trim().split(/\s+/)
  return (parts[parts.length - 1]?.charAt(0) ?? '?').toUpperCase()
}
