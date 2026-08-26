import Link from "next/link";
import type { IssueType } from "@prisma/client";
import { Avatar } from "@/components/ui/primitives";
import { ISSUE_TYPE_LABEL } from "@/lib/domain";
import { formatDateTime, formatRelative } from "@/lib/format";

/**
 * "Who assigned what to whom", for a project's Details view.
 *
 * Sourced from the same immutable `ActivityLogEntry` trail every other
 * activity feed in Prio reads (§31) — `updateIssue` already writes one of
 * these rows every time `assigneeId` changes, so nothing new is recorded
 * here. This only reads that trail and renders it as a sentence, filtered to
 * assignment events and resolved against the real actor, issue and assignee
 * for the row — never invented text.
 */

export interface AssignmentActivityEntry {
  id: string;
  createdAt: Date;
  actorName: string;
  actorImage: string | null;
  issueKey: string;
  issueTitle: string;
  issueType: IssueType;
  assigneeName: string;
}

export function AssignmentActivityList({
  entries,
}: {
  entries: AssignmentActivityEntry[];
}) {
  if (entries.length === 0) {
    return <p className="prio-text-muted">No assignments recorded yet.</p>;
  }

  return (
    <ol className="prio-activity">
      {entries.map((entry) => (
        <li key={entry.id} className="prio-activity__item">
          <span className="prio-activity__rail" aria-hidden />
          <Avatar
            name={entry.actorName}
            image={entry.actorImage}
            size="sm"
            className="prio-activity__avatar"
          />
          <div className="prio-activity__body">
            <span className="prio-activity__text">
              <strong>{entry.actorName}</strong> assigned the{" "}
              <Link href={`/issues/${entry.issueKey.toLowerCase()}`}>
                {entry.issueTitle}
              </Link>{" "}
              {ISSUE_TYPE_LABEL[entry.issueType].toLowerCase()} to{" "}
              <strong>{entry.assigneeName}</strong>.
            </span>
            <time
              className="prio-activity__time"
              dateTime={entry.createdAt.toISOString()}
              title={formatDateTime(entry.createdAt)}
            >
              {formatRelative(entry.createdAt)}
            </time>
          </div>
        </li>
      ))}
    </ol>
  );
}
