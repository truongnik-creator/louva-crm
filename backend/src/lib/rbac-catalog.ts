// Danh mục quyền và bộ vai trò khởi tạo.
//
// Nguồn: wiki/Phong_Kham_Tham_My/Kien_Truc_CRM_Tham_My.md
//   - mục 4.3 "Bảng vai trò × module × CRUD"
//   - mục 4.4 "Bốn quyền đặc biệt tách riêng khỏi CRUD"
//
// Mã quyền có dạng "<module>.<action>". Mã module (A1, B2, C4...) giữ đúng ký
// hiệu trong tài liệu để đối chiếu được với bảng phân quyền.

import { PermissionScope } from "../types/enums";

export interface PermissionDef {
  code: string;
  module: string;
  action: string;
  name: string;
  isSpecial?: boolean;
}

interface ModuleDef {
  key: string; // tiền tố mã quyền: "appointment"
  module: string; // ký hiệu trong tài liệu: "A1"
  label: string;
  actions?: string[];
}

const ACTION_LABEL: Record<string, string> = {
  read: "Xem",
  create: "Tạo",
  update: "Sửa",
  delete: "Xoá",
  approve: "Phê duyệt",
};

const DEFAULT_ACTIONS = ["read", "create", "update", "delete"];

const MODULES: ModuleDef[] = [
  { key: "appointment", module: "A1", label: "Lịch hẹn" },
  { key: "visit", module: "A2", label: "Check-in khách đã đến" },
  { key: "shift", module: "A3", label: "Phân lịch làm việc", actions: [...DEFAULT_ACTIONS, "approve"] },
  { key: "nursing_kpi", module: "A4", label: "KPI điều dưỡng", actions: [...DEFAULT_ACTIONS, "approve"] },
  { key: "consultation", module: "B1", label: "Tư vấn & phác đồ" },
  { key: "medical", module: "B2", label: "Bệnh án" },
  { key: "photo", module: "B3", label: "Ảnh trước - sau" },
  { key: "followup", module: "B4", label: "Hậu phẫu / biến chứng / khiếu nại", actions: [...DEFAULT_ACTIONS, "approve"] },
  { key: "case_study", module: "B5", label: "Thư viện case", actions: [...DEFAULT_ACTIONS, "approve"] },
  { key: "surgery_schedule", module: "B6", label: "Lịch phòng mổ" },
  { key: "customer", module: "C1", label: "Khách hàng" },
  { key: "lead", module: "C2", label: "Lead & chiến dịch" },
  { key: "sales_order", module: "C3", label: "Đơn hàng telesale" },
  { key: "finance", module: "C4", label: "Hợp đồng / Thanh toán / Công nợ", actions: [...DEFAULT_ACTIONS, "approve"] },
  { key: "service", module: "C5", label: "Dịch vụ / Bảng giá / Gói", actions: [...DEFAULT_ACTIONS, "approve"] },
  { key: "inbox", module: "D1", label: "Hộp thư Zalo" },
  { key: "inventory", module: "E1", label: "Kho vật tư & lô", actions: [...DEFAULT_ACTIONS, "approve"] },
  { key: "hr", module: "E2", label: "Nhân sự / Chấm công / Hoa hồng" },
  { key: "accounting", module: "E3", label: "Kế toán & báo cáo quản trị" },
  { key: "settings", module: "E4", label: "Phân quyền & cài đặt" },
  { key: "audit", module: "E4b", label: "Nhật ký kiểm toán", actions: ["read"] },
  { key: "work_report", module: "E5", label: "Báo cáo công việc theo trang tính", actions: ["read"] },
];

