import { Router, type Request } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { asyncHandler, HttpError } from "../middleware/errorHandler";
import { requireAuth, currentUser } from "../middleware/auth";
import {
  assertBranchAccess,
  hasPermission,
  maskCustomerPhonesInResponse,
  notFound,
  requirePermission,
  scopeOf,
  scopedWhere,
} from "../middleware/rbac";
import { writeAudit } from "../lib/audit";
import { parsePagination } from "../lib/pagination";
import { formatDateTimeVN, formatVnd, startOfVnDay, vnDayKey } from "../lib/datetime";
import { getSettingNumber } from "../lib/settings-catalog";
import { changeStage, getClinicMode, initialStageFor, isValidStage, lostStageFor, stageLabel, stageRank, stagesFor } from "../lib/stages";
import { CUSTOMER_SCOPE, assertCustomerAccess, canSeeMoney, computeMetrics, loadPipelineParams } from "../lib/crm360";
import {
  assertStageRequirements,
  currentOpportunity,
  ensureCurrentOpportunity,
  loadSubStages,
  openOpportunity,
  planDrop,
  subStageOf,
  wonStagesFor,
} from "../lib/opportunities";
import { assertNeedsInOptions, loadNeedsOptions, needsSchema, parseNeeds, suggestNeeds } from "../lib/needs";
import { createPackage, packageStats, useSession } from "../lib/packages";
import { aovReport, forecastReport, journeyByGroup, journeySummary, stageProbabilities, type AovContract, type HistoryRow } from "../lib/crm-reports";
import { upsellStats } from "../lib/upsell";
import {
  ActivityType,
  AuditAction,
  CallResult,
  ContractStatus,
  LostReason,
  MessageDirection,
  OpportunitySource,
  OpportunityStatus,
  PackageStatus,
  PermissionScope,
  StageSource,
  UpsellOfferStatus,
} from "../types/enums";

// Lô 8 · CRM 360 LÔ B (mount cùng /api/crm360 với router Lô A).
//
//   /customers/:id/opportunities, /opportunities/:id/*   P6 cơ hội, P4 bước con, P5 thả thẻ
//   /needs-options, /customers/:id/needs*                 C3 hồ sơ nhu cầu chọn nhanh (+ AI1)
//   /customers/:id/timeline, /customers/:id/calls          C4 dòng thời gian đa kênh
//   /stage-checklist                                       J3 việc theo bước
//   /customers/:id/packages, /packages/*                   V3 gói liệu trình
//   /reports/journey | aov | forecast                      J2, V4, V7

const router = Router();
router.use(requireAuth);
router.use(maskCustomerPhonesInResponse);
export default router;

const DAY = 86_400_000;

async function loadCustomer(req: Request, id: string, code = "customer.read") {
  const customer = await prisma.customer.findUnique({ where: { id } });
  if (!customer || customer.mergedIntoId) throw notFound();
  await assertCustomerAccess(req, customer as unknown as Record<string, unknown>, code);
  return customer;
}

async function namesOf(userIds: Array<string | null | undefined>) {
  const ids = [...new Set(userIds.filter((x): x is string => Boolean(x)))];
  if (!ids.length) return new Map<string, string>();
  const users = await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
  return new Map(users.map((u) => [u.id, u.name]));
}

async function serviceNames(ids: Array<string | null | undefined>) {
  const list = [...new Set(ids.filter((x): x is string => Boolean(x)))];
  if (!list.length) return new Map<string, string>();
  const rows = await prisma.service.findMany({ where: { id: { in: list } }, select: { id: true, name: true } });
  return new Map(rows.map((s) => [s.id, s.name]));
}

// ================================================================ P6 CƠ HỘI

/** GET /api/crm360/customers/:id/opportunities: mọi cơ hội của khách, lịch sử bước từng cơ hội. */
router.get(
  "/customers/:id/opportunities",
  requirePermission("customer.read"),
  asyncHandler(async (req, res) => {
    const customer = await loadCustomer(req, req.params.id);
    const money = canSeeMoney(req);
    const mode = await getClinicMode();
    const [opps, current, subDefs] = await Promise.all([
      prisma.opportunity.findMany({
        where: { customerId: customer.id },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        include: { stageHistory: { orderBy: { createdAt: "desc" }, take: 30 } },
      }),
      currentOpportunity(customer.id),
      loadSubStages(),
    ]);
    const [users, services] = await Promise.all([namesOf(opps.map((o) => o.ownerId)), serviceNames(opps.map((o) => o.serviceId))]);
    const params = await loadPipelineParams();
    const metrics = await computeMetrics(
      opps.map((o) => ({
        id: o.id,
        customerId: customer.id,
        opportunityId: o.id,
        fixedValue: o.expectedValue,
        oppServiceId: o.serviceId,
        primaryUnit: o.id === current?.id,
        stage: o.stage,
        createdAt: o.createdAt,
        stageChangedAt: o.stageChangedAt,
        interest: customer.interest,
        primaryBranchId: o.branchId,
      })),
      { mode, params, now: new Date() }
    );
    res.json({
      moneyVisible: money,
      currentId: current?.id ?? null,
      items: opps.map((o) => {
        const m = metrics.get(o.id)!;
        return {
          id: o.id,
          title: o.title,
          stage: o.stage,
          stageLabel: stageLabel(o.stage),
          subStage: subStageOf(subDefs, o.stage, o.subStage, m.deposit),
          status: o.status,
          source: o.source,
          serviceId: o.serviceId,
          serviceName: o.serviceId ? (services.get(o.serviceId) ?? null) : null,
          owner: o.ownerId ? { id: o.ownerId, name: users.get(o.ownerId) ?? "" } : null,
          expectedValue: money ? m.expectedValue : null,
          manualValue: money ? o.expectedValue : null,
          valueSource: m.valueSource,
          expectedCloseAt: o.expectedCloseAt,
          lostReason: o.lostReason,
          lostNote: o.lostNote,
          daysInStage: m.age.days,
          ageLevel: m.age.level,
          createdAt: o.createdAt,
          closedAt: o.closedAt,
          history: o.stageHistory.map((h) => ({ id: h.id, fromStage: h.fromStage, toStage: h.toStage, source: h.source, event: h.event, note: h.note, userName: h.userName, createdAt: h.createdAt })),
        };
      }),
    });
  })
);

const openBody = z.object({
  serviceId: z.string().uuid().nullable().optional(),
  title: z.string().trim().max(120).nullable().optional(),
  stage: z.string().max(30).optional(),
  expectedValue: z.number().int().min(0).max(10_000_000_000).nullable().optional(),
  expectedCloseAt: z.coerce.date().nullable().optional(),
  ownerId: z.string().uuid().nullable().optional(),
  note: z.string().trim().max(500).nullable().optional(),
});

/**
 * POST /api/crm360/customers/:id/opportunities: mở cơ hội mới (khách quay lại hỏi
 * dịch vụ mới). Không mở trùng: khách đang có cơ hội mở cùng dịch vụ thì báo lỗi.
 * Bước đầu không được là bước thắng hoặc mất.
 */
