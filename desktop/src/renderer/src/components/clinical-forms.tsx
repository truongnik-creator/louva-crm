import { fetchPromotions, type PromotionRow } from '../lib/api-lo4'
import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  addMedicalEntry,
  createConsent,
  createContract,
  createMedicalRecord,
  createQuotation,
  fetchServices,
  fetchStaff,
  getApiErrorMessage,
  signConsent,
  uploadPhotoSet
} from '../lib/api'
import { useAuth } from '../lib/auth-context'
import { toISODate, vnd } from '../lib/format'
import { PHOTO_STAGE_LABEL } from '../lib/ui'
import { useClinic } from '../lib/clinic-context'
import { Modal, useToast } from './ui'
import { SignaturePad, type SignaturePadHandle } from './SignaturePad'
import type { Service, StaffUser } from '../lib/types'

/* Các biểu mẫu thao tác của khối chuyên môn và kinh doanh.
 *
 * Tách khỏi CustomerDetail.tsx vì cùng một biểu mẫu được gọi từ nhiều màn:
 * mở bệnh án gọi từ hồ sơ khách lẫn từ hàng đợi lễ tân, tạo báo giá gọi từ hồ
 * sơ khách lẫn từ khung chat Zalo. */

/* ------------------------------------------------------------ MỞ BỆNH ÁN */

export function OpenRecordModal({
  customerId,
  onClose,
  onDone
}: {
  customerId: string
  onClose: () => void
  onDone: () => void
}): React.JSX.Element {
  const { say, fail } = useToast()
  const [form, setForm] = useState({
    bloodType: '',
    chronicDisease: '',
    currentMedication: '',
    pastAesthetic: '',
    pregnancyNote: '',
    smoking: false
  })
  const [saving, setSaving] = useState(false)

  const submit = async (): Promise<void> => {
    setSaving(true)
    try {
      await createMedicalRecord({
        customerId,
        bloodType: form.bloodType || null,
        chronicDisease: form.chronicDisease || null,
        currentMedication: form.currentMedication || null,
        pastAesthetic: form.pastAesthetic || null,
        pregnancyNote: form.pregnancyNote || null,
        smoking: form.smoking
      })
      say('Đã mở bệnh án cho khách.')
      onDone()
    } catch (err) {
      fail(getApiErrorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }))

  return (
    <Modal
      title="Mở bệnh án tại cơ sở này"
      onClose={onClose}
      footer={
        <>
          <button className="btn sec" onClick={onClose}>
            Huỷ
          </button>
          <button className="btn" onClick={() => void submit()} disabled={saving}>
            {saving ? 'Đang lưu…' : 'Mở bệnh án'}
          </button>
        </>
      }
    >
      <div className="alert wr">
        Bệnh án thuộc về CƠ SỞ đang làm việc, không liên thông sang cơ sở khác. Có thể bổ sung dần —
        không bắt buộc điền hết ngay.
      </div>
      <div className="field">
        <label>Nhóm máu</label>
        <input className="input" value={form.bloodType} onChange={set('bloodType')} placeholder="O (Rh+)" />
      </div>
      <div className="field">
        <label>Bệnh nền</label>
        <input className="input" value={form.chronicDisease} onChange={set('chronicDisease')} />
      </div>
      <div className="field">
        <label>Thuốc đang dùng</label>
        <input className="input" value={form.currentMedication} onChange={set('currentMedication')} />
      </div>
      <div className="field">
        <label>Tiền sử phẫu thuật thẩm mỹ</label>
        <input className="input" value={form.pastAesthetic} onChange={set('pastAesthetic')} />
      </div>
      <div className="field">
        <label>Mang thai / cho con bú</label>
        <input className="input" value={form.pregnancyNote} onChange={set('pregnancyNote')} />
      </div>
      <label className="row" style={{ fontSize: 13, gap: 6 }}>
        <input
          type="checkbox"
          checked={form.smoking}
          onChange={(e) => setForm((f) => ({ ...f, smoking: e.target.checked }))}
        />
        Có hút thuốc
      </label>
    </Modal>
  )
}

