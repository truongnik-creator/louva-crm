import { prisma } from "./prisma";
import { emitTo, roomFor } from "../socket";
import { UserStatus } from "../types/enums";

// Gửi Notification trong ứng dụng (chuông trên thanh trên). Dùng chung cho quy
// tắc tự động (F9), duyệt giảm giá (F21), chăm sóc sau điều trị (F10).

export interface NotifyInput {
  title: string;
  body?: string | null;
  level?: "INFO" | "WARN" | "DANGER";
  link?: string | null;
}

/** Người dùng đang làm việc có một trong các vai, thuộc cơ sở (null = mọi cơ sở). */
export async function usersWithRoles(roleCodes: string[], branchId: string | null | undefined): Promise<Array<{ id: string; name: string }>> {
  return prisma.user.findMany({
    where: {
      status: UserStatus.ACTIVE,
      roleLinks: { some: { role: { code: { in: roleCodes } } } },
      ...(branchId ? { branches: { some: { branchId } } } : {}),
    },
    select: { id: true, name: true },
    orderBy: { id: "asc" },
  });
}

/** Người dùng có một quyền (qua bất kỳ vai trò nào), thuộc cơ sở. */
export async function usersWithPermission(code: string, branchId: string | null | undefined): Promise<Array<{ id: string; name: string }>> {
  return prisma.user.findMany({
    where: {
      status: UserStatus.ACTIVE,
      roleLinks: { some: { role: { permissions: { some: { permission: { code } } } } } },
      ...(branchId ? { branches: { some: { branchId } } } : {}),
    },
    select: { id: true, name: true },
    orderBy: { id: "asc" },
  });
}

export async function notifyUsers(userIds: Array<string | null | undefined>, input: NotifyInput): Promise<number> {
  const ids = [...new Set(userIds.filter((x): x is string => Boolean(x)))];
  if (!ids.length) return 0;
  await prisma.notification.createMany({
    data: ids.map((userId) => ({
      userId,
      title: input.title.slice(0, 200),
      body: input.body?.slice(0, 1000) ?? null,
      level: input.level ?? "INFO",
      link: input.link ?? null,
    })),
  });
  for (const id of ids) emitTo(roomFor.user(id), "notification:new", { title: input.title });
  return ids.length;
}
