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
  | { type: "SPRINT"; sprintId: string };

/**
 * Where one sprint issue can go: the next open sprint, a specific other
 * sprint in this project, or back to the backlog.
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
  disabled,
}: {
  issueId: string;
  issueKey: string;
  otherOpenSprints: { id: string; name: string }[];
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
      <MenuItem onSelect={() => void move({ type: "NEXT_SPRINT" })}>
        Next sprint
      </MenuItem>
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
