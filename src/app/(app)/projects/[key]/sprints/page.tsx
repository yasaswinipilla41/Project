import type { Metadata } from "next";
import { notFound } from "next/navigation";
import {
  CompletedSprints,
  CompletedSprintsPanel,
  CompletedSprintsToggle,
} from "@/components/sprints/CompletedSprintsDisclosure";
import { NewSprintButton } from "@/components/sprints/NewSprintButton";
import { SprintCard } from "@/components/sprints/SprintCard";
import {
  ButtonLink,
  Card,
  CardBody,
  EmptyState,
} from "@/components/ui/primitives";
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

  /*
   * The three groups this page is read in, split out of the one ordered list
   * `loadSprints` returns rather than re-queried or re-sorted: active first,
   * then planned by start date, then the completed ones newest first. Taking
   * them out in that order preserves the ordering inside each group.
   *
   * "Upcoming" is every planned sprint, not only the next one. `startSprint`
   * allows one active sprint per project, so `active` holds at most one — read
   * as a list all the same, because a project that somehow held two should show
   * both rather than silently hide one.
   */
  const active = sprints.filter((sprint) => sprint.status === "ACTIVE");
  const upcoming = sprints.filter((sprint) => sprint.status === "PLANNED");
  const completed = sprints.filter((sprint) => sprint.status === "COMPLETED");

  /* Where unfinished work can be carried when a sprint is completed: this
     project's other sprints that are not themselves completed. The same set
     as before, built once because every live card needs it. */
  const openSprints = [...active, ...upcoming];

  return (
    /* The Completed sprints control and the list it opens are in two places —
       the header and the top of the list — so they share their state here. */
    <CompletedSprints>
      <div className="prio-sprints__head">
        <div>
          <h2 className="prio-issue__section-title">Sprints</h2>
          <p className="prio-text-muted">
            A sprint is a fixed period of work on {project.name}. Only this
            project&rsquo;s issues can be in one.
          </p>
        </div>
        <div className="prio-sprints__headactions">
          {/* The record, behind a control at the top right, beside
              Iterations / Sprints — only when there is something to open. */}
          {completed.length > 0 ? (
            <CompletedSprintsToggle count={completed.length} />
          ) : null}
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
          {/*
            * The completed sprints, when their control is opened: above the
            * live sprints, as a group of their own. The cards themselves are
            * unchanged — same component, same order, and still
            * `canEditIssues={false}`, because a completed sprint is a closed
            * record and `moveIssueToSprint` refuses to move work out of one.
            */}
          {completed.length > 0 ? (
            <CompletedSprintsPanel>
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
            </CompletedSprintsPanel>
          ) : null}

          {/*
            * What is being worked now.
            *
            * Its own group, with its own empty state when there is none: a
            * project between sprints is an ordinary state, and the page should
            * say so rather than leave the reader to infer it from the first
            * card happening to be a planned one. This branch is only reached
            * when the project has sprints, so "no active sprint" here can never
            * stand in for "nothing loaded".
            */}
          <h3 className="prio-sprints__section">Active sprint</h3>
          {active.length > 0 ? (
            active.map((sprint) => (
              <SprintCard
                key={sprint.id}
                sprint={sprint}
                projectId={project.id}
                projectKey={project.key}
                backlog={backlog}
                otherOpenSprints={openSprints
                  .filter((other) => other.id !== sprint.id)
                  .map((other) => ({ id: other.id, name: other.name }))}
                canEdit={canEdit}
                canDelete={canDelete}
                canStart={canStart}
                canComplete={canComplete}
                canEditIssues={canEditIssues}
              />
            ))
          ) : (
            <Card>
              <CardBody>
                <EmptyState
                  icon={<IconEmptyBox />}
                  title="No active sprint"
                  body={
                    upcoming.length > 0
                      ? "No sprint is running on this project yet. Start one of the upcoming sprints below when the team is ready."
                      : "No sprint is running on this project."
                  }
                />
              </CardBody>
            </Card>
          )}

          {/* What is planned next, in start-date order. */}
          <h3 className="prio-sprints__section">
            Upcoming sprints
            {upcoming.length > 0 ? (
              <span className="prio-sprints__historycount">
                {upcoming.length}
              </span>
            ) : null}
          </h3>
          {/* The group's cards, marked as the upcoming ones so they can be
              drawn without a border — see `.prio-sprints__upcoming`. It adds
              no box of its own, so the list's spacing is unchanged. */}
          <div className="prio-sprints__upcoming">
          {upcoming.length > 0 ? (
            upcoming.map((sprint) => (
              <SprintCard
                key={sprint.id}
                sprint={sprint}
                projectId={project.id}
                projectKey={project.key}
                backlog={backlog}
                otherOpenSprints={openSprints
                  .filter((other) => other.id !== sprint.id)
                  .map((other) => ({ id: other.id, name: other.name }))}
                canEdit={canEdit}
                canDelete={canDelete}
                canStart={canStart}
                canComplete={canComplete}
                canEditIssues={canEditIssues}
              />
            ))
          ) : (
            <Card>
              <CardBody>
                <EmptyState
                  icon={<IconEmptyBox />}
                  title="No upcoming sprints"
                  body={
                    canCreate
                      ? "Nothing is planned after this one yet. Create a sprint to line up the next block of work."
                      : "Nothing is planned after this one yet."
                  }
                  actions={
                    canCreate ? <NewSprintButton projectId={project.id} /> : null
                  }
                />
              </CardBody>
            </Card>
          )}
          </div>
        </div>
      )}
    </CompletedSprints>
  );
}
