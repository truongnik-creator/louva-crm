import { prisma } from "./prisma";
import { logger } from "./logger";
import { getSettingBool } from "./settings-catalog";
import { startOfVnDay } from "./datetime";
import { emitTo, roomFor } from "../socket";
import { ShiftAssignmentStatus, UserStatus } from "../types/enums";
import { RoleCode } from "./rbac-catalog";

// F26: HỘP THƯ THEO CA.
//
// - Mốc chờ: khách nhắn thì ghi lastInboundAt và (nếu chưa ai đang chờ) mốc
//   waitingSince; mình trả lời thì xoá waitingSince. Đồng hồ khách chờ ở hộp thư
//   và quy tắc 1 (F9) đọc waitingSince.
// - Chia xoay vòng: hội thoại mới chưa có người phụ trách thì giao cho sale
//   ĐANG TRONG CA ở cơ sở của hội thoại, lần lượt từng người (con trỏ lưu ở
//   bảng round_robin_states theo cơ sở).

const DAY_MS = 86_400_000;
export const SALES_ROLES: string[] = [RoleCode.TELESALE, RoleCode.TU_VAN_VIEN];

/** Khách vừa nhắn lúc `at`. */
export async function noteInbound(conversationId: string, at: Date = new Date()): Promise<void> {
  await prisma.conversation.updateMany({ where: { id: conversationId, waitingSince: null }, data: { waitingSince: at } });
  await prisma.conversation.update({ where: { id: conversationId }, data: { lastInboundAt: at } });
}

/** Mình vừa trả lời lúc `at`: khách hết chờ. */
export async function noteOutbound(conversationId: string, at: Date = new Date()): Promise<void> {
  await prisma.conversation.update({ where: { id: conversationId }, data: { lastOutboundAt: at, waitingSince: null } });
}

/**
 * Ghi mốc từ một lô tin đồng bộ (Pancake): tin cuối cùng là của khách thì khách
 * đang chờ từ tin khách đầu tiên sau lần trả lời cuối.
 */
export async function noteMessageBatch(
  conversationId: string,
  messages: Array<{ direction: "IN" | "OUT"; at: Date }>
): Promise<void> {
  if (!messages.length) return;
  const sorted = [...messages].sort((a, b) => a.at.getTime() - b.at.getTime());
  const conv = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { lastInboundAt: true, lastOutboundAt: true, waitingSince: true },
  });
  if (!conv) return;
  let lastIn = conv.lastInboundAt;
  let lastOut = conv.lastOutboundAt;
  let waiting = conv.waitingSince;
  for (const m of sorted) {
    if (m.direction === "IN") {
      if (!lastIn || m.at > lastIn) lastIn = m.at;
      if (!waiting && (!lastOut || m.at > lastOut)) waiting = m.at;
    } else {
      if (!lastOut || m.at > lastOut) lastOut = m.at;
      if (waiting && m.at >= waiting) waiting = null;
    }
  }
  await prisma.conversation.update({
    where: { id: conversationId },
    data: { lastInboundAt: lastIn, lastOutboundAt: lastOut, waitingSince: waiting },
  });
}

function hhmmToMinutes(s: string | null | undefined): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s ?? "");
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/**
 * Sale đang trong ca ở cơ sở: có phân lịch hôm nay (giờ VN), không huỷ; nếu mẫu
 * ca có giờ bắt đầu, kết thúc thì bây giờ phải nằm trong khung đó.
 */
export async function salesOnShift(branchId: string, now: Date = new Date()): Promise<Array<{ id: string; name: string }>> {
  const dayStart = startOfVnDay(now);
  const rows = await prisma.shiftAssignment.findMany({
    where: {
      branchId,
      date: { gte: dayStart, lt: new Date(dayStart.getTime() + DAY_MS) },
      status: { not: ShiftAssignmentStatus.CANCELLED },
      user: { status: UserStatus.ACTIVE, roleLinks: { some: { role: { code: { in: SALES_ROLES } } } } },
    },
    select: { user: { select: { id: true, name: true } }, template: { select: { startTime: true, endTime: true } } },
  });
  const minuteOfDay = Math.floor((now.getTime() - dayStart.getTime()) / 60_000);
  const out = new Map<string, { id: string; name: string }>();
  for (const r of rows) {
    const start = hhmmToMinutes(r.template?.startTime);
    const end = hhmmToMinutes(r.template?.endTime);
    if (start != null && end != null && end > start && (minuteOfDay < start || minuteOfDay >= end)) continue;
    out.set(r.user.id, r.user);
  }
  return [...out.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** Người kế tiếp theo vòng của cơ sở. null = không ai trong ca. */
export async function nextOnShift(branchId: string, now: Date = new Date()): Promise<{ id: string; name: string } | null> {
  const people = await salesOnShift(branchId, now);
  if (!people.length) return null;
  const key = `inbox:${branchId}`;
  const state = await prisma.roundRobinState.findUnique({ where: { key } });
  const idx = state?.lastUserId ? people.findIndex((p) => p.id === state.lastUserId) : -1;
  // Người cuối lượt trước đã hết ca: bắt đầu lại từ người có id lớn hơn gần nhất.
  let next = people[0];
  if (idx >= 0) next = people[(idx + 1) % people.length];
  else if (state?.lastUserId) next = people.find((p) => p.id > state.lastUserId!) ?? people[0];
  await prisma.roundRobinState.upsert({ where: { key }, create: { key, lastUserId: next.id }, update: { lastUserId: next.id } });
  return next;
}

/**
 * Giao hội thoại chưa có người phụ trách cho sale kế tiếp trong ca. Không làm
 * gì nếu tắt cài đặt, hội thoại đã có người, hội thoại không có cơ sở hoặc là nhóm nội bộ.
 */
export async function autoAssignConversation(conversationId: string, now: Date = new Date()): Promise<string | null> {
  try {
    if (!(await getSettingBool("inbox.roundRobin.enabled"))) return null;
    const conv = await prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { id: true, branchId: true, assignedToId: true, kind: true, customer: { select: { assignedToId: true, telesaleId: true } } },
    });
    if (!conv || conv.assignedToId || !conv.branchId || conv.kind !== "CUSTOMER") return null;
    const next = await nextOnShift(conv.branchId, now);
    if (!next) return null;
    const r = await prisma.conversation.updateMany({
      where: { id: conv.id, assignedToId: null },
      data: { assignedToId: next.id, assignedAt: now },
    });
    if (r.count !== 1) return null;
    emitTo(roomFor.conversation(conv.id), "conversation:assigned", { id: conv.id, assignedTo: next });
    emitTo(roomFor.user(next.id), "notification:new", { title: "Có hội thoại mới được giao" });
    return next.id;
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err), conversationId }, "[inbox] chia hội thoại lỗi");
    return null;
  }
}
