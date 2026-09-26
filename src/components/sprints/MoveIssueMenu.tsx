"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Menu, MenuItem, MenuLabel, MenuSeparator } from "@/components/ui/Menu";
import { IconArrowRight } from "@/components/ui/Icon";
import { useToast } from "@/components/ui/Toast";
import { formatDateRange } from "@/lib/format";
import { moveIssueToSprint } from "@/server/sprints";

type Destination =
  | { type: "BACKLOG" }
  | { type: "SPRINT"; sprintId: string }
  | { type: "PREVIOUS" };

/** A sprint this menu can name as somewhere to move to. */
export interface MoveDestination {
  id: string;
  name: string;
  startDate: Date;
  endDate: Date;
}

/**
 * Where one sprint issue can go: back to the sprint it came from, the
 * project's current or upcoming sprint, or the backlog.
 *
 * Restore is offered only when there is somewhere to restore to — the issue
 * was moved here out of a sprint that is still open — and it names that
 * sprint, because "Restore" on its own does not say where the work would go.
 * The destination is the issue's own record of the move, never anything this
 * menu chooses, so the server decides it and this only asks.
 *
 * The current and upcoming sprints are offered the same way, each labelled
 * with its own dates so two sprints of the same or similar name are never
 * mistaken for each other. Neither is the sprint being read now — a card
 * cannot move its issue into the sprint the issue is already in — and a
 * project further from an active sprint than that has no other destinations
 * to offer here: the later sprints stay reachable once they become the
 * current or the upcoming one, not before. Working out which two sprints
 * those are is the caller's job, from the project's own sprints; see
 * `lib/sprintMove`'s `nextOpenSprint`, the one place that answers it.
 *
 * Offered to the same people the Add issues button is — filling a sprint,
 * emptying it or moving its issues elsewhere is every working role's, not a
 * lifecycle change — and `moveIssueToSprint` asserts that same rule again on
 * the server, so a hidden trigger is never the only thing standing in the way.
 */
export function MoveIssueMenu({
  issueId,
  issueKey,
  /** At most the project's current sprint and its upcoming one, whichever of
   *  the two is not the sprint this card is already read on. */
  moveDestinations,
  previousSprint,
  disabled,
}: {
  issueId: string;
  issueKey: string;
  moveDestinations: MoveDestination[];
  /** The still-open sprint this issue was moved out of, when there is one —
   *  what Restore puts it back into. Absent means no Restore is offered. */
  previousSprint?: { id: string; name: string } | null;
  disabled?: boolean;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [moving, setMoving] = useState(false);

  async function move(destination: Destination) {
    setMoving(true);
    const result = await moveIssueToSprint({ issueId, destination });
    setMoving(false);

    if (!result.ok) {
      toast(result.error, "error");
      return;
    }
    toast(`${issueKey} moved to ${result.data.sprintName}`);
    router.refresh();
  }

  return (
    <Menu
      align="end"
      width={220}
      label={`Move ${issueKey}`}
      trigger={(props) => (
        <button
          type="button"
          className="prio-btn prio-btn--ghost prio-btn--icon prio-btn--sm"
          aria-label={`Move ${issueKey} to another sprint or the backlog`}
          title="Move to"
          disabled={disabled || moving}
          {...props}
        >
          <IconArrowRight size={13} />
        </button>
      )}
    >
      <MenuLabel>Move to</MenuLabel>
      {previousSprint ? (
        <MenuItem onSelect={() => void move({ type: "PREVIOUS" })}>
          Restore to {previousSprint.name}
        </MenuItem>
      ) : null}
      {moveDestinations.length > 0 ? (
        <>
          <MenuSeparator />
          {moveDestinations.map((sprint) => (
            <MenuItem
              key={sprint.id}
              onSelect={() => void move({ type: "SPRINT", sprintId: sprint.id })}
            >
              {sprint.name} ({formatDateRange(sprint.startDate, sprint.endDate)})
            </MenuItem>
          ))}
        </>
      ) : null}
      <MenuSeparator />
      <MenuItem onSelect={() => void move({ type: "BACKLOG" })}>Backlog</MenuItem>
    </Menu>
  );
}
