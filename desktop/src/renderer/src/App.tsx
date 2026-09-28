import React from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import { useAuth } from './lib/auth-context'
import AppShell from './components/AppShell'
import ProtectedRoute from './components/ProtectedRoute'
import { Spinner } from './components/ui'

import Login from './pages/Login'
import ChangePassword from './pages/ChangePassword'
import Dashboard from './pages/Dashboard'
import Inbox from './pages/Inbox'
import Appointments from './pages/Appointments'
import Queue from './pages/Queue'
import Customers from './pages/Customers'
import CustomerDetail from './pages/CustomerDetail'
import Leads from './pages/Leads'
import Contracts from './pages/Contracts'
import Debts from './pages/Debts'
import SurgerySchedule from './pages/SurgerySchedule'
import ProcedureRecords from './pages/ProcedureRecords'
import Photos from './pages/Photos'
import FollowUp from './pages/FollowUp'
import Inventory from './pages/Inventory'
import InventoryAdvanced from './pages/InventoryAdvanced'
import Hr from './pages/Hr'
import SystemSettings from './pages/SystemSettings'
import Shifts from './pages/Shifts'
import Services from './pages/Services'
import Rooms from './pages/Rooms'
import UsersPage from './pages/Users'
import ZaloConfigPage from './pages/ZaloConfigPage'
import AuditLog from './pages/AuditLog'
import Reports from './pages/Reports'
import Soon from './pages/Soon'

/* Đường dẫn tiếng Việt không dấu, khớp với MENU trong components/AppShell.tsx.
   Mỗi route có `permission` tương ứng quyền backend — trùng khớp cố ý để giấu
   menu và chặn route dùng chung một nguồn sự thật. */

