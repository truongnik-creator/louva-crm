import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { asyncHandler, HttpError } from "../middleware/errorHandler";
import { requireAuth, currentUser } from "../middleware/auth";
import { requirePermission, notFound } from "../middleware/rbac";
import { writeAudit } from "../lib/audit";
import { getSettingBool, getSettingNumber } from "../lib/settings-catalog";
import {
  AuditAction,
  ProductKind,
  PurchaseOrderStatus,
  StockMoveType,
  TransferStatus,
  WarehouseKind,
} from "../types/enums";
import { CodePrefix, nextCode } from "../lib/codes";

// KHO VẬT TƯ THEO LÔ.
//
// Nguyên tắc xuyên suốt: KHÔNG BAO GIỜ sửa thẳng StockLot.quantity. Mọi thay
// đổi đều đi qua một StockMovement trong cùng transaction, để cộng dồn sổ luôn
// khớp tồn kho — kiểm kê mới có cái để đối chiếu.

const router = Router();
router.use(requireAuth);

/** Kho của cơ sở đang làm việc; tự tạo kho mặc định nếu cơ sở chưa có. */
async function defaultWarehouse(branchId: string) {
  const existing = await prisma.warehouse.findFirst({
    where: { branchId },
    orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
  });
  if (existing) return existing;
  return prisma.warehouse.create({
    data: { branchId, code: "KHO_CHINH", name: "Kho chính", isDefault: true },
  });
}

/**
 * Ghi một biến động kho VÀ cập nhật tồn của lô trong cùng một giao dịch.
 * Tách riêng vì cả nhập hàng, xuất dùng, huỷ và kiểm kê đều phải đi qua đây.
 */
async function applyMovement(
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  input: {
    warehouseId: string;
    productId: string;
    lotId: string | null;
    type: string;
    quantity: number; // dương = nhập, âm = xuất
    reason?: string;
    referenceId?: string;
    actorId?: string;
  }
) {
  if (input.lotId) {
    const lot = await tx.stockLot.findUnique({ where: { id: input.lotId } });
    if (!lot) throw notFound("Không tìm thấy lô hàng");

    const next = lot.quantity + input.quantity;
    if (next < 0) {
      throw new HttpError(
        400,
        `Lô ${lot.lotNumber} chỉ còn ${lot.quantity}, không xuất được ${Math.abs(input.quantity)}`
      );
    }
    await tx.stockLot.update({ where: { id: lot.id }, data: { quantity: next } });
  }

  return tx.stockMovement.create({
    data: {
      warehouseId: input.warehouseId,
      productId: input.productId,
      lotId: input.lotId,
      type: input.type,
      quantity: input.quantity,
      reason: input.reason,
      referenceId: input.referenceId,
      actorId: input.actorId,
    },
  });
}

/* --------------------------------------------------------------- DANH MỤC */

router.get(
  "/products",
  requirePermission("inventory.read"),
  asyncHandler(async (req, res) => {
    const products = await prisma.product.findMany({
      where: {
        ...(req.query.q ? { name: { contains: String(req.query.q) } } : {}),
        ...(req.query.kind ? { kind: String(req.query.kind) } : {}),
        ...(req.query.active === "0" ? {} : { active: true }),
      },
      orderBy: { name: "asc" },
      include: { lots: { select: { quantity: true, expiryDate: true } } },
    });

    const now = Date.now();
    res.json(
      products.map((p) => {
        const onHand = p.lots.reduce((s, l) => s + l.quantity, 0);
        return {
          ...p,
          lots: undefined,
          onHand,
          lotCount: p.lots.filter((l) => l.quantity > 0).length,
          belowMin: p.minStock > 0 && onHand < p.minStock,
          // Vượt định mức tối đa = ứ đọng vốn và tăng rủi ro hết hạn trước khi
          // dùng hết. Cảnh báo nhẹ hơn thiếu hàng nhưng vẫn phải thấy.
          aboveMax: p.maxStock > 0 && onHand > p.maxStock,
          // Cận hạn = SẮP hết hạn, chưa hết. Lô đã quá hạn đếm riêng, nếu gộp
          // chung thì thủ kho tưởng còn dùng được thêm 90 ngày nữa.
          expiringSoon: p.lots.filter(
            (l) =>
              l.quantity > 0 &&
              l.expiryDate &&
              l.expiryDate.getTime() >= now &&
              l.expiryDate.getTime() - now < 90 * 86400000
          ).length,
          expiredLots: p.lots.filter(
            (l) => l.quantity > 0 && l.expiryDate && l.expiryDate.getTime() < now
          ).length,
        };
      })
    );
  })
);

router.post(
  "/products",
  requirePermission("inventory.create"),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        code: z.string().min(1),
        name: z.string().min(2),
        kind: z.nativeEnum(ProductKind).optional(),
        unit: z.string().optional(),
        isImplant: z.boolean().optional(),
        requiresLot: z.boolean().optional(),
        minStock: z.number().int().nonnegative().optional(),
        maxStock: z.number().int().nonnegative().optional(),
        note: z.string().optional(),
      })
      .parse(req.body);

    const product = await prisma.product.create({ data: body });
    await writeAudit({
      req,
      action: AuditAction.CREATE,
      entity: "Product",
      entityId: product.id,
      summary: `Thêm vật tư ${product.name}`,
    });
    res.status(201).json(product);
  })
);

router.get(
  "/suppliers",
  requirePermission("inventory.read"),
  asyncHandler(async (_req, res) => {
    res.json(
      await prisma.supplier.findMany({
        orderBy: { name: "asc" },
        include: { _count: { select: { lots: true, purchaseOrders: true } } },
      })
    );
  })
);

router.post(
  "/suppliers",
  requirePermission("inventory.create"),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        code: z.string().min(1),
        name: z.string().min(2),
        taxCode: z.string().optional(),
        phone: z.string().optional(),
        email: z.string().optional(),
        address: z.string().optional(),
        contactName: z.string().optional(),
        note: z.string().optional(),
      })
      .parse(req.body);

    const supplier = await prisma.supplier.create({ data: body });
    await writeAudit({
      req,
      action: AuditAction.CREATE,
      entity: "Supplier",
      entityId: supplier.id,
      summary: `Thêm nhà cung cấp ${supplier.name}`,
    });
    res.status(201).json(supplier);
  })
);

