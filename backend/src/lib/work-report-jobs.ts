import { registerJob } from "./jobs";
import { pullAllSources } from "./work-report-sync";

// F36: tác vụ nền cho chế độ KÉO.
//
// Chế độ ĐẨY không cần tác vụ nào — Apps Script tự bắn về khi nhân viên sửa
// bảng. Tác vụ này chỉ phục vụ những nguồn để ở chế độ kéo (trang tính chia sẻ
// công khai), chạy 30 phút một lần và chỉ kéo tháng này + tháng trước.

export const WORK_REPORT_PULL_JOB = "work-report-pull";

let registered = false;
export function registerWorkReportJobs(): void {
  if (registered) return;
  registered = true;

  registerJob({
    key: WORK_REPORT_PULL_JOB,
    label: "Báo cáo công việc: kéo trang tính công khai (30 phút)",
    intervalMs: 30 * 60_000,
    lockMs: 20 * 60_000,
    settingKey: "workReport.autoPull.enabled",
    run: async ({ now }) => {
      const r = await pullAllSources(now);
      if (!r.sources) return { created: 0, message: "Không có nguồn nào ở chế độ kéo" };
      const note = `${r.sources} nguồn, ${r.entries} dòng việc`;
      return { created: r.entries, message: r.errors.length ? `${note}. Lỗi: ${r.errors.join(" | ")}` : note };
    },
  });
}
