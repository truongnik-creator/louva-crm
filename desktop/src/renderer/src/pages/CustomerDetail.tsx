import React, { useCallback, useEffect, useState } from 'react'
import CustomerGrowthTab from '../components/CustomerGrowthTab'
import { useNavigate, useParams } from 'react-router-dom'
import {
  addCustomerNote,
  assignCustomer,
  breakGlass,
  createPayment,
  fetchConsents,
  fetchContracts,
  fetchCustomer,
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
  initialOf,
  stageStyle,
  tagStyleOf
} from '../lib/ui'
import { useOpenDeposit } from '../components/deposit-parts'
import { Customer360Header, JourneyStrip, QuoteOptionsPanel, UpsellPanel } from '../components/crm360-parts'
import { NeedsCard, OpportunitiesCard, PackagesCard, QuotesCard, TimelineCard } from '../components/crm360b-parts'
import { fetchCustomer360, fetchCustomerAftercare, type Customer360 } from '../lib/api-lo7'
import type { AftercareTask } from '../lib/api-lo4'
import { Empty, Modal, Row, Tag, useToast } from '../components/ui'
import { StageSelect } from '../components/stage-parts'
import { useClinic } from '../lib/clinic-context'
import { fetchStageHistory, setAiConsent, setPhotoMarketingConsent, type StageHistoryRow } from '../lib/api-nova'
import { setCustomerOptOut } from '../lib/api-lo4'
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
  StaffUser
} from '../lib/types'

/* HỒ SƠ KHÁCH HÀNG (Lô 7 · C1, C2, J1): thanh 360 ghim đầu hồ sơ (bước + số
   ngày, chi trọn đời, số lần, báo giá mở, hạn tái tiêm, voucher, công nợ, cờ y
   khoa, dải hành trình), rồi 5 tab:
   Tổng quan 360 · Hành trình · Tư vấn và báo giá · Y khoa và ảnh · Tài chính và quyền lợi.

   Phần y khoa đi qua cổng phân quyền riêng: không có quyền thì không gọi API,
   và nếu bệnh án ở cơ sở khác thì backend trả 404, lúc đó mới mời break-glass. */

const TABS: Array<{ key: string; label: string; anyPerm?: string[] }> = [
  { key: 'tq', label: 'Tổng quan 360' },
  { key: 'ht', label: 'Hành trình' },
  { key: 'tv', label: 'Tư vấn và báo giá' },
  { key: 'yk', label: 'Y khoa và ảnh', anyPerm: ['medical.read', 'photo.read', 'followup.read'] },
  { key: 'tc', label: 'Tài chính và quyền lợi', anyPerm: ['finance.read', 'customer.read'] }
]

