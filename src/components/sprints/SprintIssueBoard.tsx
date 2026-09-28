"use client";

import { useRouter } from "next/navigation";
import { useEffect, useOptimistic, useTransition } from "react";
import type { IssueStatus } from "@prisma/client";
import { BoardCard, type BoardIssue } from "@/components/projects/FlowBoard";
import {
  MoveIssueMenu,
  type MoveDestination,
} from "@/components/sprints/MoveIssueMenu";
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
 * A card's Move to sends its issue to another sprint or to the backlog, and
 * the page is re-read afterwards, so the blocks, the sprint's figures and its
 * charts all follow from the one move.
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
  moveDestinations = [],
  previousSprints = {},
  canMoveIssues = false,
}: {
  issues: BoardIssue[];
  workRole: WorkRole;
  currentUserId: string;
  isAdmin: boolean;
  /** The project's current sprint and its upcoming one, minus whichever of
   *  the two this board is already showing — where a card's Move to can send
   *  an issue, besides the backlog. See `MoveIssueMenu`. */
  moveDestinations?: MoveDestination[];
  /** Per issue, the still-open sprint it was moved out of — what Restore
   *  puts it back into. An issue with no entry is offered no Restore. */
  previousSprints?: Record<string, { id: string; name: string }>;
  /** Whether this reader may move a sprint's issues at all. Presentation
   *  only: `moveIssueToSprint` asserts the same rule on the server. */
  canMoveIssues?: boolean;
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
                /* This board never drags its cards, so the whole surface can
                   safely open the issue — see `linkWholeCard` on `BoardCard`
                   for why the Flow Board itself stays opt-out. */
                linkWholeCard
                /* Move to, on the card itself: the project's current or
                   upcoming sprint, or back to the backlog. The menu refreshes
                   the page, so the sprint's totals and its Issues by status
                   chart follow the move without anything here keeping a
                   second copy of the figures.
                   Deliberately not `inSprint`: that offers the same "Move to
                   next sprint" from inside the card's own ⋮ menu, which this
                   dedicated control already covers and more besides — a
                   second, narrower way to do the same thing would be
                   redundant here rather than useful. */
                actions={
                  canMoveIssues ? (
                    <MoveIssueMenu
                      issueId={issue.id}
                      issueKey={issue.key}
                      moveDestinations={moveDestinations}
                      previousSprint={previousSprints[issue.id]}
                    />
                  ) : undefined
                }
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
