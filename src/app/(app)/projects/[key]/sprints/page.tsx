import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { NewSprintButton } from "@/components/sprints/NewSprintButton";
import { SprintCard } from "@/components/sprints/SprintCard";
import { Card, EmptyState } from "@/components/ui/primitives";
import { IconEmptyBox } from "@/components/ui/Icon";
import { projectScope, workRoleOf } from "@/lib/authz";
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

  /*
   * Sprints are not a QA member's surface.
   *
   * Checked here, before the project is even queried, so a direct URL gets the
   * not-found page rather than a sprint board with every control missing — an
   * empty management screen is a worse answer than no screen. The tab strip
   * hides the link for the same people; this is what makes the hiding binding,
   * since a hidden link is not a check.
   *
   * Administrators are unaffected, and so are developers, who read sprints to
   * see what they are working in. Every write in `sprints.ts` still asserts an
   * administrator independently.
   */
  if ((await workRoleOf(user)) === "QA") notFound();

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
   * Who may do what, using the two rules Prio already has:
   *   - the sprint's lifecycle is `canManageProject` — an administrator, or
   *     the person who created this project;
   *   - putting work into a sprint is for anybody who can open the project,
   *     which is everyone who reaches this page at all.
   * Both are re-checked inside the server actions; this only decides what is
   * worth showing.
   */
  /*
   * A sprint is an administrator's instrument.
   *
   * This used to be `canManageProject` — an administrator *or* whoever created
   * the project. Starting and closing a sprint commits everybody working in
   * it, and developers and testers read sprints rather than shape them, so the
   * lifecycle narrowed to administrators alone. `sprints.ts` asserts the same
   * rule on every write; this only decides what to draw.
   */
  const canManage = user.role === "ADMIN";

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
        {canManage ? <NewSprintButton projectId={project.id} /> : null}
      </div>

      {sprints.length === 0 ? (
        <Card>
          <EmptyState
            icon={<IconEmptyBox />}
            title="No sprints yet"
            body={
              canManage
                ? "Create a sprint, add issues from the backlog, then start it. Its progress follows the issues' own statuses."
                : "Nobody has planned a sprint for this project yet. An administrator or the project's creator can start one."
            }
            actions={canManage ? <NewSprintButton projectId={project.id} /> : null}
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
              canManage={canManage}
              canEditIssues
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
                  canManage={canManage}
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
