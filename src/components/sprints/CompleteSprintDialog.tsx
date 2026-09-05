"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Dialog } from "@/components/ui/Dialog";
import { Alert, Button } from "@/components/ui/primitives";
import { IconCheck } from "@/components/ui/Icon";
import { IssueKey, IssueTypeIcon, StatusPill } from "@/components/ui/Indicators";
import { useToast } from "@/components/ui/Toast";
import { completeSprint } from "@/server/sprints";
import type { SprintIssueSummary } from "@/server/queries/sprints";

/**
 * Close a sprint out, and decide where the work it did not finish goes.
 *
 * The state of the sprint is calculated before anything is asked: the two
 * lists below are this sprint's real issues at their real current statuses,
 * split on the same `CLOSED_STATUSES` the board reads. Nothing is estimated
 * and nothing is remembered from earlier.
 *
 * The destination is a required choice, not a default — leaving unfinished
 * work with nowhere to go is the failure this dialog exists to prevent. Both
 * options keep the issues in this project: the backlog is this project's
 * backlog, and only this project's other open sprints are offered.
 */
export function CompleteSprintDialog({
  sprintId,
  sprintName,
  completed,
  incomplete,
  nextSprints,
  onClose,
}: {
  sprintId: string;
  sprintName: string;
  completed: SprintIssueSummary[];
  incomplete: SprintIssueSummary[];
  /** Other sprints in this project that are not completed. */
  nextSprints: { id: string; name: string }[];
  onClose: () => void;
}) {
  const router = useRouter();
  const { toast } = useToast();

  const [destination, setDestination] = useState<"BACKLOG" | "NEXT_SPRINT">(
    "BACKLOG",
  );
  const [nextSprintId, setNextSprintId] = useState(nextSprints[0]?.id ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function finish() {
    setSaving(true);
    setError(null);

    const result = await completeSprint({
      sprintId,
      moveIncompleteTo: destination,
      nextSprintId: destination === "NEXT_SPRINT" ? nextSprintId : "",
    });

    setSaving(false);

    if (!result.ok) {
      setError(result.error);
      return;
    }

    onClose();
    toast(
      <>
        Completed <strong>{sprintName}</strong> — {result.data.completed} done,{" "}
        {result.data.moved} carried over
      </>,
    );
    router.refresh();
  }

  return (
    <Dialog
      open
      onClose={() => (saving ? undefined : onClose())}
      busy={saving}
      size="lg"
      title={`Complete ${sprintName}`}
      description="This closes the sprint. Its record — the issues it held and how each of them ended — is kept."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="brand" onClick={() => void finish()} loading={saving}>
            Complete sprint
          </Button>
        </>
      }
    >
      {error ? <Alert tone="danger">{error}</Alert> : null}

      <div className="prio-sprintclose">
        <section>
          <h3 className="prio-sprintclose__heading">
            Completed
            <span className="prio-sprintclose__count">{completed.length}</span>
          </h3>
          {completed.length === 0 ? (
            <p className="prio-text-muted">Nothing in this sprint was finished.</p>
          ) : (
            <ul className="prio-sprintclose__list">
              {completed.map((issue) => (
                <li key={issue.id} className="prio-sprintclose__item">
                  <IconCheck size={13} />
                  <IssueTypeIcon type={issue.type} size={14} />
                  <IssueKey issueKey={issue.key} />
                  <span className="prio-truncate">{issue.title}</span>
                  <StatusPill status={issue.status} />
                </li>
              ))}
            </ul>
          )}
        </section>

        <section>
          <h3 className="prio-sprintclose__heading">
            Incomplete
            <span className="prio-sprintclose__count">{incomplete.length}</span>
          </h3>
          {incomplete.length === 0 ? (
            <p className="prio-text-muted">
              Everything in this sprint was finished.
            </p>
          ) : (
            <>
              <ul className="prio-sprintclose__list">
                {incomplete.map((issue) => (
                  <li
                    key={issue.id}
                    className="prio-sprintclose__item"
                    data-incomplete
                  >
                    <span className="prio-sprintclose__dot" aria-hidden />
                    <IssueTypeIcon type={issue.type} size={14} />
                    <IssueKey issueKey={issue.key} />
                    <span className="prio-truncate">{issue.title}</span>
                    <StatusPill status={issue.status} />
                  </li>
                ))}
              </ul>

              <fieldset className="prio-sprintclose__destination">
                <legend className="prio-label">
                  Move incomplete issues to
                </legend>

                <label className="prio-sprintclose__choice">
                  <input
                    type="radio"
                    name="sprint-destination"
                    value="BACKLOG"
                    checked={destination === "BACKLOG"}
                    onChange={() => setDestination("BACKLOG")}
                  />
                  <span>
                    Backlog
                    <span className="prio-hint">
                      Back into this project&rsquo;s backlog, in no sprint.
                    </span>
                  </span>
                </label>

                <label
                  className="prio-sprintclose__choice"
                  data-disabled={nextSprints.length === 0 || undefined}
                >
                  <input
                    type="radio"
                    name="sprint-destination"
                    value="NEXT_SPRINT"
                    checked={destination === "NEXT_SPRINT"}
                    disabled={nextSprints.length === 0}
                    onChange={() => setDestination("NEXT_SPRINT")}
                  />
                  <span>
                    Next sprint
                    <span className="prio-hint">
                      {nextSprints.length === 0
                        ? "There is no other open sprint in this project yet."
                        : "Carried into another sprint in this project."}
                    </span>
                  </span>
                </label>

                {destination === "NEXT_SPRINT" && nextSprints.length > 0 ? (
                  <select
                    className="prio-select"
                    aria-label="Sprint to move them into"
                    value={nextSprintId}
                    onChange={(event) => setNextSprintId(event.target.value)}
                  >
                    {nextSprints.map((sprint) => (
                      <option key={sprint.id} value={sprint.id}>
                        {sprint.name}
                      </option>
                    ))}
                  </select>
                ) : null}
              </fieldset>
            </>
          )}
        </section>
      </div>
    </Dialog>
  );
}
