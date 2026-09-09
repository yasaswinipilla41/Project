"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import {
  assertAdmin,
  AuthorizationError,
  NotFoundError,
} from "@/lib/authz";
import { isClosedStatus } from "@/lib/domain";
import { requireUser } from "@/lib/session";
import {
  completeSprintSchema,
  createSprintSchema,
  fieldErrors,
  sprintIdSchema,
  sprintIssueSchema,
  sprintIssuesSchema,
  updateSprintSchema,
  type FieldErrors,
} from "@/server/schemas";

/**
 * Sprints — create, fill, plan, start, complete.
 *
 * Three rules hold this module together, and every action below is written
 * against them:
 *
 *  - **A sprint belongs to exactly one project, and so does its work.** Every
 *    issue is checked against the sprint's own `projectId` before it is
 *    attached, on the server, reading the issue's project from the database
 *    rather than trusting anything the caller said. There is no path here that
 *    can put `WEB-201` into an `ENG` sprint, and no query that offers one.
 *
 *  - **The sprint holds no opinion about issue status.** Whether work is
 *    finished is `Issue.status`, the same field the board and the list read.
 *    A sprint's progress is therefore always current, because it is computed
 *    from the issues rather than stored beside them. Nothing here writes an
 *    issue's status.
 *
 *  - **Authorization reuses what Prio already has.** No sprint role and no
 *    sprint permission table: a sprint is an administrator's instrument, so
 *    every write here is `assertAdmin`.
 *
 *    That covers the lifecycle — creating, editing, starting, completing — and
 *    also what a sprint *contains*, because putting an issue into the sprint
 *    or taking it out is committing somebody's fortnight rather than editing
 *    an issue. Both used to be looser: the lifecycle was "an administrator or
 *    whoever created the project", and membership of the sprint was any member
 *    of the project. Developers and testers read sprints now; they do not
 *    shape them.
 *
 *    Reading is untouched. Nothing below gates a query, so everybody who can
 *    open the project still sees the sprint, its goal, its dates and its work.
 */

export type SprintActionResult<T = undefined> =
  | { ok: true; data: T }
  | { ok: false; error: string; fieldErrors?: FieldErrors };

function failure(error: unknown): SprintActionResult<never> {
  if (error instanceof AuthorizationError || error instanceof NotFoundError) {
    return { ok: false, error: error.message };
  }
  console.error("[prio] sprint action failed:", error);
  return { ok: false, error: "Something went wrong. Please try again." };
}

/** Every surface a sprint change can show on. */
function revalidateSprintSurfaces(projectKey: string) {
  const base = `/projects/${projectKey.toLowerCase()}`;
  revalidatePath(`${base}/sprints`);
  revalidatePath(`${base}/board`);
  revalidatePath(`${base}/list`);
  revalidatePath(base);
  revalidatePath(`${base}/summary`);
  revalidatePath(`${base}/timeline`);
}

/**
 * Loads a sprint and the project it belongs to.
 *
 * Both the sprint and its project come from the database in one read, so the
 * project a caller is authorized against is always the sprint's real one —
 * never a project id that arrived alongside the sprint id in the payload.
 */
async function loadSprint(sprintId: string) {
  const sprint = await prisma.sprint.findUnique({
    where: { id: sprintId },
    select: {
      id: true,
      projectId: true,
      name: true,
      status: true,
      startDate: true,
      endDate: true,
      project: { select: { key: true } },
    },
  });
  if (!sprint) throw new NotFoundError("This sprint no longer exists.");
  return sprint;
}

/* ------------------------------------------------------------ create/edit */

export async function createSprint(
  raw: unknown,
): Promise<SprintActionResult<{ id: string; name: string; projectKey: string }>> {
  try {
    const user = await requireUser();

    const parsed = createSprintSchema.safeParse(raw);
    if (!parsed.success) {
      return {
        ok: false,
        error: "Please correct the highlighted fields.",
        fieldErrors: fieldErrors(parsed.error),
      };
    }
    const { projectId, ...input } = parsed.data;

    assertAdmin(user);
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true, key: true },
    });
    if (!project) throw new NotFoundError("This project no longer exists.");

    const sprint = await prisma.sprint.create({
      data: { ...input, projectId, createdById: user.id },
      select: { id: true, name: true },
    });

    revalidateSprintSurfaces(project.key);
    return { ok: true, data: { ...sprint, projectKey: project.key } };
  } catch (error) {
    return failure(error);
  }
}

export async function updateSprint(raw: unknown): Promise<SprintActionResult> {
  try {
    const user = await requireUser();

    const parsed = updateSprintSchema.safeParse(raw);
    if (!parsed.success) {
      return {
        ok: false,
        error: "Please correct the highlighted fields.",
        fieldErrors: fieldErrors(parsed.error),
      };
    }
    const { sprintId, ...input } = parsed.data;

    const sprint = await loadSprint(sprintId);
    assertAdmin(user);

    /* A completed sprint is a record of what happened. Renaming one or moving
       its dates afterwards would rewrite that record, so it is refused rather
       than quietly allowed. */
    if (sprint.status === "COMPLETED") {
      return {
        ok: false,
        error: "This sprint has been completed and can no longer be changed.",
      };
    }

    await prisma.sprint.update({ where: { id: sprintId }, data: input });

    revalidateSprintSurfaces(sprint.project.key);
    return { ok: true, data: undefined };
  } catch (error) {
    return failure(error);
  }
}

