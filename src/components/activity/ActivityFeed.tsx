import Link from "next/link";
import { Avatar, EmptyState } from "@/components/ui/primitives";
import { IconEmptyBox } from "@/components/ui/Icon";
import { COMMENT_ACTION_VERB } from "@/lib/activity";
import { ISSUE_TYPE_LABEL, STATUS_LABEL, isIssueStatus } from "@/lib/domain";
import { formatDateTime, formatRelative } from "@/lib/format";
import type { ActivityEntry } from "@/server/queries/activity";

/** "Today" / "Yesterday" / "Earlier", from the entry's own timestamp. */
function groupLabel(date: Date): "Today" | "Yesterday" | "Earlier" {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const startOfYesterday = new Date(startOfToday);
  startOfYesterday.setDate(startOfYesterday.getDate() - 1);

  if (date >= startOfToday) return "Today";
  if (date >= startOfYesterday) return "Yesterday";
  return "Earlier";
}

function sentence(entry: ActivityEntry) {
  const issueLink = (
    <Link href={`/issues/${entry.issue.key.toLowerCase()}`}>{entry.issue.title}</Link>
  );

  if (entry.kind === "comment") {
    /*
     * Deliberately says only that a comment happened, never what it said.
     * A deleted comment still has a row here -- that is the point of an
     * append-only trail -- and quoting its text in the feed would undo the
     * deletion it is recording.
     */
    const verb = entry.commentAction
      ? COMMENT_ACTION_VERB[entry.commentAction]
      : "commented on";
    return (
      <>
        <strong>{entry.actor.name}</strong> {verb} {issueLink}{" "}
        {ISSUE_TYPE_LABEL[entry.issue.type].toLowerCase()}.
      </>
    );
  }

  if (entry.kind === "assignment") {
    return (
      <>
        <strong>{entry.actor.name}</strong> assigned {issueLink}{" "}
        {ISSUE_TYPE_LABEL[entry.issue.type].toLowerCase()} to{" "}
        <strong>{entry.assigneeName}</strong>.
      </>
    );
  }

  const toLabel = entry.toStatus && isIssueStatus(entry.toStatus)
    ? STATUS_LABEL[entry.toStatus]
    : (entry.toStatus ?? "an unknown status");

  return (
    <>
      <strong>{entry.actor.name}</strong> changed {issueLink}{" "}
      {ISSUE_TYPE_LABEL[entry.issue.type].toLowerCase()} status to{" "}
      <strong>{toLabel}</strong>.
    </>
  );
}

export function ActivityFeed({ entries }: { entries: ActivityEntry[] }) {
  if (entries.length === 0) {
    return (
      <EmptyState
        icon={<IconEmptyBox />}
        title="No activity yet"
        body="Activity from projects and tasks will appear here."
      />
    );
  }

  const groups: { label: string; entries: ActivityEntry[] }[] = [];
  for (const entry of entries) {
    const label = groupLabel(entry.createdAt);
    const current = groups.at(-1);
    if (current?.label === label) current.entries.push(entry);
    else groups.push({ label, entries: [entry] });
  }

  return (
    <div className="prio-activityfeed">
      {groups.map((group) => (
        <section key={group.label} className="prio-activityfeed__group">
          <h2 className="prio-activityfeed__group-title">{group.label}</h2>
          <ol className="prio-activity">
            {group.entries.map((entry) => (
              <li key={entry.id} className="prio-activity__item">
                <span className="prio-activity__rail" aria-hidden />
                <Avatar
                  name={entry.actor.name}
                  image={entry.actor.image}
                  size="sm"
                  className="prio-activity__avatar"
                />
                <div className="prio-activity__body">
                  <span className="prio-activity__text">{sentence(entry)}</span>
                  <span className="prio-activityfeed__meta">
                    <Link
                      href={`/projects/${entry.project.key.toLowerCase()}`}
                      className="prio-activityfeed__project"
                    >
                      {entry.project.name}
                    </Link>
                    <span aria-hidden>•</span>
                    <span>{entry.issue.key}</span>
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
        </section>
      ))}
    </div>
  );
}
