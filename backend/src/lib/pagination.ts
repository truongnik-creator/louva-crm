import { z } from "zod";

// Phân trang dùng chung cho MỌI list endpoint (T3).
//
// Trước đây mỗi route tự đọc `req.query.limit` bằng Number(...) — gửi "abc" ra
// NaN, gửi 1e9 là quét cả bảng, và nhiều route không có `take` nào. Giờ mọi
// danh sách đi qua `parsePagination`:
//   - limit: số nguyên >= 1, vượt trần thì bị kẹp về trần (không lỗi, để các
//     màn cũ gửi limit lớn vẫn chạy);
//   - offset (bí danh skip): số nguyên >= 0, có trần MAX_OFFSET — sâu hơn thì
//     dùng cursor;
//   - cursor: id bản ghi cuối trang trước (Prisma cursor + skip 1).
// Giá trị sai kiểu (âm, chữ, số thực) -> 400 qua ZodError.

export const MAX_OFFSET = 50_000;

const intParam = (min: number, max?: number) => {
  let s = z.coerce.number({ invalid_type_error: "phải là số" }).int("phải là số nguyên").min(min);
  if (max !== undefined) s = s.max(max);
  return s;
};

export const paginationSchema = z.object({
  limit: intParam(1).optional(),
  offset: intParam(0, MAX_OFFSET).optional(),
  skip: intParam(0, MAX_OFFSET).optional(),
  cursor: z.string().min(1).max(128).optional(),
});

export type PaginationQuery = z.infer<typeof paginationSchema>;

export interface PaginationOptions {
  /** Số dòng mặc định khi client không gửi limit. */
  defaultLimit?: number;
  /** Trần cứng của limit. */
  maxLimit?: number;
}

export interface PageArgs {
  take: number;
  skip: number;
  cursor?: { id: string };
  /** limit đã kẹp, tiện cho kiểu "lấy limit+1 để biết còn trang sau". */
  limit: number;
  offset: number;
}

/**
 * Đọc tham số phân trang từ query string. Chỉ lấy đúng 4 khoá của nó, các khoá
 * lọc khác của route để nguyên.
 */
export function parsePagination(query: unknown, options: PaginationOptions = {}): PageArgs {
  const { defaultLimit = 100, maxLimit = 500 } = options;
  const q = (query ?? {}) as Record<string, unknown>;
  const pick = (k: string) => (q[k] === undefined || q[k] === "" ? undefined : q[k]);
  const parsed = paginationSchema.parse({
    limit: pick("limit"),
    offset: pick("offset"),
    skip: pick("skip"),
    cursor: pick("cursor"),
  });

  const limit = Math.min(parsed.limit ?? defaultLimit, maxLimit);
  const offset = parsed.offset ?? parsed.skip ?? 0;

  if (parsed.cursor) {
    return { take: limit, skip: 1, cursor: { id: parsed.cursor }, limit, offset: 0 };
  }
  return { take: limit, skip: offset, limit, offset };
}

/** Kiểu rút gọn cho findMany: `prisma.x.findMany({ where, ...page(req.query) })`. */
export function pageQuery(
  query: unknown,
  options: PaginationOptions = {}
): { take: number; skip: number; cursor?: { id: string } } {
  const { take, skip, cursor } = parsePagination(query, options);
  return cursor ? { take, skip, cursor } : { take, skip };
}

/** Danh mục nhỏ (cơ sở, phòng, vai trò...): vẫn có trần nhưng mặc định rộng. */
export const CATALOG_PAGE: PaginationOptions = { defaultLimit: 500, maxLimit: 1000 };
