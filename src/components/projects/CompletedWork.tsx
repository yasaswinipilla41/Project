import Link from "next/link";
import type { IssueType } from "@prisma/client";
import { Avatar } from "@/components/ui/primitives";
import { IssueKey, IssueTypeIcon } from "@/components/ui/Indicators";

/**
 * Completed work, grouped by the person who actually completed it.
 *
 * The distinction this section exists for: **the assignee is not necessarily
 * the person who finished the work.** An issue can be reassigned, picked up by
 * whoever was free, or closed by a reviewer, and the `assigneeId` on the row
 * only ever says who holds it now. Who moved it to Done is a different fact,
 * and Prio already records it — `updateIssue` writes an `ActivityLogEntry`
 * with `field: "status"` and `newValue: "DONE"` naming the actor, and that
 * entry is what the page reads.
 *
 * Where that entry does not exist — work completed before the trail existed,
 * or imported — the person is genuinely unknown, and the section says so
 * rather than naming the assignee and hoping. Guessing here would be worse
 * than silence: it would attribute somebody else's work to whoever happens to
 * hold the issue today.
 *
 * Clicking a completed issue opens that person's work in this project, which
 * is the project's own List view filtered by them — an existing route, and
 * project-scoped, so nothing from another project can appear behind it.
 */

export interface CompletedIssue {
  id: string;
  key: string;
  title: string;
  type: IssueType;
}

export interface CompletedByPerson {
  /** `null` when no status-change entry records who completed these. */
  id: string | null;
  name: string;
  image: string | null;
  issues: CompletedIssue[];
}

/** How many keys are listed under a person before the rest are summarised. */
const KEYS_SHOWN = 8;

export function CompletedWork({
  people,
  projectKey,
}: {
  people: CompletedByPerson[];
  projectKey: string;
}) {
  if (people.length === 0) {
    return (
      <p className="prio-text-muted">
        Nothing has been completed in this project yet.
      </p>
    );
  }

  const base = `/projects/${projectKey.toLowerCase()}/list`;

  return (
    <ul className="prio-completed">
      {people.map((person) => {
        const shown = person.issues.slice(0, KEYS_SHOWN);
        const rest = person.issues.length - shown.length;

        return (
          <li key={person.id ?? "unknown"} className="prio-completed__person">
            <div className="prio-completed__head">
              <Avatar
                name={person.id === null ? null : person.name}
                image={person.image}
                size="xs"
                empty={person.id === null}
                /* The empty avatar reads "Unassigned" by default, which is a
                   different fact: nobody said who did this, not nobody holds
                   it. */
                title={person.id === null ? "Not recorded" : person.name}
              />
              <span className="prio-completed__name prio-truncate">
                {person.name}
              </span>
              <span className="prio-completed__count">
                {person.issues.length}
              </span>
            </div>

            <ul className="prio-completed__issues">
              {shown.map((issue) => {
                const label = `${issue.key} — ${issue.title}`;

                /* Named, so the issue leads to their work. Unknown, so there
                   is nobody to lead to: the key is still shown, as plain text,
                   because the fact that it was completed is true either way. */
                return (
                  <li key={issue.id}>
                    {person.id === null ? (
                      <span
                        className="prio-completed__issue"
                        title={`${label} — who completed it was not recorded`}
                      >
                        <IssueTypeIcon type={issue.type} size={13} />
                        <IssueKey issueKey={issue.key} />
                      </span>
                    ) : (
                      <Link
                        href={`${base}?assignee=${person.id}`}
                        className="prio-completed__issue"
                        title={`${label} — completed by ${person.name}. Open their work in this project.`}
                      >
                        <IssueTypeIcon type={issue.type} size={13} />
                        <IssueKey issueKey={issue.key} />
                      </Link>
                    )}
                  </li>
                );
              })}

              {rest > 0 ? (
                <li className="prio-completed__more">+{rest} more</li>
              ) : null}
            </ul>
          </li>
        );
      })}
    </ul>
  );
}
