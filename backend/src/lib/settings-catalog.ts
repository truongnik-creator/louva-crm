import { prisma } from "./prisma";

// Danh mục THAM SỐ VẬN HÀNH của phòng khám.
//
// Nguyên tắc: mỗi tham số ở đây phải THỰC SỰ điều khiển hành vi hệ thống. Một
// màn cài đặt lưu giá trị rồi không ai đọc là màn trang trí — tệ hơn không có,
// vì quản lý tưởng đã đổi mà thực tế hệ thống vẫn chạy theo số cũ.
//
// Cột "Dùng ở đâu" trong `usedIn` để người sửa biết mình đang đổi cái gì.

export type SettingType = "number" | "percent" | "text" | "boolean" | "select";

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
  /** Với type "select": các lựa chọn hợp lệ. */
  options?: Array<{ value: string; label: string }>;
  /** Kiểm tra thêm giá trị dạng chữ (bảng bậc...). Trả thông báo lỗi hoặc null. */
  validate?: (value: string) => string | null;
}

/** Bảng bậc "ngưỡng:giá trị,ngưỡng:giá trị" (F17). Dùng chung với lib/tiers.ts. */
function validateTiers(value: string): string | null {
  const parts = value.split(",").map((x) => x.trim()).filter(Boolean);
  if (!parts.length) return "Cần ít nhất một bậc dạng ngưỡng:giá trị";
  let last = -Infinity;
  for (const part of parts) {
    const m = part.match(/^(\d+(?:[.,]\d+)?)\s*:\s*(\d+(?:[.,]\d+)?)$/);
    if (!m) return `Bậc "${part}" không đúng dạng ngưỡng:giá trị`;
    const t = Number(m[1].replace(",", "."));
    if (t <= last) return "Các ngưỡng phải tăng dần";
    last = t;
  }
  return null;
}

function validateRoleList(value: string): string | null {
  return /^[A-Z_]+(\s*,\s*[A-Z_]+)*$/.test(value.trim()) ? null : "Nhập mã vai trò cách nhau dấu phẩy, ví dụ TELESALE,TU_VAN_VIEN";
}

const STAGE_KEY = /^[A-Z_]+$/;

function validateStageList(value: string): string | null {
  const v = value.trim();
  if (!v) return null;
  return v.split(",").every((x) => STAGE_KEY.test(x.trim())) ? null : "Nhập mã bước cách nhau dấu phẩy, ví dụ LICH_COC,HEN";
}

function validateStageNumbers(value: string): string | null {
  const v = value.trim();
  if (!v) return null;
  return v.split(",").every((x) => /^[A-Z_]+\s*:\s*\d+$/.test(x.trim())) ? null : "Nhập dạng BƯỚC:số cách nhau dấu phẩy, ví dụ LICH_COC:40";
}

function validateSubStages(value: string): string | null {
  const v = value.trim();
  if (!v) return null;
  for (const part of v.split(";").map((x) => x.trim()).filter(Boolean)) {
    const m = part.match(/^([A-Z_]+)\s*:\s*(.+)$/);
    if (!m) return `"${part}" không đúng dạng BƯỚC:MÃ=Nhãn|MÃ=Nhãn`;
    for (const sub of m[2].split("|")) {
      if (!/^[A-Z_]+\s*=\s*\S.*$/.test(sub.trim())) return `Bước con "${sub}" không đúng dạng MÃ=Nhãn`;
    }
  }
  return null;
}

const EVENT_KEYS = ["MESSAGE", "PHOTO", "APPOINTMENT_BOOKED", "DEPOSIT_CONFIRMED", "CHECK_IN", "CONTRACT"];
function validateEventList(value: string): string | null {
  const v = value.trim();
  if (!v) return null;
  const bad = v.split(",").map((x) => x.trim()).filter((x) => !EVENT_KEYS.includes(x));
  return bad.length ? `Mã sự kiện không hợp lệ: ${bad.join(", ")}` : null;
}

