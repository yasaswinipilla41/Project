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
