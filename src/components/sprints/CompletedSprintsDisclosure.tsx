"use client";

import {
  createContext,
  useContext,
  useId,
  useState,
  type ReactNode,
} from "react";
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
 * The control sits at the top right of the page, beside Iterations / Sprints,
 * and the sprints it opens are drawn above the Active sprint group — two
 * places on the page, so they share their open state through
 * `CompletedSprints` rather than living in one element. The same arrangement
 * the sprint page's Burndown Chart button uses (`BurndownDisclosure`).
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
 * gets no control at all — the caller only renders the toggle and the panel
 * when there is something behind them, because a dropdown that opens onto
 * nothing is worse than no dropdown.
 */

const CompletedSprintsContext = createContext<{
  open: boolean;
  toggle: () => void;
  panelId: string;
} | null>(null);

/** The open state the toggle and the panel share. Renders no element. */
export function CompletedSprints({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  return (
    <CompletedSprintsContext.Provider
      value={{ open, toggle: () => setOpen((was) => !was), panelId }}
    >
      {children}
    </CompletedSprintsContext.Provider>
  );
}

function useCompletedSprints() {
  const value = useContext(CompletedSprintsContext);
  if (!value) {
    throw new Error("Completed sprints controls must sit inside <CompletedSprints>.");
  }
  return value;
}

/**
 * The control, at the top right of the page.
 *
 * An ordinary button, so Enter and Space open the group and it carries the
 * focus ring every other control on this page has. `aria-expanded` is what
 * says whether it is open; the chevron says the same thing to everybody else.
 */
export function CompletedSprintsToggle({
  count,
}: {
  /** How many completed sprints are inside, shown on the control itself. */
  count: number;
}) {
  const { open, toggle, panelId } = useCompletedSprints();
  return (
    <button
      type="button"
      className="prio-sprints__disclosure"
      aria-expanded={open}
      aria-controls={panelId}
      onClick={toggle}
    >
      Completed sprints
      <span className="prio-sprints__historycount">{count}</span>
      {open ? <IconChevronUp size={14} /> : <IconChevronDown size={14} />}
    </button>
  );
}

/**
 * The completed sprints themselves, above the Active sprint group when open —
 * under a heading of their own, so they read as a separate group from the
 * live sprints rather than as more of them.
 */
export function CompletedSprintsPanel({ children }: { children: ReactNode }) {
  const { open, panelId } = useCompletedSprints();
  return (
    <div id={panelId} hidden={!open} className="prio-sprints__completedlist">
      <h3 className="prio-sprints__section">Completed sprints</h3>
      {children}
    </div>
  );
}
