import React from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { MENU } from '../components/AppShell'

/* Màn "chưa dựng" — dành cho các phân hệ thuộc Giai đoạn 2/3 trong lộ trình
   (kho theo lô, thư viện case, KPI/hoa hồng tự động, chấm công, đào tạo).
   Nói rõ nó nằm ở giai đoạn nào để người dùng không tưởng là lỗi. */

const PHASE_NOTE: Record<string, string> = {
  '/ton-kho': 'Giai đoạn 2 — Kho vật tư theo lô và hạn dùng',
  '/xuat-nhap-kho': 'Giai đoạn 2 — Nhập, xuất, chuyển kho theo lô',
  '/truy-vet-lo': 'Giai đoạn 2 — Truy vết implant: lô nào đã dùng cho khách nào',
  '/nha-cung-cap': 'Giai đoạn 2 — Nhà cung cấp và đơn mua hàng',
  '/thu-vien-case': 'Giai đoạn 2 — Thư viện case có ẩn danh hoá và hai cổng duyệt',
  '/kpi-dieu-duong': 'Giai đoạn 2 — KPI điều dưỡng, tách khỏi KPI kinh doanh',
  '/cham-cong': 'Giai đoạn 2 — Chấm công đối chiếu ca trực',
  '/luong': 'Giai đoạn 2 — Hoa hồng tự động theo tiền đã thu',
  '/dao-tao': 'Giai đoạn 3 — Đào tạo và theo dõi chứng chỉ hành nghề',
  '/tu-van': 'Giai đoạn 2 — Phác đồ điều trị chi tiết (hiện dùng tab trong hồ sơ khách)',
  '/mau-bieu': 'Giai đoạn 2 — Soạn mẫu cam kết và biểu mẫu in'
}

const READY = [
  { path: '/hop-thu', label: 'Hộp thư Zalo' },
  { path: '/lich-hen', label: 'Lịch hẹn' },
  { path: '/khach-da-den', label: 'Khách đã đến' },
  { path: '/khach-hang', label: 'Khách hàng' },
  { path: '/phong-mo', label: 'Lịch phòng mổ' },
  { path: '/', label: 'Dashboard' }
]

export default function Soon(): React.JSX.Element {
  const location = useLocation()
  const navigate = useNavigate()

  const title =
    MENU.flatMap((g) => g.items).find((i) => i.path === location.pathname)?.t ?? 'Màn hình'

  return (
    <div className="card">
      <div className="empty">
        <div style={{ fontSize: 34 }}>🚧</div>
        <h3 style={{ marginTop: 10 }}>{title}</h3>
        <p>Phân hệ này đã được đặc tả trong tài liệu kiến trúc nhưng chưa nằm trong Giai đoạn 1.</p>
        {PHASE_NOTE[location.pathname] ? (
          <p className="muted">{PHASE_NOTE[location.pathname]}</p>
        ) : null}
        <p className="muted">
          Giai đoạn 1 tập trung vào vòng đời khách: Zalo → đặt lịch → check-in → tư vấn → hợp đồng → thu
          tiền → bệnh án, cam kết, ảnh trước-sau → lịch mổ có checklist.
        </p>
        <div className="row" style={{ justifyContent: 'center', marginTop: 14, flexWrap: 'wrap' }}>
          {READY.map((r, i) => (
            <button
              key={r.path}
              className={`btn ${i === 0 ? '' : 'sec'} sm`}
              onClick={() => navigate(r.path)}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
