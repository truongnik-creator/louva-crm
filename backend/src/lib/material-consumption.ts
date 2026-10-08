import { prisma } from "./prisma";
import { StockMoveType } from "../types/enums";

// TỰ ĐỘNG TRỪ VẬT TƯ THEO CA BỆNH.
//
// Khi kết thúc ca mổ, hệ thống lấy ĐỊNH MỨC vật tư gắn với dịch vụ và trừ kho
// tương ứng, đồng thời ghi ProductUsage để giữ nguyên khả năng truy vết lô ↔
// khách.
//
// Nguyên tắc chọn lô: FEFO (First Expired, First Out) — xuất lô sắp hết hạn
// trước. Không dùng FIFO theo ngày nhập, vì với vật tư y tế thì lô cận hạn phải
// đi trước để không phải huỷ.
//
// Thiếu hàng KHÔNG chặn việc kết thúc mổ: ca đã mổ xong rồi, chặn lại chỉ làm
// hồ sơ bệnh án treo. Thay vào đó trả về danh sách thiếu để nhân viên kho xử lý.

export interface ConsumptionResult {
  deducted: Array<{ product: string; quantity: number; lotNumber: string | null }>;
  shortages: Array<{ product: string; required: number; available: number }>;
}

export async function consumeServiceMaterials(input: {
  procedureId: string;
  serviceId: string | null;
  customerId: string;
  branchId: string;
  actorId: string;
}): Promise<ConsumptionResult> {
  const result: ConsumptionResult = { deducted: [], shortages: [] };
  if (!input.serviceId) return result;

  const materials = await prisma.serviceMaterial.findMany({
    where: { serviceId: input.serviceId },
    include: { product: { select: { id: true, name: true, unit: true } } },
  });
  if (!materials.length) return result;

  // Đã trừ rồi thì thôi — tránh trừ hai lần nếu ai đó bấm kết thúc mổ lần nữa.
  const already = await prisma.productUsage.findFirst({
    where: { procedureId: input.procedureId },
  });
  if (already) return result;

  for (const m of materials) {
    let remaining = m.quantity;

    // FEFO: lô hết hạn sớm nhất trước; lô không có hạn dùng xếp cuối.
    const lots = await prisma.stockLot.findMany({
      where: {
        productId: m.productId,
        quantity: { gt: 0 },
        warehouse: { branchId: input.branchId },
        OR: [{ expiryDate: null }, { expiryDate: { gt: new Date() } }],
      },
      orderBy: [{ expiryDate: "asc" }, { receivedAt: "asc" }],
    });

    const available = lots.reduce((s, l) => s + l.quantity, 0);

    for (const lot of lots) {
      if (remaining <= 0) break;
      const take = Math.min(remaining, lot.quantity);

      await prisma.$transaction(async (tx) => {
        await tx.stockLot.update({
          where: { id: lot.id },
          data: { quantity: lot.quantity - take },
        });
        await tx.stockMovement.create({
          data: {
            warehouseId: lot.warehouseId,
            productId: m.productId,
            lotId: lot.id,
            type: StockMoveType.OUT,
            quantity: -take,
            reason: "Tự động trừ theo định mức ca mổ",
            referenceId: input.procedureId,
            actorId: input.actorId,
          },
        });
        await tx.productUsage.create({
          data: {
            productId: m.productId,
            lotId: lot.id,
            customerId: input.customerId,
            procedureId: input.procedureId,
            branchId: input.branchId,
            quantity: take,
            quantityTenths: take * 10,
            costAtUse: lot.unitCost * take,
            recordedById: input.actorId,
            note: "Trừ tự động theo định mức dịch vụ",
          },
        });
      });

      result.deducted.push({
        product: m.product.name,
        quantity: take,
        lotNumber: lot.lotNumber,
      });
      remaining -= take;
    }

    if (remaining > 0) {
      result.shortages.push({
        product: m.product.name,
        required: m.quantity,
        available,
      });
    }
  }

  return result;
}
