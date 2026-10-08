import React, { useCallback, useEffect, useState } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../lib/auth-context'
import { useClinic } from '../lib/clinic-context'
import { fetchConversations, fetchNotifications, markNotificationsRead } from '../lib/api'
import { fetchMyTaskCount } from '../lib/api-lo4'
import { onSocket } from '../lib/socket'
import ErrorBoundary from './ErrorBoundary'
import { useToast } from './ui'

/* Khung ứng dụng: thanh bên 7 nhóm module đúng biến MENU trong
   crm-app/docs/prototype_tmv.html, cộng thêm hai thứ prototype không có vì nó
   là bản tĩnh: lọc mục theo QUYỀN thật của người đăng nhập, và đổi cơ sở đang
   làm việc (mọi lệnh gọi API sau đó mang theo header X-Branch-Id). */

interface NavItem {
  id: string
  path: string
  ic: string
  t: string
  /** Quyền tối thiểu để thấy mục này. Bỏ trống = ai cũng thấy. */
  perm?: string
  /** Chưa dựng ở Giai đoạn 1 — hiện mờ, bấm vào ra trang "sắp có". */
  soon?: boolean
  /** F6: chỉ hiện khi phòng khám ở chế độ phẫu thuật. */
  surgeryOnly?: boolean
  /** F6: nhãn khi ở chế độ phòng khám tiêm. */
  injectionLabel?: string
}

interface NavGroup {
  group: string | null
  items: NavItem[]
}

