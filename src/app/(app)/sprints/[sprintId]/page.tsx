import type { Metadata } from "next";
import { notFound } from "next/navigation";
import {
  BurndownDisclosure,
  BurndownPanel,
  BurndownToggle,
} from "@/components/sprints/BurndownDisclosure";
import { BackLink } from "@/components/shell/BackLink";
import { SprintDetailsView } from "@/components/sprints/SprintDetailsView";
import { canAccessProject } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { loadBurndown, loadSprints } from "@/server/queries/sprints";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Sprint" };

/**
 * A sprint's details, read only: reached from the Projects directory's
 * Iterations/Sprints block, not from a project's own shell — so this page
 * carries its own project name and Back link rather than borrowing the
 * project layout's tab strip, which would offer edits this page does not.
 *
 * The rendering itself is `SprintDetailsView`, shared with the project's own
 * `sprints/[sprintId]` page — the two differ only in where Back leads and
 * whether the project shell wraps them. The burndown is on both for the same
 * reason: which link somebody followed to reach a sprint should not decide
 * whether they can see how it is going.
 */
export default async function SprintDetailsPage({
  params,
}: {
  params: Promise<{ sprintId: string }>;
}) {
  const { sprintId } = await params;
  const user = await requireUser();

  const sprintRow = await prisma.sprint.findUnique({
    where: { id: sprintId },
    select: {
      projectId: true,
      project: { select: { id: true, key: true, name: true } },
    },
  });
  if (!sprintRow) notFound();

  /*
   * Reading a sprint has always belonged to whoever may open its project —
   * the same rule the project's own Sprints tab reads. Checked here rather
   * than trusted from the route, because this page is reached by a bare
   * sprint id and an administrator's link is not proof that this reader may
   * see it too.
   */
  if (!(await canAccessProject(user, sprintRow.projectId))) notFound();

  const sprints = await loadSprints(sprintRow.project.id);
  const sprint = sprints.find((s) => s.id === sprintId);
  if (!sprint) notFound();

  const chart = await loadBurndown(sprint.id);

  return (
    <>
      <BackLink
        href={`/projects?project=${sprintRow.project.id}`}
        label="Back to sprints"
      />

      <p
        className="prio-text-muted"
        style={{ marginTop: "var(--prio-space-2)" }}
      >
        {sprintRow.project.name} <span className="prio-key">{sprintRow.project.key}</span>
      </p>

      <div style={{ marginTop: "var(--prio-space-3)" }}>
        <BurndownDisclosure>
          <SprintDetailsView
            sprint={sprint}
            /* This page has no actions on the sprint — it is read from the
               Projects directory, with no project in context to add work from
               — so the header's row holds the burndown's button alone. The
               chart is opened the same way it is on the project's own sprint
               page, rather than being always open on one page and not the
               other. */
            actions={chart ? <BurndownToggle /> : null}
          >
            {chart ? <BurndownPanel data={chart} /> : null}
          </SprintDetailsView>
        </BurndownDisclosure>
      </div>
    </>
  );
}
