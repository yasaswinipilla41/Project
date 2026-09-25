"use client";

import {
  createContext,
  useCallback,
  useContext,
  useId,
  useState,
  type ReactNode,
} from "react";
import { BurndownChart } from "@/components/sprints/BurndownChart";
import { Button, CardBody } from "@/components/ui/primitives";
import {
  IconChevronDown,
  IconChevronUp,
  IconClose,
  IconReports,
} from "@/components/ui/Icon";
import type { Burndown } from "@/lib/burndown";

/**
 * The burndown, behind a button instead of always on screen.
 *
 * The chart is the tallest thing on a sprint's page and answers a question
 * that is not always being asked, so it used to push the sprint's own work
 * most of a screen down. It is now opened from the sprint header — the button
 * sits with Add issues and Edit, before them, because reading the sprint comes
 * before changing it — and the page underneath is compact until somebody asks
 * for it.
 *
 * Three parts, because the trigger and the panel are drawn in two different
 * places: the button belongs in the header's own actions row, and the panel
 * belongs below the header card, above the sprint's issues. One piece of
 * state has to reach both, so it is held here and read through context rather
 * than by lifting either of them out of where it belongs. Nothing else is
 * shared, and nothing here fetches anything.
 *
 * The chart itself is `BurndownChart`, untouched, drawing the same `Burndown`
 * the page already reads on the server — no second chart, no second query, and
 * no calculation of its own. Opening and closing the panel changes no data:
 * the figures and both lines come from that one server read, so they say the
 * same thing however many times it is opened.
 */

interface Disclosure {
  open: boolean;
  /** Ties the button to the panel it opens, for assistive technology. */
  panelId: string;
  toggle: () => void;
  close: () => void;
}

const BurndownContext = createContext<Disclosure | null>(null);

function useDisclosure(): Disclosure {
  const value = useContext(BurndownContext);
  if (!value) {
    throw new Error(
      "BurndownToggle and BurndownPanel must be inside BurndownDisclosure",
    );
  }
  return value;
}

/** Holds whether the chart is open, for the header and the panel alike. */
export function BurndownDisclosure({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();

  const toggle = useCallback(() => setOpen((was) => !was), []);
  const close = useCallback(() => setOpen(false), []);

  return (
    <BurndownContext.Provider value={{ open, panelId, toggle, close }}>
      {children}
    </BurndownContext.Provider>
  );
}

/**
 * The button that opens it, for the sprint header's actions row.
 *
 * An ordinary button, so Enter and Space open the chart and the focus ring is
 * the one every other control here has. `aria-expanded` is what says whether
 * it is open — the chevron says the same thing to everyone else, and turning
 * it is the whole of that.
 */
export function BurndownToggle() {
  const { open, panelId, toggle } = useDisclosure();

  return (
    <Button
      variant="ghost"
      size="sm"
      className="prio-burndowntoggle"
      aria-expanded={open}
      aria-controls={panelId}
      onClick={toggle}
    >
      <IconReports size={14} />
      Burndown Chart
      {open ? <IconChevronUp size={13} /> : <IconChevronDown size={13} />}
    </Button>
  );
}

/**
 * The panel it opens: the existing chart, with a heading and a way out.
 *
 * Rendered only while open rather than hidden with CSS. The chart measures
 * itself to place the day-detail beside the point it explains, and a hidden
 * element measures as nothing — it would open with its first tooltip in the
 * wrong place. Nothing is refetched by that: `data` is the same server-read
 * `Burndown` either way.
 */
export function BurndownPanel({ data }: { data: Burndown }) {
  const { open, panelId, close } = useDisclosure();
  if (!open) return null;

  return (
    /* A section rather than the `Card` component, because the panel needs an
       id for the button's `aria-controls` to point at; `prio-card` is the same
       card treatment either way, and it is how the sprint's own block is
       built a few lines above this one on the page. */
    <section
      id={panelId}
      className="prio-card prio-burndownpanel"
      aria-label="Burndown Chart"
    >
      <CardBody>
        <header className="prio-burndownpanel__head">
          {/* Said in capitals by the stylesheet, not by the text, so the
              heading somebody hears is the heading somebody reads. */}
          <h2 className="prio-burndownpanel__title">Burndown Chart</h2>
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            aria-label="Close Burndown Chart"
            title="Close Burndown Chart"
            onClick={close}
          >
            <IconClose size={14} />
          </Button>
        </header>

        <BurndownChart data={data} />
      </CardBody>
    </section>
  );
}