router.post(
  "/customers/:id/opportunities",
  requirePermission("customer.update"),
  asyncHandler(async (req, res) => {
    const body = openBody.parse(req.body);
    const customer = await loadCustomer(req, req.params.id, "customer.update");
    const mode = await getClinicMode();
    const stage = body.stage ?? initialStageFor(mode);
    if (!isValidStage(mode, stage)) throw new HttpError(400, `Bước "${stage}" không thuộc bộ bước của phòng khám`);
    if (stage === lostStageFor(mode) || wonStagesFor(mode).includes(stage)) throw new HttpError(400, "Cơ hội mới phải bắt đầu ở bước trước khi làm dịch vụ");
    if (!body.serviceId && !body.title) throw new HttpError(400, "Chọn dịch vụ quan tâm hoặc ghi tên cơ hội");
    if (body.serviceId) {
      const svc = await prisma.service.findUnique({ where: { id: body.serviceId }, select: { active: true } });
      if (!svc?.active) throw new HttpError(400, "Dịch vụ không có trong bảng giá hoặc đã ngừng");
      const dup = await prisma.opportunity.findFirst({ where: { customerId: customer.id, serviceId: body.serviceId, status: OpportunityStatus.OPEN } });
      if (dup) throw new HttpError(409, `Khách đang có cơ hội mở cho dịch vụ này ("${dup.title}")`);
    }
    if (body.expectedValue != null && !canSeeMoney(req)) throw new HttpError(403, "Chỉ quản lý, kế toán được nhập giá trị dự kiến");
    // Khách cũ chưa chuyển dữ liệu: tạo cơ hội từ trạng thái hiện tại trước, để không mất lịch sử bước cũ.
    await ensureCurrentOpportunity(customer.id, mode);
    const me = currentUser(req);
    const opp = await openOpportunity({
      customerId: customer.id,
      stage,
      mode,
      source: OpportunitySource.MANUAL,
      title: body.title,
      serviceId: body.serviceId ?? null,
      expectedValue: body.expectedValue ?? null,
      expectedCloseAt: body.expectedCloseAt ?? null,
      ownerId: body.ownerId ?? null,
      actor: { id: me.id, name: me.name },
      note: body.note ?? null,
    });
    await writeAudit({
      req,
      action: AuditAction.CREATE,
      entity: "Opportunity",
      entityId: opp.id,
      branchId: opp.branchId,
      summary: `Mở cơ hội "${opp.title}" cho khách ${customer.code} ở bước ${stageLabel(stage)}`,
    });
    res.status(201).json(opp);
  })
);

async function loadOpportunity(req: Request, id: string, code = "customer.read") {
  const opp = await prisma.opportunity.findUnique({ where: { id } });
  if (!opp) throw notFound();
  const customer = await loadCustomer(req, opp.customerId, code);
  return { opp, customer };
}

/** PATCH /api/crm360/opportunities/:id: tên, dịch vụ, giá trị dự kiến, ngày dự kiến chốt, sale, bước con tay. */
router.patch(
  "/opportunities/:id",
  requirePermission("customer.update"),
  asyncHandler(async (req, res) => {
    const body = openBody
      .omit({ stage: true, note: true })
      .extend({ subStage: z.string().max(30).nullable().optional() })
      .parse(req.body);
    const { opp, customer } = await loadOpportunity(req, req.params.id, "customer.update");
    if (body.expectedValue !== undefined && !canSeeMoney(req)) throw new HttpError(403, "Chỉ quản lý, kế toán được sửa giá trị dự kiến");
    if (body.subStage) {
      const defs = (await loadSubStages()).get(opp.stage) ?? [];
      const def = defs.find((d) => d.key === body.subStage);
      if (!def) throw new HttpError(400, "Bước con không thuộc bước hiện tại");
      if (def.auto) throw new HttpError(400, "Bước con này tự tính theo cọc của lịch hẹn, không chọn tay");
    }
    if (body.serviceId) {
      const svc = await prisma.service.findUnique({ where: { id: body.serviceId }, select: { active: true } });
      if (!svc?.active) throw new HttpError(400, "Dịch vụ không có trong bảng giá hoặc đã ngừng");
    }
    const data: Record<string, unknown> = {};
    for (const k of ["title", "serviceId", "expectedValue", "expectedCloseAt", "ownerId", "subStage"] as const) {
      if (body[k] !== undefined) data[k] = body[k];
    }
    if (data.title === null || data.title === "") delete data.title;
    const updated = await prisma.opportunity.update({ where: { id: opp.id }, data });
    await writeAudit({
      req,
      action: AuditAction.UPDATE,
      entity: "Opportunity",
      entityId: opp.id,
      branchId: opp.branchId,
      summary: `Sửa cơ hội "${updated.title}" của khách ${customer.code}`,
      changes: Object.fromEntries(Object.keys(data).map((k) => [k, [(opp as Record<string, unknown>)[k], data[k]]])),
    });
    res.json(updated);
  })
);

/** GET /api/crm360/opportunities/:id/drop-check?to=STAGE: P5 thả thẻ mở form nào, P4 còn thiếu gì. */
router.get(
  "/opportunities/:id/drop-check",
  requirePermission("customer.read"),
  asyncHandler(async (req, res) => {
    const to = z.string().max(30).parse(req.query.to);
    const { opp } = await loadOpportunity(req, req.params.id);
    const mode = await getClinicMode();
    if (!isValidStage(mode, to)) throw new HttpError(400, `Bước "${to}" không thuộc bộ bước của phòng khám`);
    res.json(await planDrop(opp.customerId, opp, mode, to));
  })
);

/** GET /api/crm360/customers/:id/drop-check?to=STAGE: như trên cho thẻ khách chưa có cơ hội. */
router.get(
  "/customers/:id/drop-check",
  requirePermission("customer.read"),
  asyncHandler(async (req, res) => {
    const to = z.string().max(30).parse(req.query.to);
    const customer = await loadCustomer(req, req.params.id);
    const mode = await getClinicMode();
    if (!isValidStage(mode, to)) throw new HttpError(400, `Bước "${to}" không thuộc bộ bước của phòng khám`);
    res.json(await planDrop(customer.id, await currentOpportunity(customer.id), mode, to));
  })
);

/**
 * POST /api/crm360/opportunities/:id/stage: đổi bước MỘT cơ hội (bảng kéo thả).
 * Luật như đổi bước khách: bước hợp lệ, mất khách bắt buộc lý do, lùi bước bắt
 * buộc ghi lý do; thêm P4: bước cần lịch hẹn, hợp đồng.
 */
