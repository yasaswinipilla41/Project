"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Alert, Avatar, Button, CardBody } from "@/components/ui/primitives";
import { Dialog } from "@/components/ui/Dialog";
import {
  IconCalendar,
  IconCheck,
  IconClose,
  IconPlus,
  IconTrash,
  IconUsers,
  IconWarning,
} from "@/components/ui/Icon";
import { IssueKey, IssueTypeIcon, StatusPill } from "@/components/ui/Indicators";
import { useToast } from "@/components/ui/Toast";
import { BOARD_STATUSES, boardColumnFor } from "@/lib/board";
import { isClosedStatus, STATUS_LABEL } from "@/lib/domain";
import { formatDateCompact } from "@/lib/format";
import {
  deleteSprint,
  removeIssueFromSprint,
  startSprint,
} from "@/server/sprints";
import type { SprintIssueSummary, SprintView } from "@/server/queries/sprints";
import { AddSprintIssuesDialog } from "./AddSprintIssuesDialog";
import { CompleteSprintDialog } from "./CompleteSprintDialog";
import { SprintFormDialog } from "./SprintFormDialog";

/**
 * One sprint, in whichever of its three states it is in.
 *
 * The same card throughout its life, showing what that stage of it is for:
 *
 *   PLANNED    the work chosen so far, with a way to add more or take some
 *              back out, and Start Sprint at the end of it — which is the
 *              plan-then-start step in one place rather than two pages.
 *   ACTIVE     the work as a board, grouped by each issue's *current* status.
 *              Nothing is stored here: move a card on the Flow Board and this
 *              regroups, because both read `Issue.status`.
 *   COMPLETED  its record — what was finished, what was not, and the figures
 *              as they stood when it closed.
 *
 * The lifecycle actions are only rendered for somebody who may perform them,
 * and that is presentation alone: `startSprint` and `completeSprint` both
 * check on the server, and a hidden button is never the control.
 */

function SprintIssueRow({
  issue,
  onRemove,
  removing,
}: {
  issue: SprintIssueSummary;
  onRemove?: () => void;
  removing?: boolean;
}) {
  return (
    <li className="prio-sprint__issue">
      <Link
        href={`/issues/${issue.key.toLowerCase()}`}
        className="prio-sprint__issuelink"
      >
        <IssueTypeIcon type={issue.type} size={15} />
        <IssueKey issueKey={issue.key} />
        <span className="prio-sprint__issuetitle prio-truncate">
          {issue.title}
        </span>
        <StatusPill status={issue.status} />
      </Link>

      {issue.assignee ? (
        <Avatar
          name={issue.assignee.name}
          image={issue.assignee.image}
          size="xs"
        />
      ) : (
        <Avatar name={null} size="xs" empty />
      )}

      {onRemove ? (
        <button
          type="button"
          className="prio-btn prio-btn--ghost prio-btn--icon prio-btn--sm"
          aria-label={`Remove ${issue.key} from this sprint`}
          title="Remove from sprint"
          disabled={removing}
          onClick={onRemove}
        >
          <IconClose size={13} />
        </button>
      ) : null}
    </li>
  );
}

