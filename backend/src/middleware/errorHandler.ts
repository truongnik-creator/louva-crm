import { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { MulterError } from "multer";
import { logger } from "../lib/logger";

// Thrown by route handlers to produce a specific HTTP status + message.
export class HttpError extends Error {
  status: number;
  /** Trường thêm trả kèm thông báo lỗi (ví dụ điều kiện còn thiếu khi đổi bước, Lô 8 · P4). */
  extra?: Record<string, unknown>;
  constructor(status: number, message: string, extra?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

type AsyncHandler = (req: Request, res: Response, next: NextFunction) => Promise<unknown>;

// Wraps an async route handler so rejected promises are forwarded to
// Express's error-handling middleware instead of crashing the process.
export function asyncHandler(fn: AsyncHandler) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };
}

// Centralized error handler. Never leaks stack traces to the client.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, req: Request, res: Response, next: NextFunction) {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ ...(err.extra ?? {}), error: err.message });
  }

  if (err instanceof ZodError) {
    return res.status(400).json({ error: "Dữ liệu không hợp lệ", details: err.flatten() });
  }

  if (err instanceof MulterError) {
    const status = err.code === "LIMIT_FILE_SIZE" ? 413 : 400;
    return res.status(status).json({ error: `Tệp tải lên không hợp lệ (${err.code})` });
  }

  const log = (req as Request & { log?: typeof logger }).log ?? logger;
  log.error({ err }, "Lỗi không xử lý được");
  const requestId = (req as Request & { id?: unknown }).id;
  return res.status(500).json({
    error: "Lỗi máy chủ. Báo quản trị kèm mã yêu cầu để tra nhật ký.",
    ...(requestId ? { requestId: String(requestId) } : {}),
  });
}
