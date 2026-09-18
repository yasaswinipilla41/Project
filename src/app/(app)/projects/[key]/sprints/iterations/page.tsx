import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ProjectSprintsBlock } from "@/components/projects/ProjectSprintsBlock";
import { BackLink } from "@/components/shell/BackLink";
import { projectScope } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { loadSprints } from "@/server/queries/sprints";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Iterations / Sprints" };

/**
 * The project's Iterations / Sprints, as a page of its own inside the project.
 *
 * The same `ProjectSprintsBlock` and the same `loadSprints` the Projects
 * directory uses — one list, one query — with the project fixed by the route
 * rather than chosen from a picker. It lives under `/sprints` so the Sprints
 * tab stays the active one, and each row opens the sprint's own page inside
 * this project (`?from=iterations`, so Back returns here) rather than leaving
 * for the directory.
 *
 * The project is loaded through `projectScope`, the same rule the Sprints page
 * reads, so every role that can open the Sprints section can open this.
 */
export default async function ProjectIterationsPage({
  params,
}: {
  params: Promise<{ key: string }>;
}) {
  const { key } = await params;
  const user = await requireUser();

  const project = await prisma.project.findFirst({
    where: { key: key.toUpperCase(), ...projectScope(user) },
    select: { id: true, key: true, name: true },
  });
  if (!project) notFound();

  const sprints = await loadSprints(project.id);
  const base = `/projects/${project.key.toLowerCase()}/sprints`;

  return (
    <>
      <BackLink href={base} label="Back to sprints" tone="sprint" />

      <div className="prio-sprints__head" style={{ marginTop: "var(--prio-space-2)" }}>
        <div>
          <h2 className="prio-issue__section-title">Iterations / Sprints</h2>
          <p className="prio-text-muted">
            Every iteration of {project.name}, with its status, dates and
            progress.
          </p>
        </div>
      </div>

      <ProjectSprintsBlock
        sprints={sprints}
        projectName={project.name}
        sprintHref={(sprintId) => `${base}/${sprintId}?from=iterations`}
      />
    </>
  );
}
