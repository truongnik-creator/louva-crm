// F17: BẢNG BẬC LƯƠNG, THƯỞNG, % ADS. Hàm thuần (không đọc CSDL) để test biên.
//
// Mọi bảng bậc lưu trong Cài đặt dạng chữ "ngưỡng:giá trị,ngưỡng:giá trị" (xem
// validateTiers ở lib/settings-catalog.ts). Hai kiểu so ngưỡng khác nhau, theo
// đúng biên bản coaching:
//   - Lương cứng: "VƯỢT ngưỡng" (> 100 khách thì lên bậc 8 triệu, đúng 100 vẫn 7 triệu).
//   - Thưởng doanh số, % ads: "ĐẠT mốc" (>= 300 triệu thì nhận thưởng mốc 300).

export interface Tier {
  threshold: number;
  value: number;
}

export function parseTiers(raw: string): Tier[] {
  return raw
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const [t, v] = p.split(":").map((x) => Number(x.trim().replace(",", ".")));
      return { threshold: t, value: v };
    })
    .filter((t) => Number.isFinite(t.threshold) && Number.isFinite(t.value))
    .sort((a, b) => a.threshold - b.threshold);
}

/** Lương cứng: bậc cao nhất có số khách đến VƯỢT ngưỡng; không vượt bậc nào thì lương mặc định. */
export function baseSalaryFor(showups: number, defaultSalary: number, tiers: Tier[]): number {
  let salary = defaultSalary;
  for (const t of tiers) if (showups > t.threshold) salary = t.value;
  return Math.round(salary);
}

/** Bậc cao nhất có giá trị ĐẠT mốc (>=). null = chưa đạt mốc nào. */
export function reachedTier(amount: number, tiers: Tier[]): Tier | null {
  let hit: Tier | null = null;
  for (const t of tiers) if (amount >= t.threshold) hit = t;
  return hit;
}

/**
 * Thưởng doanh số.
 *  - MILESTONE: đạt mốc cao nhất nào nhận đúng số tiền của mốc đó (không cộng dồn).
 *  - PERCENT_TIER: % của bậc cao nhất đạt được nhân toàn bộ doanh thu.
 * `unitVnd` quy mốc ra đồng (mặc định 1 triệu).
 */
export function salesBonusFor(
  revenue: number,
  scheme: string,
  milestones: Tier[],
  percentTiers: Tier[],
  unitVnd: number
): { bonus: number; tier: Tier | null } {
  const inUnits = revenue / unitVnd;
  if (scheme === "PERCENT_TIER") {
    const tier = reachedTier(inUnits, percentTiers);
    return { bonus: tier ? Math.round((revenue * tier.value) / 100) : 0, tier };
  }
  const tier = reachedTier(inUnits, milestones);
  return { bonus: tier ? Math.round(tier.value) : 0, tier };
}

/** % cho người chạy ads: bậc cao nhất đạt được nhân toàn bộ doanh thu quảng cáo. */
export function adsBonusFor(adsRevenue: number, tiers: Tier[], unitVnd: number): { bonus: number; tier: Tier | null } {
  const tier = reachedTier(adsRevenue / unitVnd, tiers);
  return { bonus: tier ? Math.round((adsRevenue * tier.value) / 100) : 0, tier };
}

/** Phần trăm của một số tiền, làm tròn đồng. */
export function percentOf(amount: number, percent: number): number {
  return Math.round((amount * percent) / 100);
}
