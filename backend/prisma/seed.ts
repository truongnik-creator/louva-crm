import bcrypt from "bcrypt";
import { prisma } from "../src/lib/prisma";
import { bootstrap } from "../src/lib/bootstrap";
import { encryptNullable } from "../src/lib/crypto";
import { putEncrypted } from "../src/lib/storage";
import { RoleCode } from "../src/lib/rbac-catalog";
import {
  AnesthesiaType,
  AppointmentStatus,
  AppointmentType,
  ChannelKind,
  ConsentStatus,
  ConsentType,
  ContractStatus,
  ConversationKind,
  CustomerStatus,
  FunnelStage,
  Gender,
  InvoiceStatus,
  MessageDirection,
  MessageStatus,
  PaymentMethod,
  PhotoStage,
  ProcedureStatus,
  QuotationStatus,
  RoomType,
  ServiceKind,
  ShiftKind,
  VisitStatus,
} from "../src/types/enums";

// Dữ liệu mẫu dựng lại đúng bối cảnh trong crm-app/docs/prototype_tmv.html:
// cùng tên khách, cùng dịch vụ, cùng hội thoại Zalo, cùng lịch hẹn ngày làm
// việc và cùng 5 ca mổ — để mở app lên là thấy ngay màn hình như bản thiết kế.
//
// Chạy lại nhiều lần được: mọi thứ đều upsert theo mã, và toàn bộ khối demo bị
// bỏ qua nếu đã có khách trong CSDL.

const PASSWORD = "123456";

/** Ngày làm việc mẫu = hôm nay, giờ cố định để lưới lịch luôn có dữ liệu. */
function at(hour: number, minute = 0, dayOffset = 0): Date {
  const d = new Date();
  d.setDate(d.getDate() + dayOffset);
  d.setHours(hour, minute, 0, 0);
  return d;
}