router.post(
  "/opportunities/:id/stage",
  requirePermission("customer.update"),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        stage: z.string().max(30),
        lostReason: z.nativeEnum(LostReason).optional(),
        reason: z.string().trim().max(500).optional(),
        subStage: z.string().max(30).nullable().optional(),
      })
      .parse(req.body);
    const { opp, customer } = await loadOpportunity(req, req.params.id, "customer.update");
    const mode = await getClinicMode();
    if (!isValidStage(mode, body.stage)) throw new HttpError(400, `Bước "${body.stage}" không thuộc bộ bước của phòng khám hiện tại`);
    if (body.stage === opp.stage) return res.json({ opportunity: opp, customerStage: customer.stage });
    const lost = lostStageFor(mode);
    if (body.stage === lost && !body.lostReason) throw new HttpError(400, "Chuyển sang Mất khách bắt buộc chọn lý do mất khách");
    const isRegression = body.stage !== lost && opp.stage !== lost && stageRank(mode, opp.stage) >= 0 && stageRank(mode, body.stage) < stageRank(mode, opp.stage);
    if (isRegression && !body.reason) throw new HttpError(400, "Lùi bước bán hàng bắt buộc phải ghi lý do");
    await assertStageRequirements(customer.id, opp, mode, body.stage);
    const me = currentUser(req);
    const after = await changeStage({
      customerId: customer.id,
      fromStage: opp.stage,
      toStage: body.stage,
      opportunityId: opp.id,
      source: StageSource.MANUAL,
      lostReason: body.stage === lost ? body.lostReason : null,
      note: body.reason ?? null,
      subStage: body.subStage ?? null,
      actor: { id: me.id, name: me.name },
      mode,
    });
    await writeAudit({
      req,
      action: AuditAction.UPDATE,
      entity: "Opportunity",
      entityId: opp.id,
      branchId: opp.branchId,
      summary: `Đổi bước cơ hội "${opp.title}" của khách ${customer.code}: ${stageLabel(opp.stage)} → ${stageLabel(body.stage)}`,
      changes: { stage: [opp.stage, body.stage] },
    });
    res.json({ opportunity: await prisma.opportunity.findUnique({ where: { id: opp.id } }), customerStage: after.stage });
  })
);

// ================================================================ C3 HỒ SƠ NHU CẦU

router.get(
  "/needs-options",
  requirePermission("customer.read"),
  asyncHandler(async (_req, res) => {
    res.json(await loadNeedsOptions());
  })
);

router.get(
  "/customers/:id/needs",
  requirePermission("customer.read"),
  asyncHandler(async (req, res) => {
    const customer = await loadCustomer(req, req.params.id);
    res.json({ needs: parseNeeds(customer.needsProfile), options: await loadNeedsOptions() });
  })
);

router.put(
  "/customers/:id/needs",
  requirePermission("customer.update"),
  asyncHandler(async (req, res) => {
    const body = needsSchema.parse(req.body);
    const customer = await loadCustomer(req, req.params.id, "customer.update");
    const err = assertNeedsInOptions(body, await loadNeedsOptions());
    if (err) throw new HttpError(400, err);
    const me = currentUser(req);
    const before = parseNeeds(customer.needsProfile);
    const saved = { ...body, comparing: [...new Set(body.comparing)], updatedAt: new Date().toISOString(), updatedBy: me.name };
    await prisma.customer.update({ where: { id: customer.id }, data: { needsProfile: JSON.stringify(saved) } });
    await writeAudit({
      req,
      action: AuditAction.UPDATE,
      entity: "Customer",
      entityId: customer.id,
      summary: `Cập nhật hồ sơ nhu cầu khách ${customer.code}`,
      changes: { needsProfile: [before, body] },
    });
    res.json({ needs: saved });
  })
);

/** POST /api/crm360/customers/:id/needs/suggest: AI1 gợi ý điền (không ghi gì). */
router.post(
  "/customers/:id/needs/suggest",
  requirePermission("customer.update"),
  asyncHandler(async (req, res) => {
    const customer = await loadCustomer(req, req.params.id, "customer.update");
    res.json(await suggestNeeds({ req, customerId: customer.id, branchId: currentUser(req).activeBranchId }));
  })
);

// ================================================================ C4 DÒNG THỜI GIAN ĐA KÊNH

export const TIMELINE_KINDS = ["MESSAGE", "CALL", "VISIT", "APPOINTMENT", "QUOTE", "PAYMENT", "CONTRACT", "STAGE", "NOTE", "PACKAGE"] as const;
type TimelineKind = (typeof TIMELINE_KINDS)[number];

export interface TimelineItem {
  id: string;
  at: Date;
  kind: TimelineKind;
  channel: string | null;
  direction: string | null;
  title: string;
  text: string | null;
  by: string | null;
  amount: number | null;
}

const CHANNEL_LABEL: Record<string, string> = {
  ZALO_OA: "Zalo",
  ZALO_GROUP: "Nhóm Zalo",
  FACEBOOK: "Facebook",
  HOTLINE: "Tổng đài",
  INTERNAL: "Nội bộ",
};
const CALL_RESULT_LABEL: Record<string, string> = { ANSWERED: "nghe máy", NO_ANSWER: "không nghe máy", BUSY: "máy bận", WRONG_NUMBER: "sai số" };

/**
 * GET /api/crm360/customers/:id/timeline?kinds=MESSAGE,CALL&channel=FACEBOOK&before=ISO&limit=50
 * Gom tin Facebook, Zalo (theo kênh của hội thoại), cuộc gọi (ghi tay), lần đến,
 * lịch hẹn, báo giá, thanh toán, hợp đồng, đổi bước, ghi chú, buổi gói liệu trình
 * vào một dòng mới nhất trước. Phân trang bằng mốc `before` (trả `nextBefore`).
 * Số tiền chỉ hiện với vai xem được tiền (Quyết định 3).
 */