export function SprintCard({
  sprint,
  projectId,
  projectKey,
  backlog,
  otherOpenSprints,
  canManage,
  canEditIssues,
}: {
  sprint: SprintView;
  projectId: string;
  projectKey: string;
  /** This project's unsprinted open work — the only thing that can be added. */
  backlog: SprintIssueSummary[];
  /** Other sprints in this project that could receive unfinished work. */
  otherOpenSprints: { id: string; name: string }[];
  /** May start, complete and edit this sprint. */
  canManage: boolean;
  /** May put issues into it and take them out — anyone on the project. */
  canEditIssues: boolean;
}) {
  const router = useRouter();
  const { toast } = useToast();

  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(false);
  const [closing, setClosing] = useState(false);
  const [starting, setStarting] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deletePending, setDeletePending] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const { stats } = sprint;
  const live = sprint.status !== "COMPLETED";

  async function start() {
    setStarting(true);
    const result = await startSprint({ sprintId: sprint.id });
    setStarting(false);

    if (!result.ok) {
      toast(result.error, "error");
      return;
    }
    toast(
      <>
        <strong>{sprint.name}</strong> is now active
      </>,
    );
    router.refresh();
  }

  async function confirmDelete() {
    setDeletePending(true);
    setDeleteError(null);

    const result = await deleteSprint({ sprintId: sprint.id });

    if (!result.ok) {
      setDeletePending(false);
      setDeleteError(result.error);
      return;
    }

    setDeletePending(false);
    setDeleting(false);
    toast(
      <>
        Deleted <strong>{sprint.name}</strong>
      </>,
    );
    /* The list this card is in is rendered on the server, so the card goes
       when that re-renders — not by being hidden here. A refresh afterwards
       shows the same thing, because the row really is gone. */
    router.refresh();
  }

  async function remove(issueId: string, issueKey: string) {
    setRemovingId(issueId);
    const result = await removeIssueFromSprint({ sprintId: sprint.id, issueId });
    setRemovingId(null);

    if (!result.ok) {
      toast(result.error, "error");
      return;
    }
    toast(`${issueKey} moved back to the backlog`);
    router.refresh();
  }

  /* The active sprint's board: the same columns the Flow Board uses, and the
     same `boardColumnFor` deciding which one an issue is drawn in — so a
     Reopened issue lands in New and a Rejected one in Done here exactly as it
     does there. Empty columns are dropped: this is a read of the sprint, not
     a board to drag onto. */
  const columns = BOARD_STATUSES.map((column) => ({
    column,
    issues: sprint.issues.filter((issue) => boardColumnFor(issue.status) === column),
  })).filter((entry) => entry.issues.length > 0);

  return (
    /* A card, written out rather than built with `Card`, because the status
       has to reach the CSS as an attribute and `Card` takes only a class. */
    <section className="prio-card prio-sprint" data-status={sprint.status}>
      <CardBody>
        <header className="prio-sprint__head">
          <div className="prio-sprint__identity">
            <h3 className="prio-sprint__name">
              {sprint.name}
              <span className="prio-sprint__status" data-status={sprint.status}>
                {sprint.status === "ACTIVE"
                  ? "Active"
                  : sprint.status === "PLANNED"
                    ? "Planned"
                    : "Completed"}
              </span>
            </h3>
            {sprint.goal ? (
              <p className="prio-sprint__goal">{sprint.goal}</p>
            ) : null}
            <p className="prio-sprint__dates">
              <IconCalendar size={13} />
              {formatDateCompact(sprint.startDate)} →{" "}
              {formatDateCompact(sprint.endDate)}
              {sprint.completedAt ? (
                <span className="prio-text-muted">
                  {" "}
                  · closed {formatDateCompact(sprint.completedAt)}
                </span>
              ) : null}
            </p>
          </div>

          <div className="prio-sprint__actions">
            {live && canEditIssues ? (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setAdding(true)}
              >
                <IconPlus size={13} />
                Add issues
              </Button>
            ) : null}

            {live && canManage ? (
              <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
                Edit
              </Button>
            ) : null}

            {sprint.status === "PLANNED" && canManage ? (
              <Button
                variant="brand"
                size="sm"
                loading={starting}
                onClick={() => void start()}
              >
                Start sprint
              </Button>
            ) : null}

            {sprint.status === "ACTIVE" && canManage ? (
              <Button variant="brand" size="sm" onClick={() => setClosing(true)}>
                <IconCheck size={13} />
                Complete sprint
              </Button>
            ) : null}

            {/* Deleting is an administrator's, like the rest of this row, and
                `deleteSprint` says so again on the server. Offered whatever
                the sprint's state: a plan that was never run and a sprint that
                was are both things an administrator may clear away. */}
            {canManage ? (
              <Button
                variant="danger-outline"
                size="sm"
                onClick={() => setDeleting(true)}
              >
                <IconTrash size={13} />
                Delete sprint
              </Button>
            ) : null}
          </div>
        </header>

        {/* ------------------------------------------------------ summary */}
        {/* Counted from the issues themselves every time this renders, so a
            status change anywhere in Prio moves these figures. */}
        <div className="prio-sprint__summary">
          <span className="prio-sprint__stat">
            <span className="prio-sprint__statvalue">{stats.total}</span>
            <span className="prio-sprint__statlabel">Total</span>
          </span>
          <span className="prio-sprint__stat" data-tone="success">
            <span className="prio-sprint__statvalue">{stats.completed}</span>
            <span className="prio-sprint__statlabel">Completed</span>
          </span>
          <span className="prio-sprint__stat">
            <span className="prio-sprint__statvalue">{stats.remaining}</span>
            <span className="prio-sprint__statlabel">Remaining</span>
          </span>
          <span className="prio-sprint__stat">
            <span className="prio-sprint__statvalue">{stats.progress}%</span>
            <span className="prio-sprint__statlabel">Progress</span>
          </span>
          <span className="prio-sprint__stat">
            <span className="prio-sprint__statvalue">
              <IconUsers size={13} /> {stats.assignees}
            </span>
            <span className="prio-sprint__statlabel">Assignees</span>
          </span>
        </div>

        <div
          className="prio-progress"
          role="img"
          aria-label={`${stats.progress}% of this sprint's work is finished`}
        >
          <div
            className="prio-progress__bar"
            style={{ width: `${stats.progress}%` }}
          />
        </div>

        {/* --------------------------------------------------------- body */}
        {sprint.issues.length === 0 ? (
          <p className="prio-text-muted prio-sprint__empty">
            No issues in this sprint yet.
            {sprint.status === "PLANNED"
              ? " Add some from the backlog before starting it."
              : ""}
          </p>
        ) : sprint.status === "ACTIVE" ? (
          <div className="prio-sprint__board">
            {columns.map(({ column, issues }) => (
              <section key={column} className="prio-sprint__column">
                <h4 className="prio-sprint__columnhead">
                  {STATUS_LABEL[column]}
                  <span className="prio-sprint__columncount">{issues.length}</span>
                </h4>
                <ul className="prio-sprint__issues">
                  {issues.map((issue) => (
                    <SprintIssueRow
                      key={issue.id}
                      issue={issue}
                      onRemove={
                        canEditIssues
                          ? () => void remove(issue.id, issue.key)
                          : undefined
                      }
                      removing={removingId === issue.id}
                    />
                  ))}
                </ul>
              </section>
            ))}
          </div>
        ) : sprint.status === "PLANNED" ? (
          <ul className="prio-sprint__issues">
            {sprint.issues.map((issue) => (
              <SprintIssueRow
                key={issue.id}
                issue={issue}
                onRemove={
                  canEditIssues ? () => void remove(issue.id, issue.key) : undefined
                }
                removing={removingId === issue.id}
              />
            ))}
          </ul>
        ) : (
          /* Completed: the record, read from the outcome rows written when the
             sprint closed — not from where the issues happen to be today. */
          <div className="prio-sprint__record">
            <section>
              <h4 className="prio-sprint__recordhead">
                Completed
                <span className="prio-sprint__columncount">
                  {sprint.outcome?.completed.length ?? 0}
                </span>
              </h4>
              {sprint.outcome && sprint.outcome.completed.length > 0 ? (
                <ul className="prio-sprint__issues">
                  {sprint.outcome.completed.map((issue) => (
                    <SprintIssueRow key={issue.id} issue={issue} />
                  ))}
                </ul>
              ) : (
                <p className="prio-text-muted">Nothing was finished.</p>
              )}
            </section>

            <section>
              <h4 className="prio-sprint__recordhead">
                Incomplete
                <span className="prio-sprint__columncount">
                  {sprint.outcome?.incomplete.length ?? 0}
                </span>
              </h4>
              {sprint.outcome && sprint.outcome.incomplete.length > 0 ? (
                <ul className="prio-sprint__issues">
                  {sprint.outcome.incomplete.map((issue) => (
                    <SprintIssueRow key={issue.id} issue={issue} />
                  ))}
                </ul>
              ) : (
                <p className="prio-text-muted">
                  Everything in this sprint was finished.
                </p>
              )}
            </section>
          </div>
        )}
      </CardBody>

      {adding ? (
        <AddSprintIssuesDialog
          sprintId={sprint.id}
          sprintName={sprint.name}
          projectKey={projectKey}
          backlog={backlog}
          onClose={() => setAdding(false)}
        />
      ) : null}

      {editing ? (
        <SprintFormDialog
          projectId={projectId}
          sprint={{
            id: sprint.id,
            name: sprint.name,
            goal: sprint.goal,
            startDate: sprint.startDate,
            endDate: sprint.endDate,
          }}
          onClose={() => setEditing(false)}
        />
      ) : null}

      {closing ? (
        <CompleteSprintDialog
          sprintId={sprint.id}
          sprintName={sprint.name}
          completed={sprint.issues.filter((issue) => isClosedStatus(issue.status))}
          incomplete={sprint.issues.filter(
            (issue) => !isClosedStatus(issue.status),
          )}
          nextSprints={otherOpenSprints}
          onClose={() => setClosing(false)}
        />
      ) : null}

      {/* The same confirmation the issue page uses to delete an issue — the
          shape, the tone and the wording of a destructive action in Prio are
          established, and this is that pattern rather than another one. */}
      {deleting ? (
        <Dialog
          open
          onClose={() => (deletePending ? undefined : setDeleting(false))}
          busy={deletePending}
          title="Delete sprint?"
          description="This cannot be undone."
          footer={
            <>
              <Button
                variant="ghost"
                onClick={() => setDeleting(false)}
                disabled={deletePending}
              >
                Cancel
              </Button>
              <Button
                variant="danger"
                onClick={() => void confirmDelete()}
                loading={deletePending}
              >
                {deletePending ? "Deleting…" : "Delete sprint"}
              </Button>
            </>
          }
        >
          {deleteError ? (
            <div style={{ marginBottom: "var(--prio-space-5)" }}>
              <Alert tone="danger" icon={<IconWarning />}>
                {deleteError}
              </Alert>
            </div>
          ) : null}

          <Alert tone="danger" icon={<IconWarning />}>
            Deleting <strong>{sprint.name}</strong> removes the sprint and its
            record of how it went. Its{" "}
            {stats.total === 1 ? "issue" : `${stats.total} issues`} stay exactly
            as they are and return to the backlog.
          </Alert>
        </Dialog>
      ) : null}
    </section>
  );
}
