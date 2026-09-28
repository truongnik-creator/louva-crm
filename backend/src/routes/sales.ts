import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { asyncHandler, HttpError } from "../middleware/errorHandler";
import { requireAuth, currentUser } from "../middleware/auth";
import { requirePermission, scopedWhere, assertInScope, notFound } from "../middleware/rbac";
import { writeAudit } from "../lib/audit";
import { withCode, CodePrefix } from "../lib/codes";
import {
  AuditAction,
  ActivityType,
  ContractStatus,
  CustomerStatus,
  FunnelStage,
  InvoiceStatus,
  PaymentMethod,
  QuotationStatus,
} from "../types/enums";

// Báo giá → hợp đồng → hoá đơn → phiếu thu. Các màn "Đơn hàng · Hợp đồng" và
// "Thanh toán & Công nợ".
//
// TIỀN LÀ Int, ĐƠN VỊ ĐỒNG. Mọi phép cộng dồn đều làm bằng số nguyên; không có
// chỗ nào dùng số thực.

const router = Router();
router.use(requireAuth);

const FIN_SCOPE = { ownerFields: ["consultantId", "createdById"], branchField: "branchId" };

const lineSchema = z.object({
  serviceId: z.string().uuid().optional().nullable(),
  name: z.string().min(1),
  quantity: z.number().int().positive().default(1),
  unitPrice: z.number().int().nonnegative(),
  discount: z.number().int().nonnegative().default(0),
});

/** Tính tiền từ danh sách dòng — dùng chung cho báo giá và hợp đồng. */
function computeTotals(items: z.infer<typeof lineSchema>[]) {
  const lines = items.map((i) => ({
    ...i,
    amount: i.quantity * i.unitPrice - i.discount,
  }));
  const subtotal = lines.reduce((s, l) => s + l.quantity * l.unitPrice, 0);
  const discount = lines.reduce((s, l) => s + l.discount, 0);
  return { lines, subtotal, discount, total: subtotal - discount };
}

// ------------------------------------------------------------------ BÁO GIÁ

router.get(
  "/quotations",
  requirePermission("sales_order.read"),
  asyncHandler(async (req, res) => {
    const { where } = scopedWhere(req, "sales_order.read", FIN_SCOPE);
    res.json(
      await prisma.quotation.findMany({
        where: {
          ...where,
          ...(req.query.customerId ? { customerId: String(req.query.customerId) } : {}),
          ...(req.query.status ? { status: String(req.query.status) } : {}),
        },
        orderBy: { createdAt: "desc" },
        take: Math.min(Number(req.query.limit ?? 100), 300),
        include: {
          customer: { select: { id: true, name: true, code: true } },
          createdBy: { select: { id: true, name: true } },
          items: true,
        },
      })
    );
  })
);

router.post(
  "/quotations",
  requirePermission("sales_order.create"),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        customerId: z.string().uuid(),
        branchId: z.string().uuid().optional(),
        items: z.array(lineSchema).min(1),
        note: z.string().optional(),
        validUntil: z.coerce.date().optional(),
      })
      .parse(req.body);

    const me = currentUser(req);
    const branchId = body.branchId ?? me.activeBranchId;
    if (!branchId) throw new HttpError(400, "Chưa xác định được cơ sở");

    // Chặn bán dưới giá sàn — quy tắc bảng giá theo cơ sở.
    for (const item of body.items) {
      if (!item.serviceId) continue;
      const price = await prisma.servicePrice.findFirst({
        where: { serviceId: item.serviceId, branchId, validTo: null },
        orderBy: { validFrom: "desc" },
      });
      const net = item.unitPrice - Math.round(item.discount / item.quantity);
      if (price?.minPrice != null && net < price.minPrice) {
        throw new HttpError(
          400,
          `"${item.name}" đang báo ${net.toLocaleString("vi-VN")}đ, thấp hơn giá sàn ${price.minPrice.toLocaleString("vi-VN")}đ`
        );
      }
    }

    const { lines, subtotal, discount, total } = computeTotals(body.items);

    const quotation = await withCode(CodePrefix.QUOTATION, (code) =>
      prisma.quotation.create({
        data: {
          code,
          branchId,
          customerId: body.customerId,
          subtotal,
          discount,
          total,
          note: body.note,
          validUntil: body.validUntil,
          createdById: me.id,
          items: { create: lines },
        },
        include: { items: true, customer: { select: { id: true, name: true, code: true } } },
      })
    );

    await prisma.activity.create({
      data: {
        customerId: body.customerId,
        type: ActivityType.QUOTATION,
        content: `${me.name} lập báo giá ${quotation.code} — ${total.toLocaleString("vi-VN")}đ`,
        userId: me.id,
        userName: me.name,
      },
    });

    await writeAudit({
      req,
      action: AuditAction.CREATE,
      entity: "Quotation",
      entityId: quotation.id,
      branchId,
      summary: `Lập báo giá ${quotation.code} cho ${quotation.customer.name} — ${total.toLocaleString("vi-VN")}đ`,
    });

    res.status(201).json(quotation);
  })
);