export const MENU: NavGroup[] = [
  {
    group: null,
    items: [
      { id: 'dashboard', path: '/', ic: '▤', t: 'Tổng quan' },
      { id: 'viectoi', path: '/viec-cua-toi', ic: '✅', t: 'Việc của tôi hôm nay' },
      { id: 'doluong', path: '/do-luong', ic: '📐', t: 'Đo lường & Họp cuối ngày' },
      { id: 'tangtruong', path: '/tang-truong', ic: '🌱', t: 'Giới thiệu, voucher, thi đua' }
    ]
  },
  {
    group: 'Hành chính phòng khám',
    items: [
      { id: 'lichhen', path: '/lich-hen', ic: '📅', t: 'Lễ tân · Lịch hẹn', perm: 'appointment.read' },
      { id: 'daden', path: '/khach-da-den', ic: '🚶', t: 'Lễ tân · Khách đã đến', perm: 'visit.read' },
      { id: 'phanlich', path: '/phan-lich', ic: '🗓', t: 'Phân lịch làm việc', perm: 'shift.read' },
      { id: 'phongmo', path: '/phong-mo', ic: '🏥', t: 'Phòng mổ · Lịch mổ', perm: 'surgery_schedule.read', surgeryOnly: true },
      { id: 'kpidd', path: '/kpi-dieu-duong', ic: '📈', t: 'KPI điều dưỡng', perm: 'nursing_kpi.read' },
      { id: 'kpitv', path: '/kpi-tu-van', ic: '📊', t: 'KPI tư vấn viên', perm: 'hr.read' }
    ]
  },
  {
    group: 'Chuyên môn thẩm mỹ',
    items: [
      { id: 'tuvan', path: '/tu-van', ic: '💬', t: 'Tư vấn & Phác đồ', perm: 'consultation.read' },
      { id: 'chotquay', path: '/chot-tai-quay', ic: '🤝', t: 'Chốt tại quầy', perm: 'visit.read' },
      { id: 'hspt', path: '/ho-so-phau-thuat', ic: '📋', t: 'Hồ sơ phẫu thuật', perm: 'medical.read', surgeryOnly: true },
      { id: 'anh', path: '/anh-truoc-sau', ic: '🖼', t: 'Ảnh trước - sau', perm: 'photo.read' },
      { id: 'hauphau', path: '/hau-phau', ic: '🩺', t: 'Hậu phẫu & Tái khám', perm: 'followup.read', injectionLabel: 'Chăm sóc sau tiêm & Tái khám' },
      { id: 'case', path: '/thu-vien-case', ic: '📚', t: 'Thư viện case', perm: 'case_study.read' }
    ]
  },
  {
    group: 'Kinh doanh',
    items: [
      { id: 'zalo', path: '/hop-thu', ic: '✉', t: 'Hộp thư Zalo', perm: 'inbox.read', injectionLabel: 'Hộp thư' },
      { id: 'mautin', path: '/mau-tin-nhanh', ic: '⚡', t: 'Mẫu tin nhanh', perm: 'inbox.manage_templates' },
      { id: 'kichban', path: '/kich-ban-ban-hang', ic: '📘', t: 'Kịch bản bán hàng (AI)', perm: 'inbox.manage_scripts' },
      { id: 'chamhoithoai', path: '/cham-hoi-thoai', ic: '🎯', t: 'Chấm hội thoại (AI)', perm: 'inbox.manage_scripts' },
      { id: 'chamlai', path: '/cham-lai-khach', ic: '💌', t: 'Chăm lại khách im lặng (AI)', perm: 'inbox.reengage' },
      { id: 'guinhom', path: '/gui-tin-theo-nhom', ic: '📣', t: 'Nhóm khách & Gửi tin', perm: 'inbox.broadcast' },
      { id: 'uudai', path: '/uu-dai', ic: '🎁', t: 'Ưu đãi & Giảm giá', perm: 'sales_order.read' },
      { id: 'duyetgiam', path: '/duyet-giam-gia', ic: '✔', t: 'Duyệt giảm giá', perm: 'sales_order.approve_discount' },
      { id: 'bankem', path: '/goi-y-ban-kem', ic: '➕', t: 'Gợi ý bán kèm', perm: 'customer.read' },
      { id: 'khach', path: '/khach-hang', ic: '👤', t: 'Khách hàng', perm: 'customer.read' },
      { id: 'bangbuoc', path: '/bang-buoc-khach', ic: '🗂', t: 'Bảng bước khách', perm: 'customer.read' },
      { id: 'viecbuoc', path: '/viec-theo-buoc', ic: '☑', t: 'Việc theo bước', perm: 'customer.read' },
      { id: 'bccrm', path: '/bao-cao-crm-360', ic: '📈', t: 'Báo cáo CRM 360', perm: 'customer.read' },
      { id: 'nhapkhach', path: '/nhap-khach', ic: '📥', t: 'Nhập khách từ Excel', perm: 'customer.import' },
      { id: 'lead', path: '/lead', ic: '🎯', t: 'Lead & Chiến dịch', perm: 'lead.read' },
      { id: 'donhang', path: '/hop-dong', ic: '🧾', t: 'Đơn hàng · Hợp đồng', perm: 'finance.read' },
      { id: 'congno', path: '/cong-no', ic: '💰', t: 'Thanh toán & Công nợ', perm: 'finance.read' }
    ]
  },
  {
    group: 'Kho & vật tư',
    items: [
      { id: 'tonkho', path: '/ton-kho', ic: '📦', t: 'Tồn kho', perm: 'inventory.read' },
      { id: 'xuatnhap', path: '/xuat-nhap-kho', ic: '🔁', t: 'Xuất - Nhập kho', perm: 'inventory.read' },
      { id: 'truyvet', path: '/truy-vet-lo', ic: '🔎', t: 'Truy vết implant / lô', perm: 'inventory.read', surgeryOnly: true },
      { id: 'chuyenkho', path: '/chuyen-kho', ic: '🔀', t: 'Chuyển kho & Duyệt kho', perm: 'inventory.read' },
      { id: 'dinhmuc', path: '/dinh-muc-vat-tu', ic: '⚖️', t: 'Định mức vật tư', perm: 'inventory.read' },
      { id: 'bckho', path: '/bao-cao-kho', ic: '📊', t: 'Thẻ kho & Báo cáo', perm: 'inventory.read' },
      { id: 'ncc', path: '/nha-cung-cap', ic: '🚚', t: 'Nhà cung cấp', perm: 'inventory.read' }
    ]
  },
  {
    group: 'Nhân sự',
    items: [
      { id: 'hsnv', path: '/nhan-vien', ic: '🧑‍⚕️', t: 'Hồ sơ nhân viên', perm: 'hr.read' },
      { id: 'chamcong', path: '/cham-cong', ic: '⏱', t: 'Chấm công & Ca trực', perm: 'hr.read' },
      { id: 'luong', path: '/luong', ic: '💵', t: 'Lương & Hoa hồng', perm: 'hr.read' },
      { id: 'kyluong', path: '/ky-luong', ic: '🧮', t: 'Kỳ lương theo coaching', perm: 'hr.read' },
      { id: 'daotao', path: '/dao-tao', ic: '🎓', t: 'Đào tạo & Chứng chỉ', perm: 'hr.read', soon: true },
      // F36: media, mkt, design, content ghi báo cáo trên trang tính riêng;
      // màn này kéo về để theo dõi tiến độ mà không phải mở từng trang tính.
      { id: 'bccv', path: '/bao-cao-cong-viec', ic: '🗒', t: 'Báo cáo công việc (trang tính)', perm: 'work_report.read' }
    ]
  },
  {
    group: 'Kế toán & báo cáo',
    items: [
      { id: 'thuchi', path: '/bao-cao/doanh-thu', ic: '🏦', t: 'Doanh thu & Chi phí', perm: 'accounting.read' },
      { id: 'bcdv', path: '/bao-cao/van-hanh', ic: '📄', t: 'Báo cáo vận hành', perm: 'appointment.read' },
      { id: 'bcmkt', path: '/bao-cao/marketing', ic: '📢', t: 'Báo cáo marketing', perm: 'lead.read' },
      { id: 'xuatdl', path: '/xuat-du-lieu', ic: '⬇', t: 'Xuất dữ liệu', perm: 'report.export' }
    ]
  },
  {
    group: 'Cài đặt',
    items: [
      { id: 'banggia', path: '/dich-vu', ic: '🏷', t: 'Danh mục dịch vụ & Bảng giá', perm: 'service.read' },
      { id: 'phong', path: '/phong-thiet-bi', ic: '🚪', t: 'Phòng & Thiết bị', perm: 'settings.read' },
      { id: 'nguoidung', path: '/phan-quyen', ic: '🔐', t: 'Người dùng & Phân quyền', perm: 'settings.read' },
      { id: 'ketnoi', path: '/ket-noi-zalo', ic: '🔗', t: 'Kết nối Zalo / Tổng đài', perm: 'settings.read' },
      { id: 'maubieu', path: '/mau-bieu', ic: '🖨', t: 'Mẫu biểu & Cam kết', perm: 'settings.read' },
      { id: 'tacvu', path: '/nhat-ky-tac-vu', ic: '⏲', t: 'Nhật ký tác vụ & Tự động hoá', perm: 'settings.read' },
      { id: 'nhatky', path: '/nhat-ky', ic: '📜', t: 'Nhật ký hệ thống', perm: 'audit.read' },
      { id: 'caidat', path: '/cai-dat-he-thong', ic: '⚙️', t: 'Cài đặt hệ thống', perm: 'settings.read' }
    ]
  }
]

