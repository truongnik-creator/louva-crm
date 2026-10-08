import { Router } from "express";
import { getClinicMode, initialStageFor, stageForEvent } from "../lib/stages";
import { noteLeadPhone, safely, syncLeadsForCustomer } from "../lib/lead-funnel";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { asyncHandler, HttpError } from "../middleware/errorHandler";
import { requireAuth, currentUser } from "../middleware/auth";
import { requirePermission, scopedWhere, assertInScope, notFound, phoneFor, hasPermission } from "../middleware/rbac";
import { pageQuery, CATALOG_PAGE } from "../lib/pagination";
import { normalizeVnPhone } from "../lib/phone";
import { writeAudit } from "../lib/audit";
import { withCode, CodePrefix } from "../lib/codes";
import { AuditAction, ActivityType, ChannelKind, LeadStage, StageEvent, CustomerStatus } from "../types/enums";

// Lead & chiến dịch — màn "Lead & Chiến dịch" trong prototype.
// Marketing có phạm vi ALL với lead; telesale chỉ thấy lead của mình (OWN).

const router = Router();
router.use(requireAuth);

const LEAD_SCOPE = { ownerFields: ["assignedToId"], branchField: "branchId" };

/**
 * S4: lead trả ra ngoài luôn đi qua đây. Marketing có quyền lead phạm vi ALL
 * nhưng KHÔNG có `customer.view_phone`, nên chỉ thấy SĐT dạng 09xx xxx 123.
 * `phoneNormalized` luôn bị bỏ khỏi phản hồi vì nó chính là SĐT thật.
 */
function presentLead<T extends { phone?: string | null; phoneNormalized?: string | null }>(
  req: Parameters<typeof phoneFor>[0],
  lead: T
) {
  const { phoneNormalized: _hidden, ...rest } = lead;
  return { ...rest, phone: phoneFor(req, lead.phone) };
}

// ------------------------------------------------------------------ CHANNELS

router.get(
  "/channels",
  asyncHandler(async (req, res) => {
    res.json(await prisma.channel.findMany({ orderBy: { name: "asc" }, ...pageQuery(req.query, CATALOG_PAGE) }));
  })
);

router.post(
  "/channels",
  requirePermission("lead.create"),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        key: z.string().min(2),
        name: z.string().min(2),
        kind: z.nativeEnum(ChannelKind),
        active: z.boolean().optional(),
      })
      .parse(req.body);
    const channel = await prisma.channel.create({ data: body });
    await writeAudit({
      req,
      action: AuditAction.CREATE,
      entity: "Channel",
      entityId: channel.id,
      summary: `Tạo kênh ${channel.name}`,
    });
    res.status(201).json(channel);
  })
);

// ----------------------------------------------------------------- CAMPAIGNS

router.get(
  "/campaigns",
  requirePermission("lead.read"),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const campaigns = await prisma.campaign.findMany({
      where: {
        ...(req.query.active === "1" ? { active: true } : {}),
        OR: [{ branchId: null }, { branchId: { in: me.branchIds } }],
      },
      orderBy: { createdAt: "desc" },
      ...pageQuery(req.query, CATALOG_PAGE),
      include: {
        channel: { select: { id: true, name: true, kind: true } },
        _count: { select: { leads: true, customers: true } },
      },
    });

    // ROAS cần chi phí thực tế + doanh thu quy về chiến dịch.
    const costs = await prisma.campaignCost.groupBy({
      by: ["campaignId"],
      _sum: { amount: true },
    });
    const costByCampaign = new Map(costs.map((c) => [c.campaignId, c._sum.amount ?? 0]));

    res.json(
      campaigns.map((c) => ({
        ...c,
        leadCount: c._count.leads,
        customerCount: c._count.customers,
        spentAmount: costByCampaign.get(c.id) ?? 0,
        _count: undefined,
      }))
    );
  })
);

