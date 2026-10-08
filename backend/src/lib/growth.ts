import crypto from "node:crypto";
import { prisma } from "./prisma";
import { logger } from "./logger";
import { getSettingBool, getSettingNumber, getSettingRaw } from "./settings-catalog";
import { markOnce, registerJob } from "./jobs";
import { notifyUsers } from "./notify";
import { withCode, CodePrefix } from "./codes";
import { formatVnd, startOfVnDay, vnDayKey } from "./datetime";
import { HttpError } from "../middleware/errorHandler";
import { DAY_MS, responsibleSaleOf, settingList, showupsBySale, vnMonthRange } from "./metrics";
import {
  ActivityType,
  ApprovalStatus,
  InvoiceStatus,
  PaymentMethod,
  PaymentType,
  ReferralRewardKind,
  ReferralRewardStatus,
  TaskKind,
  TaskPriority,
  TaskStatus,
  UserStatus,
  VoucherSource,
  VoucherStatus,
} from "../types/enums";

// ĐỢT 3 · TĂNG TRƯỞNG: giới thiệu khách (F19), voucher, quà, sinh nhật (F20),
// thi đua đơn giản (F18).

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // bỏ 0/O, 1/I dễ đọc nhầm

function randomCode(prefix: string, len = 6): string {
  let out = "";
  for (let i = 0; i < len; i++) out += CODE_ALPHABET[crypto.randomInt(0, CODE_ALPHABET.length)];
  return `${prefix}${out}`;
}

async function uniqueCode(prefix: string, exists: (code: string) => Promise<boolean>): Promise<string> {
  for (let i = 0; i < 20; i++) {
    const code = randomCode(prefix);
    if (!(await exists(code))) return code;
  }
  throw new Error("Không sinh được mã không trùng");
}

// ------------------------------------------------------------ F19 GIỚI THIỆU

/** Mã giới thiệu của khách (sinh lần đầu khi cần). */
export async function ensureReferralCode(customerId: string): Promise<string> {
  const c = await prisma.customer.findUnique({ where: { id: customerId }, select: { referralCode: true } });
  if (!c) throw new HttpError(404, "Không tìm thấy khách");
  if (c.referralCode) return c.referralCode;
  const code = await uniqueCode("GT", async (x) => Boolean(await prisma.customer.findUnique({ where: { referralCode: x }, select: { id: true } })));
  await prisma.customer.update({ where: { id: customerId }, data: { referralCode: code } });
  return code;
}

/** Gắn người giới thiệu cho khách mới (theo mã hoặc chọn khách). Không đổi được khi đã thưởng. */
export async function setReferrer(customerId: string, input: { code?: string; referrerId?: string }) {
  const customer = await prisma.customer.findUnique({ where: { id: customerId }, select: { id: true, name: true, referredById: true } });
  if (!customer) throw new HttpError(404, "Không tìm thấy khách");
  const referrer = input.code
    ? await prisma.customer.findUnique({ where: { referralCode: input.code.trim().toUpperCase() }, select: { id: true, name: true, code: true, mergedIntoId: true } })
    : input.referrerId
      ? await prisma.customer.findUnique({ where: { id: input.referrerId }, select: { id: true, name: true, code: true, mergedIntoId: true } })
      : null;
  if (!referrer || referrer.mergedIntoId) throw new HttpError(404, "Không tìm thấy người giới thiệu (mã sai hoặc hồ sơ đã gộp)");
  if (referrer.id === customerId) throw new HttpError(400, "Khách không tự giới thiệu chính mình được");
  const rewarded = await prisma.referralReward.findUnique({ where: { customerId } });
  if (rewarded) throw new HttpError(409, "Đã phát thưởng giới thiệu cho khách này, không đổi người giới thiệu được");
  await prisma.customer.update({ where: { id: customerId }, data: { referredById: referrer.id, referredAt: new Date() } });
  return referrer;
}

/**
 * Khách được giới thiệu làm xong dịch vụ: thưởng người giới thiệu MỘT lần duy
 * nhất (khoá duy nhất trên ReferralReward.customerId). Trả null khi không thưởng.
 */
