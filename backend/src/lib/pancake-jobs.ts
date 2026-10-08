import { prisma } from "./prisma";
import { logger } from "./logger";
import { registerJob } from "./jobs";
import { syncPancakeConfig } from "../services/pancake-sync";
import { discoverPagesAndAgents, syncAllPancakeStats } from "../services/pancake-stats";

// F35: hai tác vụ nền chạy MỖI 10 PHÚT.
//
//   · pancake-pull-sync   — TỰ NHẬN TRANG MỚI rồi kéo hội thoại, tin nhắn về
//     hộp thư CRM (dự phòng cho webhook: webhook rớt thì vẫn không sót tin).
//   · pancake-agent-stats — kéo thống kê nhân viên (số tin đã xử lý, tốc độ
//     phản hồi) từ API thống kê của Pancake để dựng báo cáo hiệu suất.
//
// Hai tác vụ TÁCH RIÊNG có chủ ý: kéo hội thoại là phần nặng (mỗi hội thoại một
// lượt gọi lấy tin) và dễ gặp lỗi mạng; kéo thống kê chỉ một lượt gọi mỗi trang.
// Gộp lại thì một trang lỗi khi kéo tin sẽ kéo đổ luôn báo cáo hiệu suất.

export const PANCAKE_SYNC_JOB = "pancake-pull-sync";
export const PANCAKE_STATS_JOB = "pancake-agent-stats";

const TEN_MINUTES = 10 * 60_000;

/**
 * Tự nhận trang mới rồi kéo hội thoại, tin nhắn của mọi kết nối đang bật.
 *
 * VÌ SAO DÒ TRANG MỖI LƯỢT: phòng khám nối thêm kênh bên Pancake (một trang
 * Facebook mới, một tài khoản TikTok) thì CRM phải tự biết. Trước đây phải có
 * người vào Cài đặt bấm "Dò trang", mà không ai nghĩ ra là phải bấm — kênh mới
 * im lặng không về tin nào, cho tới khi có người thắc mắc sao thiếu trang.
 *
 * Chi phí: đúng MỘT lượt gọi GET /pages cho mỗi kết nối, mỗi 10 phút. Lượt gọi
 * đó cũng lấy luôn token riêng của trang mới và danh sách nhân viên, nên trang
 * vừa nối là kéo được tin ngay trong cùng lượt này.
 */
export async function runPancakePullSync(): Promise<{ created: number; message: string }> {
  const configs = await prisma.pancakeConfig.findMany({ where: { active: true }, select: { id: true, label: true } });
  if (!configs.length) return { created: 0, message: "Chưa có kết nối Pancake nào đang bật" };

  let conversations = 0;
  let messages = 0;
  let skipped = 0;
  let newPages = 0;
  let newAgents = 0;
  const errors: string[] = [];

  for (const c of configs) {
    // Dò trang trước khi kéo: trang mới nhận được trong lượt này là kéo luôn.
    try {
      const d = await discoverPagesAndAgents(c.id);
      newPages += d.created;
      if (d.created > 0) {
        newAgents += d.agents;
        logger.info({ configId: c.id, created: d.created, tokens: d.tokens }, "[pancake] tự nhận trang mới");
      }
      // Lỗi dò trang KHÔNG được chặn việc kéo tin của các trang đã có.
      errors.push(...d.errors.filter((e) => !e.includes("không trả nhân viên")).map((e) => `${c.label} (dò trang): ${e}`));
    } catch (err) {
      errors.push(`${c.label} (dò trang): ${err instanceof Error ? err.message : String(err)}`);
    }

    const r = await syncPancakeConfig(c.id);
    conversations += r.conversations;
    messages += r.messages;
    skipped += r.skipped;
    errors.push(...r.errors.map((e) => `${c.label}: ${e}`));
  }

  const parts = [`${conversations} hội thoại`, `${messages} tin mới`];
  if (newPages) parts.push(`TRANG MỚI: ${newPages}${newAgents ? ` (+${newAgents} nhân viên)` : ""}`);
  if (skipped) parts.push(`bỏ qua ${skipped} không đổi`);
  const note = parts.join(", ");
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
