"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Dialog } from "@/components/ui/Dialog";
import { Alert, Button } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/Toast";
import { IconCopy, IconTrash, IconWarning } from "@/components/ui/Icon";
import { CloneIssueDialog } from "@/components/issues/CloneIssueDialog";
import { deleteIssue } from "@/server/issues";

/**
 * Clone and Delete, from the issue's own page.
 *
 * Editing already happens inline everywhere on this page — every field is
 * click-to-edit in place — so what is left are the two actions that produce or
 * remove a whole issue.
 *
 * They are gated differently, and deliberately so. **Cloning creates an
 * issue**, which anyone who can open the issue can already do from the Create
 * dialog, so it is offered to everyone here and authorized on the server the
 * same way an ordinary create is. **Deleting** stays with the reporter or an
 * administrator, exactly as before. Neither gate is new and neither widened:
 * `cloneIssue` and `deleteIssue` each re-check independently, so what is shown
 * here is a courtesy, not the control.
 */
export function IssueDetailActions({
  issueId,
  issueKey,
  reporterId,
  currentUserId,
  isAdmin,
}: {
  issueId: string;
  issueKey: string;
  reporterId: string;
  currentUserId: string;
  isAdmin: boolean;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [confirming, setConfirming] = useState(false);
  const [cloning, setCloning] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canDelete = isAdmin || reporterId === currentUserId;

  async function confirmDelete() {
    setDeleting(true);
    setError(null);

    const result = await deleteIssue(issueId);

    if (!result.ok) {
      setDeleting(false);
      setError(result.error);
      return;
    }

    toast(<>Deleted {result.data.key}</>);
    router.push(`/projects/${result.data.projectKey.toLowerCase()}`);
    router.refresh();
  }

  return (
    <>
      <Button variant="secondary" size="sm" onClick={() => setCloning(true)}>
        <IconCopy size={13} />
        Clone
      </Button>

      {canDelete ? (
        <Button
          variant="danger-outline"
          size="sm"
          onClick={() => setConfirming(true)}
        >
          <IconTrash size={13} />
          Delete issue
        </Button>
      ) : null}

      {cloning ? (
        <CloneIssueDialog
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