/* ------------------------------------------------------------- TỒN KHO */

// GET /api/inventory/on-hand — tồn theo LÔ, kèm cảnh báo cận hạn
router.get(
  "/on-hand",
  requirePermission("inventory.read"),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const expiringDays =
      Number(req.query.expiringDays) || (await getSettingNumber("inventory.expiringSoonDays"));
    const now = Date.now();

    const lots = await prisma.stockLot.findMany({
      where: {
        warehouse: { branchId: { in: me.branchIds } },
        ...(req.query.productId ? { productId: String(req.query.productId) } : {}),
        // Mặc định CHỈ hiện lô còn hàng. Lô đã hết vẫn nằm nguyên trong sổ để
        // truy vết, nhưng không được làm rối bảng tồn hằng ngày. Thêm ?all=1
        // khi cần soi lại lô cũ.
        ...(req.query.all === "1" ? {} : { quantity: { gt: 0 } }),
      },
      orderBy: [{ expiryDate: "asc" }],
      include: {
        product: { select: { id: true, code: true, name: true, unit: true, isImplant: true, minStock: true } },
        warehouse: { select: { id: true, name: true } },
        supplier: { select: { id: true, name: true } },
      },
    });

    const rows = lots.map((l) => {
      const daysToExpiry = l.expiryDate
        ? Math.round((l.expiryDate.getTime() - now) / 86400000)
        : null;
      return {
        ...l,
        daysToExpiry,
        expired: daysToExpiry !== null && daysToExpiry < 0,
        expiringSoon: daysToExpiry !== null && daysToExpiry >= 0 && daysToExpiry <= expiringDays,
      };
    });

    res.json({
      items: rows,
      stats: {
        lotCount: rows.filter((r) => r.quantity > 0).length,
        expired: rows.filter((r) => r.expired && r.quantity > 0).length,
        expiringSoon: rows.filter((r) => r.expiringSoon && r.quantity > 0).length,
        totalValue: rows.reduce((s, r) => s + r.quantity * r.unitCost, 0),
      },
    });
  })
);

/* ------------------------------------------------------- NHẬP / XUẤT KHO */

// POST /api/inventory/receive — nhập hàng, tạo lô mới hoặc cộng vào lô sẵn có
router.post(
  "/receive",
  requirePermission("inventory.create"),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        productId: z.string().uuid(),
        lotNumber: z.string().min(1),
        serialNumber: z.string().optional(),
        expiryDate: z.coerce.date().optional(),
        quantity: z.number().int().positive(),
        unitCost: z.number().int().nonnegative().optional(),
        supplierId: z.string().uuid().optional(),
        warehouseId: z.string().uuid().optional(),
        note: z.string().optional(),
      })
      .parse(req.body);

    const me = currentUser(req);
    if (!me.activeBranchId) throw new HttpError(400, "Chưa xác định được cơ sở");
    const warehouse = body.warehouseId
      ? await prisma.warehouse.findUnique({ where: { id: body.warehouseId } })
      : await defaultWarehouse(me.activeBranchId);
    if (!warehouse || !me.branchIds.includes(warehouse.branchId)) throw notFound("Không tìm thấy kho");

    const result = await prisma.$transaction(async (tx) => {
      // Cùng sản phẩm + cùng kho + cùng mã lô thì cộng dồn, không tạo lô trùng.
      const lot = await tx.stockLot.upsert({
        where: {
          productId_warehouseId_lotNumber: {
            productId: body.productId,
            warehouseId: warehouse.id,
            lotNumber: body.lotNumber,
          },
        },
        create: {
          productId: body.productId,
          warehouseId: warehouse.id,
          supplierId: body.supplierId,
          lotNumber: body.lotNumber,
          serialNumber: body.serialNumber,
          expiryDate: body.expiryDate,
          quantity: 0,
          unitCost: body.unitCost ?? 0,
          note: body.note,
        },
        update: {
          ...(body.expiryDate ? { expiryDate: body.expiryDate } : {}),
          ...(body.unitCost ? { unitCost: body.unitCost } : {}),
        },
      });

      await applyMovement(tx, {
        warehouseId: warehouse.id,
        productId: body.productId,
        lotId: lot.id,
        type: StockMoveType.IN,
        quantity: body.quantity,
        reason: body.note ?? "Nhập kho",
        actorId: me.id,
      });

      return tx.stockLot.findUniqueOrThrow({
        where: { id: lot.id },
        include: { product: { select: { name: true } } },
      });
    });

    await writeAudit({
      req,
      action: AuditAction.CREATE,
      entity: "StockLot",
      entityId: result.id,
      branchId: warehouse.branchId,
      summary: `Nhập ${body.quantity} ${result.product.name} — lô ${body.lotNumber}`,
    });

    res.status(201).json(result);
  })
);

/**
 * POST /api/inventory/use — xuất dùng cho KHÁCH.
 *
 * Đây là điểm gắn kho vào hồ sơ y tế: ghi ProductUsage nối lô ↔ khách ↔ ca mổ,
 * nhờ đó truy vết ngược được khi có thu hồi lô.
 */
