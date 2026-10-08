import pino from "pino";

// Log có cấu trúc (T5). Một dòng JSON mỗi sự kiện, kèm `reqId` khi phát sinh
// trong một request (pino-http gắn `req.log`). Đặt LOG_LEVEL=debug khi cần soi,
// LOG_PRETTY không dùng — đọc JSON bằng `| npx pino-pretty` nếu muốn.
//
// Không bao giờ log body request: có mật khẩu, SĐT, nội dung bệnh án.

const level =
  process.env.LOG_LEVEL ?? (process.env.NODE_ENV === "test" || process.env.VITEST ? "silent" : "info");

export const logger = pino({
  level,
  base: { service: "louva-crm" },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "password",
      "passwordHash",
      "refreshToken",
      "accessToken",
    ],
    censor: "[đã ẩn]",
  },
});
