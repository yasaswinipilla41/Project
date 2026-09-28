"use client";

import { useId, useState, type ReactNode } from "react";
import { IconChevronDown, IconChevronUp } from "@/components/ui/Icon";

/**
 * Completed sprints, behind a control instead of below the live ones.
 *
 * A project's Sprints page is read to find out what is being worked now and
 * what is coming next. Every sprint the team has ever closed used to sit in
 * the same column underneath, so on a project a few months old the two
 * questions the page exists to answer were above a list of answers to neither.
 * They are still here, still whole, still openable — one click away rather
 * than one scroll past.
 *
 * Nothing about the records changes. The cards inside are the same
 * `SprintCard` the live sprints use, rendered on the server with the same
 * `SprintView` and in the same order `loadSprints` returns them (newest
 * closed first), and they stay mounted while collapsed — `hidden` rather than
 * unmounted — so opening the group is instant and costs no request.
 *
 * That is also why there is no loading or error state of its own: these
 * sprints arrive with the page, so the page's own skeleton covers the wait and
 * its own error boundary covers a failure. A project with nothing completed
 * gets no control at all — the caller only renders this when there is
 * something behind it, because a dropdown that opens onto nothing is worse
 * than no dropdown.
 */
export function CompletedSprintsDisclosure({
  count,
  children,
}: {
  /** How many completed sprints are inside, shown on the control itself. */
  count: number;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();

  return (
    <div className="prio-sprints__completed">
      {/*
       * An ordinary button, so Enter and Space open the group and it carries
       * the focus ring every other control on this page has. `aria-expanded`
       * is what says whether it is open; the chevron says the same thing to
       * everybody else. The same pattern the sprint page's Burndown Chart
       * button already uses — see `BurndownDisclosure`.
       */}
      <button
        type="button"
        className="prio-sprints__disclosure"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((was) => !was)}
      >
        Completed sprints
        <span className="prio-sprints__historycount">{count}</span>
        {open ? <IconChevronUp size={14} /> : <IconChevronDown size={14} />}
      </button>

      <div id={panelId} hidden={!open} className="prio-sprints__completedlist">
        {children}
      </div>
    </div>
  );
}
