"use client";

import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { Alert, Button } from "@/components/ui/primitives";
import { Dialog } from "@/components/ui/Dialog";
import { IconEdit, IconPlus, IconTrash, IconWarning } from "@/components/ui/Icon";
import { useToast } from "@/components/ui/Toast";
import { deleteSprint, startSprint } from "@/server/sprints";
import type { SprintIssueSummary, SprintView } from "@/server/queries/sprints";
import { AddSprintIssuesDialog } from "./AddSprintIssuesDialog";
import { SprintFormDialog } from "./SprintFormDialog";

/**
 * What can be done to a sprint, from its own page.
 *
 * The same four actions the sprint's block on the Sprints page offers, in the
 * same controls: Add issues and Edit for every working role, and Start sprint
 * and Delete for an administrator. Nothing here is a second implementation —
 * the dialogs are `AddSprintIssuesDialog` and `SprintFormDialog`, and starting
 * and deleting are `startSprint` and `deleteSprint`, which re-check on the
 * server who is asking. What this component decides is only what is worth
 * drawing.
 *
 * One thing differs from the block, and has to: deleting a sprint from the
 * sprint's own page destroys the page. So a delete leaves for the list it came
 * from, rather than re-reading a route that would now be a not-found.
 *
 * `leading` is the one thing in this row that is not an action on the sprint:
 * the button that opens its burndown. It is passed in rather than built here
 * because reading the chart is nobody's permission — it goes in this row, and
 * in front of the rest of it, but it is not one of the four things below.
 */
export function SprintDetailsActions({
  sprint,
  leading,
  projectId,
  projectKey,
  backlog,
  canEditIssues,
  canEdit,
  canStart,
  canDelete,
  /** Where a delete leaves to — the list this page was opened from. */
  backHref,
}: {
  sprint: SprintView;
  /** Drawn first in the row, before every action: the burndown's own button. */
  leading?: ReactNode;
  projectId: string;
  projectKey: string;
  /** This project's unsprinted open work — the only thing that can be added. */
  backlog: SprintIssueSummary[];
  /** May put issues into this sprint or take them out — every working role. */
  canEditIssues: boolean;
  /** May rename this sprint or move its dates. */
  canEdit: boolean;
  /** May move this sprint from Planned to Active. */
  canStart: boolean;
  /** May delete this sprint outright. */
  canDelete: boolean;
  backHref: string;
}) {
  const router = useRouter();
  const { toast } = useToast();

  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(false);
  const [starting, setStarting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deletePending, setDeletePending] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  /* A completed sprint is a closed record: its work does not move and its
     dates do not change. Deleting one is still an administrator's to do. */
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
    /* This page was the sprint, so there is nowhere to stay. `replace` rather
       than `push`: going back to a deleted sprint is not somewhere to go. */
    router.replace(backHref);
  }

  const nothingToShow =
    !canDelete &&
    !(live && canEditIssues) &&
    !(live && canEdit) &&
    !(sprint.status === "PLANNED" && canStart);
  /* Somebody who may change nothing here may still read the burndown, so the
     row survives for `leading` alone. */
  if (nothingToShow && !leading) return null;

  return (
    <>
      <div className="prio-sprint__actions">
        {leading}

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

      {/* The same confirmation the sprint's block uses, for the same reason:
          the shape and wording of a destructive action in Prio are
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
            {sprint.stats.total === 1 ? "issue" : `${sprint.stats.total} issues`}{" "}
            stay exactly as they are and return to the backlog.
          </Alert>
        </Dialog>
      ) : null}
    </>
  );
}
