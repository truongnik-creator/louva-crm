import http from "http";
import { env } from "./lib/env";
import { bootstrap } from "./lib/bootstrap";
import { initSocket } from "./socket";
import { logger } from "./lib/logger";
import { createApp } from "./app";
import { startJobScheduler } from "./lib/jobs";
import { registerAutomationJobs } from "./lib/automation";
import { registerGrowthJobs } from "./lib/growth";
import { registerScoringJob } from "./lib/conversation-scoring";
import { registerReengageJob } from "./lib/reengage";
import { registerBriefingJob } from "./lib/briefing";

async function main() {
  // Zero-setup: tạo/áp migration, sinh danh mục quyền + vai trò, tạo tài khoản
  // quản trị lần đầu. Thoát hẳn nếu hỏng thay vì phục vụ trên CSDL sai.
  await bootstrap();

  const app = createApp();
  const httpServer = http.createServer(app);
  initSocket(httpServer);

  // F8: bộ chạy tác vụ nền trong tiến trình (8 quy tắc tự động, hàng đợi gửi tin).
  registerAutomationJobs();
  registerGrowthJobs();
  registerScoringJob();
  registerReengageJob();
  registerBriefingJob();
  if (process.env.DISABLE_JOBS !== "1") startJobScheduler();

  httpServer.listen(env.port, () => {
    logger.info({ port: env.port, cors: env.corsOrigins }, `CRM backend đang chạy ở cổng ${env.port}`);
  });
}

main().catch((err) => {
  logger.fatal({ err }, "Lỗi nghiêm trọng khi khởi động");
  process.exit(1);
});