function validateOptionList(value: string): string | null {
  const items = value.split(",").map((x) => x.trim()).filter(Boolean);
  if (!items.length) return "Cần ít nhất một lựa chọn";
  if (items.some((x) => x.length > 60)) return "Mỗi lựa chọn tối đa 60 ký tự";
  return null;
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

  {
    key: "clinic.mode",
    group: "Phòng khám",
    label: "Chế độ phòng khám",
    type: "select",
    defaultValue: "INJECTION",
    options: [
      { value: "INJECTION", label: "Phòng khám tiêm (nội khoa)" },
      { value: "SURGERY", label: "Phòng khám phẫu thuật" },
    ],
    description:
      "Phòng khám tiêm ẩn phòng mổ, lịch mổ, hồ sơ phẫu thuật, implant và dùng bộ 7 bước bán hàng tiêm. Phẫu thuật dùng bộ bước phẫu thuật.",
    usedIn: "Menu · Bước của khách · Nhãn giao diện",
  },
  {
    key: "stage.returnWindowDays",
    group: "Bước bán hàng",
    label: "Làm dịch vụ lần 2 trong bao nhiêu ngày thì tính là Quay lại",
    type: "number",
    defaultValue: "180",
    description: "Khách hoàn tất lần thực hiện thứ hai trong số ngày này sẽ tự chuyển sang bước Quay lại.",
    usedIn: "Tự chuyển bước khách",
    min: 7,
    max: 1095,
  },

  // ------------------------------------------------------------ ẢNH CHAT
  {
    key: "chat.autoSavePhotos",
    group: "Hộp thư & Telesale",
    label: "Tự tải và lưu ảnh khách gửi qua chat vào hồ sơ",
    type: "boolean",
    defaultValue: "true",
    description:
      "Ảnh khách gửi qua Zalo, Pancake được tải về ngay khi nhận, mã hoá và lưu vào bộ ảnh CHAT của hồ sơ (chờ gắn hồ sơ nếu hội thoại chưa gắn).",
    usedIn: "Hộp thư · Ảnh trước sau",
  },
  {
    key: "chat.maxImageMb",
    group: "Hộp thư & Telesale",
    label: "Dung lượng tối đa mỗi ảnh chat tự tải về (MB)",
    type: "number",
    defaultValue: "10",
    description: "Ảnh lớn hơn sẽ không tự tải, vẫn xem được qua đường dẫn gốc nếu kênh chat còn giữ.",
    usedIn: "Tự lưu ảnh chat",
    min: 1,
    max: 50,
  },

  // ---------------------------------------------------------------- CỌC
  {
    key: "deposit.bankBin",
    group: "Đặt cọc",
    label: "Mã BIN ngân hàng nhận cọc (VietQR)",
    type: "text",
    defaultValue: process.env.BANK_BIN ?? "",
    description: "Mã 6 số của ngân hàng theo danh sách napas (ví dụ 970436 là Vietcombank). Cơ sở có tài khoản riêng thì khai ở thông tin cơ sở.",
    usedIn: "Mã QR đặt cọc",
  },
  {
    key: "deposit.bankAccountNo",
    group: "Đặt cọc",
    label: "Số tài khoản nhận cọc",
    type: "text",
    defaultValue: process.env.BANK_ACCOUNT_NO ?? "",
    description: "Số tài khoản ngân hàng nhận tiền cọc.",
    usedIn: "Mã QR đặt cọc",
  },
  {
    key: "deposit.bankAccountName",
    group: "Đặt cọc",
    label: "Tên chủ tài khoản nhận cọc",
    type: "text",
    defaultValue: process.env.BANK_ACCOUNT_NAME ?? "",
    description: "Tên hiện trên mã QR, viết hoa không dấu như trên thẻ ngân hàng.",
    usedIn: "Mã QR đặt cọc",
  },
  {
    key: "deposit.qrTemplate",
    group: "Đặt cọc",
    label: "Mẫu ảnh VietQR",
    type: "text",
    defaultValue: "compact2",
    description: "Mẫu ảnh của img.vietqr.io: compact, compact2, qr_only, print.",
    usedIn: "Mã QR đặt cọc",
  },
  {
    key: "deposit.defaultAmount",
    group: "Đặt cọc",
    label: "Tiền cọc gợi ý khi đặt lịch (đồng)",
    type: "number",
    defaultValue: "500000",
    description: "Số điền sẵn trong ô tiền cọc khi đặt lịch. Lễ tân sửa được từng lịch.",
    usedIn: "Đặt lịch hẹn",
    min: 0,
    max: 100000000,
  },

  // ------------------------------------------------------------------ AI
  {
    key: "ai.extractEnabled",
    group: "Trí tuệ nhân tạo",
    label: "Bật tự tách SĐT, tên, nhu cầu từ tin nhắn bằng AI",
    type: "boolean",
    defaultValue: "true",
    description:
      "Chỉ chạy khi máy chủ có ANTHROPIC_API_KEY và khách đã đồng ý xử lý dữ liệu (Nghị định 13/2023). Tách SĐT bằng mẫu số vẫn luôn chạy.",
    usedIn: "Hộp thư · Thẻ gợi ý",
  },

  // ------------------------------------------------------------- NHẬP FILE
  {
    key: "import.maxRows",
    group: "Nhập dữ liệu",
    label: "Số dòng tối đa mỗi lần nhập file khách",
    type: "number",
    defaultValue: "5000",
    description: "File nhiều hơn thì chia nhỏ rồi nhập nhiều lần.",
    usedIn: "Nhập khách từ Excel, CSV",
    min: 10,
    max: 50000,
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

  {
    key: "surgery.capacityHoursPerDay",
    group: "Phòng mổ",
    label: "Số giờ thủ thuật tối đa mỗi ngày (mốc công suất 100%)",
    type: "number",
    defaultValue: "8",
    description:
      "Công suất bác sĩ = giờ làm thật ÷ (số ngày × mốc này). Công suất cơ sở nhân thêm số phòng mổ, phòng thủ thuật đang hoạt động.",
    usedIn: "Báo cáo vận hành · Bảng điểm bác sĩ",
    min: 1,
    max: 24,
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
    group: "Chăm sóc sau điều trị",
    label: "Số ngày coi là quá hạn liên hệ (việc chăm sóc sau điều trị)",
    type: "number",
    defaultValue: "3",
    description:
      "Việc chăm sóc (mốc D0, D1, D3...) quá hạn số ngày này mà chưa bấm \"Đã liên hệ\" thì hiện đỏ ở màn Chăm sóc sau điều trị.",
    usedIn: "Chăm sóc sau điều trị",
    min: 0,
    max: 30,
  },
  {
    key: "aftercare.milestones",
    group: "Chăm sóc sau điều trị",
    label: "Các mốc chăm sóc sau điều trị (số ngày, cách nhau dấu phẩy)",
    type: "text",
    defaultValue: "0,1,3,7,14,30",
    description: "Hoàn tất một lần thực hiện thì sinh một việc gọi chăm sóc cho mỗi mốc (D0 là ngày làm).",
    usedIn: "Quy tắc 7 · Chăm sóc sau điều trị",
  },

  // ----------------------------------------------------------- TỰ ĐỘNG HOÁ (F8, F9)
  {
    key: "jobs.enabled",
    group: "Tự động hoá",
    label: "Bật bộ chạy tác vụ nền",
    type: "boolean",
    defaultValue: "true",
    description: "Tắt thì mọi quy tắc tự động và hàng đợi gửi tin dừng lại (vẫn bấm chạy tay được ở Nhật ký tác vụ).",
    usedIn: "Nhật ký tác vụ",
  },
  {
    key: "automation.unanswered.enabled",
    group: "Tự động hoá",
    label: "Quy tắc 1: tin chưa trả lời quá lâu thì báo trưởng nhóm",
    type: "boolean",
    defaultValue: "true",
    description: "Khách nhắn mà chưa ai trả lời quá số phút bên dưới thì báo quản lý cơ sở và người phụ trách hội thoại.",
    usedIn: "Quy tắc tự động",
  },
  {
    key: "automation.unanswered.minutes",
    group: "Tự động hoá",
    label: "Quy tắc 1: số phút chưa trả lời thì báo",
    type: "number",
    defaultValue: "15",
    description: "Tính từ tin khách đầu tiên chưa được trả lời.",
    usedIn: "Quy tắc tự động",
    min: 1,
    max: 1440,
  },
  {
    key: "automation.medicalKeyword.enabled",
    group: "Tự động hoá",
    label: "Quy tắc 2: tin có từ khoá y khoa thì gắn cờ, báo bác sĩ",
    type: "boolean",
    defaultValue: "true",
    description: "Gắn cờ y khoa cho hội thoại và thông báo bác sĩ của cơ sở.",
    usedIn: "Quy tắc tự động · Hộp thư",
  },
  {
    key: "automation.medicalKeywords",
    group: "Tự động hoá",
    label: "Từ khoá y khoa (cách nhau dấu phẩy)",
    type: "text",
    defaultValue: "đau,sưng,thuốc,biến chứng,bầm,dị ứng,thai,chảy máu,mưng mủ,sốt,tím,hoại tử,nhiễm trùng,cho con bú",
    description: "Dùng cho quy tắc 2 và lớp chặn thứ nhất của AI gợi ý trả lời (gặp từ khoá thì không sinh câu trả lời, đề nghị chuyển bác sĩ).",
    usedIn: "Quy tắc tự động · AI gợi ý trả lời",
  },
  {
    key: "automation.priceDeviation.enabled",
    group: "Tự động hoá",
    label: "Quy tắc 3: giá báo khác giá niêm yết thì cảnh báo quản lý",
    type: "boolean",
    defaultValue: "true",
    description: "Báo giá có dòng giảm ngoài đợt ưu đãi hoặc cao hơn giá niêm yết thì thông báo quản lý cơ sở.",
    usedIn: "Quy tắc tự động",
  },
  {
    key: "automation.stuckPhoto.enabled",
    group: "Tự động hoá",
    label: "Quy tắc 4: khách kẹt ở bước Có ảnh thì tạo việc chăm lại",
    type: "boolean",
    defaultValue: "true",
    description: "Khách ở bước Có ảnh quá số ngày bên dưới thì tạo việc chăm lại cho sale phụ trách.",
    usedIn: "Quy tắc tự động",
  },
  {
    key: "automation.stuckPhoto.days",
    group: "Tự động hoá",
    label: "Quy tắc 4: số ngày ở bước Có ảnh",
    type: "number",
    defaultValue: "3",
    description: "",
    usedIn: "Quy tắc tự động",
    min: 1,
    max: 90,
  },
  {
    key: "automation.tomorrowReminder.enabled",
    group: "Tự động hoá",
    label: "Quy tắc 5: lịch hẹn ngày mai thì tạo tin nhắc và danh sách cho lễ tân",
    type: "boolean",
    defaultValue: "true",
    description: "Tạo tin nhắc lịch (chờ gửi), việc nhắc cọc cho lịch chưa cọc, thông báo lễ tân số lịch ngày mai.",
    usedIn: "Quy tắc tự động · Lịch hẹn",
  },
  {
    key: "automation.noShow.enabled",
    group: "Tự động hoá",
    label: "Quy tắc 6: quá giờ hẹn chưa check-in thì tạo việc gọi lại",
    type: "boolean",
    defaultValue: "true",
    description: "",
    usedIn: "Quy tắc tự động",
  },
  {
    key: "automation.noShow.minutes",
    group: "Tự động hoá",
    label: "Quy tắc 6: số phút quá giờ hẹn",
    type: "number",
    defaultValue: "30",
    description: "",
    usedIn: "Quy tắc tự động",
    min: 5,
    max: 600,
  },
  {
    key: "automation.aftercare.enabled",
    group: "Tự động hoá",
    label: "Quy tắc 7: hoàn tất lần thực hiện thì sinh việc chăm sóc",
    type: "boolean",
    defaultValue: "true",
    description: "Sinh việc gọi chăm sóc theo các mốc chăm sóc sau điều trị và tính mốc tái tiêm.",
    usedIn: "Quy tắc tự động · Chăm sóc sau điều trị",
  },
  {
    key: "automation.retreat.enabled",
    group: "Tự động hoá",
    label: "Quy tắc 8: đến mốc tái tiêm thì tạo cơ hội bán và việc cho sale",
    type: "boolean",
    defaultValue: "true",
    description: "Mốc tái tiêm = ngày làm + số ngày tái tiêm của dịch vụ (bác sĩ chỉnh được từng lần).",
    usedIn: "Quy tắc tự động",
  },
  {
    key: "automation.retreat.leadDays",
    group: "Tự động hoá",
    label: "Quy tắc 8: tạo việc trước mốc tái tiêm bao nhiêu ngày",
    type: "number",
    defaultValue: "7",
    description: "",
    usedIn: "Quy tắc tự động",
    min: 0,
    max: 60,
  },

  // ------------------------------------------------------ GỬI THEO KỊCH BẢN (F11)
  {
    key: "broadcast.enabled",
    group: "Gửi tin theo nhóm",
    label: "Bật hàng đợi gửi tin theo nhóm khách",
    type: "boolean",
    defaultValue: "true",
    description: "",
    usedIn: "Nhóm khách & Gửi tin",
  },
  {
    key: "broadcast.maxPerHour",
    group: "Gửi tin theo nhóm",
    label: "Số tin tối đa gửi mỗi giờ",
    type: "number",
    defaultValue: "60",
    description: "Giới hạn chung cho mọi đợt gửi, tránh kênh chat khoá trang vì gửi dồn.",
    usedIn: "Nhóm khách & Gửi tin",
    min: 1,
    max: 2000,
  },
  {
    key: "broadcast.facebookWindowHours",
    group: "Gửi tin theo nhóm",
    label: "Cửa sổ nhắn tin Facebook (giờ)",
    type: "number",
    defaultValue: "24",
    description: "Khách Facebook, Instagram nhắn lần cuối quá số giờ này thì không tự gửi, chỉ tạo việc cho sale.",
    usedIn: "Nhóm khách & Gửi tin",
    min: 1,
    max: 168,
  },

  // --------------------------------------------------------- GIÁ, GIẢM GIÁ (F13, F21)
  {
    key: "pricing.singlePriceList",
    group: "Giá & Giảm giá",
    label: "Dùng một bảng giá chung cho tất cả cơ sở",
    type: "boolean",
    defaultValue: "false",
    description: "Bật thì mọi cơ sở dùng giá của cơ sở gốc (cơ sở tạo đầu tiên), không cần khai giá từng cơ sở.",
    usedIn: "Báo giá · Hợp đồng · Tin bảng giá",
  },
  ...(
    [
      ["TELESALE", "Telesale", "0"],
      ["TU_VAN_VIEN", "Tư vấn viên", "0"],
      ["LE_TAN", "Lễ tân", "0"],
      ["QUAN_LY_CO_SO", "Quản lý cơ sở", "10"],
      ["GIAM_DOC", "Giám đốc", "100"],
    ] as const
  ).map(
    ([role, label, def]): SettingDef => ({
      key: `discount.capPercent.${role}`,
      group: "Giá & Giảm giá",
      label: `Trần giảm ngoài ưu đãi của ${label} (%)`,
      type: "percent",
      defaultValue: def,
      description:
        "Giảm ngoài đợt ưu đãi trong trần thì vẫn phải ghi lý do; vượt trần thì báo giá chờ quản lý duyệt. 0 = chỉ giảm được qua đợt ưu đãi hoặc khi được duyệt.",
      usedIn: "Báo giá · Hợp đồng · Duyệt giảm giá",
      min: 0,
      max: 100,
    })
  ),

  // ------------------------------------------------------------ HỘP THƯ THEO CA (F26)
  {
    key: "inbox.waitingAlertMinutes",
    group: "Hộp thư & Telesale",
    label: "Đồng hồ khách chờ chuyển đỏ sau (phút)",
    type: "number",
    defaultValue: "15",
    description: "Hộp thư hiện thời gian khách chờ trả lời; quá ngưỡng này thì chuyển đỏ.",
    usedIn: "Hộp thư",
    min: 1,
    max: 1440,
  },
  {
    key: "inbox.roundRobin.enabled",
    group: "Hộp thư & Telesale",
    label: "Tự chia hội thoại mới xoay vòng cho sale đang trong ca",
    type: "boolean",
    defaultValue: "true",
    description: "Sale trong ca = có phân lịch hôm nay ở cơ sở của hội thoại (vai Telesale hoặc Tư vấn viên).",
    usedIn: "Hộp thư",
  },

  // --------------------------------------------------------------- AI (AI2, AI3)
  {
    key: "ai.suggestEnabled",
    group: "Trí tuệ nhân tạo",
    label: "Bật gợi ý câu trả lời theo kịch bản (AI2)",
    type: "boolean",
    defaultValue: "true",
    description:
      "Gợi ý dựa trên kịch bản bán hàng đang dùng. Sale sửa rồi tự bấm gửi, không bao giờ tự gửi. Chỉ chạy khi khách đã đồng ý xử lý dữ liệu.",
    usedIn: "Hộp thư",
  },
  {
    key: "ai.summaryEnabled",
    group: "Trí tuệ nhân tạo",
    label: "Bật tóm tắt hội thoại và bước tiếp theo (AI3)",
    type: "boolean",
    defaultValue: "true",
    description: "Không gửi dữ liệu y khoa lên AI. Kết quả lưu vào lịch sử khách.",
    usedIn: "Hộp thư",
  },

  // ------------------------------------------------------ AI5, AI6 (Lô 6)
  {
    key: "ai.reengageEnabled",
    group: "Trí tuệ nhân tạo",
    label: "Bật soạn nháp tin chăm lại khách im lặng (AI5)",
    type: "boolean",
    defaultValue: "true",
    description:
      "Mỗi ngày AI soạn nháp tin cho khách im lặng lâu, đưa vào hàng chờ duyệt. Sale duyệt, sửa rồi mới vào hàng đợi gửi theo nhóm. Không bao giờ tự gửi. Chỉ soạn cho khách đã đồng ý xử lý dữ liệu và không từ chối nhận tin.",
    usedIn: "Nháp tin chăm lại",
  },
  {
    key: "ai.reengageSilentDays",
    group: "Trí tuệ nhân tạo",
    label: "Khách im lặng bao nhiêu ngày thì soạn nháp chăm lại (AI5)",
    type: "number",
    defaultValue: "30",
    description: "Không có lần chạm nào trong số ngày này (bộ lọc nhóm khách im lặng của F11).",
    usedIn: "Nháp tin chăm lại",
    min: 7,
    max: 365,
  },
  {
    key: "ai.reengageDailyLimit",
    group: "Trí tuệ nhân tạo",
    label: "Số nháp tối đa mỗi ngày (AI5)",
    type: "number",
    defaultValue: "30",
    description: "Giới hạn số lần gọi AI mỗi ngày để kiểm soát chi phí và khối lượng sale phải duyệt.",
    usedIn: "Nháp tin chăm lại",
    min: 1,
    max: 500,
  },
  {
    key: "ai.reengageCooldownDays",
    group: "Trí tuệ nhân tạo",
    label: "Không soạn lại cho cùng khách trong bao nhiêu ngày (AI5)",
    type: "number",
    defaultValue: "30",
    description: "Khách đã có nháp (kể cả đã từ chối) trong khoảng này thì bỏ qua.",
    usedIn: "Nháp tin chăm lại",
    min: 1,
    max: 365,
  },
  {
    key: "ai.briefingEnabled",
    group: "Trí tuệ nhân tạo",
    label: "Bật bản tin sáng cho quản lý (AI6)",
    type: "boolean",
    defaultValue: "true",
    description:
      "7h00 mỗi ngày tổng hợp số liệu hôm qua (chỉ số tổng, không có tên, SĐT khách), AI viết đoạn tóm tắt. AI chưa cấu hình thì gửi bản số liệu thuần.",
    usedIn: "Trang chủ quản lý, Thông báo",
  },
  {
    key: "ai.briefingHour",
    group: "Trí tuệ nhân tạo",
    label: "Giờ gửi bản tin sáng (giờ Việt Nam, AI6)",
    type: "number",
    defaultValue: "7",
    description: "Tác vụ chạy từ giờ này trở đi, mỗi ngày một lần.",
    usedIn: "Trang chủ quản lý",
    min: 0,
    max: 23,
  },


  // ------------------------------------------------ LƯƠNG THƯỞNG THEO BIÊN BẢN COACHING (F17)
  {
    key: "payroll.salesRoles",
    group: "Lương thưởng",
    label: "Vai trò tính lương cứng theo bậc khách đến và thưởng doanh số",
    type: "text",
    defaultValue: "TELESALE,TU_VAN_VIEN",
    description: "Mã vai trò cách nhau dấu phẩy. Người có một trong các vai này được tính lương cứng theo bậc và thưởng doanh số.",
    usedIn: "Kỳ lương",
    validate: validateRoleList,
  },
  {
    key: "payroll.baseSalaryDefault",
    group: "Lương thưởng",
    label: "Lương cứng bậc thấp nhất (đồng)",
    type: "number",
    defaultValue: "7000000",
    description: "Áp khi số khách đến trong tháng chưa vượt ngưỡng bậc đầu tiên (mặc định từ 100 khách trở xuống).",
    usedIn: "Kỳ lương",
    min: 0,
    max: 1_000_000_000,
  },
  {
    key: "payroll.baseSalaryTiers",
    group: "Lương thưởng",
    label: "Bậc lương cứng theo số khách đến trong tháng (vượt ngưỡng:lương)",
    type: "text",
    defaultValue: "100:8000000,150:10000000,200:13000000",
    description: "Dạng ngưỡng:lương, cách nhau dấu phẩy. \"100:8000000\" nghĩa là trên 100 khách đến thì lương cứng 8 triệu. Khách đến tính theo khách do sale phụ trách, mỗi khách mỗi ngày một lần.",
    usedIn: "Kỳ lương",
    validate: validateTiers,
  },
  {
    key: "payroll.bonusScheme",
    group: "Lương thưởng",
    label: "Phương án thưởng doanh số",
    type: "select",
    defaultValue: "MILESTONE",
    options: [
      { value: "MILESTONE", label: "Thưởng theo mốc (đạt mốc nhận số tiền cố định)" },
      { value: "PERCENT_TIER", label: "Thưởng % theo bậc doanh thu" },
    ],
    description: "Chỉ một phương án được dùng cho mỗi kỳ. Doanh thu là tiền ĐÃ THU trong kỳ của khách do sale chốt.",
    usedIn: "Kỳ lương",
  },
  {
    key: "payroll.revenueUnitVnd",
    group: "Lương thưởng",
    label: "Đơn vị của mốc doanh thu (đồng)",
    type: "number",
    defaultValue: "1000000",
    description: "Mặc định 1.000.000: mốc \"300\" nghĩa là 300 triệu đồng doanh thu.",
    usedIn: "Kỳ lương",
    min: 1,
    max: 1_000_000_000,
  },
  {
    key: "payroll.bonusMilestones",
    group: "Lương thưởng",
    label: "Phương án mốc: mốc doanh thu:tiền thưởng",
    type: "text",
    defaultValue: "300:1000000,500:3000000,1000:10000000",
    description: "Đạt mốc cao nhất nào thì nhận tiền thưởng của mốc đó (không cộng dồn các mốc).",
    usedIn: "Kỳ lương",
    validate: validateTiers,
  },
  {
    key: "payroll.bonusPercentTiers",
    group: "Lương thưởng",
    label: "Phương án % bậc: mốc doanh thu:% thưởng",
    type: "text",
    defaultValue: "100:1,200:1.5,300:3,500:4",
    description: "Đạt bậc cao nhất nào thì lấy % của bậc đó nhân với toàn bộ doanh thu được tính.",
    usedIn: "Kỳ lương",
    validate: validateTiers,
  },
  {
    key: "payroll.fullSalePercent",
    group: "Lương thưởng",
    label: "Bán full: phần doanh thu tính cho sale (%)",
    type: "percent",
    defaultValue: "100",
    description: "Hợp đồng sale chốt từ A đến Z. Phần này cộng vào doanh thu tính thưởng của sale.",
    usedIn: "Kỳ lương",
    min: 0,
    max: 100,
  },
  {
    key: "payroll.partialSalePercent",
    group: "Lương thưởng",
    label: "Bán phần: phần doanh thu tính cho sale (%)",
    type: "percent",
    defaultValue: "50",
    description: "Hợp đồng sale kéo khách đến, bác sĩ chốt. Phần còn lại ghi cho bác sĩ chốt.",
    usedIn: "Kỳ lương",
    min: 0,
    max: 100,
  },
  {
    key: "payroll.doctorCloseBonusPercent",
    group: "Lương thưởng",
    label: "Bán phần: % thưởng cho bác sĩ chốt trên phần doanh thu của bác sĩ",
    type: "percent",
    defaultValue: "0",
    description: "0 = chưa trả thưởng cho bác sĩ chốt (chờ chủ đầu tư chốt mức). Phần doanh thu vẫn hiện trong chi tiết kỳ lương.",
    usedIn: "Kỳ lương",
    min: 0,
    max: 100,
  },
  {
    key: "payroll.upsellPercent",
    group: "Lương thưởng",
    label: "Upsale: % doanh thu upsale cho kỹ thuật viên",
    type: "percent",
    defaultValue: "3",
    description: "Dòng hợp đồng đánh dấu upsale gắn kỹ thuật viên; tính trên tiền đã thu trong kỳ phân bổ cho dòng đó.",
    usedIn: "Kỳ lương",
    min: 0,
    max: 100,
  },
  {
    key: "payroll.adsRoles",
    group: "Lương thưởng",
    label: "Vai trò người chạy quảng cáo",
    type: "text",
    defaultValue: "MARKETING",
    description: "Người có vai này hưởng % theo doanh thu từ quảng cáo Facebook của cơ sở.",
    usedIn: "Kỳ lương",
    validate: validateRoleList,
  },
  {
    key: "payroll.adsChannelKeys",
    group: "Lương thưởng",
    label: "Mã kênh tính là quảng cáo Facebook",
    type: "text",
    defaultValue: "facebook,messenger,instagram",
    description: "Khách thuộc kênh này và có chiến dịch hoặc mã quảng cáo mới tính vào doanh thu từ quảng cáo.",
    usedIn: "Kỳ lương · Chỉ số tuần",
  },
  {
    key: "payroll.adsPercentTiers",
    group: "Lương thưởng",
    label: "% cho người chạy ads theo doanh thu từ quảng cáo Facebook (mốc:%)",
    type: "text",
    defaultValue: "1000:0.5,1500:0.8,2500:1,5000:1.2,7000:1.5,10000:1.8",
    description: "Mốc theo đơn vị doanh thu ở trên (mặc định triệu đồng): 1000 = 1 tỷ. Đạt bậc cao nhất nào lấy % của bậc đó nhân toàn bộ doanh thu quảng cáo đã thu trong kỳ.",
    usedIn: "Kỳ lương",
    validate: validateTiers,
  },

  // ------------------------------------------------ THI ĐUA (F18)
  {
    key: "contest.monthlyShowupTarget",
    group: "Thi đua",
    label: "Mục tiêu số khách đến trong tháng của cả đội",
    type: "number",
    defaultValue: "0",
    description: "Hiện thanh tiến độ trên trang chủ. 0 = chưa đặt mục tiêu.",
    usedIn: "Trang chủ · Bảng thi đua",
    min: 0,
    max: 1_000_000,
  },

  // ------------------------------------------------ GIỚI THIỆU, SINH NHẬT, VOUCHER (F19, F20)
  {
    key: "referral.enabled",
    group: "Giới thiệu & Voucher",
    label: "Bật thưởng giới thiệu khách",
    type: "boolean",
    defaultValue: "true",
    description: "Khách mới có người giới thiệu làm xong dịch vụ lần đầu thì người giới thiệu được thưởng một lần.",
    usedIn: "Hồ sơ khách · Hoàn tất lần thực hiện",
  },
  {
    key: "referral.rewardKind",
    group: "Giới thiệu & Voucher",
    label: "Hình thức thưởng giới thiệu",
    type: "select",
    defaultValue: "VOUCHER",
    options: [
      { value: "VOUCHER", label: "Voucher cho người giới thiệu" },
      { value: "CASH", label: "Tiền mặt (kế toán chi)" },
    ],
    description: "Voucher phát ngay vào hồ sơ người giới thiệu; tiền mặt tạo khoản chờ chi.",
    usedIn: "Thưởng giới thiệu",
  },
  {
    key: "referral.rewardAmount",
    group: "Giới thiệu & Voucher",
    label: "Giá trị thưởng giới thiệu (đồng)",
    type: "number",
    defaultValue: "500000",
    description: "Giá trị voucher hoặc số tiền thưởng cho mỗi khách mới được giới thiệu.",
    usedIn: "Thưởng giới thiệu",
    min: 0,
    max: 100_000_000,
  },
  {
    key: "referral.voucherValidDays",
    group: "Giới thiệu & Voucher",
    label: "Hạn dùng voucher thưởng giới thiệu (ngày)",
    type: "number",
    defaultValue: "90",
    description: "Tính từ ngày phát voucher.",
    usedIn: "Thưởng giới thiệu",
    min: 1,
    max: 3650,
  },
  {
    key: "automation.birthday.enabled",
    group: "Tự động hoá",
    label: "Nhắc sale chúc mừng sinh nhật khách",
    type: "boolean",
    defaultValue: "true",
    description: "Mỗi ngày tạo việc cho sale phụ trách với khách có sinh nhật (theo ngày sinh trong hồ sơ).",
    usedIn: "Việc của tôi",
  },
  {
    key: "automation.birthday.leadDays",
    group: "Tự động hoá",
    label: "Nhắc sinh nhật trước bao nhiêu ngày",
    type: "number",
    defaultValue: "0",
    description: "0 = nhắc đúng ngày sinh nhật.",
    usedIn: "Việc của tôi",
    min: 0,
    max: 30,
  },

  // ------------------------------------------------ BÁO CÁO ĐỢT 3 (F23, F31)
  {
    key: "report.responseFastMinutes",
    group: "Báo cáo",
    label: "Phản hồi đầu tiên nhanh: dưới bao nhiêu phút",
    type: "number",
    defaultValue: "5",
    description: "Nhóm 1 của báo cáo tốc độ trả lời so với tỉ lệ chốt.",
    usedIn: "Báo cáo tốc độ trả lời",
    min: 1,
    max: 120,
  },
  {
    key: "report.responseSlowMinutes",
    group: "Báo cáo",
    label: "Phản hồi đầu tiên chậm: trên bao nhiêu phút",
    type: "number",
    defaultValue: "30",
    description: "Nhóm 3 của báo cáo tốc độ trả lời. Ở giữa hai ngưỡng là nhóm 2.",
    usedIn: "Báo cáo tốc độ trả lời",
    min: 2,
    max: 1440,
  },
  {
    key: "retention.dueSoonDays",
    group: "Báo cáo",
    label: "Danh sách đến hạn tái tiêm: gồm khách đến hạn trong bao nhiêu ngày tới",
    type: "number",
    defaultValue: "14",
    description: "Khách đã quá hạn tái tiêm luôn nằm trong danh sách.",
    usedIn: "Báo cáo quay lại",
    min: 0,
    max: 180,
  },

  // ------------------------------------------------ AI4
  {
    key: "ai.scoringEnabled",
    group: "Trí tuệ nhân tạo",
    label: "Bật chấm hội thoại theo kịch bản mỗi tuần (AI4)",
    type: "boolean",
    defaultValue: "true",
    description:
      "Tác vụ nền chấm các hội thoại tuần trước theo kịch bản đang dùng. Chỉ chấm hội thoại của khách đã đồng ý xử lý dữ liệu. Điểm chỉ để quản lý kèm cặp, không trừ lương tự động.",
    usedIn: "Chấm hội thoại",
  },
  {
    key: "ai.scoringBatchSize",
    group: "Trí tuệ nhân tạo",
    label: "Số hội thoại chấm tối đa mỗi lần chạy",
    type: "number",
    defaultValue: "50",
    description: "Giới hạn chi phí AI mỗi lần tác vụ chạy. Hội thoại chưa chấm sẽ được chấm lần sau trong cùng tuần.",
    usedIn: "Chấm hội thoại",
    min: 1,
    max: 1000,
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

  {
    key: "security.loginMaxAttempts",
    group: "Bảo mật",
    label: "Số lần nhập sai mật khẩu liên tiếp trước khi khoá tạm tài khoản",
    type: "number",
    defaultValue: "5",
    description:
      "Sai liên tiếp đủ số lần này thì tài khoản bị khoá tạm, kể cả nhập đúng mật khẩu sau đó cũng không vào được cho tới hết thời gian khoá.",
    usedIn: "Đăng nhập",
    min: 3,
    max: 20,
  },
  {
    key: "security.loginLockMinutes",
    group: "Bảo mật",
    label: "Thời gian khoá tạm tài khoản sau khi sai mật khẩu nhiều lần (phút)",
    type: "number",
    defaultValue: "15",
    description: "Hết thời gian này tài khoản tự mở lại. Quản trị có thể đặt lại mật khẩu để mở sớm.",
    usedIn: "Đăng nhập",
    min: 1,
    max: 1440,
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


  // ------------------------------------------------ Lô 7 · CRM 360 LÔ A
  {
    key: "pipeline.stageMaxDays.TIEP_CAN",
    group: "Bảng bước khách & CRM 360",
    label: "Số ngày tối đa ở bước Tiếp cận (quá thì thẻ đỏ)",
    type: "number",
    defaultValue: "1",
    description: "Khách nằm ở bước này quá số ngày (tính từ lần vào bước gần nhất trong lịch sử bước) thì thẻ viền đỏ, đếm vào quá hạn. 0 = không tính quá hạn ở bước này.",
    usedIn: "Bảng bước khách · Thanh 360",
    min: 0,
    max: 365,
  },
  {
    key: "pipeline.stageMaxDays.NHAN_TIN",
    group: "Bảng bước khách & CRM 360",
    label: "Số ngày tối đa ở bước Nhắn tin (quá thì thẻ đỏ)",
    type: "number",
    defaultValue: "3",
    description: "Khách nằm ở bước này quá số ngày (tính từ lần vào bước gần nhất trong lịch sử bước) thì thẻ viền đỏ, đếm vào quá hạn. 0 = không tính quá hạn ở bước này.",
    usedIn: "Bảng bước khách · Thanh 360",
    min: 0,
    max: 365,
  },
  {
    key: "pipeline.stageMaxDays.CO_ANH",
    group: "Bảng bước khách & CRM 360",
    label: "Số ngày tối đa ở bước Có ảnh (quá thì thẻ đỏ)",
    type: "number",
    defaultValue: "3",
    description: "Khách nằm ở bước này quá số ngày (tính từ lần vào bước gần nhất trong lịch sử bước) thì thẻ viền đỏ, đếm vào quá hạn. 0 = không tính quá hạn ở bước này.",
    usedIn: "Bảng bước khách · Thanh 360",
    min: 0,
    max: 365,
  },
  {
    key: "pipeline.stageMaxDays.LICH_COC",
    group: "Bảng bước khách & CRM 360",
    label: "Số ngày tối đa ở bước Lịch cọc (quá thì thẻ đỏ)",
    type: "number",
    defaultValue: "7",
    description: "Khách nằm ở bước này quá số ngày (tính từ lần vào bước gần nhất trong lịch sử bước) thì thẻ viền đỏ, đếm vào quá hạn. 0 = không tính quá hạn ở bước này.",
    usedIn: "Bảng bước khách · Thanh 360",
    min: 0,
    max: 365,
  },
  {
    key: "pipeline.stageMaxDays.DEN_CO_SO",
    group: "Bảng bước khách & CRM 360",
    label: "Số ngày tối đa ở bước Đến cơ sở (quá thì thẻ đỏ)",
    type: "number",
    defaultValue: "1",
    description: "Khách nằm ở bước này quá số ngày (tính từ lần vào bước gần nhất trong lịch sử bước) thì thẻ viền đỏ, đếm vào quá hạn. 0 = không tính quá hạn ở bước này.",
    usedIn: "Bảng bước khách · Thanh 360",
    min: 0,
    max: 365,
  },
  {
    key: "pipeline.stageMaxDays.LAM_DICH_VU",
    group: "Bảng bước khách & CRM 360",
    label: "Số ngày tối đa ở bước Làm dịch vụ (quá thì thẻ đỏ)",
    type: "number",
    defaultValue: "0",
    description: "Khách nằm ở bước này quá số ngày (tính từ lần vào bước gần nhất trong lịch sử bước) thì thẻ viền đỏ, đếm vào quá hạn. 0 = không tính quá hạn ở bước này.",
    usedIn: "Bảng bước khách · Thanh 360",
    min: 0,
    max: 365,
  },
  {
    key: "pipeline.stageMaxDays.QUAY_LAI",
    group: "Bảng bước khách & CRM 360",
    label: "Số ngày tối đa ở bước Quay lại (quá thì thẻ đỏ)",
    type: "number",
    defaultValue: "0",
    description: "Khách nằm ở bước này quá số ngày (tính từ lần vào bước gần nhất trong lịch sử bước) thì thẻ viền đỏ, đếm vào quá hạn. 0 = không tính quá hạn ở bước này.",
    usedIn: "Bảng bước khách · Thanh 360",
    min: 0,
    max: 365,
  },
  {
    key: "pipeline.stageMaxDays.default",
    group: "Bảng bước khách & CRM 360",
    label: "Số ngày tối đa ở các bước còn lại (chế độ phẫu thuật, bước chưa khai riêng)",
    type: "number",
    defaultValue: "7",
    description: "Dùng cho bước không có tham số riêng. 0 = không tính quá hạn. Bước mất khách không bao giờ tính quá hạn.",
    usedIn: "Bảng bước khách · Thanh 360",
    min: 0,
    max: 365,
  },
  {
    key: "pipeline.warnPercent",
    group: "Bảng bước khách & CRM 360",
    label: "Sắp quá hạn khi đã dùng bao nhiêu % số ngày tối đa của bước",
    type: "percent",
    defaultValue: "70",
    description: "Ví dụ ngưỡng 3 ngày, 70%: ngày thứ 3 thẻ viền vàng (sắp quá hạn), từ ngày thứ 4 viền đỏ.",
    usedIn: "Bảng bước khách",
    min: 1,
    max: 100,
  },
  {
    key: "pipeline.conversionDays",
    group: "Bảng bước khách & CRM 360",
    label: "Kỳ tính tỉ lệ chuyển giữa các cột (ngày gần nhất)",
    type: "number",
    defaultValue: "30",
    description: "Tỉ lệ chuyển = số khách vào bước trong kỳ rồi đã sang một bước sau / số khách vào bước trong kỳ (đọc lịch sử bước).",
    usedIn: "Đầu cột bảng bước · Dải phễu",
    min: 7,
    max: 365,
  },
  {
    key: "heat.recentDays",
    group: "Bảng bước khách & CRM 360",
    label: "Nhiệt độ: tương tác trong bao nhiêu ngày thì tính là gần",
    type: "number",
    defaultValue: "3",
    description: "Tương tác = khách nhắn tin vào hoặc khách đến cơ sở.",
    usedIn: "Nhiệt độ khách (nóng, ấm, lạnh)",
    min: 1,
    max: 60,
  },
  {
    key: "heat.weight.recent",
    group: "Bảng bước khách & CRM 360",
    label: "Nhiệt độ: điểm cho tương tác gần",
    type: "number",
    defaultValue: "2",
    description: "Cộng điểm khi khách tương tác trong số ngày ở trên.",
    usedIn: "Nhiệt độ khách",
    min: 0,
    max: 10,
  },
  {
    key: "heat.weight.photo",
    group: "Bảng bước khách & CRM 360",
    label: "Nhiệt độ: điểm khi khách đã gửi ảnh hoặc có ảnh tư vấn",
    type: "number",
    defaultValue: "1",
    description: "Cộng điểm khi hồ sơ có ít nhất một bộ ảnh.",
    usedIn: "Nhiệt độ khách",
    min: 0,
    max: 10,
  },
  {
    key: "heat.weight.appointment",
    group: "Bảng bước khách & CRM 360",
    label: "Nhiệt độ: điểm khi khách có lịch hẹn sắp tới",
    type: "number",
    defaultValue: "2",
    description: "Lịch chưa huỷ, chưa vắng, giờ hẹn từ bây giờ trở đi.",
    usedIn: "Nhiệt độ khách",
    min: 0,
    max: 10,
  },
  {
    key: "heat.weight.quote",
    group: "Bảng bước khách & CRM 360",
    label: "Nhiệt độ: điểm khi khách có báo giá đang mở",
    type: "number",
    defaultValue: "1",
    description: "Báo giá nháp, đã gửi hoặc khách đồng ý, chưa có hợp đồng, chưa hết hạn, không bị từ chối.",
    usedIn: "Nhiệt độ khách",
    min: 0,
    max: 10,
  },
  {
    key: "heat.hotMin",
    group: "Bảng bước khách & CRM 360",
    label: "Nhiệt độ: tổng điểm từ mức này là Nóng",
    type: "number",
    defaultValue: "4",
    description: "Tổng điểm = cộng các điểm ở trên. Khách ở bước mất khách luôn là Lạnh.",
    usedIn: "Nhiệt độ khách · Lọc Nóng",
    min: 1,
    max: 40,
  },
  {
    key: "heat.warmMin",
    group: "Bảng bước khách & CRM 360",
    label: "Nhiệt độ: tổng điểm từ mức này là Ấm (dưới là Lạnh)",
    type: "number",
    defaultValue: "2",
    description: "Phải nhỏ hơn hoặc bằng mức Nóng.",
    usedIn: "Nhiệt độ khách",
    min: 0,
    max: 40,
  },
  {
    key: "quote.packageDiscountPercent",
    group: "Bảng bước khách & CRM 360",
    label: "Báo giá 3 phương án: % ưu đãi thêm cho phương án Trọn gói",
    type: "percent",
    defaultValue: "0",
    description:
      "Giảm thêm ngoài đợt ưu đãi đang chạy cho phương án Trọn gói. Luôn bị chặn bởi trần giảm theo vai của người lập (discount.capPercent.*): vượt trần thì chỉ giảm tới trần. 0 = không giảm thêm.",
    usedIn: "Báo giá 3 phương án · Màn chốt tại quầy",
    min: 0,
    max: 100,
  },
  {
    key: "upsell.maxSuggestions",
    group: "Bảng bước khách & CRM 360",
    label: "Số gợi ý bán kèm tối đa mỗi khách",
    type: "number",
    defaultValue: "3",
    description: "Gợi ý xếp theo độ ưu tiên của luật.",
    usedIn: "Phiếu tư vấn · Màn chốt tại quầy · Hộp thư",
    min: 1,
    max: 10,
  },
  {
    key: "upsell.declineCooldownDays",
    group: "Bảng bước khách & CRM 360",
    label: "Báo giá 3 phương án: không tự cộng dịch vụ bán kèm khách đã từ chối trong số ngày này",
    type: "number",
    defaultValue: "30",
    description:
      "Khách đã bấm Từ chối một gợi ý bán kèm trong khoảng này thì phương án Trọn gói KHÔNG tự cộng dịch vụ đó (hiện dòng ghi chú để tư vấn viên biết). Gợi ý vẫn hiện ở danh sách bán kèm kèm nhãn Khách từ chối. 0 = luôn cộng như trước.",
    usedIn: "Báo giá 3 phương án · Màn chốt tại quầy",
    min: 0,
    max: 365,
  },

  // ------------------------------------------------ Lô 8 · CRM 360 LÔ B
  {
    key: "pipeline.subStages",
    group: "CRM 360: cơ hội, bước con, báo cáo",
    label: "Bước con của từng bước (P4)",
    type: "text",
    defaultValue: "LICH_COC:HEN_CHUA_COC=Đã hẹn chưa cọc|DA_COC=Đã cọc;HEN:HEN_CHUA_COC=Đã hẹn chưa cọc|DA_COC=Đã cọc",
    description:
      "Dạng BƯỚC:MÃ=Nhãn|MÃ=Nhãn; nhiều bước cách nhau dấu chấm phẩy. Hai mã HEN_CHUA_COC và DA_COC tự tính theo cọc của lịch hẹn sắp tới; mã khác do sale chọn tay trên thẻ.",
    usedIn: "Bảng bước khách · Cơ hội",
    validate: validateSubStages,
  },
  {
    key: "pipeline.wipLimits",
    group: "CRM 360: cơ hội, bước con, báo cáo",
    label: "Giới hạn số thẻ mỗi cột (P4)",
    type: "text",
    defaultValue: "",
    description:
      "Dạng BƯỚC:số, cách nhau dấu phẩy, ví dụ LICH_COC:40,DEN_CO_SO:20. Cột vượt giới hạn hiện cảnh báo (không chặn). Để trống = không giới hạn.",
    usedIn: "Bảng bước khách",
    validate: validateStageNumbers,
  },
  {
    key: "pipeline.requireAppointmentStages",
    group: "CRM 360: cơ hội, bước con, báo cáo",
    label: "Bước bắt buộc phải có lịch hẹn khi kéo sang (P4)",
    type: "text",
    defaultValue: "LICH_COC,HEN",
    description: "Mã bước cách nhau dấu phẩy. Kéo tay sang bước này mà khách chưa có lịch hẹn sắp tới thì bị chặn và mở form đặt lịch. Để trống = không bắt buộc.",
    usedIn: "Đổi bước tay · Bảng bước khách",
    validate: validateStageList,
  },
  {
    key: "pipeline.requireContractStages",
    group: "CRM 360: cơ hội, bước con, báo cáo",
    label: "Bước bắt buộc phải có hợp đồng khi kéo sang (P4)",
    type: "text",
    defaultValue: "LAM_DICH_VU,QUAY_LAI,PT",
    description: "Mã bước cách nhau dấu phẩy. Kéo tay sang bước này mà cơ hội chưa có hợp đồng (chưa huỷ) thì bị chặn và mở form tạo hợp đồng. Sự kiện thật (hoàn tất lần thực hiện) vẫn tự chuyển bước. Để trống = không bắt buộc.",
    usedIn: "Đổi bước tay · Bảng bước khách",
    validate: validateStageList,
  },
  {
    key: "pipeline.stageTasks.enabled",
    group: "CRM 360: cơ hội, bước con, báo cáo",
    label: "Tự tạo việc theo checklist khi cơ hội vào bước (J3)",
    type: "boolean",
    defaultValue: "true",
    description: "Checklist từng bước khai ở màn Việc theo bước. Tắt thì không sinh việc mới, checklist vẫn xem được.",
    usedIn: "Đổi bước · Việc của tôi",
  },
  {
    key: "opportunity.autoOpenEvents",
    group: "CRM 360: cơ hội, bước con, báo cáo",
    label: "Sự kiện tự mở cơ hội mới cho khách đã làm dịch vụ (P6)",
    type: "text",
    defaultValue: "DEPOSIT_CONFIRMED,CHECK_IN",
    description:
      "Khách đã làm dịch vụ (cơ hội đã thắng) có sự kiện này thì mở cơ hội mới thay vì giữ bước cũ. Mã: MESSAGE, PHOTO, DEPOSIT_CONFIRMED, CHECK_IN. Mặc định không tính tin nhắn và ảnh vì khách chăm sóc sau tiêm vẫn nhắn, gửi ảnh. Để trống = chỉ mở tay.",
    usedIn: "Tự chuyển bước khách",
    validate: validateEventList,
  },
  {
    key: "opportunity.reopenMinDays",
    group: "CRM 360: cơ hội, bước con, báo cáo",
    label: "Không tự mở cơ hội mới trong bao nhiêu ngày sau lần làm dịch vụ",
    type: "number",
    defaultValue: "14",
    description: "Khách tái khám, chăm sóc sau tiêm trong khoảng này thì check-in không mở cơ hội mới. Khách đang có gói liệu trình còn buổi cũng không tự mở.",
    usedIn: "Tự chuyển bước khách",
    min: 0,
    max: 365,
  },
  {
    key: "needs.budgetOptions",
    group: "CRM 360: cơ hội, bước con, báo cáo",
    label: "Hồ sơ nhu cầu: các mức ngân sách (C3)",
    type: "text",
    defaultValue: "Dưới 5 triệu,5 đến 10 triệu,10 đến 20 triệu,20 đến 50 triệu,Trên 50 triệu",
    description: "Các lựa chọn bấm nhanh, cách nhau dấu phẩy.",
    usedIn: "Hồ sơ khách · Hồ sơ nhu cầu",
    validate: validateOptionList,
  },
  {
    key: "needs.fearOptions",
    group: "CRM 360: cơ hội, bước con, báo cáo",
    label: "Hồ sơ nhu cầu: nỗi sợ, băn khoăn (C3)",
    type: "text",
    defaultValue: "Đau,Sưng bầm,Không tự nhiên,Biến chứng,Phải nghỉ dưỡng,Giá cao,Sợ người khác biết",
    description: "Các lựa chọn bấm nhanh, cách nhau dấu phẩy.",
    usedIn: "Hồ sơ khách · Hồ sơ nhu cầu",
    validate: validateOptionList,
  },
  {
    key: "needs.decisionMakerOptions",
    group: "CRM 360: cơ hội, bước con, báo cáo",
    label: "Hồ sơ nhu cầu: người quyết định (C3)",
    type: "text",
    defaultValue: "Tự quyết,Chồng hoặc người yêu,Bố mẹ,Bạn bè,Người khác trả tiền",
    description: "Các lựa chọn bấm nhanh, cách nhau dấu phẩy.",
    usedIn: "Hồ sơ khách · Hồ sơ nhu cầu",
    validate: validateOptionList,
  },
  {
    key: "needs.occasionOptions",
    group: "CRM 360: cơ hội, bước con, báo cáo",
    label: "Hồ sơ nhu cầu: dịp (C3)",
    type: "text",
    defaultValue: "Cưới,Tết,Sinh nhật,Chụp ảnh hoặc sự kiện,Du lịch,Không có dịp",
    description: "Các lựa chọn bấm nhanh, cách nhau dấu phẩy.",
    usedIn: "Hồ sơ khách · Hồ sơ nhu cầu",
    validate: validateOptionList,
  },
  {
    key: "quote.rejectFollowupDays",
    group: "CRM 360: cơ hội, bước con, báo cáo",
    label: "Báo giá bị từ chối: chăm lại sau bao nhiêu ngày (V6)",
    type: "number",
    defaultValue: "14",
    description: "Khách từ chối báo giá (bắt buộc ghi lý do) thì tự tạo việc chăm lại cho sale phụ trách, hạn sau số ngày này.",
    usedIn: "Báo giá · Việc của tôi",
    min: 1,
    max: 365,
  },
  {
    key: "package.reminderIntervalDays",
    group: "CRM 360: cơ hội, bước con, báo cáo",
    label: "Gói liệu trình: nhắc đặt buổi tiếp sau bao nhiêu ngày (V3)",
    type: "number",
    defaultValue: "30",
    description: "Tính từ buổi dùng gần nhất (chưa dùng buổi nào thì từ ngày lập gói). Gói khai số ngày riêng thì theo gói. Khách đã có lịch hẹn sắp tới thì không nhắc.",
    usedIn: "Tác vụ nền nhắc gói liệu trình",
    min: 1,
    max: 365,
  },
  {
    key: "package.defaultValidDays",
    group: "CRM 360: cơ hội, bước con, báo cáo",
    label: "Gói liệu trình: hạn dùng mặc định (ngày) (V3)",
    type: "number",
    defaultValue: "365",
    description: "Hạn dùng gợi ý khi lập gói; người lập sửa được. 0 = không có hạn.",
    usedIn: "Gói liệu trình",
    min: 0,
    max: 3650,
  },
  {
    key: "automation.packageReminder.enabled",
    group: "Tự động hoá",
    label: "Nhắc đặt buổi tiếp của gói liệu trình",
    type: "boolean",
    defaultValue: "true",
    description: "Tạo việc cho sale khi khách có gói còn buổi mà quá số ngày nhắc chưa đặt lịch.",
    usedIn: "Tác vụ nền",
  },
  {
    key: "report.crm360.defaultDays",
    group: "CRM 360: cơ hội, bước con, báo cáo",
    label: "Kỳ mặc định của báo cáo hành trình, giá trị đơn (ngày)",
    type: "number",
    defaultValue: "90",
    description: "Màn Báo cáo CRM 360 mở sẵn kỳ này; người xem đổi được.",
    usedIn: "Báo cáo CRM 360",
    min: 7,
    max: 1095,
  },
  {
    key: "forecast.minSamples",
    group: "CRM 360: cơ hội, bước con, báo cáo",
    label: "Dự báo: số cơ hội đã có kết quả tối thiểu để tính xác suất một bước (V7)",
    type: "number",
    defaultValue: "30",
    description: "Dưới số này thì bước hiện \"chưa đủ dữ liệu\" và không cộng vào dự báo. Không bao giờ dùng xác suất đoán.",
    usedIn: "Dự báo pipeline",
    min: 5,
    max: 10000,
  },
  {
    key: "forecast.lookbackDays",
    group: "CRM 360: cơ hội, bước con, báo cáo",
    label: "Dự báo: lấy lịch sử bước bao nhiêu ngày gần nhất (V7)",
    type: "number",
    defaultValue: "365",
    description: "Xác suất mỗi bước = số cơ hội vào bước trong khoảng này rồi thắng / số cơ hội đã có kết quả (thắng hoặc mất).",
    usedIn: "Dự báo pipeline",
    min: 30,
    max: 3650,
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

/** Tham số dạng danh sách "a,b,c" (bỏ khoảng trắng, bỏ mục rỗng). */
export async function getSettingList(key: string): Promise<string[]> {
  return (await getSettingRaw(key))
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
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
