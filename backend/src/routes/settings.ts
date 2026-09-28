import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { asyncHandler, HttpError } from "../middleware/errorHandler";
import { requireAuth, currentUser } from "../middleware/auth";
import { notFound } from "../middleware/rbac";
import { writeAudit } from "../lib/audit";
import { AuditAction } from "../types/enums";
import { findSetting, invalidateSettingsCache, listSettings } from "../lib/settings-catalog";
import { RoleCode } from "../lib/rbac-catalog";

// ⚙️ CÀI ĐẶT HỆ THỐNG — chỉ Quản trị hệ thống.
//
// Khu này khác mọi màn khác ở chỗ nó sửa được THAM SỐ VẬN HÀNH và XOÁ ĐƯỢC DỮ
// LIỆU. Vì vậy nó không dùng quyền `settings.update` thông thường mà đòi đúng
// vai trò QUAN_LY_HE_THONG, và mọi thao tác đều ghi nhật ký kiểm toán.

const router = Router();
router.use(requireAuth);

/**
 * Cổng riêng cho khu quản trị. Cố ý KHÔNG dùng requirePermission: quyền
 * `settings.update` có thể được quản trị viên gán cho vai trò khác, nhưng
 * quyền xoá dữ liệu gốc thì phải neo vào đúng một vai trò.
 */
function requireSystemAdmin(req: Parameters<typeof requireAuth>[0]): void {
  const me = currentUser(req);
  if (!me.roles.includes(RoleCode.QUAN_LY_HE_THONG)) {
    throw new HttpError(403, "Chỉ Quản trị hệ thống mới vào được khu cài đặt này");
  }
}

/* ----------------------------------------------------- THAM SỐ VẬN HÀNH */

router.get(
  "/",
  asyncHandler(async (req, res) => {
    requireSystemAdmin(req);
    res.json(await listSettings());
  })
);

router.put(
  "/",
  asyncHandler(async (req, res) => {
    requireSystemAdmin(req);
    const body = z
      .object({ values: z.record(z.string(), z.string()) })
      .parse(req.body);

    const changed: string[] = [];

    for (const [key, value] of Object.entries(body.values)) {
      const def = findSetting(key);
      // Chỉ nhận khoá có trong danh mục — không cho ghi khoá tuỳ ý vào CSDL.
      if (!def) continue;

      if (def.type === "number" || def.type === "percent") {
        const n = Number(value);
        if (!Number.isFinite(n)) throw new HttpError(400, `"${def.label}" phải là số`);
        if (def.min !== undefined && n < def.min) {
          throw new HttpError(400, `"${def.label}" không được nhỏ hơn ${def.min}`);
        }
        if (def.max !== undefined && n > def.max) {
          throw new HttpError(400, `"${def.label}" không được lớn hơn ${def.max}`);
        }
      }
      if (def.type === "boolean" && !["true", "false"].includes(value)) {
        throw new HttpError(400, `"${def.label}" phải là true hoặc false`);
      }

      const before = await prisma.systemSetting.findUnique({ where: { key } });
      if (before?.value === value) continue;

      await prisma.systemSetting.upsert({
        where: { key },
        create: { key, value },
        update: { value },
      });
      changed.push(`${def.label}: ${before?.value ?? def.defaultValue} → ${value}`);
    }

    invalidateSettingsCache();

    if (changed.length) {
      await writeAudit({
        req,
        action: AuditAction.UPDATE,
        entity: "SystemSetting",
        summary: `Đổi ${changed.length} tham số vận hành — ${changed.join("; ")}`,
      });
    }

    res.json({ ok: true, changed: changed.length });
  })
);

/* ---------------------------------------------------- QUẢN TRỊ DỮ LIỆU */

