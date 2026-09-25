import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { BackLink } from "@/components/shell/BackLink";
import { SprintDetailsActions } from "@/components/sprints/SprintDetailsActions";
import { SprintDetailsView } from "@/components/sprints/SprintDetailsView";
import { SprintIssueBoard } from "@/components/sprints/SprintIssueBoard";
import {
  BurndownDisclosure,
  BurndownPanel,
  BurndownToggle,
} from "@/components/sprints/BurndownDisclosure";
import { Card, CardBody } from "@/components/ui/primitives";
import { projectScope, workRoleOf } from "@/lib/authz";
import { canMoveToNextSprint } from "@/lib/sprintMove";
import {
  canDeleteSprint,
  canEditSprintDetails,
  canEditSprintIssues,
  canStartSprint,
} from "@/lib/domain";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import {
  loadBurndown,
  loadSprintBacklog,
  loadSprints,
} from "@/server/queries/sprints";

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

  const [sprints, workRole, backlog] = await Promise.all([
    loadSprints(project.id),
    workRoleOf(user),
    /* This project's unsprinted open work — what Add issues offers, and the
       same query the Sprints page reads it with. */
    loadSprintBacklog(project.id),
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
      /* Where each issue came from, so a card can offer to put it back. */
      previousSprintId: true,
      assignee: { select: { id: true, name: true, image: true } },
      labels: {
        select: { label: { select: { id: true, name: true, color: true } } },
      },
    },
  });

  /*
   * What Restore would mean for each card: the sprint the issue was moved out
   * of, when that sprint is one of this project's and is still open. Resolved
   * from the sprints already read for this page rather than queried again, and
   * a sprint that has since been completed or deleted is left out — there is
   * nothing to restore into, so nothing is offered.
   */
  const openBySprintId = new Map(
    sprints
      .filter((one) => one.status !== "COMPLETED")
      .map((one) => [one.id, { id: one.id, name: one.name }]),
  );
  const previousSprints: Record<string, { id: string; name: string }> = {};
  for (const issue of issues) {
    const previous = issue.previousSprintId
      ? openBySprintId.get(issue.previousSprintId)
      : undefined;
    if (previous && previous.id !== sprint.id) previousSprints[issue.id] = previous;
  }

  const base = `/projects/${project.key.toLowerCase()}/sprints`;
  const back =
    from === "iterations"
      ? { href: `${base}/iterations`, label: "Back to iterations" }
      : { href: base, label: "Back to sprints" };

  /* Read here, on the server, from the sprint's own work and the trail its
     remaining-hours changes are already written to. */
  const chart = await loadBurndown(sprint.id);

  return (
    <>
      <BackLink href={back.href} label={back.label} tone="sprint" />

      {/* The burndown's open/closed state, shared by the button in the header
          and the panel below it — see `BurndownDisclosure`. It wraps the view
          rather than living inside it because those two are drawn in different
          places, and nothing else here is client state. */}
      <div style={{ marginTop: "var(--prio-space-3)" }}>
        <BurndownDisclosure>
          <SprintDetailsView
            sprint={sprint}
            /*
             * Who may do what comes from the one capability table `domain.ts`
             * owns and `sprints.ts` enforces again on the server, so this only
             * decides what is worth drawing:
             *   - adding issues to a sprint or taking them out is every working
             *     role's — Admin, Developer, Tester and Full Stack alike;
             *   - renaming it or moving its dates is theirs too;
             *   - starting a planned sprint is an administrator's, and a Full
             *     Stack Developer's;
             *   - deleting one is an administrator's.
             */
            actions={
              <SprintDetailsActions
                sprint={sprint}
                /* First in the row, before Add issues and Edit: reading the
                   sprint comes before changing it. Offered only where there is
                   a chart to open. */
                leading={chart ? <BurndownToggle /> : null}
                projectId={project.id}
                projectKey={project.key}
                backlog={backlog}
                canEditIssues={canEditSprintIssues(workRole)}
                canEdit={canEditSprintDetails(workRole)}
                canStart={canStartSprint(workRole)}
                canDelete={canDeleteSprint(workRole)}
                backHref={back.href}
              />
            }
          >
            {/*
              * On this page rather than on one of its own: a burndown answers a
              * question somebody is already asking while looking at this screen,
              * and sending them elsewhere to see it is how it stops being looked
              * at. Behind its header button rather than always open, because it
              * is the tallest thing here and the sprint's own work should not
              * start a screen down.
              */}
            {chart ? <BurndownPanel data={chart} /> : null}

            <Card style={{ marginTop: "var(--prio-space-4)" }}>
              <CardBody>
                <h2 className="prio-issue__section-title">Issues in this sprint</h2>
                <SprintIssueBoard
                  issues={issues}
                  workRole={workRole}
                  currentUserId={user.id}
                  isAdmin={user.role === "ADMIN"}
                  /* Where a card's Move to can send its work: this project's
                     other sprints that are still open, from the same
                     `loadSprints` read the rest of this page is drawn from. */
                  previousSprints={previousSprints}
                  otherOpenSprints={sprints
                    .filter(
                      (other) =>
                        other.id !== sprint.id && other.status !== "COMPLETED",
                    )
                    .map((other) => ({ id: other.id, name: other.name }))}
                  /* Filling a sprint, emptying it or moving its work is every
                     working role's, and the server says so again. A completed
                     sprint is a closed record, so nothing moves out of one. */
                  canMoveIssues={
                    canEditSprintIssues(workRole) && sprint.status !== "COMPLETED"
                  }
                  /* Offered only where there is one to reach — otherwise the
                     entry is there and the move comes back "No future Sprint is
                     available." Read from the same `loadSprints` above, so it
                     costs nothing to ask. */
                  hasNextSprint={canMoveToNextSprint(sprints, sprint)}
                />
              </CardBody>
            </Card>
          </SprintDetailsView>
        </BurndownDisclosure>
      </div>
    </>
  );
}