function daysAgo(n: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

async function main() {
  // Dùng lại bootstrap để có sẵn cơ sở, danh mục quyền, vai trò và tài khoản
  // quản trị — seed chỉ lo phần dữ liệu nghiệp vụ demo.
  await bootstrap();

  // Cơ sở do bootstrap tạo (mặc định LOUVA, đổi được bằng biến CLINIC_CODE).
  const tmv = await prisma.branch.findFirstOrThrow({ orderBy: { createdAt: "asc" } });

  // ------------------------------------------------------------- PHÒNG BAN
  const departments = [
    { code: "LE_TAN", name: "Lễ tân" },
    { code: "KINH_DOANH", name: "Kinh doanh & Tư vấn" },
    { code: "CHUYEN_MON", name: "Chuyên môn thẩm mỹ" },
    { code: "DIEU_DUONG", name: "Điều dưỡng" },
    { code: "KE_TOAN", name: "Kế toán" },
    { code: "MARKETING", name: "Marketing" },
  ];
  for (const d of departments) {
    await prisma.department.upsert({
      where: { branchId_code: { branchId: tmv.id, code: d.code } },
      create: { ...d, branchId: tmv.id },
      update: { name: d.name },
    });
  }
  const deptByCode = new Map(
    (await prisma.department.findMany({ where: { branchId: tmv.id } })).map((d) => [d.code, d.id])
  );

  // ------------------------------------------------------------- NHÂN SỰ
  const roleByCode = new Map(
    (await prisma.role.findMany({ select: { id: true, code: true } })).map((r) => [r.code, r.id])
  );

  const staff = [
    { email: "giamdoc@louva.vn", name: "Giám đốc Louva", title: "", role: RoleCode.GIAM_DOC, dept: "CHUYEN_MON", branches: [tmv.id] },
    { email: "quanly@louva.vn", name: "Vũ Thanh Bình", title: "", role: RoleCode.QUAN_LY_CO_SO, dept: "KINH_DOANH", branches: [tmv.id] },
    { email: "letan@louva.vn", name: "Nguyễn Thị Thu Hiền", title: "", role: RoleCode.LE_TAN, dept: "LE_TAN", branches: [tmv.id] },
    { email: "thuha@louva.vn", name: "Trần Thu Hà", title: "", role: RoleCode.TU_VAN_VIEN, dept: "KINH_DOANH", branches: [tmv.id] },
    { email: "khanhlinh@louva.vn", name: "Đỗ Khánh Linh", title: "", role: RoleCode.TU_VAN_VIEN, dept: "KINH_DOANH", branches: [tmv.id] },
    { email: "minhngoc@louva.vn", name: "Phạm Minh Ngọc", title: "", role: RoleCode.TELESALE, dept: "KINH_DOANH", branches: [tmv.id] },
    { email: "haiyen@louva.vn", name: "Nguyễn Hải Yến", title: "", role: RoleCode.TELESALE, dept: "KINH_DOANH", branches: [tmv.id] },
    { email: "bs.tuan@louva.vn", name: "Lê Anh Tuấn", title: "BS", role: RoleCode.BAC_SI, dept: "CHUYEN_MON", branches: [tmv.id] },
    { email: "bs.huy@louva.vn", name: "Trịnh Quang Huy", title: "BS", role: RoleCode.BAC_SI, dept: "CHUYEN_MON", branches: [tmv.id] },
    { email: "bs.son@louva.vn", name: "Đinh Văn Sơn", title: "BS", role: RoleCode.BAC_SI, dept: "CHUYEN_MON", branches: [tmv.id] },
    { email: "dd.nhung@louva.vn", name: "Vũ Hồng Nhung", title: "ĐD", role: RoleCode.DIEU_DUONG, dept: "DIEU_DUONG", branches: [tmv.id] },
    { email: "dd.hanh@louva.vn", name: "Cao Thị Hạnh", title: "ĐD", role: RoleCode.DIEU_DUONG, dept: "DIEU_DUONG", branches: [tmv.id] },
    { email: "ketoan@louva.vn", name: "Lương Thị Vân Anh", title: "", role: RoleCode.KE_TOAN, dept: "KE_TOAN", branches: [tmv.id] },
    { email: "marketing@louva.vn", name: "Hoàng Đức Duy", title: "", role: RoleCode.MARKETING, dept: "MARKETING", branches: [tmv.id] },
  ];

  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  const userByEmail = new Map<string, string>();

  for (const s of staff) {
    const existing = await prisma.user.findUnique({ where: { email: s.email } });
    if (existing) {
      userByEmail.set(s.email, existing.id);
      continue;
    }
    const user = await prisma.user.create({
      data: {
        email: s.email,
        passwordHash,
        name: s.name,
        title: s.title || null,
        departmentId: deptByCode.get(s.dept) ?? null,
        roleLinks: { create: { roleId: roleByCode.get(s.role)! } },
        branches: {
          create: s.branches.map((branchId, i) => ({ branchId, isPrimary: i === 0 })),
        },
      },
    });
    userByEmail.set(s.email, user.id);
  }

  const uid = (email: string) => userByEmail.get(email)!;

  // ------------------------------------------------------------- PHÒNG
  const rooms = [
    { code: "PM1", name: "Phòng mổ 1", type: RoomType.OPERATING },
    { code: "PM2", name: "Phòng mổ 2", type: RoomType.OPERATING },
    { code: "PTP", name: "Phòng tiểu phẫu", type: RoomType.MINOR_OP },
    { code: "TV1", name: "Phòng tư vấn 1", type: RoomType.CONSULT },
    { code: "TV2", name: "Phòng tư vấn 2", type: RoomType.CONSULT },
    { code: "HS", name: "Phòng hồi sức", type: RoomType.RECOVERY },
  ];
  for (const r of rooms) {
    await prisma.room.upsert({
      where: { branchId_code: { branchId: tmv.id, code: r.code } },
      create: { ...r, branchId: tmv.id },
      update: { name: r.name, type: r.type },
    });
  }
  const roomByCode = new Map(
    (await prisma.room.findMany({ where: { branchId: tmv.id } })).map((r) => [r.code, r.id])
  );

  // ------------------------------------------------------------- CA LÀM VIỆC
  const shifts = [
    { code: "SANG", name: "Ca sáng", kind: ShiftKind.MORNING, startTime: "07:30", endTime: "12:00", color: "#177f4d" },
    { code: "CHIEU", name: "Ca chiều", kind: ShiftKind.AFTERNOON, startTime: "13:00", endTime: "17:30", color: "#1d4ed8" },
    { code: "CANGAY", name: "Cả ngày", kind: ShiftKind.FULL_DAY, startTime: "07:30", endTime: "17:30", color: "#0F5132" },
    { code: "TRUC", name: "Trực", kind: ShiftKind.ON_CALL, startTime: "17:30", endTime: "07:30", color: "#b45309" },
  ];
  for (const s of shifts) {
    await prisma.shiftTemplate.upsert({
      where: { branchId_code: { branchId: tmv.id, code: s.code } },
      create: { ...s, branchId: tmv.id },
      update: { name: s.name },
    });
  }

  // ------------------------------------------------------------- KÊNH KHÁCH
  const channels = [
    { key: "tiktok", name: "TikTok", kind: ChannelKind.TIKTOK },
    { key: "facebook", name: "Facebook", kind: ChannelKind.FACEBOOK },
    { key: "google", name: "Google", kind: ChannelKind.GOOGLE },
    { key: "gioi_thieu", name: "Giới thiệu", kind: ChannelKind.REFERRAL },
    { key: "khach_cu", name: "Khách cũ giới thiệu", kind: ChannelKind.REFERRAL },
    { key: "walk_in", name: "Khách vãng lai", kind: ChannelKind.WALK_IN },
  ];
  for (const c of channels) {
    await prisma.channel.upsert({ where: { key: c.key }, create: c, update: { name: c.name } });
  }
  const channelByKey = new Map((await prisma.channel.findMany()).map((c) => [c.key, c.id]));

  // ------------------------------------------------------------- DỊCH VỤ
  const categories = [
    { code: "MUI", name: "Mũi", sortOrder: 1 },
    { code: "MAT", name: "Mắt", sortOrder: 2 },
    { code: "NGUC", name: "Ngực", sortOrder: 3 },
    { code: "THAN_HINH", name: "Thân hình", sortOrder: 4 },
    { code: "DA", name: "Da & trẻ hoá", sortOrder: 5 },
    { code: "TOC", name: "Tóc", sortOrder: 6 },
  ];
  for (const c of categories) {
    await prisma.serviceCategory.upsert({ where: { code: c.code }, create: c, update: { name: c.name } });
  }
  const catByCode = new Map((await prisma.serviceCategory.findMany()).map((c) => [c.code, c.id]));

  const services = [
    { code: "DV-MUI-CT", name: "Nâng mũi cấu trúc", cat: "MUI", kind: ServiceKind.SURGERY, price: 38_000_000, min: 34_000_000, duration: 180, recovery: 10, anes: AnesthesiaType.SEDATION, lab: true },
    { code: "DV-MUI-SUON", name: "Nâng mũi cấu trúc sụn sườn", cat: "MUI", kind: ServiceKind.SURGERY, price: 68_000_000, min: 60_000_000, duration: 240, recovery: 14, anes: AnesthesiaType.GENERAL, lab: true },
    { code: "DV-MAT-CM", name: "Cắt mí trên", cat: "MAT", kind: ServiceKind.MINOR_PROCEDURE, price: 18_000_000, min: 15_000_000, duration: 90, recovery: 7, anes: AnesthesiaType.LOCAL, lab: false },
    { code: "DV-NGUC-NS", name: "Nâng ngực nội soi", cat: "NGUC", kind: ServiceKind.SURGERY, price: 98_000_000, min: 88_000_000, duration: 180, recovery: 14, anes: AnesthesiaType.GENERAL, lab: true },
    { code: "DV-BUNG-HM", name: "Hút mỡ bụng + tạo hình thành bụng", cat: "THAN_HINH", kind: ServiceKind.SURGERY, price: 56_000_000, min: 50_000_000, duration: 210, recovery: 10, anes: AnesthesiaType.GENERAL, lab: true },
    { code: "DV-FILLER-CAM", name: "Tiêm filler cằm", cat: "DA", kind: ServiceKind.INJECTION, price: 12_000_000, min: 10_000_000, duration: 45, recovery: 0, anes: AnesthesiaType.LOCAL, lab: false },
    { code: "DV-TRE-HOA", name: "Trẻ hoá da công nghệ cao", cat: "DA", kind: ServiceKind.LASER, price: 24_000_000, min: 20_000_000, duration: 90, recovery: 3, anes: AnesthesiaType.NONE, lab: false },
    { code: "DV-CAY-TOC", name: "Cấy tóc tự thân", cat: "TOC", kind: ServiceKind.SURGERY, price: 72_000_000, min: 65_000_000, duration: 300, recovery: 7, anes: AnesthesiaType.LOCAL, lab: true },
    { code: "DV-TU-VAN", name: "Tư vấn & khám ban đầu", cat: "DA", kind: ServiceKind.CONSULT, price: 0, min: 0, duration: 30, recovery: 0, anes: AnesthesiaType.NONE, lab: false },
  ];

  for (const s of services) {
    const service = await prisma.service.upsert({
      where: { code: s.code },
      create: {
        code: s.code,
        name: s.name,
        categoryId: catByCode.get(s.cat),
        kind: s.kind,
        durationMin: s.duration,
        recoveryDays: s.recovery,
        anesthesia: s.anes,
        requiresPreOpLab: s.lab,
      },
      update: { name: s.name, durationMin: s.duration },
    });

    const hasPrice = await prisma.servicePrice.findFirst({
      where: { serviceId: service.id, branchId: tmv.id, validTo: null },
    });
    if (!hasPrice) {
      await prisma.servicePrice.create({
        data: { serviceId: service.id, branchId: tmv.id, price: s.price, minPrice: s.min },
      });
    }
  }
  const svcByCode = new Map((await prisma.service.findMany()).map((s) => [s.code, s]));

  // ------------------------------------------------------------- MẪU TIN NHANH
  if ((await prisma.quickReply.count()) === 0) {
    await prisma.quickReply.createMany({
      data: [
        { title: "Xác nhận lịch hẹn", category: "Lễ tân", content: "Dạ em xác nhận lịch hẹn của chị lúc {{gio}} ngày {{ngay}} tại phòng khám ạ. Chị đến trước 10 phút để làm thủ tục giúp em nhé." },
        { title: "Nhắc tái khám", category: "Hậu phẫu", content: "Dạ chị ơi, mai là lịch tái khám của chị lúc {{gio}} ạ. Chị sắp xếp qua đúng hẹn giúp em nhé." },
        { title: "Gửi báo giá", category: "Tư vấn", content: "Dạ em gửi chị báo giá dịch vụ {{dich_vu}}: {{gia}}. Mức giá tuỳ tình trạng thực tế sau khi bác sĩ thăm khám ạ." },
        { title: "Dặn trước mổ", category: "Tiền phẫu", content: "Dạ chị nhịn ăn uống từ 22h đêm trước, ngưng thuốc chống đông 7 ngày và mang theo kết quả xét nghiệm giúp em ạ." },
        { title: "Nhắc thanh toán", category: "Kế toán", content: "Dạ chị ơi, phần còn lại {{so_tien}} chị thanh toán trước ngày {{han}} giúp em nhé. Em cảm ơn chị ạ." },
      ],
    });
  }

  // Từ đây trở xuống là dữ liệu demo — chỉ tạo một lần.
  if ((await prisma.customer.count()) > 0) {
    console.log("Đã có dữ liệu khách — bỏ qua phần demo.");
    return;
  }

  // ------------------------------------------------------------- CHIẾN DỊCH
  const campaign = await prisma.campaign.create({
    data: {
      code: "CD-HUTMO-HE2026",
      name: "Hút mỡ hè 2026",
      channelId: channelByKey.get("facebook"),
      branchId: tmv.id,
      utmSource: "facebook",
      utmMedium: "cpc",
      utmCampaign: "hutmo_he_2026",
      budget: 180_000_000,
      startDate: daysAgo(45),
    },
  });
  const campaignTiktok = await prisma.campaign.create({
    data: {
      code: "CD-MUI-Q3",
      name: "Nâng mũi quý 3",
      channelId: channelByKey.get("tiktok"),
      branchId: tmv.id,
      budget: 120_000_000,
      startDate: daysAgo(30),
    },
  });

  for (let i = 0; i < 20; i++) {
    await prisma.campaignCost.create({
      data: {
        campaignId: i % 2 === 0 ? campaign.id : campaignTiktok.id,
        date: daysAgo(i + 1),
        amount: 3_000_000 + (i % 5) * 800_000,
      },
    });
  }

  // ------------------------------------------------------------- THẺ KHÁCH
  const tagVip = await prisma.tag.create({ data: { name: "Khách VIP", color: "#A21CAF" } });
  const tagRepeat = await prisma.tag.create({ data: { name: "Khách quay lại", color: "#0369A1" } });

  // ------------------------------------------------------------- KHÁCH HÀNG
  // Đúng 6 khách trong prototype, giữ nguyên tên, SĐT, dịch vụ và giai đoạn.
  const customerSeed = [
    { code: "KH-2608-0181", name: "Nguyễn Thị Lan Anh", phone: "0912345678", stage: FunnelStage.DEN, status: CustomerStatus.LEAD, gender: Gender.FEMALE, interest: ["Nâng mũi cấu trúc", "Cắt mí trên"], channel: "tiktok", campaign: campaignTiktok.id, tv: "thuha@louva.vn", ts: "minhngoc@louva.vn", city: "Hà Nội" },
    { code: "KH-2608-0187", name: "Trần Bảo Ngọc", phone: "0938221004", stage: FunnelStage.CHOT, status: CustomerStatus.ACTIVE, gender: Gender.FEMALE, interest: ["Hút mỡ bụng"], channel: "facebook", campaign: campaign.id, tv: "thuha@louva.vn", ts: "minhngoc@louva.vn", city: "Hà Nội", dob: new Date("1992-03-14"), address: "Số 12, ngõ 84 Trần Duy Hưng, Cầu Giấy, Hà Nội", note: "Sợ đau, yêu cầu mê toàn thân. Muốn hoàn tất trước Tết Nguyên đán." },
    { code: "KH-2608-0165", name: "Lê Minh Châu", phone: "0987654321", stage: FunnelStage.HAUPHAU, status: CustomerStatus.POST_OP, gender: Gender.FEMALE, interest: ["Cắt mí trên"], channel: "gioi_thieu", tv: "khanhlinh@louva.vn", ts: "minhngoc@louva.vn", city: "Hà Nội" },
    { code: "KH-2608-0192", name: "Phạm Thuỳ Dương", phone: "0906778112", stage: FunnelStage.MOI, status: CustomerStatus.LEAD, gender: Gender.FEMALE, interest: ["Tiêm filler cằm"], channel: "facebook", campaign: campaign.id, tv: null, ts: null, city: "Hà Nội" },
    { code: "KH-2508-0044", name: "Hoàng Thị Mai", phone: "0977010234", stage: FunnelStage.TAIMUA, status: CustomerStatus.ACTIVE, gender: Gender.FEMALE, interest: ["Nâng ngực nội soi", "Trẻ hoá da"], channel: "khach_cu", tv: "khanhlinh@louva.vn", ts: "haiyen@louva.vn", city: "Hà Nội", tags: [tagVip.id, tagRepeat.id] },
    { code: "KH-2608-0190", name: "Đặng Quốc Hưng", phone: "0913559887", stage: FunnelStage.LIENHE, status: CustomerStatus.LEAD, gender: Gender.MALE, interest: ["Cấy tóc"], channel: "google", tv: "thuha@louva.vn", ts: "haiyen@louva.vn", city: "Hà Nội" },
    // Khách chỉ xuất hiện trong lưới lịch hẹn / lịch mổ của prototype.
    { code: "KH-2608-0171", name: "Vũ Thị Kim Chi", phone: "0904112233", stage: FunnelStage.CHOT, status: CustomerStatus.ACTIVE, gender: Gender.FEMALE, interest: ["Nâng mũi cấu trúc sụn sườn"], channel: "tiktok", campaign: campaignTiktok.id, tv: "thuha@louva.vn", ts: "minhngoc@louva.vn", city: "Hà Nội" },
    { code: "KH-2608-0175", name: "Lý Thanh Thảo", phone: "0965443322", stage: FunnelStage.CHOT, status: CustomerStatus.ACTIVE, gender: Gender.FEMALE, interest: ["Cắt mí trên"], channel: "facebook", tv: "minhngoc@louva.vn", ts: "minhngoc@louva.vn", city: "Hà Nội" },
    { code: "KH-2608-0179", name: "Ngô Bích Phượng", phone: "0918224466", stage: FunnelStage.CHOT, status: CustomerStatus.ACTIVE, gender: Gender.FEMALE, interest: ["Tiêm filler cằm"], channel: "gioi_thieu", tv: "haiyen@louva.vn", ts: "haiyen@louva.vn", city: "Hà Nội" },
    { code: "KH-2608-0183", name: "Bùi Hồng Vân", phone: "0983117722", stage: FunnelStage.HAUPHAU, status: CustomerStatus.POST_OP, gender: Gender.FEMALE, interest: ["Cắt mí trên"], channel: "facebook", tv: "khanhlinh@louva.vn", ts: "haiyen@louva.vn", city: "Hà Nội" },
    { code: "KH-2608-0185", name: "Đặng Thu Trang", phone: "0977553311", stage: FunnelStage.HEN, status: CustomerStatus.LEAD, gender: Gender.FEMALE, interest: ["Hút mỡ đùi"], channel: "tiktok", tv: "khanhlinh@louva.vn", ts: "haiyen@louva.vn", city: "Hà Nội" },
    { code: "KH-2608-0188", name: "Trịnh Thu Hằng", phone: "0946882200", stage: FunnelStage.DEN, status: CustomerStatus.LEAD, gender: Gender.FEMALE, interest: ["Combo trẻ hoá"], channel: "google", tv: "minhngoc@louva.vn", ts: "minhngoc@louva.vn", city: "Hà Nội" },
  ];

  const customerByName = new Map<string, string>();
  for (const c of customerSeed) {
    const created = await prisma.customer.create({
      data: {
        code: c.code,
        name: c.name,
        phone: c.phone,
        dob: c.dob,
        gender: c.gender,
        address: c.address,
        city: c.city,
        note: c.note,
        status: c.status,
        stage: c.stage,
        channelId: channelByKey.get(c.channel!),
        campaignId: c.campaign,
        interest: JSON.stringify(c.interest),
        assignedToId: c.tv ? uid(c.tv) : null,
        telesaleId: c.ts ? uid(c.ts) : null,
        lastContactAt: daysAgo(Math.floor(Math.random() * 3)),
        branchLinks: { create: [{ branchId: tmv.id, isPrimary: true }] },
        ...(c.tags ? { tags: { create: c.tags.map((tagId) => ({ tagId })) } } : {}),
      },
    });
    customerByName.set(c.name, created.id);
  }
  const cid = (name: string) => customerByName.get(name)!;

  // ------------------------------------------------------------- HỘI THOẠI ZALO
  const oaConfig = await prisma.zaloOAConfig.create({
    data: {
      branchId: tmv.id,
      label: "OA Phẫu thuật Thẩm mỹ (demo)",
      oaId: "demo-oa-tmv",
      appId: "demo-app-id",
      appSecretEnc: encryptNullable("demo-secret-chua-ket-noi")!,
    },
  });

  const conversations: Array<{
    customer?: string;
    title: string;
    kind: string;
    members?: number;
    assigned?: string;
    unread: number;
    messages: Array<{ dir: string; text: string; by?: string; minutesAgo: number }>;
  }> = [
    {
      customer: "Nguyễn Thị Lan Anh",
      title: "Nguyễn Thị Lan Anh",
      kind: ConversationKind.CUSTOMER,
      assigned: "thuha@louva.vn",
      unread: 3,
      messages: [
        { dir: MessageDirection.IN, text: "Em chào chị, chị cho em hỏi nâng mũi cấu trúc bên mình giá bao nhiêu ạ?", minutesAgo: 81 },
        { dir: MessageDirection.OUT, text: "Dạ em chào chị Lan Anh, nâng mũi cấu trúc tại phòng khám hiện từ 38.000.000đ ạ. Mức giá tuỳ vào chất liệu sụn và tình trạng mũi hiện tại của chị.", by: "thuha@louva.vn", minutesAgo: 78 },
        { dir: MessageDirection.IN, text: "Vậy chị muốn qua khám trực tiếp thì đặt lịch thế nào em?", minutesAgo: 70 },
        { dir: MessageDirection.OUT, text: "Dạ chị qua phòng khám bác sĩ soi mũi và tư vấn miễn phí ạ. Chị rảnh sáng thứ 5 lúc 9h30 được không ạ?", by: "thuha@louva.vn", minutesAgo: 67 },
        { dir: MessageDirection.IN, text: "9h30 thứ 5 được em nhé. Cho chị xin địa chỉ với", minutesAgo: 62 },
        { dir: MessageDirection.IN, text: "Mà chị hơi sợ đau, có gây mê không em?", minutesAgo: 61 },
        { dir: MessageDirection.IN, text: "Alo em ơi?", minutesAgo: 60 },
      ],
    },
    {
      customer: "Trần Bảo Ngọc",
      title: "Trần Bảo Ngọc",
      kind: ConversationKind.CUSTOMER,
      assigned: "thuha@louva.vn",
      unread: 1,
      messages: [
        { dir: MessageDirection.OUT, text: "Dạ chị Ngọc ơi, em xác nhận ca hút mỡ bụng của chị đã xếp Phòng mổ 1 lúc 13h ạ.", by: "thuha@louva.vn", minutesAgo: 200 },
        { dir: MessageDirection.IN, text: "Ok em. Trước mổ chị cần chuẩn bị gì không?", minutesAgo: 120 },
        { dir: MessageDirection.OUT, text: "Dạ chị nhịn ăn uống từ 22h đêm trước, ngưng thuốc chống đông 7 ngày và mang theo kết quả xét nghiệm ạ. Còn 24.000.000đ chị thanh toán trước mổ giúp em nhé.", by: "thuha@louva.vn", minutesAgo: 116 },
        { dir: MessageDirection.IN, text: "Chị chuyển khoản chiều mai nhé", minutesAgo: 113 },
      ],
    },
    {
      customer: "Lê Minh Châu",
      title: "Lê Minh Châu",
      kind: ConversationKind.CUSTOMER,
      assigned: "dd.nhung@louva.vn",
      unread: 0,
      messages: [
        { dir: MessageDirection.OUT, text: "Chị Châu ơi hôm nay ngày thứ 5 sau cắt mí rồi, mắt chị còn sưng nhiều không ạ?", by: "dd.nhung@louva.vn", minutesAgo: 420 },
        { dir: MessageDirection.IN, text: "Đỡ nhiều rồi em, chỉ còn hơi cộm thôi", minutesAgo: 130 },
        { dir: MessageDirection.IN, text: "Chị gửi ảnh em xem nhé [Hình ảnh]", minutesAgo: 124 },
        { dir: MessageDirection.OUT, text: "Dạ vết mổ khô đẹp ạ. Mai 10h chị qua cắt chỉ đúng hẹn giúp em nhé.", by: "dd.nhung@louva.vn", minutesAgo: 122 },
      ],
    },
    {
      customer: "Phạm Thuỳ Dương",
      title: "Phạm Thuỳ Dương",
      kind: ConversationKind.CUSTOMER,
      unread: 1,
      messages: [
        { dir: MessageDirection.IN, text: "Cho mình hỏi tiêm filler cằm bao nhiêu tiền vậy shop?", minutesAgo: 254 },
      ],
    },
    {
      customer: "Hoàng Thị Mai",
      title: "Hoàng Thị Mai",
      kind: ConversationKind.CUSTOMER,
      assigned: "khanhlinh@louva.vn",
      unread: 0,
      messages: [
        { dir: MessageDirection.IN, text: "Em ơi chị sinh xong 8 tháng rồi, giờ muốn làm ngực thì được chưa?", minutesAgo: 1500 },
        { dir: MessageDirection.OUT, text: "Dạ chị Mai, sau sinh 6 tháng và ngừng cho con bú là làm được ạ. Chị qua để bác sĩ khám và đo trực tiếp nhé.", by: "khanhlinh@louva.vn", minutesAgo: 1495 },
      ],
    },
    {
      customer: "Đặng Quốc Hưng",
      title: "Đặng Quốc Hưng",
      kind: ConversationKind.CUSTOMER,
      assigned: "thuha@louva.vn",
      unread: 0,
      messages: [
        { dir: MessageDirection.OUT, text: "Dạ em chào anh Hưng, em gọi anh 2 lần chưa được. Anh cho em xin thời gian thuận tiện để tư vấn cấy tóc ạ.", by: "thuha@louva.vn", minutesAgo: 1440 },
      ],
    },
    {
      title: "Nhóm — Kíp mổ hôm nay",
      kind: ConversationKind.GROUP,
      members: 6,
      unread: 2,
      messages: [
        { dir: MessageDirection.IN, text: "BS Tuấn: Ca 8h mai chuyển sang Phòng mổ 2 nhé, phòng 1 đang bảo trì đèn.", minutesAgo: 65 },
        { dir: MessageDirection.IN, text: "ĐD Nhung: Dạ em đã chuẩn bị dụng cụ sang phòng 2 ạ.", minutesAgo: 58 },
      ],
    },
    {
      title: "Nhóm — Chăm sóc khách VIP",
      kind: ConversationKind.GROUP,
      members: 4,
      unread: 0,
      messages: [
        { dir: MessageDirection.IN, text: "QL: Chị Hoàng Thị Mai là khách cũ đã làm dịch vụ tại phòng khám, ưu tiên xếp bác sĩ trưởng khoa.", minutesAgo: 480 },
      ],
    },
  ];

  for (const conv of conversations) {
    const last = conv.messages[conv.messages.length - 1];
    const created = await prisma.conversation.create({
      data: {
        branchId: tmv.id,
        oaConfigId: conv.kind === ConversationKind.CUSTOMER ? oaConfig.id : null,
        kind: conv.kind,
        channel: conv.kind === ConversationKind.GROUP ? "ZALO_GROUP" : "ZALO_OA",
        title: conv.title,
        externalId: conv.customer ? `zalo-${cid(conv.customer).slice(0, 8)}` : null,
        memberCount: conv.members,
        customerId: conv.customer ? cid(conv.customer) : null,
        assignedToId: conv.assigned ? uid(conv.assigned) : null,
        unreadCount: conv.unread,
        lastMessageAt: new Date(Date.now() - last.minutesAgo * 60000),
        lastMessagePreview: last.text.slice(0, 160),
      },
    });

    for (const m of conv.messages) {
      await prisma.chatMessage.create({
        data: {
          conversationId: created.id,
          direction: m.dir,
          content: m.text,
          senderUserId: m.by ? uid(m.by) : null,
          senderName: m.by ? staff.find((s) => s.email === m.by)?.name : conv.title,
          status: m.dir === MessageDirection.OUT ? MessageStatus.SENT : MessageStatus.DELIVERED,
          createdAt: new Date(Date.now() - m.minutesAgo * 60000),
        },
      });
    }
  }

  // ------------------------------------------------------------- LỊCH HẸN
  // Khớp lưới lịch trong prototype: 4 cột (2 bác sĩ + 2 phòng tư vấn).
  const bsTuan = uid("bs.tuan@louva.vn");
  const bsHuy = uid("bs.huy@louva.vn");
  const tv1 = roomByCode.get("TV1")!;
  const tv2 = roomByCode.get("TV2")!;

  const appointments = [
    { customer: "Vũ Thị Kim Chi", title: "Khám tiền phẫu — Nâng mũi", doctor: bsTuan, hour: 8, min: 0, dur: 60, status: AppointmentStatus.ARRIVED, type: AppointmentType.PRE_OP, svc: "DV-MUI-SUON" },
    { customer: "Nguyễn Thị Lan Anh", title: "Tư vấn lần đầu — Nâng mũi cấu trúc", doctor: bsTuan, hour: 9, min: 30, dur: 60, status: AppointmentStatus.CONFIRMED, type: AppointmentType.CONSULT, svc: "DV-MUI-CT" },
    { customer: "Bùi Hồng Vân", title: "Tái khám T1 — Cắt mí", doctor: bsTuan, hour: 10, min: 30, dur: 60, status: AppointmentStatus.CONFIRMED, type: AppointmentType.FOLLOW_UP, svc: "DV-MAT-CM" },
    { customer: "Trần Bảo Ngọc", title: "Khám tiền phẫu — Hút mỡ bụng", doctor: bsTuan, hour: 14, min: 0, dur: 90, status: AppointmentStatus.PENDING, type: AppointmentType.PRE_OP, svc: "DV-BUNG-HM" },
    { customer: "Lê Minh Châu", title: "Thay băng — Cắt mí trên", doctor: bsHuy, hour: 8, min: 30, dur: 60, status: AppointmentStatus.ARRIVED, type: AppointmentType.FOLLOW_UP, svc: "DV-MAT-CM" },
    { customer: "Đặng Thu Trang", title: "Tư vấn lần đầu — Hút mỡ đùi", doctor: bsHuy, hour: 10, min: 0, dur: 90, status: AppointmentStatus.NO_SHOW, type: AppointmentType.CONSULT },
    { customer: "Hoàng Thị Mai", title: "Tư vấn lại — Nâng ngực nội soi", doctor: bsHuy, hour: 15, min: 0, dur: 60, status: AppointmentStatus.CONFIRMED, type: AppointmentType.CONSULT, svc: "DV-NGUC-NS" },
    { customer: "Phạm Thuỳ Dương", title: "Tư vấn — Tiêm filler cằm", room: tv1, hour: 9, min: 0, dur: 60, status: AppointmentStatus.PENDING, type: AppointmentType.CONSULT, svc: "DV-FILLER-CAM" },
    { customer: "Ngô Bích Phượng", title: "Tư vấn — Trẻ hoá da công nghệ cao", room: tv1, hour: 13, min: 30, dur: 60, status: AppointmentStatus.CONFIRMED, type: AppointmentType.CONSULT, svc: "DV-TRE-HOA" },
    { customer: "Đặng Quốc Hưng", title: "Tư vấn — Cấy tóc tự thân", room: tv1, hour: 16, min: 0, dur: 60, status: AppointmentStatus.PENDING, type: AppointmentType.CONSULT, svc: "DV-CAY-TOC" },
    { customer: "Lý Thanh Thảo", title: "Tư vấn — Cắt mí + nhấn mí", room: tv2, hour: 10, min: 0, dur: 60, status: AppointmentStatus.CONFIRMED, type: AppointmentType.CONSULT, svc: "DV-MAT-CM" },
    { customer: "Trịnh Thu Hằng", title: "Tư vấn gói — Combo trẻ hoá", room: tv2, hour: 15, min: 30, dur: 90, status: AppointmentStatus.ARRIVED, type: AppointmentType.CONSULT, svc: "DV-TRE-HOA" },
  ];

  const apptIdByCustomer = new Map<string, string>();
  for (const a of appointments) {
    const start = at(a.hour, a.min);
    const created = await prisma.appointment.create({
      data: {
        branchId: tmv.id,
        customerId: cid(a.customer),
        type: a.type,
        title: a.title,
        serviceId: a.svc ? svcByCode.get(a.svc)!.id : null,
        doctorId: a.doctor ?? null,
        roomId: a.room ?? null,
        startAt: start,
        endAt: new Date(start.getTime() + a.dur * 60000),
        status: a.status,
        createdById: uid("letan@louva.vn"),
      },
    });
    if (a.status === AppointmentStatus.ARRIVED) apptIdByCustomer.set(a.customer, created.id);
  }

  // ------------------------------------------------------------- CHECK-IN
  const arrivals: Array<{ customer: string; status: string; consultant?: string; minutesAgo: number }> = [
    { customer: "Vũ Thị Kim Chi", status: VisitStatus.IN_SERVICE, consultant: "thuha@louva.vn", minutesAgo: 95 },
    { customer: "Lê Minh Châu", status: VisitStatus.CONSULTING, consultant: "khanhlinh@louva.vn", minutesAgo: 55 },
    { customer: "Trịnh Thu Hằng", status: VisitStatus.WAITING, minutesAgo: 18 },
  ];
  let queueNo = 0;
  for (const v of arrivals) {
    queueNo++;
    const checkedInAt = new Date(Date.now() - v.minutesAgo * 60000);
    await prisma.visit.create({
      data: {
        branchId: tmv.id,
        customerId: cid(v.customer),
        appointmentId: apptIdByCustomer.get(v.customer) ?? null,
        queueNumber: queueNo,
        status: v.status,
        consultantId: v.consultant ? uid(v.consultant) : null,
        checkedInAt,
        calledAt: v.status === VisitStatus.WAITING ? null : new Date(checkedInAt.getTime() + 12 * 60000),
      },
    });
  }

  // -------------------------------------------- BÁO GIÁ · HỢP ĐỒNG · THU TIỀN
  const hutMo = svcByCode.get("DV-BUNG-HM")!;
  const ngocId = cid("Trần Bảo Ngọc");

  const quotation = await prisma.quotation.create({
    data: {
      code: "BG-2608-0143",
      branchId: tmv.id,
      customerId: ngocId,
      status: QuotationStatus.ACCEPTED,
      subtotal: 59_000_000,
      discount: 3_000_000,
      total: 56_000_000,
      note: "Giảm 5% ưu đãi hè",
      createdById: uid("thuha@louva.vn"),
      sentAt: daysAgo(5),
      decidedAt: daysAgo(5),
      items: {
        create: [
          { serviceId: hutMo.id, name: "Hút mỡ bụng + tạo hình thành bụng mini", quantity: 1, unitPrice: 59_000_000, discount: 3_000_000, amount: 56_000_000 },
        ],
      },
    },
  });

  const contract = await prisma.contract.create({
    data: {
      code: "DH-2608-0142",
      branchId: tmv.id,
      customerId: ngocId,
      quotationId: quotation.id,
      status: ContractStatus.SIGNED,
      subtotal: 59_000_000,
      discount: 3_000_000,
      total: 56_000_000,
      paidAmount: 32_000_000,
      consultantId: uid("thuha@louva.vn"),
      signedAt: daysAgo(5),
      items: {
        create: [
          { serviceId: hutMo.id, name: "Hút mỡ bụng + tạo hình thành bụng mini", quantity: 1, unitPrice: 59_000_000, discount: 3_000_000, amount: 56_000_000 },
        ],
      },
    },
  });

  // Ba đợt thu đúng tab "Tài chính" trong prototype.
  const depositInvoice = await prisma.invoice.create({
    data: { code: "HD-2608-0071", branchId: tmv.id, customerId: ngocId, contractId: contract.id, title: "Cọc 30% (khi ký)", amount: 32_000_000, paidAmount: 32_000_000, status: InvoiceStatus.PAID, dueDate: daysAgo(5), issuedAt: daysAgo(5) },
  });
  await prisma.invoice.create({
    data: { code: "HD-2608-0072", branchId: tmv.id, customerId: ngocId, contractId: contract.id, title: "Trước mổ", amount: 16_800_000, status: InvoiceStatus.ISSUED, dueDate: at(17, 0, 2), issuedAt: daysAgo(5) },
  });
  await prisma.invoice.create({
    data: { code: "HD-2608-0073", branchId: tmv.id, customerId: ngocId, contractId: contract.id, title: "Sau mổ", amount: 7_200_000, status: InvoiceStatus.ISSUED, dueDate: at(17, 0, 11), issuedAt: daysAgo(5) },
  });

  await prisma.payment.create({
    data: {
      code: "PT-2608-0091",
      branchId: tmv.id,
      customerId: ngocId,
      contractId: contract.id,
      invoiceId: depositInvoice.id,
      amount: 32_000_000,
      method: PaymentMethod.CASH,
      paidAt: daysAgo(5),
      receivedById: uid("letan@louva.vn"),
    },
  });

  // Vài hợp đồng khác để dashboard và báo cáo có số liệu thật.
  const otherDeals: Array<{ customer: string; svc: string; total: number; paid: number; daysAgo: number; consultant: string }> = [
    { customer: "Vũ Thị Kim Chi", svc: "DV-MUI-SUON", total: 68_000_000, paid: 40_000_000, daysAgo: 9, consultant: "thuha@louva.vn" },
    { customer: "Hoàng Thị Mai", svc: "DV-NGUC-NS", total: 98_000_000, paid: 98_000_000, daysAgo: 22, consultant: "khanhlinh@louva.vn" },
    { customer: "Lê Minh Châu", svc: "DV-MAT-CM", total: 18_000_000, paid: 18_000_000, daysAgo: 14, consultant: "khanhlinh@louva.vn" },
    { customer: "Lý Thanh Thảo", svc: "DV-MAT-CM", total: 18_000_000, paid: 9_000_000, daysAgo: 4, consultant: "minhngoc@louva.vn" },
    { customer: "Ngô Bích Phượng", svc: "DV-FILLER-CAM", total: 12_000_000, paid: 12_000_000, daysAgo: 2, consultant: "haiyen@louva.vn" },
    { customer: "Bùi Hồng Vân", svc: "DV-MAT-CM", total: 18_000_000, paid: 18_000_000, daysAgo: 30, consultant: "khanhlinh@louva.vn" },
  ];

  let seq = 143;
  for (const d of otherDeals) {
    seq++;
    const svc = svcByCode.get(d.svc)!;
    const c = await prisma.contract.create({
      data: {
        code: `DH-2608-0${seq}`,
        branchId: tmv.id,
        customerId: cid(d.customer),
        status: ContractStatus.SIGNED,
        subtotal: d.total,
        total: d.total,
        paidAmount: d.paid,
        consultantId: uid(d.consultant),
        signedAt: daysAgo(d.daysAgo),
        items: { create: [{ serviceId: svc.id, name: svc.name, quantity: 1, unitPrice: d.total, amount: d.total }] },
      },
    });
    const inv = await prisma.invoice.create({
      data: {
        code: `HD-2608-0${seq}`,
        branchId: tmv.id,
        customerId: cid(d.customer),
        contractId: c.id,
        title: "Toàn bộ hợp đồng",
        amount: d.total,
        paidAmount: d.paid,
        status: d.paid >= d.total ? InvoiceStatus.PAID : InvoiceStatus.PARTIAL,
        dueDate: daysAgo(d.daysAgo - 7),
        issuedAt: daysAgo(d.daysAgo),
      },
    });
    if (d.paid > 0) {
      await prisma.payment.create({
        data: {
          code: `PT-2608-0${seq}`,
          branchId: tmv.id,
          customerId: cid(d.customer),
          contractId: c.id,
          invoiceId: inv.id,
          amount: d.paid,
          method: PaymentMethod.BANK_TRANSFER,
          paidAt: daysAgo(d.daysAgo),
          receivedById: uid("ketoan@louva.vn"),
        },
      });
    }
  }

  // ------------------------------------------------------------- BỆNH ÁN
  const record = await prisma.medicalRecord.create({
    data: {
      code: "BA-2608-0044",
      branchId: tmv.id,
      customerId: ngocId,
      bloodType: "O (Rh+)",
      chronicDisease: "Không",
      currentMedication: "Vitamin tổng hợp",
      smoking: false,
      pregnancyNote: "Đã ngừng cho con bú 10 tháng",
      pastAesthetic: "Chưa từng",
      doctorId: bsHuy,
    },
  });
  await prisma.medicalRecordEntry.create({
    data: {
      recordId: record.id,
      kind: "EXAM",
      content: "Khám tiền phẫu: bụng chảy xệ sau sinh, da thừa vùng dưới rốn. Chỉ định hút mỡ Vaser + tạo hình thành bụng mini.",
      authorId: bsHuy,
      authorName: "Trịnh Quang Huy",
    },
  });
  await prisma.allergy.create({
    data: { recordId: record.id, substance: "Không ghi nhận", reaction: "—", severity: "NORMAL" },
  });

  await prisma.consentForm.create({
    data: {
      branchId: tmv.id,
      customerId: ngocId,
      type: ConsentType.SURGERY,
      title: "Cam kết phẫu thuật — Hút mỡ bụng + tạo hình thành bụng",
      bodyText:
        "Tôi đã được bác sĩ giải thích đầy đủ về phương pháp, các rủi ro có thể xảy ra (chảy máu, nhiễm trùng, tụ dịch, sẹo xấu, bất đối xứng), quá trình hồi phục và chi phí. Tôi tự nguyện đồng ý thực hiện phẫu thuật.",
      status: ConsentStatus.SIGNED,
      signedAt: daysAgo(1),
      staffId: uid("dd.nhung@louva.vn"),
    },
  });

  // ------------------------------------------------------------- LỊCH MỔ
  // Năm ca đúng như prototype, kèm mức đủ/thiếu điều kiện tiền phẫu.
  const pm1 = roomByCode.get("PM1")!;
  const pm2 = roomByCode.get("PM2")!;
  const ptp = roomByCode.get("PTP")!;

  const surgeries = [
    { code: "PM-2608-0031", customer: "Vũ Thị Kim Chi", title: "Nâng mũi cấu trúc sụn sườn", svc: "DV-MUI-SUON", room: pm1, surgeon: bsTuan, anes: AnesthesiaType.GENERAL, hour: 8, dur: 180, checklist: [true, true, true, true, true, true, true], team: "BS Lê Anh Tuấn (chính) · BS Trịnh Quang Huy (phụ) · BS Đinh Văn Sơn (gây mê) · ĐD Vũ Hồng Nhung · ĐD Cao Thị Hạnh", material: "Sụn sườn tự thân · Sụn nhân tạo Surgiform (lô SF-2451) · Bộ chỉ PDS 5-0" },
    { code: "PM-2608-0032", customer: "Trần Bảo Ngọc", title: "Hút mỡ bụng + tạo hình thành bụng", svc: "DV-BUNG-HM", room: pm1, surgeon: bsHuy, anes: AnesthesiaType.GENERAL, hour: 13, dur: 120, checklist: [true, true, false, true, true, true, true], team: "BS Trịnh Quang Huy (chính) · BS Đinh Văn Sơn (gây mê) · ĐD Cao Thị Hạnh", material: "Canuyn hút mỡ · Dịch Klein · Gen định hình size M" },
    { code: "PM-2608-0033", customer: "Lý Thanh Thảo", title: "Cắt mí trên 2 bên", svc: "DV-MAT-CM", room: pm2, surgeon: bsTuan, anes: AnesthesiaType.LOCAL, hour: 9, dur: 90, checklist: [true, true, true, true, true, true, true], team: "BS Lê Anh Tuấn (chính) · ĐD Vũ Hồng Nhung", material: "Chỉ Nylon 6-0 · Bộ tiểu phẫu mí" },
    { code: "PM-2608-0034", customer: "Hoàng Thị Mai", title: "Nâng ngực nội soi đường nách", svc: "DV-NGUC-NS", room: pm2, surgeon: bsTuan, anes: AnesthesiaType.GENERAL, hour: 14, dur: 120, checklist: [true, true, true, false, true, true, false], team: "BS Lê Anh Tuấn (chính) · BS Đinh Văn Sơn (gây mê) · ĐD Cao Thị Hạnh", material: "Túi ngực Motiva 275cc (lô MT-88120) — KHO CHỈ CÒN 1/2 TÚI" },
    { code: "PM-2608-0035", customer: "Ngô Bích Phượng", title: "Tiêm filler cằm 2ml", svc: "DV-FILLER-CAM", room: ptp, surgeon: bsHuy, anes: AnesthesiaType.LOCAL, hour: 10, dur: 45, checklist: [true, true, true, true, true, true, true], team: "BS Trịnh Quang Huy (chính) · ĐD Vũ Hồng Nhung", material: "Filler Juvederm Volux 2ml (lô JV-7712)" },
  ];

  for (const s of surgeries) {
    const contractForCustomer = await prisma.contract.findFirst({
      where: { customerId: cid(s.customer), status: ContractStatus.SIGNED },
      orderBy: { createdAt: "desc" },
    });
    await prisma.procedureRecord.create({
      data: {
        code: s.code,
        branchId: tmv.id,
        customerId: cid(s.customer),
        contractId: contractForCustomer?.id ?? null,
        serviceId: svcByCode.get(s.svc)!.id,
        title: s.title,
        roomId: s.room,
        surgeonId: s.surgeon,
        teamNote: s.team,
        materialNote: s.material,
        anesthesia: s.anes,
        status: ProcedureStatus.SCHEDULED,
        scheduledAt: at(s.hour, 0),
        durationMin: s.dur,
        checklist: JSON.stringify(s.checklist),
      },
    });
  }

  // ------------------------------- CAM KẾT + ẢNH TRƯỚC MỔ CHO CA ĐỦ ĐIỀU KIỆN
  //
  // Checklist tiền phẫu được CHẤM TỪ DỮ LIỆU THẬT (xem routes/surgery.ts), nên
  // muốn ca hiện "Đủ điều kiện" thì phải thực sự có cam kết đã ký và bộ ảnh
  // trước mổ. Ba ca dưới đây khớp với prototype (3 xanh / 2 đỏ).
  const readyCases = ['Vũ Thị Kim Chi', 'Lý Thanh Thảo', 'Ngô Bích Phượng']

  for (const name of readyCases) {
    const customerId = cid(name)
    const proc = await prisma.procedureRecord.findFirst({ where: { customerId } })
    if (!proc) continue

    await prisma.consentForm.create({
      data: {
        branchId: tmv.id,
        customerId,
        procedureId: proc.id,
        type: ConsentType.SURGERY,
        title: `Cam kết phẫu thuật — ${proc.title}`,
        bodyText:
          'Tôi đã được bác sĩ giải thích đầy đủ về phương pháp, các rủi ro có thể xảy ra, quá trình hồi phục và chi phí. Tôi tự nguyện đồng ý thực hiện phẫu thuật.',
        status: ConsentStatus.SIGNED,
        signedAt: daysAgo(1),
        staffId: uid('dd.nhung@louva.vn'),
      },
    })

    // Ảnh mẫu 1x1 JPEG, đi qua đúng đường mã hoá AES-256-GCM như ảnh thật.
    const sampleJpeg = Buffer.from(
      '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
      'base64'
    )
    const stored = putEncrypted(`photos/${customerId}`, 'truoc-mo.jpg', sampleJpeg)

    await prisma.photoSet.create({
      data: {
        branchId: tmv.id,
        customerId,
        procedureId: proc.id,
        stage: PhotoStage.PRE_OP,
        takenById: uid('dd.nhung@louva.vn'),
        note: 'Ảnh hiện trạng trước mổ — chụp theo mốc chuẩn',
        photos: {
          create: {
            storageKey: stored.storageKey,
            fileName: 'truoc-mo.jpg',
            mimeType: 'image/jpeg',
            size: stored.size,
            angle: 'front',
            encIv: stored.iv,
            encTag: stored.tag,
          },
        },
      },
    })
  }

  // ------------------------------------------------------------- LEAD MỚI
  const leadSeed = [
    { name: "Nguyễn Khánh Chi", phone: "0901234567", interest: "Nâng mũi cấu trúc", stage: "NEW", channel: "tiktok", campaign: campaignTiktok.id },
    { name: "Trần Mỹ Duyên", phone: "0912994411", interest: "Cắt mí", stage: "CONTACTING", channel: "facebook", campaign: campaign.id, assigned: "minhngoc@louva.vn" },
    { name: "Lê Hoài Thu", phone: "0938112255", interest: "Hút mỡ bụng", stage: "APPOINTED", channel: "facebook", campaign: campaign.id, assigned: "haiyen@louva.vn" },
    { name: "Phan Thị Ngân", phone: "0977889911", interest: "Trẻ hoá da", stage: "NEW", channel: "google" },
    { name: "Vương Bảo Trâm", phone: "0968224477", interest: "Nâng ngực", stage: "LOST", channel: "tiktok", campaign: campaignTiktok.id, lost: "Khách chê giá cao, chọn nơi khác" },
  ];
  for (const l of leadSeed) {
    await prisma.lead.create({
      data: {
        branchId: tmv.id,
        name: l.name,
        phone: l.phone,
        interest: l.interest,
        stage: l.stage,
        lostReason: l.lost,
        channelId: channelByKey.get(l.channel),
        campaignId: l.campaign,
        assignedToId: l.assigned ? uid(l.assigned) : null,
        createdAt: daysAgo(Math.floor(Math.random() * 10) + 1),
      },
    });
  }

  console.log("=================================================");
  console.log("Đã nạp dữ liệu mẫu theo prototype.");
  console.log(`  ${staff.length} nhân viên · mật khẩu chung: ${PASSWORD}`);
  console.log(`  ${customerSeed.length} khách · ${conversations.length} hội thoại Zalo`);
  console.log(`  ${appointments.length} lịch hẹn hôm nay · ${surgeries.length} ca mổ`);
  console.log("Đăng nhập thử:");
  console.log("  Giám đốc      giamdoc@louva.vn");
  console.log("  Lễ tân        letan@louva.vn");
  console.log("  Tư vấn viên   thuha@louva.vn");
  console.log("  Bác sĩ        bs.tuan@louva.vn");
  console.log("  Marketing     marketing@louva.vn  (SĐT bị che)");
  console.log("=================================================");
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