/**
 * Bảng nào được đụng vào, và đụng tới mức nào.
 *
 * `deletable: false` KHÔNG phải vì kỹ thuật khó — mà vì:
 *   · Nhật ký kiểm toán và nhật ký truy cập phải CHỈ GHI THÊM. Cho xoá là
 *     phá luôn giá trị pháp lý của chúng: ai xoá được vết thì vết vô nghĩa.
 *   · Bệnh án, cam kết, ảnh, phiếu mổ là hồ sơ y tế, có nghĩa vụ lưu trữ.
 *     Muốn gỡ phải đi qua quy trình nghiệp vụ có lý do, không xoá thẳng ở đây.
 *   · Phiếu thu và hợp đồng là chứng từ tài chính — huỷ bằng nghiệp vụ (ghi
 *     lý do, giữ vết), không xoá bản ghi.
 */
interface Dependent {
  /** Tên model Prisma chứa bản ghi con. */
  model: string;
  /** Cột trỏ tới bản ghi sắp xoá. */
  field: string;
  label: string;
}

interface TableDef {
  key: string;
  label: string;
  group: string;
  deletable: boolean;
  reason?: string;
  search?: string[];
  /**
   * Những bảng đang trỏ tới bảng này. Với quan hệ SetNull, CSDL sẽ vui vẻ cho
   * xoá và lặng lẽ gỡ liên kết — khách mất luôn nguồn, ROAS hỏng vĩnh viễn mà
   * không ai biết. Vì vậy phải ĐẾM TRƯỚC và bắt người xoá xác nhận.
   */
  dependents?: Dependent[];
}

const TABLES: TableDef[] = [
  { key: "customer", label: "Khách hàng", group: "Kinh doanh", deletable: false, reason: "Không xoá khách — dùng chức năng Ẩn hồ sơ kèm lý do ở màn Khách hàng.", search: ["name", "code", "phone"] },
  { key: "lead", label: "Lead", group: "Kinh doanh", deletable: true, search: ["name", "phone"] },
  { key: "channel", label: "Nguồn khách", group: "Danh mục", deletable: true, search: ["name", "key"], dependents: [{ model: "customer", field: "channelId", label: "khách hàng" }, { model: "lead", field: "channelId", label: "lead" }, { model: "campaign", field: "channelId", label: "chiến dịch" }] },
  { key: "campaign", label: "Chiến dịch", group: "Danh mục", deletable: true, search: ["name", "code"], dependents: [{ model: "customer", field: "campaignId", label: "khách hàng" }, { model: "lead", field: "campaignId", label: "lead" }] },
  { key: "tag", label: "Thẻ khách", group: "Danh mục", deletable: true, search: ["name"] },
  { key: "service", label: "Dịch vụ", group: "Danh mục", deletable: true, search: ["name", "code"], dependents: [{ model: "appointment", field: "serviceId", label: "lịch hẹn" }, { model: "procedureRecord", field: "serviceId", label: "ca mổ" }] },
  { key: "serviceCategory", label: "Nhóm dịch vụ", group: "Danh mục", deletable: true, search: ["name", "code"] },
  { key: "room", label: "Phòng & thiết bị", group: "Danh mục", deletable: true, search: ["name", "code"], dependents: [{ model: "appointment", field: "roomId", label: "lịch hẹn" }, { model: "procedureRecord", field: "roomId", label: "ca mổ" }] },
  { key: "shiftTemplate", label: "Loại ca làm việc", group: "Danh mục", deletable: true, search: ["name", "code"] },
  { key: "quickReply", label: "Mẫu tin nhanh", group: "Danh mục", deletable: true, search: ["title"] },
  { key: "product", label: "Vật tư", group: "Kho", deletable: true, search: ["name", "code"], dependents: [{ model: "stockLot", field: "productId", label: "lô hàng" }, { model: "productUsage", field: "productId", label: "lượt xuất dùng" }] },
  { key: "supplier", label: "Nhà cung cấp", group: "Kho", deletable: true, search: ["name", "code"], dependents: [{ model: "stockLot", field: "supplierId", label: "lô hàng" }] },
  { key: "stockLot", label: "Lô hàng", group: "Kho", deletable: false, reason: "Xoá lô là mất dấu truy vết implant. Dùng chức năng Huỷ lô kèm lý do ở màn Tồn kho.", search: ["lotNumber"] },
  { key: "appointment", label: "Lịch hẹn", group: "Vận hành", deletable: true, search: ["title"] },
  { key: "visit", label: "Lượt check-in", group: "Vận hành", deletable: true },
  { key: "commissionRule", label: "Quy tắc hoa hồng", group: "Nhân sự", deletable: true, search: ["name"] },
  { key: "kpiDefinition", label: "Chỉ tiêu KPI", group: "Nhân sự", deletable: true, search: ["name", "code"] },
  { key: "contract", label: "Hợp đồng", group: "Tài chính", deletable: false, reason: "Chứng từ tài chính — huỷ bằng nghiệp vụ ở màn Hợp đồng, giữ nguyên vết." },
  { key: "payment", label: "Phiếu thu", group: "Tài chính", deletable: false, reason: "Chứng từ tài chính, không được xoá." },
  { key: "invoice", label: "Hoá đơn", group: "Tài chính", deletable: false, reason: "Chứng từ tài chính, không được xoá." },
  { key: "medicalRecord", label: "Bệnh án", group: "Hồ sơ y tế", deletable: false, reason: "Hồ sơ y tế có nghĩa vụ lưu trữ — không xoá được từ khu quản trị." },
  { key: "consentForm", label: "Cam kết", group: "Hồ sơ y tế", deletable: false, reason: "Bằng chứng pháp lý về sự đồng ý của khách — không xoá." },
  { key: "procedureRecord", label: "Phiếu mổ", group: "Hồ sơ y tế", deletable: false, reason: "Hồ sơ y tế — không xoá." },
  { key: "auditLog", label: "Nhật ký thay đổi", group: "Nhật ký", deletable: false, reason: "Nhật ký chỉ ghi thêm. Ai xoá được vết thì vết mất hết giá trị." },
  { key: "dataAccessLog", label: "Nhật ký truy cập", group: "Nhật ký", deletable: false, reason: "Nhật ký chỉ ghi thêm — đây là bằng chứng khi điều tra rò rỉ bệnh án." },
];