router.post(
  "/campaigns",
  requirePermission("lead.create"),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        code: z.string().min(2),
        name: z.string().min(2),
        channelId: z.string().uuid().optional(),
        branchId: z.string().uuid().optional(),
        utmSource: z.string().optional(),
        utmMedium: z.string().optional(),
        utmCampaign: z.string().optional(),
        budget: z.number().int().nonnegative().optional(),
        startDate: z.coerce.date().optional(),
        endDate: z.coerce.date().optional(),
      })
      .parse(req.body);

    const campaign = await prisma.campaign.create({ data: body });
    await writeAudit({
      req,
      action: AuditAction.CREATE,
      entity: "Campaign",
      entityId: campaign.id,
      branchId: campaign.branchId,
      summary: `Tạo chiến dịch ${campaign.name} (${campaign.code})`,
    });
    res.status(201).json(campaign);
  })
);

router.post(
  "/campaigns/:id/costs",
  requirePermission("lead.update"),
  asyncHandler(async (req, res) => {
    const body = z
      .object({ date: z.coerce.date(), amount: z.number().int().nonnegative(), note: z.string().optional() })
      .parse(req.body);

    const cost = await prisma.campaignCost.upsert({
      where: { campaignId_date: { campaignId: req.params.id, date: body.date } },
      create: { campaignId: req.params.id, ...body },
      update: { amount: body.amount, note: body.note },
    });
    res.status(201).json(cost);
  })
);

// --------------------------------------------------------------------- LEADS

router.get(
  "/",
  requirePermission("lead.read"),
  asyncHandler(async (req, res) => {
    const { where } = scopedWhere(req, "lead.read", LEAD_SCOPE);
    const filters: Record<string, unknown> = { ...where };
    if (req.query.stage) filters.stage = String(req.query.stage);
    if (req.query.campaignId) filters.campaignId = String(req.query.campaignId);
    if (req.query.assignedToId) filters.assignedToId = String(req.query.assignedToId);
    if (req.query.q) {
      const q = String(req.query.q).trim();
      const qPhone = normalizeVnPhone(q);
      filters.OR = [
        { name: { contains: q } },
        { phone: { contains: q } },
        ...(qPhone ? [{ phoneNormalized: { contains: qPhone } }] : []),
      ];
    }

    const leads = await prisma.lead.findMany({
      where: filters,
      orderBy: { createdAt: "desc" },
      ...pageQuery(req.query, { defaultLimit: 200, maxLimit: 500 }),
      include: {
        channel: { select: { id: true, name: true, kind: true } },
        campaign: { select: { id: true, name: true, code: true } },
        assignedTo: { select: { id: true, name: true } },
      },
    });
    res.json(leads.map((l) => presentLead(req, l)));
  })
);

const leadSchema = z.object({
  name: z.string().min(2),
  phone: z.string().optional().nullable(),
  zaloUserId: z.string().optional().nullable(),
  interest: z.string().optional().nullable(),
  note: z.string().optional().nullable(),
  channelId: z.string().uuid().optional().nullable(),
  campaignId: z.string().uuid().optional().nullable(),
  branchId: z.string().uuid().optional().nullable(),
  assignedToId: z.string().uuid().optional().nullable(),
  externalId: z.string().optional().nullable(),
});

