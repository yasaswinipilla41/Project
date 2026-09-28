"use client";

import { useEffect } from "react";
import { LoadError } from "@/components/ui/LoadError";

/**
 * One sprint's page inside its project, when the read behind it fails.
 *
 * Its own boundary rather than the Sprints list's, so a sprint that cannot be
 * read is reported on the sprint's own page and the list it was opened from
 * keeps working.
 *
 * This is the page-wide failure only — the dependency that genuinely prevents
 * the page from existing, which is the sprint itself. The blocks on it that can
 * fail independently say so independently: the burndown is read separately and
 * carries its own error, so a chart that cannot be drawn never takes the
 * sprint's issues down with it.
 */
export default function ProjectSprintDetailsError({
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