export default function App(): React.JSX.Element {
  const { loading } = useAuth()
  if (loading) return <Spinner />

  return (
    <Routes>
      <Route path="/login" element={<Login />} />

      <Route
        path="/"
        element={
          <ProtectedRoute>
            <AppShell />
          </ProtectedRoute>
        }
      >
        <Route index element={<Dashboard />} />
        <Route path="doi-mat-khau" element={<ChangePassword />} />

        {/* Hành chính phòng khám */}
        <Route
          path="lich-hen"
          element={
            <ProtectedRoute permission="appointment.read">
              <Appointments />
            </ProtectedRoute>
          }
        />
        <Route
          path="khach-da-den"
          element={
            <ProtectedRoute permission="visit.read">
              <Queue />
            </ProtectedRoute>
          }
        />
        <Route
          path="phan-lich"
          element={
            <ProtectedRoute permission="shift.read">
              <Shifts />
            </ProtectedRoute>
          }
        />
        <Route
          path="phong-mo"
          element={
            <ProtectedRoute permission="surgery_schedule.read">
              <SurgerySchedule />
            </ProtectedRoute>
          }
        />
        <Route
          path="kpi-dieu-duong"
          element={
            <ProtectedRoute permission="nursing_kpi.read">
              <Hr />
            </ProtectedRoute>
          }
        />
        <Route
          path="kpi-tu-van"
          element={
            <ProtectedRoute permission="hr.read">
              <Reports />
            </ProtectedRoute>
          }
        />

        {/* Chuyên môn thẩm mỹ */}
        <Route path="tu-van" element={<Soon />} />
        <Route
          path="ho-so-phau-thuat"
          element={
            <ProtectedRoute permission="surgery_schedule.read">
              <ProcedureRecords />
            </ProtectedRoute>
          }
        />
        <Route
          path="anh-truoc-sau"
          element={
            <ProtectedRoute permission="photo.read">
              <Photos />
            </ProtectedRoute>
          }
        />
        <Route
          path="hau-phau"
          element={
            <ProtectedRoute permission="followup.read">
              <FollowUp />
            </ProtectedRoute>
          }
        />
        <Route path="thu-vien-case" element={<Soon />} />

        {/* Kinh doanh */}
        <Route
          path="hop-thu"
          element={
            <ProtectedRoute permission="inbox.read">
              <Inbox />
            </ProtectedRoute>
          }
        />
        <Route
          path="khach-hang"
          element={
            <ProtectedRoute permission="customer.read">
              <Customers />
            </ProtectedRoute>
          }
        />
        <Route
          path="khach-hang/:id"
          element={
            <ProtectedRoute permission="customer.read">
              <CustomerDetail />
            </ProtectedRoute>
          }
        />
        <Route
          path="lead"
          element={
            <ProtectedRoute permission="lead.read">
              <Leads />
            </ProtectedRoute>
          }
        />
        <Route
          path="hop-dong"
          element={
            <ProtectedRoute permission="finance.read">
              <Contracts />
            </ProtectedRoute>
          }
        />
        <Route
          path="cong-no"
          element={
            <ProtectedRoute permission="finance.read">
              <Debts />
            </ProtectedRoute>
          }
        />

        {/* Kho & vật tư */}
        <Route
          path="ton-kho"
          element={
            <ProtectedRoute permission="inventory.read">
              <Inventory />
            </ProtectedRoute>
          }
        />
        <Route
          path="xuat-nhap-kho"
          element={
            <ProtectedRoute permission="inventory.read">
              <Inventory />
            </ProtectedRoute>
          }
        />
        <Route
          path="truy-vet-lo"
          element={
            <ProtectedRoute permission="inventory.read">
              <Inventory />
            </ProtectedRoute>
          }
        />
        <Route
          path="nha-cung-cap"
          element={
            <ProtectedRoute permission="inventory.read">
              <Inventory />
            </ProtectedRoute>
          }
        />
        <Route
          path="chuyen-kho"
          element={
            <ProtectedRoute permission="inventory.read">
              <InventoryAdvanced />
            </ProtectedRoute>
          }
        />
        <Route
          path="dinh-muc-vat-tu"
          element={
            <ProtectedRoute permission="inventory.read">
              <InventoryAdvanced />
            </ProtectedRoute>
          }
        />
        <Route
          path="bao-cao-kho"
          element={
            <ProtectedRoute permission="inventory.read">
              <InventoryAdvanced />
            </ProtectedRoute>
          }
        />

        {/* Nhân sự */}
        <Route
          path="nhan-vien"
          element={
            <ProtectedRoute permission="hr.read">
              <UsersPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="cham-cong"
          element={
            <ProtectedRoute permission="hr.read">
              <Hr />
            </ProtectedRoute>
          }
        />
        <Route
          path="luong"
          element={
            <ProtectedRoute permission="hr.read">
              <Hr />
            </ProtectedRoute>
          }
        />
        <Route path="dao-tao" element={<Soon />} />

        {/* Kế toán & báo cáo */}
        <Route
          path="bao-cao/doanh-thu"
          element={
            <ProtectedRoute permission="accounting.read">
              <Reports />
            </ProtectedRoute>
          }
        />
        <Route
          path="bao-cao/van-hanh"
          element={
            <ProtectedRoute permission="appointment.read">
              <Reports />
            </ProtectedRoute>
          }
        />
        <Route
          path="bao-cao/marketing"
          element={
            <ProtectedRoute permission="lead.read">
              <Reports />
            </ProtectedRoute>
          }
        />
        <Route
          path="xuat-du-lieu"
          element={
            <ProtectedRoute permission="report.export">
              <Reports />
            </ProtectedRoute>
          }
        />

        {/* Cài đặt */}
        <Route
          path="dich-vu"
          element={
            <ProtectedRoute permission="service.read">
              <Services />
            </ProtectedRoute>
          }
        />
        <Route
          path="phong-thiet-bi"
          element={
            <ProtectedRoute permission="settings.read">
              <Rooms />
            </ProtectedRoute>
          }
        />
        <Route
          path="phan-quyen"
          element={
            <ProtectedRoute permission="settings.read">
              <UsersPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="ket-noi-zalo"
          element={
            <ProtectedRoute permission="settings.read">
              <ZaloConfigPage />
            </ProtectedRoute>
          }
        />
        <Route path="mau-bieu" element={<Soon />} />
        <Route
          path="cai-dat-he-thong"
          element={
            <ProtectedRoute permission="settings.read">
              <SystemSettings />
            </ProtectedRoute>
          }
        />
        <Route
          path="nhat-ky"
          element={
            <ProtectedRoute permission="audit.read">
              <AuditLog />
            </ProtectedRoute>
          }
        />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
