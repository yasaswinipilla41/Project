"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Menu, MenuItem, MenuSeparator } from "@/components/ui/Menu";
import { Dialog } from "@/components/ui/Dialog";
import { Alert, Button } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/Toast";
import {
  IconArrowRight,
  IconChevronLeft,
  IconCopy,
  IconEdit,
  IconMore,
  IconTrash,
  IconWarning,
} from "@/components/ui/Icon";
import { CloneIssueDialog } from "@/components/issues/CloneIssueDialog";
import {
  SprintMoveOptions,
  useSprintMove,
} from "@/components/sprints/MoveToSprintControl";
import { deleteIssue } from "@/server/issues";
import { moveIssueToSprint } from "@/server/sprints";
import type { WorkRole } from "@/lib/domain";

/**
 * The ⋮ menu at the end of a table row.
 *
 * "Open" and "Edit" both land on the issue detail page — Prio's editing is
 * inline there (every field is click-to-edit in place), so there is no
 * separate edit screen to route to. Offering a second link that goes to the
 * exact same place under a different name would be a menu item with nothing
 * behind it; wording it as "Edit issue" instead says plainly what happens
 * when it is clicked.
 *
 * Delete only appears for the people `deleteIssue` will actually let through —
 * the reporter or an administrator — so the menu never offers an action the
 * server is just going to refuse. That check is read from data already on the
 * row (`reporterId`, the viewer's own id and role); the server re-derives and
 * re-checks all of it independently.
 *
 * "Move to next sprint" is offered only where the issue is actually being
 * shown as part of a sprint, because that is the only place the phrase means
 * anything — see `inSprint`. It is this menu rather than a second control
 * beside it: an issue's actions belong in the menu an issue already has.
 */

export interface IssueRowActionsProps {
  issueId: string;
  issueKey: string;
  reporterId: string;
  currentUserId: string;
  isAdmin: boolean;
  /** Cloning files new work; the dialog offers the statuses that allows. */
  workRole: WorkRole;
  /**
   * Offer "Move to next sprint".
   *
   * Set where this row is a sprint's own issue. Everywhere else the menu is
   * used — the issue list, the Flow Board — an issue may have no sprint at
   * all, and an action whose name assumes one would be offering something
   * that cannot happen. `moveIssueToSprint` re-checks access and refuses a
   * move with nowhere to go, so this only decides whether to show it.
   */
  inSprint?: boolean;
  /**
   * Offer "Move Sprint": the issue's own sprint picker — every eligible sprint
   * in its project, not only the next — opened inside this menu.
   *
   * The Flow Board sets it for the people who may move sprint issues
   * (`canEditSprintIssues`) and for work that is not Done, which stays in the
   * sprint it was finished in. Presentation only: `eligibleSprintsForIssue`
   * and `moveIssueToSprint` re-check all of it on the server.
   */
  moveSprint?: boolean;
}

