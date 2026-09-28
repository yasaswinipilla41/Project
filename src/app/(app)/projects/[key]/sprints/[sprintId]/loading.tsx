import { SprintDetailsSkeleton } from "@/components/sprints/SprintDetailsSkeleton";

/**
 * One sprint's page inside its project, while it is being read.
 *
 * Its own placeholder rather than the Sprints list's, because this page is a
 * different shape: one sprint's card, then its issues, then its chart. Opening
 * a sprint from the list is a server navigation, and without this the list
 * stayed on screen for the length of the query — or, worse, the page painted
 * its empty states before the sprint's work had arrived.
 */
export default function Loading() {
  return <SprintDetailsSkeleton />;
}