/* --------------------------------------------------------- GHI CHÉP KHÁM */

export function AddEntryModal({
  recordId,
  onClose,
  onDone
}: {
  recordId: string
  onClose: () => void
  onDone: () => void
}): React.JSX.Element {
  const { say, fail } = useToast()
  const [kind, setKind] = useState('EXAM')
  const [content, setContent] = useState('')
  const [saving, setSaving] = useState(false)

  const submit = async (): Promise<void> => {
    if (content.trim().length < 2) {
      fail('Nhập nội dung ghi chép.')
      return
    }
    setSaving(true)
    try {
      await addMedicalEntry(recordId, content.trim(), kind)
      say('Đã ghi vào bệnh án.')
      onDone()
    } catch (err) {
      fail(getApiErrorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      title="Ghi chép khám"
      onClose={onClose}
      footer={
        <>
          <button className="btn sec" onClick={onClose}>
            Huỷ
          </button>
          <button className="btn" onClick={() => void submit()} disabled={saving}>
            {saving ? 'Đang lưu…' : 'Ghi vào bệnh án'}
          </button>
        </>
      }
    >
      <div className="field">
        <label>Loại ghi chép</label>
        <select className="input" value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="EXAM">Khám</option>
          <option value="DIAGNOSIS">Chẩn đoán</option>
          <option value="PLAN">Hướng xử trí</option>
          <option value="NOTE">Ghi chú</option>
        </select>
      </div>
      <div className="field">
        <label>Nội dung</label>
        <textarea className="input" rows={6} value={content} onChange={(e) => setContent(e.target.value)} />
      </div>
      <div className="muted" style={{ fontSize: 11.5 }}>
        Ghi chép không sửa/xoá được sau khi lưu — mọi bổ sung đều là một dòng mới có tên người ghi và
        thời điểm.
      </div>
    </Modal>
  )
}

/* ------------------------------------------------------------- CAM KẾT */

const CONSENT_TEMPLATES: Record<string, { title: string; body: string }> = {
  SURGERY: {
    title: 'Cam kết phẫu thuật',
    body: 'Tôi đã được bác sĩ giải thích đầy đủ về phương pháp phẫu thuật, các rủi ro có thể xảy ra (chảy máu, nhiễm trùng, tụ dịch, sẹo xấu, bất đối xứng, kết quả không như mong đợi), quá trình hồi phục và chi phí. Tôi đã có cơ hội đặt câu hỏi và được giải đáp. Tôi tự nguyện đồng ý thực hiện phẫu thuật.'
  },
  ANESTHESIA: {
    title: 'Cam kết gây mê / gây tê',
    body: 'Tôi đã được bác sĩ gây mê giải thích về phương pháp vô cảm, các rủi ro liên quan và đã khai báo trung thực tiền sử dị ứng, bệnh nền, thuốc đang dùng. Tôi đồng ý thực hiện vô cảm theo chỉ định.'
  },
  PHOTO_USE: {
    title: 'Đồng ý chụp và lưu ảnh trước - sau',
    body: 'Tôi đồng ý để phòng khám chụp và lưu trữ ảnh tình trạng trước và sau khi thực hiện dịch vụ, phục vụ mục đích theo dõi chuyên môn. Ảnh chỉ được sử dụng cho mục đích truyền thông khi tôi ký riêng văn bản đồng ý, và tôi có quyền rút lại đồng ý bất cứ lúc nào.'
  },
  MINOR_PROCEDURE: {
    title: 'Cam kết thực hiện thủ thuật',
    body: 'Tôi đã được nhân viên y tế giải thích về thủ thuật sẽ thực hiện, các phản ứng có thể gặp (sưng, bầm, đau, dị ứng) và cách chăm sóc sau thủ thuật. Tôi đã khai báo trung thực tiền sử dị ứng và bệnh nền. Tôi tự nguyện đồng ý thực hiện.'
  },
  DATA_PRIVACY: {
    title: 'Đồng ý xử lý dữ liệu cá nhân',
    body: 'Tôi đồng ý để phòng khám thu thập và xử lý thông tin cá nhân, thông tin sức khoẻ của tôi phục vụ việc khám chữa bệnh, chăm sóc sau dịch vụ và nghĩa vụ lưu trữ hồ sơ theo quy định.'
  }
}

export function ConsentModal({
  customerId,
  onClose,
  onDone
}: {
  customerId: string
  onClose: () => void
  onDone: () => void
}): React.JSX.Element {
  const { say, fail } = useToast()
  const [type, setType] = useState('SURGERY')
  const [title, setTitle] = useState(CONSENT_TEMPLATES.SURGERY.title)
  const [bodyText, setBodyText] = useState(CONSENT_TEMPLATES.SURGERY.body)
  const [signNow, setSignNow] = useState(true)
  const [saving, setSaving] = useState(false)
  const padRef = useRef<SignaturePadHandle>(null)

  const pickType = (next: string): void => {
    setType(next)
    const t = CONSENT_TEMPLATES[next]
    if (t) {
      setTitle(t.title)
      setBodyText(t.body)
    }
  }

  const submit = async (): Promise<void> => {
    // B16: ghi nhận "đã ký" thì phải có chữ ký tay thật, lưu kèm cam kết.
    const signature = signNow ? await padRef.current?.toBlob() : null
    if (signNow && !signature) {
      fail('Khách chưa ký vào khung chữ ký.')
      return
    }
    setSaving(true)
    try {
      const form = await createConsent({ customerId, type, title, bodyText })
      if (signNow && signature) await signConsent(form.id, signature)
      say(signNow ? 'Đã tạo và ghi nhận khách đã ký cam kết.' : 'Đã tạo cam kết, chờ khách ký.')
      onDone()
    } catch (err) {
      fail(getApiErrorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      title="Cam kết của khách"
      onClose={onClose}
      width={640}
      footer={
        <>
          <button className="btn sec" onClick={onClose}>
            Huỷ
          </button>
          <button className="btn" onClick={() => void submit()} disabled={saving}>
            {saving ? 'Đang lưu…' : signNow ? 'Tạo và ghi nhận đã ký' : 'Tạo cam kết'}
          </button>
        </>
      }
    >
      <div className="field">
        <label>Loại cam kết</label>
        <select className="input" value={type} onChange={(e) => pickType(e.target.value)}>
          <option value="SURGERY">Phẫu thuật</option>
          <option value="ANESTHESIA">Gây mê / gây tê</option>
          <option value="MINOR_PROCEDURE">Thủ thuật nhỏ</option>
          <option value="PHOTO_USE">Chụp và lưu ảnh</option>
          <option value="DATA_PRIVACY">Xử lý dữ liệu cá nhân</option>
        </select>
      </div>
      <div className="field">
        <label>Tiêu đề</label>
        <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
      </div>
      <div className="field">
        <label>Nội dung cam kết</label>
        <textarea className="input" rows={8} value={bodyText} onChange={(e) => setBodyText(e.target.value)} />
      </div>
      <label className="row" style={{ fontSize: 13, gap: 6 }}>
        <input type="checkbox" checked={signNow} onChange={(e) => setSignNow(e.target.checked)} />
        Khách đã ký trước mặt nhân viên
      </label>
      {signNow ? (
        <div className="field" style={{ marginTop: 8 }}>
          <label>Chữ ký của khách</label>
          <SignaturePad ref={padRef} />
        </div>
      ) : null}
      <div className="muted" style={{ fontSize: 11.5, marginTop: 8 }}>
        Ca mổ không xác nhận được nếu chưa có cam kết phẫu thuật đã ký.
      </div>
    </Modal>
  )
}

/* --------------------------------------------------------------- ẢNH */

export function PhotoUploadModal({
  customerId,
  onClose,
  onDone
}: {
  customerId: string
  onClose: () => void
  onDone: () => void
}): React.JSX.Element {
  const { say, fail } = useToast()
  const clinic = useClinic()
  const stageOptions = clinic.photoStages.length ? clinic.photoStages : Object.keys(PHOTO_STAGE_LABEL)
  const [stage, setStage] = useState(stageOptions[0] ?? 'PRE_OP')
  const [note, setNote] = useState('')
  const [files, setFiles] = useState<File[]>([])
  const [saving, setSaving] = useState(false)

  const submit = async (): Promise<void> => {
    if (!files.length) {
      fail('Chọn ít nhất một ảnh.')
      return
    }
    setSaving(true)
    try {
      const r = await uploadPhotoSet({ customerId, stage, note: note || undefined, files })
      say(`Đã lưu ${r.photoCount} ảnh (đã mã hoá).`)
      onDone()
    } catch (err) {
      fail(getApiErrorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      title="Thêm ảnh theo mốc"
      onClose={onClose}
      footer={
        <>
          <button className="btn sec" onClick={onClose}>
            Huỷ
          </button>
          <button className="btn" onClick={() => void submit()} disabled={saving || !files.length}>
            {saving ? 'Đang tải lên…' : `Lưu ${files.length || ''} ảnh`}
          </button>
        </>
      }
    >
      <div className="field">
        <label>Mốc chụp</label>
        <select className="input" value={stage} onChange={(e) => setStage(e.target.value)}>
          {stageOptions.map((k) => (
            <option key={k} value={k}>
              {PHOTO_STAGE_LABEL[k] ?? k}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label>Chọn ảnh (nhiều ảnh cùng lúc)</label>
        <input
          className="input"
          type="file"
          accept="image/*"
          multiple
          onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
        />
      </div>
      <div className="field">
        <label>Ghi chú</label>
        <input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Góc chụp, điều kiện ánh sáng…" />
      </div>
      <div className="muted" style={{ fontSize: 11.5 }}>
        Ảnh được mã hoá AES-256-GCM khi lưu. Mỗi lần xem đều bị kiểm quyền và ghi vào nhật ký truy cập.
      </div>
    </Modal>
  )
}

/* -------------------------------------------------- BÁO GIÁ / HỢP ĐỒNG */

interface LineDraft {
  serviceId: string
  name: string
  quantity: number
  unitPrice: number
  discount: number
  /** F13: đợt ưu đãi, F21: lý do giảm ngoài ưu đãi. */
  promotionId: string
  discountReason: string
}

/**
 * Dùng chung cho cả báo giá và hợp đồng: khác nhau ở chỗ hợp đồng cần thêm
 * LỊCH THU (cọc / trước mổ / sau mổ) và tổng lịch thu phải khớp giá trị.
 */
export function DealModal({
  customerId,
  mode,
  onClose,
  onDone
}: {
  customerId: string
  mode: 'quotation' | 'contract'
  onClose: () => void
  onDone: () => void
}): React.JSX.Element {
  const { say, fail } = useToast()
  const { user } = useAuth()
  const [services, setServices] = useState<Service[]>([])
  const [staff, setStaff] = useState<StaffUser[]>([])
  const [lines, setLines] = useState<LineDraft[]>([])
  const [consultantId, setConsultantId] = useState('')
  const [note, setNote] = useState('')
  const [useSchedule, setUseSchedule] = useState(mode === 'contract')
  const [depositPct, setDepositPct] = useState(30)
  const [saving, setSaving] = useState(false)
  const [promotions, setPromotions] = useState<PromotionRow[]>([])

  useEffect(() => {
    fetchServices().then(setServices).catch(() => undefined)
    fetchStaff().then(setStaff).catch(() => undefined)
    fetchPromotions({ active: '1' }).then(setPromotions).catch(() => undefined)
  }, [])

  const promosFor = (serviceId: string): PromotionRow[] =>
    promotions.filter((p) => !p.services.length || p.services.some((x) => x.serviceId === serviceId))

  const applyPromotion = (i: number, promotionId: string): void =>
    setLines((ls) =>
      ls.map((l, idx) => {
        if (idx !== i) return l
        const p = promotions.find((x) => x.id === promotionId)
        const gross = l.quantity * l.unitPrice
        const discount = !p ? 0 : p.kind === 'PERCENT' ? Math.round((gross * p.value) / 100) : Math.min(gross, p.value * l.quantity)
        return { ...l, promotionId, discount }
      })
    )

  useEffect(() => {
    if (user) setConsultantId(user.id)
  }, [user])

  const total = useMemo(
    () => lines.reduce((s, l) => s + l.quantity * l.unitPrice - l.discount, 0),
    [lines]
  )

  const addLine = (serviceId: string): void => {
    const svc = services.find((s) => s.id === serviceId)
    if (!svc) return
    setLines((ls) => [
      ...ls,
      { serviceId: svc.id, name: svc.name, quantity: 1, unitPrice: svc.price ?? 0, discount: 0, promotionId: '', discountReason: '' }
    ])
  }

  const patch = (i: number, key: keyof LineDraft, value: number): void =>
    setLines((ls) => ls.map((l, idx) => (idx === i ? { ...l, [key]: value } : l)))

  // Lịch thu 3 đợt: cọc theo % khi ký, phần còn lại chia đôi trước/sau mổ.
  const schedule = useMemo(() => {
    if (!useSchedule || total <= 0) return []
    const deposit = Math.round((total * depositPct) / 100)
    const rest = total - deposit
    const preOp = Math.round(rest * 0.7)
    const postOp = rest - preOp
    const today = new Date()
    const plus = (d: number): string => {
      const x = new Date(today)
      x.setDate(x.getDate() + d)
      return toISODate(x)
    }
    return [
      { title: `Cọc ${depositPct}% (khi ký)`, amount: deposit, dueDate: plus(0) },
      { title: 'Trước mổ', amount: preOp, dueDate: plus(7) },
      { title: 'Sau mổ', amount: postOp, dueDate: plus(21) }
    ].filter((s) => s.amount > 0)
  }, [useSchedule, total, depositPct])

  const submit = async (): Promise<void> => {
    if (!lines.length) {
      fail('Thêm ít nhất một dịch vụ.')
      return
    }
    setSaving(true)
    try {
      const items = lines.map((l) => ({
        serviceId: l.serviceId,
        name: l.name,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        discount: l.discount,
        promotionId: l.promotionId || undefined,
        discountReason: l.discountReason.trim() || undefined
      }))

      if (mode === 'quotation') {
        const q = (await createQuotation({ customerId, items, note: note || undefined })) as {
          code: string
          approval?: { status: string; maxExcessPercent: number; capPercent: number }
        }
        if (q.approval?.status === 'PENDING') {
          say(`Đã lập báo giá ${q.code}: giảm ${q.approval.maxExcessPercent}% vượt trần ${q.approval.capPercent}%, đang chờ quản lý duyệt.`)
        } else {
          say(`Đã lập báo giá ${q.code}: ${vnd(total)}.`)
        }
      } else {
        const c = await createContract({
          customerId,
          items,
          consultantId: consultantId || undefined,
          note: note || undefined,
          ...(schedule.length ? { schedule } : {})
        })
        say(`Đã tạo hợp đồng ${c.code} — ${vnd(total)}. Khách chuyển sang giai đoạn Đã chốt.`)
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
      title={mode === 'quotation' ? 'Lập báo giá' : 'Tạo hợp đồng'}
      onClose={onClose}
      width={720}
      footer={
        <>
          <button className="btn sec" onClick={onClose}>
            Huỷ
          </button>
          <button className="btn" onClick={() => void submit()} disabled={saving || !lines.length}>
            {saving ? 'Đang lưu…' : mode === 'quotation' ? 'Lập báo giá' : 'Tạo hợp đồng'}
          </button>
        </>
      }
    >
      <div className="field">
        <label>Thêm dịch vụ</label>
        <select
          className="input"
          value=""
          onChange={(e) => {
            addLine(e.target.value)
            e.target.value = ''
          }}
        >
          <option value="">— Chọn dịch vụ để thêm —</option>
          {services.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
              {s.price != null ? ` — ${vnd(s.price)}` : ''}
            </option>
          ))}
        </select>
      </div>

      {lines.length ? (
        <table style={{ marginBottom: 10 }}>
          <thead>
            <tr>
              <th>Dịch vụ</th>
              <th style={{ width: 60 }}>SL</th>
              <th style={{ width: 130 }}>Đơn giá</th>
              <th style={{ width: 120 }}>Giảm</th>
              <th style={{ width: 120 }}>Thành tiền</th>
              <th style={{ width: 32 }} />
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={i}>
                <td>{l.name}</td>
                <td>
                  <input
                    className="input"
                    type="number"
                    min={1}
                    value={l.quantity}
                    onChange={(e) => patch(i, 'quantity', Number(e.target.value))}
                  />
                </td>
                <td>
                  <input
                    className="input"
                    type="number"
                    value={l.unitPrice}
                    onChange={(e) => patch(i, 'unitPrice', Number(e.target.value))}
                  />
                </td>
                <td>
                  <input
                    className="input"
                    type="number"
                    value={l.discount}
                    onChange={(e) => patch(i, 'discount', Number(e.target.value))}
                  />
                  {promosFor(l.serviceId).length ? (
                    <select
                      className="input"
                      style={{ marginTop: 4 }}
                      value={l.promotionId}
                      onChange={(e) => applyPromotion(i, e.target.value)}
                    >
                      <option value="">Không dùng ưu đãi</option>
                      {promosFor(l.serviceId).map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name} ({p.kind === 'PERCENT' ? `${p.value}%` : vnd(p.value)}
                          {p.slotsLeft != null ? `, còn ${p.slotsLeft} suất` : ''})
                        </option>
                      ))}
                    </select>
                  ) : null}
                  {l.discount > 0 && !l.promotionId ? (
                    <input
                      className="input"
                      style={{ marginTop: 4 }}
                      placeholder="Lý do giảm (bắt buộc)"
                      value={l.discountReason}
                      onChange={(e) =>
                        setLines((ls) => ls.map((x, idx) => (idx === i ? { ...x, discountReason: e.target.value } : x)))
                      }
                    />
                  ) : null}
                </td>
                <td>
                  <b>{vnd(l.quantity * l.unitPrice - l.discount)}</b>
                </td>
                <td>
                  <button
                    className="btn sec sm"
                    onClick={() => setLines((ls) => ls.filter((_, idx) => idx !== i))}
                  >
                    ✕
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}

      <div className="row" style={{ justifyContent: 'flex-end', marginBottom: 10 }}>
        <b style={{ fontSize: 15 }}>Tổng: {vnd(total)}</b>
      </div>

      {mode === 'contract' ? (
        <>
          <div className="field">
            <label>Tư vấn viên phụ trách</label>
            <select className="input" value={consultantId} onChange={(e) => setConsultantId(e.target.value)}>
              <option value="">— Không gán —</option>
              {staff.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
          <label className="row" style={{ fontSize: 13, gap: 6, marginBottom: 8 }}>
            <input type="checkbox" checked={useSchedule} onChange={(e) => setUseSchedule(e.target.checked)} />
            Chia lịch thu thành nhiều đợt
          </label>
          {useSchedule ? (
            <>
              <div className="field">
                <label>Tỉ lệ cọc khi ký (%)</label>
                <input
                  className="input"
                  type="number"
                  min={0}
                  max={100}
                  value={depositPct}
                  onChange={(e) => setDepositPct(Number(e.target.value))}
                />
              </div>
              <table>
                <thead>
                  <tr>
                    <th>Đợt</th>
                    <th>Số tiền</th>
                    <th>Hạn</th>
                  </tr>
                </thead>
                <tbody>
                  {schedule.map((s) => (
                    <tr key={s.title}>
                      <td>{s.title}</td>
                      <td>{vnd(s.amount)}</td>
                      <td className="muted">{s.dueDate}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {depositPct < 30 ? (
                <div className="alert wr" style={{ marginTop: 8 }}>
                  Cọc dưới 30% thì ca mổ sẽ không qua được checklist tiền phẫu.
                </div>
              ) : null}
            </>
          ) : null}
        </>
      ) : null}

      <div className="field" style={{ marginTop: 10 }}>
        <label>Ghi chú</label>
        <input className="input" value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
    </Modal>
  )
}

/* --------------------------------------------------------- XẾP CA MỔ */

export function ScheduleProcedureModal({
  onClose,
  onDone,
  defaultCustomerId
}: {
  onClose: () => void
  onDone: () => void
  defaultCustomerId?: string
}): React.JSX.Element {
  const { say, fail } = useToast()
  const [customers, setCustomers] = useState<Array<{ id: string; name: string; code: string; stage: string }>>([])
  const [services, setServices] = useState<Service[]>([])
  const [staff, setStaff] = useState<StaffUser[]>([])
  const [rooms, setRooms] = useState<Array<{ id: string; name: string; type: string }>>([])

  const [customerId, setCustomerId] = useState(defaultCustomerId ?? '')
  const [serviceId, setServiceId] = useState('')
  const [title, setTitle] = useState('')
  const [surgeonId, setSurgeonId] = useState('')
  const [roomId, setRoomId] = useState('')
  const [anesthesia, setAnesthesia] = useState('LOCAL')
  const [date, setDate] = useState(() => toISODate(new Date()))
  const [time, setTime] = useState('08:00')
  const [durationMin, setDurationMin] = useState(120)
  const [teamNote, setTeamNote] = useState('')
  const [materialNote, setMaterialNote] = useState('')
  // F14: dịch vụ tiêm: vùng tiêm, lượng tiêm (bước 0,1cc), điều dưỡng phụ.
  const [injectionArea, setInjectionArea] = useState('')
  const [volumeCc, setVolumeCc] = useState('')
  const [nurseId, setNurseId] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    void (async () => {
      const [{ fetchCustomers, fetchRooms }] = [await import('../lib/api')]
      const cs = await fetchCustomers({ limit: 300 }).catch(() => ({ items: [] as never[] }))
      // Chỉ khách ĐÃ CHỐT trở đi mới xếp mổ được — backend cũng chặn, nhưng lọc
      // sẵn ở đây để nhân viên không chọn nhầm rồi mới bị báo lỗi.
      setCustomers(
        cs.items
          .filter((c) => ['CHOT', 'PT', 'HAUPHAU', 'TAIMUA', 'LICH_COC', 'DEN_CO_SO', 'LAM_DICH_VU', 'QUAY_LAI'].includes(c.stage))
          .map((c) => ({ id: c.id, name: c.name, code: c.code, stage: c.stage }))
      )
      setRooms((await fetchRooms().catch(() => [])).filter((r) => r.type === 'OPERATING' || r.type === 'MINOR_OP'))
    })()
    fetchServices().then(setServices).catch(() => undefined)
    fetchStaff().then(setStaff).catch(() => undefined)
  }, [])

  const pickService = (id: string): void => {
    setServiceId(id)
    const svc = services.find((s) => s.id === id)
    if (svc) {
      setTitle(svc.name)
      setDurationMin(svc.durationMin || 120)
      if (svc.anesthesia) setAnesthesia(svc.anesthesia)
    }
  }

  const submit = async (): Promise<void> => {
    if (!customerId || !title) {
      fail('Chọn khách và nhập tên thủ thuật.')
      return
    }
    setSaving(true)
    try {
      const { createProcedure } = await import('../lib/api')
      await createProcedure({
        customerId,
        serviceId: serviceId || undefined,
        title,
        surgeonId: surgeonId || undefined,
        roomId: roomId || undefined,
        anesthesia,
        scheduledAt: new Date(`${date}T${time}`).toISOString(),
        durationMin,
        teamNote: teamNote || undefined,
        materialNote: materialNote || undefined,
        injectionArea: injectionArea || undefined,
        volumeCc: volumeCc ? Number(volumeCc.replace(',', '.')) : undefined,
        nurseId: nurseId || undefined
      })
      say('Đã xếp ca mổ. Ca chỉ xác nhận được khi checklist tiền phẫu đủ 7/7.')
      onDone()
    } catch (err) {
      fail(getApiErrorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  const doctors = staff.filter((s) => s.roles.some((r) => r.code === 'BAC_SI'))

  return (
    <Modal
      title="Xếp ca mổ"
      onClose={onClose}
      width={640}
      footer={
        <>
          <button className="btn sec" onClick={onClose}>
            Huỷ
          </button>
          <button className="btn" onClick={() => void submit()} disabled={saving}>
            {saving ? 'Đang lưu…' : 'Xếp ca'}
          </button>
        </>
      }
    >
      <div className="alert wr">
        Chỉ xếp được cho khách đã có hợp đồng hiệu lực. Hệ thống tự chèn 30 phút dọn phòng giữa hai ca.
      </div>
      <div className="field">
        <label>Khách hàng *</label>
        <select className="input" value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
          <option value="">— Chọn khách đã chốt —</option>
          {customers.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name} ({c.code})
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label>Dịch vụ</label>
        <select className="input" value={serviceId} onChange={(e) => pickService(e.target.value)}>
          <option value="">— Chọn dịch vụ —</option>
          {services.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label>Tên thủ thuật *</label>
        <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
      </div>
      <div className="row" style={{ gap: 10 }}>
        <div className="field" style={{ flex: 1 }}>
          <label>Bác sĩ chính</label>
          <select className="input" value={surgeonId} onChange={(e) => setSurgeonId(e.target.value)}>
            <option value="">— Chọn —</option>
            {doctors.map((d) => (
              <option key={d.id} value={d.id}>
                {d.title ? `${d.title} ` : ''}
                {d.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field" style={{ flex: 1 }}>
          <label>Phòng mổ</label>
          <select className="input" value={roomId} onChange={(e) => setRoomId(e.target.value)}>
            <option value="">— Chọn —</option>
            {rooms.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="row" style={{ gap: 10 }}>
        <div className="field" style={{ flex: 1 }}>
          <label>Ngày</label>
          <input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        <div className="field" style={{ flex: 1 }}>
          <label>Giờ bắt đầu</label>
          <input className="input" type="time" value={time} onChange={(e) => setTime(e.target.value)} />
        </div>
        <div className="field" style={{ flex: 1 }}>
          <label>Thời lượng (phút)</label>
          <input
            className="input"
            type="number"
            value={durationMin}
            onChange={(e) => setDurationMin(Number(e.target.value))}
          />
        </div>
      </div>
      <div className="field">
        <label>Loại vô cảm</label>
        <select className="input" value={anesthesia} onChange={(e) => setAnesthesia(e.target.value)}>
          <option value="NONE">Không vô cảm</option>
          <option value="LOCAL">Tê tại chỗ</option>
          <option value="SEDATION">Tiền mê</option>
          <option value="GENERAL">Mê toàn thân</option>
        </select>
      </div>
      <div className="field">
        <label>Kíp mổ</label>
        <input className="input" value={teamNote} onChange={(e) => setTeamNote(e.target.value)} placeholder="BS chính · BS phụ · gây mê · điều dưỡng" />
      </div>
      <div className="field">
        <label>Vật tư dự trù</label>
        <input className="input" value={materialNote} onChange={(e) => setMaterialNote(e.target.value)} />
      </div>
      <div className="grid" style={{ gridTemplateColumns: '2fr 1fr 2fr', gap: 8 }}>
        <div className="field">
          <label>Vùng tiêm</label>
          <input className="input" value={injectionArea} onChange={(e) => setInjectionArea(e.target.value)} placeholder="Môi, cằm, rãnh cười" />
        </div>
        <div className="field">
          <label>Lượng tiêm (cc)</label>
          <input className="input" type="number" step={0.1} min={0} value={volumeCc} onChange={(e) => setVolumeCc(e.target.value)} placeholder="1,5" />
        </div>
        <div className="field">
          <label>Điều dưỡng</label>
          <select className="input" value={nurseId} onChange={(e) => setNurseId(e.target.value)}>
            <option value="">Không chọn</option>
            {staff
              .filter((s) => s.roles.some((r) => r.code === 'DIEU_DUONG'))
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
          </select>
        </div>
      </div>
    </Modal>
  )
}
