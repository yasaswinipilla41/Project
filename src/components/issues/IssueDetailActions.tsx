"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Dialog } from "@/components/ui/Dialog";
import { Alert, Button } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/Toast";
import { IconTrash, IconWarning } from "@/components/ui/Icon";
import { deleteIssue } from "@/server/issues";

/**
 * Delete, from the issue's own page.
 *
 * Editing already happens inline everywhere on this page — every field is
 * click-to-edit in place — so the only action this page is missing is the one
 * that removes the issue outright. Shown only to the reporter or an
 * administrator; `deleteIssue` enforces the same rule independently, so
 * hiding the button here is a courtesy, not the control.
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
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isAdmin && reporterId !== currentUserId) return null;

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
      <Button
        variant="danger-outline"
        size="sm"
        onClick={() => setConfirming(true)}
      >
        <IconTrash size={13} />
        Delete issue
      </Button>

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
