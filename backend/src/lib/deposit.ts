import type { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { getSettingRaw } from "./settings-catalog";
import { withCode, CodePrefix } from "./codes";
import { buildVietQrUrl, isBankConfigured, type BankAccount } from "./vietqr";
import { DepositStatus, PaymentType } from "../types/enums";

// F25 + F12: cọc gắn với lịch hẹn.
//
// Tiền cọc là một phiếu thu loại DEPOSIT gắn appointmentId, tính vào thực thu
// NGAY ngày nhận cọc. Khi khách thanh toán dịch vụ, phiếu cọc chưa trừ được
// "chuyển" sang hoá đơn/hợp đồng (gắn invoiceId/contractId + depositAppliedAt)
// nên công nợ giảm đúng số cọc mà thực thu không bị đếm hai lần.

/** Tài khoản nhận cọc: của cơ sở nếu khai riêng, không thì theo Cài đặt hệ thống. */
export async function resolveBankAccount(branchId: string | null | undefined): Promise<BankAccount | null> {
  const branch = branchId
    ? await prisma.branch.findUnique({
        where: { id: branchId },
        select: { bankBin: true, bankAccountNo: true, bankAccountName: true },
      })
    : null;
  if (branch && isBankConfigured({ bin: branch.bankBin ?? "", accountNo: branch.bankAccountNo ?? "" })) {
    return { bin: branch.bankBin!, accountNo: branch.bankAccountNo!, accountName: branch.bankAccountName ?? "" };
  }
  const bank = {
    bin: (await getSettingRaw("deposit.bankBin")).trim(),
    accountNo: (await getSettingRaw("deposit.bankAccountNo")).trim(),
    accountName: (await getSettingRaw("deposit.bankAccountName")).trim(),
  };
  return isBankConfigured(bank) ? bank : null;
}

/** Lịch cũ chưa có mã thì cấp mã LH-YYMM-NNNN ngay lúc cần. */
export async function ensureAppointmentCode(appointmentId: string): Promise<string> {
  const appt = await prisma.appointment.findUniqueOrThrow({ where: { id: appointmentId }, select: { code: true } });
  if (appt.code) return appt.code;
  const updated = await withCode(CodePrefix.APPOINTMENT, (code) =>
    prisma.appointment.update({ where: { id: appointmentId }, data: { code }, select: { code: true } })
  );
  return updated.code!;
}

export async function depositQr(appointmentId: string) {
  const appt = await prisma.appointment.findUniqueOrThrow({ where: { id: appointmentId } });
  const code = await ensureAppointmentCode(appointmentId);
  const bank = await resolveBankAccount(appt.branchId);
  const template = await getSettingRaw("deposit.qrTemplate");
  return {
    appointmentId,
    code,
    amount: appt.depositAmount,
    depositStatus: appt.depositStatus,
    bankConfigured: Boolean(bank),
    bank: bank ? { bin: bank.bin, accountNo: bank.accountNo, accountName: bank.accountName } : null,
    url: bank && appt.depositAmount > 0 ? buildVietQrUrl({ bank, amount: appt.depositAmount, addInfo: code, template }) : null,
  };
}

/** Phiếu cọc đã nhận, chưa hoàn, chưa trừ vào thanh toán nào của khách. */
export async function openDeposits(
  tx: Prisma.TransactionClient,
  customerId: string,
  appointmentId?: string | null
) {
  return tx.payment.findMany({
    where: {
      customerId,
      type: PaymentType.DEPOSIT,
      depositAppliedAt: null,
      appointment: { depositStatus: DepositStatus.DA_COC },
      ...(appointmentId ? { appointmentId } : {}),
    },
    orderBy: { paidAt: "asc" },
  });
}

/** Chọn phiếu cọc trừ được trong trần `cap` (không chia nhỏ phiếu). Dùng chung cho kiểm tra và ghi. */
export function planDeposits<T extends { amount: number }>(deposits: T[], cap: number | null): { picked: T[]; total: number } {
  const picked: T[] = [];
  let total = 0;
  for (const d of deposits) {
    if (cap !== null && total + d.amount > cap) continue;
    picked.push(d);
    total += d.amount;
  }
  return { picked, total };
}

/**
 * Trừ cọc vào hoá đơn/hợp đồng. Trả về tổng tiền cọc đã trừ. Chỉ trừ tối đa
 * phần còn lại của hoá đơn (`cap`); phiếu cọc lớn hơn phần còn lại thì để dành
 * cho lần sau (không chia nhỏ phiếu thu: chứng từ phải giữ nguyên số).
 */
export async function applyDeposits(
  tx: Prisma.TransactionClient,
  opts: { customerId: string; appointmentId?: string | null; invoiceId?: string | null; contractId?: string | null; cap: number | null }
): Promise<{ applied: number; paymentIds: string[] }> {
  const { picked } = planDeposits(await openDeposits(tx, opts.customerId, opts.appointmentId), opts.cap);
  let applied = 0;
  const paymentIds: string[] = [];
  for (const d of picked) {
    await tx.payment.update({
      where: { id: d.id },
      data: {
        depositAppliedAt: new Date(),
        ...(opts.invoiceId ? { invoiceId: opts.invoiceId } : {}),
        ...(opts.contractId ? { contractId: opts.contractId } : {}),
      },
    });
    applied += d.amount;
    paymentIds.push(d.id);
  }
  return { applied, paymentIds };
}
