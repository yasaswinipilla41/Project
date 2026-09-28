"use client";

import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";
import type { SprintStatus } from "@prisma/client";
import { Menu, MenuItem, MenuLabel, MenuSeparator } from "@/components/ui/Menu";
import {
  IconChevronDown,
  IconInfo,
  IconRefresh,
  IconWarning,
} from "@/components/ui/Icon";
import { useToast } from "@/components/ui/Toast";
import { SPRINT_STATUS_LABEL } from "@/lib/domain";
import { formatDateRange } from "@/lib/format";
import {
  eligibleSprintsForIssue,
  moveIssueToSprint,
  type EligibleSprints,
} from "@/server/sprints";

/**
 * Move to sprint, on the issue's own Details panel.
 *
 * The field states which sprint this work is in and lets somebody move it to
 * any *eligible* one — every open sprint in the issue's own project, not the
 * one sprint that happens to come next. Where the sprint board's
 * `MoveIssueMenu` offers a card the project's current and upcoming sprint,
 * this is the issue's own page and the whole set is the right answer here:
 * re-planning a single item is the thing this page is open for.
 *
 * It writes through `moveIssueToSprint` — the same server action the sprint
 * board's Move to and the row menu's Next sprint already call. There is no
 * second assignment path, no second permission rule, and nothing here decides
 * what is allowed: `eligibleSprintsForIssue` and `moveIssueToSprint` each
 * re-derive the caller's access, the issue's project and the destination's
 * eligibility from the database, so a forged request is refused exactly as a
 * hidden control would have been.
 *
 * ## The states, which are all of them
 *
 * The destinations are fetched when the menu opens rather than shipped with
 * every render of the page, so this control has a request of its own and every
 * outcome of one:
 *
 *  - **loading** — a note and a spinner, and no rows to choose from, so a move
 *    cannot be submitted against a list that has not arrived;
 *  - **data** — the eligible sprints, soonest first, each with its own dates so
 *    two similarly named sprints are never mistaken for each other;
 *  - **empty** — "No eligible sprints available.", which is a different
 *    sentence from the failure below and never stands in for it;
 *  - **error** — the server's own message and a Retry that re-runs the read
 *    without closing the menu;
 *  - **not allowed** — no menu at all: the sprint is stated, the way Priority
 *    and Assignee are stated to somebody who may not change them;
 *  - **refused move** — the field keeps the sprint it had (it is never updated
 *    optimistically), the reason is toasted, and the destination list is read
 *    again so a sprint that has since been completed or deleted stops being
 *    offered.
 */

/** The sprint an issue is in, as the page has already read it. */
export interface CurrentSprint {
  id: string;
  name: string;
  status: SprintStatus;
}

type Load =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "ready"; options: EligibleSprints }
  | { state: "error"; message: string };

