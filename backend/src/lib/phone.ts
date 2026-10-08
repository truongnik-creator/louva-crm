// Chuẩn hoá số điện thoại Việt Nam (B17).
//
// Khách gõ SĐT đủ kiểu: "+84 912 345 678", "84912345678", "0912.345.678",
// "(091) 234-5678". Không chuẩn hoá thì cùng một người thành 3 hồ sơ và chống
// trùng vô tác dụng. Mọi so khớp SĐT (tạo khách, tạo lead, chuyển lead, gộp hồ
// sơ, đồng bộ Pancake) phải đi qua cột `phoneNormalized` do hàm này sinh ra.

/** Bỏ mọi ký tự không phải chữ số, giữ dấu + đầu chuỗi để nhận diện mã quốc gia. */
function stripFormatting(raw: string): string {
  const trimmed = raw.trim();
  const plus = trimmed.startsWith("+");
  const digits = trimmed.replace(/\D/g, "");
  return plus ? `+${digits}` : digits;
}

/**
 * Trả về SĐT dạng `0xxxxxxxxx` (10 số di động, 11 số máy bàn 02x), hoặc null
 * khi đầu vào rỗng/quá ngắn để là số điện thoại.
 *
 * Số nước ngoài (không phải +84) giữ nguyên dạng chỉ-chữ-số có dấu + để vẫn
 * chống trùng được, chỉ là không ép về đầu 0.
 */
export function normalizeVnPhone(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  let s = stripFormatting(String(raw));
  if (!s || s === "+") return null;

  if (s.startsWith("+84")) s = `0${s.slice(3)}`;
  else if (s.startsWith("0084")) s = `0${s.slice(4)}`;
  else if (s.startsWith("+")) return s.length >= 8 ? s : null; // số quốc tế khác
  else if (s.startsWith("84") && (s.length === 11 || s.length === 12)) s = `0${s.slice(2)}`;
  else if (!s.startsWith("0") && (s.length === 9 || s.length === 10)) s = `0${s}`; // quên số 0 đầu

  // "0" + "0912..." khi người dùng gõ "+84 0912..." — bỏ số 0 thừa.
  if (s.startsWith("00") && s.length >= 11) s = s.slice(1);

  return s.length >= 8 ? s : null;
}

/** SĐT di động hoặc máy bàn Việt Nam hợp lệ sau chuẩn hoá. */
export function isValidVnPhone(raw: string | null | undefined): boolean {
  const n = normalizeVnPhone(raw);
  return Boolean(n && /^0(3|5|7|8|9)\d{8}$|^02\d{9}$/.test(n));
}