/** Bốn quyền đặc biệt tách khỏi CRUD (mục 4.4). */
const SPECIAL_PERMISSIONS: PermissionDef[] = [
  {
    code: "customer.view_phone",
    module: "C1",
    action: "view_phone",
    name: "Xem số điện thoại khách (không có thì SĐT bị che)",
    isSpecial: true,
  },
  {
    code: "customer.merge",
    module: "C1",
    action: "merge",
    name: "Gộp hồ sơ khách trùng (giữ lịch sử, ghi nhật ký)",
    isSpecial: true,
  },
  {
    code: "photo.download",
    module: "B3",
    action: "download",
    name: "Tải ảnh trước-sau về máy (đóng dấu chìm + ghi log)",
    isSpecial: true,
  },
  {
    code: "customer.import",
    module: "C1",
    action: "import",
    name: "Nhập dữ liệu khách từ Excel, CSV (có báo cáo và nhật ký)",
    isSpecial: true,
  },
  {
    code: "photo.marketing_consent",
    module: "B3",
    action: "marketing_consent",
    name: "Bật, tắt cho phép dùng ảnh khách làm marketing (có nhật ký)",
    isSpecial: true,
  },
  {
    code: "inbox.manage_templates",
    module: "D1",
    action: "manage_templates",
    name: "Quản lý mẫu tin nhanh của hộp thư (thêm, sửa, tắt)",
    isSpecial: true,
  },
  {
    code: "sales_order.approve_discount",
    module: "C3",
    action: "approve_discount",
    name: "Duyệt báo giá giảm vượt trần (trong trần giảm của chính mình)",
    isSpecial: true,
  },
  {
    code: "promotion.manage",
    module: "C5",
    action: "manage",
    name: "Quản lý đợt ưu đãi (mức giảm, số suất, thời gian, dịch vụ)",
    isSpecial: true,
  },
  {
    code: "inbox.broadcast",
    module: "D1",
    action: "broadcast",
    name: "Lập nhóm khách và gửi tin theo kịch bản hàng loạt",
    isSpecial: true,
  },
  {
    code: "inbox.reengage",
    module: "D1",
    action: "reengage",
    name: "Duyệt, sửa nháp tin chăm lại khách im lặng do AI soạn (AI5) rồi đưa vào hàng đợi gửi",
    isSpecial: true,
  },
  {
    code: "inbox.manage_scripts",
    module: "D1",
    action: "manage_scripts",
    name: "Quản lý kịch bản bán hàng chuẩn (nguồn cho AI gợi ý trả lời)",
    isSpecial: true,
  },
  {
    code: "upsell.manage",
    module: "C5",
    action: "upsell_manage",
    name: "Quản lý luật gợi ý bán kèm (dịch vụ A gợi ý B, lời gợi ý, điều kiện)",
    isSpecial: true,
  },
  {
    code: "pipeline.manage",
    module: "C1",
    action: "pipeline_manage",
    name: "Quản lý checklist việc theo bước (J3) của bảng bước khách",
    isSpecial: true,
  },
  {
    code: "upsell.review",
    module: "B1",
    action: "upsell_review",
    name: "Duyệt chuyên môn luật gợi ý bán kèm (gỡ nhãn luật mẫu)",
    isSpecial: true,
  },
  {
    code: "work_report.manage_source",
    module: "E5",
    action: "manage_source",
    name: "Gắn, đổi, ngắt trang tính báo cáo của nhân viên và cấp lại token Apps Script",
    isSpecial: true,
  },
  {
    code: "work_report.sync",
    module: "E5",
    action: "sync",
    name: "Bấm đồng bộ trang tính báo cáo ngay (không chờ tác vụ nền)",
    isSpecial: true,
  },
  {
    code: "report.export",
    module: "E4c",
    action: "export",
    name: "Xuất dữ liệu ra ngoài (có hạn mức, có log)",
    isSpecial: true,
  },
  {
    code: "medical.break_glass",
    module: "B2",
    action: "break_glass",
    name: "Truy cập bệnh án ngoài phạm vi (30 phút, bắt buộc nêu lý do)",
    isSpecial: true,
  },
];

export const PERMISSIONS: PermissionDef[] = [
  ...MODULES.flatMap((m) =>
    (m.actions ?? DEFAULT_ACTIONS).map((action) => ({
      code: `${m.key}.${action}`,
      module: m.module,
      action,
      name: `${ACTION_LABEL[action] ?? action} — ${m.label}`,
    }))
  ),
  ...SPECIAL_PERMISSIONS,
];

export const PERMISSION_CODES = new Set(PERMISSIONS.map((p) => p.code));

// -----------------------------------------------------------------------------
// Vai trò khởi tạo
// -----------------------------------------------------------------------------

export const RoleCode = {
  QUAN_LY_HE_THONG: "QUAN_LY_HE_THONG",
  GIAM_DOC: "GIAM_DOC",
  QUAN_LY_CO_SO: "QUAN_LY_CO_SO",
  LE_TAN: "LE_TAN",
  TELESALE: "TELESALE",
  TU_VAN_VIEN: "TU_VAN_VIEN",
  BAC_SI: "BAC_SI",
  DIEU_DUONG: "DIEU_DUONG",
  KHO: "KHO",
  KE_TOAN: "KE_TOAN",
  MARKETING: "MARKETING",
  MEDIA: "MEDIA",
  DESIGN: "DESIGN",
  CONTENT: "CONTENT",
} as const;
export type RoleCode = (typeof RoleCode)[keyof typeof RoleCode];

