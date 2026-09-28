"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Menu, MenuItem, MenuLabel, MenuSeparator } from "@/components/ui/Menu";
import { IconArrowRight, IconInfo } from "@/components/ui/Icon";
import { useToast } from "@/components/ui/Toast";
import { formatDate } from "@/lib/format";
import { moveIssueToSprint } from "@/server/sprints";

type Destination = { type: "SPRINT"; sprintId: string } | { type: "PREVIOUS" };

/** A sprint this menu can name as somewhere to move to. */
export interface MoveDestination {
  id: string;
  name: string;
  startDate: Date;
  endDate: Date;
}

/**
 * Where one sprint issue can go: back to the upcoming sprint it came from, or
 * any of the project's upcoming sprints. Sprints only — the backlog is never
 * offered here.
 *
 * Restore is offered only when there is somewhere to restore to — the issue
 * was moved here out of a sprint that is still upcoming — and it names that
 * sprint, because "Restore" on its own does not say where the work would go.
 * The destination is the issue's own record of the move, never anything this
 * menu chooses, so the server decides it and this only asks.
 *
 * The upcoming sprints — every planned one, not only the next — are listed
 * soonest first, each with its own start and end dates so two sprints of the
 * same or similar name are never mistaken for each other. The running sprint
 * and completed ones are never listed, nor is the sprint being read now: a
 * card cannot move its issue into the sprint the issue is already in. Working
 * out which sprints those are is the caller's job, from the project's own
 * sprints; a project with none says so rather than leaving a gap.
 *
 * Offered to the same people the Add issues button is — filling a sprint,
 * emptying it or moving its issues elsewhere is every working role's, not a
 * lifecycle change — and `moveIssueToSprint` asserts that same rule again on
 * the server, so a hidden trigger is never the only thing standing in the way.
 */
export function MoveIssueMenu({
  issueId,
  issueKey,
  /** The project's upcoming sprints, soonest first, less the sprint this card
   *  is already read on. */
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
      /* Sized to its rows rather than a fixed 220px, which cut every
         sprint's dates off — see `.prio-menu--movesprint`. */
      panelClassName="prio-menu--movesprint"
      label={`Move ${issueKey}`}
      trigger={(props) => (
        <button
          type="button"
          className="prio-btn prio-btn--ghost prio-btn--icon prio-btn--sm"
          aria-label={`Move ${issueKey} to another sprint`}
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
              {/* The sprint's name, and under it the dates it runs — start
                  and end, each with its year — so two similarly named
                  sprints are never mistaken for each other. */}
              <span className="prio-movesprint__name">{sprint.name}</span>
              <span className="prio-movesprint__dates">
                {formatDate(sprint.startDate)} – {formatDate(sprint.endDate)}
              </span>
            </MenuItem>
          ))}
        </>
      ) : (
        <>
          <MenuSeparator />
          {/* Said, not left as a gap: the project has no sprint planned
              after this one, in the same note the issue page's sprint
              picker uses for the same answer. */}
          <p className="prio-menu__note">
            <IconInfo size={14} />
            No upcoming sprints available
          </p>
        </>
      )}
    </Menu>
  );
}