/** Phụ đề của từng màn — lấy từ biến SUB trong prototype. */
export const PAGE_SUBTITLE: Record<string, string> = {
  '/hop-thu': 'Toàn bộ hội thoại của phòng khám. Khách nhắn là hiện ngay, không cần bấm làm mới.',
  '/lich-hen': 'Đặt, dời, xác nhận lịch tư vấn và khám trong ngày.',
  '/khach-da-den': 'Hàng đợi thời gian thực — khách đã check-in đang chờ ai, chờ bao lâu.',
  '/khach-hang': 'Toàn bộ đời sống của khách tại phòng khám trong một trang.',
  '/bang-buoc-khach': 'Phễu khối, thẻ khách có số ngày ở bước, nhiệt độ, việc kế tiếp. Đỏ là quá hạn.',
  '/chot-tai-quay': 'Khách vừa check-in: thanh 360, phác đồ, case tương tự, bán kèm, ba phương án và nút chốt.',
  '/goi-y-ban-kem': 'Luật dịch vụ A gợi ý B, đo tỉ lệ khách nhận (không tính lương).',
  '/viec-theo-buoc': 'Checklist việc và mẫu tin của từng bước; cơ hội vào bước thì tự tạo việc cho sale.',
  '/bao-cao-crm-360': 'Hành trình theo bước, giá trị đơn trung bình (chỉ đo), dự báo pipeline từ dữ liệu thật, gói liệu trình.',
  '/phong-mo': 'Tài nguyên đắt nhất của phòng khám — chỉ ca đủ điều kiện tiền phẫu mới được xác nhận.',
  '/': 'Bức tranh kinh doanh một màn hình cho chủ đầu tư.'
}

