import type { Prisma, PrismaClient } from "@prisma/client";
import { TESTING_TEAM_SLUG } from "@/lib/authz";
import { prisma } from "@/lib/prisma";

/**
 * Immutable activity history (§31) and the notifications derived from it.
 *
 * Nothing in Prio updates or deletes an ActivityLogEntry — every recorded
 * change is append-only. All write paths funnel through here so the trail can
 * never diverge from what actually happened.
 */

/** Works inside a transaction or against the base client. */
type Db = PrismaClient | Prisma.TransactionClient;

export interface FieldChange {
  field: string;
  oldValue: string | null;
  newValue: string | null;
}

/** Records issue creation. */
export async function recordIssueCreated(
  db: Db,
  params: { issueId: string; actorId: string; isBug: boolean },
): Promise<void> {
  await db.activityLogEntry.create({
    data: {
      issueId: params.issueId,
      actorId: params.actorId,
      action: params.isBug ? "bug.created" : "issue.created",
    },
  });
}

/**
 * Records one entry per changed field. No changes means no rows.
 *
 * `action` names what the change *was*, and defaults to the ordinary edit. A
 * developer taking an issue off another developer passes `issue.takeover`: the
 * row is otherwise identical — same field, same old and new assignee, same
 * actor, same timestamp — so every reader that already understands an
 * `assigneeId` change keeps working, including the Activity feed's assignment
 * filter. Only the sentence it renders differs, which is the whole difference
 * between "reassigned this" and "took this over".
 */
export async function recordFieldChanges(
  db: Db,
  params: {
    issueId: string;
    actorId: string;
    changes: FieldChange[];
    action?: string;
  },
): Promise<void> {
  if (params.changes.length === 0) return;

  await db.activityLogEntry.createMany({
    data: params.changes.map((change) => ({
      issueId: params.issueId,
      actorId: params.actorId,
      action: params.action ?? "issue.updated",
      field: change.field,
      oldValue: change.oldValue,
      newValue: change.newValue,
    })),
  });
}

export async function recordCommentCreated(
  db: Db,
  params: { issueId: string; actorId: string },
): Promise<void> {
  await db.activityLogEntry.create({
    data: {
      issueId: params.issueId,
      actorId: params.actorId,
      action: "comment.created",
    },
  });
}

/* ------------------------------------------------------------- watchers */

/**
 * Implicit watchers (§32): the reporter, the assignee and anyone who has
 * commented. Adding is idempotent.
 */
export async function addWatchers(
  db: Db,
  issueId: string,
  userIds: (string | null | undefined)[],
): Promise<void> {
  const unique = [...new Set(userIds.filter((id): id is string => Boolean(id)))];
  if (unique.length === 0) return;

  await db.issueWatcher.createMany({
    data: unique.map((userId) => ({ issueId, userId })),
    skipDuplicates: true,
  });
}

export async function watcherIds(
  db: Db,
  issueId: string,
): Promise<string[]> {
  const rows = await db.issueWatcher.findMany({
    where: { issueId },
    select: { userId: true },
  });
  return rows.map((r) => r.userId);
}

/* --------------------------------------------------------- notifications */

export interface NotifyParams {
  issueId: string;
  actorId: string;
  /** Recipients; the actor is always filtered out — nobody notifies themselves. */
  userIds: (string | null | undefined)[];
  type: "ISSUE_ASSIGNED" | "MENTIONED" | "STATUS_CHANGED" | "COMMENT_ADDED";
  message: string;
  commentId?: string | null;
}

export async function notify(db: Db, params: NotifyParams): Promise<void> {
  const recipients = [
    ...new Set(params.userIds.filter((id): id is string => Boolean(id))),
  ].filter((id) => id !== params.actorId);

  if (recipients.length === 0) return;

  await db.notification.createMany({
    data: recipients.map((userId) => ({
      userId,
      type: params.type,
      actorId: params.actorId,
      issueId: params.issueId,
      commentId: params.commentId ?? null,
      message: params.message,
    })),
  });
}

/**
 * Is this person a tester — that is, on the Testing team?
 *
 * "Tester" is not a `Role` and not a field on the issue: it is membership of
 * the team that owns the testing surfaces, which is how `authz.ts` and
 * `/my-work` already decide it. This asks the same question of the same rows;
 * what it adds is a `Db`, so the check can run inside the transaction that is
 * about to write the notification rather than against a second connection
 * that might not see the same state.
 *
 * A user id that is null, or belongs to nobody, is not a tester — an
 * unassignment has no one to be one.
 */
export async function isTester(
  db: Db,
  userId: string | null | undefined,
): Promise<boolean> {
  if (!userId) return false;
  const count = await db.teamMember.count({
    where: { userId, team: { slug: TESTING_TEAM_SLUG } },
  });
  return count > 0;
}

/**
 * What to tell someone who has just been given an issue.
 *
 * Assignment already notified whoever received the work; a tester being handed
 * something is the same event, and gets the same row, the same type and the
 * same destination. Only the sentence changes — "assigned you as tester for"
 * rather than "assigned … to you" — because being asked to test a thing and
 * being asked to build it are different jobs, and the notification is the
 * first place that distinction is visible.
 *
 * Written to the existing convention: `NotificationList` renders
 * `<strong>{actor.name}</strong> {message}`, so this is a predicate with no
 * name of its own in front of it.
 */
export function assignmentMessage(params: {
  issueKey: string;
  issueTitle: string;
  typeLabel: string;
  tester: boolean;
}): string {
  if (params.tester) {
    return `assigned you as tester for ${params.issueKey} — ${params.issueTitle}`;
  }
  return `assigned ${params.typeLabel} ${params.issueKey} to you`;
}

/** Unread notification count for the chrome badge. */
export async function unreadCount(userId: string): Promise<number> {
  return prisma.notification.count({ where: { userId, readAt: null } });
}

/**
 * Tells every other active admin that someone new has joined, the first time
 * that person ever signs in. Not issue-scoped — `notify()` above requires an
 * `issueId`, which this event has none of — so it writes the same
 * `Notification` row shape directly rather than stretching that helper's
 * signature to fit a case it was not built for.
 */
export async function notifyAdminsOfNewUser(
  db: Db,
  params: { newUserId: string; newUserName: string },
): Promise<void> {
  const admins = await db.user.findMany({
    where: { role: "ADMIN", isActive: true, id: { not: params.newUserId } },
    select: { id: true },
  });
  if (admins.length === 0) return;

  await db.notification.createMany({
    data: admins.map((admin) => ({
      userId: admin.id,
      type: "USER_JOINED",
      actorId: params.newUserId,
      /*
       * No name prefix here — `NotificationList` already renders
       * `<strong>{actor.name}</strong> {message}`, the same convention
       * `issues.ts`'s "assigned X to you" messages follow. Prefixing the name
       * again here would show it twice.
       */
      message:
        "has joined Prio and is now available in Bugs → Reporter and Assignee.",
    })),
  });
}

/**
 * The testers on a project: its members who are on the Testing team.
 *
 * Handing work to QA has no one person to address — the issue is not assigned
 * to a tester at that moment, and often never is — so the notice goes to
 * whoever could pick it up. Membership of the project bounds it: a tester who
 * cannot open the issue is not told about it.
 */
export async function projectTesterIds(
  db: Db,
  projectId: string,
): Promise<string[]> {
  const rows = await db.projectMember.findMany({
    where: {
      projectId,
      user: {
        isActive: true,
        teamMemberships: { some: { team: { slug: TESTING_TEAM_SLUG } } },
      },
    },
    select: { userId: true },
  });
  return rows.map((row) => row.userId);
}
