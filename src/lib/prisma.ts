import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";

/**
 * Prisma 7 drives Postgres through the node-postgres adapter, so the pool is
 * ours to configure. A single client is cached on `globalThis` to survive
 * Next.js dev hot-reloads (otherwise every reload leaks a pool).
 */

declare global {
  var __prioPrisma: PrismaClient | undefined;
}

function createClient(): PrismaClient {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set");
  }

  const adapter = new PrismaPg({
    connectionString,
    max: Number(process.env.DATABASE_POOL_MAX ?? 10),
  });

  return new PrismaClient({
    adapter,
    log:
      process.env.NODE_ENV === "development"
        ? [{ emit: "stdout", level: "warn" }, { emit: "stdout", level: "error" }]
        : [{ emit: "stdout", level: "error" }],
  });
}

export const prisma: PrismaClient = globalThis.__prioPrisma ?? createClient();

if (process.env.NODE_ENV !== "production") {
  globalThis.__prioPrisma = prisma;
}