router.post(
  "/quotations/:id/status",
  requirePermission("sales_order.update"),
  asyncHandler(async (req, res) => {
    const { status } = z.object({ status: z.nativeEnum(QuotationStatus) }).parse(req.body);
    const before = await prisma.quotation.findUnique({ where: { id: req.params.id } });
    assertInScope(req, "sales_order.update", before as unknown as Record<string, unknown>, FIN_SCOPE);

    const quotation = await prisma.quotation.update({
      where: { id: req.params.id },
      data: {
        status,
        ...(status === QuotationStatus.SENT ? { sentAt: new Date() } : {}),
        ...(status === QuotationStatus.ACCEPTED || status === QuotationStatus.REJECTED
          ? { decidedAt: new Date() }
          : {}),
      },
    });
    res.json(quotation);
  })
);

// ----------------------------------------------------------------- HỢP ĐỒNG

const contractInclude = {
  customer: { select: { id: true, name: true, code: true, phone: true } },
  consultant: { select: { id: true, name: true } },
  items: true,
  branch: { select: { id: true, code: true, shortName: true } },
} as const;

router.get(
  "/contracts",
  requirePermission("finance.read"),
  asyncHandler(async (req, res) => {
    const { where } = scopedWhere(req, "finance.read", FIN_SCOPE);
    const contracts = await prisma.contract.findMany({
      where: {
        ...where,
        ...(req.query.customerId ? { customerId: String(req.query.customerId) } : {}),
        ...(req.query.status ? { status: String(req.query.status) } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: Math.min(Number(req.query.limit ?? 100), 300),
      include: contractInclude,
    });
    res.json(contracts.map((c) => ({ ...c, remaining: c.total - c.paidAmount })));
  })
);

/**
 * POST /api/contracts — tạo hợp đồng, có thể sinh từ một báo giá đã chốt.
 * Kèm lịch thu (đợt cọc / trước mổ / sau mổ) tạo luôn thành các Invoice, đúng
 * tab "Tài chính" trong hồ sơ khách của prototype.
 */
router.post(
  "/contracts",
  requirePermission("finance.create"),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        customerId: z.string().uuid(),
        branchId: z.string().uuid().optional(),
        quotationId: z.string().uuid().optional(),
        items: z.array(lineSchema).optional(),
        consultantId: z.string().uuid().optional(),
        note: z.string().optional(),
        schedule: z
          .array(
            z.object({
              title: z.string().min(1),
              amount: z.number().int().positive(),
              dueDate: z.coerce.date().optional(),
            })
          )
          .optional(),
      })
      .parse(req.body);

    const me = currentUser(req);
    const branchId = body.branchId ?? me.activeBranchId;
    if (!branchId) throw new HttpError(400, "Chưa xác định được cơ sở");

    // Lấy dòng hàng từ báo giá nếu không truyền tay.
    let sourceItems = body.items;
    if (!sourceItems && body.quotationId) {
      const quotation = await prisma.quotation.findUnique({
        where: { id: body.quotationId },
        include: { items: true, contract: { select: { id: true, code: true } } },
      });
      if (!quotation) throw notFound("Không tìm thấy báo giá");
      if (quotation.contract) {
        throw new HttpError(409, `Báo giá này đã có hợp đồng ${quotation.contract.code}`);
      }
      sourceItems = quotation.items.map((i) => ({
        serviceId: i.serviceId,
        name: i.name,
        quantity: i.quantity,
        unitPrice: i.unitPrice,
        discount: i.discount,
      }));
    }
    if (!sourceItems?.length) throw new HttpError(400, "Hợp đồng phải có ít nhất một dòng dịch vụ");

    const { lines, subtotal, discount, total } = computeTotals(sourceItems);

    if (body.schedule?.length) {
      const scheduled = body.schedule.reduce((s, i) => s + i.amount, 0);
      if (scheduled !== total) {
        throw new HttpError(
          400,
          `Tổng lịch thu (${scheduled.toLocaleString("vi-VN")}đ) phải bằng giá trị hợp đồng (${total.toLocaleString("vi-VN")}đ)`
        );
      }
    }

    const contract = await withCode(CodePrefix.CONTRACT, (code) =>
      prisma.contract.create({
        data: {
          code,
          branchId,
          customerId: body.customerId,
          quotationId: body.quotationId,
          subtotal,
          discount,
          total,
          consultantId: body.consultantId ?? me.id,
          note: body.note,
          items: { create: lines },
        },
        include: contractInclude,
      })
    );

    // Lịch thu -> hoá đơn từng đợt.
    if (body.schedule?.length) {
      for (const part of body.schedule) {
        await withCode(CodePrefix.INVOICE, (code) =>
          prisma.invoice.create({
            data: {
              code,
              branchId,
              customerId: body.customerId,
              contractId: contract.id,
              title: part.title,
              amount: part.amount,
              dueDate: part.dueDate,
              status: InvoiceStatus.ISSUED,
              issuedAt: new Date(),
            },
          })
        );
      }
    }

    if (body.quotationId) {
      await prisma.quotation.update({
        where: { id: body.quotationId },
        data: { status: QuotationStatus.ACCEPTED, decidedAt: new Date() },
      });
    }

    await prisma.customer.update({
      where: { id: body.customerId },
      data: {
        stage: FunnelStage.CHOT,
        status: CustomerStatus.ACTIVE,
        activities: {
          create: {
            type: ActivityType.CONTRACT,
            content: `${me.name} chốt hợp đồng ${contract.code} — ${total.toLocaleString("vi-VN")}đ`,
            userId: me.id,
            userName: me.name,
          },
        },
      },
    });

    await writeAudit({
      req,
      action: AuditAction.CREATE,
      entity: "Contract",
      entityId: contract.id,
      branchId,
      summary: `Tạo hợp đồng ${contract.code} cho ${contract.customer.name} — ${total.toLocaleString("vi-VN")}đ`,
    });

    res.status(201).json(contract);
  })
);

