import { Router } from "express";
import { refreshFirstPurchaseAt, safely } from "../lib/lead-funnel";
import { applyStageEventSafe } from "../lib/stages";
import { currentOpportunityId } from "../lib/opportunities";
import {
  consumePromotionSlot,
  discountCapPercent,
  evaluatePricing,
  initialApprovalStatus,
  lineData,
  releasePromotionSlot,
} from "../lib/pricing";
import { notifyUsers, usersWithPermission } from "../lib/notify";
import { applyDeposits, openDeposits, planDeposits } from "../lib/deposit";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { formatDateVN, formatVnd, startOfVnDay } from "../lib/datetime";
import { pageQuery } from "../lib/pagination";
import { asyncHandler, HttpError } from "../middleware/errorHandler";
import { requireAuth, currentUser } from "../middleware/auth";
import { requirePermission, scopedWhere, assertInScope, notFound, maskCustomerPhonesInResponse } from "../middleware/rbac";
import { writeAudit } from "../lib/audit";
import { withCode, CodePrefix } from "../lib/codes";
import {
  AuditAction,
  CloseType,
  ActivityType,
  ApprovalStatus,
  ContractStatus,
  CustomerStatus,
  StageEvent,
  InvoiceStatus,
  PaymentMethod,
  PaymentType,
  QuotationStatus,
  TaskKind,
  TaskPriority,
  TaskStatus,
} from "../types/enums";
import { getSettingNumber } from "../lib/settings-catalog";

// Báo giá → hợp đồng → hoá đơn → phiếu thu. Các màn "Đơn hàng · Hợp đồng" và
// "Thanh toán & Công nợ".
//
// TIỀN LÀ Int, ĐƠN VỊ ĐỒNG. Mọi phép cộng dồn đều làm bằng số nguyên; không có
// chỗ nào dùng số thực.

const router = Router();
router.use(requireAuth);
// Che SĐT khách lồng trong mọi phản hồi của router này cho vai không có customer.view_phone.
router.use(maskCustomerPhonesInResponse);

const FIN_SCOPE = { ownerFields: ["consultantId", "createdById"], branchField: "branchId" };

const lineSchema = z.object({
  serviceId: z.string().uuid().optional().nullable(),
  name: z.string().min(1),
  quantity: z.number().int().positive().default(1),
  unitPrice: z.number().int().nonnegative(),
  discount: z.number().int().nonnegative().default(0),
  /** F13: đợt ưu đãi áp cho dòng này. */
  promotionId: z.string().uuid().optional().nullable(),
  /** F21: lý do giảm ngoài ưu đãi (bắt buộc khi có). */
  discountReason: z.string().trim().max(300).optional().nullable(),
});

/**
 * F21: phần giảm ngoài ưu đãi lớn nhất (% giá niêm yết) của các dòng đã lưu,
 * để kiểm người duyệt có đủ trần hay không.
 */
function maxExcessPercentOf(
  items: Array<{ quantity: number; unitPrice: number; listPrice: number | null; discountAmount: number; promotionDiscount: number }>
): number {
  let max = 0;
  for (const i of items) {
    const listTotal = (i.listPrice ?? i.unitPrice) * i.quantity;
    if (listTotal <= 0) continue;
    max = Math.max(max, ((i.discountAmount - i.promotionDiscount) / listTotal) * 100);
  }
  return Math.round(max * 100) / 100;
}

// ------------------------------------------------------------------ BÁO GIÁ