export function IssueRowActions({
  issueId,
  issueKey,
  reporterId,
  currentUserId,
  isAdmin,
  workRole,
  inSprint = false,
  moveSprint = false,
}: IssueRowActionsProps) {
  const router = useRouter();
  const { toast } = useToast();
  const [confirming, setConfirming] = useState(false);
  const [cloning, setCloning] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [moving, setMoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /*
   * Which page of the menu is showing: its actions, or — after "Move Sprint" —
   * the sprint picker, the same one the issue's own page has. It opens in
   * place rather than in a second popup, and every close of the menu puts it
   * back to the actions.
   */
  const [view, setView] = useState<"actions" | "sprints">("actions");
  const picker = useSprintMove(issueId, issueKey);

  const canDelete = isAdmin || reporterId === currentUserId;
  const href = `/issues/${issueKey.toLowerCase()}`;

  /**
   * Hands this issue to the next sprint, through the existing move.
   *
   * `moveIssueToSprint` is the one path a sprint change goes through — it
   * checks project access and the same edit rule every other sprint write
   * does, refuses a completed sprint, works out which sprint is next by start
   * date, and records the change on the issue's trail. It writes `sprintId`
   * and nothing else, which is what keeps the issue's status exactly where it
   * was. Nothing about any of that is re-implemented here.
   *
   * The refresh afterwards is the page's own: both sprints' issue lists,
   * their totals and the chart are read from the same query on the next
   * render, so none of them needs telling separately.
   */
  async function moveToNextSprint() {
    setMoving(true);
    const result = await moveIssueToSprint({
      issueId,
      destination: { type: "NEXT_SPRINT" },
    });
    setMoving(false);

    if (!result.ok) {
      toast(result.error, "error");
      return;
    }
    toast(
      <>
        Moved {issueKey} to {result.data.sprintName}
      </>,
    );
    router.refresh();
  }

  async function confirmDelete() {
    setDeleting(true);
    setError(null);

    const result = await deleteIssue(issueId);

    if (!result.ok) {
      setDeleting(false);
      setError(result.error);
      return;
    }

    setConfirming(false);
    toast(<>Deleted {result.data.key}</>);
    router.refresh();
  }

  return (
    <>
      <Menu
        align="end"
        /* The picker is as wide as the issue page's, for the sprints' dates;
           the actions keep their own width. */
        width={view === "sprints" ? "min(340px, calc(100vw - 32px))" : 180}
        label={`Actions for ${issueKey}`}
        onOpenChange={(open) => {
          if (!open) setView("actions");
        }}
        trigger={(props) => (
          <button
            type="button"
            className="prio-btn prio-btn--ghost prio-btn--icon prio-btn--sm"
            aria-label={`Actions for ${issueKey}`}
            {...props}
          >
            <IconMore size={14} />
          </button>
        )}
      >
        {view === "sprints" ? (
          <>
            <MenuItem
              keepOpen
              icon={<IconChevronLeft />}
              onSelect={() => setView("actions")}
            >
              Back
            </MenuItem>
            <MenuSeparator />
            <SprintMoveOptions picker={picker} />
          </>
        ) : (
          <>
            <MenuItem href={href} icon={<IconEdit />}>
              Open / edit
            </MenuItem>
            {/* Cloning creates an issue, which any project member may already do —
            the same gate the Create dialog has, re-checked on the server. */}
            <MenuItem icon={<IconCopy />} onSelect={() => setCloning(true)}>
              Clone
            </MenuItem>
            {inSprint ? (
              <MenuItem
                icon={<IconArrowRight />}
                disabled={moving}
                onSelect={() => void moveToNextSprint()}
              >
                {moving ? "Moving…" : "Move to next sprint"}
              </MenuItem>
            ) : null}
            {moveSprint ? (
              <MenuItem
                keepOpen
                icon={<IconArrowRight />}
                disabled={picker.moving}
                onSelect={() => {
                  setView("sprints");
                  /* Read where it may go now, as the issue page's picker does on
                 opening — once, until a move or a failure asks again. */
                  if (picker.load.state === "idle") void picker.read();
                }}
              >
                {picker.moving ? "Moving…" : "Move Sprint"}
              </MenuItem>
            ) : null}
            {canDelete ? (
              <>
                <MenuSeparator />
                <MenuItem
                  danger
                  icon={<IconTrash />}
                  onSelect={() => setConfirming(true)}
                >
                  Delete
                </MenuItem>
              </>
            ) : null}
          </>
        )}
      </Menu>

      {cloning ? (
        <CloneIssueDialog
          workRole={workRole}
          issueId={issueId}
          issueKey={issueKey}
          onClose={() => setCloning(false)}
        />
      ) : null}

      {confirming ? (
        <Dialog
          open
          onClose={() => (deleting ? undefined : setConfirming(false))}
          busy={deleting}
          title="Delete issue?"
          description="This cannot be undone."
          footer={
            <>
              <Button
                variant="ghost"
                onClick={() => setConfirming(false)}
                disabled={deleting}
              >
                Cancel
              </Button>
              <Button
                variant="danger"
                onClick={() => void confirmDelete()}
                loading={deleting}
              >
                {deleting ? "Deleting…" : "Delete issue"}
              </Button>
            </>
          }
        >
          {error ? (
            <div style={{ marginBottom: "var(--prio-space-5)" }}>
              <Alert tone="danger" icon={<IconWarning />}>
                {error}
              </Alert>
            </div>
          ) : null}

          <Alert tone="danger" icon={<IconWarning />}>
            Deleting <strong>{issueKey}</strong> permanently removes it along
            with its comments, attachments and activity history.
          </Alert>
        </Dialog>
      ) : null}
    </>
  );
}
