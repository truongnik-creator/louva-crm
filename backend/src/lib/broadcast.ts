import { z } from "zod";
import { prisma } from "./prisma";
import { logger } from "./logger";
import { getSettingNumber } from "./settings-catalog";
import { vnDayKey } from "./datetime";
import { renderTemplate } from "./quick-reply-vars";
import { sendToChannel } from "../services/outbound";
import { emitTo, roomFor } from "../socket";
import {
  BroadcastStatus,
  ConversationKind,
  MessageDirection,
  MessageStatus,
  ProcedureStatus,
  RecipientStatus,
  TaskKind,
  TaskPriority,
  TaskStatus,
  ContractStatus,
} from "../types/enums";

// F11: NHÓM KHÁCH VÀ GỬI THEO KỊCH BẢN.
//
// - Bộ lọc nhóm: im lặng quá N ngày, đã làm dịch vụ, sắp tái tiêm, sinh nhật
//   trong tháng (có thể kết hợp). Luôn loại khách ẩn, đã gộp, TỪ CHỐI NHẬN TIN.
// - Tạo đợt gửi = chụp danh sách khách vào BroadcastRecipient (nhật ký gửi).
// - Tác vụ nền "broadcast-send" gửi dần theo giới hạn broadcast.maxPerHour.
// - Facebook, Instagram chỉ cho trang nhắn khách trong 24 giờ kể từ tin khách
//   nhắn cuối: ngoài cửa sổ thì KHÔNG tự gửi, tạo việc cho sale tự liên hệ.

const DAY_MS = 86_400_000;
export const MAX_RECIPIENTS = 5000;

export const segmentFilterSchema = z
  .object({
    /** Không có lần chạm nào trong N ngày. */
    silentDays: z.number().int().min(1).max(3650).optional(),
    /** Đã làm (hoàn tất lần thực hiện / hợp đồng hiệu lực) một trong các dịch vụ này. */
    serviceIds: z.array(z.string().uuid()).max(50).optional(),
    /** Đã làm dịch vụ bất kỳ. */
    servedAny: z.boolean().optional(),
    /** Mốc tái tiêm trong N ngày tới (kể cả đã quá mốc tối đa 30 ngày). */
    retreatWithinDays: z.number().int().min(0).max(365).optional(),
    /** Sinh nhật trong tháng (1..12); 0 = tháng hiện tại. */
    birthdayMonth: z.number().int().min(0).max(12).optional(),
    stages: z.array(z.string().max(30)).max(20).optional(),
    branchId: z.string().uuid().optional(),
  })
  .strict();

export type SegmentFilter = z.infer<typeof segmentFilterSchema>;

export function parseSegmentFilter(raw: string | null | undefined): SegmentFilter {
  try {
    return segmentFilterSchema.parse(JSON.parse(raw ?? "{}"));
  } catch {
    return {};
  }
}

/** Điều kiện Prisma cho khách thuộc nhóm (chưa gồm sinh nhật, lọc ở bước sau). */
export function segmentWhere(filter: SegmentFilter, opts: { now: Date; branchIds: string[] | null }): Record<string, unknown> {
  const and: Record<string, unknown>[] = [{ hidden: false, mergedIntoId: null }];
  const branchIds = filter.branchId ? [filter.branchId] : opts.branchIds;
  if (branchIds) and.push({ branchLinks: { some: { branchId: { in: branchIds } } } });
  if (filter.silentDays) {
    const cutoff = new Date(opts.now.getTime() - filter.silentDays * DAY_MS);
    and.push({ OR: [{ lastContactAt: null, createdAt: { lt: cutoff } }, { lastContactAt: { lt: cutoff } }] });
  }
  if (filter.serviceIds?.length) {
    and.push({
      OR: [
        { procedures: { some: { status: ProcedureStatus.COMPLETED, serviceId: { in: filter.serviceIds } } } },
        {
          contracts: {
            some: { status: { not: ContractStatus.CANCELLED }, signedAt: { not: null }, items: { some: { serviceId: { in: filter.serviceIds } } } },
          },
        },
      ],
    });
  }
  if (filter.servedAny) {
    and.push({ OR: [{ lastServiceAt: { not: null } }, { procedures: { some: { status: ProcedureStatus.COMPLETED } } }] });
  }
  if (filter.retreatWithinDays != null) {
    and.push({
      procedures: {
        some: {
          retreatDueAt: {
            gte: new Date(opts.now.getTime() - 30 * DAY_MS),
            lte: new Date(opts.now.getTime() + filter.retreatWithinDays * DAY_MS),
          },
        },
      },
    });
  }
  if (filter.stages?.length) and.push({ stage: { in: filter.stages } });
  if (filter.birthdayMonth != null) and.push({ dob: { not: null } });
  return { AND: and };
}

function birthdayMonthOf(filter: SegmentFilter, now: Date): number | null {
  if (filter.birthdayMonth == null) return null;
  return filter.birthdayMonth === 0 ? Number(vnDayKey(now).slice(5, 7)) : filter.birthdayMonth;
}

