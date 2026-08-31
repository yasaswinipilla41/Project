"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Avatar, Button, EmptyState } from "@/components/ui/primitives";
import { IssueKey, IssueTypeIcon } from "@/components/ui/Indicators";
import { IconCheck, IconInbox } from "@/components/ui/Icon";
import { useToast } from "@/components/ui/Toast";
import { formatRelative } from "@/lib/format";
import {
  markAllNotificationsRead,
  markNotificationRead,
} from "@/server/notifications";
import type { IssueType, NotificationType } from "@prisma/client";

export interface NotificationRow {
  id: string;
  type: NotificationType;
  message: string;
  readAt: Date | null;
  createdAt: Date;
  actor: { name: string; image: string | null } | null;
  commentId: string | null;
  issue: { key: string; title: string; type: IssueType } | null;
  project: { key: string; name: string } | null;
}

const TYPE_LABEL: Record<NotificationType, string> = {
  ISSUE_ASSIGNED: "Assigned",
  MENTIONED: "Mentioned",
  STATUS_CHANGED: "Status",
  COMMENT_ADDED: "Comment",
  INVITED: "Invitation",
  USER_JOINED: "New member",
  TEST_RESULT: "Test result",
  PROJECT_ACCESS_REQUEST: "Access request",
};

export function NotificationList({
  notifications,
  unreadCount,
}: {
  notifications: NotificationRow[];
  unreadCount: number;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [pending, startTransition] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);

  async function toggle(id: string, currentlyRead: boolean) {
    setBusyId(id);
    const result = await markNotificationRead(id, !currentlyRead);
    setBusyId(null);

    if (!result.ok) {
      toast(result.error, "error");
      return;
    }
    startTransition(() => router.refresh());
  }

  async function markAll() {
    const result = await markAllNotificationsRead();
    if (!result.ok) {
      toast(result.error, "error");
      return;
    }
    toast("All notifications marked as read");
    startTransition(() => router.refresh());
  }

  if (notifications.length === 0) {
    return (
      <div className="prio-card">
        <EmptyState
          icon={<IconInbox size={24} />}
          title="You're all caught up."
          body="Assignments, mentions and status changes on work you follow will appear here."
        />
      </div>
    );
  }

  return (
    <>
      {unreadCount > 0 ? (
        <div className="prio-notifications__toolbar">
          <span className="prio-text-muted">
            {unreadCount} unread {unreadCount === 1 ? "notification" : "notifications"}
          </span>
          <Button variant="secondary" size="sm" onClick={markAll} disabled={pending}>
            <IconCheck size={13} />
            Mark all as read
          </Button>
        </div>
      ) : null}

      <ul className="prio-notifications">
        {notifications.map((n) => {
          const read = n.readAt !== null;
          /* Whatever produced the notification is what it opens: an issue
             (narrowed to a comment when there is one), or the project whose
             access was asked about. Anything with neither — a deleted subject,
             or an event that names no entity — stays plain text rather than
             offering a link that leads nowhere. */
          const target = n.issue
            ? `/issues/${n.issue.key.toLowerCase()}${
                n.commentId ? `#comment-${n.commentId}` : ""
              }`
            : n.project
              ? `/projects/${n.project.key.toLowerCase()}`
              : null;
          return (
            <li
              key={n.id}
              className="prio-notification"
              data-read={read}
              aria-label={read ? "Read notification" : "Unread notification"}
            >
              <span className="prio-notification__dot" aria-hidden />

              <Avatar
                name={n.actor?.name ?? "Prio"}
                image={n.actor?.image ?? null}
                size="md"
              />

              <div className="prio-notification__body">
                {/*
                 * The whole message opens whatever produced it, not just the
                 * issue chip below — a notification is a pointer at one thing,
                 * so reading it and going to it should be the same gesture.
                 * A comment notification lands on the comment itself rather
                 * than the top of a long thread. When the subject has since
                 * been deleted there is no target, and the text stays plain
                 * rather than offering a link that would 404.
                 */}
                {target ? (
                  <Link href={target} className="prio-notification__link">
                    <p className="prio-notification__text">
                      <strong>{n.actor?.name ?? "Prio"}</strong> {n.message}
                    </p>
                  </Link>
                ) : (
                  <p className="prio-notification__text">
                    <strong>{n.actor?.name ?? "Prio"}</strong> {n.message}
                  </p>
                )}

                {n.issue && target ? (
                  <Link href={target} className="prio-notification__issue">
                    <IssueTypeIcon type={n.issue.type} size={16} />
                    <IssueKey issueKey={n.issue.key} />
                    <span className="prio-truncate">{n.issue.title}</span>
                  </Link>
                ) : null}

                <span className="prio-notification__meta">
                  <span className="prio-badge">{TYPE_LABEL[n.type]}</span>
                  <time dateTime={new Date(n.createdAt).toISOString()}>
                    {formatRelative(n.createdAt)}
                  </time>
                </span>
              </div>

              <button
                type="button"
                className="prio-btn prio-btn--ghost prio-btn--sm"
                onClick={() => toggle(n.id, read)}
                disabled={busyId === n.id}
              >
                {read ? "Mark unread" : "Mark read"}
              </button>
            </li>
          );
        })}
      </ul>
    </>
  );
}
