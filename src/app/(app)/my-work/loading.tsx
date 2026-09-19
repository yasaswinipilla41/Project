import { Card, CardBody, Skeleton } from "@/components/ui/primitives";

/**
 * My Work, while the server works out what is on it.
 *
 * Choosing a tile is a server navigation, and without this the previous tile's
 * rows stayed on screen for the length of the new query — the old list
 * presented under the new tile's name, which is the one thing a category
 * chooser must not do.
 *
 * It stands in for the whole page rather than for the list alone. Suspending
 * only the list would let the figures paint first, which sounds better and is
 * worse: the response then streams in two stages, and a Back that is a
 * document navigation paints the incoming figures while the outgoing ones are
 * still on screen — two summary rows at once, which is a good deal louder than
 * a moment of placeholder.
 *
 * Built from the `Skeleton` primitive and the shimmer it already carries, so
 * there is no second loading vocabulary and it follows the theme like the rest
 * of the application.
 */
export default function Loading() {
  return (
    <div role="status" aria-live="polite">
      <span className="prio-visually-hidden">Loading your work</span>

      <div className="prio-page-header">
        <div className="prio-page-header__text">
          <Skeleton variant="title" width={180} />
          <Skeleton variant="text" width={260} />
        </div>
      </div>

      {/* The four figures, in the grid they occupy, so nothing moves when the
          real ones arrive. */}
      <div className="row g-3" style={{ marginBottom: "var(--prio-space-6)" }}>
        {[0, 1, 2, 3].map((tile) => (
          <div key={tile} className="col-6 col-xl-3">
            <Skeleton variant="block" height={92} />
          </div>
        ))}
      </div>

      <Card>
        <CardBody>
          <Skeleton variant="title" />
          {[0, 1, 2, 3, 4].map((row) => (
            <Skeleton key={row} variant="block" height={44} />
          ))}
        </CardBody>
      </Card>
    </div>
  );
}
