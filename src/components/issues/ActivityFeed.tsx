import { Avatar } from "@/components/ui/primitives";
import { StatusPill } from "@/components/ui/Indicators";
import type { IssueLinkType } from "@prisma/client";
import { FIELD_LABEL, humanizeEnumValue, isIssueStatus } from "@/lib/domain";
import { LINK_LABEL } from "@/lib/issue-links";
import { formatDate, formatDateTime, formatRelative } from "@/lib/format";

/**
 * Immutable activity history (§31), rendered chronologically.
 *
 * Entries are never edited or deleted, so this is a faithful record: who did
 * what, and when. Values are resolved to names where the stored value is an id.
 */

export interface ActivityEntry {
  id: string;
  action: string;
  field: string | null;
  oldValue: string | null;
  newValue: string | null;
  createdAt: Date;
  actor: { id: string; name: string; image: string | null };
}

/** Maps user ids stored in `assigneeId` changes back to display names. */
export type NameLookup = Record<string, string>;

function describe(entry: ActivityEntry, names: NameLookup): React.ReactNode {
  if (entry.action === "issue.created") return "created this issue";
  if (entry.action === "bug.created") return "reported this bug";
  if (entry.action === "comment.created") return "added a comment";
  if (entry.action === "comment.edited") return "edited a comment";
  if (entry.action === "comment.deleted") return "deleted a comment";
  if (entry.action === "attachment.added") {
    return `attached ${entry.newValue ?? "a file"}`;
  }
  if (entry.action === "attachment.removed") {
    return `removed the attachment ${entry.oldValue ?? ""}`.trim();
  }
  if (entry.action === "link.added") {
    return `marked this as ${LINK_LABEL[entry.field as IssueLinkType] ?? "related to"} ${entry.newValue ?? ""}`.trim();
  }
  if (entry.action === "link.removed") {
    return `removed the link to ${entry.oldValue ?? "another issue"}`;
  }

  const field = entry.field;
  if (!field) return "updated this issue";

  const label = FIELD_LABEL[field] ?? field;

  // Status changes get the real pills so the workflow reads at a glance.
  if (field === "status") {
    const from = entry.oldValue;
    const to = entry.newValue;
    return (
      <>
        changed status
        {from && isIssueStatus(from) ? (
          <>
            {" from "}
            <StatusPill status={from} />
          </>
        ) : null}
        {to && isIssueStatus(to) ? (
          <>
            {" to "}
            <StatusPill status={to} />
          </>
        ) : null}
      </>
    );
  }

  const format = (value: string | null): string => {
    if (value === null || value === "") return "None";
    if (field === "assigneeId" || field === "reporterId") {
      return names[value] ?? "someone";
    }
    if (field === "dueDate") return formatDate(value);
    if (field === "parentId") return names[value] ?? value;
    if (field === "description" || field === "title") return "";
    return humanizeEnumValue(field, value);
  };

  // Long free-text fields are not diffed inline — the change is noted instead.
  if (field === "description" || field === "stepsToReproduce") {
    return `updated the ${label}`;
  }

  if (field === "assigneeId") {
    if (!entry.newValue) return "removed the assignee";
    if (!entry.oldValue) return `assigned this to ${format(entry.newValue)}`;
    return `reassigned this from ${format(entry.oldValue)} to ${format(entry.newValue)}`;
  }

  const from = format(entry.oldValue);
  const to = format(entry.newValue);

  if (!entry.oldValue) return `set the ${label} to ${to}`;
  if (!entry.newValue) return `cleared the ${label}`;
  return `changed the ${label} from ${from} to ${to}`;
}

/**
 * A single system event.
 *
 * Exported on its own so `IssueConversation` can interleave these with comment
 * cards in one chronological list — the wording of an event lives here, and
 * only here, whichever list it ends up in.
 */
export function ActivityFeedItem({
  entry,
  names,
}: {
  entry: ActivityEntry;
  names: NameLookup;
}) {
  return (
    <li className="prio-activity__item">
      <span className="prio-activity__rail" aria-hidden />
      <Avatar
        name={entry.actor.name}
        image={entry.actor.image}
        size="sm"
        className="prio-activity__avatar"
      />
      <div className="prio-activity__body">
        <span className="prio-activity__text">
          <strong>{entry.actor.name}</strong> {describe(entry, names)}
        </span>
        <time
          className="prio-activity__time"
          dateTime={entry.createdAt.toISOString()}
          title={formatDateTime(entry.createdAt)}
            /*
             * Relative time is computed from the clock, so the server's render
             * and the client's hydration can legitimately disagree by a tick —
             * "59m ago" against "1h ago". Without this, React treats that as a
             * mismatched tree and re-renders the subtree, which throws away the
             * comment composer's in-progress text along with it.
             *
             * The value is not wrong, only differently rounded, which is what
             * this attribute exists for. The exact instant is in `dateTime` and
             * in the tooltip either way.
             */
            suppressHydrationWarning
        >
          {formatRelative(entry.createdAt)}
        </time>
      </div>
    </li>
  );
}

export function ActivityFeed({
  entries,
  names,
}: {
  entries: ActivityEntry[];
  names: NameLookup;
}) {
  if (entries.length === 0) {
    return (
      <p className="prio-text-muted" style={{ fontSize: "var(--prio-text-sm)" }}>
        No activity recorded yet.
      </p>
    );
  }

  return (
    <ol className="prio-activity">
      {entries.map((entry) => (
        <ActivityFeedItem key={entry.id} entry={entry} names={names} />
      ))}
    </ol>
  );
}