export interface RoleDef {
  code: RoleCode;
  name: string;
  description: string;
  /**
   * Mỗi mục: "<permission code>" hoặc "<module key>:<actions>" viết tắt.
   * Ví dụ "customer:cru" = customer.create + customer.read + customer.update.
   * Scope áp cho toàn bộ mục đó.
   */
  grants: Array<{ scope: PermissionScope; items: string[] }>;
}

const A: Record<string, string> = { c: "create", r: "read", u: "update", d: "delete", a: "approve" };

/** "customer:cru" -> ["customer.create","customer.read","customer.update"] */
export function expandGrant(item: string): string[] {
  if (!item.includes(":")) return [item];
  const [key, letters] = item.split(":");
  return letters
    .split("")
    .map((ch) => A[ch])
    .filter(Boolean)
    .map((action) => `${key}.${action}`);
}

const ALL = PermissionScope.ALL;
const BR = PermissionScope.BRANCH;
const OWN = PermissionScope.OWN;

export const ROLES: RoleDef[] = [
  {
    code: RoleCode.QUAN_LY_HE_THONG,
    name: "Quản trị hệ thống",
    description:
      "Quản trị tài khoản, vai trò, cấu hình và nhật ký. KHÔNG được đọc nội dung y khoa mặc định — phải break-glass.",
    grants: [
      {
        scope: ALL,
        items: [
          "appointment:crud",
          "visit:crud",
          "shift:cruda",
          "nursing_kpi:cruda",
          "consultation:crud",
          "medical:rd", // chỉ xem/xoá metadata, nội dung phải break-glass
          "photo:rd",
          "followup:cruda",
          "case_study:cruda",
          "surgery_schedule:crud",
          "customer:crud",
          "customer.view_phone",
          "customer.merge",
          "customer.import",
          "lead:crud",
          "sales_order:crud",
          "finance:cruda",
          "service:cruda",
          "inbox:crud",
          "inbox.manage_templates",
          "inbox.broadcast",
          "inbox.reengage",
          "inbox.manage_scripts",
          "sales_order.approve_discount",
          "promotion.manage",
          "upsell.manage",
          "pipeline.manage",
          "inventory:cruda",
          "hr:crud",
          "accounting:crud",
          "settings:crud",
          "audit.read",
          "report.export",
          "work_report.read",
          "work_report.manage_source",
          "work_report.sync",
          "medical.break_glass",
        ],
      },
    ],
  },
  {
    code: RoleCode.GIAM_DOC,
    name: "Giám đốc / Chủ đầu tư",
    description: "Nhìn toàn công ty, phê duyệt các khoản lớn. Xem bệnh án cơ sở khác phải break-glass.",
    grants: [
      {
        scope: ALL,
        items: [
          "appointment.read",
          "visit.read",
          "shift.read",
          "nursing_kpi.read",
          "consultation:cru",
          "followup:ra",
          "case_study:ra",
          "surgery_schedule.read",
          "customer.read",
          "customer.view_phone",
          "customer.merge",
          "customer.import",
          "photo.marketing_consent",
          "lead.read",
          "sales_order.read",
          "finance:ra",
          "service:ra",
          "inbox.read",
          "inbox.broadcast",
          "inbox.reengage",
          "inbox.manage_scripts",
          "sales_order.approve_discount",
          "promotion.manage",
          "upsell.manage",
          "pipeline.manage",
          "inventory.read",
          "hr.read",
          "accounting.read",
          "settings.read",
          "audit.read",
          "report.export",
          "work_report.read",
          "work_report.manage_source",
          "work_report.sync",
          "medical.break_glass",
        ],
      },
      { scope: BR, items: ["medical.read", "photo.read"] },
    ],
  },
  {
    code: RoleCode.QUAN_LY_CO_SO,
    name: "Quản lý cơ sở",
    description: "Điều hành toàn bộ hoạt động trong cơ sở của mình.",
    grants: [
      {
        scope: BR,
        items: [
          "appointment:crud",
          "visit:cru",
          "shift:cruda",
          "nursing_kpi:crua",
          "consultation:cru",
          "medical.read",
          "photo.read",
          "photo.download",
          "photo.marketing_consent",
          "followup:crua",
          "case_study:ra",
          "surgery_schedule:cru",
          "customer:cru",
          "customer.view_phone",
          "customer.merge",
          "customer.import",
          "lead.read",
          "sales_order:cru",
          "finance:crua",
          "service.read",
          "inbox:cru",
          "inbox.manage_templates",
          "inbox.broadcast",
          "inbox.reengage",
          "inbox.manage_scripts",
          "sales_order.approve_discount",
          "promotion.manage",
          "upsell.manage",
          "pipeline.manage",
          // Tài liệu vận hành (bảng nhân sự) ghi rõ: ở quy mô đầu, quản lý cơ
          // sở KIÊM THỦ KHO. Cho quyền nhập/xuất chứ không chỉ xem, nếu không
          // thì không ai nhập được hàng cho tới khi tuyển nhân viên kho riêng.
          "inventory:crua",
          "hr:cru",
          "accounting.read",
          "settings.read",
          "audit.read",
          "report.export",
          "work_report.read",
          "work_report.manage_source",
          "work_report.sync",
        ],
      },
    ],
  },
  {
    code: RoleCode.LE_TAN,
    name: "Lễ tân",
    description: "Đặt lịch, check-in, thu tiền tại quầy. Không có quyền bệnh án.",
    grants: [
      {
        scope: BR,
        items: [
          "appointment:cru",
          "visit:cru",
          "consultation.read",
          "followup:cr",
          "surgery_schedule.read",
          "customer:cru",
          "customer.view_phone",
          "sales_order.read",
          "finance:cr",
          "service.read",
          "inbox:cru",
        ],
      },
      { scope: OWN, items: ["shift.read", "hr.read"] },
    ],
  },
  {
    code: RoleCode.TELESALE,
    name: "Telesale",
    description: "Chăm khách được giao, chốt đơn. Chỉ thấy dữ liệu của mình.",
    grants: [
      {
        scope: OWN,
        items: [
          "appointment:cru",
          "visit.read",
          "shift.read",
          "consultation.read",
          "followup.read",
          "customer:cru",
          "customer.view_phone",
          "lead.read",
          "sales_order:cru",
          "finance.read",
          "inbox:cru",
          "inbox.reengage",
          "hr.read",
        ],
      },
      { scope: BR, items: ["service.read", "case_study.read"] },
    ],
  },
  {
    code: RoleCode.TU_VAN_VIEN,
    name: "Tư vấn viên",
    description:
      "Tư vấn tại phòng khám, ra phác đồ và báo giá. Chỉ thấy phần bệnh án liên quan bán hàng (dị ứng, chống chỉ định).",
    grants: [
      {
        scope: OWN,
        items: [
          "appointment:cru",
          "consultation:cru",
          "customer:cru",
          "customer.view_phone",
          "lead.read",
          "sales_order:cru",
          "finance:cr",
          "followup:cr",
          "inbox:cru",
          "inbox.reengage",
          "shift.read",
          "hr.read",
        ],
      },
      { scope: BR, items: ["visit.read", "medical.read", "photo.read", "service.read", "surgery_schedule.read", "case_study.read"] },
    ],
  },
  {
    code: RoleCode.BAC_SI,
    name: "Bác sĩ",
    description: "Khám, mổ, làm chủ bệnh án và ảnh trong cơ sở của mình.",
    grants: [
      {
        scope: BR,
        items: [
          "appointment:ru",
          "visit.read",
          "consultation:cru",
          "medical:crud",
          "photo:crud",
          "photo.download",
          "photo.marketing_consent",
          "followup:cru",
          "case_study:crua",
          "upsell.review",
          "surgery_schedule:cru",
          "customer.read",
          "customer.view_phone",
          "service.read",
          "inbox.read",
          "inventory.read",
        ],
      },
      { scope: OWN, items: ["shift.read", "hr.read"] },
    ],
  },
  {
    code: RoleCode.DIEU_DUONG,
    name: "Điều dưỡng",
    description: "Chăm sóc trước/sau mổ, phụ mổ, thay băng, ghi sinh hiệu.",
    grants: [
      {
        scope: BR,
        items: [
          "appointment.read",
          "visit:ru",
          "consultation.read",
          "medical:cru",
          "photo:cru",
          "followup:cru",
          "case_study.read",
          "surgery_schedule:ru",
          "customer.read",
          "service.read",
          "inventory.read",
        ],
      },
      { scope: OWN, items: ["shift.read", "nursing_kpi.read", "hr.read"] },
    ],
  },
  {
    code: RoleCode.KHO,
    name: "Kho vật tư",
    description: "Nhập, xuất, kiểm kê vật tư theo lô.",
    grants: [
      { scope: BR, items: ["inventory:crud", "surgery_schedule.read", "service.read"] },
      { scope: OWN, items: ["shift.read", "hr.read"] },
    ],
  },
  {
    code: RoleCode.KE_TOAN,
    name: "Kế toán",
    description: "Hợp đồng, hoá đơn, công nợ, sổ quỹ và báo cáo tài chính của cơ sở.",
    grants: [
      {
        scope: BR,
        items: [
          "appointment.read",
          "visit.read",
          "shift.read",
          "nursing_kpi.read",
          "consultation.read",
          "followup.read",
          "customer.read",
          "customer.view_phone",
          "lead.read",
          "sales_order.read",
          "finance:crua",
          "service.read",
          "inventory.read",
          "hr:cru",
          "accounting:crud",
          "report.export",
        ],
      },
    ],
  },
  {
    code: RoleCode.MARKETING,
    name: "Marketing",
    description:
      "Chạy chiến dịch và đọc số liệu phễu. KHÔNG thấy số điện thoại khách, chỉ xem case đã ẩn danh và đã duyệt.",
    grants: [
      { scope: ALL, items: ["customer.read", "lead:crud", "sales_order.read", "case_study.read"] },
      { scope: BR, items: ["inbox.read", "service.read"] },
      { scope: OWN, items: ["shift.read", "hr.read", "work_report.read"] },
    ],
  },

  // ---------------------------------------------------------------------------
  // F36: ba vai trò sáng tạo nội dung (bộ phận Media, Design, Content).
  //
  // Bộ phận MKT dùng lại vai trò MARKETING sẵn có — nó đã đúng việc (phễu,
  // chiến dịch, số liệu) nên thêm một vai "MKT" trùng chức năng chỉ làm bảng
  // phân quyền rối. Ba vai dưới đây thì KHÔNG có vai nào sẵn tương đương.
  //
  // Nguyên tắc cấp quyền: đủ để làm việc và tự xem báo cáo của mình, KHÔNG
  // chạm dữ liệu y khoa và KHÔNG thấy số điện thoại khách (thiếu
  // `customer.view_phone` nên SĐT bị che ở mọi màn). Trưởng bộ phận cần xem
  // báo cáo cả nhóm thì nâng `work_report.read` lên phạm vi BRANCH ở màn
  // Người dùng & Phân quyền — không phải sửa mã nguồn.
  {
    code: RoleCode.MEDIA,
    name: "Media (quay, dựng)",
    description:
      "Quay, dựng, đăng nội dung trên các kênh. Xem được dịch vụ, case đã duyệt và báo cáo công việc của chính mình.",
    grants: [
      { scope: BR, items: ["customer.read", "service.read", "case_study.read", "inbox.read"] },
      { scope: OWN, items: ["appointment.read", "shift.read", "hr.read", "work_report.read"] },
    ],
  },
  {
    code: RoleCode.DESIGN,
    name: "Design (thiết kế)",
    description:
      "Thiết kế ấn phẩm, ảnh trước-sau đã được phép dùng marketing, backdrop, voucher. Xem báo cáo công việc của chính mình.",
    grants: [
      { scope: BR, items: ["customer.read", "service.read", "case_study.read", "inbox.read"] },
      { scope: OWN, items: ["appointment.read", "shift.read", "hr.read", "work_report.read"] },
    ],
  },
  {
    code: RoleCode.CONTENT,
    name: "Content (nội dung)",
    description:
      "Viết nội dung, kịch bản bán hàng chuẩn cho AI gợi ý trả lời. Xem báo cáo công việc của chính mình.",
    grants: [
      {
        scope: BR,
        items: ["customer.read", "service.read", "case_study.read", "inbox.read", "inbox.manage_scripts"],
      },
      { scope: OWN, items: ["appointment.read", "shift.read", "hr.read", "work_report.read"] },
    ],
  },
];

