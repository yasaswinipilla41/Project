import { after } from "next/server";
import { prisma } from "@/lib/prisma";

/**
 * Marks a project as just-opened by this user, backing the sidebar's
 * "Recents" section. Scheduled with `after()` so it runs once the response
 * has already been sent — a visit log has no business adding latency to the
 * page that triggers it.
 */
export function recordProjectVisit(userId: string, projectId: string): void {
  after(async () => {
    await prisma.projectRecent.upsert({
      where: { projectId_userId: { projectId, userId } },
      update: { lastVisitedAt: new Date() },
      create: { projectId, userId },
    });
  });
}
