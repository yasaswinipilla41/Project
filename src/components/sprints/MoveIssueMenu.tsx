"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Menu, MenuItem, MenuLabel, MenuSeparator } from "@/components/ui/Menu";
import { IconArrowRight } from "@/components/ui/Icon";
import { useToast } from "@/components/ui/Toast";
import { moveIssueToSprint } from "@/server/sprints";

type Destination =
  | { type: "BACKLOG" }
  | { type: "NEXT_SPRINT" }
  | { type: "SPRINT"; sprintId: string }
  | { type: "PREVIOUS" };

/**
 * Where one sprint issue can go: back to the sprint it came from, the next
 * open sprint, a specific other sprint in this project, or the backlog.
 *
 * Restore is offered only when there is somewhere to restore to — the issue
 * was moved here out of a sprint that is still open — and it names that
 * sprint, because "Restore" on its own does not say where the work would go.
 * The destination is the issue's own record of the move, never anything this
 * menu chooses, so the server decides it and this only asks.
 *
 * Next sprint is offered on the same terms, for the same reason. A project
 * running its only sprint has none after it, and the entry used to be there
 * regardless — failing with "No future Sprint is available." every time it
 * was used. Whether there is one is worked out by the page from the sprints
 * it has already loaded; see `lib/sprintMove`.
 *
 * Offered to the same people the Add issues button is — filling a sprint,
 * emptying it or moving its issues elsewhere is every working role's, not a
 * lifecycle change — and `moveIssueToSprint` asserts that same rule again on
 * the server, so a hidden trigger is never the only thing standing in the way.
 */
export function MoveIssueMenu({
  issueId,
  issueKey,
  /** This project's other sprints that are not completed. */
  otherOpenSprints,
  previousSprint,
  hasNextSprint = true,
  disabled,
}: {
  issueId: string;
  issueKey: string;
  otherOpenSprints: { id: string; name: string }[];
  /** The still-open sprint this issue was moved out of, when there is one —
   *  what Restore puts it back into. Absent means no Restore is offered. */
  previousSprint?: { id: string; name: string } | null;
  /** Whether this issue's sprint has an open one on or after it. Defaults to
   *  offering the move, so a caller that does not know keeps the old
   *  behaviour and the server still has the final word. */
  hasNextSprint?: boolean;
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
      {hasNextSprint ? (
        <MenuItem onSelect={() => void move({ type: "NEXT_SPRINT" })}>
          Next sprint
        </MenuItem>
      ) : null}
      {otherOpenSprints.length > 0 ? (
        <>
          <MenuSeparator />
          {otherOpenSprints.map((sprint) => (
            <MenuItem
              key={sprint.id}
              onSelect={() => void move({ type: "SPRINT", sprintId: sprint.id })}
            >
              {sprint.name}
            </MenuItem>
          ))}
        </>
      ) : null}
      <MenuSeparator />
      <MenuItem onSelect={() => void move({ type: "BACKLOG" })}>Backlog</MenuItem>
    </Menu>
  );
}