router.get(
  "/customers/:id/timeline",
  requirePermission("customer.read"),
  asyncHandler(async (req, res) => {
    const q = z
      .object({
        kinds: z.string().max(200).optional(),
        channel: z.string().max(30).optional(),
        before: z.coerce.date().optional(),
      })
      .parse(req.query);
    const page = parsePagination(req.query, { defaultLimit: 50, maxLimit: 200 });
    const customer = await loadCustomer(req, req.params.id);
    const money = canSeeMoney(req);
    const wanted = new Set<TimelineKind>(
      q.kinds ? (q.kinds.split(",").map((k) => k.trim().toUpperCase()).filter((k) => (TIMELINE_KINDS as readonly string[]).includes(k)) as TimelineKind[]) : [...TIMELINE_KINDS]
    );
    // Lọc theo kênh chat thì chỉ còn tin nhắn của kênh đó.
    if (q.channel) for (const k of TIMELINE_KINDS) if (k !== "MESSAGE") wanted.delete(k);
    const before = q.before ?? new Date(Date.now() + DAY);
    const take = page.limit + 1;
    const cid = customer.id;
    const has = (k: TimelineKind) => wanted.has(k);
    const activityTypes = [
      ...(has("CALL") ? [ActivityType.CALL] : []),
      ...(has("STAGE") ? [ActivityType.STAGE_CHANGE, ActivityType.OPPORTUNITY] : []),
      ...(has("NOTE") ? [ActivityType.NOTE] : []),
    ];

    const [messages, activities, visits, appts, quotes, payments, contracts, sessions] = await Promise.all([
      has("MESSAGE")
        ? prisma.chatMessage.findMany({
            where: { conversation: { customerId: cid, ...(q.channel ? { channel: q.channel } : {}) }, createdAt: { lt: before } },
            orderBy: { createdAt: "desc" },
            take,
            select: { id: true, content: true, direction: true, senderName: true, createdAt: true, type: true, conversation: { select: { channel: true } } },
          })
        : [],
      activityTypes.length
        ? prisma.activity.findMany({ where: { customerId: cid, type: { in: activityTypes }, createdAt: { lt: before } }, orderBy: { createdAt: "desc" }, take })
        : [],
      has("VISIT")
        ? prisma.visit.findMany({
            where: { customerId: cid, checkedInAt: { lt: before } },
            orderBy: { checkedInAt: "desc" },
            take,
            select: { id: true, checkedInAt: true, status: true, purpose: true, branch: { select: { shortName: true, name: true } }, consultant: { select: { name: true } } },
          })
        : [],
      has("APPOINTMENT")
        ? prisma.appointment.findMany({
            where: { customerId: cid, createdAt: { lt: before } },
            orderBy: { createdAt: "desc" },
            take,
            select: { id: true, createdAt: true, startAt: true, title: true, status: true, depositAmount: true, depositStatus: true, createdBy: { select: { name: true } } },
          })
        : [],
      has("QUOTE")
        ? prisma.quotation.findMany({
            where: { customerId: cid, createdAt: { lt: before } },
            orderBy: { createdAt: "desc" },
            take,
            select: { id: true, code: true, createdAt: true, status: true, total: true, rejectReason: true, optionTier: true, createdBy: { select: { name: true } } },
          })
        : [],
      has("PAYMENT")
        ? prisma.payment.findMany({
            where: { customerId: cid, paidAt: { lt: before } },
            orderBy: { paidAt: "desc" },
            take,
            select: { id: true, code: true, paidAt: true, amount: true, type: true, method: true, receivedBy: { select: { name: true } } },
          })
        : [],
      has("CONTRACT")
        ? prisma.contract.findMany({
            where: { customerId: cid, createdAt: { lt: before } },
            orderBy: { createdAt: "desc" },
            take,
            select: { id: true, code: true, createdAt: true, status: true, total: true, consultant: { select: { name: true } } },
          })
        : [],
      has("PACKAGE")
        ? prisma.packageSession.findMany({
            where: { package: { customerId: cid }, usedAt: { lt: before } },
            orderBy: { usedAt: "desc" },
            take,
            select: { id: true, usedAt: true, sessionNo: true, userName: true, note: true, package: { select: { name: true, totalSessions: true } } },
          })
        : [],
    ]);

    const items: TimelineItem[] = [];
    for (const m of messages) {
      const ch = CHANNEL_LABEL[m.conversation.channel] ?? m.conversation.channel;
      items.push({
        id: `msg:${m.id}`,
        at: m.createdAt,
        kind: "MESSAGE",
        channel: m.conversation.channel,
        direction: m.direction,
        title: m.direction === MessageDirection.IN ? `Khách nhắn qua ${ch}` : `Trả lời qua ${ch}`,
        text: m.content,
        by: m.direction === MessageDirection.OUT ? m.senderName : null,
        amount: null,
      });
    }
    for (const a of activities) {
      let meta: Record<string, unknown> = {};
      try {
        meta = a.meta ? JSON.parse(a.meta) : {};
      } catch {
        meta = {};
      }
      const kind: TimelineKind = a.type === ActivityType.CALL ? "CALL" : a.type === ActivityType.NOTE ? "NOTE" : "STAGE";
      const title =
        kind === "CALL"
          ? `Cuộc gọi ${meta.direction === "IN" ? "khách gọi đến" : "gọi cho khách"}${meta.result ? `: ${CALL_RESULT_LABEL[String(meta.result)] ?? meta.result}` : ""}${
              typeof meta.durationSec === "number" && meta.durationSec > 0 ? ` (${Math.round(meta.durationSec / 60)} phút)` : ""
            }`
          : kind === "NOTE"
            ? "Ghi chú"
            : a.type === ActivityType.OPPORTUNITY
              ? "Cơ hội"
              : "Đổi bước";
      items.push({ id: `act:${a.id}`, at: a.createdAt, kind, channel: kind === "CALL" ? "PHONE" : null, direction: kind === "CALL" ? String(meta.direction ?? "OUT") : null, title, text: a.content, by: a.userName, amount: null });
    }
    for (const v of visits) {
      items.push({
        id: `visit:${v.id}`,
        at: v.checkedInAt,
        kind: "VISIT",
        channel: null,
        direction: null,
        title: `Đến cơ sở ${v.branch.shortName ?? v.branch.name}`,
        text: [v.purpose, v.consultant ? `Tư vấn: ${v.consultant.name}` : null].filter(Boolean).join(" · ") || null,
        by: null,
        amount: null,
      });
    }
    for (const a of appts) {
      items.push({
        id: `appt:${a.id}`,
        at: a.createdAt,
        kind: "APPOINTMENT",
        channel: null,
        direction: null,
        title: `Đặt lịch: ${a.title}`,
        text: `Hẹn ${formatDateTimeVN(a.startAt)}${a.depositStatus === "DA_COC" ? " · đã cọc" : a.depositStatus === "CHO_COC" ? " · chờ cọc" : ""}`,
        by: a.createdBy?.name ?? null,
        amount: money && a.depositAmount ? a.depositAmount : null,
      });
    }
    for (const qt of quotes) {
      items.push({
        id: `quote:${qt.id}`,
        at: qt.createdAt,
        kind: "QUOTE",
        channel: null,
        direction: null,
        title: `Báo giá ${qt.code}`,
        text: `${qt.status === "REJECTED" ? `Khách từ chối${qt.rejectReason ? `: ${qt.rejectReason}` : ""}` : qt.status === "ACCEPTED" ? "Khách đồng ý" : qt.status === "SENT" ? "Đã gửi khách" : "Nháp"}`,
        by: qt.createdBy?.name ?? null,
        amount: money ? qt.total : null,
      });
    }
    for (const p of payments) {
      items.push({
        id: `pay:${p.id}`,
        at: p.paidAt,
        kind: "PAYMENT",
        channel: null,
        direction: null,
        title: p.type === "REFUND" ? `Hoàn tiền ${p.code}` : p.type === "DEPOSIT" ? `Thu cọc ${p.code}` : `Thu tiền ${p.code}`,
        text: money ? `${formatVnd(p.amount)}đ` : null,
        by: p.receivedBy?.name ?? null,
        amount: money ? p.amount : null,
      });
    }
    for (const c of contracts) {
      items.push({ id: `contract:${c.id}`, at: c.createdAt, kind: "CONTRACT", channel: null, direction: null, title: `Hợp đồng ${c.code}`, text: c.status === ContractStatus.CANCELLED ? "Đã huỷ" : null, by: c.consultant?.name ?? null, amount: money ? c.total : null });
    }
    for (const s of sessions) {
      items.push({ id: `pkg:${s.id}`, at: s.usedAt, kind: "PACKAGE", channel: null, direction: null, title: `Dùng buổi ${s.sessionNo}/${s.package.totalSessions} gói "${s.package.name}"`, text: s.note, by: s.userName, amount: null });
    }
    items.sort((a, b) => b.at.getTime() - a.at.getTime() || a.id.localeCompare(b.id));
    const pageItems = items.slice(0, page.limit);
    const hasMore = items.length > page.limit;
    res.json({
      items: pageItems,
      nextBefore: hasMore ? pageItems[pageItems.length - 1].at : null,
      channels: (await prisma.conversation.groupBy({ by: ["channel"], where: { customerId: cid } })).map((c) => ({ key: c.channel, label: CHANNEL_LABEL[c.channel] ?? c.channel })),
      moneyVisible: money,
    });
  })
);