const TABLE_BY_KEY = new Map(TABLES.map((t) => [t.key, t]));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function delegate(key: string): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const model = (prisma as any)[key];
  if (!model) throw notFound("Bảng không tồn tại");
  return model;
}

router.get(
  "/data/tables",
  asyncHandler(async (req, res) => {
    requireSystemAdmin(req);
    const rows = await Promise.all(
      TABLES.map(async (t) => ({
        ...t,
        count: await delegate(t.key).count().catch(() => 0),
      }))
    );
    res.json(rows);
  })
);

router.get(
  "/data/:table",
  asyncHandler(async (req, res) => {
    requireSystemAdmin(req);
    const def = TABLE_BY_KEY.get(req.params.table);
    if (!def) throw notFound("Bảng không nằm trong danh sách quản trị được");

    const q = (req.query.q as string)?.trim();
    const where =
      q && def.search?.length
        ? { OR: def.search.map((f) => ({ [f]: { contains: q } })) }
        : {};

    const [items, total] = await Promise.all([
      delegate(def.key).findMany({
        where,
        take: Math.min(Number(req.query.limit ?? 50), 200),
        skip: Number(req.query.offset ?? 0),
        orderBy: { createdAt: "desc" },
      }).catch(() =>
        // Vài bảng không có createdAt (SystemSetting) — thử lại không sắp xếp.
        delegate(def.key).findMany({ where, take: 50 })
      ),
      delegate(def.key).count({ where }),
    ]);

    res.json({ table: def, total, items });
  })
);

/** Đếm số bản ghi đang trỏ tới bản ghi này, theo từng bảng con. */
async function countDependents(def: TableDef, id: string) {
  if (!def.dependents?.length) return [];
  return Promise.all(
    def.dependents.map(async (d) => ({
      label: d.label,
      count: await delegate(d.model)
        .count({ where: { [d.field]: id } })
        .catch(() => 0),
    }))
  );
}

