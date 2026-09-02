"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Avatar, Button, EmptyState } from "@/components/ui/primitives";
import { IssueKey, IssueTypeIcon } from "@/components/ui/Indicators";
import {
  IconCheck,
  IconChevronLeft,
  IconExternal,
  IconInbox,
} from "@/components/ui/Icon";
import { useToast } from "@/components/ui/Toast";
import { formatDateTime, formatRelative } from "@/lib/format";
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

/**
 * Where a notification points, or null when its subject is gone.
 *
 * Lifted out of the list so the detail view's action button and the list agree
 * by construction rather than by two copies of the same expression.
 */
function targetOf(n: NotificationRow): string | null {
  if (n.issue) {
    return `/issues/${n.issue.key.toLowerCase()}${
      n.commentId ? `#comment-${n.commentId}` : ""
    }`;
  }
  if (n.project) return `/projects/${n.project.key.toLowerCase()}`;
  return null;
}

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
  /* Which notification is being read. A notification is a pointer at
     something; opening it should show what it points at before taking you
     there, not instead of it. */
  const [openId, setOpenId] = useState<string | null>(null);

  async function open(notification: NotificationRow) {
    setOpenId(notification.id);
    // Opening is reading. Already-read ones are left alone so this does not
    // rewrite a timestamp every time somebody looks twice.
    if (notification.readAt === null) {
      const result = await markNotificationRead(notification.id, true);
      if (result.ok) startTransition(() => router.refresh());
    }
  }

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

  const opened = notifications.find((n) => n.id === openId) ?? null;
  if (opened) {
    return (
      <NotificationDetail
        notification={opened}
        onBack={() => setOpenId(null)}
      />
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
                {/*
                  * Opens the notification rather than following it. The whole
                  * message is still the target, so reading it is still one
                  * gesture -- it now leads to what the notification says, with
                  * the way onward offered there, instead of dropping the
                  * reader into a page with no idea what brought them.
                  */}
                <button
                  type="button"
                  className="prio-notification__link"
                  onClick={() => void open(n)}
                  aria-expanded={false}
                >
                  <p className="prio-notification__text">
                    <strong>{n.actor?.name ?? "Prio"}</strong> {n.message}
                  </p>
                </button>

                {n.issue ? (
                  <span className="prio-notification__issue">
                    <IssueTypeIcon type={n.issue.type} size={16} />
                    <IssueKey issueKey={n.issue.key} />
                    <span className="prio-truncate">{n.issue.title}</span>
                  </span>
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


/**
 * One notification, read in place.
 *
 * A notification used to be a link: clicking it left this page for the issue
 * immediately, which answered "where" without ever answering "what". This
 * shows what the notification actually says -- who did it, to what, when, and
 * on which project -- and then offers the way onward as a deliberate second
 * step rather than an unavoidable first one.
 *
 * It replaces the list rather than sitting beside it, which is what keeps the
 * list's own markup and styling untouched; Back restores it unchanged.
 */
function NotificationDetail({
  notification: n,
  onBack,
}: {
  notification: NotificationRow;
  onBack: () => void;
}) {
  const target = targetOf(n);
  const actor = n.actor?.name ?? "Prio";

  return (
    <div className="prio-card prio-notification-detail">
      <div className="prio-notification-detail__bar">
        <button
          type="button"
          className="prio-btn prio-btn--ghost prio-btn--sm"
          onClick={onBack}
        >
          <IconChevronLeft size={14} />
          Back to notifications
        </button>
        <span className="prio-badge">{TYPE_LABEL[n.type]}</span>
      </div>

      <div className="prio-notification-detail__head">
        <Avatar name={actor} image={n.actor?.image ?? null} size="lg" />
        <div className="prio-notification-detail__who">
          <p className="prio-notification-detail__text">
            <strong>{actor}</strong> {n.message}
          </p>
          <time
            className="prio-text-muted"
            dateTime={new Date(n.createdAt).toISOString()}
            title={formatDateTime(n.createdAt)}
          >
            {formatDateTime(n.createdAt)}
          </time>
        </div>
      </div>

      <dl className="prio-notification-detail__facts">
        {n.issue ? (
          <>
            <dt>Issue</dt>
            <dd>
              <span className="prio-notification__issue">
                <IssueTypeIcon type={n.issue.type} size={16} />
                <IssueKey issueKey={n.issue.key} />
                <span>{n.issue.title}</span>
              </span>
            </dd>
          </>
        ) : null}
        {n.project ? (
          <>
            <dt>Project</dt>
            <dd>{n.project.name}</dd>
          </>
        ) : null}
        {n.commentId ? (
          <>
            <dt>Comment</dt>
            <dd className="prio-text-muted">
              This notification points at a specific comment on the issue.
            </dd>
          </>
        ) : null}
        <dt>Received</dt>
        <dd>{formatRelative(n.createdAt)}</dd>
      </dl>

      <div className="prio-notification-detail__actions">
        {target ? (
          <Link href={target} className="prio-btn prio-btn--brand">
            {n.issue ? "Open issue" : "View content"}
            <IconExternal size={14} />
          </Link>
        ) : (
          /* The subject has been deleted. Saying so is more use than a button
             that would lead to a missing page. */
          <p className="prio-text-muted">
            Whatever this referred to is no longer available.
          </p>
        )}
      </div>
    </div>
  );
}
