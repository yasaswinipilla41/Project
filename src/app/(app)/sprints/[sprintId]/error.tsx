"use client";

import { useEffect } from "react";
import { LoadError } from "@/components/ui/LoadError";

/**
 * A sprint reached from the Projects directory, when the read behind it fails.
 *
 * The same boundary the project's own sprint page has, for the same reason:
 * which link somebody followed to reach a sprint should not decide whether a
 * failed read is reported or silently shown as an empty sprint.
 */
export default function SprintDetailsError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => {
    console.error("[prio] sprint details failed to load:", error);
  }, [error]);

  return (
    <div style={{ maxWidth: 520 }}>
      <LoadError
        title="Unable to load this sprint."
        body="Something went wrong while reading the sprint. Its issues and its record have not been changed."
        onRetry={retry}
      />
    </div>
  );
}
