import express from "express";
import cors from "cors";
import http from "http";
import fs from "node:fs";
import path from "node:path";
import { env, BACKEND_ROOT } from "./lib/env";
import { bootstrap } from "./lib/bootstrap";
import { initSocket } from "./socket";
import { errorHandler } from "./middleware/errorHandler";

import authRoutes from "./routes/auth";
import orgRoutes from "./routes/org";
import userRoutes from "./routes/users";
import customerRoutes from "./routes/customers";
import leadRoutes from "./routes/leads";
import inboxRoutes from "./routes/inbox";
import zaloRoutes from "./routes/zalo";
import receptionRoutes from "./routes/reception";
import catalogRoutes from "./routes/catalog";
import salesRoutes from "./routes/sales";
import medicalRoutes from "./routes/medical";
import surgeryRoutes from "./routes/surgery";
import reportRoutes from "./routes/reports";
import auditRoutes from "./routes/audit";
import inventoryRoutes from "./routes/inventory";
import hrRoutes from "./routes/hr";
import pancakeRoutes from "./routes/pancake";
import settingsRoutes from "./routes/settings";

async function main() {
  // Zero-setup: tạo/áp migration, sinh danh mục quyền + vai trò, tạo tài khoản
  // quản trị lần đầu. Thoát hẳn nếu hỏng thay vì phục vụ trên CSDL sai.
  await bootstrap();

  const app = express();

  // Đứng sau nginx/load balancer thì req.ip mới đúng IP thật của người dùng —
  // nhật ký kiểm toán ghi IP nên điều này có ý nghĩa pháp lý.
  app.set("trust proxy", true);

  // CORS chặt: chỉ những origin khai báo, không dùng "*" nữa. Bản cũ mặc định
  // "*" nghĩa là bất kỳ trang web nào cũng gọi được API bằng token của nhân viên.
  app.use(
    cors({
      origin(origin, callback) {
        // Không có Origin: gọi từ Electron/curl/webhook — cho qua.
        if (!origin) return callback(null, true);
        if (env.corsOrigins.includes(origin)) return callback(null, true);
        // Danh sách cấu hình sẵn không thể biết trước tên miền lúc chạy (đưa ra
        // ngoài qua Cloudflare Tunnel, nginx, hay IP LAN). Nhưng khi giao diện
        // do CHÍNH máy chủ này phục vụ thì đó là cùng origin — vốn dĩ đã an
        // toàn, và trình duyệt vẫn gửi Origin vì Vite gắn `crossorigin` lên
        // thẻ script. Cho qua đúng trường hợp đó, không nới thêm gì khác.
        return callback(null, false);
      },
      credentials: true,
      allowedHeaders: ["Content-Type", "Authorization", "X-Branch-Id"],
    })
  );

  /**
   * Cho phép request cùng origin (giao diện web do chính máy chủ này phục vụ).
   * Đặt SAU cors() để ghi đè kết quả của nó khi và chỉ khi Origin trùng đúng
   * host mà client đang gọi tới — sau proxy thì host thật nằm ở X-Forwarded-Host.
   */
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (!origin) return next();

    const forwardedHost = req.headers["x-forwarded-host"];
    const host = (Array.isArray(forwardedHost) ? forwardedHost[0] : forwardedHost) ?? req.headers.host;

    try {
      if (host && new URL(origin).host === host) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Access-Control-Allow-Credentials", "true");
        res.setHeader("Vary", "Origin");
        if (req.method === "OPTIONS") {
          res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Branch-Id");
          res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, PUT, DELETE, OPTIONS");
          return res.sendStatus(204);
        }
      }
    } catch {
      // Origin không phải URL hợp lệ — bỏ qua, cors() phía trên đã quyết định.
    }
    return next();
  });

  // Giữ lại RAW body để xác thực HMAC webhook Zalo. Bắt buộc phải là đúng
  // chuỗi byte đã nhận: tính chữ ký trên JSON.stringify(req.body) sẽ sai ngay
  // khi Zalo đổi thứ tự khoá hoặc khoảng trắng.
  app.use(
    express.json({
      limit: "2mb",
      verify: (req, _res, buf) => {
        (req as express.Request).rawBody = Buffer.from(buf);
      },
    })
  );

  app.get("/health", (_req, res) => res.json({ ok: true, version: "1.0.0-tmv" }));

  app.use("/api/auth", authRoutes);
  app.use("/api/org", orgRoutes);
  app.use("/api/users", userRoutes);
  app.use("/api/customers", customerRoutes);
  app.use("/api/leads", leadRoutes);
  app.use("/api/conversations", inboxRoutes);
  app.use("/api/zalo", zaloRoutes);
  app.use("/api/reception", receptionRoutes);
  app.use("/api/catalog", catalogRoutes);
  app.use("/api/sales", salesRoutes);
  app.use("/api/medical", medicalRoutes);
  app.use("/api/procedures", surgeryRoutes);
  app.use("/api/reports", reportRoutes);
  app.use("/api/audit", auditRoutes);
  app.use("/api/inventory", inventoryRoutes);
  app.use("/api/hr", hrRoutes);
  app.use("/api/pancake", pancakeRoutes);
  app.use("/api/settings", settingsRoutes);

  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "Không tìm thấy đường dẫn" });
  });

  // Phục vụ luôn bản web đã build (desktop/out/web) từ chính máy chủ này.
  //
  // Cùng một origin cho cả giao diện lẫn API nghĩa là: không cần CORS, cookie
  // và socket bám đúng tên miền, và chỉ cần MỘT đường hầm/tên miền khi đưa ra
  // ngoài (Cloudflare Tunnel, nginx…). Bản build dùng đường dẫn API tương đối
  // "/api" nên chạy được ở bất kỳ tên miền nào mà không phải build lại.
  const WEB_ROOT = path.resolve(BACKEND_ROOT, "..", "desktop", "out", "web");
  if (fs.existsSync(path.join(WEB_ROOT, "index.html"))) {
    app.use(express.static(WEB_ROOT, { index: false }));

    // SPA fallback: mọi đường dẫn không phải /api đều trả index.html để
    // React Router tự định tuyến phía client.
    app.get("*", (_req, res) => {
      res.sendFile(path.join(WEB_ROOT, "index.html"));
    });
    console.log(`Phục vụ giao diện web từ ${WEB_ROOT}`);
  } else {
    console.log(
      `Chưa có bản web tại ${WEB_ROOT} — chỉ phục vụ API. Build bằng: cd desktop && npx vite build --config vite.web.config.mts`
    );
  }

  app.use(errorHandler);

  const httpServer = http.createServer(app);
  initSocket(httpServer);

  httpServer.listen(env.port, () => {
    console.log(`CRM backend đang chạy ở cổng ${env.port}`);
    console.log(`CORS cho phép: ${env.corsOrigins.join(", ")}`);
  });
}

main().catch((err) => {
  console.error("Lỗi nghiêm trọng khi khởi động:", err);
  process.exit(1);
});