export function MoveToSprintControl({
  issueId,
  issueKey,
  sprint,
  canMove,
}: {
  issueId: string;
  issueKey: string;
  /** Where the work is now — null for an issue in the backlog. */
  sprint: CurrentSprint | null;
  /**
   * Whether this reader may move sprint issues at all — `canEditSprintIssues`,
   * the same capability the sprint board reads. Presentation only: both server
   * actions behind this control assert it again.
   */
  canMove: boolean;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [load, setLoad] = useState<Load>({ state: "idle" });
  const [moving, setMoving] = useState(false);

  const current = sprint ? (
    <span className="prio-truncate">
      {sprint.name}
      {sprint.status === "COMPLETED" ? (
        <span className="prio-text-muted">
          {" "}
          · {SPRINT_STATUS_LABEL[sprint.status]}
        </span>
      ) : null}
    </span>
  ) : (
    /* The existing no-sprint state: an issue in the backlog is in no sprint,
       which is a fact about it rather than something missing. */
    <span className="prio-text-muted">No sprint</span>
  );

  const read = useCallback(async () => {
    setLoad({ state: "loading" });
    try {
      const result = await eligibleSprintsForIssue({ issueId });
      setLoad(
        result.ok
          ? { state: "ready", options: result.data }
          : { state: "error", message: result.error },
      );
    } catch (error) {
      /*
       * The request never reached an answer — offline, a dropped connection, a
       * server that did not respond. A rejected call is not a refusal and not
       * an empty list, and without this the panel would sit on "Loading
       * sprints…" for as long as it was left open, which is the one state that
       * tells the reader nothing and never resolves.
       */
      console.error("[prio] eligible sprints failed to load:", error);
      setLoad({
        state: "error",
        message: "Unable to load sprints. Check your connection and try again.",
      });
    }
  }, [issueId]);

  /*
   * Stated rather than offered, in the same place and the same shape the menu
   * would occupy — the row reads identically whoever is looking at it, and the
   * server refuses the move either way. The same treatment `PriorityControl`
   * and `AssigneeControl` already give a field somebody may read and not set.
   */
  if (!canMove) {
    return (
      <span
        className="prio-fieldtrigger"
        data-readonly
        title="You do not have permission to move this work between sprints."
      >
        {current}
      </span>
    );
  }

  async function move(
    destination: { type: "BACKLOG" } | { type: "SPRINT"; sprintId: string },
    label: string,
  ) {
    setMoving(true);

    let result: Awaited<ReturnType<typeof moveIssueToSprint>>;
    try {
      result = await moveIssueToSprint({ issueId, destination });
    } catch (error) {
      /*
       * The move never reached the server. Nothing was written, nothing on this
       * page claimed otherwise, and the attempt is reported rather than
       * dropped: the field still shows the sprint the issue is in, and the
       * destinations are read again next time the panel is opened, so a retry
       * starts from what is true then rather than from what was true before the
       * connection went.
       */
      console.error("[prio] sprint move failed:", error);
      setMoving(false);
      toast(
        "Unable to move this issue. Check your connection and try again.",
        "error",
      );
      setLoad({ state: "idle" });
      return;
    }
    setMoving(false);

    if (!result.ok) {
      /*
       * The field still shows the sprint the issue is actually in: nothing was
       * updated ahead of the answer, so there is nothing to put back.
       *
       * The destinations are read again regardless of why the move failed. A
       * sprint that was completed or deleted between the menu opening and the
       * item being chosen is exactly the case this covers — the refusal is
       * correct, and the stale row has to stop being offered or the next
       * attempt fails the same way.
       */
      toast(result.error, "error");
      void read();
      return;
    }

    toast(`${issueKey} moved to ${label}`);
    /* The sprint has changed, so the eligible set has too — the next open
       reads it again rather than showing what was true before the move. */
    setLoad({ state: "idle" });
    router.refresh();
  }

  return (
    <Menu
      align="start"
      /*
       * Wide enough for a sprint's name and its dates beside the status that
       * marks the running one — the dates are what tell two similarly named
       * sprints apart, so they are the last thing that should be clipped.
       *
       * A ceiling rather than a width, because 340px does not fit a 320px
       * phone and `Menu` can only move a panel, not shrink one: it clamps the
       * left edge to the viewport, so an over-wide panel is pinned at the
       * margin and runs off the right. The gutter is the 8px `place()` leaves
       * on each side, with the same again for a scrollbar.
       */
      width="min(340px, calc(100vw - 32px))"
      label={`Move ${issueKey} to a sprint`}
      /* The request is worth making when the panel opens, and only the first
         time: reopening shows what was read, and a move or a failure is what
         puts it back to `idle`. */
      onOpenChange={(open) => {
        if (open && load.state === "idle") void read();
      }}
      trigger={(props) => (
        <button
          type="button"
          className="prio-fieldtrigger"
          disabled={moving}
          aria-label={`Move ${issueKey} to a sprint`}
          {...props}
        >
          {current}
          <IconChevronDown size={12} />
        </button>
      )}
    >
      <MenuLabel>Move to sprint</MenuLabel>

      {load.state === "loading" ? (
        <p className="prio-menu__note" role="status">
          <span className="prio-spinner" aria-hidden />
          Loading sprints…
        </p>
      ) : null}

      {load.state === "error" ? (
        <>
          <p className="prio-menu__note">
            <IconWarning size={14} />
            {/* The server's own words — an authorization refusal, a sprint
                that has gone, or the generic failure — rather than one
                message covering every reason the read did not land. */}
            {load.message}
          </p>
          <div className="prio-menu__footer" data-menu-keep-open>
            <button
              type="button"
              className="prio-btn prio-btn--secondary prio-btn--sm"
              onClick={() => void read()}
            >
              <IconRefresh size={13} />
              Try again
            </button>
          </div>
        </>
      ) : null}

      {load.state === "ready" && load.options.locked ? (
        <p className="prio-menu__note">
          <IconInfo size={14} />
          This issue&rsquo;s sprint has been completed and can no longer be
          changed.
        </p>
      ) : null}

      {load.state === "ready" && !load.options.locked ? (
        <>
          {load.options.sprints.length === 0 ? (
            <p className="prio-menu__note">
              <IconInfo size={14} />
              No eligible sprints available.
            </p>
          ) : (
            load.options.sprints.map((option) => (
              <MenuItem
                key={option.id}
                selected={option.id === load.options.current?.id}
                trailing={SPRINT_STATUS_LABEL[option.status]}
                onSelect={() =>
                  option.id !== load.options.current?.id &&
                  void move({ type: "SPRINT", sprintId: option.id }, option.name)
                }
              >
                {option.name} ({formatDateRange(option.startDate, option.endDate)})
              </MenuItem>
            ))
          )}

          {/* Out of the sprint altogether, which the data model has always
              supported — `moveIssueToSprint`'s BACKLOG destination, the same
              one the sprint board's Move to offers. Not shown for an issue
              that is already there: there is nowhere to remove it from. */}
          {load.options.inBacklog ? null : (
            <>
              <MenuSeparator />
              <MenuItem onSelect={() => void move({ type: "BACKLOG" }, "Backlog")}>
                Remove from sprint (Backlog)
              </MenuItem>
            </>
          )}
        </>
      ) : null}
    </Menu>
  );
}
