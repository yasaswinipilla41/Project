"use client";

import { useEffect, useState } from "react";
import styles from "./SnipTool.module.css";

/**
 * A red ring where the pointer was pressed, while a recording is running.
 *
 * A screen recording made to show somebody how to do something is much harder
 * to follow without this: the cursor moves, something changes, and the viewer
 * is left inferring that a click happened at all. The ring says where, once,
 * and then goes.
 *
 * It is drawn into the page rather than composited into the video, which has
 * one consequence worth being plain about: it appears in the recording when
 * the captured surface is the Prio tab or a screen containing it, and does not
 * when somebody records a different tab. Nothing inside a page can paint onto
 * another surface, and pretending otherwise would be worse than the limit.
 *
 * Deliberately passive — `pointer-events: none`, no state kept beyond the few
 * hundred milliseconds a ring lives, and every listener removed when recording
 * stops. It never sits between the person and the thing they are clicking.
 */

interface Pulse {
  id: number;
  x: number;
  y: number;
}

/** How long one ring lives. Long enough to register, short enough to go. */
const LIFETIME_MS = 550;

export function ClickPulse({ active }: { active: boolean }) {
  const [pulses, setPulses] = useState<Pulse[]>([]);

  useEffect(() => {
    if (!active) return;

    let next = 0;
    const timers: ReturnType<typeof setTimeout>[] = [];

    function onPointerDown(event: PointerEvent) {
      /* Only a real press from a real device, and only the primary button:
         a right-click opening a context menu is not "the user clicked here"
         in the sense a viewer is looking for. */
      if (event.button !== 0) return;

      const id = (next += 1);
      setPulses((current) => [...current, { id, x: event.clientX, y: event.clientY }]);

      timers.push(
        setTimeout(() => {
          setPulses((current) => current.filter((pulse) => pulse.id !== id));
        }, LIFETIME_MS),
      );
    }

    /* Capture phase, so a click that something else stops still shows. The
       listener never calls `preventDefault` — it only watches. */
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      for (const timer of timers) clearTimeout(timer);
      /* Cleared as the recording ends rather than on the way in: a ring left
         behind would outlive the thing it was marking. */
      setPulses([]);
    };
  }, [active]);

  if (!active || pulses.length === 0) return null;

  return (
    <div className={styles.pulseLayer} aria-hidden>
      {pulses.map((pulse) => (
        <span
          key={pulse.id}
          className={styles.pulse}
          style={{ left: pulse.x, top: pulse.y }}
        />
      ))}
    </div>
  );
}
