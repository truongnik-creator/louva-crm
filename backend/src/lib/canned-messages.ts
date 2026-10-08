import { prisma } from "./prisma";
import { formatVnd } from "./datetime";
import { currentListPrice } from "./pricing";

// F24: tin mẫu "Gửi vị trí" và "Gửi bảng giá chuẩn" trong hộp thư.
//
// Nội dung dựng từ DỮ LIỆU CƠ SỞ và BẢNG GIÁ NIÊM YẾT, không cho sale gõ tay:
// đó chính là hai lỗi NOVA đang gặp (khách không tìm thấy cơ sở vì địa chỉ đổi,
// sale báo giá sai).

export interface CannedResult {
  content: string;
  /** Thông tin còn thiếu để quản lý bổ sung (không chặn gửi nếu vẫn có nội dung). */
  missing: string[];
}

export async function buildLocationMessage(branchId: string | null): Promise<CannedResult> {
  const branch = branchId ? await prisma.branch.findUnique({ where: { id: branchId } }) : null;
  if (!branch) return { content: "", missing: ["cơ sở của hội thoại"] };
  const missing: string[] = [];
  const lines = [`Dạ, địa chỉ ${branch.name}:`];
  if (branch.address) lines.push(`📍 ${branch.address}`);
  else missing.push("địa chỉ");
  if (branch.mapUrl) lines.push(`Bản đồ: ${branch.mapUrl}`);
  else missing.push("link bản đồ");
  if (branch.buildingGuide) lines.push(`Lối vào: ${branch.buildingGuide}`);
  if (branch.parkingGuide) lines.push(`Gửi xe: ${branch.parkingGuide}`);
  if (branch.facadePhotoUrl) lines.push(`Ảnh mặt tiền: ${branch.facadePhotoUrl}`);
  if (branch.phone) lines.push(`Hotline: ${branch.phone}`);
  return { content: branch.address || branch.mapUrl ? lines.join("\n") : "", missing };
}

function parseInterest(v: string | null | undefined): string[] {
  if (!v) return [];
  try {
    const arr = JSON.parse(v);
    return Array.isArray(arr) ? arr.map(String) : [];
  } catch {
    return [];
  }
}

/**
 * Bảng giá niêm yết của các dịch vụ chọn (hoặc dịch vụ khách quan tâm) tại cơ
 * sở của hội thoại. Chỉ lấy giá đang hiệu lực, không bao giờ in giá sàn.
 */
export async function buildPriceMessage(opts: {
  branchId: string | null;
  serviceIds?: string[];
  customerInterest?: string | null;
}): Promise<CannedResult & { services: Array<{ id: string; name: string; price: number | null }> }> {
  if (!opts.branchId) return { content: "", missing: ["cơ sở của hội thoại"], services: [] };
  let services: Array<{ id: string; name: string }> = [];
  if (opts.serviceIds?.length) {
    services = await prisma.service.findMany({
      where: { id: { in: opts.serviceIds }, active: true },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    });
  } else {
    const interests = parseInterest(opts.customerInterest);
    for (const name of interests.slice(0, 5)) {
      const found = await prisma.service.findMany({
        where: { active: true, name: { contains: name } },
        select: { id: true, name: true },
        take: 5,
      });
      for (const f of found) if (!services.some((s) => s.id === f.id)) services.push(f);
    }
  }
  if (!services.length) return { content: "", missing: ["dịch vụ khách quan tâm"], services: [] };

  const now = new Date();
  const rows = [];
  for (const s of services) {
    // F13: bảng giá chung cho mọi cơ sở nếu bật pricing.singlePriceList.
    const price = await currentListPrice(s.id, opts.branchId, now);
    rows.push({ ...s, price: price?.price ?? null });
  }
  const priced = rows.filter((r) => r.price != null);
  const missing = rows.filter((r) => r.price == null).map((r) => `giá ${r.name}`);
  if (!priced.length) return { content: "", missing, services: rows };
  const lines = ["Dạ, bảng giá niêm yết bên em:"];
  for (const r of priced) lines.push(`• ${r.name}: ${formatVnd(r.price!)}đ`);
  lines.push("Chị cần em tư vấn thêm hoặc giữ lịch không ạ?");
  return { content: lines.join("\n"), missing, services: rows };
}
