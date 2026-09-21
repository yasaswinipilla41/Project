"use client";

import { useRouter } from "next/navigation";
import { useEffect, useOptimistic, useTransition } from "react";
import type { IssueStatus } from "@prisma/client";
import { BoardCard, type BoardIssue } from "@/components/projects/FlowBoard";
import { useToast } from "@/components/ui/Toast";
import { ISSUE_STATUSES, STATUS_LABEL, type WorkRole } from "@/lib/domain";
import { updateIssue } from "@/server/issues";

/**
 * A sprint's own issues, one block per status they are actually in.
 *
 * Grouped by each issue's real status, in the application's own status order,
 * and a status nobody is in draws no block at all. Each issue is the Flow
 * Board's own card — same design, same status menu, same role-aware actions —
 * so what a Developer, Tester, Full Stack Developer or Admin may do to an
 * issue here is exactly what they may do to it on the board, and the server
 * re-checks it either way.
 *
 * Changing a status from a card's menu moves the card to its new block
 * straight away (optimistically) and then re-reads the page, so the block it
 * lands in is always the server's answer. A change made anywhere else —
 * another tab, somebody else — is picked up when this page is looked at
 * again: returning to the tab or window re-reads it.
 */
export function SprintIssueBoard({
  issues,
  workRole,
  currentUserId,
  isAdmin,
}: {
  issues: BoardIssue[];
  workRole: WorkRole;
  currentUserId: string;
  isAdmin: boolean;
}) {
  const router = useRouter();
  const { toast } = useToast();
  /*
   * Whether a status change is still being written.
   *
   * The card moves the instant it is chosen, which is the right feel and also
   * a claim the page cannot yet make: the server has not answered. Until this
   * clears, the board is showing what it *expects* rather than what is stored,
   * and a reload in that window renders the issue where it still is — which
   * looks exactly like the change having been lost, even though it lands.
   *
   * So the board says so. It dims while the write is in flight and is marked
   * busy for anything reading the page, and the state clears only after
   * `updateIssue` has answered and the refresh it triggers has re-rendered —
   * so "not busy" means the server agrees, not merely that the click was
   * handled.
   */
  const [saving, startTransition] = useTransition();

  const [shown, moveIssue] = useOptimistic(
    issues,
    (state, change: { issueId: string; status: IssueStatus }) =>
      state.map((issue) =>
        issue.id === change.issueId ? { ...issue, status: change.status } : issue,
      ),
  );

  /* Coming back to the page re-reads it, so a status changed elsewhere lands
     in its new block without anybody having to reload. */
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === "visible") router.refresh();
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [router]);

  function changeStatus(issueId: string, status: IssueStatus) {
    startTransition(async () => {
      moveIssue({ issueId, status });
      const result = await updateIssue({ issueId, status });
      if (!result.ok) toast(result.error, "error");
      router.refresh();
    });
  }

  if (shown.length === 0) {
    return <p className="prio-text-muted">No issues in this sprint yet.</p>;
  }

  const blocks = ISSUE_STATUSES.map((status) => ({
    status,
    issues: shown.filter((issue) => issue.status === status),
  })).filter((block) => block.issues.length > 0);

  return (
    <div
      className="prio-sprint__board prio-scroll"
      data-pending={saving || undefined}
      aria-busy={saving || undefined}
    >
      {blocks.map(({ status, issues: inBlock }) => (
        <section
          key={status}
          className="prio-sprint__column"
          aria-label={`${STATUS_LABEL[status]}, ${inBlock.length} ${inBlock.length === 1 ? "issue" : "issues"}`}
        >
          <h3 className="prio-sprint__columnhead">
            {STATUS_LABEL[status]}
            <span className="prio-sprint__columncount">{inBlock.length}</span>
          </h3>
          <div className="prio-sprint__cards">
            {inBlock.map((issue) => (
              <BoardCard
                key={issue.id}
                issue={issue}
                draggable={false}
                dragging={false}
                onDragStart={() => {}}
                onDragEnd={() => {}}
                onStatusChange={(next) => changeStatus(issue.id, next)}
                workRole={workRole}
                currentUserId={currentUserId}
                isAdmin={isAdmin}
                /* These cards are a sprint's own, so the card's existing
                   menu carries Move to next sprint here and nowhere else. */
                inSprint
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
