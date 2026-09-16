import type { Prisma, PrismaClient } from "@prisma/client";
import {
  QA_TEAM_SLUGS,
  WORK_TEAM_SLUGS,
  workRoleFromTeams,
} from "@/lib/authz";
import { doesDeveloperWork } from "@/lib/domain";
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
  type:
    | "ISSUE_ASSIGNED"
    | "MENTIONED"
    | "STATUS_CHANGED"
    | "COMMENT_ADDED"
    | "TEST_RESULT";
  message: string;
  commentId?: string | null;
  /**
   * The issue's project, for a notice that should name it in the detail view
   * as well as open the issue. Optional: most notices are only about the
   * issue, and the issue is still what every notification opens.
   */
  projectId?: string | null;
  /**
   * This notice reports a Developer or QA workflow activity — a status moving
   * through the build or the checking, a hand-off, a claim, a verdict.
   *
   * It is what `workflowAudience` below keys on, and it is set at the call
   * site rather than guessed from `type`: an `ISSUE_ASSIGNED` row is raised
   * both by the workflow and by an administrator onboarding somebody, and only
   * the caller knows which of those just happened. Commenting and mentioning
   * are not workflow activities and never set it.
   */
  workflowActivity?: boolean;
}

/**
 * Writes the notifications and answers who actually received them.
 *
 * The return value matters for callers that mirror the audience on another
 * channel — `recordTestResult` sends email to the same people — so the two
 * cannot address different sets.
 */
export async function notify(db: Db, params: NotifyParams): Promise<string[]> {
  const intended = [
    ...new Set(params.userIds.filter((id): id is string => Boolean(id))),
  ].filter((id) => id !== params.actorId);

  const recipients = params.workflowActivity
    ? await workflowAudience(db, params.actorId, intended)
    : intended;

  if (recipients.length === 0) return [];

  await db.notification.createMany({
    data: recipients.map((userId) => ({
      userId,
      type: params.type,
      actorId: params.actorId,
      issueId: params.issueId,
      commentId: params.commentId ?? null,
      projectId: params.projectId ?? null,
      message: params.message,
    })),
  });

  return recipients;
}

/**
 * Who hears about a Developer or QA workflow activity.
 *
 * For everybody else this is the audience the caller worked out, untouched —
 * a developer handing work over still tells the tester, a tester's verdict
 * still reaches the developer, and nothing about those paths has moved.
 *
 * A full stack member is the exception, and deliberately a narrow one. They
 * hold both halves of the job, so the people an ordinary hand-off would tell
 * are frequently themselves in the other half, or colleagues with no part in
 * the work: the notice lands on developers and testers who were not involved
 * and cannot act on it, which is the pattern that teaches everybody to ignore
 * the bell. Their workflow activity is reported to the administrators instead,
 * who are the people who oversee it.
 *
 * The role is resolved here, from the actor's own team rows, through the same
 * `workRoleFromTeams` every other surface reads. Nothing about it comes from
 * the request: `actorId` is the session user at every call site, so a client
 * cannot nominate a role, an activity or a recipient.
 */
async function workflowAudience(
  db: Db,
  actorId: string,
  intended: string[],
): Promise<string[]> {
  if (!(await isFullStack(db, actorId))) return intended;
  return administratorIds(db, actorId);
}

/** Does this person's authoritative working role come out as Full Stack? */
async function isFullStack(db: Db, userId: string): Promise<boolean> {
  const person = await db.user.findUnique({
    where: { id: userId },
    select: {
      role: true,
      teamMemberships: {
        where: { team: { slug: { in: [...WORK_TEAM_SLUGS] } } },
        select: { team: { select: { slug: true } } },
      },
    },
  });
  if (!person) return false;

  return (
    workRoleFromTeams(
      person.role,
      person.teamMemberships.map((row) => row.team.slug),
    ) === "FULLSTACK"
  );
}

