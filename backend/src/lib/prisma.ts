import { PrismaClient } from "@prisma/client";
import { env } from "./env";
import { normalizeVnPhone } from "./phone";
import { normalizeName } from "./text";

// Singleton Prisma client. In dev with hot-reload (tsx watch) we stash the
// instance on globalThis to avoid exhausting DB connections on reload.
declare global {
  // eslint-disable-next-line no-var
  var __prisma: PrismaClient | undefined;
}

function createClient(): PrismaClient {
  // Passed explicitly (rather than relying on process.env timing/import
  // order) so the client always points at the same SQLite file env.ts
  // resolved, whether that came from DATABASE_URL or the zero-config default.
  const client = new PrismaClient({
    datasources: { db: { url: env.databaseUrl } },
  });

  // B17: mọi lần ghi `phone` / `name` của Customer và Lead đều tự tính cột
  // chuẩn hoá. Đặt ở tầng client thay vì từng route để không route nào (webhook
  // Zalo, đồng bộ Pancake, seed, script) quên cập nhật và làm hỏng chống trùng.
  client.$use(async (params, next) => {
    if (params.model !== "Customer" && params.model !== "Lead") return next(params);
    const withName = params.model === "Customer";

    const patch = (data: Record<string, unknown> | undefined) => {
      if (!data || typeof data !== "object") return;
      if ("phone" in data) {
        const phone = data.phone;
        data.phoneNormalized =
          phone && typeof phone === "object" && "set" in (phone as object)
            ? normalizeVnPhone((phone as { set: string | null }).set)
            : normalizeVnPhone(phone as string | null | undefined);
      }
      if (withName && "name" in data) {
        const name = data.name;
        data.nameNormalized =
          name && typeof name === "object" && "set" in (name as object)
            ? normalizeName((name as { set: string }).set)
            : normalizeName(name as string | undefined);
      }
    };

    const args = params.args as Record<string, unknown> | undefined;
    // F15: lead tạo ra đã có SĐT thì mốc "có SĐT" là lúc tạo.
    const stampPhone = (data: Record<string, unknown> | undefined) => {
      if (params.model !== "Lead" || !data || typeof data !== "object") return;
      if (typeof data.phone === "string" && data.phone.trim() && !data.hasPhoneAt) data.hasPhoneAt = new Date();
    };
    if (params.action === "create") stampPhone(args?.data as Record<string, unknown>);
    if (params.action === "createMany") {
      const data = args?.data;
      if (Array.isArray(data)) data.forEach((d) => stampPhone(d));
      else stampPhone(data as Record<string, unknown>);
    }
    if (params.action === "upsert") stampPhone(args?.create as Record<string, unknown>);
    switch (params.action) {
      case "create":
      case "update":
      case "updateMany":
        patch(args?.data as Record<string, unknown>);
        break;
      case "createMany": {
        const data = args?.data;
        if (Array.isArray(data)) data.forEach((d) => patch(d));
        else patch(data as Record<string, unknown>);
        break;
      }
      case "upsert":
        patch(args?.create as Record<string, unknown>);
        patch(args?.update as Record<string, unknown>);
        break;
    }
    return next(params);
  });

  return client;
}

export const prisma = global.__prisma ?? createClient();

if (process.env.NODE_ENV !== "production") {
  global.__prisma = prisma;
}
