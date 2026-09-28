import { PrismaClient } from "@prisma/client";
import { env } from "./env";

// Singleton Prisma client. In dev with hot-reload (tsx watch) we stash the
// instance on globalThis to avoid exhausting DB connections on reload.
declare global {
  // eslint-disable-next-line no-var
  var __prisma: PrismaClient | undefined;
}

// Passed explicitly (rather than relying on process.env timing/import
// order) so the client always points at the same SQLite file env.ts
// resolved, whether that came from DATABASE_URL or the zero-config default.
export const prisma =
  global.__prisma ??
  new PrismaClient({
    datasources: { db: { url: env.databaseUrl } },
  });

if (process.env.NODE_ENV !== "production") {
  global.__prisma = prisma;
}