router.post(
  "/contracts/:id/sign",
  requirePermission("finance.update"),
  asyncHandler(async (req, res) => {
    const before = await prisma.contract.findUnique({ where: { id: req.params.id } });
    assertInScope(req, "finance.update", before as unknown as Record<string, unknown>, FIN_SCOPE);
    if (before!.status !== ContractStatus.DRAFT) {
      throw new HttpError(400, "Chỉ ký được hợp đồng đang ở trạng thái nháp");
    }

    const contract = await prisma.contract.update({
      where: { id: req.params.id },
      data: { status: ContractStatus.SIGNED, signedAt: new Date() },
      include: contractInclude,
    });
    await writeAudit({
      req,
      action: AuditAction.APPROVE,
      entity: "Contract",
      entityId: contract.id,
      branchId: contract.branchId,
      summary: `Ký hợp đồng ${contract.code}`,
    });
    res.json(contract);
  })
);

router.post(
  "/contracts/:id/cancel",
  requirePermission("finance.approve"),
  asyncHandler(async (req, res) => {
    const { reason } = z.object({ reason: z.string().min(5) }).parse(req.body);
    const before = await prisma.contract.findUnique({ where: { id: req.params.id } });
    assertInScope(req, "finance.approve", before as unknown as Record<string, unknown>, FIN_SCOPE);

    const contract = await prisma.contract.update({
      where: { id: req.params.id },
      data: { status: ContractStatus.CANCELLED, cancelReason: reason },
    });
    await writeAudit({
      req,
      action: AuditAction.UPDATE,
      entity: "Contract",
      entityId: contract.id,
      branchId: contract.branchId,
      summary: `Huỷ hợp đồng ${contract.code}. Lý do: ${reason}`,
    });
    res.json(contract);
  })
);

