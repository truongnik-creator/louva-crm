import { z } from "zod";
import { prisma } from "./prisma";
import { currentListPrice } from "./pricing";
import { HttpError } from "../middleware/errorHandler";
import { FaceArea } from "../types/enums";

// F30: PHIẾU TƯ VẤN TRÊN MÁY TÍNH BẢNG.
//
// Phiếu gồm vùng mặt, dịch vụ đề xuất (lấy từ bảng giá), sản phẩm, liều theo
// 0,1 đơn vị (15 = 1,5cc) và ảnh "trước" (PhotoSet mốc CONSULT). Từ phiếu lập
// phác đồ (TreatmentPlan), từ phác đồ lập báo giá theo giá niêm yết (Quotation)
// hoặc gắn báo giá sẵn có. Liều lưu số nguyên, không dùng số thực.

export const FACE_AREA_LABEL: Record<FaceArea, string> = {
  TRAN: "Trán",
  THAI_DUONG: "Thái dương",
  HOC_MAT: "Hốc mắt, bọng mắt",
  MUI: "Mũi",
  MA: "Má",
  RANH_MUI_MA: "Rãnh mũi má",
  MOI: "Môi",
  CAM: "Cằm",
  HAM: "Góc hàm",
  NONG_CAM: "Nọng cằm",
  CO: "Cổ",
  TOAN_MAT: "Toàn mặt",
};

export const proposalInputSchema = z.object({
  serviceId: z.string().uuid(),
  productId: z.string().uuid().optional().nullable(),
  /** Liều theo 0,1 đơn vị: 15 = 1,5cc (hoặc 1,5 ống, 1,5 đơn vị theo sản phẩm). */
  doseTenths: z.number().int().min(1).max(10_000).optional().nullable(),
  /** Số lượng lên báo giá (đơn vị bán của bảng giá). Trống = làm tròn lên từ liều, không có liều thì 1. */
  quantity: z.number().int().min(1).max(100).optional().nullable(),
  faceArea: z.nativeEnum(FaceArea).optional().nullable(),
  note: z.string().trim().max(300).optional().nullable(),
});
export type ProposalInput = z.infer<typeof proposalInputSchema>;

export interface Proposal {
  serviceId: string;
  serviceName: string;
  productId: string | null;
  productName: string | null;
  productUnit: string | null;
  doseTenths: number | null;
  quantity: number;
  faceArea: FaceArea | null;
  listPrice: number | null;
  note: string | null;
}

/** "15" -> "1,5". */
export function formatTenths(v: number | null | undefined): string {
  if (v == null) return "";
  const whole = Math.trunc(v / 10);
  const frac = Math.abs(v % 10);
  return frac ? `${whole},${frac}` : String(whole);
}

export function defaultQuantity(doseTenths: number | null | undefined): number {
  return doseTenths ? Math.max(1, Math.ceil(doseTenths / 10)) : 1;
}

/** Kiểm dịch vụ, sản phẩm tồn tại; chụp tên và giá niêm yết hiện hành. */
export async function enrichProposals(items: ProposalInput[], branchId: string): Promise<Proposal[]> {
  const serviceIds = [...new Set(items.map((i) => i.serviceId))];
  const productIds = [...new Set(items.map((i) => i.productId).filter((x): x is string => Boolean(x)))];
  const [services, products] = await Promise.all([
    prisma.service.findMany({ where: { id: { in: serviceIds } }, select: { id: true, name: true, active: true } }),
    prisma.product.findMany({ where: { id: { in: productIds } }, select: { id: true, name: true, unit: true } }),
  ]);
  const svc = new Map(services.map((s) => [s.id, s]));
  const prod = new Map(products.map((p) => [p.id, p]));
  const out: Proposal[] = [];
  for (const i of items) {
    const s = svc.get(i.serviceId);
    if (!s || !s.active) throw new HttpError(400, "Dịch vụ đề xuất không có trong bảng giá hoặc đã ngừng");
    const p = i.productId ? prod.get(i.productId) : null;
    if (i.productId && !p) throw new HttpError(400, "Không tìm thấy sản phẩm đề xuất");
    const price = await currentListPrice(s.id, branchId);
    out.push({
      serviceId: s.id,
      serviceName: s.name,
      productId: p?.id ?? null,
      productName: p?.name ?? null,
      productUnit: p?.unit ?? null,
      doseTenths: i.doseTenths ?? null,
      quantity: i.quantity ?? defaultQuantity(i.doseTenths),
      faceArea: i.faceArea ?? null,
      listPrice: price?.price ?? null,
      note: i.note?.trim() || null,
    });
  }
  return out;
}

export function parseProposals(raw: string | null | undefined): Proposal[] {
  try {
    const v = JSON.parse(raw ?? "[]");
    return Array.isArray(v) ? (v as Proposal[]) : [];
  } catch {
    return [];
  }
}

export function parseFaceAreas(raw: string | null | undefined): FaceArea[] {
  try {
    const v = JSON.parse(raw ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is FaceArea => typeof x === "string" && x in FACE_AREA_LABEL) : [];
  } catch {
    return [];
  }
}

/** Tên dòng báo giá: dịch vụ + vùng + liều thật (liều lẻ vẫn ghi đúng dù số lượng làm tròn). */
export function planItemLabel(i: { name: string; faceArea: string | null; doseTenths: number | null; productName: string | null }): string {
  const bits: string[] = [];
  if (i.faceArea && i.faceArea in FACE_AREA_LABEL) bits.push(FACE_AREA_LABEL[i.faceArea as FaceArea]);
  if (i.productName) bits.push(i.productName);
  if (i.doseTenths) bits.push(`liều ${formatTenths(i.doseTenths)}`);
  return bits.length ? `${i.name} (${bits.join(", ")})` : i.name;
}