router.post(
  "/use",
  requirePermission("inventory.update"),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        lotId: z.string().uuid(),
        customerId: z.string().uuid(),
        procedureId: z.string().uuid().optional(),
        quantity: z.number().int().positive().default(1),
        note: z.string().optional(),
      })
      .parse(req.body);

    const me = currentUser(req);
    const lot = await prisma.stockLot.findUnique({
      where: { id: body.lotId },
      include: { warehouse: true, product: { select: { name: true } } },
    });
    if (!lot || !me.branchIds.includes(lot.warehouse.branchId)) throw notFound("Không tìm thấy lô");

    const blockExpired = await getSettingBool("inventory.blockExpiredUse");
    if (blockExpired && lot.expiryDate && lot.expiryDate.getTime() < Date.now()) {
      throw new HttpError(400, `Lô ${lot.lotNumber} đã hết hạn ngày ${lot.expiryDate.toLocaleDateString("vi-VN")} — không được dùng cho khách`);
    }

    const usage = await prisma.$transaction(async (tx) => {
      await applyMovement(tx, {
        warehouseId: lot.warehouseId,
        productId: lot.productId,
        lotId: lot.id,
        type: StockMoveType.OUT,
        quantity: -body.quantity,
        reason: body.note ?? "Xuất dùng cho khách",
        referenceId: body.procedureId,
        actorId: me.id,
      });

      return tx.productUsage.create({
        data: {
          productId: lot.productId,
          lotId: lot.id,
          customerId: body.customerId,
          procedureId: body.procedureId,
          branchId: lot.warehouse.branchId,
          quantity: body.quantity,
          recordedById: me.id,
          note: body.note,
        },
      });
    });

    await writeAudit({
      req,
      action: AuditAction.UPDATE,
      entity: "ProductUsage",
      entityId: usage.id,
      branchId: lot.warehouse.branchId,
      summary: `Xuất ${body.quantity} ${lot.product.name} (lô ${lot.lotNumber}) dùng cho khách`,
    });

    res.status(201).json(usage);
  })
);

// POST /api/inventory/adjust — điều chỉnh / huỷ, bắt buộc lý do
router.post(
  "/adjust",
  requirePermission("inventory.update"),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        lotId: z.string().uuid(),
        quantity: z.number().int(), // âm = giảm
        type: z.enum([StockMoveType.ADJUST, StockMoveType.DISPOSE]).default(StockMoveType.ADJUST),
        reason: z.string().min(3),
      })
      .parse(req.body);

    const me = currentUser(req);
    const lot = await prisma.stockLot.findUnique({
      where: { id: body.lotId },
      include: { warehouse: true, product: { select: { name: true } } },
    });
    if (!lot || !me.branchIds.includes(lot.warehouse.branchId)) throw notFound("Không tìm thấy lô");

    await prisma.$transaction(async (tx) => {
      await applyMovement(tx, {
        warehouseId: lot.warehouseId,
        productId: lot.productId,
        lotId: lot.id,
        type: body.type,
        quantity: body.quantity,
        reason: body.reason,
        actorId: me.id,
      });
    });

    await writeAudit({
      req,
      action: AuditAction.UPDATE,
      entity: "StockLot",
      entityId: lot.id,
      branchId: lot.warehouse.branchId,
      summary: `${body.type === StockMoveType.DISPOSE ? "Huỷ" : "Điều chỉnh"} ${body.quantity} ${lot.product.name} (lô ${lot.lotNumber}). Lý do: ${body.reason}`,
    });

    res.json({ ok: true });
  })
);

// GET /api/inventory/movements — sổ xuất nhập
router.get(
  "/movements",
  requirePermission("inventory.read"),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    res.json(
      await prisma.stockMovement.findMany({
        where: {
          warehouse: { branchId: { in: me.branchIds } },
          ...(req.query.productId ? { productId: String(req.query.productId) } : {}),
          ...(req.query.type ? { type: String(req.query.type) } : {}),
        },
        orderBy: { createdAt: "desc" },
        take: Math.min(Number(req.query.limit ?? 200), 500),
        include: {
          product: { select: { id: true, name: true, unit: true } },
          lot: { select: { id: true, lotNumber: true, expiryDate: true } },
          actor: { select: { id: true, name: true } },
          warehouse: { select: { id: true, name: true } },
        },
      })
    );
  })
);

/* ------------------------------------------------------------- TRUY VẾT */

/**
 * GET /api/inventory/traceability/:lotId
 * Lô này đã dùng cho những khách nào — câu hỏi phải trả lời được trong vài phút
 * khi nhà sản xuất thu hồi lô.
 */
router.get(
  "/traceability/:lotId",
  requirePermission("inventory.read"),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const lot = await prisma.stockLot.findUnique({
      where: { id: req.params.lotId },
      include: {
        warehouse: true,
        product: { select: { id: true, code: true, name: true, isImplant: true } },
        supplier: { select: { id: true, name: true } },
      },
    });
    if (!lot || !me.branchIds.includes(lot.warehouse.branchId)) throw notFound("Không tìm thấy lô");

    const usages = await prisma.productUsage.findMany({
      where: { lotId: lot.id },
      orderBy: { usedAt: "desc" },
      include: {
        customer: { select: { id: true, code: true, name: true, phone: true } },
        procedure: { select: { id: true, code: true, title: true, scheduledAt: true } },
        recordedBy: { select: { id: true, name: true } },
      },
    });

    res.json({
      lot,
      usedQuantity: usages.reduce((s, u) => s + u.quantity, 0),
      customerCount: new Set(usages.map((u) => u.customerId).filter(Boolean)).size,
      usages,
    });
  })
);

/** GET /api/inventory/traceability/customer/:customerId — khách này đã dùng lô nào. */
router.get(
  "/traceability/customer/:customerId",
  requirePermission("inventory.read"),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    res.json(
      await prisma.productUsage.findMany({
        where: { customerId: req.params.customerId, branchId: { in: me.branchIds } },
        orderBy: { usedAt: "desc" },
        include: {
          product: { select: { id: true, name: true, isImplant: true } },
          lot: { select: { id: true, lotNumber: true, serialNumber: true, expiryDate: true } },
          procedure: { select: { id: true, code: true, title: true } },
        },
      })
    );
  })
);

/* ------------------------------------------------------------ KHO & PHÂN CẤP */

router.get(
  "/warehouses",
  requirePermission("inventory.read"),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const rows = await prisma.warehouse.findMany({
      where: { branchId: { in: me.branchIds } },
      orderBy: [{ kind: "asc" }, { name: "asc" }],
      include: {
        parent: { select: { id: true, name: true } },
        _count: { select: { lots: true, children: true } },
      },
    });

    // Tồn và giá trị theo từng kho, để quản lý nhìn được kho nào đang giữ hàng.
    const lots = await prisma.stockLot.groupBy({
      by: ["warehouseId"],
      _sum: { quantity: true },
    });
    const qtyByWarehouse = new Map(lots.map((l) => [l.warehouseId, l._sum.quantity ?? 0]));

    res.json(
      rows.map((w) => ({
        ...w,
        onHand: qtyByWarehouse.get(w.id) ?? 0,
        lotCount: w._count.lots,
        childCount: w._count.children,
        _count: undefined,
      }))
    );
  })
);

