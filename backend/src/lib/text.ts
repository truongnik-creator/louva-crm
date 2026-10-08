// Tiện ích chuỗi tiếng Việt dùng chung.

/** Bỏ dấu tiếng Việt, chữ thường, gộp khoảng trắng: "Nguyễn  Thị Lan" -> "nguyen thi lan". */
export function normalizeName(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const s = String(raw)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return s || null;
}

/** Khoảng cách Levenshtein, dùng cho cảnh báo tên gần giống (gõ sai một hai chữ). */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

/**
 * Hai tên (đã normalizeName) có "gần giống" không: trùng hẳn sau bỏ dấu, hoặc
 * lệch tối đa 1 ký tự với tên ngắn / 2 ký tự với tên từ 12 ký tự trở lên.
 */
export function isSimilarName(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const threshold = Math.max(a.length, b.length) >= 12 ? 2 : 1;
  if (Math.abs(a.length - b.length) > threshold) return false;
  return levenshtein(a, b) <= threshold;
}
