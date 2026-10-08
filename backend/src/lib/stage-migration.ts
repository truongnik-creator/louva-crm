import { prisma } from "./prisma";
import { LEGACY_TO_INJECTION } from "./stages";
import { currentOpportunity, statusForStage } from "./opportunities";
import { AppointmentStatus, ClinicMode, DepositStatus, InjectionStage, LostReason, OpportunityStatus, StageSource } from "../types/enums";

// F1: chuyển khách đang ở bộ bước cũ (phẫu thuật) sang bộ 7 bước tiêm.
// Dùng bởi scripts/migrate-stages.ts và test. Idempotent: khách đã ở bước mới
// không bị đụng tới.

export interface StageMigrationPlan {
  total: number;
  byMapping: Record<string, number>;
}

export async function migrateLegacyStages(opts: { apply: boolean; batch?: number }): Promise<StageMigrationPlan> {
  const legacy = Object.keys(LEGACY_TO_INJECTION);
  const customers = await prisma.customer.findMany({
    where: { stage: { in: legacy } },
    select: { id: true, stage: true, lostReason: true },
  });
  // Lịch sắp tới đã cọc thì bước đúng là Lịch cọc, không phải Nhắn tin.
  const deposited = new Set(
    (
      await prisma.appointment.findMany({
        where: {
          customerId: { in: customers.map((c) => c.id) },
          depositStatus: DepositStatus.DA_COC,
          startAt: { gte: new Date() },
          status: { notIn: [AppointmentStatus.CANCELLED, AppointmentStatus.NO_SHOW] },
        },
        select: { customerId: true },
      })
    ).map((a) => a.customerId)
  );

  const byMapping: Record<string, number> = {};
  const plan = customers.map((c) => {
    let to: string = LEGACY_TO_INJECTION[c.stage];
    if (to === InjectionStage.NHAN_TIN && deposited.has(c.id)) to = InjectionStage.LICH_COC;
    byMapping[`${c.stage} → ${to}`] = (byMapping[`${c.stage} → ${to}`] ?? 0) + 1;
    return { ...c, to };
  });

  if (opts.apply) {
    const size = opts.batch ?? 200;
    for (let i = 0; i < plan.length; i += size) {
      const chunk = plan.slice(i, i + size);
      // Lô 8 · P6: cơ hội hiện tại của khách đổi bước theo, lịch sử gắn vào cơ hội đó.
      const oppOf = new Map<string, string>();
      for (const c of chunk) {
        const o = await currentOpportunity(c.id);
        if (o) oppOf.set(c.id, o.id);
      }
      await prisma.$transaction([
        ...chunk
          .filter((c) => oppOf.has(c.id))
          .map((c) => {
            const status = statusForStage(ClinicMode.INJECTION, c.to);
            return prisma.opportunity.update({
              where: { id: oppOf.get(c.id)! },
              data: {
                stage: c.to,
                status,
                lostReason: status === OpportunityStatus.LOST ? (c.lostReason ?? LostReason.KHAC) : null,
              },
            });
          }),
        ...chunk.map((c) =>
          prisma.customer.update({
            where: { id: c.id },
            data: {
              stage: c.to,
              ...(c.to === InjectionStage.MAT_KHACH && !c.lostReason ? { lostReason: LostReason.KHAC } : {}),
            },
          })
        ),
        prisma.stageHistory.createMany({
          data: chunk.map((c) => ({
            customerId: c.id,
            opportunityId: oppOf.get(c.id) ?? null,
            fromStage: c.stage,
            toStage: c.to,
            source: StageSource.MIGRATION,
            note: "Chuyển sang bộ 7 bước phòng khám tiêm",
          })),
        }),
      ]);
    }
  }
  return { total: plan.length, byMapping };
}
