import { Request, Response, NextFunction } from "express";
import { PermissionScope } from "../types/enums";
import { HttpError } from "./errorHandler";
import { currentUser } from "./auth";

// Ba cổng phân quyền (mục 4.1 tài liệu kiến trúc):
//
//   Cổng 1 VAI TRÒ   — vai trò có quyền `<module>.<action>` không?      -> 403
//   Cổng 2 CƠ SỞ     — người dùng có thuộc branchId đang thao tác không? -> 404
//   Cổng 3 PHẠM VI   — ALL / BRANCH / OWN                                -> 404
//
// Cổng 2 và cổng 3 trả 404 chứ không phải 403: 403 sẽ lộ ra rằng bản ghi có
// tồn tại ở cơ sở khác. Với bệnh án phòng khám, đó đã là rò rỉ thông tin.

/** 404 dùng cho mọi trường hợp vượt phạm vi — không tiết lộ sự tồn tại. */
export function notFound(message = "Không tìm thấy"): HttpError {
  return new HttpError(404, message);
}

export function hasPermission(req: Request, code: string): boolean {
  return Boolean(req.user?.permissions[code]);
}

export function scopeOf(req: Request, code: string): PermissionScope | null {
  return (req.user?.permissions[code] as PermissionScope | undefined) ?? null;
}

/** Cổng 1 — chặn ngay ở tầng route nếu vai trò không có quyền. */
export function requirePermission(code: string) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(new HttpError(401, "Chưa đăng nhập"));
    if (!req.user.permissions[code]) {
      return next(new HttpError(403, `Không có quyền: ${code}`));
    }
    return next();
  };
}

/** Chấp nhận nếu có BẤT KỲ quyền nào trong danh sách (dùng cho route đọc chung). */
export function requireAnyPermission(...codes: string[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(new HttpError(401, "Chưa đăng nhập"));
    if (!codes.some((c) => req.user!.permissions[c])) {
      return next(new HttpError(403, `Không có quyền: ${codes.join(" hoặc ")}`));
    }
    return next();
  };
}

/**
 * Như `requireAnyPermission` nhưng LOẠI phạm vi OWN.
 *
 * Nhiều vai trò được cấp `hr.read` phạm vi OWN chỉ để tự xem lịch trực và bảng
 * công của chính mình. Nếu route báo cáo toàn công ty chỉ hỏi "có quyền hr.read
 * không" thì thủ kho cũng mở được bảng doanh số và tiền thực thu của cả phòng
 * khám. Dùng hàm này cho mọi báo cáo tổng hợp nhiều người.
 */
export function requireCrossPersonPermission(...codes: string[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(new HttpError(401, "Chưa đăng nhập"));
    const ok = codes.some((c) => {
      const scope = req.user!.permissions[c];
      return scope && scope !== PermissionScope.OWN;
    });
    if (!ok) {
      return next(
        new HttpError(403, `Không có quyền xem số liệu của người khác: ${codes.join(" hoặc ")}`)
      );
    }
    return next();
  };
}

/**
 * Cổng 2 — cơ sở đang thao tác phải nằm trong danh sách cơ sở của người dùng.
 * Người có phạm vi ALL cho quyền `code` được đi xuyên cơ sở.
 */
export function assertBranchAccess(req: Request, branchId: string | null | undefined, code: string): void {
  if (!branchId) return;
  const user = currentUser(req);
  if (scopeOf(req, code) === PermissionScope.ALL) return;
  if (!user.branchIds.includes(branchId)) throw notFound();
}

export interface ScopeFilter {
  /** Mệnh đề where ghép thêm vào truy vấn Prisma. */
  where: Record<string, unknown>;
  scope: PermissionScope;
}

/**
 * Cổng 3 — dựng mệnh đề `where` theo phạm vi dữ liệu.
 *
 * @param ownerFields Các cột thể hiện "của tôi". Truyền nhiều cột khi một bản
 *   ghi có thể thuộc về nhiều vai trò cùng lúc (ví dụ Customer có cả
 *   assignedToId lẫn telesaleId) — khi đó dùng OR.
 * @param branchField Tên cột cơ sở; đặt null cho bảng liên thông toàn công ty
 *   như Customer (khách liên thông, xem mục 4.2).
 */
