import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { NewSprintButton } from "@/components/sprints/NewSprintButton";
import { SprintCard } from "@/components/sprints/SprintCard";
import { ButtonLink, Card, EmptyState } from "@/components/ui/primitives";
import { IconEmptyBox, IconTimeline } from "@/components/ui/Icon";
import { projectScope, workRoleOf } from "@/lib/authz";
import {
  canCompleteSprint,
  canCreateSprint,
  canDeleteSprint,
  canEditSprintDetails,
  canEditSprintIssues,
  canStartSprint,
} from "@/lib/domain";
import { prisma } from "@/lib/prisma";
import { loadSprintBacklog, loadSprints } from "@/server/queries/sprints";
import { requireUser } from "@/lib/session";

export const metadata: Metadata = { title: "Sprints" };
export const dynamic = "force-dynamic";

/**
 * The project's sprints: plan one, fill it, start it, work it, complete it.
 *
 * One page for the whole lifecycle rather than a page per stage. A sprint's
 * card shows what that stage of it needs — the chosen work and Start Sprint
 * while it is planned, a status board while it runs, its record once it is
 * closed — so the workflow is a sequence of states on one screen instead of a
 * sequence of screens.
 *
 * Everything on it is this project's. The project comes from the route and is
 * loaded through `projectScope`, so somebody who cannot see the project gets
 * the not-found page; the sprints and the backlog are both queried by that
 * project's id, so nothing from another project can appear here — not in a
 * sprint, not in the picker, not in a count.
 */
export default async function ProjectSprintsPage({
  params,
}: {
  params: Promise<{ key: string }>;
}) {
  const { key } = await params;
  const user = await requireUser();
  const workRole = await workRoleOf(user);

  const project = await prisma.project.findFirst({
    where: { key: key.toUpperCase(), ...projectScope(user) },
    select: { id: true, key: true, name: true, createdById: true },
  });
  if (!project) notFound();

  const [sprints, backlog] = await Promise.all([
    loadSprints(project.id),
    loadSprintBacklog(project.id),
  ]);

  /*
   * Who may do what, read from the one capability table `domain.ts` owns and
   * `sprints.ts` enforces independently — this only decides what is worth
   * drawing:
   *   - creating, editing and deleting a sprint's own configuration is an
   *     administrator's;
   *   - starting a planned sprint is also open to a Full Stack Developer;
   *   - completing a sprint, the same team-wide decision closing its record
   *     out is, stays an administrator's;
   *   - filling a sprint, emptying it or moving its issues elsewhere is every
   *     working role's — Admin, Developer, Tester and Full Stack Developer
   *     alike.
   */
  const canCreate = canCreateSprint(workRole);
  const canEdit = canEditSprintDetails(workRole);
  const canDelete = canDeleteSprint(workRole);
  const canStart = canStartSprint(workRole);
  const canComplete = canCompleteSprint(workRole);
  const canEditIssues = canEditSprintIssues(workRole);

  const open = sprints.filter((sprint) => sprint.status !== "COMPLETED");
  const completed = sprints.filter((sprint) => sprint.status === "COMPLETED");

  return (
    <>
      <div className="prio-sprints__head">
        <div>
          <h2 className="prio-issue__section-title">Sprints</h2>
          <p className="prio-text-muted">
            A sprint is a fixed period of work on {project.name}. Only this
            project&rsquo;s issues can be in one.
          </p>
        </div>
        <div className="prio-sprints__headactions">
          {/* Every role that can open this section can open Iterations /
              Sprints, so it is offered to all of them; New sprint stays an
              administrator's. */}
          <ButtonLink
            href={`/projects/${project.key.toLowerCase()}/sprints/iterations`}
            variant="secondary"
          >
            <IconTimeline size={14} />
            Iterations / Sprints
          </ButtonLink>
          {canCreate ? <NewSprintButton projectId={project.id} /> : null}
        </div>
      </div>

      {sprints.length === 0 ? (
        <Card>
          <EmptyState
            icon={<IconEmptyBox />}
            title="No sprints yet"
            body={
              canCreate
                ? "Create a sprint, add issues from the backlog, then start it. Its progress follows the issues' own statuses."
                : "Nobody has planned a sprint for this project yet. An administrator can start one."
            }
            actions={canCreate ? <NewSprintButton projectId={project.id} /> : null}
          />
        </Card>
      ) : (
        <div className="prio-sprints">
          {open.map((sprint) => (
            <SprintCard
              key={sprint.id}
              sprint={sprint}
              projectId={project.id}
              projectKey={project.key}
              backlog={backlog}
              /* Where unfinished work can be carried: this project's other
                 sprints that are not themselves completed. */
              otherOpenSprints={open
                .filter((other) => other.id !== sprint.id)
                .map((other) => ({ id: other.id, name: other.name }))}
              canEdit={canEdit}
              canDelete={canDelete}
              canStart={canStart}
              canComplete={canComplete}
              canEditIssues={canEditIssues}
            />
          ))}

          {completed.length > 0 ? (
            <>
              <h3 className="prio-sprints__history">
                Completed sprints
                <span className="prio-sprints__historycount">
                  {completed.length}
                </span>
              </h3>
              {completed.map((sprint) => (
                <SprintCard
                  key={sprint.id}
                  sprint={sprint}
                  projectId={project.id}
                  projectKey={project.key}
                  backlog={backlog}
                  otherOpenSprints={[]}
                  canEdit={canEdit}
                  canDelete={canDelete}
                  canStart={canStart}
                  canComplete={canComplete}
                  canEditIssues={false}
                />
              ))}
            </>
          ) : null}
        </div>
      )}
    </>
  );
}
