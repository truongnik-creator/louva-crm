import { stageRank, stagesFor } from "./stages";
import { wonStagesFor } from "./opportunities";
import { ClinicMode } from "../types/enums";

// Lô 8 · J2, V4, V7: LUẬT TÍNH BÁO CÁO CRM 360 (hàm thuần, test được không cần CSDL).
//
// Mọi số đọc từ dữ liệu thật: lịch sử bước (StageHistory), hợp đồng đã ký chưa huỷ.
// Không có dữ liệu thì trả null, giao diện hiện "–" hoặc "chưa đủ dữ liệu".

const DAY_MS = 86_400_000;

export interface HistoryRow {
  /** Cơ hội (hoặc khách với dòng cũ chưa gắn cơ hội). */
  key: string;
  fromStage: string | null;
  toStage: string;
  createdAt: Date;
}

function groupRows(rows: HistoryRow[]): Map<string, HistoryRow[]> {
  const sorted = [...rows].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const out = new Map<string, HistoryRow[]>();
  for (const r of sorted) {
    const list = out.get(r.key) ?? [];
    list.push(r);
    out.set(r.key, list);
  }
  return out;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

// ================================================================ J2 HÀNH TRÌNH

export interface JourneyStageStat {
  stage: string;
  /** Số lượt vào bước trong kỳ. */
  entered: number;
  /** Số lượt đã rời bước (có dòng lịch sử kế tiếp), dùng tính thời gian TB. */
  completed: number;
  /** Số ngày trung bình ở bước (một chữ số thập phân); null khi chưa ai rời bước. */
  avgDays: number | null;
  /** Số lượt rơi (mất khách) ngay từ bước này. */
  dropped: number;
}

export interface JourneySummary {
  stages: JourneyStageStat[];
  units: number;
  lost: number;
  /** Bước rơi nhiều nhất; null khi chưa có lượt rơi nào. */
  topDrop: { stage: string; dropped: number } | null;
}

/**
 * J2: thời gian trung bình ở mỗi bước và bước rơi nhiều nhất. Một lượt ở bước S =
 * một dòng lịch sử vào S trong kỳ [from, to); thời gian ở bước = tới dòng kế tiếp
 * của cùng cơ hội (lượt chưa rời bước không tính vào trung bình). Rơi = dòng sang
 * bước mất khách, tính cho bước trước đó (fromStage, không có thì dòng trước).
 */
export function journeySummary(rows: HistoryRow[], mode: ClinicMode, range: { from: Date; to: Date }): JourneySummary {
  const stages = stagesFor(mode);
  const lostKey = stages.find((s) => s.lost)?.key;
  const acc = new Map<string, { entered: number; completed: number; totalMs: number; dropped: number }>();
  for (const s of stages) if (!s.lost) acc.set(s.key, { entered: 0, completed: 0, totalMs: 0, dropped: 0 });
  const units = new Set<string>();
  let lost = 0;
  for (const [key, list] of groupRows(rows)) {
    list.forEach((r, i) => {
      const inRange = r.createdAt >= range.from && r.createdAt < range.to;
      if (!inRange) return;
      units.add(key);
      if (r.toStage === lostKey) {
        lost++;
        const from = r.fromStage ?? list[i - 1]?.toStage ?? null;
        const a = from ? acc.get(from) : undefined;
        if (a) a.dropped++;
        return;
      }
      const a = acc.get(r.toStage);
      if (!a) return;
      a.entered++;
      const next = list[i + 1];
      if (next) {
        a.completed++;
        a.totalMs += next.createdAt.getTime() - r.createdAt.getTime();
      }
    });
  }
  const out: JourneyStageStat[] = [...acc.entries()].map(([stage, a]) => ({
    stage,
    entered: a.entered,
    completed: a.completed,
    avgDays: a.completed ? round1(a.totalMs / a.completed / DAY_MS) : null,
    dropped: a.dropped,
  }));
  const top = out.filter((s) => s.dropped > 0).sort((a, b) => b.dropped - a.dropped || stageRank(mode, a.stage) - stageRank(mode, b.stage))[0];
  return { stages: out, units: units.size, lost, topDrop: top ? { stage: top.stage, dropped: top.dropped } : null };
}

/** J2 theo nhóm (sale, kênh, dịch vụ, cơ sở): mỗi cơ hội thuộc một nhóm. */
export function journeyByGroup(
  rows: HistoryRow[],
  groupOf: (key: string) => string | null,
  mode: ClinicMode,
  range: { from: Date; to: Date }
): Array<{ group: string | null; summary: JourneySummary }> {
  const buckets = new Map<string | null, HistoryRow[]>();
  for (const r of rows) {
    const g = groupOf(r.key);
    buckets.set(g, [...(buckets.get(g) ?? []), r]);
  }
  return [...buckets.entries()]
    .map(([group, list]) => ({ group, summary: journeySummary(list, mode, range) }))
    .filter((g) => g.summary.units > 0)
    .sort((a, b) => b.summary.units - a.summary.units);
}

// ================================================================ V4 GIÁ TRỊ ĐƠN TB

export interface AovContract {
  id: string;
  total: number;
  hasUpsell: boolean;
  dims: Record<string, string | null>;
}

export interface AovRow {
  key: string | null;
  orders: number;
  revenue: number;
  /** Giá trị đơn trung bình (đồng, làm tròn). */
  avg: number;
  withUpsell: number;
  /** 0..1 */
  upsellRate: number;
}

function aovOf(key: string | null, list: AovContract[]): AovRow {
  const revenue = list.reduce((s, c) => s + c.total, 0);
  const withUpsell = list.filter((c) => c.hasUpsell).length;
  return { key, orders: list.length, revenue, avg: list.length ? Math.round(revenue / list.length) : 0, withUpsell, upsellRate: list.length ? withUpsell / list.length : 0 };
}

/** V4: giá trị đơn trung bình và tỉ lệ đơn có bán kèm, tổng và theo từng chiều. Chỉ đo, không nối lương. */
export function aovReport(contracts: AovContract[], dims: string[]): { overall: AovRow; by: Record<string, AovRow[]> } {
  const by: Record<string, AovRow[]> = {};
  for (const d of dims) {
    const buckets = new Map<string | null, AovContract[]>();
    for (const c of contracts) {
      const k = c.dims[d] ?? null;
      buckets.set(k, [...(buckets.get(k) ?? []), c]);
    }
    by[d] = [...buckets.entries()].map(([k, list]) => aovOf(k, list)).sort((a, b) => b.revenue - a.revenue);
  }
  return { overall: aovOf(null, contracts), by };
}

// ================================================================ V7 DỰ BÁO

export interface StageProbability {
  stage: string;
  /** Số cơ hội vào bước trong khoảng lịch sử và đã có kết quả (thắng hoặc mất). */
  settled: number;
  won: number;
  /** null = chưa đủ dữ liệu (settled dưới ngưỡng mẫu). */
  probability: number | null;
}

/**
 * V7: xác suất thắng của một cơ hội đang ở bước S, đo từ lịch sử thật: trong các
 * cơ hội từng vào S và ĐÃ có kết quả sau đó (sang bước thắng hoặc mất khách), tỉ
 * lệ thắng. Cơ hội chưa có kết quả không tính (không kéo xác suất xuống sai).
 * Dưới ngưỡng mẫu thì null: không bao giờ đoán.
 */
export function stageProbabilities(rows: HistoryRow[], mode: ClinicMode, minSamples: number): Map<string, StageProbability> {
  const stages = stagesFor(mode);
  const lostKey = stages.find((s) => s.lost)?.key;
  const won = new Set(wonStagesFor(mode));
  const out = new Map<string, StageProbability>();
  const groups = [...groupRows(rows).values()];
  for (const st of stages) {
    if (st.lost || won.has(st.key)) continue;
    let settled = 0;
    let w = 0;
    for (const list of groups) {
      const idx = list.findIndex((r) => r.toStage === st.key);
      if (idx < 0) continue;
      const after = list.slice(idx + 1);
      // Kết quả cuối cùng sau khi vào bước: lần thắng hoặc mất gần nhất.
      const outcome = [...after].reverse().find((r) => won.has(r.toStage) || r.toStage === lostKey);
      if (!outcome) continue;
      settled++;
      if (won.has(outcome.toStage)) w++;
    }
    out.set(st.key, { stage: st.key, settled, won: w, probability: settled >= minSamples && settled > 0 ? w / settled : null });
  }
  return out;
}

export interface ForecastOpp {
  id: string;
  stage: string;
  value: number | null;
  ownerId: string | null;
  /** Tháng dự kiến chốt "YYYY-MM" (giờ VN); null = chưa có ngày dự kiến. */
  month: string | null;
}

export interface ForecastBucket {
  key: string | null;
  count: number;
  pipelineValue: number;
  /** Giá trị × xác suất, chỉ cộng cơ hội có xác suất. */
  weightedValue: number;
  /** Cơ hội ở bước chưa đủ dữ liệu (không cộng vào dự báo). */
  noDataCount: number;
  noDataValue: number;
}

function bucketOf(key: string | null, list: ForecastOpp[], prob: Map<string, StageProbability>): ForecastBucket {
  const b: ForecastBucket = { key, count: list.length, pipelineValue: 0, weightedValue: 0, noDataCount: 0, noDataValue: 0 };
  for (const o of list) {
    const v = o.value ?? 0;
    b.pipelineValue += v;
    const p = prob.get(o.stage)?.probability ?? null;
    if (p === null) {
      b.noDataCount++;
      b.noDataValue += v;
    } else b.weightedValue += v * p;
  }
  b.weightedValue = Math.round(b.weightedValue);
  return b;
}

/** V7: dự báo = giá trị × xác suất bước, tổng, theo tháng, theo sale. */
export function forecastReport(opps: ForecastOpp[], prob: Map<string, StageProbability>) {
  const group = (f: (o: ForecastOpp) => string | null) => {
    const m = new Map<string | null, ForecastOpp[]>();
    for (const o of opps) m.set(f(o), [...(m.get(f(o)) ?? []), o]);
    return [...m.entries()].map(([k, list]) => bucketOf(k, list, prob));
  };
  return {
    total: bucketOf(null, opps, prob),
    byMonth: group((o) => o.month).sort((a, b) => (a.key ?? "9999").localeCompare(b.key ?? "9999")),
    byOwner: group((o) => o.ownerId).sort((a, b) => b.weightedValue - a.weightedValue),
    byStage: group((o) => o.stage),
  };
}
