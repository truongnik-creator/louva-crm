import type { Request, Response, NextFunction } from "express";

// Lưới an toàn cho S4/B17: cột `phoneNormalized` CHÍNH LÀ số điện thoại thật.
// Route nào lỡ trả nguyên bản ghi Customer/Lead (include: { customer: true },
// spread `...customer`) thì SĐT đã che ở cột `phone` vẫn lộ qua cột này. Gỡ hai
// cột chuẩn hoá khỏi MỌI phản hồi JSON; máy khách không cần chúng.

const INTERNAL_KEYS = new Set(["phoneNormalized", "nameNormalized"]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== "object") return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

export function stripInternalKeys(value: unknown, depth = 0): unknown {
  if (depth > 12) return value;
  if (Array.isArray(value)) return value.map((v) => stripInternalKeys(v, depth + 1));
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (INTERNAL_KEYS.has(k)) continue;
    out[k] = stripInternalKeys(v, depth + 1);
  }
  return out;
}

export function stripInternalFields(_req: Request, res: Response, next: NextFunction) {
  const original = res.json.bind(res);
  res.json = (body?: unknown) => original(stripInternalKeys(body));
  next();
}