export async function grantReferralReward(customerId: string, procedureId: string | null, now = new Date()) {
  if (!(await getSettingBool("referral.enabled"))) return null;
  const customer = await prisma.customer.findUnique({ where: { id: customerId }, select: { id: true, name: true, referredById: true } });
  if (!customer?.referredById) return null;
  if (await prisma.referralReward.findUnique({ where: { customerId } })) return null;
  const referrer = await prisma.customer.findUnique({
    where: { id: customer.referredById },
    select: { id: true, name: true, assignedToId: true, telesaleId: true },
  });
  if (!referrer) return null;

  const kind = (await getSettingRaw("referral.rewardKind")) === ReferralRewardKind.CASH ? ReferralRewardKind.CASH : ReferralRewardKind.VOUCHER;
  const amount = Math.max(0, Math.round(await getSettingNumber("referral.rewardAmount")));
  if (amount <= 0) return null;
  const validDays = Math.max(1, await getSettingNumber("referral.voucherValidDays"));

  try {
    const reward = await prisma.$transaction(async (tx) => {
      let voucherId: string | null = null;
      if (kind === ReferralRewardKind.VOUCHER) {
        const code = await uniqueCode("VC", async (x) => Boolean(await tx.voucher.findUnique({ where: { code: x }, select: { id: true } })));
        const v = await tx.voucher.create({
          data: {
            code,
            customerId: referrer.id,
            value: amount,
            expiresAt: new Date(startOfVnDay(now).getTime() + (validDays + 1) * DAY_MS),
            source: VoucherSource.REFERRAL,
            note: `Thưởng giới thiệu khách ${customer.name}`,
          },
        });
        voucherId = v.id;
      }
      const r = await tx.referralReward.create({
        data: {
          customerId,
          referrerId: referrer.id,
          procedureId,
          kind,
          amount,
          voucherId,
          status: kind === ReferralRewardKind.VOUCHER ? ReferralRewardStatus.ISSUED : ReferralRewardStatus.PENDING_PAYOUT,
        },
      });
      await tx.activity.create({
        data: {
          customerId: referrer.id,
          type: ActivityType.SYSTEM,
          content: `Thưởng giới thiệu khách ${customer.name}: ${kind === ReferralRewardKind.VOUCHER ? "voucher" : "tiền"} ${formatVnd(amount)}đ`,
        },
      });
      return r;
    });
    await notifyUsers([responsibleSaleOf(referrer)], {
      title: `Thưởng giới thiệu cho ${referrer.name}`,
      body: `Khách ${customer.name} đã làm dịch vụ. ${kind === ReferralRewardKind.VOUCHER ? "Đã phát voucher" : "Chờ kế toán chi tiền"} ${formatVnd(amount)}đ, báo cho khách giới thiệu.`,
      link: `/khach-hang/${referrer.id}`,
    });
    return reward;
  } catch (err) {
    const e = err as { code?: string };
    if (e?.code === "P2002") return null; // hai luồng cùng hoàn tất: chỉ một lần thưởng
    throw err;
  }
}

// ------------------------------------------------------------- F20 VOUCHER

export function voucherState(v: { status: string; expiresAt: Date }, now = new Date()): "ACTIVE" | "REDEEMED" | "CANCELLED" | "EXPIRED" {
  if (v.status === VoucherStatus.REDEEMED) return "REDEEMED";
  if (v.status === VoucherStatus.CANCELLED) return "CANCELLED";
  return v.expiresAt.getTime() <= now.getTime() ? "EXPIRED" : "ACTIVE";
}

export async function createVoucher(input: {
  customerId?: string | null;
  branchId?: string | null;
  value: number;
  expiresAt: Date;
  source?: string;
  note?: string | null;
  createdById?: string | null;
}) {
  const code = await uniqueCode("VC", async (x) => Boolean(await prisma.voucher.findUnique({ where: { code: x }, select: { id: true } })));
  return prisma.voucher.create({
    data: {
      code,
      customerId: input.customerId ?? null,
      branchId: input.branchId ?? null,
      value: input.value,
      expiresAt: input.expiresAt,
      source: input.source ?? VoucherSource.MANUAL,
      note: input.note ?? null,
      createdById: input.createdById ?? null,
    },
  });
}

/**
 * Dùng voucher khi thanh toán: lập phiếu thu phương thức VOUCHER (giảm công nợ
 * hoá đơn, hợp đồng; KHÔNG tính doanh thu đã thu). Voucher dùng một lần, giá trị
 * lớn hơn phần còn nợ thì phần dư không hoàn lại.
 */