/**
 * The administrators, by the lookup Prio already uses for an org-wide notice —
 * see `notifyAdminsOfNewUser`. Active accounts only, and never the actor: an
 * administrator is never full stack, so that last clause is belt and braces
 * rather than a case that arises.
 */
async function administratorIds(db: Db, exclude: string): Promise<string[]> {
  const admins = await db.user.findMany({
    where: { role: "ADMIN", isActive: true, id: { not: exclude } },
    select: { id: true },
  });
  return admins.map((admin) => admin.id);
}

/**
 * Is this person a tester — that is, does a membership of theirs carry the QA
 * half of the job?
 *
 * "Tester" is not a `Role` and not a field on the issue: it is membership of a
 * team that does the testing, which is how `authz.ts` and `/my-work` already
 * decide it. Two memberships carry it — Testing, and Full Stack Developers —
 * so both are asked for; a full stack developer tests, and a check that knew
 * only the Testing row would quietly leave them out of every notice addressed
 * to whoever has to do the checking.
 *
 * What this adds over the rule in `authz.ts` is a `Db`, so the check can run
 * inside the transaction that is about to write the notification rather than
 * against a second connection that might not see the same state.
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
    where: { userId, team: { slug: { in: [...QA_TEAM_SLUGS] } } },
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

/**
 * What to tell the tester who raised a piece of work when it comes back.
 *
 * A developer moving an issue to Ready for QA is handing it to somebody
 * specific — the person who asked for it — so this is an assignment notice and
 * uses the assignment row, the assignment type and the assignment destination.
 * It reads differently from `assignmentMessage` because the event is
 * different: nobody has decided to give them new work, the work they already
 * raised has come back with something to check.
 *
 * The same convention as everything else here: `NotificationList` renders
 * `<strong>{actor.name}</strong> {message}`, so the developer's name is
 * already in front of this and must not be repeated inside it.
 */
export function readyForQaReturnMessage(params: {
  issueKey: string;
  issueTitle: string;
  projectName?: string;
}): string {
  return (
    `finished ${params.issueKey}, marked it Ready for QA and returned it to ` +
    `you to test — ${params.issueTitle}${inProject(params.projectName)}`
  );
}

/**
 * What to tell the QA member an issue is assigned to when it is marked Ready
 * for QA.
 *
 * The developer handing work over names who tests it by assigning it, so the
 * notice goes to that person and nobody else. It carries what they need to act
 * without opening anything first: the issue's key and title, its project, the
 * status it is now in, and that it is theirs to test. The same convention as
 * the rest: the actor's name is already rendered in front of it.
 */
export function readyForQaMessage(params: {
  issueKey: string;
  issueTitle: string;
  projectName?: string;
}): string {
  return (
    `marked ${params.issueKey} Ready for QA and assigned it to you to test — ` +
    `${params.issueTitle}${inProject(params.projectName)}`
  );
}

/** " (Engineering)", or nothing when there is no name to give. */
function inProject(projectName: string | undefined): string {
  return projectName ? ` (${projectName})` : "";
}

/**
 * The tester a piece of work should go back to when it is ready to be checked.
 *
 * It is whoever raised it, and nobody else. Not the first tester on the
 * project, not every tester, not anybody the request happened to name: the
 * person who wrote the issue is the person who knows what "fixed" would look
 * like, and they are already recorded on the row as its reporter. That
 * identifier is read here from the database rather than taken from the caller,
 * so no request can redirect somebody else's work.
 *
 * Three things have to be true, or the work stays where it is. They must still
 * be a tester, because somebody who has moved off testing is not who to ask.
 * They must still be active. And they must still be a member of the project,
 * because an assignee who cannot open the issue is a state the rest of Prio
 * refuses to create. Where any of those fails this returns null and the
 * ordinary notice to the project's testers is the whole of what happens —
 * which is exactly the behaviour that existed before this rule.
 */
