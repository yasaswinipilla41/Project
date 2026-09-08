"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Menu, MenuItem, MenuSeparator } from "@/components/ui/Menu";
import { Dialog } from "@/components/ui/Dialog";
import { Alert, Button } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/Toast";
import {
  IconCopy,
  IconEdit,
  IconMore,
  IconTrash,
  IconWarning,
} from "@/components/ui/Icon";
import { CloneIssueDialog } from "@/components/issues/CloneIssueDialog";
import { deleteIssue } from "@/server/issues";
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
 */

export interface IssueRowActionsProps {
  issueId: string;
  issueKey: string;
  reporterId: string;
  currentUserId: string;
  isAdmin: boolean;
  /** Cloning files new work; the dialog offers the statuses that allows. */
  workRole: WorkRole;
}

export function IssueRowActions({
  issueId,
  issueKey,
  reporterId,
  currentUserId,
  isAdmin,
  workRole,
}: IssueRowActionsProps) {
  const router = useRouter();
  const { toast } = useToast();
  const [confirming, setConfirming] = useState(false);
  const [cloning, setCloning] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canDelete = isAdmin || reporterId === currentUserId;
  const href = `/issues/${issueKey.toLowerCase()}`;

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
        width={180}
        label={`Actions for ${issueKey}`}
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
        <MenuItem href={href} icon={<IconEdit />}>
          Open / edit
        </MenuItem>
        {/* Cloning creates an issue, which any project member may already do —
            the same gate the Create dialog has, re-checked on the server. */}
        <MenuItem icon={<IconCopy />} onSelect={() => setCloning(true)}>
          Clone
        </MenuItem>
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