/** Lô 8 · P6: báo giá gắn cơ hội (truyền vào phải thuộc khách; trống = cơ hội hiện tại). */
async function opportunityFor(customerId: string, opportunityId: string | undefined): Promise<string | null> {
  if (opportunityId) {
    const o = await prisma.opportunity.findUnique({ where: { id: opportunityId }, select: { customerId: true } });
    if (!o || o.customerId !== customerId) throw new HttpError(400, "Cơ hội không thuộc khách này");
    return opportunityId;
  }
  return currentOpportunityId(customerId);
}

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
        ...pageQuery(req.query, { defaultLimit: 100, maxLimit: 300 }),
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
        opportunityId: z.string().uuid().optional(),
      })
      .parse(req.body);

    const me = currentUser(req);
    const branchId = body.branchId ?? me.activeBranchId;
    if (!branchId) throw new HttpError(400, "Chưa xác định được cơ sở");

    // F13 + F21: giá niêm yết, đợt ưu đãi, trần giảm theo vai (lib/pricing.ts).
    const capPercent = await discountCapPercent(me.roles);
    const priced = await evaluatePricing(body.items, { branchId, capPercent });
    const { subtotal, discount, total } = priced;
    const approvalStatus = initialApprovalStatus(priced.needsApproval);
    const oppId = await opportunityFor(body.customerId, body.opportunityId);

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
          opportunityId: oppId,
          approvalStatus,
          approvalRequestedAt: priced.needsApproval ? new Date() : null,
          items: { create: priced.lines.map(lineData) },
        },
        include: { items: true, customer: { select: { id: true, name: true, code: true } } },
      })
    );

    if (priced.needsApproval) {
      const approvers = await usersWithPermission("sales_order.approve_discount", branchId);
      await notifyUsers(
        approvers.map((a) => a.id).filter((id) => id !== me.id),
        {
          title: `Báo giá ${quotation.code} chờ duyệt giảm giá`,
          body: `${me.name} giảm ngoài ưu đãi ${priced.maxExcessPercent}% (trần ${capPercent}%) cho ${quotation.customer.name}.`,
          level: "WARN",
          link: "/duyet-giam-gia",
        }
      );
    }

    await prisma.activity.create({
      data: {
        customerId: body.customerId,
        type: ActivityType.QUOTATION,
        content: `${me.name} lập báo giá ${quotation.code}: ${formatVnd(total)}đ`,
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
      summary: `Lập báo giá ${quotation.code} cho ${quotation.customer.name}: ${formatVnd(total)}đ${
        priced.needsApproval ? ` (chờ duyệt giảm ${priced.maxExcessPercent}%, trần ${capPercent}%)` : ""
      }`,
    });

    res.status(201).json({
      ...quotation,
      approval: { status: approvalStatus, maxExcessPercent: priced.maxExcessPercent, capPercent },
    });
  })
);

/**
 * Lô 8 · V6: báo giá bị từ chối thì tự tạo việc chăm lại sau X ngày (tham số
 * quote.rejectFollowupDays) cho sale phụ trách khách (tư vấn viên, telesale, rồi người lập).
 */
async function createQuoteFollowup(
  quotation: { id: string; code: string; customerId: string; branchId: string; total: number; createdById: string | null; opportunityId: string | null },
  reason: string,
  actor: { id: string; name: string }
) {
  const days = await getSettingNumber("quote.rejectFollowupDays");
  const customer = await prisma.customer.findUniqueOrThrow({ where: { id: quotation.customerId }, select: { name: true, assignedToId: true, telesaleId: true } });
  const due = new Date(startOfVnDay(new Date()).getTime() + (days + 1) * 86_400_000 - 60_000);
  const task = await prisma.task.create({
    data: {
      customerId: quotation.customerId,
      branchId: quotation.branchId,
      title: `Chăm lại ${customer.name}: báo giá ${quotation.code} bị từ chối`,
      description: `Lý do khách từ chối: ${reason}. Hỏi lại nhu cầu, đề xuất phương án phù hợp hơn.`,
      status: TaskStatus.OPEN,
      priority: TaskPriority.NORMAL,
      dueAt: due,
      assigneeId: customer.assignedToId ?? customer.telesaleId ?? quotation.createdById,
      createdById: actor.id,
      kind: TaskKind.QUOTE_FOLLOWUP,
      source: "quote-rejected",
      opportunityId: quotation.opportunityId,
    },
  });
  await prisma.quotation.update({ where: { id: quotation.id }, data: { followupTaskId: task.id } });
  await prisma.activity.create({
    data: {
      customerId: quotation.customerId,
      type: ActivityType.QUOTATION,
      content: `Khách từ chối báo giá ${quotation.code}. Lý do: ${reason}. Đã tạo việc chăm lại hạn ${formatDateVN(due)}`,
      userId: actor.id,
      userName: actor.name,
    },
  });
  return task;
}

