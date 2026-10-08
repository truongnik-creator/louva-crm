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
import QuickReplies from './pages/QuickReplies'
import Appointments from './pages/Appointments'
import Queue from './pages/Queue'
import Customers from './pages/Customers'
import CustomerDetail from './pages/CustomerDetail'
import CustomerDuplicates from './pages/CustomerDuplicates'
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
import CustomerBoard from './pages/CustomerBoard'
import CustomerImport from './pages/CustomerImport'
import ConsentTemplates from './pages/ConsentTemplates'
import JobLog from './pages/JobLog'
import MyTasks from './pages/MyTasks'
import Outreach from './pages/Outreach'
import Promotions from './pages/Promotions'
import SalesScripts from './pages/SalesScripts'
import Analytics from './pages/Analytics'
import Payroll from './pages/Payroll'
import Growth from './pages/Growth'
import ConversationScores from './pages/ConversationScores'
import Consultations from './pages/Consultations'
import CaseLibrary from './pages/CaseLibrary'
import Reengage from './pages/Reengage'
import CounterClose from './pages/CounterClose'
import UpsellRules from './pages/UpsellRules'
import CrmReports from './pages/CrmReports'
import StageChecklist from './pages/StageChecklist'
import { useClinic } from './lib/clinic-context'

/* Đường dẫn tiếng Việt không dấu, khớp với MENU trong components/AppShell.tsx.
   Mỗi route có `permission` tương ứng quyền backend — trùng khớp cố ý để giấu
   menu và chặn route dùng chung một nguồn sự thật. */

/** F6: màn chỉ dành cho phòng khám phẫu thuật; chế độ tiêm thì về trang chủ. */
function SurgeryOnly({ children }: { children: React.ReactNode }): React.JSX.Element {
  const clinic = useClinic()
  if (clinic.loaded && clinic.isInjection) return <Navigate to="/" replace />
  return <>{children}</>
}

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
        <Route path="viec-cua-toi" element={<MyTasks />} />

        {/* Lô 4 · Đợt 2 */}
        <Route
          path="gui-tin-theo-nhom"
          element={
            <ProtectedRoute permission="inbox.broadcast">
              <Outreach />
            </ProtectedRoute>
          }
        />
        <Route
          path="uu-dai"
          element={
            <ProtectedRoute permission="sales_order.read">
              <Promotions />
            </ProtectedRoute>
          }
        />
        <Route
          path="duyet-giam-gia"
          element={
            <ProtectedRoute permission="sales_order.approve_discount">
              <Promotions />
            </ProtectedRoute>
          }
        />
        <Route
          path="kich-ban-ban-hang"
          element={
            <ProtectedRoute permission="inbox.manage_scripts">
              <SalesScripts />
            </ProtectedRoute>
          }
        />
        <Route
          path="nhat-ky-tac-vu"
          element={
            <ProtectedRoute permission="settings.read">
              <JobLog />
            </ProtectedRoute>
          }
        />

        {/* Lô 5 · Đợt 3: đo lường, lương thưởng, tăng trưởng */}
        <Route path="do-luong" element={<Analytics />} />
        <Route
          path="ky-luong"
          element={
            <ProtectedRoute permission="hr.read">
              <Payroll />
            </ProtectedRoute>
          }
        />
        <Route path="tang-truong" element={<Growth />} />
        <Route
          path="cham-hoi-thoai"
          element={
            <ProtectedRoute permission="inbox.manage_scripts">
              <ConversationScores />
            </ProtectedRoute>
          }
        />

        {/* Lô 6: AI5 nháp tin chăm lại khách im lặng */}
        <Route
          path="cham-lai-khach"
          element={
            <ProtectedRoute permission="inbox.reengage">
              <Reengage />
            </ProtectedRoute>
          }
        />

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
              <SurgeryOnly>
                <SurgerySchedule />
              </SurgeryOnly>
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
        <Route
          path="tu-van"
          element={
            <ProtectedRoute permission="consultation.read">
              <Consultations />
            </ProtectedRoute>
          }
        />
        <Route
          path="chot-tai-quay"
          element={
            <ProtectedRoute permission="visit.read">
              <CounterClose />
            </ProtectedRoute>
          }
        />
        <Route
          path="goi-y-ban-kem"
          element={
            <ProtectedRoute permission="customer.read">
              <UpsellRules />
            </ProtectedRoute>
          }
        />
        <Route
          path="ho-so-phau-thuat"
          element={
            <ProtectedRoute permission="surgery_schedule.read">
              <SurgeryOnly>
                <ProcedureRecords />
              </SurgeryOnly>
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
        <Route
          path="thu-vien-case"
          element={
            <ProtectedRoute permission="case_study.read">
              <CaseLibrary />
            </ProtectedRoute>
          }
        />

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
          path="mau-tin-nhanh"
          element={
            <ProtectedRoute permission="inbox.manage_templates">
              <QuickReplies />
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
          path="bang-buoc-khach"
          element={
            <ProtectedRoute permission="customer.read">
              <CustomerBoard />
            </ProtectedRoute>
          }
        />
        <Route
          path="viec-theo-buoc"
          element={
            <ProtectedRoute permission="customer.read">
              <StageChecklist />
            </ProtectedRoute>
          }
        />
        <Route
          path="bao-cao-crm-360"
          element={
            <ProtectedRoute permission="customer.read">
              <CrmReports />
            </ProtectedRoute>
          }
        />
        <Route
          path="nhap-khach"
          element={
            <ProtectedRoute permission="customer.import">
              <CustomerImport />
            </ProtectedRoute>
          }
        />
        <Route
          path="khach-hang/trung-lap"
          element={
            <ProtectedRoute permission="customer.merge">
              <CustomerDuplicates />
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
        <Route
          path="mau-bieu"
          element={
            <ProtectedRoute permission="settings.read">
              <ConsentTemplates />
            </ProtectedRoute>
          }
        />
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
