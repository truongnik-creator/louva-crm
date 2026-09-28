import { Server as HttpServer } from "http";
import { Server as SocketIOServer, Socket } from "socket.io";
import { env } from "../lib/env";
import { prisma } from "../lib/prisma";
import { verifyAccessToken } from "../lib/session";

// Socket.io CÓ XÁC THỰC VÀ CÓ ROOM (mục 3 Giai đoạn 1). Bản cũ phát tin cho
// mọi kết nối, nghĩa là bất kỳ ai mở được cổng đều đọc được tin nhắn khách.
//
// Room dùng trong hệ thống:
//   branch:<id>  — sự kiện chung của cơ sở (hàng đợi lễ tân, lịch hẹn)
//   conv:<id>    — một hội thoại Zalo cụ thể
//   user:<id>    — thông báo riêng cho một người
//
// Khi lên nhiều instance backend, thêm @socket.io/redis-adapter ở đúng chỗ này.

let io: SocketIOServer | null = null;

export type SocketEvent =
  | "message:new"
  | "message:status"
  | "conversation:updated"
  | "conversation:assigned"
  | "appointment:created"
  | "appointment:updated"
  | "visit:checked-in"
  | "queue:updated"
  | "notification:new";

interface SocketAuth {
  userId: string;
  branchIds: string[];
}

export function initSocket(httpServer: HttpServer): SocketIOServer {
  io = new SocketIOServer(httpServer, {
    cors: { origin: env.corsOrigins, credentials: true },
  });

  io.use(async (socket, next) => {
    const token =
      (socket.handshake.auth?.token as string | undefined) ??
      socket.handshake.headers.authorization?.replace("Bearer ", "");
    if (!token) return next(new Error("Thiếu token"));

    try {
      const payload = verifyAccessToken(token);
      const session = await prisma.authSession.findUnique({
        where: { id: payload.sid },
        select: { revokedAt: true, expiresAt: true },
      });
      if (!session || session.revokedAt || session.expiresAt.getTime() < Date.now()) {
        return next(new Error("Phiên đã bị thu hồi"));
      }

      const branches = await prisma.userBranch.findMany({
        where: { userId: payload.sub },
        select: { branchId: true },
      });
      (socket.data as SocketAuth) = {
        userId: payload.sub,
        branchIds: branches.map((b) => b.branchId),
      };
      return next();
    } catch {
      return next(new Error("Token không hợp lệ"));
    }
  });

  io.on("connection", (socket: Socket) => {
    const auth = socket.data as SocketAuth;

    // Tự vào room riêng và room của mọi cơ sở mình thuộc về.
    socket.join(`user:${auth.userId}`);
    for (const branchId of auth.branchIds) socket.join(`branch:${branchId}`);

    // Chỉ cho vào room hội thoại nếu hội thoại đó thuộc cơ sở của mình.
    socket.on("conversation:join", async (conversationId: string) => {
      const conv = await prisma.conversation.findUnique({
        where: { id: conversationId },
        select: { branchId: true },
      });
      if (!conv) return;
      if (conv.branchId && !auth.branchIds.includes(conv.branchId)) return;
      socket.join(`conv:${conversationId}`);
    });

    socket.on("conversation:leave", (conversationId: string) => {
      socket.leave(`conv:${conversationId}`);
    });
  });

  return io;
}

export function getIO(): SocketIOServer | null {
  return io;
}

/** Phát sự kiện tới một hoặc nhiều room. Bỏ qua im lặng nếu socket chưa sẵn sàng. */
export function emitTo(rooms: string | string[], event: SocketEvent, payload: unknown): void {
  if (!io) return;
  io.to(rooms).emit(event, payload);
}

export const roomFor = {
  branch: (id: string) => `branch:${id}`,
  conversation: (id: string) => `conv:${id}`,
  user: (id: string) => `user:${id}`,
};