/** POST /api/crm360/customers/:id/calls: ghi cuộc gọi tay (chưa nối tổng đài). */
router.post(
  "/customers/:id/calls",
  requirePermission("customer.update"),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        direction: z.enum(["IN", "OUT"]).default("OUT"),
        result: z.nativeEnum(CallResult),
        durationSec: z.number().int().min(0).max(36_000).optional(),
        note: z.string().trim().max(1000).optional(),
      })
      .parse(req.body);
    const customer = await loadCustomer(req, req.params.id, "customer.update");
    const me = currentUser(req);
    const activity = await prisma.activity.create({
      data: {
        customerId: customer.id,
        type: ActivityType.CALL,
        content: body.note?.trim() || (body.direction === "IN" ? "Khách gọi đến" : "Gọi cho khách"),
        meta: JSON.stringify({ direction: body.direction, result: body.result, durationSec: body.durationSec ?? 0 }),
        userId: me.id,
        userName: me.name,
      },
    });
    if (body.result === CallResult.ANSWERED) await prisma.customer.update({ where: { id: customer.id }, data: { lastContactAt: new Date() } });
    res.status(201).json(activity);
  })
);

// ================================================================ J3 VIỆC THEO BƯỚC

const checklistBody = z.object({
  stage: z.string().max(30),
  branchId: z.string().uuid().nullable().optional(),
  title: z.string().trim().min(3, "Tên việc tối thiểu 3 ký tự").max(200),
  messageTemplate: z.string().trim().max(1000).nullable().optional(),
  dueDays: z.number().int().min(0).max(60).default(0),
  sortOrder: z.number().int().min(0).max(999).default(0),
  active: z.boolean().default(true),
});

function assertChecklistBranch(req: Request, branchId: string | null | undefined) {
  if (!branchId) {
    if (scopeOf(req, "pipeline.manage") !== PermissionScope.ALL) throw new HttpError(403, "Việc áp cho mọi cơ sở cần quyền toàn hệ thống: chọn cơ sở của bạn");
    return;
  }
  assertBranchAccess(req, branchId, "pipeline.manage");
}

router.get(
  "/stage-checklist",
  requirePermission("customer.read"),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const all = scopeOf(req, "pipeline.manage") === PermissionScope.ALL;
    const items = await prisma.stageChecklistItem.findMany({
      where: all ? {} : { OR: [{ branchId: null }, { branchId: { in: me.branchIds } }] },
      orderBy: [{ stage: "asc" }, { sortOrder: "asc" }, { createdAt: "asc" }],
    });
    res.json({ items, canManage: hasPermission(req, "pipeline.manage") });
  })
);

router.post(
  "/stage-checklist",
  requirePermission("pipeline.manage"),
  asyncHandler(async (req, res) => {
    const body = checklistBody.parse(req.body);
    const mode = await getClinicMode();
    if (!isValidStage(mode, body.stage)) throw new HttpError(400, `Bước "${body.stage}" không thuộc bộ bước của phòng khám`);
    assertChecklistBranch(req, body.branchId);
    const me = currentUser(req);
    const item = await prisma.stageChecklistItem.create({ data: { ...body, branchId: body.branchId ?? null, createdById: me.id } });
    await writeAudit({ req, action: AuditAction.CREATE, entity: "StageChecklistItem", entityId: item.id, branchId: item.branchId, summary: `Thêm việc theo bước ${stageLabel(item.stage)}: ${item.title}` });
    res.status(201).json(item);
  })
);

router.patch(
  "/stage-checklist/:id",
  requirePermission("pipeline.manage"),
  asyncHandler(async (req, res) => {
    const body = checklistBody.partial().parse(req.body);
    const before = await prisma.stageChecklistItem.findUnique({ where: { id: req.params.id } });
    if (!before) throw notFound();
    assertChecklistBranch(req, before.branchId);
    if (body.branchId !== undefined) assertChecklistBranch(req, body.branchId);
    if (body.stage && !isValidStage(await getClinicMode(), body.stage)) throw new HttpError(400, `Bước "${body.stage}" không thuộc bộ bước của phòng khám`);
    const item = await prisma.stageChecklistItem.update({ where: { id: before.id }, data: { ...body, ...(body.title || body.messageTemplate !== undefined ? { isSample: false } : {}) } });
    await writeAudit({ req, action: AuditAction.UPDATE, entity: "StageChecklistItem", entityId: item.id, branchId: item.branchId, summary: `Sửa việc theo bước ${stageLabel(item.stage)}: ${item.title}${body.active === false ? " (tắt)" : ""}` });
    res.json(item);
  })
);

// ================================================================ V3 GÓI LIỆU TRÌNH

function packageView(p: Awaited<ReturnType<typeof prisma.treatmentPackage.findFirstOrThrow>> & { sessions?: Array<{ id: string; sessionNo: number; usedAt: Date; value: number; userName: string | null; note: string | null }> }, money: boolean) {
  const st = packageStats(p);
  return {
    id: p.id,
    name: p.name,
    contractId: p.contractId,
    contractItemId: p.contractItemId,
    serviceId: p.serviceId,
    branchId: p.branchId,
    totalSessions: p.totalSessions,
    usedSessions: p.usedSessions,
    remainingSessions: st.remainingSessions,
    status: p.status,
    expiresAt: p.expiresAt,
    expired: Boolean(p.expiresAt && p.expiresAt < new Date() && p.status === PackageStatus.ACTIVE),
    intervalDays: p.intervalDays,
    lastUsedAt: p.lastUsedAt,
    cancelReason: p.cancelReason,
    createdAt: p.createdAt,
    price: money ? p.price : null,
    usedValue: money ? st.usedValue : null,
    remainingValue: money ? st.remainingValue : null,
    sessions: (p.sessions ?? []).map((s) => ({ ...s, value: money ? s.value : null })),
  };
}

