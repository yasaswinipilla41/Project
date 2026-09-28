import { SprintDetailsSkeleton } from "@/components/sprints/SprintDetailsSkeleton";

/**
 * A sprint's details reached from the Projects directory, while it is read.
 *
 * The same placeholder the project's own sprint page uses, because the two
 * render the same blocks through the same `SprintDetailsView` — see
 * `SprintDetailsSkeleton`.
 */
export default function Loading() {
  return <SprintDetailsSkeleton />;
}