router.post(
  "/warehouses",
  requirePermission("inventory.create"),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        code: z.string().min(1),
        name: z.string().min(2),
        kind: z.nativeEnum(WarehouseKind).optional(),
        parentId: z.string().uuid().nullable().optional(),
      })
      .parse(req.body);

    const me = currentUser(req);
    if (!me.activeBranchId) throw new HttpError(400, "Chưa xác định được cơ sở");

    // Kho con bắt buộc có kho tổng — nếu không thì không biết hàng từ đâu về.
    if (body.kind === WarehouseKind.SUB && !body.parentId) {
      throw new HttpError(400, "Kho con phải chọn kho tổng cấp trên");
    }

    const warehouse = await prisma.warehouse.create({
      data: {
        branchId: me.activeBranchId,
        code: body.code,
        name: body.name,
        kind: body.kind ?? WarehouseKind.MAIN,
        parentId: body.parentId ?? null,
      },
    });

    await writeAudit({
      req,
      action: AuditAction.CREATE,
      entity: "Warehouse",
      entityId: warehouse.id,
      branchId: warehouse.branchId,
      summary: `Tạo ${warehouse.kind === WarehouseKind.SUB ? "kho con" : "kho tổng"} ${warehouse.name}`,
    });
    res.status(201).json(warehouse);
  })
);

/* ------------------------------------------------- CHUYỂN KHO CÓ DUYỆT */

router.get(
  "/transfers",
  requirePermission("inventory.read"),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    res.json(
      await prisma.stockTransfer.findMany({
        where: {
          branchId: { in: me.branchIds },
          ...(req.query.status ? { status: String(req.query.status) } : {}),
        },
        orderBy: { createdAt: "desc" },
        take: 100,
        include: {
          fromWarehouse: { select: { id: true, name: true } },
          toWarehouse: { select: { id: true, name: true } },
          requestedBy: { select: { id: true, name: true } },
          approvedBy: { select: { id: true, name: true } },
          items: {
            include: {
              product: { select: { id: true, name: true, unit: true } },
              lot: { select: { id: true, lotNumber: true, expiryDate: true, quantity: true } },
            },
          },
        },
      })
    );
  })
);

router.post(
  "/transfers",
  requirePermission("inventory.create"),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        fromWarehouseId: z.string().uuid(),
        toWarehouseId: z.string().uuid(),
        reason: z.string().optional(),
        items: z
          .array(
            z.object({
              productId: z.string().uuid(),
              lotId: z.string().uuid().optional(),
              quantity: z.number().int().positive(),
            })
          )
          .min(1),
      })
      .parse(req.body);

    const me = currentUser(req);
    if (body.fromWarehouseId === body.toWarehouseId) {
      throw new HttpError(400, "Kho nguồn và kho đích phải khác nhau");
    }

    const [from, to] = await Promise.all([
      prisma.warehouse.findUnique({ where: { id: body.fromWarehouseId } }),
      prisma.warehouse.findUnique({ where: { id: body.toWarehouseId } }),
    ]);
    if (!from || !to || !me.branchIds.includes(from.branchId)) throw notFound("Không tìm thấy kho");

    // Kiểm tra tồn NGAY khi lập phiếu, để không duyệt xong mới phát hiện thiếu.
    for (const item of body.items) {
      if (!item.lotId) continue;
      const lot = await prisma.stockLot.findUnique({ where: { id: item.lotId } });
      if (!lot) throw notFound("Không tìm thấy lô");
      if (lot.warehouseId !== body.fromWarehouseId) {
        throw new HttpError(400, `Lô ${lot.lotNumber} không nằm ở kho nguồn`);
      }
      if (lot.quantity < item.quantity) {
        throw new HttpError(400, `Lô ${lot.lotNumber} chỉ còn ${lot.quantity}`);
      }
    }

    const code = await nextCode(CodePrefix.TRANSFER);

    const transfer = await prisma.stockTransfer.create({
      data: {
        code,
        branchId: from.branchId,
        fromWarehouseId: body.fromWarehouseId,
        toWarehouseId: body.toWarehouseId,
        reason: body.reason,
        requestedById: me.id,
        items: { create: body.items },
      },
      include: { fromWarehouse: true, toWarehouse: true },
    });

    await writeAudit({
      req,
      action: AuditAction.CREATE,
      entity: "StockTransfer",
      entityId: transfer.id,
      branchId: transfer.branchId,
      summary: `Lập phiếu chuyển kho ${transfer.code}: ${transfer.fromWarehouse.name} → ${transfer.toWarehouse.name}`,
    });

    res.status(201).json(transfer);
  })
);

/**
 * POST /api/inventory/transfers/:id/decide
 * Duyệt hoặc từ chối. Duyệt xong hàng CHƯA rời kho — phải bấm "Xuất hàng" thì
 * tồn mới đổi, để thẻ kho luôn khớp với hàng thật trên kệ.
 */
router.post(
  "/transfers/:id/decide",
  requirePermission("inventory.approve"),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        status: z.enum([TransferStatus.APPROVED, TransferStatus.REJECTED]),
        note: z.string().optional(),
      })
      .parse(req.body);

    const me = currentUser(req);
    const transfer = await prisma.stockTransfer.findUnique({ where: { id: req.params.id } });
    if (!transfer || !me.branchIds.includes(transfer.branchId)) throw notFound();
    if (transfer.status !== TransferStatus.PENDING) {
      throw new HttpError(400, "Phiếu đã được xử lý");
    }

    const updated = await prisma.stockTransfer.update({
      where: { id: transfer.id },
      data: {
        status: body.status,
        approvedById: me.id,
        approvedAt: new Date(),
        rejectNote: body.status === TransferStatus.REJECTED ? body.note : null,
      },
    });

    await writeAudit({
      req,
      action: body.status === TransferStatus.APPROVED ? AuditAction.APPROVE : AuditAction.REJECT,
      entity: "StockTransfer",
      entityId: transfer.id,
      branchId: transfer.branchId,
      summary: `${body.status === TransferStatus.APPROVED ? "Duyệt" : "Từ chối"} phiếu chuyển kho ${transfer.code}`,
    });

    res.json(updated);
  })
);

