import { prisma } from "./prisma";
import { logger } from "./logger";
import { REAL_MONEY } from "./report-scope";
import { LeadStage, PaymentType } from "../types/enums";

// F15: MỐC CỦA LEAD VÀ PHỄU MARKETING.
//
// Chỉ số tuần đo chi phí trên mỗi SĐT, mỗi khách đến, nên lead phải mang mốc:
//   hasPhoneAt  lần đầu có SĐT (lead nhập có SĐT, hoặc khách gắn với lead có SĐT)
//   showedUpAt  lần đầu khách của lead check-in
// Và lead chuyển thành khách (bằng nút Chuyển, gắn hội thoại có lead vào hồ sơ,
// hay gộp) đều phải lên WON, nếu không phễu marketing luôn báo 0 chốt.
//
// Một lead "thuộc" khách khi: lead.convertedCustomerId = khách, hoặc hội thoại
// của khách mang leadId (lead Pancake tạo từ quảng cáo).

async function leadIdsOfCustomer(customerId: string, extra: Array<string | null | undefined> = []): Promise<string[]> {
  const [converted, convs] = await Promise.all([
    prisma.lead.findMany({ where: { convertedCustomerId: customerId }, select: { id: true } }),
    prisma.conversation.findMany({ where: { customerId, leadId: { not: null } }, select: { leadId: true } }),
  ]);
  return [...new Set([...converted.map((l) => l.id), ...convs.map((c) => c.leadId!), ...extra.filter((x): x is string => Boolean(x))])];
}

/** Ghi mốc có SĐT cho lead (chỉ lần đầu). */
export async function noteLeadPhone(leadIds: string[], at: Date = new Date()): Promise<void> {
  if (!leadIds.length) return;
  await prisma.lead.updateMany({ where: { id: { in: leadIds }, hasPhoneAt: null }, data: { hasPhoneAt: at } });
}

/**
 * Đồng bộ các lead của một khách sau khi khách được tạo, gắn hội thoại, đổi SĐT:
 * mốc có SĐT, bước WON, lead gốc (convertedCustomerId), nguồn chiến dịch.
 */
export async function syncLeadsForCustomer(customerId: string, opts: { leadId?: string | null; at?: Date } = {}): Promise<void> {
  const at = opts.at ?? new Date();
  const ids = await leadIdsOfCustomer(customerId, [opts.leadId]);
  if (!ids.length) return;
  const customer = await prisma.customer.findUnique({
    where: { id: customerId },
    select: { id: true, phone: true, channelId: true, campaignId: true, leadOrigin: { select: { id: true } } },
  });
  if (!customer) return;
  const leads = await prisma.lead.findMany({
    where: { id: { in: ids } },
    select: { id: true, stage: true, phone: true, convertedCustomerId: true, channelId: true, campaignId: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });

  if (customer.phone) await noteLeadPhone(leads.map((l) => l.id), at);
  else await noteLeadPhone(leads.filter((l) => l.phone).map((l) => l.id), at);

  await prisma.lead.updateMany({
    where: { id: { in: leads.map((l) => l.id) }, stage: { notIn: [LeadStage.WON, LeadStage.SPAM] } },
    data: { stage: LeadStage.WON },
  });

  // Lead gốc của khách: convertedCustomerId là duy nhất, chỉ gán khi khách chưa có.
  if (!customer.leadOrigin) {
    const origin = leads.find((l) => !l.convertedCustomerId);
    if (origin) {
      await prisma.lead.update({ where: { id: origin.id }, data: { convertedCustomerId: customerId } }).catch((err) =>
        logger.warn({ err: err instanceof Error ? err.message : String(err) }, "[lead-funnel] không gán được lead gốc")
      );
    }
  }

  // Khách chưa có nguồn: lấy nguồn của lead sớm nhất (để doanh thu quy đúng chiến dịch).
  const src = leads.find((l) => l.campaignId || l.channelId);
  if (src && (!customer.campaignId || !customer.channelId)) {
    await prisma.customer.update({
      where: { id: customerId },
      data: {
        ...(!customer.campaignId && src.campaignId ? { campaignId: src.campaignId } : {}),
        ...(!customer.channelId && src.channelId ? { channelId: src.channelId } : {}),
      },
    });
  }
}

/** Khách check-in: mốc khách đến lần đầu cho các lead của khách. */
export async function noteShowUp(customerId: string, at: Date = new Date()): Promise<void> {
  const ids = await leadIdsOfCustomer(customerId);
  if (!ids.length) return;
  await prisma.lead.updateMany({ where: { id: { in: ids }, showedUpAt: null }, data: { showedUpAt: at } });
}

/** Bọc lỗi: mốc marketing hỏng không được làm hỏng nghiệp vụ chính (check-in, gắn hội thoại). */
export async function safely(label: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, `[lead-funnel] ${label} lỗi`);
  }
}

/** Tìm chiến dịch theo tên chiến dịch quảng cáo (mã, utm_campaign hoặc tên, không phân biệt hoa thường). */
export async function findCampaignByAdName(name: string | null | undefined): Promise<{ id: string; channelId: string | null } | null> {
  const n = name?.trim();
  if (!n) return null;
  const all = await prisma.campaign.findMany({ select: { id: true, code: true, name: true, utmCampaign: true, channelId: true } });
  const low = n.toLowerCase();
  const hit = all.find(
    (c) => c.code.toLowerCase() === low || c.name.toLowerCase() === low || (c.utmCampaign ?? "").toLowerCase() === low
  );
  return hit ? { id: hit.id, channelId: hit.channelId } : null;
}

/** F32: mốc mua đầu = phiếu thu tiền thật dương sớm nhất (không tính hoàn tiền, voucher). */
export async function refreshFirstPurchaseAt(customerId: string): Promise<void> {
  const first = await prisma.payment.findFirst({
    where: { customerId, amount: { gt: 0 }, type: { not: PaymentType.REFUND }, ...REAL_MONEY },
    orderBy: { paidAt: "asc" },
    select: { paidAt: true },
  });
  await prisma.customer.update({ where: { id: customerId }, data: { firstPurchaseAt: first?.paidAt ?? null } });
}
