"use client";

import type { ReactNode } from "react";
import { Alert, Button } from "@/components/ui/primitives";
import { IconRefresh, IconWarning } from "@/components/ui/Icon";

/**
 * "Unable to load X." — and a way to try again.
 *
 * A failed request is not an empty one, and the difference has to be visible:
 * an empty state says the answer is nothing, this says there is no answer yet.
 * So it is the danger `Alert` with a warning icon rather than the quiet
 * `EmptyState` with an empty box, and it carries a retry, which an empty state
 * never does — the shape alone tells the two apart before a word is read.
 *
 * The markup is the pattern `/activity`'s route boundary established: a
 * headline, a sentence of explanation, and one secondary button. It is a
 * component because several blocks and route boundaries now need exactly it,
 * and the one thing worse than an error state is two that disagree about
 * whether this is retryable.
 *
 * Retrying is the caller's to define. A route boundary passes Next's own
 * `retry()`, which re-renders the segment on the server; a block inside a page
 * passes whatever re-runs its own read. Where nothing can be retried, no button
 * is drawn rather than one that does nothing.
 */
export function LoadError({
  title,
  body,
  onRetry,
  actionLabel = "Try again",
}: {
  /** What failed, as a sentence: "Unable to load sprints." */
  title: string;
  /** Why the reader is seeing this, and what it does not mean. */
  body?: ReactNode;
  /** Absent when there is nothing this reader can do but leave and come back. */
  onRetry?: () => void;
  actionLabel?: string;
}) {
  return (
    <Alert tone="danger" icon={<IconWarning />}>
      <p style={{ margin: 0, fontWeight: 600 }}>{title}</p>
      {body ? (
        <p style={{ margin: "var(--prio-space-2) 0 0" }}>{body}</p>
      ) : null}
      {onRetry ? (
        <div style={{ marginTop: "var(--prio-space-4)" }}>
          <Button variant="secondary" size="sm" onClick={onRetry}>
            <IconRefresh size={13} />
            {actionLabel}
          </Button>
        </div>
      ) : null}
    </Alert>
  );
}
