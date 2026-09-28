import { prisma } from "./prisma";

// Danh mục THAM SỐ VẬN HÀNH của phòng khám.
//
// Nguyên tắc: mỗi tham số ở đây phải THỰC SỰ điều khiển hành vi hệ thống. Một
// màn cài đặt lưu giá trị rồi không ai đọc là màn trang trí — tệ hơn không có,
// vì quản lý tưởng đã đổi mà thực tế hệ thống vẫn chạy theo số cũ.
//
// Cột "Dùng ở đâu" trong `usedIn` để người sửa biết mình đang đổi cái gì.

export type SettingType = "number" | "percent" | "text" | "boolean";

export interface SettingDef {
  key: string;
  group: string;
  label: string;
  type: SettingType;
  defaultValue: string;
  description: string;
  usedIn: string;
  min?: number;
  max?: number;
}

export const SETTINGS: SettingDef[] = [
  // ---------------------------------------------------------- PHÒNG KHÁM
  {
    key: "clinic.name",
    group: "Phòng khám",
    label: "Tên phòng khám",
    type: "text",
    defaultValue: "Phòng khám Thẩm mỹ Louva",
    description: "Tên hiển thị trên thanh bên và các biểu mẫu in.",
    usedIn: "Thanh bên · Biểu mẫu",
  },
  {
    key: "clinic.workStart",
    group: "Phòng khám",
    label: "Giờ mở cửa",
    type: "text",
    defaultValue: "07:30",
    description: "Khung giờ sớm nhất hiện trên lưới Lịch hẹn và Lịch mổ.",
    usedIn: "Lịch hẹn · Lịch mổ",
  },
  {
    key: "clinic.workEnd",
    group: "Phòng khám",
    label: "Giờ đóng cửa",
    type: "text",
    defaultValue: "18:00",
    description: "Khung giờ muộn nhất hiện trên lưới Lịch hẹn và Lịch mổ.",
    usedIn: "Lịch hẹn · Lịch mổ",
  },

  // ------------------------------------------------------------ PHÒNG MỔ
  {
    key: "surgery.minDepositPercent",
    group: "Phòng mổ",
    label: "Tỉ lệ cọc tối thiểu để xác nhận ca mổ (%)",
    type: "percent",
    defaultValue: "30",
    description:
      "Khách chưa cọc đủ tỉ lệ này thì checklist tiền phẫu KHÔNG đạt và ca mổ không xác nhận được.",
    usedIn: "Checklist tiền phẫu",
    min: 0,
    max: 100,
  },
  {
    key: "surgery.cleanupMinutes",
    group: "Phòng mổ",
    label: "Thời gian dọn phòng giữa hai ca (phút)",
    type: "number",
    defaultValue: "30",
    description: "Hệ thống tự chèn khoảng này khi kiểm tra trùng lịch phòng mổ.",
    usedIn: "Xếp ca mổ",
    min: 0,
    max: 240,
  },

  // ------------------------------------------------------------- HỘP THƯ
  {
    key: "inbox.slowReplyMinutes",
    group: "Hộp thư & Telesale",
    label: "Ngưỡng trả lời chậm (phút)",
    type: "number",
    defaultValue: "60",
    description:
      "Quá ngưỡng này tính là một lượt trả lời chậm khi chấm điểm telesale, và hiện cảnh báo trên Dashboard.",
    usedIn: "Dashboard · Chấm điểm telesale",
    min: 1,
    max: 1440,
  },

  // ------------------------------------------------------------ HẬU PHẪU
  {
    key: "followup.overdueDays",
    group: "Hậu phẫu",
    label: "Số ngày coi là quá hạn liên hệ khách hậu phẫu",
    type: "number",
    defaultValue: "3",
    description: "Khách hậu phẫu quá số ngày này không có lần chạm nào sẽ vào danh sách cảnh báo.",
    usedIn: "Hậu phẫu & Tái khám",
    min: 1,
    max: 30,
  },

  // -------------------------------------------------------------- BẢO MẬT
  {
    key: "security.breakGlassMinutes",
    group: "Bảo mật",
    label: "Thời hạn quyền truy cập khẩn cấp bệnh án (phút)",
    type: "number",
    defaultValue: "30",
    description:
      "Sau khi break-glass, quyền xem bệnh án ngoài phạm vi kéo dài bao lâu trước khi tự thu hồi.",
    usedIn: "Break-glass bệnh án",
    min: 5,
    max: 480,
  },
  {
    key: "security.exportRowLimit",
    group: "Bảo mật",
    label: "Số dòng tối đa mỗi lần xuất dữ liệu",
    type: "number",
    defaultValue: "5000",
    description:
      "Chặn xuất hàng loạt. Vượt hạn mức sẽ bị từ chối và ghi nhật ký truy cập mức nghiêm trọng.",
    usedIn: "Xuất dữ liệu",
    min: 100,
    max: 100000,
  },

  // ---------------------------------------------------------------- KHO
  {
    key: "inventory.expiringSoonDays",
    group: "Kho vật tư",
    label: "Cảnh báo cận hạn trước bao nhiêu ngày",
    type: "number",
    defaultValue: "90",
    description: "Lô có hạn dùng trong khoảng này sẽ hiện cảnh báo vàng ở màn Tồn kho.",
    usedIn: "Tồn kho",
    min: 1,
    max: 365,
  },
  {
    key: "inventory.blockExpiredUse",
    group: "Kho vật tư",
    label: "Chặn dùng vật tư đã hết hạn cho khách",
    type: "boolean",
    defaultValue: "true",
    description:
      "Bật (khuyến nghị): không cho xuất lô đã quá hạn. Tắt chỉ khi có quy trình bù đắp riêng.",
    usedIn: "Xuất dùng vật tư",
  },

  // ------------------------------------------------------------ HOA HỒNG
  {
    key: "commission.holdDays",
    group: "Hoa hồng",
    label: "Số ngày giữ hoa hồng trước khi chi",
    type: "number",
    defaultValue: "30",
    description:
      "Khoảng giữ để thu hồi hoa hồng nếu khách hoàn tiền trong thời gian này. Hiện thị trên bảng lương.",
    usedIn: "Lương & Hoa hồng",
    min: 0,
    max: 180,
  },
];

