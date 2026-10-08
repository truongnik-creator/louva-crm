import { getSettingRaw } from "./settings-catalog";

// Từ khoá y khoa trong tin khách (F9 quy tắc 2, AI2 lớp chặn 1, AI3 che nội dung).
// Danh sách chỉnh ở Cài đặt "automation.medicalKeywords".

export function parseKeywords(raw: string): string[] {
  return [...new Set(raw.split(/[,;\n]+/).map((k) => k.trim().toLowerCase()).filter((k) => k.length >= 2))];
}

export async function medicalKeywords(): Promise<string[]> {
  return parseKeywords(await getSettingRaw("automation.medicalKeywords"));
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Các từ khoá xuất hiện trong đoạn văn, so cả CỤM TỪ (không khớp giữa chừng
 * một từ khác: "thai" không khớp "thailand"). Có dấu tiếng Việt nên "đau" và
 * "đâu" là hai từ khác nhau.
 */
export function findMedicalKeywords(text: string, keywords: string[]): string[] {
  const t = text.normalize("NFC").toLowerCase();
  return keywords.filter((k) =>
    new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(k.normalize("NFC"))}(?=$|[^\\p{L}\\p{N}])`, "u").test(t)
  );
}

/** Thay các câu có từ khoá y khoa bằng dấu che (AI3 không nạp dữ liệu y khoa). */
export function redactMedical(text: string, keywords: string[]): string {
  return text
    .split(/(?<=[.!?\n])/)
    .map((sentence) => (findMedicalKeywords(sentence, keywords).length ? "[nội dung sức khoẻ đã ẩn] " : sentence))
    .join("");
}
