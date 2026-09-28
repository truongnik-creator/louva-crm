import { io, Socket } from 'socket.io-client'
import { API_BASE_URL } from './api'
import type { ChatMessage, Visit } from './types'

// Sự kiện khớp với backend/src/socket/index.ts. Máy chủ chỉ phát vào room mà
// người dùng được phép vào, nên client không phải tự lọc theo cơ sở.
interface ServerToClientEvents {
  'message:new': (message: ChatMessage) => void
  'message:status': (payload: { id: string; status: string }) => void
  'conversation:updated': (payload: {
    id: string
    unreadCount?: number
    lastMessagePreview?: string
  }) => void
  'conversation:assigned': (payload: { id: string; assignedTo: { id: string; name: string } | null }) => void
  'appointment:created': (payload: unknown) => void
  'appointment:updated': (payload: unknown) => void
  'visit:checked-in': (visit: Visit) => void
  'queue:updated': (payload: { branchId: string }) => void
  'notification:new': (payload: { title: string; body?: string }) => void
}

interface ClientToServerEvents {
  'conversation:join': (conversationId: string) => void
  'conversation:leave': (conversationId: string) => void
}

export type CrmSocket = Socket<ServerToClientEvents, ClientToServerEvents>

let socket: CrmSocket | null = null

function socketBaseUrl(): string {
  try {
    // API_BASE_URL tuyệt đối (Electron trỏ thẳng localhost:4000).
    const url = new URL(API_BASE_URL)
    return `${url.protocol}//${url.host}`
  } catch {
    // API_BASE_URL tương đối ("/api") — bản web do chính backend phục vụ, kể cả
    // khi đi qua Cloudflare Tunnel. Lấy origin hiện tại để socket bám đúng
    // tên miền và đúng scheme (https -> wss).
    return window.location.origin
  }
}

export function connectSocket(token: string): CrmSocket {
  if (socket) disconnectSocket()
  socket = io(socketBaseUrl(), {
    auth: { token },
    transports: ['websocket', 'polling'],
    autoConnect: true
  })
  return socket
}

export function getSocket(): CrmSocket | null {
  return socket
}

export function disconnectSocket(): void {
  if (!socket) return
  socket.removeAllListeners()
  socket.disconnect()
  socket = null
}

/**
 * Đăng ký một trình xử lý sự kiện và trả về hàm huỷ đăng ký — dùng trong
 * useEffect để không rò rỉ listener khi component tháo ra.
 */
export function onSocket<E extends keyof ServerToClientEvents>(
  event: E,
  handler: ServerToClientEvents[E]
): () => void {
  const s = socket
  if (!s) return () => undefined
  s.on(event, handler as never)
  return () => {
    s.off(event, handler as never)
  }
}