function pageTitle(pathname: string, injection: boolean): string {
  // Các màn chi tiết phải khớp TRƯỚC vòng lặp: '/khach-hang/:id' cũng
  // startsWith('/khach-hang') nên nếu để sau sẽ không bao giờ tới lượt.
  if (pathname === '/khach-hang/trung-lap') return 'Gộp hồ sơ khách trùng'
  if (pathname.startsWith('/khach-hang/')) return 'Hồ sơ khách hàng thẩm mỹ'
  if (pathname === '/doi-mat-khau') return 'Đổi mật khẩu'

  for (const group of MENU) {
    for (const item of group.items) {
      if (item.path === '/' ? pathname === '/' : pathname.startsWith(item.path))
        return injection && item.injectionLabel ? item.injectionLabel : item.t
    }
  }
  return 'Màn hình'
}

export default function AppShell(): React.JSX.Element {
  const { user, can, logout, branchId, switchBranch } = useAuth()
  const clinic = useClinic()
  const navigate = useNavigate()
  const location = useLocation()
  const { say } = useToast()

  const [dark, setDark] = useState(false)
  const [unreadInbox, setUnreadInbox] = useState(0)
  const [notifCount, setNotifCount] = useState(0)
  const [taskCount, setTaskCount] = useState<{ today: number; overdue: number }>({ today: 0, overdue: 0 })
  const [now, setNow] = useState(new Date())
  // F28: menu dạng ngăn kéo trên điện thoại; đổi màn là tự đóng.
  const [navOpen, setNavOpen] = useState(false)
  useEffect(() => setNavOpen(false), [location.pathname])

  useEffect(() => {
    document.body.classList.toggle('dark', dark)
  }, [dark])

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 30_000)
    return () => window.clearInterval(timer)
  }, [])

  const loadBadges = useCallback(async () => {
    try {
      if (can('inbox.read')) {
        const convs = await fetchConversations({ unread: '1' })
        setUnreadInbox(convs.reduce((s, c) => s + c.unreadCount, 0))
      }
      const notif = await fetchNotifications()
      setNotifCount(notif.unread)
      // F27: huy hiệu số việc hôm nay trên menu.
      setTaskCount(await fetchMyTaskCount())
    } catch {
      // Số phù hiệu chỉ là thông tin phụ — hỏng thì bỏ qua, không chặn giao diện.
    }
  }, [can])

  useEffect(() => {
    void loadBadges()
  }, [loadBadges, branchId])

  // Tin mới đến thì phù hiệu phải nhảy ngay, đó là cả điểm của hộp thư tập trung.
  useEffect(() => {
    const off = onSocket('conversation:updated', () => void loadBadges())
    const offNotif = onSocket('notification:new', () => void loadBadges())
    const onTasks = (): void => void loadBadges()
    window.addEventListener('tasks:changed', onTasks)
    const timer = window.setInterval(() => void loadBadges(), 120_000)
    return () => {
      off()
      offNotif()
      window.removeEventListener('tasks:changed', onTasks)
      window.clearInterval(timer)
    }
  }, [loadBadges])

  const openNotifications = useCallback(async () => {
    const { items, unread } = await fetchNotifications()
    if (!unread) {
      say('Không có thông báo mới.')
      return
    }
    say(items[0]?.title ?? 'Có thông báo mới')
    await markNotificationsRead()
    setNotifCount(0)
  }, [say])

  if (!user) return <></>

  const primaryRole = user.roles[0]?.name ?? 'Nhân viên'
  const activeBranch = user.branches.find((b) => b.id === branchId)

  return (
    <div className={`app-root${navOpen ? ' nav-open' : ''}`}>
      <div className="side-ovl" onClick={() => setNavOpen(false)} />
      <aside className="sidebar" aria-label="Menu chính">
        <div className="side-head">
          <div className="role">{primaryRole}</div>
          <div className="clinic">{activeBranch?.name ?? 'Phòng khám'}</div>
          {user.branches.length > 1 ? (
            <select value={branchId ?? ''} onChange={(e) => switchBranch(e.target.value)}>
              {user.branches.map((b) => (
                <option key={b.id} value={b.id}>
                  Cơ sở: {b.shortName ?? b.name}
                </option>
              ))}
            </select>
          ) : null}
        </div>

        <nav className="side-nav">
          {MENU.map((group, gi) => {
            const visible = group.items.filter(
              (i) => (!i.perm || can(i.perm)) && !(i.surgeryOnly && clinic.isInjection)
            )
            if (!visible.length) return null
            return (
              <React.Fragment key={group.group ?? `g${gi}`}>
                {group.group ? <div className="nav-group">{group.group}</div> : null}
                {visible.map((item) => (
                  <NavLink
                    key={item.id}
                    to={item.path}
                    end={item.path === '/'}
                    className={({ isActive }) =>
                      `nav-item${isActive ? ' active' : ''}${item.soon ? ' locked' : ''}`
                    }
                  >
                    <span className="ic">{item.ic}</span>
                    <span>{clinic.isInjection && item.injectionLabel ? item.injectionLabel : item.t}</span>
                    {item.id === 'zalo' && unreadInbox > 0 ? (
                      <span className="badge">{unreadInbox}</span>
                    ) : null}
                    {item.id === 'viectoi' && taskCount.today > 0 ? (
                      <span className="badge" title={taskCount.overdue ? `${taskCount.overdue} việc quá hạn` : undefined}>
                        {taskCount.today}
                      </span>
                    ) : null}
                  </NavLink>
                ))}
              </React.Fragment>
            )
          })}
        </nav>

        <div className="side-foot">
          <div className="me">
            {user.title ? `${user.title} ` : ''}
            {user.name}
            <small>{user.roles.map((r) => r.name).join(' · ')}</small>
          </div>
          <div className="acts">
            <button onClick={() => setDark((d) => !d)}>
              {dark ? '☀ Chuyển nền sáng' : '🌙 Chuyển nền tối'}
            </button>
            <button onClick={() => navigate('/doi-mat-khau')}>🔑 Đổi mật khẩu</button>
            <button
              onClick={async () => {
                await logout()
                navigate('/login')
              }}
            >
              ⎋ Đăng xuất
            </button>
          </div>
        </div>
      </aside>

      <div className="main">
        <div className="topbar">
          <button className="hamburger m-only" aria-label="Mở menu" onClick={() => setNavOpen((o) => !o)}>
            ☰
          </button>
          <div>
            <h1>{pageTitle(location.pathname, clinic.isInjection)}</h1>
            {PAGE_SUBTITLE[location.pathname] ? (
              <div className="sub">{PAGE_SUBTITLE[location.pathname]}</div>
            ) : null}
          </div>
          <div className="right">
            <span className="muted clock" style={{ fontSize: 12 }}>
              {now.toLocaleDateString('vi-VN')} · {now.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })}
            </span>
            <button className="btn sec sm" onClick={openNotifications}>
              🔔{notifCount ? ` ${notifCount}` : ''}
            </button>
          </div>
        </div>

        <div className={`content${location.pathname.startsWith('/hop-thu') ? ' flush' : ''}`}>
          {/* resetKey theo đường dẫn: đổi màn là boundary tự phục hồi. */}
          <ErrorBoundary resetKey={location.pathname}>
            <Outlet />
          </ErrorBoundary>
        </div>
      </div>
    </div>
  )
}
