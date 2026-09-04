"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import type { IssueStatus, IssueType } from "@prisma/client";
import { Button } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/Toast";
import { IconClose, IconPlus, IconWarning } from "@/components/ui/Icon";
import { IssueKey, IssueTypeIcon, StatusPill } from "@/components/ui/Indicators";
import { ISSUE_TYPES, ISSUE_TYPE_LABEL, isClosedStatus } from "@/lib/domain";
import { createIssue } from "@/server/issues";

/**
 * The month grid, and creating work on the day it is due.
 *
 * The calendar was read-only: it drew issues that already had a due date and
 * offered no way to add one, so planning a day meant leaving the calendar,
 * opening the Create dialog and typing the date back in by hand. Clicking a
 * day now opens a small composer on that day.
 *
 * **Nothing new is stored.** A calendar entry *is* an issue with a due date —
 * the same `Issue` row the board, the list and the detail page all read — and
 * it is written by the same `createIssue` server action every other create
 * flow in Prio uses, so project scoping, membership checks and the activity
 * trail all come along unchanged. There is no calendar event model, no second
 * create path, and nothing here is client-only state: the composer closes on a
 * `router.refresh()`, which re-runs the page's own query.
 *
 * **Dates are date-only, in UTC.** The clicked day is sent as `YYYY-MM-DD`,
 * which is exactly what the Create dialog's `<input type="date">` sends, and
 * the page buckets by `getUTCDate()`. That pairing is what stops a day
 * boundary moving an issue to the day before or after — see the note on the
 * page itself.
 */

export interface CalendarIssue {
  id: string;
  key: string;
  title: string;
  type: IssueType;
  status: IssueStatus;
  /** Day of the month, already resolved in UTC by the page. */
  day: number;
}

export interface CalendarMember {
  id: string;
  name: string;
}

/**
 * Roughly how tall the composer is, used only to place it on the first paint
 * before it can be measured. Over-estimating is the safe direction: it flips
 * the panel above a fraction earlier than strictly needed, where the effect
 * below then confirms or corrects it against the real height.
 */
const ESTIMATED_COMPOSER_HEIGHT = 240;

