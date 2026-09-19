"use client";

import { useLinkStatus } from "next/link";

/**
 * Says that the link it sits in has been pressed and the server is answering.
 *
 * For controls that choose what the page below them shows rather than taking
 * the reader somewhere else. Those are the ones where a press can otherwise
 * look ignored: the address bar changes, the page does not, and what is on
 * screen is still the previous answer until the new render lands.
 *
 * `useLinkStatus` reports the enclosing `Link`'s own navigation, so only the
 * control that was actually pressed says anything — which is also what keeps
 * it useful, since it marks the one whose answer is coming.
 *
 * Nothing is rendered while nothing is pending, so a tile that is merely sitting
 * there is unchanged, and the spinner is the one Prio already has.
 */
export function LinkPending() {
  const { pending } = useLinkStatus();
  if (!pending) return null;

  return (
    <span className="prio-stat__pending" role="status">
      <span className="prio-spinner" aria-hidden />
      <span className="prio-visually-hidden">Loading</span>
    </span>
  );
}