router.post(
  "/",
  requirePermission("lead.create"),
  asyncHandler(async (req, res) => {
    const body = leadSchema.parse(req.body);
    const me = currentUser(req);

    // Chống trùng khi lead đến từ webhook Facebook chạy lại.
    if (body.externalId) {
      const existing = await prisma.lead.findFirst({ where: { externalId: body.externalId } });
      if (existing) return res.status(200).json(presentLead(req, existing));
    }

    // B17: chống trùng theo SĐT chuẩn hoá. Một người nhắn qua 2 kênh chỉ là
    // MỘT lead đang mở; lead đã chốt/thất bại thì cho tạo lead mới (quay lại).
    const phoneNormalized = normalizeVnPhone(body.phone);
    if (phoneNormalized) {
      const dup = await prisma.lead.findFirst({
        where: {
          phoneNormalized,
          stage: { notIn: [LeadStage.WON, LeadStage.LOST, LeadStage.SPAM] },
        },
        select: { id: true, name: true, stage: true },
      });
      if (dup) {
        return res.status(409).json({
          error: `Số điện thoại đã có lead đang mở: ${dup.name}`,
          duplicate: { type: "lead", id: dup.id, name: dup.name, stage: dup.stage },
        });
      }
    }
    const matchedCustomer = phoneNormalized
      ? await prisma.customer.findFirst({
          where: { phoneNormalized, mergedIntoId: null },
          select: { id: true, code: true, name: true },
        })
      : null;

    const lead = await prisma.lead.create({
      data: { ...body, branchId: body.branchId ?? me.activeBranchId },
    });
    await writeAudit({
      req,
      action: AuditAction.CREATE,
      entity: "Lead",
      entityId: lead.id,
      branchId: lead.branchId,
      summary: `Tạo lead ${lead.name}`,
    });
    // Khách cũ quay lại qua quảng cáo vẫn tạo lead (để đo chiến dịch), nhưng
    // báo cho người nhập biết đã có hồ sơ khách, khi chuyển đổi sẽ gộp vào đó.
    res.status(201).json({ ...presentLead(req, lead), matchedCustomer });
  })
);

router.patch(
  "/:id",
  requirePermission("lead.update"),
  asyncHandler(async (req, res) => {
    const body = leadSchema
      .partial()
      .extend({ stage: z.nativeEnum(LeadStage).optional(), lostReason: z.string().optional() })
      .parse(req.body);

    const before = await prisma.lead.findUnique({ where: { id: req.params.id } });
    assertInScope(req, "lead.update", before as unknown as Record<string, unknown>, LEAD_SCOPE);

    // Người không được xem SĐT chỉ thấy bản che; form sửa gửi lại chuỗi che đó
    // thì KHÔNG được ghi đè số thật.
    if (!hasPermission(req, "customer.view_phone") && before!.phone && body.phone !== undefined) {
      delete body.phone;
    }

    if (body.stage === LeadStage.LOST && !body.lostReason && !before!.lostReason) {
      throw new HttpError(400, "Đánh dấu lead thất bại bắt buộc ghi lý do");
    }

    const lead = await prisma.lead.update({ where: { id: req.params.id }, data: body });
    // F15: lần đầu lead có SĐT.
    if (lead.phone) await noteLeadPhone([lead.id]);
    res.json(presentLead(req, lead));
  })
);

// POST /api/leads/:id/assign — chia lead cho telesale
router.post(
  "/:id/assign",
  requirePermission("lead.update"),
  asyncHandler(async (req, res) => {
    const { userId } = z.object({ userId: z.string().uuid() }).parse(req.body);
    const before = await prisma.lead.findUnique({ where: { id: req.params.id } });
    assertInScope(req, "lead.update", before as unknown as Record<string, unknown>, LEAD_SCOPE);

    const lead = await prisma.lead.update({
      where: { id: req.params.id },
      data: { assignedToId: userId, stage: before!.stage === LeadStage.NEW ? LeadStage.CONTACTING : before!.stage },
      include: { assignedTo: { select: { id: true, name: true } } },
    });
    await writeAudit({
      req,
      action: AuditAction.UPDATE,
      entity: "Lead",
      entityId: lead.id,
      summary: `Chia lead ${lead.name} cho ${lead.assignedTo?.name}`,
    });
    res.json(presentLead(req, lead));
  })
);

/**
 * POST /api/leads/:id/convert
 * Lead -> Customer. Nếu số điện thoại đã có khách thì GẮN VÀO khách cũ thay vì
 * tạo bản trùng — chống phân mảnh hồ sơ, quan trọng vì khách liên thông giữa
 * phòng khám sản và thẩm mỹ.
 */
