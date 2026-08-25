"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";

/**
 * Notification inbox actions (§32).
 *
 * Every mutation is scoped by `userId` in the WHERE clause, so one person can
 * never mark another person's notification read even by supplying its id.
 */

export type NotificationResult =
  | { ok: true; unread: number }
  | { ok: false; error: string };

export async function markNotificationRead(
  notificationId: string,
  read: boolean,
): Promise<NotificationResult> {
  try {
    const user = await requireUser();

    await prisma.notification.updateMany({
      where: { id: notificationId, userId: user.id },
      data: { readAt: read ? new Date() : null },
    });

    const unread = await prisma.notification.count({
      where: { userId: user.id, readAt: null },
    });

    revalidatePath("/notifications");
    revalidatePath("/");

    return { ok: true, unread };
  } catch (error) {
    console.error("[prio] markNotificationRead failed:", error);
    return { ok: false, error: "Could not update that notification." };
  }
}

export async function markAllNotificationsRead(): Promise<NotificationResult> {
  try {
    const user = await requireUser();

    await prisma.notification.updateMany({
      where: { userId: user.id, readAt: null },
      data: { readAt: new Date() },
    });

    revalidatePath("/notifications");
    revalidatePath("/");

    return { ok: true, unread: 0 };
  } catch (error) {
    console.error("[prio] markAllNotificationsRead failed:", error);
    return { ok: false, error: "Could not update your notifications." };
  }
}