const SETTING_BY_KEY = new Map(SETTINGS.map((s) => [s.key, s]));

/**
 * Bộ nhớ đệm ngắn hạn. Tham số vận hành được đọc ở nhiều đường nóng (mỗi lần
 * chấm checklist, mỗi lần xuất dùng vật tư) nên không thể truy vấn CSDL mỗi
 * lần; nhưng cũng không được đệm vĩnh viễn, vì quản lý đổi xong phải thấy hiệu
 * lực ngay chứ không phải chờ khởi động lại.
 */
let cache: Map<string, string> | null = null;
let cachedAt = 0;
const CACHE_MS = 15_000;

export function invalidateSettingsCache(): void {
  cache = null;
}

async function loadAll(): Promise<Map<string, string>> {
  if (cache && Date.now() - cachedAt < CACHE_MS) return cache;
  const rows = await prisma.systemSetting.findMany();
  cache = new Map(rows.map((r) => [r.key, r.value]));
  cachedAt = Date.now();
  return cache;
}

export async function getSettingRaw(key: string): Promise<string> {
  const all = await loadAll();
  return all.get(key) ?? SETTING_BY_KEY.get(key)?.defaultValue ?? "";
}

export async function getSettingNumber(key: string): Promise<number> {
  const raw = await getSettingRaw(key);
  const n = Number(raw);
  if (Number.isFinite(n)) return n;
  return Number(SETTING_BY_KEY.get(key)?.defaultValue ?? 0);
}

export async function getSettingBool(key: string): Promise<boolean> {
  return (await getSettingRaw(key)) === "true";
}

/** Toàn bộ tham số kèm giá trị hiện hành, cho màn Cài đặt. */
export async function listSettings(): Promise<
  Array<SettingDef & { value: string; isDefault: boolean }>
> {
  const all = await loadAll();
  return SETTINGS.map((s) => {
    const stored = all.get(s.key);
    return {
      ...s,
      value: stored ?? s.defaultValue,
      isDefault: stored === undefined || stored === s.defaultValue,
    };
  });
}

export function findSetting(key: string): SettingDef | undefined {
  return SETTING_BY_KEY.get(key);
}
