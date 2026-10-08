import { sendZaloMessage, type SendResult } from "./zalo";
import { sendPancakeReply } from "./pancake";

// F5: một cửa gửi tin ra ngoài theo NGUỒN của hội thoại. Hội thoại đến từ
// Pancake (Facebook, Instagram, TikTok, Zalo qua Pancake) phải trả lời qua
// Pancake; gửi qua Zalo OA là sai kênh và khách không bao giờ nhận được.

export interface OutboundConversation {
  id: string;
  externalId: string | null;
  oaConfigId: string | null;
  pancakeConversationId: string | null;
  pancakePageId: string | null;
}

export function channelOf(conv: OutboundConversation): "PANCAKE" | "ZALO" {
  return conv.pancakeConversationId ? "PANCAKE" : "ZALO";
}

/**
 * `senderUserId` là người trong CRM bấm gửi. Chuyển tiếp xuống Pancake
 * (tham số sender_id) để Pancake quy tin này về đúng nhân viên — nhờ đó báo cáo
 * hiệu suất (F35, số liệu do Pancake đo) tính cả tin gửi từ CRM, không chỉ tin
 * gõ trong app Pancake. Hàng đợi gửi tin theo nhóm không có người gửi cụ thể
 * nên bỏ trống.
 */
export async function sendToChannel(
  conv: OutboundConversation,
  text: string,
  opts: { senderUserId?: string | null } = {}
): Promise<SendResult> {
  if (channelOf(conv) === "PANCAKE") return sendPancakeReply(conv, text, opts);
  return sendZaloMessage(conv, text);
}