router.get(
  "/customers/:id/packages",
  requirePermission("customer.read"),
  asyncHandler(async (req, res) => {
    const customer = await loadCustomer(req, req.params.id);
    const money = canSeeMoney(req);
    const [pkgs, items] = await Promise.all([
      prisma.treatmentPackage.findMany({ where: { customerId: customer.id }, orderBy: { createdAt: "desc" }, include: { sessions: { orderBy: { sessionNo: "asc" } } } }),
      // Dòng hợp đồng có số lượng từ 2, chưa lập gói: gợi ý "Lập gói".
      prisma.contractItem.findMany({
        where: { quantity: { gte: 2 }, contract: { customerId: customer.id, status: { not: ContractStatus.CANCELLED } } },
        select: { id: true, name: true, quantity: true, amount: true, contract: { select: { id: true, code: true } } },
      }),
    ]);
    const used = new Set(pkgs.map((p) => p.contractItemId));
    res.json({
      moneyVisible: money,
      items: pkgs.map((p) => packageView(p, money)),
      candidates: items.filter((i) => !used.has(i.id)).map((i) => ({ ...i, amount: money ? i.amount : null })),
    });
  })
);

/** POST /api/crm360/packages: lập gói từ một dòng hợp đồng (số buổi mặc định = số lượng dòng). */
router.post(
  "/packages",
  requirePermission("finance.create"),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        contractItemId: z.string().uuid(),
        sessions: z.number().int().min(2).max(100).optional(),
        intervalDays: z.number().int().min(1).max(365).nullable().optional(),
        expiresAt: z.coerce.date().nullable().optional(),
      })
      .parse(req.body);
    const item = await prisma.contractItem.findUnique({ where: { id: body.contractItemId }, select: { contract: { select: { customerId: true, branchId: true } } } });
    if (!item) throw notFound();
    assertBranchAccess(req, item.contract.branchId, "finance.create");
    await loadCustomer(req, item.contract.customerId);
    const me = currentUser(req);
    const pkg = await createPackage({ ...body, actor: { id: me.id, name: me.name } });
    await writeAudit({ req, action: AuditAction.CREATE, entity: "TreatmentPackage", entityId: pkg.id, branchId: pkg.branchId, summary: `Lập gói liệu trình "${pkg.name}" ${pkg.totalSessions} buổi` });
    res.status(201).json(packageView(pkg, canSeeMoney(req)));
  })
);

/** POST /api/crm360/packages/:id/sessions: trừ một buổi (gắn lần thực hiện nếu có). */
router.post(
  "/packages/:id/sessions",
  requirePermission("customer.update"),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        procedureId: z.string().uuid().nullable().optional(),
        visitId: z.string().uuid().nullable().optional(),
        note: z.string().trim().max(500).nullable().optional(),
      })
      .parse(req.body);
    const pkg = await prisma.treatmentPackage.findUnique({ where: { id: req.params.id } });
    if (!pkg) throw notFound();
    await loadCustomer(req, pkg.customerId, "customer.update");
    const me = currentUser(req);
    if (!me.branchIds.includes(pkg.branchId) && scopeOf(req, "customer.update") !== PermissionScope.ALL) {
      // Khách dùng buổi ở cơ sở khác cơ sở bán gói: cho phép nếu người bấm làm ở cơ sở có khách đến.
      const visitHere = await prisma.visit.findFirst({ where: { customerId: pkg.customerId, branchId: { in: me.branchIds }, checkedInAt: { gte: startOfVnDay(new Date()) } } });
      if (!visitHere) throw notFound("Gói thuộc cơ sở khác");
    }
    const r = await useSession({ packageId: pkg.id, procedureId: body.procedureId ?? null, visitId: body.visitId ?? null, note: body.note ?? null, actor: { id: me.id, name: me.name } });
    await writeAudit({ req, action: AuditAction.UPDATE, entity: "TreatmentPackage", entityId: pkg.id, branchId: pkg.branchId, summary: `Dùng buổi ${r.session.sessionNo}/${pkg.totalSessions} gói "${pkg.name}"` });
    res.status(201).json({ session: { ...r.session, value: canSeeMoney(req) ? r.session.value : null }, package: packageView(r.package, canSeeMoney(req)) });
  })
);

router.post(
  "/packages/:id/cancel",
  requirePermission("finance.update"),
  asyncHandler(async (req, res) => {
    const { reason } = z.object({ reason: z.string().trim().min(3, "Ghi lý do huỷ gói").max(500) }).parse(req.body);
    const pkg = await prisma.treatmentPackage.findUnique({ where: { id: req.params.id } });
    if (!pkg) throw notFound();
    assertBranchAccess(req, pkg.branchId, "finance.update");
    if (pkg.status !== PackageStatus.ACTIVE) throw new HttpError(409, "Chỉ huỷ được gói đang dùng");
    const me = currentUser(req);
    const updated = await prisma.treatmentPackage.update({ where: { id: pkg.id }, data: { status: PackageStatus.CANCELLED, cancelReason: reason } });
    await prisma.activity.create({ data: { customerId: pkg.customerId, type: ActivityType.PACKAGE, content: `${me.name} huỷ gói "${pkg.name}" (đã dùng ${pkg.usedSessions}/${pkg.totalSessions} buổi). Lý do: ${reason}`, userId: me.id, userName: me.name } });
    await writeAudit({ req, action: AuditAction.UPDATE, entity: "TreatmentPackage", entityId: pkg.id, branchId: pkg.branchId, summary: `Huỷ gói "${pkg.name}". Lý do: ${reason}` });
    res.json(packageView(updated, canSeeMoney(req)));
  })
);

/** Phạm vi cơ sở cho báo cáo tiền: finance.read toàn hệ thống thì mọi cơ sở (lọc được), cơ sở thì cơ sở của mình. */
function moneyBranches(req: Request, branchId?: string): string[] | null {
  if (!canSeeMoney(req)) throw new HttpError(403, "Báo cáo có số tiền chỉ dành cho quản lý, kế toán, giám đốc");
  const me = currentUser(req);
  if (branchId) {
    assertBranchAccess(req, branchId, "finance.read");
    return [branchId];
  }
  return scopeOf(req, "finance.read") === PermissionScope.ALL ? null : me.branchIds;
}

/**
 * GET /api/crm360/packages/summary: tổng gói đã bán, giá trị buổi đã dùng, phần trả
 * trước chưa thực hiện. THAM KHẢO cho kế toán; báo cáo doanh thu giữ cách ghi theo hợp đồng.
 */
router.get(
  "/packages/summary",
  requirePermission("finance.read"),
  asyncHandler(async (req, res) => {
    const { branchId } = z.object({ branchId: z.string().uuid().optional() }).parse(req.query);
    const branches = moneyBranches(req, branchId);
    const pkgs = await prisma.treatmentPackage.findMany({ where: branches ? { branchId: { in: branches } } : {} });
    const contracts = await prisma.contract.findMany({ where: { id: { in: [...new Set(pkgs.map((p) => p.contractId))] } }, select: { id: true, paidAmount: true, total: true } });
    const paidOf = new Map(contracts.map((c) => [c.id, c]));
    let sold = 0;
    let usedValue = 0;
    let prepaidUnused = 0;
    for (const p of pkgs) {
      if (p.status === PackageStatus.CANCELLED) continue;
      const st = packageStats(p);
      sold += p.price;
      usedValue += st.usedValue;
      const c = paidOf.get(p.contractId);
      // Phần đã thu của dòng gói (chia theo tỉ lệ giá gói trên hợp đồng) trừ giá trị buổi đã dùng.
      const paidForPkg = c && c.total > 0 ? Math.round((c.paidAmount * p.price) / c.total) : 0;
      prepaidUnused += Math.max(0, paidForPkg - st.usedValue);
    }
    res.json({
      packages: pkgs.length,
      active: pkgs.filter((p) => p.status === PackageStatus.ACTIVE).length,
      completed: pkgs.filter((p) => p.status === PackageStatus.COMPLETED).length,
      cancelled: pkgs.filter((p) => p.status === PackageStatus.CANCELLED).length,
      soldValue: sold,
      usedValue,
      remainingValue: sold - usedValue,
      prepaidUnused,
      note: "Doanh số và thực thu trong báo cáo tài chính giữ nguyên cách ghi: doanh số theo hợp đồng ký, thực thu theo phiếu thu. Số liệu gói ở đây chỉ để tham khảo.",
    });
  })
);