/** POST /api/inventory/transfers/:id/execute — xuất hàng thật, đổi tồn hai kho. */
router.post(
  "/transfers/:id/execute",
  requirePermission("inventory.update"),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const transfer = await prisma.stockTransfer.findUnique({
      where: { id: req.params.id },
      include: { items: { include: { lot: true, product: true } } },
    });
    if (!transfer || !me.branchIds.includes(transfer.branchId)) throw notFound();
    if (transfer.status !== TransferStatus.APPROVED) {
      throw new HttpError(400, "Chỉ xuất được phiếu đã duyệt");
    }

    await prisma.$transaction(async (tx) => {
      for (const item of transfer.items) {
        if (!item.lot) continue;

        // Trừ ở kho nguồn.
        await applyMovement(tx, {
          warehouseId: transfer.fromWarehouseId,
          productId: item.productId,
          lotId: item.lotId,
          type: StockMoveType.TRANSFER,
          quantity: -item.quantity,
          reason: `Chuyển sang kho khác — phiếu ${transfer.code}`,
          referenceId: transfer.id,
          actorId: me.id,
        });

        // Tạo (hoặc cộng vào) lô CÙNG MÃ ở kho đích — giữ nguyên mã lô và hạn
        // dùng, nếu không thì sang kho con là mất dấu truy vết.
        const target = await tx.stockLot.upsert({
          where: {
            productId_warehouseId_lotNumber: {
              productId: item.productId,
              warehouseId: transfer.toWarehouseId,
              lotNumber: item.lot.lotNumber,
            },
          },
          create: {
            productId: item.productId,
            warehouseId: transfer.toWarehouseId,
            supplierId: item.lot.supplierId,
            lotNumber: item.lot.lotNumber,
            serialNumber: item.lot.serialNumber,
            expiryDate: item.lot.expiryDate,
            quantity: 0,
            unitCost: item.lot.unitCost,
          },
          update: {},
        });

        await applyMovement(tx, {
          warehouseId: transfer.toWarehouseId,
          productId: item.productId,
          lotId: target.id,
          type: StockMoveType.TRANSFER,
          quantity: item.quantity,
          reason: `Nhận từ kho khác — phiếu ${transfer.code}`,
          referenceId: transfer.id,
          actorId: me.id,
        });
      }

      await tx.stockTransfer.update({
        where: { id: transfer.id },
        data: { status: TransferStatus.COMPLETED, completedAt: new Date() },
      });
    });

    await writeAudit({
      req,
      action: AuditAction.UPDATE,
      entity: "StockTransfer",
      entityId: transfer.id,
      branchId: transfer.branchId,
      summary: `Xuất hàng theo phiếu chuyển kho ${transfer.code} — ${transfer.items.length} dòng`,
    });

    res.json({ ok: true });
  })
);

/* --------------------------------------- ĐỊNH MỨC VẬT TƯ THEO DỊCH VỤ */

router.get(
  "/service-materials",
  requirePermission("inventory.read"),
  asyncHandler(async (req, res) => {
    res.json(
      await prisma.serviceMaterial.findMany({
        where: req.query.serviceId ? { serviceId: String(req.query.serviceId) } : {},
        orderBy: { createdAt: "asc" },
        include: {
          service: { select: { id: true, name: true, code: true } },
          product: { select: { id: true, name: true, unit: true, isImplant: true } },
        },
      })
    );
  })
);

router.put(
  "/service-materials",
  requirePermission("inventory.update"),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        serviceId: z.string().uuid(),
        materials: z.array(
          z.object({
            productId: z.string().uuid(),
            quantity: z.number().int().positive(),
            required: z.boolean().optional(),
            note: z.string().optional(),
          })
        ),
      })
      .parse(req.body);

    await prisma.$transaction(async (tx) => {
      await tx.serviceMaterial.deleteMany({ where: { serviceId: body.serviceId } });
      if (body.materials.length) {
        await tx.serviceMaterial.createMany({
          data: body.materials.map((m) => ({ ...m, serviceId: body.serviceId })),
        });
      }
    });

    const service = await prisma.service.findUnique({ where: { id: body.serviceId } });
    await writeAudit({
      req,
      action: AuditAction.UPDATE,
      entity: "ServiceMaterial",
      entityId: body.serviceId,
      summary: `Đặt định mức vật tư cho dịch vụ ${service?.name}: ${body.materials.length} loại`,
    });

    res.json({ ok: true, count: body.materials.length });
  })
);

/* ------------------------------------------------------------- THẺ KHO */

/**
 * GET /api/inventory/stock-card — THẺ KHO (kardex).
 *
 * Tồn đầu · nhập · xuất · tồn cuối theo từng bút toán. Tồn đầu tính bằng cách
 * cộng ngược mọi biến động TRƯỚC mốc bắt đầu, chứ không lưu số chốt sẵn — nhờ
 * vậy thẻ kho luôn đúng kể cả khi có bút toán được ghi lùi ngày, và không bao
 * giờ lệch với tồn thực tế.
 */
