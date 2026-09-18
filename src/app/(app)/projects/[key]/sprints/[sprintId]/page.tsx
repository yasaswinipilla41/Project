import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { BackLink } from "@/components/shell/BackLink";
import { SprintDetailsView } from "@/components/sprints/SprintDetailsView";
import { SprintIssueBoard } from "@/components/sprints/SprintIssueBoard";
import { Card, CardBody } from "@/components/ui/primitives";
import { projectScope, workRoleOf } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { loadSprints } from "@/server/queries/sprints";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Sprint" };

/**
 * One sprint's own page inside its project: its details, and its issues
 * grouped by the status each is in right now.
 *
 * Nested under the project's route, so it inherits the project shell and the
 * Sprints tab stays active. The project is loaded through `projectScope`, the
 * rule the Sprints list itself reads, so this opens for exactly the roles
 * that could open that list.
 *
 * Which issues are "this sprint's" comes from `loadSprints` — the same
 * membership its figures are counted from — so the blocks and the stats can
 * never disagree: live membership while the sprint runs, its permanent record
 * once it has closed. The cards are then read fresh, scoped to this project
 * as well, so each shows its current status and lands in the right block.
 */
export default async function ProjectSprintDetailsPage({
  params,
  searchParams,
}: {
  params: Promise<{ key: string; sprintId: string }>;
  /** `from=iterations` when opened from the project's Iterations / Sprints
   *  page, so Back returns there. Anything else is ignored. */
  searchParams: Promise<{ from?: string }>;
}) {
  const { key, sprintId } = await params;
  const { from } = await searchParams;
  const user = await requireUser();

  const project = await prisma.project.findFirst({
    where: { key: key.toUpperCase(), ...projectScope(user) },
    select: { id: true, key: true },
  });
  if (!project) notFound();

  const [sprints, workRole] = await Promise.all([
    loadSprints(project.id),
    workRoleOf(user),
  ]);
  const sprint = sprints.find((s) => s.id === sprintId);
  if (!sprint) notFound();

  const issues = await prisma.issue.findMany({
    where: {
      id: { in: sprint.issues.map((issue) => issue.id) },
      projectId: project.id,
    },
    orderBy: [{ sortIndex: "asc" }, { number: "asc" }],
    select: {
      id: true,
      key: true,
      type: true,
      title: true,
      status: true,
      priority: true,
      sortIndex: true,
      reporterId: true,
      assignee: { select: { id: true, name: true, image: true } },
      labels: {
        select: { label: { select: { id: true, name: true, color: true } } },
      },
    },
  });

  const base = `/projects/${project.key.toLowerCase()}/sprints`;
  const back =
    from === "iterations"
      ? { href: `${base}/iterations`, label: "Back to iterations" }
      : { href: base, label: "Back to sprints" };

  return (
    <>
      <BackLink href={back.href} label={back.label} tone="sprint" />

      <div style={{ marginTop: "var(--prio-space-3)" }}>
        <SprintDetailsView sprint={sprint}>
          <Card style={{ marginTop: "var(--prio-space-4)" }}>
            <CardBody>
              <h2 className="prio-issue__section-title">Issues in this sprint</h2>
              <SprintIssueBoard
                issues={issues}
                workRole={workRole}
                currentUserId={user.id}
                isAdmin={user.role === "ADMIN"}
              />
            </CardBody>
          </Card>
        </SprintDetailsView>
      </div>
    </>
  );
}
