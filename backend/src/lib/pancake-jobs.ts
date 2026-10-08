import { prisma } from "./prisma";
import { registerJob } from "./jobs";
import { syncPancakeConfig } from "../services/pancake-sync";
import { syncAllPancakeStats } from "../services/pancake-stats";

// F35: hai tác vụ nền chạy MỖI 10 PHÚT.
//
//   · pancake-pull-sync   — kéo hội thoại, tin nhắn về hộp thư CRM (dự phòng
//     cho webhook: webhook rớt thì vẫn không sót tin của khách).
//   · pancake-agent-stats — kéo thống kê nhân viên (số tin đã xử lý, tốc độ
//     phản hồi) từ API thống kê của Pancake để dựng báo cáo hiệu suất.
//
// Hai tác vụ TÁCH RIÊNG có chủ ý: kéo hội thoại là phần nặng (mỗi hội thoại một
// lượt gọi lấy tin) và dễ gặp lỗi mạng; kéo thống kê chỉ một lượt gọi mỗi trang.
// Gộp lại thì một trang lỗi khi kéo tin sẽ kéo đổ luôn báo cáo hiệu suất.

export const PANCAKE_SYNC_JOB = "pancake-pull-sync";
export const PANCAKE_STATS_JOB = "pancake-agent-stats";

const TEN_MINUTES = 10 * 60_000;

/** Kéo hội thoại, tin nhắn của mọi kết nối đang bật. */
export async function runPancakePullSync(): Promise<{ created: number; message: string }> {
  const configs = await prisma.pancakeConfig.findMany({ where: { active: true }, select: { id: true, label: true } });
  if (!configs.length) return { created: 0, message: "Chưa có kết nối Pancake nào đang bật" };

  let conversations = 0;
  let messages = 0;
  let skipped = 0;
  const errors: string[] = [];
  for (const c of configs) {
    const r = await syncPancakeConfig(c.id);
    conversations += r.conversations;
    messages += r.messages;
    skipped += r.skipped;
    errors.push(...r.errors.map((e) => `${c.label}: ${e}`));
  }
  const note = `${conversations} hội thoại, ${messages} tin mới${skipped ? `, bỏ qua ${skipped} không đổi` : ""}`;
  return { created: messages, message: errors.length ? `${note}. Lỗi: ${errors.join(" | ")}` : note };
}

/** Kéo thống kê nhân viên của mọi kết nối đang bật. */
export async function runPancakeStatsSync(now: Date): Promise<{ created: number; message: string }> {
  const r = await syncAllPancakeStats(now);
  const note = `${r.pages} trang, ${r.buckets} ô số liệu, ${r.agents} nhân viên`;
  return { created: r.buckets, message: r.errors.length ? `${note}. Lỗi: ${r.errors.join(" | ")}` : note };
}

let registered = false;
export function registerPancakeJobs(): void {
  if (registered) return;
  registered = true;

  registerJob({
    key: PANCAKE_SYNC_JOB,
    label: "Pancake: kéo hội thoại và tin nhắn (10 phút)",
    intervalMs: TEN_MINUTES,
    // Kéo tin có thể chạy lâu khi nhiều trang; giữ khoá rộng hơn chu kỳ.
    lockMs: 20 * 60_000,
    settingKey: "pancake.autoSync.enabled",
    run: () => runPancakePullSync(),
  });

  registerJob({
    key: PANCAKE_STATS_JOB,
    label: "Pancake: kéo thống kê hiệu suất nhân viên (10 phút)",
    intervalMs: TEN_MINUTES,
    lockMs: 15 * 60_000,
    settingKey: "pancake.statsSync.enabled",
    run: ({ now }) => runPancakeStatsSync(now),
  });
}