router.post(
  "/:id/convert",
  requirePermission("customer.create"),
  asyncHandler(async (req, res) => {
    const lead = await prisma.lead.findUnique({ where: { id: req.params.id } });
    if (!lead) throw notFound("Không tìm thấy lead");
    if (lead.convertedCustomerId) throw new HttpError(409, "Lead này đã được chuyển thành khách");

    const me = currentUser(req);
    const branchId = lead.branchId ?? me.activeBranchId;

    // B17: so theo SĐT chuẩn hoá, "+84 912..." và "0912..." là cùng một khách.
    const phoneNormalized = lead.phoneNormalized ?? normalizeVnPhone(lead.phone);
    const existing = phoneNormalized
      ? await prisma.customer.findFirst({
          where: { phoneNormalized, mergedIntoId: null },
          orderBy: { createdAt: "asc" },
        })
      : null;

    const mode = await getClinicMode();
    const customer =
      existing ??
      (await withCode(CodePrefix.CUSTOMER, (code) =>
        prisma.customer.create({
          data: {
            code,
            name: lead.name,
            phone: lead.phone,
            zaloUserId: lead.zaloUserId,
            channelId: lead.channelId,
            campaignId: lead.campaignId,
            interest: lead.interest ? JSON.stringify([lead.interest]) : null,
            note: lead.note,
            status: CustomerStatus.LEAD,
            // Lead đã được liên hệ: phẫu thuật = "Đã liên hệ", tiêm = "Nhắn tin".
            stage: stageForEvent(mode, StageEvent.MESSAGE) ?? initialStageFor(mode),
            assignedToId: lead.assignedToId ?? me.id,
            ...(branchId ? { branchLinks: { create: { branchId, isPrimary: true } } } : {}),
          },
        })
      ));

    // Khách cũ ở cơ sở khác: bổ sung liên kết cơ sở, không đụng vào bệnh án.
    if (existing && branchId) {
      await prisma.customerBranchLink.upsert({
        where: { customerId_branchId: { customerId: existing.id, branchId } },
        create: { customerId: existing.id, branchId },
        update: {},
      });
    }

    // Khách cũ đã có lead gốc: convertedCustomerId là duy nhất, lead này chỉ lên WON
    // (trước đây ghi đè gây lỗi trùng khoá và lead kẹt ngoài phễu marketing).
    const hasOrigin = existing
      ? Boolean(await prisma.lead.findFirst({ where: { convertedCustomerId: existing.id }, select: { id: true } }))
      : false;
    await prisma.$transaction([
      prisma.lead.update({
        where: { id: lead.id },
        data: { ...(hasOrigin ? {} : { convertedCustomerId: customer.id }), stage: LeadStage.WON },
      }),
      prisma.activity.create({
        data: {
          customerId: customer.id,
          type: ActivityType.SYSTEM,
          content: existing
            ? `Lead "${lead.name}" gộp vào hồ sơ khách sẵn có bởi ${me.name}`
            : `Chuyển lead "${lead.name}" thành khách bởi ${me.name}`,
          userId: me.id,
          userName: me.name,
        },
      }),
    ]);

    await safely("đồng bộ lead khi chuyển", () => syncLeadsForCustomer(customer.id, { leadId: lead.id }));

    await writeAudit({
      req,
      action: AuditAction.UPDATE,
      entity: "Lead",
      entityId: lead.id,
      branchId,
      summary: `Chuyển lead ${lead.name} thành khách ${customer.code}${existing ? " (gộp vào khách sẵn có)" : ""}`,
    });

    res.status(201).json({
      customer: { ...customer, phone: phoneFor(req, customer.phone), phoneNormalized: undefined },
      merged: Boolean(existing),
    });
  })
);

export default router;
