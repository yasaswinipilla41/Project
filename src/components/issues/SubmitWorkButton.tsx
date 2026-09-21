"use client";

import { useRouter } from "next/navigation";
import { isClosedStatus } from "@/lib/domain";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/primitives";
import { IconCheck } from "@/components/ui/Icon";
import { useToast } from "@/components/ui/Toast";
import { updateIssue } from "@/server/issues";
import type { IssueStatus } from "@prisma/client";

/**
 * "Submit for review" — the assignee saying their part is done.
 *
 * Deliberately not a new workflow. Prio already has an `IN_REVIEW` status and
 * `updateIssue` already records the status change in the activity trail and
 * notifies the issue's watchers; this is a one-click way to reach that state
 * without hunting through the status dropdown, and nothing more. Everything a
 * reviewer needs afterwards — who submitted, when, and what changed — is the
 * ordinary activity entry that transition already writes.
 *
 * Shown only to the person the work is assigned to, and only while there is
 * something to submit. `updateIssue` re-checks access on the server, so this
 * button appearing is a convenience rather than the permission itself.
 */
export function SubmitWorkButton({
  issueId,
  issueKey,
  status,
  assigneeId,
  currentUserId,
}: {
  issueId: string;
  issueKey: string;
  status: IssueStatus;
  assigneeId: string | null;
  currentUserId: string;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [saving, setSaving] = useState(false);
  const [pending, startTransition] = useTransition();

  // Not their work, or already submitted / finished: nothing to offer.
  if (assigneeId !== currentUserId) return null;
  /*
   * Offered from wherever the work actually is, so long as it is not already
   * there and is not closed.
   *
   * This used to ask `canTransition(status, "IN_REVIEW")`, which withheld the
   * button from anything the ordinary path does not connect to Ready for QA —
   * including the common case it exists for: work that was built, deployed and
   * checked before anybody updated its status. Hand-off is now a move the
   * holder may make from where the issue is; who may set the status at all is
   * still decided by `updateIssue` on the server.
   */
  if (status === "IN_REVIEW" || isClosedStatus(status)) {
    return null;
  }

  async function submit() {
    setSaving(true);
    const result = await updateIssue({ issueId, status: "IN_REVIEW" });
    setSaving(false);

    if (!result.ok) {
      toast(result.error, "error");
      return;
    }

    toast(`${issueKey} submitted for review`);
    startTransition(() => router.refresh());
  }

  return (
    <Button
      variant="primary"
      size="sm"
      onClick={submit}
      loading={saving || pending}
      title="Move this issue to Ready for QA for someone to check"
    >
      <IconCheck size={13} />
      Submit for review
    </Button>
  );
}
