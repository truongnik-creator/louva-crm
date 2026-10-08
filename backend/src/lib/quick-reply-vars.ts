import { prisma } from "./prisma";
import { formatDateVN, formatTimeVN, formatDateTimeVN, formatVnd } from "./datetime";
import { AppointmentStatus, InvoiceStatus } from "../types/enums";
import { currentListPrice } from "./pricing";

// BIẾN TRONG MẪU TIN NHANH (B12).
//
// Mẫu viết dạng "Chào {{ten_khach}}, lịch của mình lúc {{gio_hen}} ngày
// {{ngay_hen}} tại {{dia_chi_co_so}}". Khi nhân viên chọn mẫu, hệ thống tự điền
// từ hồ sơ khách, bảng giá, lịch hẹn. Biến nào không có dữ liệu thì GIỮ NGUYÊN
// "{{...}}" để nhân viên tự sửa, và backend chặn gửi tin còn "{{" (không bao
// giờ để khách nhận "Chào {{ten_khach}}").

export interface TemplateVariable {
  key: string;
  label: string;
  example: string;
}

export const TEMPLATE_VARIABLES: TemplateVariable[] = [
  { key: "ten_khach", label: "Tên khách trong hồ sơ", example: "Nguyễn Thu Hà" },
  { key: "ma_khach", label: "Mã khách", example: "KH-2609-0012" },
  { key: "nhan_vien", label: "Tên nhân viên đang trả lời", example: "Minh Ngọc" },
  { key: "co_so", label: "Tên cơ sở của hội thoại", example: "Cơ sở Hà Nội" },
  { key: "dia_chi_co_so", label: "Địa chỉ cơ sở", example: "12 Trần Phú, Hà Đông" },
  { key: "hotline", label: "Số điện thoại cơ sở", example: "0900 000 000" },
  { key: "ban_do", label: "Link bản đồ của cơ sở (F24)", example: "https://maps.app.goo.gl/..." },
  { key: "chi_dan_gui_xe", label: "Chỉ dẫn gửi xe của cơ sở", example: "Gửi xe tầng hầm B1" },
  { key: "chi_dan_toa_nha", label: "Chỉ dẫn sảnh, tầng của cơ sở", example: "Sảnh A, thang máy lên tầng 4" },
  { key: "lich_hen", label: "Lịch hẹn sắp tới (giờ và ngày)", example: "09:30 15/10/2026" },
  { key: "gio_hen", label: "Giờ lịch hẹn sắp tới", example: "09:30" },
  { key: "ngay_hen", label: "Ngày lịch hẹn sắp tới", example: "15/10/2026" },
  { key: "bac_si_hen", label: "Bác sĩ của lịch hẹn sắp tới", example: "BS Vân Trần" },
  { key: "dich_vu_quan_tam", label: "Dịch vụ khách quan tâm (đầu tiên)", example: "Filler" },
  { key: "gia_dich_vu_quan_tam", label: "Giá hiện hành của dịch vụ khách quan tâm", example: "12.000.000đ" },
  { key: "cong_no", label: "Công nợ còn lại của khách", example: "3.000.000đ" },
  { key: "han_thanh_toan", label: "Hạn thanh toán gần nhất của khách", example: "05/10/2026" },
  { key: "hom_nay", label: "Ngày hôm nay", example: "30/09/2026" },
  { key: "gia:MA_DICH_VU", label: "Giá hiện hành của dịch vụ theo mã (vd {{gia:FILLER}})", example: "4.500.000đ" },
];

const VAR_RE = /\{\{\s*([^{}]+?)\s*\}\}/g;

/** Tên biến cũ (mẫu tạo trước Lô 2, seed cũ) quy về tên chuẩn. */
const ALIASES: Record<string, string> = {
  gio: "gio_hen",
  ngay: "ngay_hen",
  dich_vu: "dich_vu_quan_tam",
  gia: "gia_dich_vu_quan_tam",
  so_tien: "cong_no",
  han: "han_thanh_toan",
  ten: "ten_khach",
};
const canonical = (key: string) => ALIASES[key] ?? key;

/** Tin còn biến chưa điền (hoặc dấu "{{" lạc) thì không được gửi cho khách. */
export function hasUnresolvedPlaceholder(content: string): boolean {
  return content.includes("{{");
}

/** Biến viết sai tên (không có trong danh mục) — báo khi lưu mẫu. */
export function unknownVariables(content: string): string[] {
  const known = new Set(TEMPLATE_VARIABLES.map((v) => v.key));
  const out = new Set<string>();
  for (const m of content.matchAll(VAR_RE)) {
    const key = canonical(m[1].trim());
    if (key.startsWith("gia:") && key.length > 4) continue;
    if (!known.has(key)) out.add(key);
  }
  return [...out];
}

export interface RenderContext {
  /** Hội thoại đang trả lời. Trống thì lấy theo customerId (gửi theo nhóm khách, F11). */
  conversationId?: string | null;
  customerId?: string | null;
  staffName: string;
  /** Cơ sở dùng khi hội thoại chưa gắn cơ sở. */
  fallbackBranchId: string | null;
}

