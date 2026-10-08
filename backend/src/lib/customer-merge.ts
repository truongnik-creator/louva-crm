import type { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { HttpError } from "../middleware/errorHandler";
import { ActivityType } from "../types/enums";
import { getClinicMode } from "./stages";
import { opportunityFromCustomer, syncCustomerStage } from "./opportunities";

// Gộp hồ sơ khách trùng (B17).
//
// Nguyên tắc: KHÔNG xoá gì. Mọi bản ghi con (lịch hẹn, hợp đồng, phiếu thu,
// bệnh án, ảnh, tin nhắn...) chuyển sang hồ sơ giữ lại; hồ sơ bị gộp chỉ bị ẩn,
// đánh dấu `mergedIntoId`, để tra ngược được và nhật ký cũ vẫn trỏ đúng chỗ.

/** Các bảng có cột customerId chuyển thẳng được bằng updateMany. */
const MOVABLE = [
  "activity",
  "task",
  "conversation",
  "appointment",
  "visit",
  "quotation",
  "contract",
  "invoice",
  "payment",
  "medicalRecord",
  "consentForm",
  "photoSet",
  "procedureRecord",
  "productUsage",
  "consultationSession",
  "treatmentPlan",
  "caseStudy",
  "dataAccessLog",
  "breakGlassGrant",
  "stageHistory",
  // Lô 4: nhật ký gửi theo nhóm, gợi ý AI.
  "broadcastRecipient",
  "aiSuggestion",
  // Lô 5: voucher, quà tặng, điểm chấm hội thoại. (ReferralReward xử lý riêng
  // bên dưới vì mỗi khách được giới thiệu chỉ có một dòng thưởng.)
  "voucher",
  "giftLog",
  // Lô 7: gợi ý bán kèm.
  "upsellOffer",
  "conversationScore",
  // Lô 6: nháp tin chăm lại (AI5).
  "reengageDraft",
  // Lô 8: cơ hội bán, gói liệu trình.
  "opportunity",
  "treatmentPackage",
] as const;

type Movable = (typeof MOVABLE)[number];

function parseArray(v: string | null): string[] {
  if (!v) return [];
  try {
    const p = JSON.parse(v);
    return Array.isArray(p) ? p.map(String) : [];
  } catch {
    return [];
  }
}

export interface MergeResult {
  primaryId: string;
  duplicateId: string;
  moved: Record<string, number>;
  filledFields: string[];
}

export async function mergeCustomers(opts: {
  primaryId: string;
  duplicateId: string;
  reason: string;
  actor: { id: string; name: string };
}): Promise<MergeResult> {
  const { primaryId, duplicateId, reason, actor } = opts;
  if (primaryId === duplicateId) throw new HttpError(400, "Không thể gộp một hồ sơ vào chính nó");

  return prisma.$transaction(async (tx) => {
    const [primary, dup] = await Promise.all([
      tx.customer.findUnique({ where: { id: primaryId }, include: { leadOrigin: { select: { id: true } } } }),
      tx.customer.findUnique({ where: { id: duplicateId }, include: { leadOrigin: { select: { id: true } } } }),
    ]);
    if (!primary || !dup) throw new HttpError(404, "Không tìm thấy hồ sơ khách");
    if (primary.mergedIntoId) throw new HttpError(409, `Hồ sơ ${primary.code} đã bị gộp vào hồ sơ khác, không dùng làm hồ sơ giữ lại được`);
    if (dup.mergedIntoId) throw new HttpError(409, `Hồ sơ ${dup.code} đã được gộp trước đó`);

    // Bệnh án là duy nhất theo (khách, cơ sở). Hai hồ sơ cùng có bệnh án ở một
    // cơ sở thì không được gộp máy móc: phải để bác sĩ đối chiếu nội dung.
    const [pRecords, dRecords] = await Promise.all([
      tx.medicalRecord.findMany({ where: { customerId: primaryId }, select: { branchId: true, code: true } }),
      tx.medicalRecord.findMany({ where: { customerId: duplicateId }, select: { branchId: true, code: true } }),
    ]);
    const clash = dRecords.find((d) => pRecords.some((p) => p.branchId === d.branchId));
    if (clash) {
      throw new HttpError(
        409,
        `Cả hai hồ sơ đều có bệnh án tại cùng một cơ sở (${clash.code}). Cần bác sĩ đối chiếu và gộp bệnh án trước.`
      );
    }

    // Lô 8 · P6: hồ sơ giữ lại chưa có cơ hội mà hồ sơ trùng có thì tạo cơ hội của hồ
    // sơ giữ lại trước (từ bước hiện tại của nó), để bước của nó không bị lẫn vào cơ
    // hội chuyển sang. Sau khi chuyển, bước khách = cơ hội mở mới nhất (Quyết định 1).
    const mode = await getClinicMode();
    const [pOpps, dOpps] = await Promise.all([
      tx.opportunity.count({ where: { customerId: primaryId } }),
      tx.opportunity.count({ where: { customerId: duplicateId } }),
    ]);
    if (!pOpps && dOpps) {
      const seed = await tx.customer.findUniqueOrThrow({
        where: { id: primaryId },
        include: { branchLinks: { select: { branchId: true, isPrimary: true } } },
      });
      const created = await tx.opportunity.create({ data: opportunityFromCustomer(seed, mode, new Map()) });
      await tx.stageHistory.updateMany({ where: { customerId: primaryId, opportunityId: null }, data: { opportunityId: created.id } });
    }

    const moved: Record<string, number> = {};
    for (const model of MOVABLE) {
      const delegate = tx[model as Movable] as unknown as {
        updateMany: (args: { where: { customerId: string }; data: { customerId: string } }) => Promise<{ count: number }>;
      };
      const r = await delegate.updateMany({ where: { customerId: duplicateId }, data: { customerId: primaryId } });
      if (r.count) moved[model] = r.count;
    }

    // Liên kết cơ sở và thẻ có khoá duy nhất: thêm cái còn thiếu rồi bỏ bản của hồ sơ trùng.
    const dupLinks = await tx.customerBranchLink.findMany({ where: { customerId: duplicateId } });
    for (const l of dupLinks) {
      await tx.customerBranchLink.upsert({
        where: { customerId_branchId: { customerId: primaryId, branchId: l.branchId } },
        create: { customerId: primaryId, branchId: l.branchId, firstSeenAt: l.firstSeenAt },
        update: {},
      });
    }
    await tx.customerBranchLink.deleteMany({ where: { customerId: duplicateId } });
    if (dupLinks.length) moved.customerBranchLink = dupLinks.length;

    const dupTags = await tx.customerTag.findMany({ where: { customerId: duplicateId } });
    for (const t of dupTags) {
      await tx.customerTag.upsert({
        where: { customerId_tagId: { customerId: primaryId, tagId: t.tagId } },
        create: { customerId: primaryId, tagId: t.tagId },
        update: {},
      });
    }
    await tx.customerTag.deleteMany({ where: { customerId: duplicateId } });

    // F19: khách do hồ sơ trùng giới thiệu chuyển sang hồ sơ giữ lại; thưởng giới
    // thiệu của hồ sơ trùng (với tư cách người được giới thiệu) chỉ chuyển khi hồ sơ
    // giữ lại chưa có, để không phát thưởng hai lần.
    moved.referredCustomers = (await tx.customer.updateMany({ where: { referredById: duplicateId }, data: { referredById: primaryId } })).count;
    moved.referralRewardsAsReferrer = (await tx.referralReward.updateMany({ where: { referrerId: duplicateId }, data: { referrerId: primaryId } })).count;
    const [pReward, dReward] = await Promise.all([
      tx.referralReward.findUnique({ where: { customerId: primaryId } }),
      tx.referralReward.findUnique({ where: { customerId: duplicateId } }),
    ]);
    if (dReward && !pReward) {
      await tx.referralReward.update({ where: { id: dReward.id }, data: { customerId: primaryId } });
      moved.referralReward = 1;
    }
    for (const k of ["referredCustomers", "referralRewardsAsReferrer"]) if (!moved[k]) delete moved[k];

    // Lead gốc: convertedCustomerId là duy nhất, chỉ chuyển khi hồ sơ giữ lại chưa có.
    if (dup.leadOrigin && !primary.leadOrigin) {
      await tx.lead.update({ where: { id: dup.leadOrigin.id }, data: { convertedCustomerId: primaryId } });
      moved.lead = 1;
    }

    // Điền các ô còn trống của hồ sơ giữ lại bằng dữ liệu hồ sơ trùng.
    const fill: Prisma.CustomerUncheckedUpdateInput = {};
    const filledFields: string[] = [];
    const fillable = [
      "phone",
      "email",
      "dob",
      "gender",
      "address",
      "city",
      "channelId",
      "campaignId",
      "budgetNote",
      "assignedToId",
      "telesaleId",
      "referredById",
      "referredAt",
    ] as const;
    for (const f of fillable) {
      if ((primary[f] === null || primary[f] === undefined) && dup[f] != null) {
        (fill as Record<string, unknown>)[f] = dup[f];
        filledFields.push(f);
      }
    }
    const interests = [...new Set([...parseArray(primary.interest), ...parseArray(dup.interest)])];
    if (interests.length !== parseArray(primary.interest).length) {
      fill.interest = JSON.stringify(interests);
      filledFields.push("interest");
    }
    if (dup.note && dup.note !== primary.note) {
      fill.note = [primary.note, `[Từ hồ sơ ${dup.code}] ${dup.note}`].filter(Boolean).join("\n");
      filledFields.push("note");
    }
    if (dup.lastContactAt && (!primary.lastContactAt || dup.lastContactAt > primary.lastContactAt)) {
      fill.lastContactAt = dup.lastContactAt;
    }
    const takeZalo = !primary.zaloUserId && dup.zaloUserId;
    if (fill.referredById === primaryId) {
      delete fill.referredById;
      delete fill.referredAt;
    }
    const takeReferralCode = !primary.referralCode && dup.referralCode;

    // zaloUserId là duy nhất: gỡ khỏi hồ sơ trùng trước rồi mới gán cho hồ sơ giữ lại.
    await tx.customer.update({
      where: { id: duplicateId },
      data: {
        hidden: true,
        hiddenReason: `Đã gộp vào ${primary.code}. Lý do: ${reason}`,
        mergedIntoId: primaryId,
        zaloUserId: null,
        referralCode: null,
      },
    });
    await tx.customer.update({
      where: { id: primaryId },
      data: {
        ...fill,
        ...(takeZalo ? { zaloUserId: dup.zaloUserId } : {}),
        ...(takeReferralCode ? { referralCode: dup.referralCode } : {}),
        activities: {
          create: {
            type: ActivityType.SYSTEM,
            content: `${actor.name} gộp hồ sơ trùng ${dup.code} (${dup.name}) vào hồ sơ này. Lý do: ${reason}`,
            userId: actor.id,
            userName: actor.name,
            meta: JSON.stringify({ mergedFrom: duplicateId, moved, filledFields }),
          },
        },
      },
    });

    if (moved.opportunity) await syncCustomerStage(primaryId, tx);

    return { primaryId, duplicateId, moved, filledFields };
  });
}