// ------------------------------------------------------------------ HOÁ ĐƠN

router.get(
  "/invoices",
  requirePermission("finance.read"),
  asyncHandler(async (req, res) => {
    const { where } = scopedWhere(req, "finance.read", { branchField: "branchId" });
    const invoices = await prisma.invoice.findMany({
      where: {
        ...where,
        ...(req.query.customerId ? { customerId: String(req.query.customerId) } : {}),
        ...(req.query.contractId ? { contractId: String(req.query.contractId) } : {}),
        ...(req.query.status ? { status: String(req.query.status) } : {}),
      },
      orderBy: [{ dueDate: "asc" }, { createdAt: "desc" }],
      take: Math.min(Number(req.query.limit ?? 200), 500),
      include: {
        customer: { select: { id: true, name: true, code: true, phone: true } },
        contract: { select: { id: true, code: true } },
      },
    });

    const now = Date.now();
    res.json(
      invoices.map((i) => ({
        ...i,
        remaining: i.amount - i.paidAmount,
        overdueDays:
          i.dueDate && i.status !== InvoiceStatus.PAID && i.dueDate.getTime() < now
            ? Math.floor((now - i.dueDate.getTime()) / 86400000)
            : 0,
      }))
    );
  })
);

// GET /api/debts — công nợ, dùng cho màn "Thanh toán & Công nợ"
router.get(
  "/debts",
  requirePermission("finance.read"),
  asyncHandler(async (req, res) => {
    const { where } = scopedWhere(req, "finance.read", { branchField: "branchId" });
    const overdueDays = Number(req.query.overdueDays ?? 0);
    const cutoff = new Date(Date.now() - overdueDays * 86400000);

    const invoices = await prisma.invoice.findMany({
      where: {
        ...where,
        status: { in: [InvoiceStatus.ISSUED, InvoiceStatus.PARTIAL, InvoiceStatus.OVERDUE] },
        ...(overdueDays > 0 ? { dueDate: { lt: cutoff } } : {}),
      },
      orderBy: { dueDate: "asc" },
      include: {
        customer: {
          select: { id: true, name: true, code: true, phone: true, assignedTo: { select: { name: true } } },
        },
        contract: { select: { id: true, code: true } },
      },
    });

    const now = Date.now();
    const rows = invoices
      .map((i) => ({
        ...i,
        remaining: i.amount - i.paidAmount,
        overdueDays: i.dueDate ? Math.floor((now - i.dueDate.getTime()) / 86400000) : 0,
      }))
      .filter((i) => i.remaining > 0);

    res.json({
      totalDebt: rows.reduce((s, r) => s + r.remaining, 0),
      overdueCount: rows.filter((r) => r.overdueDays > 0).length,
      overdueAmount: rows.filter((r) => r.overdueDays > 0).reduce((s, r) => s + r.remaining, 0),
      items: rows,
    });
  })
);

// ----------------------------------------------------------------- PHIẾU THU

