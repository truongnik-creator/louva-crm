import React, { useCallback, useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  addCustomerNote,
  assignCustomer,
  breakGlass,
  changeCustomerStage,
  createPayment,
  fetchConsents,
  fetchContracts,
  fetchCustomer,
  fetchCustomerTimeline,
  fetchInvoices,
  fetchMedicalRecord,
  fetchPhotoBlob,
  fetchPhotoSets,
  fetchStaff,
  getApiErrorMessage
} from '../lib/api'
import { useAuth } from '../lib/auth-context'
import { dateTimeVi, dateVi, relativeVi, vnd } from '../lib/format'
import {
  CONTRACT_STATUS,
  INVOICE_STATUS,
  PHOTO_STAGE_LABEL,
  STAGES,
  initialOf,
  stageStyle,
  tagStyleOf
} from '../lib/ui'
import { Empty, Modal, Row, Tag, useToast } from '../components/ui'
import {
  AddEntryModal,
  ConsentModal,
  DealModal,
  OpenRecordModal,
  PhotoUploadModal
} from '../components/clinical-forms'
import type {
  ConsentForm,
  Contract,
  CustomerDetail as CustomerDetailType,
  Invoice,
  MedicalRecord,
  PhotoSet,
  StaffUser,
  TimelineEntry
} from '../lib/types'

/* HỒ SƠ KHÁCH HÀNG THẨM MỸ — 8 tab đúng prototype:
   Tổng quan · Dòng thời gian · Nhu cầu & Phác đồ · Báo giá & Đơn hàng ·
   Hồ sơ y khoa · Ảnh trước-sau · Hậu phẫu · Tài chính.

   Ba tab y khoa đi qua cổng phân quyền riêng: không có quyền thì không gọi API,
   và nếu bệnh án ở cơ sở khác thì backend trả 404 — lúc đó mới mời break-glass. */

const TABS: Array<{ key: string; label: string; perm?: string }> = [
  { key: 'tq', label: 'Tổng quan' },
  { key: 'tl', label: 'Dòng thời gian' },
  { key: 'pd', label: 'Nhu cầu & Phác đồ' },
  { key: 'bg', label: 'Báo giá & Đơn hàng', perm: 'finance.read' },
  { key: 'yk', label: 'Hồ sơ y khoa', perm: 'medical.read' },
  { key: 'anh', label: 'Ảnh trước-sau', perm: 'photo.read' },
  { key: 'hp', label: 'Hậu phẫu', perm: 'followup.read' },
  { key: 'tc', label: 'Tài chính', perm: 'finance.read' }
]

