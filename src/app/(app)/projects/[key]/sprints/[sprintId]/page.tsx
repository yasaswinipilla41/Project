import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { BackLink } from "@/components/shell/BackLink";
import { SprintDetailsView } from "@/components/sprints/SprintDetailsView";
import { projectScope } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { loadSprints } from "@/server/queries/sprints";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Sprint" };

/**
 * One sprint's details, reached by clicking it on the project's own Sprints
 * page — a dedicated URL per sprint (`/projects/:key/sprints/:sprintId`)
 * rather than an in-place expansion, so a specific sprint is always a real,
 * shareable destination.
 *
 * Nested under the project's own route on purpose: it inherits the project
 * shell (header, tab strip) from `projects/[key]/layout.tsx` exactly like
 * every other project view, and the Sprints tab still reads as active,
 * because `ProjectNav` matches by the longest prefix and this path starts
 * with `/sprints`. The project is loaded through `projectScope`, the same
 * rule the Sprints list page itself reads — so this page opens for exactly
 * the four roles that could already open that list, and for no one else.
 *
 * The rendering is `SprintDetailsView`, shared with the Projects directory's
 * own `/sprints/[sprintId]` page; the two differ only in where Back leads.
 */
export default async function ProjectSprintDetailsPage({
  params,
}: {
  params: Promise<{ key: string; sprintId: string }>;
}) {
  const { key, sprintId } = await params;
  const user = await requireUser();

  const project = await prisma.project.findFirst({
    where: { key: key.toUpperCase(), ...projectScope(user) },
    select: { id: true, key: true },
  });
  if (!project) notFound();

  const sprints = await loadSprints(project.id);
  const sprint = sprints.find((s) => s.id === sprintId);
  if (!sprint) notFound();

  return (
    <>
      <BackLink
        href={`/projects/${project.key.toLowerCase()}/sprints`}
        label="Back to sprints"
      />

      <div style={{ marginTop: "var(--prio-space-3)" }}>
        <SprintDetailsView sprint={sprint} />
      </div>
    </>
  );
}
