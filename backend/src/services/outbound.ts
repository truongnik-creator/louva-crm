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

export async function sendToChannel(conv: OutboundConversation, text: string): Promise<SendResult> {
  if (channelOf(conv) === "PANCAKE") return sendPancakeReply(conv, text);
  return sendZaloMessage(conv, text);
}