router.get(
  "/stock-card",
  requirePermission("inventory.read"),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const productId = z.string().uuid().parse(req.query.productId);
    const warehouseId = req.query.warehouseId ? String(req.query.warehouseId) : undefined;

    const from = req.query.from
      ? new Date(String(req.query.from))
      : new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    const to = req.query.to ? new Date(String(req.query.to)) : new Date();

    const scope = {
      productId,
      warehouse: { branchId: { in: me.branchIds } },
      ...(warehouseId ? { warehouseId } : {}),
    };

    const [opening, movements, product] = await Promise.all([
      prisma.stockMovement.aggregate({
        where: { ...scope, createdAt: { lt: from } },
        _sum: { quantity: true },
      }),
      prisma.stockMovement.findMany({
        where: { ...scope, createdAt: { gte: from, lte: to } },
        orderBy: { createdAt: "asc" },
        include: {
          lot: { select: { id: true, lotNumber: true, expiryDate: true, unitCost: true } },
          warehouse: { select: { id: true, name: true } },
          actor: { select: { id: true, name: true } },
        },
      }),
      prisma.product.findUnique({ where: { id: productId } }),
    ]);

    let balance = opening._sum.quantity ?? 0;
    const openingBalance = balance;

    const rows = movements.map((m) => {
      balance += m.quantity;
      return {
        id: m.id,
        at: m.createdAt,
        type: m.type,
        lotNumber: m.lot?.lotNumber ?? null,
        expiryDate: m.lot?.expiryDate ?? null,
        warehouse: m.warehouse.name,
        inQty: m.quantity > 0 ? m.quantity : 0,
        outQty: m.quantity < 0 ? -m.quantity : 0,
        balance,
        unitCost: m.lot?.unitCost ?? 0,
        reason: m.reason,
        actor: m.actor?.name ?? null,
      };
    });

    res.json({
      product,
      from,
      to,
      openingBalance,
      closingBalance: balance,
      totalIn: rows.reduce((s, r) => s + r.inQty, 0),
      totalOut: rows.reduce((s, r) => s + r.outQty, 0),
      rows,
    });
  })
);

/* -------------------------------------------------- BÁO CÁO GIÁ TRỊ TỒN */

router.get(
  "/reports/valuation",
  requirePermission("inventory.read"),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const now = Date.now();
    const expiringDays = await getSettingNumber("inventory.expiringSoonDays");

    const lots = await prisma.stockLot.findMany({
      where: { warehouse: { branchId: { in: me.branchIds } }, quantity: { gt: 0 } },
      include: {
        product: { select: { id: true, name: true, kind: true, unit: true, minStock: true, maxStock: true } },
        warehouse: { select: { id: true, name: true, kind: true } },
      },
    });

    // Giá trị tồn theo KHO — quản lý cần biết vốn đang nằm ở đâu.
    const byWarehouse = new Map<string, { name: string; kind: string; qty: number; value: number }>();
    // và theo NHÓM VẬT TƯ — để thấy tiền đọng ở loại hàng nào.
    const byKind = new Map<string, { qty: number; value: number }>();

    let totalValue = 0;
    let expiringValue = 0;
    let expiredValue = 0;
    // Đếm theo LÔ song song với giá trị: vật tư nhập giá vốn 0 (hàng mẫu, hàng
    // tặng) vẫn hết hạn như thường. Nếu chỉ cảnh báo theo tiền thì những lô đó
    // hiện "0đ" và người xem tưởng không có vấn đề gì.
    let expiringCount = 0;
    let expiredCount = 0;

    for (const l of lots) {
      const value = l.quantity * l.unitCost;
      totalValue += value;

      const w = byWarehouse.get(l.warehouseId) ?? {
        name: l.warehouse.name,
        kind: l.warehouse.kind,
        qty: 0,
        value: 0,
      };
      w.qty += l.quantity;
      w.value += value;
      byWarehouse.set(l.warehouseId, w);

      const k = byKind.get(l.product.kind) ?? { qty: 0, value: 0 };
      k.qty += l.quantity;
      k.value += value;
      byKind.set(l.product.kind, k);

      if (l.expiryDate) {
        const days = (l.expiryDate.getTime() - now) / 86400000;
        if (days < 0) {
          expiredValue += value;
          expiredCount++;
        } else if (days <= expiringDays) {
          expiringValue += value;
          expiringCount++;
        }
      }
    }

    // Cảnh báo định mức: gộp tồn theo sản phẩm trên TOÀN BỘ kho của cơ sở.
    const onHandByProduct = new Map<string, { name: string; unit: string; qty: number; min: number; max: number }>();
    for (const l of lots) {
      const p = onHandByProduct.get(l.productId) ?? {
        name: l.product.name,
        unit: l.product.unit,
        qty: 0,
        min: l.product.minStock,
        max: l.product.maxStock,
      };
      p.qty += l.quantity;
      onHandByProduct.set(l.productId, p);
    }

    const belowMin = [...onHandByProduct.entries()]
      .filter(([, p]) => p.min > 0 && p.qty < p.min)
      .map(([id, p]) => ({ productId: id, ...p, shortage: p.min - p.qty }));

    const aboveMax = [...onHandByProduct.entries()]
      .filter(([, p]) => p.max > 0 && p.qty > p.max)
      .map(([id, p]) => ({ productId: id, ...p, excess: p.qty - p.max }));

    res.json({
      totalValue,
      expiringValue,
      expiredValue,
      expiringCount,
      expiredCount,
      lotCount: lots.length,
      byWarehouse: [...byWarehouse.entries()].map(([id, v]) => ({ warehouseId: id, ...v })),
      byKind: [...byKind.entries()].map(([kind, v]) => ({ kind, ...v })),
      belowMin,
      aboveMax,
    });
  })
);

/* ------------------------------------------------ THAO TÁC NHANH CHO KHO */
//
// Nhân viên kho làm những việc này hàng chục lần mỗi ngày. Mỗi thao tác thừa là
// một lần họ bỏ qua không ghi, và tồn kho trên máy lệch với hàng thật trên kệ.
// Vì vậy nhóm này tối ưu cho SỐ LẦN BẤM, không phải cho sự đầy đủ của biểu mẫu.

/** Đếm bản ghi đang tham chiếu, dùng chung cho các thao tác xoá. */
async function countRefs(checks: Array<{ model: string; where: object; label: string }>) {
  const rows = await Promise.all(
    checks.map(async (c) => ({
      label: c.label,
      count: await delegate(c.model).count({ where: c.where }).catch(() => 0),
    }))
  );
  return rows.filter((r) => r.count > 0);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function delegate(model: string): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (prisma as any)[model];
}

/* ---- VẬT TƯ: sửa · xoá ---- */

