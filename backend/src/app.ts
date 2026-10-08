import crypto from "node:crypto";
import pinoHttp from "pino-http";
import { rateLimit } from "express-rate-limit";
import { logger } from "./lib/logger";
import express from "express";
import cors from "cors";
import fs from "node:fs";
import path from "node:path";
import { env, BACKEND_ROOT } from "./lib/env";
import { errorHandler } from "./middleware/errorHandler";
import { stripInternalFields } from "./middleware/strip-internal";

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
import homeRoutes from "./routes/home";
import clinicRoutes from "./routes/clinic";
import customerImportRoutes from "./routes/customer-import";
import automationRoutes from "./routes/automation";
import aftercareRoutes from "./routes/aftercare";
import outreachRoutes from "./routes/outreach";
import promotionRoutes from "./routes/promotions";
import salesScriptRoutes from "./routes/sales-scripts";
import analyticsRoutes from "./routes/analytics";
import payrollRoutes from "./routes/payroll";
import growthRoutes from "./routes/growth";
import consultationRoutes from "./routes/consultations";
import caseRoutes from "./routes/cases";
import reengageRoutes from "./routes/reengage";
import crm360Routes, { customer360Router } from "./routes/crm360";
import crm360bRoutes from "./routes/crm360b";


/**
 * Dựng ứng dụng Express, KHÔNG chạy bootstrap và KHÔNG mở cổng — để test
 * (supertest) dựng app trên CSDL test riêng. `index.ts` lo bootstrap + listen.
 */
export function createApp(): express.Express {
  const app = express();

  // Đứng sau nginx/load balancer thì req.ip mới đúng IP thật của người dùng —
  // nhật ký kiểm toán ghi IP nên điều này có ý nghĩa pháp lý.
  app.set("trust proxy", env.trustProxy);

  // T5: log có cấu trúc + request id. Id lấy từ header X-Request-Id nếu proxy
  // đã gắn (để nối log hai tầng), không thì tự sinh; luôn trả lại cho client để
  // người dùng báo lỗi kèm mã tra được.
  app.use(
    pinoHttp({
      logger,
      genReqId(req, res) {
        const incoming = req.headers["x-request-id"];
        const id =
          typeof incoming === "string" && /^[\w.-]{1,100}$/.test(incoming) ? incoming : crypto.randomUUID();
        res.setHeader("X-Request-Id", id);
        return id;
      },
      customLogLevel(_req, res, err) {
        if (err || res.statusCode >= 500) return "error";
        if (res.statusCode >= 400) return "warn";
        return "info";
      },
      serializers: {
        req(req) {
          // Chỉ method + đường dẫn (bỏ query string: có thể chứa SĐT tìm kiếm).
          return { id: req.id, method: req.method, url: String(req.url).split("?")[0] };
        },
        res(res) {
          return { statusCode: res.statusCode };
        },
      },
      autoLogging: { ignore: (req) => req.url === "/health" },
    })
  );

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
      allowedHeaders: ["Content-Type", "Authorization", "X-Branch-Id", "X-Request-Id"],
      exposedHeaders: ["X-Request-Id"],
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

  app.use("/api", stripInternalFields);

  app.get("/health", (_req, res) => res.json({ ok: true, version: "1.0.0-tmv" }));

  // S6: chặn dò mật khẩu. Chỉ đếm lượt THẤT BẠI để nhân viên đăng nhập đúng
  // nhiều lần trong ngày không bị chặn; kèm khoá tạm tài khoản ở routes/auth.ts.
  const tooMany = (message: string) => (_req: express.Request, res: express.Response) =>
    res.status(429).json({ error: message });
  app.use(
    "/api/auth/login",
    rateLimit({
      windowMs: env.loginRateLimitWindowMs,
      limit: env.loginRateLimitMax,
      skipSuccessfulRequests: true,
      standardHeaders: "draft-7",
      legacyHeaders: false,
      handler: tooMany("Đăng nhập sai quá nhiều lần từ máy này. Vui lòng thử lại sau 15 phút."),
    })
  );
  app.use(
    "/api/auth/refresh",
    rateLimit({
      windowMs: env.loginRateLimitWindowMs,
      limit: Math.max(env.loginRateLimitMax * 6, 30),
      skipSuccessfulRequests: true,
      standardHeaders: "draft-7",
      legacyHeaders: false,
      handler: tooMany("Làm mới phiên thất bại quá nhiều lần. Vui lòng đăng nhập lại sau ít phút."),
    })
  );

  app.use("/api/auth", authRoutes);
  app.use("/api/org", orgRoutes);
  app.use("/api/users", userRoutes);
  // Đặt TRƯỚC /api/customers để "/import/..." không bị hiểu là "/:id".
  app.use("/api/customers/import", customerImportRoutes);
  // Lô 7: /pipeline, /pipeline/prefs, /:id/360 khớp trước router khách chung.
  app.use("/api/customers", customer360Router);
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
  app.use("/api/home", homeRoutes);
  app.use("/api/clinic", clinicRoutes);
  // Lô 4 · Đợt 2
  app.use("/api/automation", automationRoutes);
  app.use("/api/aftercare", aftercareRoutes);
  app.use("/api/outreach", outreachRoutes);
  app.use("/api/promotions", promotionRoutes);
  app.use("/api/sales-scripts", salesScriptRoutes);
  // Lô 5 · Đợt 3
  app.use("/api/analytics", analyticsRoutes);
  app.use("/api/payroll", payrollRoutes);
  app.use("/api/growth", growthRoutes);
  // Lô 6 · SAU 90 NGÀY
  app.use("/api/consultations", consultationRoutes);
  app.use("/api/cases", caseRoutes);
  app.use("/api/reengage", reengageRoutes);
  app.use("/api/crm360", crm360Routes);
  // Lô 8 · CRM 360 Lô B
  app.use("/api/crm360", crm360bRoutes);

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
    logger.debug({ webRoot: WEB_ROOT }, "Phục vụ giao diện web");
  } else {
    logger.debug({ webRoot: WEB_ROOT }, "Chưa có bản web, chỉ phục vụ API");
  }

  app.use(errorHandler);

  return app;

}