/** `2026-09-03` for the given year/month/day, without touching local time. */
function isoDate(year: number, month: number, day: number): string {
  return `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function ProjectCalendarGrid({
  projectId,
  monthLabel,
  year,
  month,
  cells,
  issues,
  members,
  todayDay,
}: {
  projectId: string;
  monthLabel: string;
  year: number;
  /** Zero-based, as `Date` uses it. */
  month: number;
  /** One entry per grid cell: the day of the month, or `null` for padding. */
  cells: (number | null)[];
  issues: CalendarIssue[];
  /** This project's members, for the composer's assignee control. */
  members: CalendarMember[];
  /** Today's day-of-month when this month is the current one, else `null`. */
  todayDay: number | null;
}) {
  const router = useRouter();
  const { toast } = useToast();

  /** The day whose composer is open, or `null`. */
  const [openDay, setOpenDay] = useState<number | null>(null);
  /**
   * Which side of the day the composer opens on.
   *
   * A day near the foot of the calendar has no room below it, and a panel
   * anchored to `top: 100%` there runs off the bottom of the window — the
   * fields and the Create button end up somewhere nobody can reach. The side
   * is therefore measured rather than assumed: below when it fits, above when
   * it does not.
   */
  const [place, setPlace] = useState<"below" | "above">("below");
  const [title, setTitle] = useState("");
  const [type, setType] = useState<IssueType>("TASK");
  const [assigneeId, setAssigneeId] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const gridRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);

  /**
   * Which side a composer anchored to this cell should open on.
   *
   * `height` is the panel's real height once it has been rendered, and a
   * conservative estimate before that — enough to place it correctly on the
   * very first paint, so it never appears below and then jumps above.
   *
   * Below is preferred: it is where a panel anchored to a control is expected.
   * Above is used only when below would be clipped *and* above actually has
   * the room, so a window too short for either still shows the panel where it
   * can at least be scrolled to.
   */
  const sideFor = useCallback((cell: Element, height: number) => {
    const rect = cell.getBoundingClientRect();
    const gap = 8;
    const fitsBelow = rect.bottom + height + gap <= window.innerHeight;
    const fitsAbove = rect.top - height - gap >= 0;
    return !fitsBelow && fitsAbove ? "above" : "below";
  }, []);

  const close = useCallback(() => {
    setOpenDay(null);
    setTitle("");
    setType("TASK");
    setAssigneeId("");
    setError(null);
  }, []);

  /* Escape closes it, and so does a click anywhere outside — the two ways out
     of every other transient panel in Prio. */
  useEffect(() => {
    if (openDay === null) return;

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    const onPointerDown = (event: PointerEvent) => {
      const composer = gridRef.current?.querySelector(".prio-calendar__composer");
      if (composer && !composer.contains(event.target as Node)) close();
    };

    document.addEventListener("keydown", onKey);
    /* Capture, so the handler runs before React's own click handling — a
       pointer down on another day's add button must close this composer and
       let that day open its own. */
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [openDay, close]);

  // Focus lands in the field the moment the composer opens.
  useEffect(() => {
    if (openDay !== null) titleRef.current?.focus();
  }, [openDay]);

  /*
   * Correct the side against the panel's real height, and keep it right while
   * the window changes. The click-time estimate places it; this is what makes
   * the placement true for a composer that grew — an error message under the
   * title adds a line — or a window that was resized while it is open.
   */
  useEffect(() => {
    if (openDay === null) return;

    const settle = () => {
      const composer = composerRef.current;
      const cell = composer?.closest(".prio-calendar__cell");
      if (!composer || !cell) return;
      setPlace(sideFor(cell, composer.offsetHeight));
    };

    settle();
    window.addEventListener("resize", settle);
    /* The calendar scrolls with the page, so the room below a day changes
       without the window changing size. */
    window.addEventListener("scroll", settle, true);
    return () => {
      window.removeEventListener("resize", settle);
      window.removeEventListener("scroll", settle, true);
    };
  }, [openDay, error, sideFor]);

  async function submit(day: number) {
    if (saving) return; // A second click while the first is in flight is not a second issue.

    const trimmed = title.trim();
    if (trimmed.length === 0) {
      setError("Give it a title.");
      titleRef.current?.focus();
      return;
    }

    setSaving(true);
    setError(null);

    const result = await createIssue({
      projectId,
      type,
      title: trimmed,
      assigneeId: assigneeId || null,
      /* Date-only, exactly as the Create dialog's date input sends it. */
      dueDate: isoDate(year, month, day),
    });

    setSaving(false);

    if (!result.ok) {
      setError(result.fieldErrors?.title ?? result.error);
      return;
    }

    close();
    toast(
      <>
        Created <strong>{result.data.key}</strong> — due{" "}
        {isoDate(year, month, day)}
      </>,
    );
    /* The page re-queries and the new issue arrives in its cell. Nothing is
       inserted into local state, so what is on screen is always what was
       stored. */
    router.refresh();
  }

  const issuesFor = (day: number) => issues.filter((issue) => issue.day === day);

  return (
    <div
      className="prio-calendar"
      role="grid"
      aria-label={monthLabel}
      ref={gridRef}
    >
      {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((day) => (
        <div key={day} className="prio-calendar__weekday" role="columnheader">
          {day}
        </div>
      ))}

      {cells.map((day, index) => {
        const dayIssues = day === null ? [] : issuesFor(day);
        const composing = day !== null && openDay === day;
        /* The last two columns open their composer to the left, so it cannot
           be clipped by the edge of the grid. */
        const column = index % 7;

        return (
          <div
            key={day ?? `pad-${index}`}
            className="prio-calendar__cell"
            data-empty={day === null || undefined}
            data-today={(todayDay !== null && day === todayDay) || undefined}
            data-composing={composing || undefined}
            role="gridcell"
          >
            {day === null ? null : (
              <>
                <span className="prio-calendar__day">{day}</span>

                {dayIssues.map((issue) => (
                  <Link
                    key={issue.id}
                    href={`/issues/${issue.key.toLowerCase()}`}
                    className="prio-calendar__issue"
                    data-done={isClosedStatus(issue.status) || undefined}
                    title={`${issue.key} — ${issue.title}`}
                  >
                    <IssueTypeIcon type={issue.type} size={12} />
                    <IssueKey issueKey={issue.key} />
                    <span className="prio-truncate">{issue.title}</span>
                    <StatusPill status={issue.status} />
                  </Link>
                ))}

                {/*
                 * The free space below the day's issues, as a button.
                 *
                 * Deliberately not a click handler on the cell: the issues
                 * above are links to their own pages, and a cell-wide handler
                 * would have to guess whether a click was meant for one of
                 * them. A button that occupies only what is left over cannot
                 * be hit by accident, and it is reachable from the keyboard,
                 * which a clickable `div` would not be.
                 */}
                <button
                  type="button"
                  className="prio-calendar__add"
                  aria-label={`Add an issue due ${day} ${monthLabel}`}
                  aria-expanded={composing}
                  onClick={(event) => {
                    if (composing) close();
                    else {
                      setTitle("");
                      setType("TASK");
                      setAssigneeId("");
                      setError(null);
                      /* Placed before it is rendered, from the day's own box
                         and a conservative height, so the first paint is
                         already on the right side. The effect above then
                         corrects it against the real height. */
                      const cell = event.currentTarget.closest(
                        ".prio-calendar__cell",
                      );
                      if (cell) setPlace(sideFor(cell, ESTIMATED_COMPOSER_HEIGHT));
                      setOpenDay(day);
                    }
                  }}
                >
                  <IconPlus size={12} />
                </button>

                {composing ? (
                  <div
                    ref={composerRef}
                    className="prio-calendar__composer"
                    data-align={column >= 5 ? "end" : undefined}
                    data-place={place}
                    role="dialog"
                    aria-label={`New issue due ${day} ${monthLabel}`}
                  >
                    <div className="prio-calendar__composer-head">
                      <span className="prio-calendar__composer-date">
                        {day} {monthLabel}
                      </span>
                      <button
                        type="button"
                        className="prio-calendar__composer-close"
                        aria-label="Close"
                        onClick={close}
                      >
                        <IconClose size={13} />
                      </button>
                    </div>

                    <form
                      onSubmit={(event) => {
                        event.preventDefault();
                        void submit(day);
                      }}
                    >
                      <label
                        className="prio-visually-hidden"
                        htmlFor="calendar-new-title"
                      >
                        What needs to be done?
                      </label>
                      <input
                        ref={titleRef}
                        id="calendar-new-title"
                        className="prio-input"
                        value={title}
                        placeholder="What needs to be done?"
                        maxLength={200}
                        onChange={(event) => setTitle(event.target.value)}
                      />

                      <div className="prio-calendar__composer-row">
                        <label
                          className="prio-visually-hidden"
                          htmlFor="calendar-new-type"
                        >
                          Issue type
                        </label>
                        <select
                          id="calendar-new-type"
                          className="prio-select"
                          value={type}
                          onChange={(event) =>
                            setType(event.target.value as IssueType)
                          }
                        >
                          {ISSUE_TYPES.map((option) => (
                            <option key={option} value={option}>
                              {ISSUE_TYPE_LABEL[option]}
                            </option>
                          ))}
                        </select>

                        <label
                          className="prio-visually-hidden"
                          htmlFor="calendar-new-assignee"
                        >
                          Assignee
                        </label>
                        <select
                          id="calendar-new-assignee"
                          className="prio-select"
                          value={assigneeId}
                          onChange={(event) => setAssigneeId(event.target.value)}
                        >
                          <option value="">Unassigned</option>
                          {members.map((member) => (
                            <option key={member.id} value={member.id}>
                              {member.name}
                            </option>
                          ))}
                        </select>
                      </div>

                      {error ? (
                        <p className="prio-error" role="alert">
                          <IconWarning size={12} />
                          {error}
                        </p>
                      ) : null}

                      <div className="prio-calendar__composer-actions">
                        <Button
                          variant="ghost"
                          size="sm"
                          type="button"
                          onClick={close}
                          disabled={saving}
                        >
                          Cancel
                        </Button>
                        <Button
                          variant="brand"
                          size="sm"
                          type="submit"
                          loading={saving}
                          disabled={saving}
                        >
                          {saving ? "Creating…" : "Create"}
                        </Button>
                      </div>
                    </form>
                  </div>
                ) : null}
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