router.post(
  "/quotations/:id/status",
  requirePermission("sales_order.update"),
  asyncHandler(async (req, res) => {
    const { status, reason } = z
      .object({ status: z.nativeEnum(QuotationStatus), reason: z.string().trim().max(500).optional() })
      .parse(req.body);
    const before = await prisma.quotation.findUnique({ where: { id: req.params.id } });
    assertInScope(req, "sales_order.update", before as unknown as Record<string, unknown>, FIN_SCOPE);
    // Lô 8 · V6: khách từ chối báo giá bắt buộc ghi lý do (để chăm lại đúng chỗ khách vướng).
    if (status === QuotationStatus.REJECTED && before!.status !== QuotationStatus.REJECTED && (!reason || reason.length < 3)) {
      throw new HttpError(400, "Khách từ chối báo giá bắt buộc ghi lý do");
    }
    if (
      (status === QuotationStatus.SENT || status === QuotationStatus.ACCEPTED) &&
      (before!.approvalStatus === ApprovalStatus.PENDING || before!.approvalStatus === ApprovalStatus.REJECTED)
    ) {
      throw new HttpError(
        409,
        before!.approvalStatus === ApprovalStatus.PENDING
          ? "Báo giá đang chờ quản lý duyệt giảm giá, chưa gửi khách được"
          : "Báo giá bị từ chối duyệt giảm giá: lập báo giá mới"
      );
    }

    const quotation = await prisma.quotation.update({
      where: { id: req.params.id },
      data: {
        status,
        ...(status === QuotationStatus.SENT ? { sentAt: new Date() } : {}),
        ...(status === QuotationStatus.ACCEPTED || status === QuotationStatus.REJECTED
          ? { decidedAt: new Date() }
          : {}),
        ...(status === QuotationStatus.REJECTED && reason ? { rejectReason: reason } : {}),
      },
    });
    if (status === QuotationStatus.REJECTED && before!.status !== QuotationStatus.REJECTED) {
      const me = currentUser(req);
      const task = await createQuoteFollowup(quotation, reason!, { id: me.id, name: me.name });
      await writeAudit({
        req,
        action: AuditAction.UPDATE,
        entity: "Quotation",
        entityId: quotation.id,
        branchId: quotation.branchId,
        summary: `Khách từ chối báo giá ${quotation.code}. Lý do: ${reason}`,
      });
      return res.json({ ...quotation, followupTaskId: task.id });
    }
    res.json(quotation);
  })
);

// ------------------------------------------------------- DUYỆT GIẢM GIÁ (F21)

/** GET /api/sales/discount-approvals?status=PENDING — báo giá chờ duyệt giảm vượt trần. */
router.get(
  "/discount-approvals",
  requirePermission("sales_order.approve_discount"),
  asyncHandler(async (req, res) => {
    const { where } = scopedWhere(req, "sales_order.approve_discount", { branchField: "branchId" });
    const status = z.nativeEnum(ApprovalStatus).default(ApprovalStatus.PENDING).parse(req.query.status ?? undefined);
    const rows = await prisma.quotation.findMany({
      where: { ...where, approvalStatus: status },
      orderBy: { createdAt: "desc" },
      ...pageQuery(req.query, { defaultLimit: 100, maxLimit: 300 }),
      include: {
        customer: { select: { id: true, name: true, code: true } },
        createdBy: { select: { id: true, name: true } },
        items: true,
      },
    });
    res.json(rows.map((q) => ({ ...q, maxExcessPercent: maxExcessPercentOf(q.items) })));
  })
);

/**
 * POST /api/sales/quotations/:id/approval { decision: APPROVE|REJECT, note }
 * Người duyệt chỉ duyệt được mức giảm nằm trong trần của CHÍNH MÌNH (quản lý cơ
 * sở mặc định 10%, giám đốc 100%): vượt nữa thì phải lên cấp trên.
 */
