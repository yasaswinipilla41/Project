"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Alert, Button, CardBody } from "@/components/ui/primitives";
import { Dialog } from "@/components/ui/Dialog";
import {
  IconArrowRight,
  IconCalendar,
  IconCheck,
  IconEdit,
  IconPlus,
  IconTrash,
  IconUsers,
  IconWarning,
} from "@/components/ui/Icon";
import { useToast } from "@/components/ui/Toast";
import { isClosedStatus, SPRINT_STATUS_LABEL } from "@/lib/domain";
import { formatDateRange, formatOrdinalDate } from "@/lib/format";
import { deleteSprint, startSprint } from "@/server/sprints";
import type { SprintIssueSummary, SprintView } from "@/server/queries/sprints";
import { AddSprintIssuesDialog } from "./AddSprintIssuesDialog";
import { CompleteSprintDialog } from "./CompleteSprintDialog";
import { SprintFormDialog } from "./SprintFormDialog";

/**
 * One sprint, in whichever of its three states it is in: its name (the link to
 * its own page), goal, dates, figures and progress, and the actions that stage
 * allows — Add issues, Edit, Start, Complete, Delete.
 *
 * The block is a summary. The sprint's issues are listed on its own page,
 * grouped by the status each is in, rather than repeated inside every block
 * here.
 *
 * The lifecycle actions are only rendered for somebody who may perform them,
 * and that is presentation alone: `startSprint` and `completeSprint` both
 * check on the server, and a hidden button is never the control.
 */

export function SprintCard({
  sprint,
  projectId,
  projectKey,
  backlog,
  otherOpenSprints,
  canEdit,
  canDelete,
  canStart,
  canComplete,
  canEditIssues,
}: {
  sprint: SprintView;
  projectId: string;
  projectKey: string;
  /** This project's unsprinted open work — the only thing that can be added. */
  backlog: SprintIssueSummary[];
  /** Other sprints in this project that could receive unfinished work. */
  otherOpenSprints: { id: string; name: string }[];
  /** May rename this sprint or move its dates. */
  canEdit: boolean;
  /** May delete this sprint outright. */
  canDelete: boolean;
  /** May move this sprint from Planned to Active. */
  canStart: boolean;
  /** May close this sprint out and say where unfinished work goes. */
  canComplete: boolean;
  /** May put issues into it, take them out, or move them elsewhere — every
   *  working role. */
  canEditIssues: boolean;
}) {
  const router = useRouter();
  const { toast } = useToast();

  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(false);
  const [closing, setClosing] = useState(false);
  const [starting, setStarting] = useState(false);
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

  return (
    /* A card, written out rather than built with `Card`, because the status
       has to reach the CSS as an attribute and `Card` takes only a class. */
    <section className="prio-card prio-sprint" data-status={sprint.status}>
      <CardBody>
        <header className="prio-sprint__head">
          <div className="prio-sprint__identity">
            <h3 className="prio-sprint__name">
              {/* Only the name is the link to this sprint's own page, and it
                  reads as one — link colour, an arrow, an underline on hover.
                  Goal, dates and the actions to the right are not links, so a
                  click on any of them is never taken as navigation. */}
              <Link
                href={`/projects/${projectKey.toLowerCase()}/sprints/${sprint.id}`}
                className="prio-sprint__identitylink"
                title={`Open ${sprint.name}`}
              >
                {sprint.name}
                {/* The period, beside the name rather than only below it: a
                    list of sprints is read to find out which one covers now,
                    and that question should be answered by the line that
                    names them. */}
                <span className="prio-sprint__range">
                  ({formatDateRange(sprint.startDate, sprint.endDate)})
                </span>
                <IconArrowRight size={14} aria-hidden />
              </Link>
              <span className="prio-sprint__status" data-status={sprint.status}>
                {SPRINT_STATUS_LABEL[sprint.status]}
              </span>
            </h3>
            {sprint.goal ? (
              <p className="prio-sprint__goal">{sprint.goal}</p>
            ) : null}
            <p className="prio-sprint__dates">
              <IconCalendar size={13} />
              {formatOrdinalDate(sprint.startDate)} →{" "}
              {formatOrdinalDate(sprint.endDate)}
              {sprint.completedAt ? (
                <span className="prio-text-muted">
                  {" "}
                  · closed {formatOrdinalDate(sprint.completedAt)}
                </span>
              ) : null}
            </p>
          </div>

          <div className="prio-sprint__actions">
            {live && canEditIssues ? (
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                aria-label="Add issues"
                title="Add issues"
                onClick={() => setAdding(true)}
              >
                <IconPlus size={18} />
              </Button>
            ) : null}

            {live && canEdit ? (
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                aria-label="Edit"
                title="Edit"
                onClick={() => setEditing(true)}
              >
                <IconEdit size={18} />
              </Button>
            ) : null}

            {sprint.status === "PLANNED" && canStart ? (
              <Button
                variant="brand"
                size="sm"
                loading={starting}
                onClick={() => void start()}
              >
                Start sprint
              </Button>
            ) : null}

            {sprint.status === "ACTIVE" && canComplete ? (
              <Button variant="brand" size="sm" onClick={() => setClosing(true)}>
                <IconCheck size={13} />
                Complete sprint
              </Button>
            ) : null}

            {/* Deleting is an administrator's, like editing and completing,
                and `deleteSprint` says so again on the server. Offered
                whatever the sprint's state: a plan that was never run and a
                sprint that was are both things an administrator may clear
                away. */}
            {canDelete ? (
              <Button
                variant="danger"
                size="sm"
                iconOnly
                aria-label="Delete sprint"
                title="Delete sprint"
                onClick={() => setDeleting(true)}
              >
                <IconTrash size={13} />
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

        <div className="prio-sprint__progressrow">
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
          <span className="prio-sprint__progresslabel" aria-hidden>
            {stats.progress}%
          </span>
        </div>

        {/* The block is a summary: its issues are listed, by status, on the
            sprint's own page behind its name. Only an empty sprint says so
            here, since that is what stands between it and Start sprint. */}
        {sprint.issues.length === 0 ? (
          <p className="prio-text-muted prio-sprint__empty">
            No issues in this sprint yet.
            {sprint.status === "PLANNED"
              ? " Add some from the backlog before starting it."
              : ""}
          </p>
        ) : null}
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