router.get(
  "/payments",
  requirePermission("finance.read"),
  asyncHandler(async (req, res) => {
    const { where } = scopedWhere(req, "finance.read", { branchField: "branchId" });
    res.json(
      await prisma.payment.findMany({
        where: {
          ...where,
          ...(req.query.customerId ? { customerId: String(req.query.customerId) } : {}),
          ...(req.query.from || req.query.to
            ? {
                paidAt: {
                  ...(req.query.from ? { gte: new Date(String(req.query.from)) } : {}),
                  ...(req.query.to ? { lt: new Date(String(req.query.to)) } : {}),
                },
              }
            : {}),
        },
        orderBy: { paidAt: "desc" },
        take: Math.min(Number(req.query.limit ?? 200), 500),
        include: {
          customer: { select: { id: true, name: true, code: true } },
          receivedBy: { select: { id: true, name: true } },
          invoice: { select: { id: true, code: true, title: true } },
        },
      })
    );
  })
);

/**
 * POST /api/payments — ghi nhận thu tiền.
 * Cập nhật đồng thời hoá đơn và hợp đồng trong MỘT giao dịch: nếu tách ra,
 * một lỗi giữa chừng sẽ để lại phiếu thu mà công nợ không giảm.
 */
router.post(
  "/payments",
  requirePermission("finance.create"),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        customerId: z.string().uuid(),
        invoiceId: z.string().uuid().optional(),
        contractId: z.string().uuid().optional(),
        branchId: z.string().uuid().optional(),
        amount: z.number().int().positive(),
        method: z.nativeEnum(PaymentMethod).optional(),
        reference: z.string().optional(),
        note: z.string().optional(),
        paidAt: z.coerce.date().optional(),
      })
      .parse(req.body);

    const me = currentUser(req);
    const branchId = body.branchId ?? me.activeBranchId;
    if (!branchId) throw new HttpError(400, "Chưa xác định được cơ sở");

    const invoice = body.invoiceId
      ? await prisma.invoice.findUnique({ where: { id: body.invoiceId } })
      : null;
    if (body.invoiceId && !invoice) throw notFound("Không tìm thấy hoá đơn");
    if (invoice && invoice.paidAmount + body.amount > invoice.amount) {
      throw new HttpError(
        400,
        `Số tiền vượt quá phần còn lại của hoá đơn (${(invoice.amount - invoice.paidAmount).toLocaleString("vi-VN")}đ)`
      );
    }

    const contractId = body.contractId ?? invoice?.contractId ?? null;

    const payment = await withCode(CodePrefix.PAYMENT, (code) =>
      prisma.$transaction(async (tx) => {
        const created = await tx.payment.create({
          data: {
            code,
            branchId,
            customerId: body.customerId,
            invoiceId: body.invoiceId,
            contractId,
            amount: body.amount,
            method: body.method ?? PaymentMethod.CASH,
            reference: body.reference,
            note: body.note,
            paidAt: body.paidAt ?? new Date(),
            receivedById: me.id,
          },
          include: { customer: { select: { id: true, name: true, code: true } } },
        });

        if (invoice) {
          const paid = invoice.paidAmount + body.amount;
          await tx.invoice.update({
            where: { id: invoice.id },
            data: {
              paidAmount: paid,
              status: paid >= invoice.amount ? InvoiceStatus.PAID : InvoiceStatus.PARTIAL,
            },
          });
        }

        if (contractId) {
          const agg = await tx.payment.aggregate({
            where: { contractId },
            _sum: { amount: true },
          });
          await tx.contract.update({
            where: { id: contractId },
            data: { paidAmount: agg._sum.amount ?? 0 },
          });
        }

        await tx.activity.create({
          data: {
            customerId: body.customerId,
            type: ActivityType.PAYMENT,
            content: `Thu ${body.amount.toLocaleString("vi-VN")}đ — phiếu ${code} (${body.method ?? "CASH"})`,
            userId: me.id,
            userName: me.name,
          },
        });

        return created;
      })
    );

    await writeAudit({
      req,
      action: AuditAction.CREATE,
      entity: "Payment",
      entityId: payment.id,
      branchId,
      summary: `Thu ${body.amount.toLocaleString("vi-VN")}đ của ${payment.customer.name} — phiếu ${payment.code}`,
    });

    res.status(201).json(payment);
  })
);

export default router;