export interface SegmentMember {
  id: string;
  code: string;
  name: string;
  phone: string | null;
  optOut: boolean;
  lastContactAt: Date | null;
}

/** Toàn bộ khách của nhóm (kể cả khách từ chối nhận tin, có cờ optOut). */
export async function resolveSegment(
  filter: SegmentFilter,
  opts: { now?: Date; branchIds: string[] | null; limit?: number }
): Promise<SegmentMember[]> {
  const now = opts.now ?? new Date();
  const limit = Math.min(opts.limit ?? MAX_RECIPIENTS, MAX_RECIPIENTS);
  const month = birthdayMonthOf(filter, now);
  const rows = await prisma.customer.findMany({
    where: segmentWhere(filter, { now, branchIds: opts.branchIds }),
    select: { id: true, code: true, name: true, phone: true, optOut: true, lastContactAt: true, dob: true },
    orderBy: { id: "asc" },
    // Lọc tháng sinh nhật làm ở bộ nhớ (SQLite không có hàm tháng qua Prisma): lấy dư rồi cắt.
    take: month ? MAX_RECIPIENTS * 4 : limit,
  });
  const out = month ? rows.filter((r) => r.dob && Number(vnDayKey(r.dob).slice(5, 7)) === month) : rows;
  return out.slice(0, limit).map(({ dob: _dob, ...r }) => r);
}

// ------------------------------------------------------------- HÀNG ĐỢI GỬI

function isFacebookLike(channel: string | null | undefined): boolean {
  const c = (channel ?? "").toLowerCase();
  return c === "facebook" || c === "instagram" || c === "messenger";
}

