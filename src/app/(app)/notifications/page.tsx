import type { Metadata } from "next";
import { NotificationList } from "@/components/notifications/NotificationList";
import { IconBell } from "@/components/ui/Icon";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { sharedSheetPathFor } from "@/server/shares";

export const metadata: Metadata = { title: "Notifications" };
export const dynamic = "force-dynamic";

/** The in-app notification inbox (§32), read from real notification rows. */
export default async function NotificationsPage() {
  const user = await requireUser();

  const [notifications, unreadCount] = await Promise.all([
    prisma.notification.findMany({
      where: { userId: user.id },
      /*
       * Newest first, and nothing else.
       *
       * This used to sort unread ahead of read. Reading a notification writes
       * `readAt`, which moved it out of the unread group and down to the
       * bottom of the list -- so opening the second notification and coming
       * back found it last. Ordering on a column that opening the thing
       * changes cannot hold a list still.
       *
       * `createdAt` never changes, so a notification keeps its place whatever
       * is done to it. Read and unread are still told apart, by the dot and
       * the `data-read` styling the row already carries.
       */
      orderBy: { createdAt: "desc" },
      take: 100,
      select: {
        id: true,
        type: true,
        message: true,
        readAt: true,
        createdAt: true,
        commentId: true,
        actor: { select: { name: true, image: true } },
        issue: { select: { key: true, title: true, type: true } },
        project: { select: { key: true, name: true } },
      },
    }),
    prisma.notification.count({ where: { userId: user.id, readAt: null } }),
  ]);

  /*
   * Where an Issues Sheet notification opens.
   *
   * A sheet share hangs off no issue and no project — it is the whole sheet —
   * so unlike every other notification its destination cannot be read from the
   * row. It is the same place for all of them, and it is this reader's own
   * share link, so it is resolved once here and handed to the list rather than
   * stored on each row. Null when nothing is shared with them, which is what
   * leaves a revoked share's notification without a link instead of pointing
   * at a page that would turn them away.
   */
  const sharedSheetPath = notifications.some((n) => n.type === "INVITED")
    ? await sharedSheetPathFor(user.id)
    : null;

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
        sharedSheetPath={sharedSheetPath}
        notifications={notifications}
        unreadCount={unreadCount}
      />
    </>
  );
}