export async function testerToReturnWorkTo(
  db: Db,
  params: { reporterId: string; projectId: string },
): Promise<string | null> {
  const reporter = await db.user.findFirst({
    where: {
      id: params.reporterId,
      isActive: true,
      teamMemberships: { some: { team: { slug: { in: [...QA_TEAM_SLUGS] } } } },
      projectMemberships: { some: { projectId: params.projectId } },
    },
    select: { id: true },
  });

  return reporter?.id ?? null;
}

/**
 * The developer a reopened issue belongs back with.
 *
 * When testing sends work back it goes to whoever built it — not to whoever
 * happens to hold it, not to whoever raised it, and not to whoever created it.
 * That person is not on the issue row at all: after a QA cycle `assigneeId` is
 * the tester doing the checking, which is the one answer that is certainly
 * wrong. It is in the append-only trail, which records who moved the work
 * through the build.
 *
 * Two entries can say it, tried in that order:
 *
 *   1. whoever last moved it to Ready for QA — the hand-off, the moment a
 *      developer declared the build finished and asked for it to be checked;
 *   2. otherwise whoever last moved it to In Progress — the build itself, for
 *      work that reached QA some other way.
 *
 * Most recent first, so work built, reopened and built again by somebody else
 * goes back to whoever built it last: the cycle being reopened, rather than the
 * first one ever run.
 *
 * Three things then have to be true of that person, or the work stays where it
 * is and this answers null. They must still do development, because somebody
 * who has since moved to testing is not who to hand a build back to. They must
 * still be active. And they must still be a member of the project — which is
 * not politeness: `updateIssue` refuses an assignee who is not one, so writing
 * one here would create exactly the state the rest of Prio rejects.
 */
export async function developerToReturnWorkTo(
  db: Db,
  params: { issueId: string; projectId: string },
): Promise<string | null> {
  const entries = await db.activityLogEntry.findMany({
    where: {
      issueId: params.issueId,
      field: "status",
      newValue: { in: ["IN_REVIEW", "IN_PROGRESS"] },
    },
    select: { actorId: true, newValue: true },
    orderBy: { createdAt: "desc" },
  });

  const candidates = [
    entries.find((entry) => entry.newValue === "IN_REVIEW")?.actorId,
    entries.find((entry) => entry.newValue === "IN_PROGRESS")?.actorId,
  ];

  for (const actorId of candidates) {
    if (!actorId) continue;
    if (await stillBuildsOnProject(db, actorId, params.projectId)) {
      return actorId;
    }
  }
  return null;
}

/** Still active, still on the project, and still doing development work. */
async function stillBuildsOnProject(
  db: Db,
  userId: string,
  projectId: string,
): Promise<boolean> {
  const person = await db.user.findFirst({
    where: {
      id: userId,
      isActive: true,
      projectMemberships: { some: { projectId } },
    },
    select: {
      role: true,
      teamMemberships: {
        where: { team: { slug: { in: [...WORK_TEAM_SLUGS] } } },
        select: { team: { select: { slug: true } } },
      },
    },
  });
  if (!person) return false;

  /* The same derivation every other surface uses, so "does development work"
     cannot come to mean something different here — and a full stack developer
     qualifies for the same reason they build everywhere else. */
  return doesDeveloperWork(
    workRoleFromTeams(
      person.role,
      person.teamMemberships.map((row) => row.team.slug),
    ),
  );
}

/**
 * What to tell the developer a reopened issue has gone back to.
 *
 * Testing has looked at the build and sent it back, so this is an assignment
 * notice: the work is theirs again and there is something to do. The actor's
 * name is already rendered in front of it, as everywhere else here.
 */
export function reopenedMessage(params: {
  issueKey: string;
  issueTitle: string;
  projectName?: string;
}): string {
  return (
    `reopened ${params.issueKey} and sent it back to you — ` +
    `${params.issueTitle}${inProject(params.projectName)}`
  );
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
        teamMemberships: {
          some: { team: { slug: { in: [...QA_TEAM_SLUGS] } } },
        },
      },
    },
    select: { userId: true },
  });
  return rows.map((row) => row.userId);
}