export default function CustomerDetail(): React.JSX.Element {
  const { id = '' } = useParams()
  const { can } = useAuth()
  const { say, fail } = useToast()
  const navigate = useNavigate()

  const [customer, setCustomer] = useState<CustomerDetailType | null>(null)
  const [tab, setTab] = useState('tq')
  const [loading, setLoading] = useState(true)
  const [payFor, setPayFor] = useState<Invoice | null>(null)
  const [invoices, setInvoices] = useState<Invoice[]>([])

  const load = useCallback(async () => {
    try {
      setCustomer(await fetchCustomer(id))
    } catch (err) {
      fail(getApiErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }, [id, fail])

  useEffect(() => {
    void load()
  }, [load])

  const loadInvoices = useCallback(async () => {
    if (!can('finance.read')) return
    try {
      setInvoices(await fetchInvoices({ customerId: id }))
    } catch {
      // Không có quyền tài chính thì bỏ qua — tab đó cũng không hiện.
    }
  }, [id, can])

  useEffect(() => {
    void loadInvoices()
  }, [loadInvoices])

  const changeStage = useCallback(
    async (next: string) => {
      if (!customer) return
      const order = Object.keys(STAGES)
      const isBack = order.indexOf(next) < order.indexOf(customer.stage)
      let reason: string | undefined
      if (isBack) {
        reason = window.prompt('Lùi giai đoạn bắt buộc ghi lý do:') ?? undefined
        if (!reason) return
      }
      try {
        await changeCustomerStage(customer.id, next, reason)
        say('Đã chuyển giai đoạn.')
        void load()
      } catch (err) {
        fail(getApiErrorMessage(err))
      }
    },
    [customer, say, fail, load]
  )

  if (loading) return <div className="card"><Empty>Đang tải hồ sơ khách…</Empty></div>
  if (!customer) return <div className="card"><Empty>Không tìm thấy hồ sơ khách này.</Empty></div>

  const visibleTabs = TABS.filter((t) => !t.perm || can(t.perm))
  const age = customer.dob
    ? Math.floor((Date.now() - new Date(customer.dob).getTime()) / (365.25 * 86400000))
    : null
  const unpaid = invoices.filter((i) => i.remaining > 0)

  return (
    <>
      {/* Đầu trang */}
      <div className="card" style={{ marginBottom: 12 }}>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <div className="pava" style={{ width: 46, height: 46, flex: '0 0 46px', fontSize: 18 }}>
            {initialOf(customer.name)}
          </div>
          <div>
            <div style={{ fontSize: 17, fontWeight: 700 }}>
              {customer.name}{' '}
              <span className="muted" style={{ fontWeight: 400, fontSize: 13 }}>
                {age ? `· ${age} tuổi ` : ''}
                {customer.gender === 'FEMALE' ? '· Nữ' : customer.gender === 'MALE' ? '· Nam' : ''}
              </span>
            </div>
            <div className="muted" style={{ fontSize: 12.5 }}>
              {customer.phone ?? '—'} · {customer.city ?? '—'} · Mã KH: {customer.code}
            </div>
            <div style={{ marginTop: 6 }}>
              <Tag style={stageStyle(customer.stage)} />{' '}
              <span className="tag out">Nguồn: {customer.channel?.name ?? 'Không rõ'}</span>{' '}
              {customer.tags.map((t) => (
                <span key={t.id} className="tag" style={{ background: `${t.color}22`, color: t.color }}>
                  {t.name}
                </span>
              ))}
              {customer.branches.length > 1 ? (
                <span className="tag" style={{ background: '#E0F2FE', color: '#0369A1', marginLeft: 4 }}>
                  Khách liên cơ sở
                </span>
              ) : null}
            </div>
          </div>

          <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {can('inbox.read') ? (
              <button className="btn sec sm" onClick={() => navigate('/hop-thu')}>
                Nhắn Zalo
              </button>
            ) : null}
            {can('appointment.create') ? (
              <button className="btn sec sm" onClick={() => navigate(`/lich-hen?customerId=${customer.id}`)}>
                Đặt lịch
              </button>
            ) : null}
            {can('customer.update') ? (
              <select
                className="input"
                style={{ width: 'auto' }}
                value={customer.stage}
                onChange={(e) => void changeStage(e.target.value)}
              >
                {Object.entries(STAGES).map(([key, s]) => (
                  <option key={key} value={key}>
                    {s.t}
                  </option>
                ))}
              </select>
            ) : null}
            {can('finance.create') && unpaid.length ? (
              <button className="btn sm" onClick={() => setPayFor(unpaid[0])}>
                Thu tiền
              </button>
            ) : null}
          </div>
        </div>

        <div className="grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)', marginTop: 12 }}>
          <Mini label="Tổng đã chi tiêu" value={vnd(customer.totalPaid)} />
          <Mini
            label="Công nợ"
            value={
              customer.debt > 0 ? <span style={{ color: 'var(--danger)' }}>{vnd(customer.debt)}</span> : '0đ'
            }
          />
          <Mini label="Tư vấn viên" value={customer.assignedTo?.name ?? '— chưa gán —'} />
          <Mini label="Lần chạm gần nhất" value={relativeVi(customer.lastContactAt)} />
        </div>
      </div>

      <div className="tabs">
        {visibleTabs.map((t) => (
          <button key={t.key} className={tab === t.key ? 'on' : ''} onClick={() => setTab(t.key)}>
            {t.label}
          </button>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 420 }}>
          {tab === 'tq' ? <OverviewTab customer={customer} onReload={load} /> : null}
          {tab === 'tl' ? <TimelineTab customerId={customer.id} /> : null}
          {tab === 'pd' ? <NeedsTab customer={customer} /> : null}
          {tab === 'bg' ? <ContractsTab customerId={customer.id} /> : null}
          {tab === 'yk' ? <MedicalTab customer={customer} /> : null}
          {tab === 'anh' ? <PhotosTab customerId={customer.id} /> : null}
          {tab === 'hp' ? <PostOpTab customer={customer} /> : null}
          {tab === 'tc' ? (
            <FinanceTab invoices={invoices} onCollect={(inv) => setPayFor(inv)} />
          ) : null}
        </div>

        <div style={{ width: 290, flex: '0 0 290px', display: 'grid', gap: 12 }}>
          <TodoCard customer={customer} invoices={invoices} />
          <NoteCard customerId={customer.id} onSaved={load} />
        </div>
      </div>

      {payFor ? (
        <CollectModal
          invoice={payFor}
          customerId={customer.id}
          onClose={() => setPayFor(null)}
          onDone={() => {
            setPayFor(null)
            void load()
            void loadInvoices()
          }}
        />
      ) : null}
    </>
  )
}

function Mini({ label, value }: { label: string; value: React.ReactNode }): React.JSX.Element {
  return (
    <div>
      <div className="lab" style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase' }}>
        {label}
      </div>
      <div style={{ fontWeight: 700, marginTop: 3 }}>{value}</div>
    </div>
  )
}

/* ------------------------------------------------------------------ TAB 1 */

function OverviewTab({
  customer,
  onReload
}: {
  customer: CustomerDetailType
  onReload: () => void
}): React.JSX.Element {
  const { can } = useAuth()
  const { say, fail } = useToast()
  const [staff, setStaff] = useState<StaffUser[]>([])
  const [assigning, setAssigning] = useState(false)

  useEffect(() => {
    if (can('hr.read')) fetchStaff().then(setStaff).catch(() => undefined)
  }, [can])

  const reassign = async (assignedToId: string): Promise<void> => {
    const reason = window.prompt('Lý do đổi người phụ trách (bắt buộc):')
    if (!reason) return
    setAssigning(true)
    try {
      await assignCustomer(customer.id, { assignedToId: assignedToId || null, reason })
      say('Đã đổi người phụ trách.')
      onReload()
    } catch (err) {
      fail(getApiErrorMessage(err))
    } finally {
      setAssigning(false)
    }
  }

  return (
    <div className="card">
      <div className="sec-title">Tổng quan</div>
      <table>
        <tbody>
          <Row label="Họ tên" value={customer.name} />
          <Row label="Ngày sinh" value={dateVi(customer.dob)} />
          <Row label="Số điện thoại / Zalo" value={customer.phone ?? '—'} />
          <Row label="Địa chỉ" value={customer.address ?? '—'} />
          <Row
            label="Dịch vụ quan tâm"
            value={
              customer.interest.length
                ? customer.interest.map((d) => (
                    <span
                      key={d}
                      className="tag"
                      style={{ background: 'var(--green-50)', color: 'var(--green-700)', marginRight: 4 }}
                    >
                      {d}
                    </span>
                  ))
                : '—'
            }
          />
          <Row label="Giai đoạn phễu" value={<Tag style={stageStyle(customer.stage)} />} />
          <Row
            label="Nguồn khách"
            value={`${customer.channel?.name ?? 'Không rõ'}${customer.campaign ? ` — chiến dịch "${customer.campaign.name}"` : ''}`}
          />
          <Row
            label="Tư vấn viên / Telesale"
            value={
              can('customer.update') && staff.length ? (
                <select
                  className="input"
                  style={{ width: 240 }}
                  value={customer.assignedTo?.id ?? ''}
                  disabled={assigning}
                  onChange={(e) => void reassign(e.target.value)}
                >
                  <option value="">— Chưa phân công —</option>
                  {staff.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              ) : (
                `${customer.assignedTo?.name ?? '—'} / ${customer.telesale?.name ?? '—'}`
              )
            }
          />
          <Row label="Cơ sở đã phục vụ" value={customer.branches.map((b) => b.shortName ?? b.name).join(' · ')} />
          <Row label="Ghi chú" value={customer.note ?? '—'} />
        </tbody>
      </table>
      <div className="muted" style={{ fontSize: 12, marginTop: 10 }}>
        Không xoá được khách. Chỉ quản lý cơ sở hoặc chủ đầu tư được ẩn hồ sơ, và bắt buộc ghi lý do.
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ TAB 2 */

function TimelineTab({ customerId }: { customerId: string }): React.JSX.Element {
  const { fail } = useToast()
  const [entries, setEntries] = useState<TimelineEntry[] | null>(null)

  useEffect(() => {
    fetchCustomerTimeline(customerId)
      .then(setEntries)
      .catch((err) => fail(getApiErrorMessage(err)))
  }, [customerId, fail])

  if (!entries) return <div className="card"><Empty>Đang tải dòng thời gian…</Empty></div>

  return (
    <div className="card">
      <div className="sec-title">Dòng thời gian</div>
      {entries.length === 0 ? (
        <Empty>Chưa có hoạt động nào được ghi nhận.</Empty>
      ) : (
        entries.map((e, i) => (
          <div
            key={i}
            style={{ padding: '8px 0', borderBottom: '1px dashed var(--border)', fontSize: 12.8 }}
          >
            <span className="muted">{dateTimeVi(e.at)}</span> · {e.text}
            {e.by ? <span className="muted"> — {e.by}</span> : null}
          </div>
        ))
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ TAB 3 */

function NeedsTab({ customer }: { customer: CustomerDetailType }): React.JSX.Element {
  return (
    <div className="card">
      <div className="sec-title">Nhu cầu &amp; Phác đồ</div>
      <table>
        <tbody>
          <Row label="Dịch vụ quan tâm" value={customer.interest.join(' · ') || '—'} />
          <Row label="Ngân sách dự kiến" value={customer.budgetNote ?? '—'} />
          <Row label="Mong muốn của khách" value={customer.note ?? '—'} />
          <Row label="Giai đoạn phễu" value={<Tag style={stageStyle(customer.stage)} />} />
        </tbody>
      </table>
      <div className="muted" style={{ fontSize: 12, marginTop: 10 }}>
        Phác đồ chi tiết (phương pháp chỉ định, thời gian nghỉ dưỡng, chống chỉ định) nằm trong tab
        Hồ sơ y khoa và chỉ bác sĩ, điều dưỡng mới ghi được.
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ TAB 4 */

function ContractsTab({ customerId }: { customerId: string }): React.JSX.Element {
  const { fail } = useToast()
  const { can } = useAuth()
  const [contracts, setContracts] = useState<Contract[] | null>(null)
  const [deal, setDeal] = useState<'quotation' | 'contract' | null>(null)

  const load = useCallback(() => {
    fetchContracts({ customerId })
      .then(setContracts)
      .catch((err) => fail(getApiErrorMessage(err)))
  }, [customerId, fail])

  useEffect(() => {
    load()
  }, [load])

  if (!contracts) return <div className="card"><Empty>Đang tải…</Empty></div>

  return (
    <>
    {can('sales_order.create') || can('finance.create') ? (
      <div className="row" style={{ marginBottom: 12 }}>
        {can('sales_order.create') ? (
          <button className="btn sec sm" onClick={() => setDeal('quotation')}>
            + Lập báo giá
          </button>
        ) : null}
        {can('finance.create') ? (
          <button className="btn sm" onClick={() => setDeal('contract')}>
            + Tạo hợp đồng
          </button>
        ) : null}
      </div>
    ) : null}
    <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
      <div className="sec-title" style={{ padding: '12px 14px 0' }}>
        Báo giá &amp; Đơn hàng
      </div>
      {contracts.length === 0 ? (
        <Empty>Khách chưa có hợp đồng nào.</Empty>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Mã</th>
              <th>Nội dung</th>
              <th>Giá trị</th>
              <th>Đã thu</th>
              <th>Trạng thái</th>
            </tr>
          </thead>
          <tbody>
            {contracts.map((c) => (
              <tr key={c.id}>
                <td className="muted">{c.code}</td>
                <td>{c.items.map((i) => i.name).join(', ')}</td>
                <td>{vnd(c.total)}</td>
                <td>
                  {vnd(c.paidAmount)}
                  {c.remaining > 0 ? (
                    <span className="muted"> · còn {vnd(c.remaining)}</span>
                  ) : null}
                </td>
                <td>
                  <Tag style={tagStyleOf(CONTRACT_STATUS, c.status)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
    {deal ? (
      <DealModal
        customerId={customerId}
        mode={deal}
        onClose={() => setDeal(null)}
        onDone={() => {
          setDeal(null)
          load()
        }}
      />
    ) : null}
    </>
  )
}

/* ------------------------------------------------------------------ TAB 5 */

function MedicalTab({ customer }: { customer: CustomerDetailType }): React.JSX.Element {
  const { say, fail } = useToast()
  const [record, setRecord] = useState<MedicalRecord | null>(null)
  const [consents, setConsents] = useState<ConsentForm[]>([])
  const [notFound, setNotFound] = useState(false)
  const [loading, setLoading] = useState(true)
  const [opening, setOpening] = useState(false)
  const [addingEntry, setAddingEntry] = useState(false)
  const [addingConsent, setAddingConsent] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setNotFound(false)
    try {
      const [rec, forms] = await Promise.all([
        fetchMedicalRecord(customer.id),
        fetchConsents(customer.id).catch(() => [])
      ])
      setRecord(rec)
      setConsents(forms)
    } catch (err) {
      // 404 ở đây có hai nghĩa: chưa có bệnh án, hoặc bệnh án nằm ở cơ sở khác
      // và đang bị cách ly. Cả hai đều xử lý bằng cùng một màn hình.
      setNotFound(true)
    } finally {
      setLoading(false)
    }
  }, [customer.id])

  useEffect(() => {
    void load()
  }, [load])

  const requestBreakGlass = async (): Promise<void> => {
    const reason = window.prompt(
      'Truy cập bệnh án ngoài phạm vi cần lý do rõ ràng (tối thiểu 10 ký tự).\nHành động này được ghi log mức CRITICAL và thông báo ngay cho Giám đốc chuyên môn.'
    )
    if (!reason || reason.length < 10) return
    try {
      const grant = await breakGlass(customer.id, reason)
      say(`Đã mở quyền khẩn cấp trong ${grant.minutes} phút. Mọi thao tác đều được ghi vết.`)
      void load()
    } catch (err) {
      fail(getApiErrorMessage(err))
    }
  }

  const { can } = useAuth()

  if (loading) return <div className="card"><Empty>Đang tải hồ sơ y khoa…</Empty></div>

  if (notFound || !record) {
    return (
      <div className="card">
        <Empty>
          Không có bệnh án của khách này tại cơ sở bạn đang làm việc.
          <br />
          <span className="muted">
            Bệnh án bị cách ly theo cơ sở — bệnh án ở cơ sở khác không hiện ở đây.
          </span>
          <div className="row" style={{ justifyContent: 'center', marginTop: 14 }}>
            {can('medical.create') ? (
              <button className="btn sm" onClick={() => setOpening(true)}>
                Mở bệnh án tại cơ sở này
              </button>
            ) : null}
            {can('medical.break_glass') ? (
              <button className="btn sec sm" onClick={() => void requestBreakGlass()}>
                Truy cập khẩn cấp (break-glass)
              </button>
            ) : null}
          </div>
        </Empty>
        {opening ? (
          <OpenRecordModal
            customerId={customer.id}
            onClose={() => setOpening(false)}
            onDone={() => {
              setOpening(false)
              void load()
            }}
          />
        ) : null}
      </div>
    )
  }

  return (
    <>
      <div className="card" style={{ marginBottom: 12 }}>
        <div className="sec-title">Hồ sơ y khoa · {record.code}</div>
        {record.restricted ? (
          <div className="alert wr">
            Vai trò của bạn chỉ xem được phần liên quan tư vấn bán hàng: dị ứng và chống chỉ định.
            Chẩn đoán, phiếu mổ và phiếu gây mê không hiển thị.
          </div>
        ) : null}
        {record.contraindications.some((c) => c.blocking) ? (
          <div className="alert dg">
            Có chống chỉ định CHẶN ca mổ — không xác nhận được lịch mổ cho tới khi xử lý.
          </div>
        ) : null}

        <table>
          <tbody>
            <Row label="Nhóm máu" value={record.bloodType ?? '—'} />
            <Row
              label="Dị ứng"
              value={
                record.allergies.length
                  ? record.allergies.map((a) => `${a.substance}${a.reaction ? ` (${a.reaction})` : ''}`).join(', ')
                  : 'Không ghi nhận'
              }
            />
            <Row
              label="Chống chỉ định"
              value={
                record.contraindications.length
                  ? record.contraindications.map((c) => c.content).join('; ')
                  : 'Không'
              }
            />
            <Row label="Bệnh nền" value={record.chronicDisease ?? '—'} />
            <Row label="Thuốc đang dùng" value={record.currentMedication ?? '—'} />
            <Row label="Tiền sử PTTM" value={record.pastAesthetic ?? '—'} />
            <Row label="Hút thuốc" value={record.smoking ? 'Có' : 'Không'} />
            <Row label="Mang thai / cho con bú" value={record.pregnancyNote ?? '—'} />
            <Row label="Bác sĩ phụ trách" value={record.doctor?.name ?? '—'} />
          </tbody>
        </table>
      </div>

      {!record.restricted ? (
        <div className="card" style={{ marginBottom: 12 }}>
          <div className="row" style={{ marginBottom: 9 }}>
            <div className="sec-title" style={{ margin: 0 }}>
              Ghi chép khám
            </div>
            {can('medical.update') ? (
              <button className="btn sec sm" style={{ marginLeft: 'auto' }} onClick={() => setAddingEntry(true)}>
                + Ghi chép khám
              </button>
            ) : null}
          </div>
          {record.entries.length === 0 ? (
            <Empty>Chưa có ghi chép nào.</Empty>
          ) : null}
          {record.entries.map((e) => (
            <div key={e.id} style={{ padding: '8px 0', borderBottom: '1px dashed var(--border)', fontSize: 12.8 }}>
              <span className="muted">
                {dateTimeVi(e.createdAt)} · {e.kind}
              </span>
              <div>{e.content}</div>
              {e.authorName ? <span className="muted">— {e.authorName}</span> : null}
            </div>
          ))}
        </div>
      ) : null}

      <div className="card">
        <div className="row" style={{ marginBottom: 9 }}>
          <div className="sec-title" style={{ margin: 0 }}>
            Cam kết đã ký
          </div>
          {can('medical.create') ? (
            <button className="btn sec sm" style={{ marginLeft: 'auto' }} onClick={() => setAddingConsent(true)}>
              + Tạo cam kết
            </button>
          ) : null}
        </div>
        {consents.length === 0 ? (
          <Empty>Chưa có cam kết nào. Ca mổ không được xác nhận nếu thiếu cam kết đã ký.</Empty>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Loại</th>
                <th>Tiêu đề</th>
                <th>Trạng thái</th>
                <th>Ngày ký</th>
              </tr>
            </thead>
            <tbody>
              {consents.map((c) => (
                <tr key={c.id}>
                  <td className="muted">{c.type}</td>
                  <td>{c.title}</td>
                  <td>
                    {c.status === 'SIGNED' ? (
                      <span className="tag" style={{ background: '#DCFCE7', color: '#15803D' }}>
                        Đã ký
                      </span>
                    ) : (
                      <span className="tag out">{c.status}</span>
                    )}
                  </td>
                  <td>{dateVi(c.signedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {addingEntry ? (
        <AddEntryModal
          recordId={record.id}
          onClose={() => setAddingEntry(false)}
          onDone={() => {
            setAddingEntry(false)
            void load()
          }}
        />
      ) : null}
      {addingConsent ? (
        <ConsentModal
          customerId={customer.id}
          onClose={() => setAddingConsent(false)}
          onDone={() => {
            setAddingConsent(false)
            void load()
          }}
        />
      ) : null}
    </>
  )
}

/* ------------------------------------------------------------------ TAB 6 */

function PhotosTab({ customerId }: { customerId: string }): React.JSX.Element {
  const { can } = useAuth()
  const [sets, setSets] = useState<PhotoSet[] | null>(null)
  const [blocked, setBlocked] = useState(false)
  const [uploading, setUploading] = useState(false)

  const load = useCallback(() => {
    fetchPhotoSets(customerId)
      .then((r) => {
        setSets(r)
        setBlocked(false)
      })
      .catch(() => setBlocked(true))
  }, [customerId])

  useEffect(() => {
    load()
  }, [load])

  const uploadButton = can('photo.create') ? (
    <button className="btn sm" onClick={() => setUploading(true)}>
      + Thêm ảnh
    </button>
  ) : null

  const uploadModal = uploading ? (
    <PhotoUploadModal
      customerId={customerId}
      onClose={() => setUploading(false)}
      onDone={() => {
        setUploading(false)
        load()
      }}
    />
  ) : null

  if (blocked) {
    return (
      <div className="card">
        <Empty>
          Không có ảnh của khách này tại cơ sở bạn đang làm việc, hoặc bạn không đủ quyền xem.
          <div className="row" style={{ justifyContent: 'center', marginTop: 12 }}>{uploadButton}</div>
        </Empty>
        {uploadModal}
      </div>
    )
  }
  if (!sets) return <div className="card"><Empty>Đang tải ảnh…</Empty></div>
  if (sets.length === 0) {
    return (
      <div className="card">
        <Empty>
          Chưa có ảnh. Chụp ảnh hiện trạng trước khi phẫu thuật để so sánh về sau.
          <br />
          <span className="muted">Mốc chuẩn: trước mổ · N1 · N7 · T1 · T3 · T6</span>
          <div className="row" style={{ justifyContent: 'center', marginTop: 14 }}>{uploadButton}</div>
        </Empty>
        {uploadModal}
      </div>
    )
  }

  return (
    <>
      {uploadButton ? <div className="row" style={{ marginBottom: 12 }}>{uploadButton}</div> : null}
      {sets.map((set) => (
        <div className="card" key={set.id} style={{ marginBottom: 12 }}>
          <div className="row">
            <div className="sec-title" style={{ margin: 0 }}>
              {PHOTO_STAGE_LABEL[set.stage] ?? set.stage}
            </div>
            <span className="muted" style={{ fontSize: 12, marginLeft: 'auto' }}>
              {dateTimeVi(set.takenAt)}
              {set.takenBy ? ` · ${set.takenBy.name}` : ''}
            </span>
          </div>
          {set.note ? <div className="muted" style={{ fontSize: 12.5, marginBottom: 8 }}>{set.note}</div> : null}
          <div className="row" style={{ flexWrap: 'wrap' }}>
            {set.photos.map((p) => (
              <SecurePhoto key={p.id} photoId={p.id} fileName={p.fileName} />
            ))}
          </div>
        </div>
      ))}
      <div className="muted" style={{ fontSize: 12 }}>
        Ảnh được mã hoá khi lưu. Mỗi lần xem đều đi qua kiểm quyền và được ghi vào nhật ký truy cập.
      </div>
      {uploadModal}
    </>
  )
}

/** Ảnh không có URL tĩnh — phải tải qua API kèm token, nên dùng blob URL. */
function SecurePhoto({ photoId, fileName }: { photoId: string; fileName: string }): React.JSX.Element {
  const [url, setUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let objectUrl: string | null = null
    fetchPhotoBlob(photoId)
      .then((u) => {
        objectUrl = u
        setUrl(u)
      })
      .catch(() => setFailed(true))
    return () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [photoId])

  if (failed) {
    return (
      <div className="card" style={{ width: 150, height: 150, display: 'grid', placeItems: 'center' }}>
        <span className="muted" style={{ fontSize: 12 }}>
          Không tải được
        </span>
      </div>
    )
  }
  if (!url) {
    return (
      <div className="card" style={{ width: 150, height: 150, display: 'grid', placeItems: 'center' }}>
        <div className="spinner" />
      </div>
    )
  }
  return (
    <img
      src={url}
      alt={fileName}
      style={{ width: 150, height: 150, objectFit: 'cover', borderRadius: 8, border: '1px solid var(--border)' }}
    />
  )
}

/* ------------------------------------------------------------------ TAB 7 */

function PostOpTab({ customer }: { customer: CustomerDetailType }): React.JSX.Element {
  const isPostOp = ['PT', 'HAUPHAU'].includes(customer.stage)
  return (
    <div className="card">
      <div className="sec-title">Hậu phẫu</div>
      {isPostOp ? (
        <div className="alert ok">
          Khách đang trong giai đoạn hậu phẫu. Lịch tái khám N1 / N7 / T1 / T3 đã được sinh tự động khi
          kết thúc ca mổ — xem ở Lễ tân · Lịch hẹn.
        </div>
      ) : (
        <Empty>
          Khách chưa phẫu thuật. Lịch theo dõi hậu phẫu sẽ tự sinh sau khi bấm “Kết thúc mổ” ở màn Phòng
          mổ · Lịch mổ.
        </Empty>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ TAB 8 */

function FinanceTab({
  invoices,
  onCollect
}: {
  invoices: Invoice[]
  onCollect: (invoice: Invoice) => void
}): React.JSX.Element {
  const { can } = useAuth()

  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
      <div className="sec-title" style={{ padding: '12px 14px 0' }}>
        Tài chính · lịch thu
      </div>
      {invoices.length === 0 ? (
        <Empty>Khách chưa có đợt thu nào.</Empty>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Đợt</th>
              <th>Số tiền</th>
              <th>Đã thu</th>
              <th>Hạn</th>
              <th>Trạng thái</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {invoices.map((i) => (
              <tr key={i.id}>
                <td>{i.title ?? i.code}</td>
                <td>{vnd(i.amount)}</td>
                <td>{vnd(i.paidAmount)}</td>
                <td>
                  {dateVi(i.dueDate)}
                  {i.overdueDays > 0 ? (
                    <span className="down"> · quá {i.overdueDays} ngày</span>
                  ) : null}
                </td>
                <td>
                  <Tag style={tagStyleOf(INVOICE_STATUS, i.status)} />
                </td>
                <td>
                  {can('finance.create') && i.remaining > 0 ? (
                    <button className="btn sm" onClick={() => onCollect(i)}>
                      Thu
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

/* ------------------------------------------------------------ CỘT BÊN PHẢI */

function TodoCard({
  customer,
  invoices
}: {
  customer: CustomerDetailType
  invoices: Invoice[]
}): React.JSX.Element {
  const todos: Array<{ level: 'dg' | 'wr'; text: string }> = []

  const overdue = invoices.filter((i) => i.remaining > 0 && i.overdueDays > 0)
  const upcoming = invoices.filter((i) => i.remaining > 0 && i.overdueDays <= 0)

  for (const i of overdue) {
    todos.push({ level: 'dg', text: `Quá hạn ${i.overdueDays} ngày: thu ${vnd(i.remaining)} — ${i.title ?? i.code}` })
  }
  for (const i of upcoming) {
    todos.push({ level: 'wr', text: `Thu ${vnd(i.remaining)} — ${i.title ?? i.code}, hạn ${dateVi(i.dueDate)}` })
  }
  if (!customer.assignedTo) todos.push({ level: 'wr', text: 'Khách chưa có tư vấn viên phụ trách' })
  if (!customer.phone) todos.push({ level: 'wr', text: 'Khách chưa có số điện thoại' })

  return (
    <div className="card">
      <div className="sec-title">Việc cần làm với khách này</div>
      {todos.length === 0 ? (
        <div className="alert ok">Không có việc tồn đọng.</div>
      ) : (
        todos.map((t, i) => (
          <div key={i} className={`alert ${t.level}`}>
            {t.text}
          </div>
        ))
      )}
    </div>
  )
}

function NoteCard({
  customerId,
  onSaved
}: {
  customerId: string
  onSaved: () => void
}): React.JSX.Element {
  const { can } = useAuth()
  const { say, fail } = useToast()
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)

  if (!can('customer.update')) return <></>

  const submit = async (): Promise<void> => {
    if (!note.trim()) return
    setSaving(true)
    try {
      await addCustomerNote(customerId, note.trim())
      setNote('')
      say('Đã ghi nhận.')
      onSaved()
    } catch (err) {
      fail(getApiErrorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="card">
      <div className="sec-title">Ghi nhanh</div>
      <textarea
        className="input"
        rows={3}
        placeholder="Nội dung trao đổi với khách…"
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
      <button
        className="btn sm block"
        style={{ marginTop: 8 }}
        onClick={() => void submit()}
        disabled={saving || !note.trim()}
      >
        {saving ? 'Đang lưu…' : 'Lưu vào dòng thời gian'}
      </button>
    </div>
  )
}

function CollectModal({
  invoice,
  customerId,
  onClose,
  onDone
}: {
  invoice: Invoice
  customerId: string
  onClose: () => void
  onDone: () => void
}): React.JSX.Element {
  const { say, fail } = useToast()
  const [amount, setAmount] = useState(invoice.remaining)
  const [method, setMethod] = useState('CASH')
  const [reference, setReference] = useState('')
  const [saving, setSaving] = useState(false)

  const submit = async (): Promise<void> => {
    setSaving(true)
    try {
      const payment = await createPayment({
        customerId,
        invoiceId: invoice.id,
        amount,
        method,
        reference: reference || undefined
      })
      say(`Đã lập phiếu thu ${payment.code} — ${vnd(amount)}.`)
      onDone()
    } catch (err) {
      fail(getApiErrorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      title={`Thu tiền — ${invoice.title ?? invoice.code}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn sec" onClick={onClose}>
            Huỷ
          </button>
          <button className="btn" onClick={() => void submit()} disabled={saving || amount <= 0}>
            {saving ? 'Đang lưu…' : 'Lập phiếu thu'}
          </button>
        </>
      }
    >
      <div className="alert wr">
        Còn phải thu: <b>{vnd(invoice.remaining)}</b> trên tổng {vnd(invoice.amount)}
      </div>
      <div className="field">
        <label>Số tiền thu (đồng)</label>
        <input
          className="input"
          type="number"
          value={amount}
          max={invoice.remaining}
          onChange={(e) => setAmount(Number(e.target.value))}
        />
      </div>
      <div className="field">
        <label>Hình thức</label>
        <select className="input" value={method} onChange={(e) => setMethod(e.target.value)}>
          <option value="CASH">Tiền mặt</option>
          <option value="BANK_TRANSFER">Chuyển khoản</option>
          <option value="CARD">Thẻ</option>
          <option value="QR">QR</option>
        </select>
      </div>
      <div className="field">
        <label>Mã giao dịch / ghi chú</label>
        <input className="input" value={reference} onChange={(e) => setReference(e.target.value)} />
      </div>
    </Modal>
  )
}