/** GET /data/:table/:id/impact — xem trước hậu quả TRƯỚC khi xoá. */
router.get(
  "/data/:table/:id/impact",
  asyncHandler(async (req, res) => {
    requireSystemAdmin(req);
    const def = TABLE_BY_KEY.get(req.params.table);
    if (!def) throw notFound("Bảng không nằm trong danh sách quản trị được");

    const dependents = (await countDependents(def, req.params.id)).filter((d) => d.count > 0);
    res.json({
      deletable: def.deletable,
      reason: def.reason,
      dependents,
      totalAffected: dependents.reduce((s, d) => s + d.count, 0),
    });
  })
);

router.delete(
  "/data/:table/:id",
  asyncHandler(async (req, res) => {
    requireSystemAdmin(req);
    const def = TABLE_BY_KEY.get(req.params.table);
    if (!def) throw notFound("Bảng không nằm trong danh sách quản trị được");

    if (!def.deletable) {
      throw new HttpError(403, def.reason ?? "Bảng này không cho xoá từ khu quản trị");
    }

    const reason = z.string().min(5).parse(req.query.reason ?? req.body?.reason);

    const before = await delegate(def.key)
      .findUnique({ where: { id: req.params.id } })
      .catch(() => null);
    if (!before) throw notFound("Không tìm thấy bản ghi");

    // Quan hệ SetNull khiến CSDL cho xoá và lặng lẽ gỡ liên kết. Với "nguồn
    // khách" chẳng hạn, khách sẽ mất quy kết nguồn và ROAS hỏng vĩnh viễn mà
    // không ai hay. Bắt buộc xác nhận rõ số bản ghi bị ảnh hưởng.
    const dependents = (await countDependents(def, req.params.id)).filter((d) => d.count > 0);
    const force = req.query.force === "1";
    if (dependents.length && !force) {
      const detail = dependents.map((d) => `${d.count} ${d.label}`).join(", ");
      throw new HttpError(
        409,
        `Bản ghi này đang được ${detail} tham chiếu. Xoá sẽ gỡ liên kết của chúng và không khôi phục được. Cân nhắc đánh dấu ngưng dùng thay vì xoá; nếu vẫn muốn xoá, xác nhận lại.`
      );
    }

    try {
      await delegate(def.key).delete({ where: { id: req.params.id } });
    } catch (err) {
      const e = err as { code?: string };
      // P2003: còn bản ghi con tham chiếu tới. Báo đúng nguyên nhân thay vì
      // "lỗi máy chủ", vì đây là tình huống rất hay gặp khi dọn danh mục.
      if (e.code === "P2003") {
        throw new HttpError(
          409,
          "Không xoá được vì còn dữ liệu khác đang tham chiếu tới bản ghi này. Hãy gỡ liên kết trước, hoặc đánh dấu ngưng dùng thay vì xoá."
        );
      }
      throw err;
    }

    await writeAudit({
      req,
      action: AuditAction.DELETE,
      entity: def.label,
      entityId: req.params.id,
      summary:
        `XOÁ bản ghi ${def.label} từ khu quản trị. Lý do: ${reason}` +
        (dependents.length
          ? ` — GỠ LIÊN KẾT của ${dependents.map((d) => `${d.count} ${d.label}`).join(", ")}`
          : ""),
      changes: { deleted: [JSON.stringify(before).slice(0, 500), null] },
    });

    res.json({ ok: true });
  })
);

/** Thống kê nhanh dung lượng dữ liệu, để quản trị biết CSDL đang phình ở đâu. */
router.get(
  "/data/stats/overview",
  asyncHandler(async (req, res) => {
    requireSystemAdmin(req);
    const [customers, messages, audits, accessLogs, photos] = await Promise.all([
      prisma.customer.count(),
      prisma.chatMessage.count(),
      prisma.auditLog.count(),
      prisma.dataAccessLog.count(),
      prisma.photoAsset.count(),
    ]);
    res.json({ customers, messages, audits, accessLogs, photos });
  })
);

export default router;