/**
 * Delete a sprint.
 *
 * An administrator's, like every other change to a sprint's lifecycle, and
 * checked here rather than by hiding the button — the same `assertAdmin` the
 * rest of this file uses, so there is no second notion of who may.
 *
 * What it removes is the sprint and nothing else. The schema already says so:
 * `Issue.sprintId` is `onDelete: SetNull`, so the issues that were in it are
 * simply no longer in a sprint — they keep their status, their assignee, their
 * history and their place on the board — and `SprintIssueOutcome` cascades,
 * because those rows are the sprint's own record of how it went and mean
 * nothing without it. Nothing else in Prio points at a sprint.
 *
 * A sprint that has already gone is not an error worth alarming anybody about:
 * `loadSprint` throws `NotFoundError`, which `failure` turns into the ordinary
 * "no longer exists" message. Deleting twice therefore ends with the sprint
 * deleted, which is what was asked for both times.
 */
export async function deleteSprint(raw: unknown): Promise<SprintActionResult> {
  try {
    const user = await requireUser();

    const parsed = sprintIdSchema.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, error: "That sprint could not be identified." };
    }

    const sprint = await loadSprint(parsed.data.sprintId);
    assertAdmin(user);

    await prisma.sprint.delete({ where: { id: sprint.id } });

    revalidateSprintSurfaces(sprint.project.key);
    return { ok: true, data: undefined };
  } catch (error) {
    return failure(error);
  }
}

/* -------------------------------------------------------------- the issues */

/**
 * Add issues from the project's backlog to a sprint.
 *
 * The project-scoping check is the whole point of this action. `issueIds`
 * arrives from the browser, so every id is looked up and checked against the
 * sprint's own `projectId` before anything is written — and if any one of them
 * fails, the whole call is refused rather than partially applied.
 *
 * Refusing outright rather than quietly skipping the offending ids matters for
 * two reasons: somebody who picked three issues and was told "added two" has
 * no way to find out which one was dropped or why, and a caller probing with a
 * hand-made payload gets a straight answer instead of a silent no-op that
 * looks like success.
 */
export async function addIssuesToSprint(
  raw: unknown,
): Promise<SprintActionResult<{ added: number }>> {
  try {
    const user = await requireUser();

    const parsed = sprintIssuesSchema.safeParse(raw);
    if (!parsed.success) {
      return {
        ok: false,
        error: "Choose at least one issue.",
        fieldErrors: fieldErrors(parsed.error),
      };
    }
    const { sprintId, issueIds } = parsed.data;

    const sprint = await loadSprint(sprintId);
    assertAdmin(user);

    if (sprint.status === "COMPLETED") {
      return {
        ok: false,
        error: "This sprint has been completed. Add the work to another one.",
      };
    }

    /*
     * Read the issues' own `projectId` from the database — never from the
     * payload, which the caller controls. An id that names nothing, or names
     * another project's work, is the same failure here.
     */
    const requested = [...new Set(issueIds)];
    const eligible = await prisma.issue.findMany({
      where: { id: { in: requested }, projectId: sprint.projectId },
      select: { id: true },
    });

    if (eligible.length !== requested.length) {
      return {
        ok: false,
        error: `Only issues in this project can be added to ${sprint.name}.`,
      };
    }

    const { count } = await prisma.issue.updateMany({
      // Scoped again on the write, so nothing can have changed underneath.
      where: { id: { in: requested }, projectId: sprint.projectId },
      data: { sprintId },
    });

    revalidateSprintSurfaces(sprint.project.key);
    return { ok: true, data: { added: count } };
  } catch (error) {
    return failure(error);
  }
}

/** Take one issue back out of a sprint, returning it to the backlog. */
export async function removeIssueFromSprint(
  raw: unknown,
): Promise<SprintActionResult> {
  try {
    const user = await requireUser();

    const parsed = sprintIssueSchema.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, error: "That issue could not be read." };
    }
    const { sprintId, issueId } = parsed.data;

    const sprint = await loadSprint(sprintId);
    assertAdmin(user);

    if (sprint.status === "COMPLETED") {
      return {
        ok: false,
        error: "This sprint has been completed and can no longer be changed.",
      };
    }

    /* Scoped by sprint as well as by issue, so this can only ever detach work
       that is actually in this sprint. */
    await prisma.issue.updateMany({
      where: { id: issueId, sprintId },
      data: { sprintId: null },
    });

    revalidateSprintSurfaces(sprint.project.key);
    return { ok: true, data: undefined };
  } catch (error) {
    return failure(error);
  }
}

/* ------------------------------------------------------------------ start */