// ================================================================ BÁO CÁO J2 V4 V7

const reportQuery = z.object({
  days: z.coerce.number().int().min(1).max(1095).optional(),
  branchId: z.string().uuid().optional(),
});

async function periodOf(days?: number) {
  const d = days ?? (await getSettingNumber("report.crm360.defaultDays"));
  const to = new Date();
  return { days: d, from: new Date(startOfVnDay(to).getTime() - (d - 1) * DAY), to };
}

/**
 * GET /api/crm360/reports/journey?days=90&groupBy=sale|channel|service|branch
 * J2: thời gian TB mỗi bước, bước rơi nhiều nhất; tổng và theo nhóm. Đếm theo cơ
 * hội (dòng cũ chưa gắn cơ hội thì theo khách). Phạm vi xem theo khách (customer.read).
 */
router.get(
  "/reports/journey",
  requirePermission("customer.read"),
  asyncHandler(async (req, res) => {
    const q = reportQuery.extend({ groupBy: z.enum(["sale", "channel", "service", "branch"]).default("sale") }).parse(req.query);
    const { days, from, to } = await periodOf(q.days);
    const mode = await getClinicMode();
    const { where } = scopedWhere(req, "customer.read", CUSTOMER_SCOPE);
    const customerWhere = { AND: [where, { mergedIntoId: null }, ...(q.branchId ? [{ branchLinks: { some: { branchId: q.branchId } } }] : [])] };
    // Lấy trọn lịch sử của các cơ hội có dòng trong kỳ (để có dòng kế tiếp tính thời gian).
    const inRange = await prisma.stageHistory.findMany({
      where: { createdAt: { gte: from, lt: to }, customer: customerWhere },
      select: { customerId: true, opportunityId: true },
    });
    const oppIds = [...new Set(inRange.map((r) => r.opportunityId).filter((x): x is string => Boolean(x)))];
    const legacyCustomers = [...new Set(inRange.filter((r) => !r.opportunityId).map((r) => r.customerId))];
    const rowsRaw = await prisma.stageHistory.findMany({
      where: { OR: [{ opportunityId: { in: oppIds } }, { customerId: { in: legacyCustomers }, opportunityId: null }] },
      select: { customerId: true, opportunityId: true, fromStage: true, toStage: true, createdAt: true },
    });
    const rows: HistoryRow[] = rowsRaw.map((r) => ({ key: r.opportunityId ?? r.customerId, fromStage: r.fromStage, toStage: r.toStage, createdAt: r.createdAt }));
    const [opps, customers] = await Promise.all([
      prisma.opportunity.findMany({ where: { id: { in: oppIds } }, select: { id: true, ownerId: true, channelId: true, serviceId: true, branchId: true, customerId: true } }),
      prisma.customer.findMany({
        where: { id: { in: [...new Set(rowsRaw.map((r) => r.customerId))] } },
        select: { id: true, assignedToId: true, telesaleId: true, channelId: true, branchLinks: { select: { branchId: true, isPrimary: true } } },
      }),
    ]);
    const oppOf = new Map(opps.map((o) => [o.id, o]));
    const custOf = new Map(customers.map((c) => [c.id, c]));
    const groupOf = (key: string): string | null => {
      const o = oppOf.get(key);
      const c = custOf.get(o?.customerId ?? key);
      const branch = o?.branchId ?? (c?.branchLinks.find((b) => b.isPrimary) ?? c?.branchLinks[0])?.branchId ?? null;
      switch (q.groupBy) {
        case "sale":
          return o?.ownerId ?? c?.assignedToId ?? c?.telesaleId ?? null;
        case "channel":
          return o?.channelId ?? c?.channelId ?? null;
        case "service":
          return o?.serviceId ?? null;
        case "branch":
          return branch;
      }
    };
    const groups = journeyByGroup(rows, groupOf, mode, { from, to });
    const ids = groups.map((g) => g.group).filter((x): x is string => Boolean(x));
    const labelOf = new Map<string, string>();
    if (q.groupBy === "sale") for (const [k, v] of await namesOf(ids)) labelOf.set(k, v);
    if (q.groupBy === "service") for (const [k, v] of await serviceNames(ids)) labelOf.set(k, v);
    if (q.groupBy === "channel") for (const c of await prisma.channel.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })) labelOf.set(c.id, c.name);
    if (q.groupBy === "branch") for (const b of await prisma.branch.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, shortName: true } })) labelOf.set(b.id, b.shortName ?? b.name);
    res.json({
      days,
      from,
      to,
      groupBy: q.groupBy,
      stages: stagesFor(mode).filter((s) => !s.lost).map((s) => ({ key: s.key, label: s.label })),
      overall: journeySummary(rows, mode, { from, to }),
      groups: groups.map((g) => ({ key: g.group, label: g.group ? (labelOf.get(g.group) ?? "(đã xoá)") : "Chưa xác định", ...g.summary })),
    });
  })
);

/**
 * GET /api/crm360/reports/aov?days=90: V4 giá trị đơn trung bình theo sale, bác sĩ,
 * cơ sở, dịch vụ đầu vào, kênh; tỉ lệ đơn có bán kèm; tỉ lệ nhận gợi ý V2. CHỈ ĐO,
 * không nối lương, thi đua (Quyết định 2). Đơn = hợp đồng đã ký chưa huỷ, theo ngày ký
 * (cùng chuẩn báo cáo doanh số hiện có).
 */
