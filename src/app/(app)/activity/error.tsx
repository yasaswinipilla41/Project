"use client";

import { useEffect } from "react";
import { Alert, Button } from "@/components/ui/primitives";
import { IconWarning } from "@/components/ui/Icon";

/**
 * Next's route-level error boundary for `/activity` (the framework's own
 * mechanism for exactly this: a server-render failure with a retry action —
 * `reset()` re-runs the segment rather than reloading the whole page).
 */
export default function ActivityError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[prio] activity feed failed to load:", error);
  }, [error]);

  return (
    <div className="prio-page-header">
      <div className="prio-page-header__text" style={{ maxWidth: 480 }}>
        <Alert tone="danger" icon={<IconWarning />}>
          <p style={{ margin: 0, fontWeight: 600 }}>Unable to load activity.</p>
          <p style={{ margin: "var(--prio-space-2) 0 var(--prio-space-4)" }}>
            Something went wrong while fetching the activity feed.
          </p>
          <Button variant="secondary" size="sm" onClick={reset}>
            Try again
          </Button>
        </Alert>
      </div>
    </div>
  );
}