router.post(
  "/quotations/:id/approval",
  requirePermission("sales_order.approve_discount"),
  asyncHandler(async (req, res) => {
    const body = z
      .object({ decision: z.enum(["APPROVE", "REJECT"]), note: z.string().trim().max(500).optional() })
      .parse(req.body);
    const before = await prisma.quotation.findUnique({ where: { id: req.params.id }, include: { items: true } });
    assertInScope(req, "sales_order.approve_discount", before as unknown as Record<string, unknown>, { branchField: "branchId" });
    if (before!.approvalStatus !== ApprovalStatus.PENDING) throw new HttpError(409, "Báo giá này không chờ duyệt");
    const me = currentUser(req);
    const excess = maxExcessPercentOf(before!.items);
    if (body.decision === "APPROVE") {
      const myCap = await discountCapPercent(me.roles);
      if (excess > myCap + 0.01) {
        throw new HttpError(403, `Mức giảm ${excess}% vượt trần duyệt của bạn (${myCap}%). Chuyển cấp trên duyệt.`);
      }
    }
    const approved = body.decision === "APPROVE";
    const now = new Date();
    const quotation = await prisma.$transaction(async (tx) => {
      if (approved) {
        for (const i of before!.items) {
          if (i.discountAmount - i.promotionDiscount > 0) {
            await tx.quotationItem.update({ where: { id: i.id }, data: { approvedById: me.id } });
          }
        }
      }
      return tx.quotation.update({
        where: { id: before!.id },
        data: {
          approvalStatus: approved ? ApprovalStatus.APPROVED : ApprovalStatus.REJECTED,
          approvedById: me.id,
          approvedAt: now,
          approvalNote: body.note ?? null,
          ...(approved ? {} : { status: QuotationStatus.REJECTED, decidedAt: now }),
        },
        include: { items: true, customer: { select: { id: true, name: true, code: true } } },
      });
    });
    await writeAudit({
      req,
      action: approved ? AuditAction.APPROVE : AuditAction.REJECT,
      entity: "Quotation",
      entityId: quotation.id,
      branchId: quotation.branchId,
      summary: `${approved ? "Duyệt" : "Từ chối"} giảm giá ${excess}% của báo giá ${quotation.code}${body.note ? `. Ghi chú: ${body.note}` : ""}`,
    });
    await notifyUsers([before!.createdById], {
      title: `Báo giá ${quotation.code} ${approved ? "đã được duyệt" : "bị từ chối"} giảm giá`,
      body: body.note ?? null,
      level: approved ? "INFO" : "WARN",
      link: `/khach-hang/${quotation.customerId}`,
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
      ...pageQuery(req.query, { defaultLimit: 100, maxLimit: 300 }),
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

    // Dòng nhập tay qua đúng luật giá của báo giá (B14, F13, F21). Giảm vượt trần
    // thì không lập thẳng hợp đồng được: lập báo giá để quản lý duyệt.
    let lines: ReturnType<typeof lineData>[] = [];
    if (body.items?.length) {
      const priced = await evaluatePricing(body.items, { branchId, capPercent: await discountCapPercent(me.roles) });
      if (priced.needsApproval) {
        throw new HttpError(
          409,
          `Giảm ngoài ưu đãi ${priced.maxExcessPercent}% vượt trần của bạn: lập báo giá để quản lý duyệt rồi chốt hợp đồng từ báo giá`
        );
      }
      lines = priced.lines.map(lineData);
    } else if (body.quotationId) {
      // Lấy dòng hàng từ báo giá (giữ nguyên giá niêm yết, ưu đãi, người duyệt).
      const quotation = await prisma.quotation.findUnique({
        where: { id: body.quotationId },
        include: { items: true, contract: { select: { id: true, code: true } } },
      });
      if (!quotation) throw notFound("Không tìm thấy báo giá");
      if (quotation.contract) {
        throw new HttpError(409, `Báo giá này đã có hợp đồng ${quotation.contract.code}`);
      }
      if (quotation.approvalStatus === ApprovalStatus.PENDING) {
        throw new HttpError(409, "Báo giá đang chờ quản lý duyệt giảm giá, chưa chốt hợp đồng được");
      }
      if (quotation.approvalStatus === ApprovalStatus.REJECTED) {
        throw new HttpError(409, "Báo giá bị từ chối duyệt giảm giá, không chốt hợp đồng được");
      }
      lines = quotation.items.map((i) => ({
        serviceId: i.serviceId,
        name: i.name,
        quantity: i.quantity,
        unitPrice: i.unitPrice,
        discount: i.discount,
        amount: i.amount,
        listPrice: i.listPrice,
        discountAmount: i.discountAmount,
        promotionDiscount: i.promotionDiscount,
        discountReason: i.discountReason,
        promotionId: i.promotionId,
        approvedById: i.approvedById,
      }));
    }
    if (!lines.length) throw new HttpError(400, "Hợp đồng phải có ít nhất một dòng dịch vụ");

    const subtotal = lines.reduce((s, l) => s + l.quantity * l.unitPrice, 0);
    const discount = lines.reduce((s, l) => s + l.discount, 0);
    const total = subtotal - discount;

    if (body.schedule?.length) {
      const scheduled = body.schedule.reduce((s, i) => s + i.amount, 0);
      if (scheduled !== total) {
        throw new HttpError(
          400,
          `Tổng lịch thu (${formatVnd(scheduled)}đ) phải bằng giá trị hợp đồng (${formatVnd(total)}đ)`
        );
      }
    }

    // F13: mỗi hợp đồng dùng một suất của mỗi đợt ưu đãi; hết suất thì đợt tự khoá.
    const promotionIds = [...new Set(lines.map((l) => l.promotionId).filter((x): x is string => Boolean(x)))];
    const consumed: string[] = [];
    for (const pid of promotionIds) {
      if (!(await consumePromotionSlot(pid))) {
        for (const c of consumed) await releasePromotionSlot(c);
        const p = await prisma.promotion.findUnique({ where: { id: pid }, select: { name: true } });
        throw new HttpError(409, `Đợt ưu đãi "${p?.name ?? pid}" đã hết suất hoặc đã khoá`);
      }
      consumed.push(pid);
    }

    const contractOppId =
      (body.quotationId
        ? (await prisma.quotation.findUnique({ where: { id: body.quotationId }, select: { opportunityId: true } }))?.opportunityId
        : null) ?? (await currentOpportunityId(body.customerId));
    let contract;
    try {
      contract = await withCode(CodePrefix.CONTRACT, (code) =>
        prisma.contract.create({
          data: {
            code,
            branchId,
            customerId: body.customerId,
            quotationId: body.quotationId,
            opportunityId: contractOppId,
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
    } catch (err) {
      for (const c of consumed) await releasePromotionSlot(c);
      throw err;
    }

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

    await applyStageEventSafe(body.customerId, StageEvent.CONTRACT, { actor: { id: me.id, name: me.name } });
    await prisma.customer.update({
      where: { id: body.customerId },
      data: {
        status: CustomerStatus.ACTIVE,
        activities: {
          create: {
            type: ActivityType.CONTRACT,
            content: `${me.name} chốt hợp đồng ${contract.code}: ${formatVnd(total)}đ`,
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
      summary: `Tạo hợp đồng ${contract.code} cho ${contract.customer.name}: ${formatVnd(total)}đ`,
    });

    res.status(201).json(contract);
  })
);

/**
 * PATCH /api/sales/contracts/:id/attribution: F17 ghi nhận ai chốt (bán full hay
 * bán phần, bác sĩ chốt) và dòng nào là upsale của kỹ thuật viên. Kỳ lương đã
 * khoá không bị ảnh hưởng (số đã chốt).
 */
router.patch(
  "/contracts/:id/attribution",
  requirePermission("finance.update"),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        closeType: z.nativeEnum(CloseType).optional(),
        closingDoctorId: z.string().uuid().nullable().optional(),
        upsell: z.array(z.object({ itemId: z.string().uuid(), upsellById: z.string().uuid().nullable() })).max(100).optional(),
      })
      .parse(req.body);
    const before = await prisma.contract.findUnique({ where: { id: req.params.id }, include: { items: { select: { id: true, name: true, upsellById: true } } } });
    assertInScope(req, "finance.update", before as unknown as Record<string, unknown>, FIN_SCOPE);
    const closeType = body.closeType ?? before!.closeType;
    const closingDoctorId = body.closingDoctorId !== undefined ? body.closingDoctorId : before!.closingDoctorId;
    if (closeType === CloseType.PARTIAL && !closingDoctorId) throw new HttpError(400, "Bán phần phải chọn bác sĩ chốt");
    const userIds = [closingDoctorId, ...(body.upsell ?? []).map((u) => u.upsellById)].filter((x): x is string => Boolean(x));
    if (userIds.length) {
      const found = await prisma.user.count({ where: { id: { in: [...new Set(userIds)] } } });
      if (found !== new Set(userIds).size) throw new HttpError(400, "Có nhân viên không tồn tại");
    }
    for (const u of body.upsell ?? []) {
      if (!before!.items.some((i) => i.id === u.itemId)) throw new HttpError(400, "Dòng hợp đồng không thuộc hợp đồng này");
    }
    await prisma.$transaction([
      prisma.contract.update({
        where: { id: before!.id },
        data: { closeType, closingDoctorId: closeType === CloseType.PARTIAL ? closingDoctorId : null },
      }),
      ...(body.upsell ?? []).map((u) => prisma.contractItem.update({ where: { id: u.itemId }, data: { upsellById: u.upsellById } })),
    ]);
    await writeAudit({
      req,
      action: AuditAction.UPDATE,
      entity: "Contract",
      entityId: before!.id,
      branchId: before!.branchId,
      summary: `Ghi nhận chốt hợp đồng ${before!.code}: ${closeType === CloseType.PARTIAL ? "bán phần (bác sĩ chốt)" : "bán full"}${body.upsell?.length ? `, ${body.upsell.filter((u) => u.upsellById).length} dòng upsale` : ""}`,
      changes: { closeType: [before!.closeType, closeType], closingDoctorId: [before!.closingDoctorId, closingDoctorId] },
    });
    const contract = await prisma.contract.findUniqueOrThrow({ where: { id: before!.id }, include: contractInclude });
    res.json(contract);
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
    const before = await prisma.contract.findUnique({ where: { id: req.params.id }, include: { items: { select: { promotionId: true } } } });
    assertInScope(req, "finance.approve", before as unknown as Record<string, unknown>, FIN_SCOPE);
    if (before!.status === ContractStatus.CANCELLED) throw new HttpError(409, "Hợp đồng đã huỷ trước đó");

    const contract = await prisma.contract.update({
      where: { id: req.params.id },
      data: { status: ContractStatus.CANCELLED, cancelReason: reason },
    });
    // F13: trả lại suất ưu đãi của hợp đồng huỷ.
    for (const pid of new Set(before!.items.map((i) => i.promotionId).filter((x): x is string => Boolean(x)))) {
      await releasePromotionSlot(pid);
    }
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
      ...pageQuery(req.query, { defaultLimit: 200, maxLimit: 500 }),
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
      ...pageQuery(req.query, { defaultLimit: 200, maxLimit: 500 }),
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
        ...pageQuery(req.query, { defaultLimit: 200, maxLimit: 500 }),
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
        /** Tiền thu thêm lần này. 0 chỉ hợp lệ khi cọc đã nhận trả đủ phần còn lại. */
        amount: z.number().int().min(0),
        method: z
          .nativeEnum(PaymentMethod)
          .refine((m) => m !== PaymentMethod.VOUCHER, "Voucher dùng qua nút Dùng voucher, không chọn như phương thức thu")
          .optional(),
        reference: z.string().optional(),
        note: z.string().optional(),
        paidAt: z.coerce.date().optional(),
        /** F25: lịch hẹn của lần thanh toán này (để trừ đúng phiếu cọc của lịch). */
        appointmentId: z.string().uuid().optional(),
        /** F25: tự trừ cọc đã nhận (mặc định bật). */
        applyDeposit: z.boolean().optional(),
        misaInvoiceNo: z.string().trim().max(50).optional(),
      })
      .parse(req.body);

    const me = currentUser(req);
    const branchId = body.branchId ?? me.activeBranchId;
    if (!branchId) throw new HttpError(400, "Chưa xác định được cơ sở");

    const invoice = body.invoiceId
      ? await prisma.invoice.findUnique({ where: { id: body.invoiceId } })
      : null;
    if (body.invoiceId && !invoice) throw notFound("Không tìm thấy hoá đơn");

    // F25: cọc đã nhận được trừ trước, khách chỉ trả phần còn lại.
    const useDeposit = body.applyDeposit !== false;
    const cap = invoice ? invoice.amount - invoice.paidAmount : null;
    const pendingDeposit = useDeposit
      ? planDeposits(await openDeposits(prisma, body.customerId, body.appointmentId), cap).total
      : 0;
    if (body.amount === 0 && pendingDeposit === 0) throw new HttpError(400, "Số tiền thu phải lớn hơn 0");
    if (invoice) {
      const remaining = invoice.amount - invoice.paidAmount;
      const depositUsable = pendingDeposit;
      if (body.amount > remaining - depositUsable) {
        throw new HttpError(
          400,
          `Số tiền vượt quá phần còn lại của hoá đơn (${formatVnd(remaining - depositUsable)}đ${
            depositUsable ? `, đã trừ cọc ${formatVnd(depositUsable)}đ` : ""
          })`
        );
      }
    }

    const contractId = body.contractId ?? invoice?.contractId ?? null;
    let depositApplied = 0;

    const payment = await withCode(CodePrefix.PAYMENT, (code) =>
      prisma.$transaction(async (tx) => {
        if (useDeposit && pendingDeposit > 0) {
          const r = await applyDeposits(tx, {
            customerId: body.customerId,
            appointmentId: body.appointmentId,
            invoiceId: invoice?.id,
            contractId,
            cap,
          });
          depositApplied = r.applied;
        }
        // Cọc trả đủ phần còn lại: không lập phiếu thu 0 đồng, chỉ ghi trừ cọc.
        if (body.amount === 0) {
          if (invoice) {
            const paid = invoice.paidAmount + depositApplied;
            await tx.invoice.update({
              where: { id: invoice.id },
              data: { paidAmount: paid, status: paid >= invoice.amount ? InvoiceStatus.PAID : InvoiceStatus.PARTIAL },
            });
          }
          if (contractId) {
            const agg = await tx.payment.aggregate({ where: { contractId }, _sum: { amount: true } });
            await tx.contract.update({ where: { id: contractId }, data: { paidAmount: agg._sum.amount ?? 0 } });
          }
          const customer = await tx.customer.findUniqueOrThrow({ where: { id: body.customerId }, select: { id: true, name: true, code: true } });
          await tx.activity.create({
            data: {
              customerId: body.customerId,
              type: ActivityType.PAYMENT,
              content: `Trừ cọc ${formatVnd(depositApplied)}đ vào thanh toán dịch vụ`,
              userId: me.id,
              userName: me.name,
            },
          });
          return { id: null, code: "(chỉ trừ cọc)", amount: 0, customer } as unknown as Awaited<ReturnType<typeof tx.payment.create>> & {
            customer: { id: string; name: string; code: string };
          };
        }
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
            note: depositApplied
              ? [body.note, `Đã trừ cọc ${formatVnd(depositApplied)}đ`].filter(Boolean).join(". ")
              : body.note,
            paidAt: body.paidAt ?? new Date(),
            receivedById: me.id,
            type: PaymentType.PAYMENT,
            appointmentId: body.appointmentId ?? null,
            misaInvoiceNo: body.misaInvoiceNo ?? null,
          },
          include: { customer: { select: { id: true, name: true, code: true } } },
        });

        if (invoice) {
          const paid = invoice.paidAmount + body.amount + depositApplied;
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
            content: `Thu ${formatVnd(body.amount)}đ, phiếu ${code} (${body.method ?? "CASH"})${
              depositApplied ? `, trừ cọc ${formatVnd(depositApplied)}đ` : ""
            }`,
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
      summary: `Thu ${formatVnd(body.amount)}đ của ${payment.customer.name}: phiếu ${payment.code}${
        depositApplied ? ` (trừ cọc ${formatVnd(depositApplied)}đ)` : ""
      }`,
    });

    await safely("mốc mua đầu", () => refreshFirstPurchaseAt(body.customerId));
    res.status(201).json({ ...payment, depositApplied });
  })
);

/** GET /api/sales/open-deposits?customerId= — cọc đã nhận chưa trừ, để màn thu tiền hiện "sẽ trừ cọc". */
router.get(
  "/open-deposits",
  requirePermission("finance.read"),
  asyncHandler(async (req, res) => {
    const { customerId, appointmentId } = z
      .object({ customerId: z.string().uuid(), appointmentId: z.string().uuid().optional() })
      .parse(req.query);
    const rows = await openDeposits(prisma, customerId, appointmentId);
    res.json({
      total: rows.reduce((s, r) => s + r.amount, 0),
      items: rows.map((r) => ({ id: r.id, code: r.code, amount: r.amount, paidAt: r.paidAt, appointmentId: r.appointmentId })),
    });
  })
);

export default router;
