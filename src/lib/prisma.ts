import { PrismaClient } from "@prisma/client";

/**
 * Singleton PrismaClient, following Next.js's recommended pattern for
 * avoiding exhausted connections from hot-reloading in dev.
 * https://www.prisma.io/docs/guides/nextjs
 */
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