router.patch(
  "/products/:id",
  requirePermission("inventory.update"),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        name: z.string().min(2).optional(),
        unit: z.string().optional(),
        kind: z.nativeEnum(ProductKind).optional(),
        minStock: z.number().int().nonnegative().optional(),
        maxStock: z.number().int().nonnegative().optional(),
        isImplant: z.boolean().optional(),
        active: z.boolean().optional(),
        note: z.string().optional(),
      })
      .parse(req.body);

    if (
      body.minStock !== undefined &&
      body.maxStock !== undefined &&
      body.maxStock > 0 &&
      body.minStock > body.maxStock
    ) {
      throw new HttpError(400, "Định mức tối thiểu không được lớn hơn tối đa");
    }

    const product = await prisma.product.update({ where: { id: req.params.id }, data: body });
    await writeAudit({
      req,
      action: AuditAction.UPDATE,
      entity: "Product",
      entityId: product.id,
      summary: `Sửa vật tư ${product.name}`,
    });
    res.json(product);
  })
);

router.delete(
  "/products/:id",
  requirePermission("inventory.delete"),
  asyncHandler(async (req, res) => {
    const product = await prisma.product.findUnique({ where: { id: req.params.id } });
    if (!product) throw notFound("Không tìm thấy vật tư");

    // Phải chặn theo ĐỦ mọi bảng đang trỏ tới vật tư, không chỉ lô còn hàng:
    // sổ kho (movements) và phiếu kiểm kê là chứng từ kế toán, xoá vật tư đi là
    // thủng sổ. Thiếu một dòng ở đây thì Prisma ném lỗi khoá ngoại 500 thay vì
    // báo cho thủ kho biết vướng ở đâu.
    const refs = await countRefs([
      { model: "stockLot", where: { productId: product.id }, label: "lô hàng (kể cả lô đã hết)" },
      { model: "stockMovement", where: { productId: product.id }, label: "bút toán trong sổ kho" },
      { model: "productUsage", where: { productId: product.id }, label: "lượt đã xuất dùng" },
      { model: "serviceMaterial", where: { productId: product.id }, label: "định mức dịch vụ" },
      { model: "purchaseOrderItem", where: { productId: product.id }, label: "dòng đơn mua hàng" },
      { model: "stockCountItem", where: { productId: product.id }, label: "dòng phiếu kiểm kê" },
      { model: "stockTransferItem", where: { productId: product.id }, label: "dòng phiếu chuyển kho" },
    ]);

    // Vật tư đã từng xuất dùng cho khách KHÔNG được xoá — xoá là mất truy vết.
    // Trường hợp đó chuyển sang "ngưng dùng" để không ai chọn nữa mà vẫn giữ vết.
    if (refs.length) {
      const detail = refs.map((r) => `${r.count} ${r.label}`).join(", ");
      throw new HttpError(
        409,
        `Không xoá được vì còn ${detail}. Dùng nút "Ngưng dùng" để ẩn khỏi danh sách chọn mà vẫn giữ lịch sử.`
      );
    }

    await prisma.product.delete({ where: { id: product.id } });
    await writeAudit({
      req,
      action: AuditAction.DELETE,
      entity: "Product",
      entityId: product.id,
      summary: `Xoá vật tư ${product.name}`,
    });
    res.json({ ok: true });
  })
);

/* ---- NHÀ CUNG CẤP: sửa · xoá ---- */

router.patch(
  "/suppliers/:id",
  requirePermission("inventory.update"),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        name: z.string().min(2).optional(),
        taxCode: z.string().optional(),
        phone: z.string().optional(),
        email: z.string().optional(),
        address: z.string().optional(),
        contactName: z.string().optional(),
        note: z.string().optional(),
        active: z.boolean().optional(),
      })
      .parse(req.body);

    const supplier = await prisma.supplier.update({ where: { id: req.params.id }, data: body });
    await writeAudit({
      req,
      action: AuditAction.UPDATE,
      entity: "Supplier",
      entityId: supplier.id,
      summary: `Sửa nhà cung cấp ${supplier.name}`,
    });
    res.json(supplier);
  })
);

router.delete(
  "/suppliers/:id",
  requirePermission("inventory.delete"),
  asyncHandler(async (req, res) => {
    const supplier = await prisma.supplier.findUnique({ where: { id: req.params.id } });
    if (!supplier) throw notFound("Không tìm thấy nhà cung cấp");

    const refs = await countRefs([
      { model: "stockLot", where: { supplierId: supplier.id }, label: "lô hàng đã nhập" },
      { model: "purchaseOrder", where: { supplierId: supplier.id }, label: "đơn mua hàng" },
    ]);
    if (refs.length) {
      throw new HttpError(
        409,
        `Không xoá được vì còn ${refs[0].count} ${refs[0].label}. Dùng "Ngưng dùng" để ẩn khỏi danh sách chọn.`
      );
    }

    await prisma.supplier.delete({ where: { id: supplier.id } });
    await writeAudit({
      req,
      action: AuditAction.DELETE,
      entity: "Supplier",
      entityId: supplier.id,
      summary: `Xoá nhà cung cấp ${supplier.name}`,
    });
    res.json({ ok: true });
  })
);

/* ---- LÔ HÀNG: sửa thông tin, xoá lô rỗng ---- */

router.patch(
  "/lots/:id",
  requirePermission("inventory.update"),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        expiryDate: z.coerce.date().nullable().optional(),
        unitCost: z.number().int().nonnegative().optional(),
        serialNumber: z.string().nullable().optional(),
        supplierId: z.string().uuid().nullable().optional(),
        note: z.string().optional(),
      })
      .parse(req.body);

    const me = currentUser(req);
    const lot = await prisma.stockLot.findUnique({
      where: { id: req.params.id },
      include: { warehouse: true, product: { select: { name: true } } },
    });
    if (!lot || !me.branchIds.includes(lot.warehouse.branchId)) throw notFound("Không tìm thấy lô");

    // Số lượng CỐ Ý không sửa được ở đây — muốn đổi tồn phải đi qua nhập/xuất/
    // điều chỉnh để sổ kho có bút toán, nếu không thẻ kho sẽ lệch tồn thật.
    const updated = await prisma.stockLot.update({ where: { id: lot.id }, data: body });

    await writeAudit({
      req,
      action: AuditAction.UPDATE,
      entity: "StockLot",
      entityId: lot.id,
      branchId: lot.warehouse.branchId,
      summary: `Sửa thông tin lô ${lot.lotNumber} (${lot.product.name})`,
    });
    res.json(updated);
  })
);