export async function redeemVoucher(input: {
  code: string;
  customerId: string;
  invoiceId?: string;
  contractId?: string;
  branchId: string;
  actor: { id: string; name: string };
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const voucher = await prisma.voucher.findUnique({ where: { code: input.code.trim().toUpperCase() } });
  if (!voucher) throw new HttpError(404, "Không tìm thấy voucher");
  const state = voucherState(voucher, now);
  if (state === "EXPIRED") throw new HttpError(409, "Voucher đã hết hạn");
  if (state !== "ACTIVE") throw new HttpError(409, "Voucher đã dùng hoặc đã huỷ");
  if (voucher.customerId && voucher.customerId !== input.customerId) throw new HttpError(409, "Voucher thuộc khách khác");
  if (!input.invoiceId && !input.contractId) throw new HttpError(400, "Chọn hoá đơn hoặc hợp đồng để trừ voucher");

  const invoice = input.invoiceId ? await prisma.invoice.findUnique({ where: { id: input.invoiceId } }) : null;
  if (input.invoiceId && (!invoice || invoice.customerId !== input.customerId)) throw new HttpError(404, "Không tìm thấy hoá đơn của khách");
  const contractId = input.contractId ?? invoice?.contractId ?? null;
  const contract = contractId ? await prisma.contract.findUnique({ where: { id: contractId } }) : null;
  if (contractId && (!contract || contract.customerId !== input.customerId)) throw new HttpError(404, "Không tìm thấy hợp đồng của khách");

  const remaining = invoice ? invoice.amount - invoice.paidAmount : contract!.total - contract!.paidAmount;
  const amount = Math.min(voucher.value, remaining);
  if (amount <= 0) throw new HttpError(400, "Không còn khoản nợ để trừ voucher");

  return withCode(CodePrefix.PAYMENT, (code) =>
    prisma.$transaction(async (tx) => {
      // Giành voucher bằng câu UPDATE có điều kiện: hai quầy bấm cùng lúc chỉ một bên dùng được.
      const claimed = await tx.voucher.updateMany({
        where: { id: voucher.id, status: VoucherStatus.ACTIVE, expiresAt: { gt: now } },
        data: { status: VoucherStatus.REDEEMED, redeemedAt: now, redeemedById: input.actor.id },
      });
      if (claimed.count !== 1) throw new HttpError(409, "Voucher vừa được dùng ở nơi khác");
      const payment = await tx.payment.create({
        data: {
          code,
          branchId: input.branchId,
          customerId: input.customerId,
          invoiceId: invoice?.id ?? null,
          contractId,
          amount,
          method: PaymentMethod.VOUCHER,
          type: PaymentType.PAYMENT,
          reference: voucher.code,
          note: `Trừ voucher ${voucher.code}${amount < voucher.value ? ` (giá trị ${formatVnd(voucher.value)}đ, dùng ${formatVnd(amount)}đ)` : ""}`,
          paidAt: now,
          receivedById: input.actor.id,
        },
      });
      await tx.voucher.update({ where: { id: voucher.id }, data: { redeemedPaymentId: payment.id } });
      if (invoice) {
        const paid = invoice.paidAmount + amount;
        await tx.invoice.update({
          where: { id: invoice.id },
          data: { paidAmount: paid, status: paid >= invoice.amount ? InvoiceStatus.PAID : InvoiceStatus.PARTIAL },
        });
      }
      if (contractId) {
        const agg = await tx.payment.aggregate({ where: { contractId }, _sum: { amount: true } });
        await tx.contract.update({ where: { id: contractId }, data: { paidAmount: agg._sum.amount ?? 0 } });
      }
      await tx.activity.create({
        data: {
          customerId: input.customerId,
          type: ActivityType.PAYMENT,
          content: `Dùng voucher ${voucher.code}: trừ ${formatVnd(amount)}đ (phiếu ${code})`,
          userId: input.actor.id,
          userName: input.actor.name,
        },
      });
      return { payment, voucherId: voucher.id, amount };
    })
  );
}

// ----------------------------------------------------- F20 SINH NHẬT (TÁC VỤ)

export const BIRTHDAY_JOB = "birthday-reminder";

/** Tạo việc chúc sinh nhật cho sale phụ trách. Mỗi khách mỗi năm một lần. */
export async function ruleBirthday(now: Date): Promise<{ created: number }> {
  const lead = Math.max(0, await getSettingNumber("automation.birthday.leadDays"));
  const target = new Date(startOfVnDay(now).getTime() + lead * DAY_MS + 12 * 3_600_000);
  const targetKey = vnDayKey(target); // YYYY-MM-DD
  const [ty, tm, td] = targetKey.split("-").map(Number);
  const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

  const customers = await prisma.customer.findMany({
    where: { dob: { not: null }, hidden: false, mergedIntoId: null },
    select: { id: true, name: true, dob: true, assignedToId: true, telesaleId: true, branchLinks: { select: { branchId: true, isPrimary: true } } },
  });
  let created = 0;
  for (const c of customers) {
    const [, m, d] = vnDayKey(c.dob!).split("-").map(Number);
    // 29/2 năm không nhuận: nhắc ngày 28/2.
    const matches = (m === tm && d === td) || (m === 2 && d === 29 && !isLeap(ty) && tm === 2 && td === 28);
    if (!matches) continue;
    const assignee = responsibleSaleOf(c);
    if (!assignee) continue;
    if (!(await markOnce(BIRTHDAY_JOB, `${c.id}:${ty}`))) continue;
    await prisma.task.create({
      data: {
        branchId: (c.branchLinks.find((l) => l.isPrimary) ?? c.branchLinks[0])?.branchId ?? null,
        customerId: c.id,
        title: `Chúc mừng sinh nhật ${c.name} (${String(td).padStart(2, "0")}/${String(tm).padStart(2, "0")})`,
        description: "Nhắn chúc mừng sinh nhật khách. Có voucher sinh nhật thì gửi kèm mã.",
        status: TaskStatus.OPEN,
        priority: TaskPriority.NORMAL,
        dueAt: new Date(startOfVnDay(target).getTime() + 18 * 3_600_000),
        assigneeId: assignee,
        kind: TaskKind.BIRTHDAY,
        source: BIRTHDAY_JOB,
      },
    });
    created++;
  }
  return { created };
}

// ----------------------------------------------------------- F18 THI ĐUA

export interface LeaderRow {
  userId: string;
  name: string;
  showups: number;
  rank: number | null;
  disqualified: boolean;
  reasons: string[];
}

/** Bảng sale theo số khách đến trong tháng, kèm hai luật loại. */
export async function leaderboard(periodKey: string, branchIds: string[]): Promise<{
  target: number;
  actual: number;
  percent: number | null;
  rows: LeaderRow[];
}> {
  const range = vnMonthRange(periodKey);
  const salesRoles = await settingList("payroll.salesRoles");
  const [users, showups, badQuotes, flags] = await Promise.all([
    prisma.user.findMany({
      where: {
        status: UserStatus.ACTIVE,
        branches: { some: { branchId: { in: branchIds } } },
        roleLinks: { some: { role: { code: { in: salesRoles } } } },
      },
      select: { id: true, name: true, status: true },
    }),
    showupsBySale(range, branchIds),
    // Luật 1: báo giá có dòng giảm dưới giá niêm yết (ngoài đợt ưu đãi) mà không được duyệt.
    prisma.quotation.findMany({
      where: {
        branchId: { in: branchIds },
        createdAt: range,
        approvalStatus: { not: ApprovalStatus.APPROVED },
        items: { some: { discountAmount: { gt: 0 } } },
      },
      select: { code: true, createdById: true, items: { select: { discountAmount: true, promotionDiscount: true } } },
    }),
    // Luật 2: quản lý gắn cờ vi phạm chuyên môn trong tháng.
    prisma.staffViolationFlag.findMany({ where: { periodKey, revokedAt: null }, select: { userId: true, reason: true } }),
  ]);

  const reasons = new Map<string, string[]>();
  const add = (userId: string | null, r: string) => {
    if (!userId) return;
    reasons.set(userId, [...(reasons.get(userId) ?? []), r]);
  };
  for (const q of badQuotes) {
    if (q.items.some((i) => i.discountAmount - i.promotionDiscount > 0)) add(q.createdById, `Báo giá ${q.code} dưới giá niêm yết chưa được duyệt`);
  }
  for (const f of flags) add(f.userId, `Vi phạm chuyên môn: ${f.reason}`);

  const rows: LeaderRow[] = users
    .map((u) => ({
      userId: u.id,
      name: u.name,
      showups: showups.get(u.id) ?? 0,
      rank: null as number | null,
      disqualified: reasons.has(u.id),
      reasons: reasons.get(u.id) ?? [],
    }))
    .sort((a, b) => Number(a.disqualified) - Number(b.disqualified) || b.showups - a.showups || a.name.localeCompare(b.name));
  let rank = 0;
  let prev: number | null = null;
  let i = 0;
  for (const r of rows) {
    if (r.disqualified) continue;
    i++;
    if (prev === null || r.showups !== prev) rank = i;
    r.rank = rank;
    prev = r.showups;
  }

  const target = Math.max(0, Math.round(await getSettingNumber("contest.monthlyShowupTarget")));
  const actual = [...showups.values()].reduce((s, n) => s + n, 0);
  return { target, actual, percent: target > 0 ? Math.round((actual / target) * 1000) / 10 : null, rows };
}

// --------------------------------------------------------- ĐĂNG KÝ TÁC VỤ

let registered = false;
export function registerGrowthJobs(): void {
  if (registered) return;
  registered = true;
  registerJob({
    key: BIRTHDAY_JOB,
    label: "Nhắc sale chúc mừng sinh nhật khách",
    intervalMs: 60 * 60_000,
    settingKey: "automation.birthday.enabled",
    run: ({ now }) => ruleBirthday(now),
  });
}

export function logGrowthError(label: string, err: unknown): void {
  logger.warn({ err: err instanceof Error ? err.message : String(err) }, `[growth] ${label}`);
}