export function scopedWhere(
  req: Request,
  code: string,
  options: { ownerFields?: string[]; branchField?: string | null } = {}
): ScopeFilter {
  const user = currentUser(req);
  const scope = scopeOf(req, code);
  if (!scope) throw new HttpError(403, `Không có quyền: ${code}`);

  const { ownerFields = [], branchField = "branchId" } = options;

  if (scope === PermissionScope.ALL) return { where: {}, scope };

  if (scope === PermissionScope.BRANCH) {
    if (!branchField) return { where: {}, scope };
    return { where: { [branchField]: { in: user.branchIds } }, scope };
  }

  // OWN — chỉ dữ liệu mình phụ trách, vẫn giới hạn trong cơ sở của mình.
  const ownerClause =
    ownerFields.length === 0
      ? {}
      : ownerFields.length === 1
        ? { [ownerFields[0]]: user.id }
        : { OR: ownerFields.map((f) => ({ [f]: user.id })) };

  const branchClause = branchField ? { [branchField]: { in: user.branchIds } } : {};
  return { where: { ...branchClause, ...ownerClause }, scope };
}

/**
 * Kiểm tra một bản ghi đã nạp có nằm trong phạm vi không. Dùng cho các route
 * :id sau khi findUnique — ném 404 thay vì 403 khi vượt phạm vi.
 */
export function assertInScope(
  req: Request,
  code: string,
  record: Record<string, unknown> | null,
  options: { ownerFields?: string[]; branchField?: string | null } = {}
): void {
  if (!record) throw notFound();
  const user = currentUser(req);
  const scope = scopeOf(req, code);
  if (!scope) throw new HttpError(403, `Không có quyền: ${code}`);
  if (scope === PermissionScope.ALL) return;

  const { ownerFields = [], branchField = "branchId" } = options;

  if (branchField) {
    const branchId = record[branchField] as string | null | undefined;
    if (branchId && !user.branchIds.includes(branchId)) throw notFound();
  }

  if (scope === PermissionScope.OWN && ownerFields.length) {
    const isOwner = ownerFields.some((f) => record[f] === user.id);
    if (!isOwner) throw notFound();
  }
}

/**
 * Che số điện thoại cho vai trò không có `customer.view_phone` (mục 4.4).
 * Marketing thấy danh sách khách nhưng SĐT hiện dạng 09xx xxx 123.
 */
export function maskPhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 6) return "xxx";
  return `${digits.slice(0, 2)}xx xxx ${digits.slice(-3)}`;
}

export function phoneFor(req: Request, phone: string | null | undefined): string | null {
  return hasPermission(req, "customer.view_phone") ? (phone ?? null) : maskPhone(phone);
}

function maskNested(value: unknown, depth: number): unknown {
  if (depth > 10 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => maskNested(v, depth + 1));
  if (value instanceof Date || Buffer.isBuffer(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (k === "customer" && v && typeof v === "object" && !Array.isArray(v) && "phone" in v) {
      const c = v as Record<string, unknown>;
      out[k] = { ...(maskNested(c, depth + 1) as Record<string, unknown>), phone: maskPhone(c.phone as string | null) };
    } else {
      out[k] = maskNested(v, depth + 1);
    }
  }
  return out;
}

/**
 * Che SĐT của mọi đối tượng `customer` lồng trong dữ liệu trả về (lịch hẹn,
 * hàng đợi, lịch mổ, hợp đồng, hoá đơn, kho...) cho vai trò không có
 * `customer.view_phone`. Dùng hàm này thay vì tự nhớ gọi phoneFor ở từng chỗ.
 */
export function maskCustomerPhones<T>(req: Request, data: T): T {
  if (hasPermission(req, "customer.view_phone")) return data;
  return maskNested(data, 0) as T;
}

/**
 * Middleware gắn ở cấp router: mọi res.json của router đó đi qua
 * maskCustomerPhones. Router nào trả khách lồng bên trong (không phải màn khách
 * hàng) thì gắn cái này, không phải sửa từng route.
 */
export function maskCustomerPhonesInResponse(req: Request, res: Response, next: NextFunction) {
  const original = res.json.bind(res);
  res.json = (body?: unknown) => original(maskCustomerPhones(req, body));
  next();
}

/**
 * Dữ liệu phát qua socket tới cả phòng cơ sở không biết người nhận có quyền
 * xem SĐT hay không: luôn che. Màn hình cần số thật thì tải lại qua API.
 */
export function maskCustomerPhonesForBroadcast<T>(data: T): T {
  return maskNested(data, 0) as T;
}
