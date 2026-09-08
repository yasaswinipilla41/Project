"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { IssueStatus } from "@prisma/client";
import { Button } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/Toast";
import { isClosedStatus } from "@/lib/domain";
import { claimIssue } from "@/server/issues";

/**
 * Start, or take over.
 *
 * One control for the two ways a developer picks work up, because they are the
 * same act: the issue becomes theirs and it becomes In Progress. Which word it
 * shows depends only on whether somebody is currently holding it.
 *
 * There is no "assign to…" here and there is no parameter for one — `claimIssue`
 * takes an issue and nothing else, so a developer handing work to a colleague
 * is not something this refuses, it is something it cannot express. Deciding
 * who does a piece of work stays with an administrator.
 *
 * Absent when the work is already theirs and already running, when the issue is
 * closed — that is reopened first, and reopening is a tester's call — and for
 * anyone who is not a developer.
 */
export function ClaimIssueButton({
  issueId,
  issueKey,
  status,
  assigneeId,
  assigneeName,
  currentUserId,
}: {
  issueId: string;
  issueKey: string;
  status: IssueStatus;
  assigneeId: string | null;
  assigneeName: string | null;
  currentUserId: string;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);

  const mine = assigneeId === currentUserId;
  const heldByAnother = assigneeId !== null && !mine;

  // Already theirs and already running: there is nothing left to start.
  if (mine && status === "IN_PROGRESS") return null;
  if (isClosedStatus(status)) return null;

  async function claim() {
    setBusy(true);
    const result = await claimIssue({ issueId });
    setBusy(false);

    if (!result.ok) {
      toast(result.error, "error");
      // Somebody moved first; show who actually has it.
      startTransition(() => router.refresh());
      return;
    }

    toast(
      heldByAnother ? (
        <>
          You took over {issueKey}
          {assigneeName ? ` from ${assigneeName}` : ""}
        </>
      ) : (
        <>{issueKey} is yours, and in progress</>
      ),
    );
    startTransition(() => router.refresh());
  }

  return (
    <Button
      variant={heldByAnother ? "secondary" : "brand"}
      size="sm"
      loading={busy || pending}
      onClick={() => void claim()}
      title={
        heldByAnother
          ? `Take ${issueKey} over${assigneeName ? ` from ${assigneeName}` : ""} and start it`
          : `Take ${issueKey} and start it`
      }
    >
      {heldByAnother ? "Take over" : "Start"}
    </Button>
  );
}
