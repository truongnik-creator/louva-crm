import { prisma } from "./prisma";

// F38: nối dòng việc trong trang tính với bài trong bảng sản xuất nội dung.
//
// Khối sáng tạo đã ghi trang tính từ trước F37, và sẽ còn ghi tiếp — không ai
// muốn nhập hai lần. Cột "✅Link hoàn thành" của trang tính chính là bằng chứng
// bài đã đăng, cột "📶Đánh giá bài đăng" chính là kết quả. Việc duy nhất phải
// làm là nhận ra dòng đó ứng với bài nào.
//
// NGUYÊN TẮC: ghép sai nguy hiểm hơn không ghép. Một bài bị gán nhầm kết quả
// của bài khác sẽ làm hỏng mọi số liệu dựa trên nó, và không ai phát hiện ra.
// Nên chỉ ghép tự động khi URL chuẩn hoá TRÙNG KHÍT. Giống tên việc thì để con
// người quyết (xem `goiYGhep` ở routes/content.ts).

/** Tham số theo dõi cần bỏ — chúng không đổi bài, chỉ đổi đường dẫn. */
const TRACKING_PARAMS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "utm_id",
  "fbclid",
  "gclid",
  "ttclid",
  "igshid",
  "si",
  "is_from_webapp",
  "sender_device",
  "web_id",
  "_r",
  "_t",
  "mibextid",
  "rdid",
];

/**
 * Quy một URL bài đăng về một khoá so sánh được.
 *
 * Cùng một bài TikTok có thể xuất hiện dưới nhiều dạng tuỳ người dán từ đâu:
 *   https://www.tiktok.com/@nova/video/7412?is_from_webapp=1&sender_device=pc
 *   https://m.tiktok.com/@nova/video/7412/
 *   https://vt.tiktok.com/@nova/video/7412?_t=abc&_r=1
 * Cả ba phải ra cùng một khoá, nếu không thì bài dán từ điện thoại sẽ không bao
 * giờ khớp với bài dán từ máy tính.
 *
 * Trả về null khi chuỗi không phải URL dùng được — gồm cả ô chỉ có chữ "Link"
 * (trang tính chạy đường KÉO không lấy được siêu liên kết, xem docs F36).
 */
export function normalizePostUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim();
  if (!s) return null;

  let u: URL;
  try {
    u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;

  // Tên miền phải có dấu chấm và đuôi là chữ. Không có bước này thì ô chỉ ghi
  // "Link" (trang tính chạy đường KÉO) sẽ thành "https://Link" — một URL hợp
  // lệ về cú pháp — rồi MỌI ô như vậy cùng ra một khoá và ghép nhầm vào nhau.
  // Đây là lỗi âm thầm: số liệu sai mà không ai thấy báo đỏ ở đâu cả.
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/i.test(u.hostname)) return null;

  // Tên miền: bỏ tiền tố thiết bị / rút gọn, hạ chữ thường.
  let host = u.hostname.toLowerCase().replace(/^(www|m|mobile|vt|vm|web|l)\./, "");
  // Facebook có nhiều tên miền quốc gia trỏ cùng nội dung.
  if (/(^|\.)facebook\.[a-z.]+$/.test(host)) host = "facebook.com";

  // Đường dẫn: bỏ dấu "/" cuối, giữ nguyên hoa thường vì id bài phân biệt.
  const path = u.pathname.replace(/\/+$/, "") || "/";

  // Tham số: bỏ tham số theo dõi, phần còn lại sắp xếp để thứ tự không đổi khoá.
  const keep: Array<[string, string]> = [];
  u.searchParams.forEach((v, k) => {
    if (!TRACKING_PARAMS.includes(k.toLowerCase())) keep.push([k, v]);
  });
  keep.sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])));
  const query = keep.length ? `?${keep.map(([k, v]) => `${k}=${v}`).join("&")}` : "";

  // Bỏ neo (#) — nó cuộn trang, không đổi bài.
  return `${host}${path}${query}`;
}

/**
 * Ghép lại toàn bộ dòng việc của một nguồn trang tính với các bài.
 *
 * Gọi sau mỗi lần đồng bộ. Đồng bộ xoá rồi ghi lại toàn bộ dòng của sheet, nên
 * việc ghép cũng TÍNH LẠI chứ không cộng dồn — trang tính luôn là nguồn sự
 * thật, sửa link trong trang tính thì lần đồng bộ sau tự sửa theo.
 *
 * Chỉ ghép trong phạm vi cơ sở của nguồn: hai cơ sở có thể đăng cùng một link
 * (chia sẻ lại bài của nhau), và kết quả phải về đúng bài của cơ sở mình.
 */
