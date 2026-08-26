/**
 * The Activity feed's type vocabulary — split out from
 * `server/queries/activity.ts` on purpose. That module pulls in Prisma (and
 * transitively the `pg` driver) to run the actual query; a client component
 * that only needs these two constants would otherwise drag that whole
 * server-only dependency chain into the browser bundle, exactly the mistake
 * `lib/board.ts` exists to avoid for the Flow Board's own status list.
 */

export const ACTIVITY_TYPES = ["assignment", "status"] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];

export const ACTIVITY_TYPE_LABEL: Record<ActivityType, string> = {
  assignment: "Assignments",
  status: "Status changes",
};