export async function startSprint(raw: unknown): Promise<SprintActionResult> {
  try {
    const user = await requireUser();

    const parsed = sprintIdSchema.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, error: "That sprint could not be read." };
    }

    const sprint = await loadSprint(parsed.data.sprintId);
    assertAdmin(user);

    if (sprint.status !== "PLANNED") {
      return {
        ok: false,
        error:
          sprint.status === "ACTIVE"
            ? "This sprint is already running."
            : "This sprint has already been completed.",
      };
    }

    /* The date rule is re-checked here and not only at creation: a sprint can
       be edited between being created and being started. */
    if (sprint.startDate.getTime() > sprint.endDate.getTime()) {
      return {
        ok: false,
        error: "Fix the sprint's dates before starting it.",
      };
    }

    // A sprint is a commitment to a set of work, so there has to be some.
    const issues = await prisma.issue.count({ where: { sprintId: sprint.id } });
    if (issues === 0) {
      return {
        ok: false,
        error: "Add at least one issue before starting this sprint.",
      };
    }

    /*
     * One sprint runs at a time in a project. Without that, "the next sprint"
     * has no meaning — which is exactly what completing a sprint has to be
     * able to name when it moves unfinished work forward.
     */
    const running = await prisma.sprint.findFirst({
      where: { projectId: sprint.projectId, status: "ACTIVE" },
      select: { name: true },
    });
    if (running) {
      return {
        ok: false,
        error: `${running.name} is already running. Complete it before starting another.`,
      };
    }

    await prisma.sprint.update({
      where: { id: sprint.id },
      data: { status: "ACTIVE", startedAt: new Date() },
    });

    revalidateSprintSurfaces(sprint.project.key);
    return { ok: true, data: undefined };
  } catch (error) {
    return failure(error);
  }
}

/* --------------------------------------------------------------- complete */

/**
 * Close a sprint out, and say where its unfinished work goes.
 *
 * "Finished with" is `isClosedStatus` — Done, Cancelled and Rejected. Work
 * that was cancelled or turned out not to be an issue is not carried into the
 * next sprint, because there is nothing left to carry; only genuinely open
 * work moves. That is the same `CLOSED_STATUSES` the rest of Prio reads, so a
 * sprint cannot disagree with the board about what is still outstanding.
 *
 * Everything the sprint held is written to `SprintIssueOutcome` first, inside
 * the same transaction that moves the work. That is what makes a completed
 * sprint a permanent record: the outcome rows still name every issue and how
 * it ended after the unfinished ones have moved on.
 */
export async function completeSprint(
  raw: unknown,
): Promise<SprintActionResult<{ completed: number; moved: number }>> {
  try {
    const user = await requireUser();

    const parsed = completeSprintSchema.safeParse(raw);
    if (!parsed.success) {
      return {
        ok: false,
        error: "Choose where the unfinished work should go.",
        fieldErrors: fieldErrors(parsed.error),
      };
    }
    const { sprintId, moveIncompleteTo, nextSprintId } = parsed.data;

    const sprint = await loadSprint(sprintId);
    assertAdmin(user);

    if (sprint.status !== "ACTIVE") {
      return {
        ok: false,
        error:
          sprint.status === "PLANNED"
            ? "This sprint has not been started yet."
            : "This sprint has already been completed.",
      };
    }

    /*
     * The destination sprint, if one was named. Checked against this sprint's
     * project, so unfinished work can never be moved into another project's
     * sprint — the one thing §11 rules out outright.
     */
    let destination: string | null = null;
    if (moveIncompleteTo === "NEXT_SPRINT") {
      const next = await prisma.sprint.findFirst({
        where: {
          id: nextSprintId ?? "",
          projectId: sprint.projectId,
          status: { in: ["PLANNED", "ACTIVE"] },
        },
        select: { id: true },
      });
      if (!next) {
        return {
          ok: false,
          error: "Choose a sprint in this project that has not been completed.",
          fieldErrors: { nextSprintId: "Pick an open sprint in this project." },
        };
      }
      destination = next.id;
    }

    const issues = await prisma.issue.findMany({
      where: { sprintId: sprint.id },
      select: { id: true, status: true },
    });

    const finished = issues.filter((issue) => isClosedStatus(issue.status));
    const unfinished = issues.filter((issue) => !isClosedStatus(issue.status));

    await prisma.$transaction(async (tx) => {
      // The permanent record, written before anything moves.
      if (issues.length > 0) {
        await tx.sprintIssueOutcome.createMany({
          data: issues.map((issue) => ({
            sprintId: sprint.id,
            issueId: issue.id,
            completed: isClosedStatus(issue.status),
          })),
          skipDuplicates: true,
        });
      }

      /* Unfinished work moves; finished work stays where it was done. The
         `where` still names this sprint, so a concurrent change cannot make
         this touch an issue that has already left it. */
      if (unfinished.length > 0) {
        await tx.issue.updateMany({
          where: { id: { in: unfinished.map((i) => i.id) }, sprintId: sprint.id },
          data: { sprintId: destination },
        });
      }

      await tx.sprint.update({
        where: { id: sprint.id },
        data: { status: "COMPLETED", completedAt: new Date() },
      });
    });

    revalidateSprintSurfaces(sprint.project.key);
    return {
      ok: true,
      data: { completed: finished.length, moved: unfinished.length },
    };
  } catch (error) {
    return failure(error);
  }
}
