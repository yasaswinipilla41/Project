import type { Metadata } from "next";
import { NotificationList } from "@/components/notifications/NotificationList";
import { IconBell } from "@/components/ui/Icon";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";

export const metadata: Metadata = { title: "Notifications" };
export const dynamic = "force-dynamic";

/** The in-app notification inbox (§32), read from real notification rows. */
export default async function NotificationsPage() {
  const user = await requireUser();

  const [notifications, unreadCount] = await Promise.all([
    prisma.notification.findMany({
      where: { userId: user.id },
      orderBy: [{ readAt: { sort: "asc", nulls: "first" } }, { createdAt: "desc" }],
      take: 100,
      select: {
        id: true,
        type: true,
        message: true,
        readAt: true,
        createdAt: true,
        actor: { select: { name: true, image: true } },
        issue: { select: { key: true, title: true, type: true } },
      },
    }),
    prisma.notification.count({ where: { userId: user.id, readAt: null } }),
  ]);

  return (
    <>
      <div className="prio-page-header">
        <div className="prio-page-header__text">
          <h1 className="prio-page-header__title">
            <IconBell />
            Notifications
          </h1>
          <p className="prio-page-header__subtitle">
            Assignments, mentions and status changes on work you follow.
          </p>
        </div>
      </div>

      <NotificationList
        notifications={notifications}
        unreadCount={unreadCount}
      />
    </>
  );
}