/** F36: bốn bộ phận dùng cơ chế báo cáo công việc theo trang tính. */
export const WORK_REPORT_DEPARTMENTS = [
  { code: "MEDIA", name: "Media" },
  { code: "MKT", name: "Marketing (MKT)" },
  { code: "DESIGN", name: "Design" },
  { code: "CONTENT", name: "Content" },
] as const;

/** Mã bộ phận mặc định được coi là "khối báo cáo trang tính" trên giao diện. */
export const WORK_REPORT_DEPARTMENT_CODES: string[] = WORK_REPORT_DEPARTMENTS.map((d) => d.code);

/**
 * Vai trò của khối báo cáo trang tính.
 *
 * Cần cả danh sách này bên cạnh danh sách bộ phận vì người quản trị tạo tài
 * khoản thì BẮT BUỘC chọn vai trò, còn bộ phận là tuỳ chọn và trên thực tế gần
 * như luôn để trống. Lọc nhân viên chỉ theo bộ phận sẽ ra danh sách rỗng ngay
 * cả khi đã có đủ người của Media, Design, Content.
 */
export const WORK_REPORT_ROLE_CODES: string[] = [
  RoleCode.MEDIA,
  RoleCode.DESIGN,
  RoleCode.CONTENT,
  RoleCode.MARKETING,
];
