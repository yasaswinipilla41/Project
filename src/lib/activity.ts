/**
 * The Activity feed's type vocabulary — split out from
 * `server/queries/activity.ts` on purpose. That module pulls in Prisma (and
 * transitively the `pg` driver) to run the actual query; a client component
 * that only needs these two constants would otherwise drag that whole
 * server-only dependency chain into the browser bundle, exactly the mistake
 * `lib/board.ts` exists to avoid for the Flow Board's own status list.
 */

export const ACTIVITY_TYPES = ["assignment", "status", "comment"] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];

export const ACTIVITY_TYPE_LABEL: Record<ActivityType, string> = {
  assignment: "Assignments",
  status: "Status changes",
  comment: "Comments",
};

/**
 * The `action` values a comment writes to the activity trail.
 *
 * These are what `comments.ts` already records on every create, edit and
 * delete -- this only names them so the feed can ask for them. They are
 * matched on `action` rather than on `field`, which the other two kinds use,
 * because a comment changes no field of the issue.
 *
 * `comment.deleted` is the reason the trail is worth reading at all: an
 * activity row belongs to the *issue*, not to the comment, so removing a
 * comment cannot take the record of its removal with it.
 */
export const COMMENT_ACTIONS = [
  "comment.created",
  "comment.edited",
  "comment.deleted",
] as const;

export type CommentAction = (typeof COMMENT_ACTIONS)[number];

export const COMMENT_ACTION_VERB: Record<CommentAction, string> = {
  "comment.created": "commented on",
  "comment.edited": "edited a comment on",
  "comment.deleted": "deleted a comment on",
};

export function isCommentAction(action: string): action is CommentAction {
  return (COMMENT_ACTIONS as readonly string[]).includes(action);
}

/* ------------------------------------------------- how an assignment happened */

/**
 * The `action` an automatic assignment is written with.
 *
 * Prio hands work out in three ways that a person did not individually choose:
 * the backlog allocator dealing a project's unclaimed work, the return to a
 * tester when something is marked Ready for QA, and the return to the
 * developer who built something when testing reopens it. Every one of those
 * wrote a row indistinguishable from somebody assigning by hand, which made
 * the history unreadable in exactly the case it is consulted for — *who
 * decided this?*
 *
 * Recorded on `action` rather than in a new column, following the precedent
 * `issue.takeover` already set: the row is otherwise identical — same field,
 * same old and new assignee, same actor, same timestamp — so every reader that
 * already understands an `assigneeId` change keeps working. Only the sentence
 * it renders, and the badge the history page prints, differ.
 */
export const AUTOMATIC_ASSIGNMENT_ACTION = "issue.assigned.auto";

/** How an assignment came about, as the history page reports it. */
export const ASSIGNMENT_KINDS = ["Manual", "Automatic"] as const;
export type AssignmentKind = (typeof ASSIGNMENT_KINDS)[number];

/**
 * Whether an assignment row was Prio's doing or a person's.
 *
 * Read from the recorded action, never inferred from who received the work:
 * the recipient of an automatic assignment is the one thing that is certainly
 * *not* the actor, and guessing from it is the bug this exists to prevent.
 */
export function assignmentKindOf(action: string): AssignmentKind {
  return action === AUTOMATIC_ASSIGNMENT_ACTION ? "Automatic" : "Manual";
}
