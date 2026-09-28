"use client";

import { useEffect } from "react";
import { LoadError } from "@/components/ui/LoadError";

/**
 * The project's Sprints page, when the read behind it fails.
 *
 * Next's own route boundary, which is the framework's mechanism for exactly
 * this: `retry()` re-runs the segment on the server rather than reloading the
 * document, so the reader stays where they were and the sprints are simply
 * queried again.
 *
 * It exists because the alternative is worse than an error message. Without a
 * boundary here, a failed `loadSprints` either takes out the whole application
 * shell or — far more dangerous — gets caught somewhere upstream and renders as
 * an empty list, telling somebody their project has no sprints when the truth
 * is that nobody could find out. "No sprints yet" is a fact about a project;
 * this is a fact about a request, and the page must never say the first when it
 * means the second.
 */
export default function ProjectSprintsError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => {
    console.error("[prio] project sprints failed to load:", error);
  }, [error]);

  return (
    <div style={{ maxWidth: 520 }}>
      <LoadError
        title="Unable to load sprints."
        body="Something went wrong while reading this project's sprints. They have not been changed."
        onRetry={retry}
      />
    </div>
  );
}