router.get(
  "/reports/aov",
  requirePermission("finance.read"),
  asyncHandler(async (req, res) => {
    const q = reportQuery.parse(req.query);
    const branches = moneyBranches(req, q.branchId);
    const { days, from, to } = await periodOf(q.days);
    const contracts = await prisma.contract.findMany({
      where: { status: { not: ContractStatus.CANCELLED }, signedAt: { gte: from, lt: to }, ...(branches ? { branchId: { in: branches } } : {}) },
      select: {
        id: true,
        total: true,
        branchId: true,
        consultantId: true,
        closingDoctorId: true,
        customerId: true,
        quotationId: true,
        customer: { select: { channelId: true } },
        items: { select: { serviceId: true, upsellById: true } },
        procedures: { select: { surgeonId: true }, take: 1, orderBy: { scheduledAt: "asc" } },
      },
    });
    const customerIds = [...new Set(contracts.map((c) => c.customerId))];
    // Dịch vụ đầu vào = dịch vụ dòng đầu của hợp đồng đầu tiên khách từng ký.
    const firsts = await prisma.contract.findMany({
      where: { customerId: { in: customerIds }, status: { not: ContractStatus.CANCELLED }, signedAt: { not: null } },
      orderBy: [{ signedAt: "asc" }, { createdAt: "asc" }],
      select: { customerId: true, items: { select: { serviceId: true }, take: 1 } },
    });
    const entryOf = new Map<string, string | null>();
    for (const f of firsts) if (!entryOf.has(f.customerId)) entryOf.set(f.customerId, f.items[0]?.serviceId ?? null);
    const quoteIds = contracts.map((c) => c.quotationId).filter((x): x is string => Boolean(x));
    const acceptedOffers = quoteIds.length
      ? await prisma.upsellOffer.findMany({ where: { quotationId: { in: quoteIds }, status: UpsellOfferStatus.ACCEPTED }, select: { quotationId: true } })
      : [];
    const upsellQuotes = new Set(acceptedOffers.map((o) => o.quotationId));
    const rows: AovContract[] = contracts.map((c) => ({
      id: c.id,
      total: c.total,
      hasUpsell: c.items.some((i) => i.upsellById) || Boolean(c.quotationId && upsellQuotes.has(c.quotationId)),
      dims: {
        sale: c.consultantId,
        doctor: c.closingDoctorId ?? c.procedures[0]?.surgeonId ?? null,
        branch: c.branchId,
        entryService: entryOf.get(c.customerId) ?? null,
        channel: c.customer.channelId,
      },
    }));
    const dims = ["sale", "doctor", "branch", "entryService", "channel"];
    const report = aovReport(rows, dims);
    const userIds = [...report.by.sale, ...report.by.doctor].map((r) => r.key);
    const [users, services, channels, branchRows] = await Promise.all([
      namesOf(userIds),
      serviceNames(report.by.entryService.map((r) => r.key)),
      prisma.channel.findMany({ where: { id: { in: report.by.channel.map((r) => r.key).filter((x): x is string => Boolean(x)) } }, select: { id: true, name: true } }),
      prisma.branch.findMany({ where: { id: { in: report.by.branch.map((r) => r.key).filter((x): x is string => Boolean(x)) } }, select: { id: true, name: true, shortName: true } }),
    ]);
    const label = (dim: string, key: string | null) => {
      if (!key) return "Chưa xác định";
      if (dim === "sale" || dim === "doctor") return users.get(key) ?? "(đã xoá)";
      if (dim === "entryService") return services.get(key) ?? "(đã xoá)";
      if (dim === "channel") return channels.find((c) => c.id === key)?.name ?? "(đã xoá)";
      const b = branchRows.find((x) => x.id === key);
      return b ? (b.shortName ?? b.name) : "(đã xoá)";
    };
    const upsell = await upsellStats({ gte: from, lt: to }, branches);
    res.json({
      days,
      from,
      to,
      overall: report.overall,
      by: Object.fromEntries(dims.map((d) => [d, report.by[d].map((r) => ({ ...r, label: label(d, r.key) }))])),
      upsellOffers: upsell,
      note: "Chỉ đo và hiển thị, không dùng tính lương hay thi đua.",
    });
  })
);

/**
 * GET /api/crm360/reports/forecast: V7 dự báo pipeline = giá trị dự kiến × xác suất
 * thắng của bước, xác suất đo từ lịch sử bước thật; dưới ngưỡng mẫu thì "chưa đủ
 * dữ liệu" và không cộng vào dự báo. Theo tháng (ngày dự kiến chốt, không có thì
 * lịch hẹn sắp tới) và theo sale.
 */
router.get(
  "/reports/forecast",
  requirePermission("finance.read"),
  asyncHandler(async (req, res) => {
    const q = reportQuery.parse(req.query);
    const branches = moneyBranches(req, q.branchId);
    const mode = await getClinicMode();
    const [minSamples, lookback] = await Promise.all([getSettingNumber("forecast.minSamples"), getSettingNumber("forecast.lookbackDays")]);
    const now = new Date();
    const histRaw = await prisma.stageHistory.findMany({
      where: { createdAt: { gte: new Date(now.getTime() - lookback * DAY) } },
      select: { customerId: true, opportunityId: true, fromStage: true, toStage: true, createdAt: true },
    });
    const prob = stageProbabilities(
      histRaw.map((r) => ({ key: r.opportunityId ?? r.customerId, fromStage: r.fromStage, toStage: r.toStage, createdAt: r.createdAt })),
      mode,
      minSamples
    );
    const opps = await prisma.opportunity.findMany({
      where: {
        status: OpportunityStatus.OPEN,
        customer: { hidden: false, mergedIntoId: null },
        ...(branches
          ? { OR: [{ branchId: { in: branches } }, { branchId: null, customer: { branchLinks: { some: { branchId: { in: branches } } } } }] }
          : {}),
      },
      select: { id: true, customerId: true, stage: true, ownerId: true, expectedValue: true, expectedCloseAt: true, serviceId: true, branchId: true, createdAt: true, stageChangedAt: true, customer: { select: { interest: true } } },
    });
    const currentIds = new Set<string>();
    const seen = new Set<string>();
    for (const o of [...opps].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())) {
      if (!seen.has(o.customerId)) {
        seen.add(o.customerId);
        currentIds.add(o.id);
      }
    }
    const params = await loadPipelineParams();
    const metrics = await computeMetrics(
      opps.map((o) => ({
        id: o.id,
        customerId: o.customerId,
        opportunityId: o.id,
        fixedValue: o.expectedValue,
        oppServiceId: o.serviceId,
        primaryUnit: currentIds.has(o.id),
        stage: o.stage,
        createdAt: o.createdAt,
        stageChangedAt: o.stageChangedAt,
        interest: o.customer.interest,
        primaryBranchId: o.branchId,
      })),
      { mode, params, now }
    );
    const report = forecastReport(
      opps.map((o) => {
        const m = metrics.get(o.id)!;
        const when = o.expectedCloseAt ?? m.nextAppointmentAt;
        return { id: o.id, stage: o.stage, value: m.expectedValue, ownerId: o.ownerId, month: when ? vnDayKey(when).slice(0, 7) : null };
      }),
      prob
    );
    const users = await namesOf(report.byOwner.map((b) => b.key));
    res.json({
      minSamples,
      lookbackDays: lookback,
      probabilities: stagesFor(mode)
        .filter((s) => prob.has(s.key))
        .map((s) => ({ ...prob.get(s.key)!, label: s.label })),
      total: report.total,
      byMonth: report.byMonth,
      byOwner: report.byOwner.map((b) => ({ ...b, label: b.key ? (users.get(b.key) ?? "(đã xoá)") : "Chưa phân công" })),
      byStage: report.byStage.map((b) => ({ ...b, label: stageLabel(b.key) })),
    });
  })
);