router.delete(
  "/lots/:id",
  requirePermission("inventory.delete"),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const lot = await prisma.stockLot.findUnique({
      where: { id: req.params.id },
      include: { warehouse: true, product: { select: { name: true } } },
    });
    if (!lot || !me.branchIds.includes(lot.warehouse.branchId)) throw notFound("Không tìm thấy lô");

    if (lot.quantity > 0) {
      throw new HttpError(
        409,
        `Lô còn ${lot.quantity} đơn vị. Xuất hết hoặc huỷ số còn lại trước khi xoá lô.`
      );
    }

    const used = await prisma.productUsage.count({ where: { lotId: lot.id } });
    if (used > 0) {
      throw new HttpError(
        409,
        `Lô này đã dùng cho ${used} lượt khách — không xoá được vì sẽ mất dấu truy vết.`
      );
    }

    // Khoá ngoại của StockMovement.lotId là SetNull: xoá lô sẽ ÂM THẦM biến các
    // bút toán thành mồ côi, thẻ kho không còn quy được về lô nào. Vì vậy lô đã
    // từng phát sinh bút toán thì không xoá — nó đã hết hàng nên tự ẩn khỏi
    // bảng tồn rồi, giữ lại chỉ tốn một dòng trong sổ.
    const moves = await prisma.stockMovement.count({ where: { lotId: lot.id } });
    if (moves > 0) {
      throw new HttpError(
        409,
        `Lô này có ${moves} bút toán trong sổ kho — xoá đi là thủng thẻ kho. Lô đã hết hàng sẽ tự ẩn khỏi bảng tồn, không cần xoá.`
      );
    }

    await prisma.stockLot.delete({ where: { id: lot.id } });
    await writeAudit({
      req,
      action: AuditAction.DELETE,
      entity: "StockLot",
      entityId: lot.id,
      branchId: lot.warehouse.branchId,
      summary: `Xoá lô rỗng ${lot.lotNumber} (${lot.product.name})`,
    });
    res.json({ ok: true });
  })
);

/**
 * POST /api/inventory/issue — XUẤT NỘI BỘ, không gắn khách.
 *
 * Kho thường xuyên xuất hàng không cho khách cụ thể: dùng thử, hỏng vỡ, hao
 * hụt, cấp cho phòng khác. Trước đây phải mượn chức năng "xuất dùng cho khách"
 * và chọn bừa một khách — làm hỏng luôn dữ liệu truy vết. Nay tách hẳn.
 */
router.post(
  "/issue",
  requirePermission("inventory.update"),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        lotId: z.string().uuid(),
        quantity: z.number().int().positive(),
        reason: z.string().min(3),
      })
      .parse(req.body);

    const me = currentUser(req);
    const lot = await prisma.stockLot.findUnique({
      where: { id: body.lotId },
      include: { warehouse: true, product: { select: { name: true } } },
    });
    if (!lot || !me.branchIds.includes(lot.warehouse.branchId)) throw notFound("Không tìm thấy lô");

    await prisma.$transaction(async (tx) => {
      await applyMovement(tx, {
        warehouseId: lot.warehouseId,
        productId: lot.productId,
        lotId: lot.id,
        type: StockMoveType.OUT,
        quantity: -body.quantity,
        reason: `Xuất nội bộ: ${body.reason}`,
        actorId: me.id,
      });
    });

    await writeAudit({
      req,
      action: AuditAction.UPDATE,
      entity: "StockLot",
      entityId: lot.id,
      branchId: lot.warehouse.branchId,
      summary: `Xuất nội bộ ${body.quantity} ${lot.product.name} (lô ${lot.lotNumber}). Lý do: ${body.reason}`,
    });

    res.json({ ok: true });
  })
);

/**
 * POST /api/inventory/quick-adjust — cộng/trừ nhanh ngay trên dòng tồn.
 *
 * Dành cho tình huống đếm lại thấy lệch: bấm +1/−1 tại chỗ thay vì mở biểu mẫu.
 * Vẫn sinh bút toán đầy đủ nên thẻ kho không bao giờ mất dấu.
 */
router.post(
  "/quick-adjust",
  requirePermission("inventory.update"),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        lotId: z.string().uuid(),
        delta: z.number().int(),
        reason: z.string().optional(),
      })
      .parse(req.body);

    if (body.delta === 0) throw new HttpError(400, "Chênh lệch phải khác 0");

    const me = currentUser(req);
    const lot = await prisma.stockLot.findUnique({
      where: { id: body.lotId },
      include: { warehouse: true, product: { select: { name: true } } },
    });
    if (!lot || !me.branchIds.includes(lot.warehouse.branchId)) throw notFound("Không tìm thấy lô");

    const reason = body.reason ?? (body.delta > 0 ? "Điều chỉnh tăng khi kiểm đếm" : "Điều chỉnh giảm khi kiểm đếm");

    await prisma.$transaction(async (tx) => {
      await applyMovement(tx, {
        warehouseId: lot.warehouseId,
        productId: lot.productId,
        lotId: lot.id,
        type: StockMoveType.ADJUST,
        quantity: body.delta,
        reason,
        actorId: me.id,
      });
    });

    await writeAudit({
      req,
      action: AuditAction.UPDATE,
      entity: "StockLot",
      entityId: lot.id,
      branchId: lot.warehouse.branchId,
      summary: `Điều chỉnh nhanh ${body.delta > 0 ? "+" : ""}${body.delta} ${lot.product.name} (lô ${lot.lotNumber}). ${reason}`,
    });

    const updated = await prisma.stockLot.findUniqueOrThrow({ where: { id: lot.id } });
    res.json({ ok: true, quantity: updated.quantity });
  })
);

export default router;
