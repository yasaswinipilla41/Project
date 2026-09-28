import { Card, CardBody, Skeleton } from "@/components/ui/primitives";

/**
 * A sprint details page, while the server is still reading it.
 *
 * One skeleton for both of the pages that show a sprint's details — the
 * project's own `sprints/[sprintId]` and the cross-project `sprints/[sprintId]`
 * reached from the Projects directory — because they render the same blocks
 * through the same `SprintDetailsView`. Two placeholders for one layout is how
 * they would end up disagreeing with it.
 *
 * It stands in for the blocks that are actually there, in their order and
 * roughly their height: the sprint's own card, its issues, and the chart of
 * those issues by status. Each is a bordered card, the same as the real thing,
 * so the page does not gain and lose its edges as it loads.
 *
 * Deliberately no "no issues in this sprint" and no empty chart: until the read
 * lands there is nothing to be empty. The shimmer says the page is still
 * arriving; every empty state on it waits for an answer first.
 */
export function SprintDetailsSkeleton() {
  return (
    <div role="status" aria-live="polite">
      <span className="prio-visually-hidden">Loading sprint</span>

      <Skeleton variant="text" width={120} />

      <div style={{ marginTop: "var(--prio-space-3)" }}>
        {/* The sprint's own block: name, dates, goal, then its five figures. */}
        <Card>
          <CardBody>
            <Skeleton variant="title" width={300} />
            <Skeleton variant="text" width={240} />
            <Skeleton variant="block" height={64} />
            <Skeleton variant="block" height={10} />
          </CardBody>
        </Card>

        {/* Issues in this sprint, as a row of status blocks. */}
        <Card style={{ marginTop: "var(--prio-space-4)" }}>
          <CardBody>
            <Skeleton variant="title" width={180} />
            <div className="row g-3">
              {[0, 1, 2].map((column) => (
                <div key={column} className="col-12 col-md-4">
                  <Skeleton variant="block" height={140} />
                </div>
              ))}
            </div>
          </CardBody>
        </Card>

        {/* Issues by status. */}
        <Card style={{ marginTop: "var(--prio-space-4)" }}>
          <CardBody>
            <Skeleton variant="title" width={150} />
            <Skeleton variant="block" height={200} />
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
