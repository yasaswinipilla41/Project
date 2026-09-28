import { Card, CardBody, Skeleton } from "@/components/ui/primitives";

/**
 * The project's Sprints page, while the server works out what is on it.
 *
 * The one thing this exists to prevent: "No sprints yet" — or, now, "No active
 * sprint" — appearing while the query is still running. An empty state is an
 * answer, and until `loadSprints` has returned there is no answer, so the page
 * says it is still asking.
 *
 * Built from the `Skeleton` primitive and the shimmer it already carries, the
 * same way `my-work/loading.tsx` is, so there is no second loading vocabulary
 * and it follows the theme with everything else. It stands in for the whole
 * segment rather than for the list alone: the heading and the actions are read
 * from the project too, and painting them first would stream the page in two
 * stages for no gain.
 *
 * Laid out as the real page is — a header, then a run of tall cards — so the
 * content lands roughly where the placeholder stood instead of jumping.
 */
export default function Loading() {
  return (
    <div role="status" aria-live="polite">
      <span className="prio-visually-hidden">Loading sprints</span>

      <div className="prio-sprints__head">
        <div style={{ flex: 1, minWidth: 0 }}>
          <Skeleton variant="title" width={140} />
          <Skeleton variant="text" width={320} />
        </div>
      </div>

      <div className="prio-sprints">
        {[0, 1].map((card) => (
          <Card key={card}>
            <CardBody>
              <Skeleton variant="title" width={260} />
              <Skeleton variant="text" width={200} />
              <Skeleton variant="block" height={64} />
              <Skeleton variant="block" height={10} />
            </CardBody>
          </Card>
        ))}
      </div>
    </div>
  );
}