export default function CustomerDetail(): React.JSX.Element {
  const { id = '' } = useParams()
  const { can } = useAuth()
  const { fail } = useToast()
  const navigate = useNavigate()

  const [customer, setCustomer] = useState<CustomerDetailType | null>(null)
  const [c360, setC360] = useState<Customer360 | null>(null)
  const [tab, setTab] = useState('tq')
  const [loading, setLoading] = useState(true)
  const [payFor, setPayFor] = useState<Invoice | null>(null)
  const [invoices, setInvoices] = useState<Invoice[]>([])

  const load = useCallback(async () => {
    try {
      setCustomer(await fetchCustomer(id))
      fetchCustomer360(id).then(setC360).catch(() => setC360(null))
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

  if (loading) return <div className="card"><Empty>Đang tải hồ sơ khách…</Empty></div>
  if (!customer) return <div className="card"><Empty>Không tìm thấy hồ sơ khách này.</Empty></div>

  const visibleTabs = TABS.filter((t) => !t.anyPerm || t.anyPerm.some((p) => can(p)))
  const unpaid = invoices.filter((i) => i.remaining > 0)

  const actions = (
    <>
      {can('inbox.read') ? (
        <button className="btn sec sm" onClick={() => navigate('/hop-thu')}>
          Nhắn tin
        </button>
      ) : null}
      {can('appointment.create') ? (
        <button className="btn sec sm" onClick={() => navigate(`/lich-hen?customerId=${customer.id}`)}>
          Đặt lịch
        </button>
      ) : null}
      {can('customer.update') ? (
        <StageSelect customerId={customer.id} customerName={customer.name} stage={customer.stage} onChanged={() => void load()} />
      ) : null}
      {can('finance.create') && unpaid.length ? (
        <button className="btn sm" onClick={() => setPayFor(unpaid[0])}>
          Thu tiền
        </button>
      ) : null}
    </>
  )

  return (
    <>
      {c360 ? (
        <Customer360Header data={c360} actions={actions} phone={customer.phone} />
      ) : (
        <div className="card" style={{ marginBottom: 12 }}>
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <div className="pava" style={{ width: 46, height: 46, flex: '0 0 46px', fontSize: 18 }}>
              {initialOf(customer.name)}
            </div>
            <div>
              <div style={{ fontSize: 17, fontWeight: 700 }}>{customer.name}</div>
              <div className="muted" style={{ fontSize: 12.5 }}>
                {customer.phone ?? '—'} · Mã KH: {customer.code}
              </div>
            </div>
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, flexWrap: 'wrap' }}>{actions}</div>
          </div>
        </div>
      )}

      <div className="tabs">
        {visibleTabs.map((t) => (
          <button key={t.key} className={tab === t.key ? 'on' : ''} onClick={() => setTab(t.key)}>
            {t.label}
          </button>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 0, flexBasis: 420, display: 'grid', gap: 12 }}>
          {tab === 'tq' ? (
            <>
              <OverviewTab customer={customer} onReload={load} />
              <OpportunitiesCard customerId={customer.id} customerName={customer.name} onChanged={() => void load()} />
              <div className="card">
                <div className="sec-title">Gợi ý bán kèm</div>
                <UpsellPanel customerId={customer.id} context="CONSULT" />
              </div>
            </>
          ) : null}
          {tab === 'ht' ? (
            <>
              <JourneyCard data={c360} />
              <TimelineCard customerId={customer.id} />
            </>
          ) : null}
          {tab === 'tv' ? (
            <>
              <NeedsCard customerId={customer.id} />
              <NeedsTab customer={customer} />
              {can('sales_order.read') ? <QuotesCard customerId={customer.id} onChanged={() => void load()} /> : null}
              {can('sales_order.read') ? (
                <div className="card">
                  <div className="sec-title">Báo giá 3 phương án</div>
                  <QuoteOptionsPanel customerId={customer.id} customerName={customer.name} onChosen={() => void load()} />
                </div>
              ) : null}
              {can('finance.read') ? <ContractsTab customerId={customer.id} /> : null}
            </>
          ) : null}
          {tab === 'yk' ? (
            <>
              {can('medical.read') ? <MedicalTab customer={customer} /> : null}
              {can('photo.read') ? <PhotosTab customerId={customer.id} /> : null}
              {can('followup.read') ? <PostOpTab customer={customer} /> : null}
            </>
          ) : null}
          {tab === 'tc' ? (
            <>
              {can('finance.read') ? <FinanceTab invoices={invoices} onCollect={(inv) => setPayFor(inv)} /> : null}
              <PackagesCard customerId={customer.id} />
              {can('customer.read') ? <CustomerGrowthTab customerId={customer.id} /> : null}
            </>
          ) : null}
        </div>

        <div className="d-side" style={{ width: 290, flex: '0 0 290px', display: 'grid', gap: 12 }}>
          <TodoCard customer={customer} invoices={invoices} tasks={c360?.openTasks ?? null} />
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

/** Tab Hành trình: dải mốc kèm bảng chi tiết (ngày, khoảng cách với mốc trước). */
function JourneyCard({ data }: { data: Customer360 | null }): React.JSX.Element {
  if (!data) return <div className="card"><Empty>Đang tải hành trình…</Empty></div>
  return (
    <div className="card">
      <div className="sec-title">Hành trình khách</div>
      <JourneyStrip items={data.journey} />
      <table style={{ marginTop: 8 }}>
        <tbody>
          {data.journey.map((m, i) => (
            <tr key={i}>
              <td style={{ width: 110 }} className={m.future ? 't-warn' : 'muted'}>
                {dateVi(m.at)}
              </td>
              <td>
                <b>{m.label}</b>
                {m.detail ? <span className="muted"> · {m.detail}</span> : null}
                {m.future ? <span className="muted"> (sắp tới)</span> : null}
              </td>
              <td className="muted" style={{ width: 120, fontSize: 12 }}>
                {m.gapDays != null ? `+${m.gapDays} ngày sau mốc trước` : 'Mốc đầu'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
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

  const clinic = useClinic()
  const [savingConsent, setSavingConsent] = useState(false)
  const [history, setHistory] = useState<StageHistoryRow[]>([])

  useEffect(() => {
    fetchStageHistory(customer.id).then(setHistory).catch(() => setHistory([]))
  }, [customer.id, customer.stage])

  const toggleConsent = async (): Promise<void> => {
    const next = !customer.aiDataConsent
    if (next && !window.confirm('Xác nhận khách đã ký hoặc đồng ý điều khoản xử lý dữ liệu (có chuyển dữ liệu ra nước ngoài khi dùng AI)?')) return
    setSavingConsent(true)
    try {
      await setAiConsent(customer.id, next)
      say(next ? 'Đã ghi nhận khách đồng ý.' : 'Đã ghi nhận khách rút lại đồng ý.')
      onReload()
    } catch (err) {
      fail(getApiErrorMessage(err))
    } finally {
      setSavingConsent(false)
    }
  }

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
          <Row label="Bước bán hàng" value={<Tag style={clinic.stageStyle(customer.stage)} />} />
          <Row
            label="Đồng ý xử lý dữ liệu bằng AI"
            value={
              <span>
                {customer.aiDataConsent ? (
                  <span className="tag" style={{ background: '#DCFCE7', color: '#15803D' }}>Đã đồng ý</span>
                ) : (
                  <span className="tag" style={{ background: '#F1F5F9', color: '#475569' }}>Chưa đồng ý</span>
                )}
                {can('customer.update') ? (
                  <button className="btn sec sm" style={{ marginLeft: 8 }} disabled={savingConsent} onClick={() => void toggleConsent()}>
                    {customer.aiDataConsent ? 'Rút lại đồng ý' : 'Ghi nhận khách đã đồng ý'}
                  </button>
                ) : null}
                <div className="muted" style={{ fontSize: 11.5, marginTop: 3 }}>
                  Theo Nghị định 13/2023: chưa đồng ý thì tin nhắn của khách không được gửi lên AI. Mẫu điều khoản ở Cài đặt, Mẫu biểu.
                </div>
              </span>
            }
          />
          <Row
            label="Nhận tin gửi theo nhóm"
            value={
              <span>
                {customer.optOut ? (
                  <span className="tag" style={{ background: '#FEE2E2', color: '#B91C1C' }}>Khách từ chối nhận</span>
                ) : (
                  <span className="tag" style={{ background: '#DCFCE7', color: '#15803D' }}>Nhận tin</span>
                )}
                {can('customer.update') ? (
                  <button
                    className="btn sec sm"
                    style={{ marginLeft: 8 }}
                    onClick={async () => {
                      const reason = customer.optOut ? undefined : (window.prompt('Lý do khách từ chối nhận tin (không bắt buộc):') ?? undefined)
                      try {
                        await setCustomerOptOut(customer.id, !customer.optOut, reason || undefined)
                        say(customer.optOut ? 'Khách nhận tin lại.' : 'Đã ghi nhận khách từ chối nhận tin.')
                        onReload()
                      } catch (err) {
                        fail(getApiErrorMessage(err))
                      }
                    }}
                  >
                    {customer.optOut ? 'Cho nhận tin lại' : 'Khách từ chối nhận tin'}
                  </button>
                ) : null}
              </span>
            }
          />
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

      <div className="sec-title" style={{ marginTop: 14 }}>Lịch sử đổi bước</div>
      {history.length === 0 ? (
        <div className="muted" style={{ fontSize: 12.5 }}>Chưa có lần đổi bước nào được ghi.</div>
      ) : (
        <table>
          <tbody>
            {history.slice(0, 20).map((h) => (
              <tr key={h.id}>
                <td style={{ width: 130 }} className="muted">{dateTimeVi(h.createdAt)}</td>
                <td>
                  {h.fromStage ? <Tag style={clinic.stageStyle(h.fromStage)} /> : null} →{' '}
                  <Tag style={clinic.stageStyle(h.toStage)} />
                  {h.lostReason ? <span className="muted"> · {clinic.lostReasonLabel(h.lostReason)}</span> : null}
                </td>
                <td className="muted" style={{ fontSize: 12 }}>
                  {h.source === 'AUTO' ? 'Tự động' : h.source === 'IMPORT' ? 'Nhập file' : h.source === 'MIGRATION' ? 'Chuyển bộ bước' : (h.userName ?? 'Nhân viên')}
                  {h.note ? ` · ${h.note}` : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ TAB 3 */
/* Tab 2 (dòng thời gian) chuyển sang TimelineCard đa kênh, Lô 8 · C4. */

function NeedsTab({ customer }: { customer: CustomerDetailType }): React.JSX.Element {
  const clinic = useClinic()
  return (
    <div className="card">
      <div className="sec-title">Ghi chú nhu cầu &amp; Phác đồ</div>
      <table>
        <tbody>
          <Row label="Dịch vụ quan tâm" value={customer.interest.join(' · ') || '—'} />
          <Row label="Ngân sách dự kiến" value={customer.budgetNote ?? '—'} />
          <Row label="Mong muốn của khách" value={customer.note ?? '—'} />
          <Row label="Bước (cơ hội hiện tại)" value={<Tag style={clinic.stageStyle(customer.stage)} />} />
        </tbody>
      </table>
      <div className="muted" style={{ fontSize: 12, marginTop: 10 }}>
        Phiếu tư vấn và phác đồ lập ở màn Tư vấn; báo giá 3 phương án bên dưới tự lấy phác đồ gần nhất.
        Dị ứng, chống chỉ định nằm trong tab Y khoa và ảnh, chỉ bác sĩ, điều dưỡng mới ghi được.
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
            Chẩn đoán, bệnh nền, thuốc đang dùng, thai kỳ, phiếu mổ và phiếu gây mê không hiển thị.
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
            {!record.restricted ? <Row label="Bệnh nền" value={record.chronicDisease ?? '—'} /> : null}
            {!record.restricted ? (
              <Row label="Thuốc đang dùng" value={record.currentMedication ?? '—'} />
            ) : null}
            <Row label="Tiền sử PTTM" value={record.pastAesthetic ?? '—'} />
            <Row label="Hút thuốc" value={record.smoking ? 'Có' : 'Không'} />
            {!record.restricted ? (
              <Row label="Mang thai / cho con bú" value={record.pregnancyNote ?? '—'} />
            ) : null}
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
  const clinic = useClinic()
  const { say, fail } = useToast()
  const toggleMarketing = async (set: PhotoSet): Promise<void> => {
    const next = !set.consentForMarketing
    if (next && !window.confirm('Chỉ bật khi khách đã đồng ý bằng văn bản cho dùng ảnh làm truyền thông. Tiếp tục?')) return
    try {
      await setPhotoMarketingConsent(set.id, next)
      say(next ? 'Đã cho phép dùng bộ ảnh làm marketing.' : 'Đã tắt cho phép dùng ảnh làm marketing.')
      load()
    } catch (err) {
      fail(getApiErrorMessage(err))
    }
  }
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
          {clinic.isInjection
            ? 'Chưa có ảnh. Chụp ảnh D0 trước khi tiêm để so sánh về sau.'
            : 'Chưa có ảnh. Chụp ảnh hiện trạng trước khi phẫu thuật để so sánh về sau.'}
          <br />
          <span className="muted">
            {clinic.isInjection ? 'Mốc chuẩn: D0 · D7 · D30. Ảnh khách gửi qua chat tự lưu vào mục "Khách gửi qua chat".' : 'Mốc chuẩn: trước mổ · N1 · N7 · T1 · T3 · T6'}
          </span>
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
            {set.consentForMarketing ? (
              <span className="tag" style={{ background: '#DCFCE7', color: '#15803D', marginLeft: 6 }}>Được dùng marketing</span>
            ) : null}
            {can('photo.marketing_consent') ? (
              <button className="btn sec sm" style={{ marginLeft: 6 }} onClick={() => void toggleMarketing(set)}>
                {set.consentForMarketing ? 'Tắt marketing' : 'Cho dùng marketing'}
              </button>
            ) : null}
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

/** C2: chế độ tiêm hiện chăm sóc sau tiêm D0..D30 (việc F10 thật), chế độ phẫu thuật giữ hậu phẫu. */
function PostOpTab({ customer }: { customer: CustomerDetailType }): React.JSX.Element {
  const clinic = useClinic()
  const [tasks, setTasks] = useState<AftercareTask[] | null>(null)
  useEffect(() => {
    if (!clinic.isInjection) return
    fetchCustomerAftercare(customer.id)
      .then((r) => setTasks(r.items))
      .catch(() => setTasks([]))
  }, [customer.id, clinic.isInjection])

  if (clinic.isInjection) {
    const care = (tasks ?? []).filter((t) => t.kind === 'AFTERCARE' || t.kind === 'RETREAT')
    return (
      <div className="card">
        <div className="sec-title">Chăm sóc sau tiêm</div>
        {tasks === null ? (
          <div className="muted">Đang tải…</div>
        ) : care.length === 0 ? (
          <Empty>Khách chưa có mốc chăm sóc. Mốc D0 đến D30 tự sinh khi hoàn tất một lần thực hiện dịch vụ.</Empty>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table>
              <thead>
                <tr>
                  <th>Mốc</th>
                  <th>Dịch vụ</th>
                  <th>Hạn gọi</th>
                  <th>Trạng thái</th>
                  <th>Kết quả</th>
                </tr>
              </thead>
              <tbody>
                {care.map((t) => (
                  <tr key={t.id}>
                    <td>
                      <b>{t.kind === 'RETREAT' ? 'Tái tiêm' : (t.milestone ?? '—')}</b>
                    </td>
                    <td>{t.procedure?.service?.name ?? t.procedure?.title ?? t.title}</td>
                    <td className={t.overdue ? 't-over' : ''}>{dateVi(t.dueAt)}</td>
                    <td>
                      {t.status === 'DONE' ? (
                        <span className="hchip PAID">Đã liên hệ</span>
                      ) : t.overdue ? (
                        <span className="hchip HOT">Quá hạn</span>
                      ) : (
                        <span className="hchip NEUTRAL">Chờ liên hệ</span>
                      )}
                    </td>
                    <td className="muted" style={{ fontSize: 12 }}>
                      {t.resultNote ?? (t.contactedAt ? dateTimeVi(t.contactedAt) : '—')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
          Bấm “Đã liên hệ” và ghi kết quả ở màn Chăm sóc sau tiêm.
        </div>
      </div>
    )
  }

  const isPostOp = ['PT', 'HAUPHAU', 'LAM_DICH_VU', 'QUAY_LAI'].includes(customer.stage)
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
  invoices,
  tasks
}: {
  customer: CustomerDetailType
  invoices: Invoice[]
  /** Việc mở của khách (mọi người được giao), cùng nguồn với "việc kế tiếp" trên thanh 360. */
  tasks: Customer360['openTasks'] | null
}): React.JSX.Element {
  const todos: Array<{ level: 'dg' | 'wr' | 'info'; text: string }> = []

  for (const t of tasks ?? []) {
    const who = t.assignee ? ` · ${t.assignee.name}` : ' · chưa giao ai'
    todos.push({
      level: t.overdue ? 'dg' : 'info',
      text: `${t.overdue ? 'Quá hạn: ' : ''}${t.title}${t.dueAt ? `, hạn ${dateVi(t.dueAt)}` : ''}${who}`
    })
  }

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
  const [misa, setMisa] = useState('')
  const [saving, setSaving] = useState(false)
  const dep = useOpenDeposit(customerId, invoice.remaining, setAmount)

  const submit = async (): Promise<void> => {
    setSaving(true)
    try {
      const payment = await createPayment({
        customerId,
        invoiceId: invoice.id,
        amount,
        method,
        reference: reference || undefined,
        misaInvoiceNo: misa.trim() || undefined
      })
      say(
        `Đã lập phiếu thu ${payment.code}: ${vnd(amount)}${payment.depositApplied ? `, trừ cọc ${vnd(payment.depositApplied)}` : ''}.`
      )
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
          <button className="btn" onClick={() => void submit()} disabled={saving || (amount <= 0 && dep.usable <= 0)}>
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
          max={invoice.remaining - dep.usable}
          onChange={(e) => setAmount(Number(e.target.value))}
        />
        {dep.note}
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
      <div className="field">
        <label>Số hoá đơn MISA (nếu đã xuất)</label>
        <input className="input" value={misa} onChange={(e) => setMisa(e.target.value)} />
      </div>
    </Modal>
  )
}