export async function matchEntriesToPlans(sourceId: string): Promise<{ matched: number; unmatched: number }> {
  const entries = await prisma.workReportEntry.findMany({
    where: { sourceId, linkUrlKey: { not: null } },
    select: { id: true, linkUrlKey: true, branchId: true },
  });
  if (entries.length === 0) return { matched: 0, unmatched: 0 };

  const keys = [...new Set(entries.map((e) => e.linkUrlKey!))];
  const plans = await prisma.contentPlan.findMany({
    where: { postUrlKey: { in: keys } },
    select: { id: true, postUrlKey: true, branchId: true },
  });

  // Một khoá ứng với nhiều bài (hai người cùng khai một link) là dữ liệu mập
  // mờ — bỏ qua cả cụm thay vì chọn bừa một bài.
  const byKey = new Map<string, Array<{ id: string; branchId: string | null }>>();
  for (const p of plans) {
    const list = byKey.get(p.postUrlKey!) ?? [];
    list.push({ id: p.id, branchId: p.branchId });
    byKey.set(p.postUrlKey!, list);
  }

  let matched = 0;
  let unmatched = 0;
  const updates = new Map<string, string[]>(); // planId -> entryIds

  for (const e of entries) {
    const cands = (byKey.get(e.linkUrlKey!) ?? []).filter(
      (p) => !p.branchId || !e.branchId || p.branchId === e.branchId
    );
    if (cands.length !== 1) {
      unmatched++;
      continue;
    }
    const list = updates.get(cands[0].id) ?? [];
    list.push(e.id);
    updates.set(cands[0].id, list);
    matched++;
  }

  await prisma.$transaction(async (tx) => {
    // Gỡ hết liên kết cũ của nguồn này trước, rồi gắn lại theo kết quả mới.
    await tx.workReportEntry.updateMany({
      where: { sourceId, contentPlanId: { not: null } },
      data: { contentPlanId: null },
    });
    for (const [planId, entryIds] of updates) {
      await tx.workReportEntry.updateMany({ where: { id: { in: entryIds } }, data: { contentPlanId: planId } });
    }
  });

  return { matched, unmatched };
}

/** Thứ bậc đánh giá bài đăng — để lấy kết quả TỐT NHẤT khi một bài có nhiều dòng. */
const RATING_RANK: Record<string, number> = { BAD: 1, AVERAGE: 2, GOOD: 3, EXCELLENT: 4 };

export function bestRating(codes: Array<string | null>): string | null {
  let best: string | null = null;
  for (const c of codes) {
    if (!c) continue;
    if (!best || (RATING_RANK[c] ?? 0) > (RATING_RANK[best] ?? 0)) best = c;
  }
  return best;
}

export { RATING_RANK };

/**
 * Ghép một bài vừa được dán link với các dòng việc đã có sẵn trong CSDL.
 *
 * Trình tự thật ngoài đời thường ngược với lúc thiết kế: bạn media đăng bài,
 * ghi link vào trang tính, trang tính đồng bộ về — rồi mãi sau mới có người mở
 * CRM dán link vào bài. Nếu chỉ ghép lúc đồng bộ thì những dòng đã về trước đó
 * nằm im mãi. Hàm này lo chiều ngược lại.
 */
export async function matchPlan(planId: string): Promise<number> {
  const plan = await prisma.contentPlan.findUnique({
    where: { id: planId },
    select: { id: true, postUrlKey: true, branchId: true },
  });

  // Gỡ liên kết cũ trước: bài bị đổi link thì các dòng cũ không còn thuộc về nó.
  await prisma.workReportEntry.updateMany({ where: { contentPlanId: planId }, data: { contentPlanId: null } });
  if (!plan?.postUrlKey) return 0;

  // Chỉ gắn khi khoá này ứng với đúng MỘT bài — giống quy tắc ở matchEntriesToPlans.
  const trung = await prisma.contentPlan.count({
    where: { postUrlKey: plan.postUrlKey, ...(plan.branchId ? { branchId: plan.branchId } : {}) },
  });
  if (trung !== 1) return 0;

  const res = await prisma.workReportEntry.updateMany({
    where: {
      linkUrlKey: plan.postUrlKey,
      ...(plan.branchId ? { OR: [{ branchId: plan.branchId }, { branchId: null }] } : {}),
    },
    data: { contentPlanId: planId },
  });
  return res.count;
}