async function lastInboundAt(conv: { id: string; lastInboundAt: Date | null }): Promise<Date | null> {
  if (conv.lastInboundAt) return conv.lastInboundAt;
  const m = await prisma.chatMessage.findFirst({
    where: { conversationId: conv.id, direction: MessageDirection.IN },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  return m?.createdAt ?? null;
}

async function createManualTask(opts: {
  customer: { id: string; name: string; assignedToId: string | null; telesaleId: string | null };
  branchId: string | null;
  content: string;
  reason: string;
  broadcastName: string;
  createdById: string | null;
  now: Date;
}): Promise<string> {
  const task = await prisma.task.create({
    data: {
      branchId: opts.branchId,
      customerId: opts.customer.id,
      title: `Nhắn tay theo kịch bản "${opts.broadcastName}"`,
      description: `${opts.reason}. Nội dung gợi ý:\n${opts.content}`,
      status: TaskStatus.OPEN,
      priority: TaskPriority.NORMAL,
      dueAt: new Date(opts.now.getTime() + DAY_MS),
      assigneeId: opts.customer.assignedToId ?? opts.customer.telesaleId ?? opts.createdById,
      createdById: opts.createdById,
      kind: TaskKind.MANUAL_MESSAGE,
      source: "broadcast",
    },
  });
  return task.id;
}

/**
 * Tác vụ nền: gửi tin các đợt đang chờ, tối đa broadcast.maxPerHour tin THẬT
 * SỰ GỬI mỗi 60 phút (tính mọi đợt). Việc tạo cho sale không tính vào giới hạn.
 */
export async function processBroadcastQueue(now: Date): Promise<{ created: number; message: string }> {
  const maxPerHour = await getSettingNumber("broadcast.maxPerHour");
  const windowHours = await getSettingNumber("broadcast.facebookWindowHours");
  const sentLastHour = await prisma.broadcastRecipient.count({
    where: { status: RecipientStatus.SENT, sentAt: { gt: new Date(now.getTime() - 3_600_000) } },
  });
  let budget = Math.max(0, maxPerHour - sentLastHour);
  let sent = 0;
  let tasks = 0;
  let failed = 0;

  const pending = await prisma.broadcastRecipient.findMany({
    where: { status: RecipientStatus.PENDING, broadcast: { status: { in: [BroadcastStatus.QUEUED, BroadcastStatus.RUNNING] } } },
    orderBy: { createdAt: "asc" },
    take: 500,
    include: { broadcast: true },
  });

  const started = new Set<string>();
  for (const r of pending) {
    if (!started.has(r.broadcastId) && r.broadcast.status === BroadcastStatus.QUEUED) {
      await prisma.broadcast.update({ where: { id: r.broadcastId }, data: { status: BroadcastStatus.RUNNING } });
    }
    started.add(r.broadcastId);
    try {
      const customer = await prisma.customer.findUnique({
        where: { id: r.customerId },
        select: { id: true, name: true, optOut: true, assignedToId: true, telesaleId: true, mergedIntoId: true },
      });
      if (!customer || customer.mergedIntoId) {
        await prisma.broadcastRecipient.update({ where: { id: r.id }, data: { status: RecipientStatus.FAILED, error: "Hồ sơ khách không còn" } });
        failed++;
        continue;
      }
      // Khách đổi ý (bấm từ chối nhận tin) sau khi đợt đã tạo: vẫn loại.
      if (customer.optOut) {
        await prisma.broadcastRecipient.update({ where: { id: r.id }, data: { status: RecipientStatus.SKIPPED_OPT_OUT } });
        continue;
      }
      const conv = await prisma.conversation.findFirst({
        where: { customerId: customer.id, kind: ConversationKind.CUSTOMER },
        orderBy: [{ lastMessageAt: "desc" }, { createdAt: "desc" }],
      });
      const outside =
        !conv
          ? "Khách chưa có hội thoại chat"
          : isFacebookLike(conv.channel)
            ? await (async () => {
                const lastIn = await lastInboundAt(conv);
                return !lastIn || now.getTime() - lastIn.getTime() > windowHours * 3_600_000
                  ? `Ngoài cửa sổ ${windowHours} giờ của Facebook (khách nhắn lần cuối ${lastIn ? vnDayKey(lastIn) : "không rõ"})`
                  : null;
              })()
            : null;
      // Hết hạn mức giờ này: tin cần gửi thật để chờ lượt sau (việc cho sale vẫn tạo).
      if (!outside && budget <= 0) continue;
      const rendered = await renderTemplate(r.broadcast.template, {
        conversationId: conv?.id ?? null,
        customerId: customer.id,
        staffName: r.broadcast.createdByName ?? "Phòng khám",
        fallbackBranchId: r.broadcast.branchId,
      });
      if (rendered.unresolved.length) {
        await prisma.broadcastRecipient.update({
          where: { id: r.id },
          data: { status: RecipientStatus.FAILED, error: `Thiếu dữ liệu cho biến: ${rendered.unresolved.map((u) => `{{${u}}}`).join(", ")}` },
        });
        failed++;
        continue;
      }
      const content = rendered.content;

      if (outside) {
        const taskId = await createManualTask({
          customer,
          branchId: conv?.branchId ?? r.broadcast.branchId,
          content,
          reason: outside,
          broadcastName: r.broadcast.name,
          createdById: r.broadcast.createdById,
          now,
        });
        await prisma.broadcastRecipient.update({
          where: { id: r.id },
          data: { status: RecipientStatus.TASK_CREATED, content, taskId, conversationId: conv?.id ?? null, error: outside },
        });
        tasks++;
        continue;
      }

      const message = await prisma.chatMessage.create({
        data: {
          conversationId: conv!.id,
          direction: MessageDirection.OUT,
          content,
          senderUserId: r.broadcast.createdById,
          senderName: `${r.broadcast.createdByName ?? "Hệ thống"} (gửi theo nhóm)`,
          status: MessageStatus.PENDING,
        },
      });
      const result = await sendToChannel(conv!, content);
      await prisma.chatMessage.update({
        where: { id: message.id },
        data: { status: result.ok ? MessageStatus.SENT : MessageStatus.FAILED, errorMessage: result.ok ? null : result.error },
      });
      if (result.ok) {
        await prisma.conversation.update({
          where: { id: conv!.id },
          data: { lastMessageAt: now, lastMessagePreview: content.slice(0, 160), lastOutboundAt: now },
        });
        emitTo(roomFor.conversation(conv!.id), "message:new", { ...message, status: MessageStatus.SENT });
      }
      await prisma.broadcastRecipient.update({
        where: { id: r.id },
        data: {
          status: result.ok ? RecipientStatus.SENT : RecipientStatus.FAILED,
          content,
          conversationId: conv!.id,
          messageId: message.id,
          sentAt: result.ok ? now : null,
          error: result.ok ? null : (result.error ?? "Kênh chat báo lỗi"),
        },
      });
      if (result.ok) {
        sent++;
        budget--;
      } else failed++;
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err), recipient: r.id }, "[broadcast] gửi lỗi");
      await prisma.broadcastRecipient.update({
        where: { id: r.id },
        data: { status: RecipientStatus.FAILED, error: err instanceof Error ? err.message.slice(0, 500) : "Lỗi không rõ" },
      });
      failed++;
    }
  }

  // Đợt không còn khách chờ gửi thì đóng.
  const open = await prisma.broadcast.findMany({
    where: { status: { in: [BroadcastStatus.QUEUED, BroadcastStatus.RUNNING] } },
    select: { id: true, _count: { select: { recipients: { where: { status: RecipientStatus.PENDING } } } } },
  });
  for (const b of open) {
    if (b._count.recipients === 0) {
      await prisma.broadcast.update({ where: { id: b.id }, data: { status: BroadcastStatus.DONE, finishedAt: now } });
    }
  }

  const left = await prisma.broadcastRecipient.count({ where: { status: RecipientStatus.PENDING, broadcast: { status: BroadcastStatus.RUNNING } } });
  return {
    created: sent + tasks,
    message: `Đã gửi ${sent}, tạo việc ${tasks}, lỗi ${failed}. Còn chờ ${left}. Giới hạn ${maxPerHour}/giờ (đã dùng ${sentLastHour + sent}).`,
  };
}