/** Điền biến vào nội dung mẫu. Trả về nội dung đã điền và danh sách biến chưa điền được. */
export async function renderTemplate(
  content: string,
  ctx: RenderContext
): Promise<{ content: string; unresolved: string[] }> {
  const keys = new Set([...content.matchAll(VAR_RE)].map((m) => canonical(m[1].trim())));
  if (keys.size === 0) return { content, unresolved: [] };

  const conv = ctx.conversationId
    ? await prisma.conversation.findUnique({
        where: { id: ctx.conversationId },
        select: {
          branchId: true,
          customer: { select: { id: true, name: true, code: true, interest: true } },
        },
      })
    : null;
  const byId =
    !conv && ctx.customerId
      ? await prisma.customer.findUnique({
          where: { id: ctx.customerId },
          select: {
            id: true,
            name: true,
            code: true,
            interest: true,
            branchLinks: { select: { branchId: true, isPrimary: true }, orderBy: { firstSeenAt: "asc" } },
          },
        })
      : null;
  const customer = conv?.customer ?? (byId ? { id: byId.id, name: byId.name, code: byId.code, interest: byId.interest } : null);
  const customerBranch = byId ? (byId.branchLinks.find((b) => b.isPrimary) ?? byId.branchLinks[0])?.branchId ?? null : null;
  const branchId = conv?.branchId ?? customerBranch ?? ctx.fallbackBranchId;
  const branch = branchId
    ? await prisma.branch.findUnique({
        where: { id: branchId },
        select: { name: true, address: true, phone: true, mapUrl: true, parkingGuide: true, buildingGuide: true },
      })
    : null;

  const needAppointment = ["lich_hen", "gio_hen", "ngay_hen", "bac_si_hen"].some((k) => keys.has(k));
  const appointment =
    customer && needAppointment
      ? await prisma.appointment.findFirst({
          where: {
            customerId: customer.id,
            startAt: { gte: new Date() },
            status: { notIn: [AppointmentStatus.CANCELLED, AppointmentStatus.NO_SHOW] },
          },
          orderBy: { startAt: "asc" },
          select: { startAt: true, doctor: { select: { name: true, title: true } } },
        })
      : null;

  let debt: number | null = null;
  let dueDate: Date | null = null;
  if (customer && (keys.has("cong_no") || keys.has("han_thanh_toan"))) {
    const agg = await prisma.invoice.aggregate({
      where: {
        customerId: customer.id,
        status: { in: [InvoiceStatus.ISSUED, InvoiceStatus.PARTIAL, InvoiceStatus.OVERDUE] },
      },
      _sum: { amount: true, paidAmount: true },
      _min: { dueDate: true },
    });
    debt = (agg._sum.amount ?? 0) - (agg._sum.paidAmount ?? 0);
    // Không còn nợ thì không có gì để nhắc: để biến trống cho nhân viên thấy.
    if (debt <= 0) debt = null;
    dueDate = debt ? agg._min.dueDate : null;
  }

  let interest: string | null = null;
  if (customer?.interest) {
    try {
      const arr = JSON.parse(customer.interest);
      if (Array.isArray(arr) && arr.length) interest = String(arr[0]);
    } catch {
      interest = null;
    }
  }

  // Giá dịch vụ khách quan tâm: khớp tên dịch vụ trong danh mục với mục quan tâm đầu tiên.
  let interestPrice: number | null = null;
  if (interest && branchId && keys.has("gia_dich_vu_quan_tam")) {
    const service = await prisma.service.findFirst({
      where: { active: true, name: { contains: interest } },
      select: { id: true },
    });
    const price = service ? await currentListPrice(service.id, branchId) : null;
    interestPrice = price?.price ?? null;
  }

  const values = new Map<string, string | null>([
    ["ten_khach", customer?.name ?? null],
    ["ma_khach", customer?.code ?? null],
    ["nhan_vien", ctx.staffName],
    ["co_so", branch?.name ?? null],
    ["dia_chi_co_so", branch?.address ?? null],
    ["hotline", branch?.phone ?? null],
    ["ban_do", branch?.mapUrl ?? null],
    ["chi_dan_gui_xe", branch?.parkingGuide ?? null],
    ["chi_dan_toa_nha", branch?.buildingGuide ?? null],
    ["lich_hen", appointment ? formatDateTimeVN(appointment.startAt) : null],
    ["gio_hen", appointment ? formatTimeVN(appointment.startAt) : null],
    ["ngay_hen", appointment ? formatDateVN(appointment.startAt) : null],
    [
      "bac_si_hen",
      appointment?.doctor ? `${appointment.doctor.title ? `${appointment.doctor.title} ` : ""}${appointment.doctor.name}` : null,
    ],
    ["dich_vu_quan_tam", interest],
    ["gia_dich_vu_quan_tam", interestPrice != null ? `${formatVnd(interestPrice)}đ` : null],
    ["cong_no", debt != null ? `${formatVnd(debt)}đ` : null],
    ["han_thanh_toan", dueDate ? formatDateVN(dueDate) : null],
    ["hom_nay", formatDateVN(new Date())],
  ]);

  // Giá theo mã dịch vụ, tại cơ sở của hội thoại.
  for (const key of keys) {
    if (!key.startsWith("gia:")) continue;
    const code = key.slice(4).trim();
    const service = code
      ? await prisma.service.findFirst({ where: { code, active: true }, select: { id: true } })
      : null;
    const price = service && branchId ? await currentListPrice(service.id, branchId) : null;
    values.set(key, price ? `${formatVnd(price.price)}đ` : null);
  }

  const unresolved = new Set<string>();
  const rendered = content.replace(VAR_RE, (whole, rawKey: string) => {
    const key = canonical(rawKey.trim());
    const v = values.get(key);
    if (v == null || v === "") {
      unresolved.add(key);
      return whole;
    }
    return v;
  });
  return { content: rendered, unresolved: [...unresolved] };
}
