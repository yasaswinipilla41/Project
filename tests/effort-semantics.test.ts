import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { remainingEffort } from "@/lib/domain";
import { createIssue, updateIssue } from "@/server/issues";
import { actAs, projectByKey } from "./helpers";

/**
 * What "Remaining" answers, and the several things it is not.
 *
 * `effort-remaining.test.ts` covers the columns — that the estimate is written
 * once, that the remainder is seeded from it and then moves on its own, that
 * zero and empty are different answers. This file covers the *reading* of those
 * columns, which is where they were being misread:
 *
 *  - **Time passing is not work.** An item's `updatedAt` moves whenever its row
 *    changes — a comment, a status, a sprint, a label. Nothing in Prio reduces
 *    a remainder because a timestamp is old, and "Updated 5d ago, Effort 2h,
 *    Remaining 2h" is a correct reading of an estimate nobody has revised, not
 *    a stale one.
 *
 *  - **Finished work has nothing left.** Closing an item does not write to its
 *    remainder, so the column goes stale the moment work is done. The burndown
 *    has always known this and answered nothing for closed work; the issue
 *    panel read the column verbatim, so one finished item could report 0h on
 *    its sprint's chart and 2h on its own page. `remainingEffort` is the one
 *    rule both now read.
 *
 * Nothing here writes to the remainder on the caller's behalf. That is
 * deliberate and asserted: the burndown needs the reading somebody actually
 * recorded, and an item that is reopened must not keep a nought it never had.
 */

const ADMIN = "admin@symbiosystech.com";
const made: string[] = [];

afterAll(async () => {
  if (made.length > 0) {
    await prisma.notification.deleteMany({ where: { issueId: { in: made } } });
    await prisma.issue.deleteMany({ where: { id: { in: made } } });
  }
  await prisma.$disconnect();
});

async function anIssue(title: string) {
  await actAs(ADMIN);
  const project = await projectByKey("ENG");
  const result = await createIssue({
    projectId: project.id,
    type: "TASK",
    title: `${title} ${Date.now()}`,
    priority: "MEDIUM",
    labelIds: [],
  });
  if (!result.ok) throw new Error(result.error);
  made.push(result.data.id);
  return result.data.id;
}

/** The three columns the panel reads, as they stand. */
async function readWork(issueId: string) {
  return prisma.issue.findUniqueOrThrow({
    where: { id: issueId },
    select: {
      status: true,
      effortHours: true,
      remainingHours: true,
      updatedAt: true,
      title: true,
      priority: true,
      assigneeId: true,
      sprintId: true,
      dueDate: true,
    },
  });
}

/* ------------------------------------------------------------- the rule */

describe("the rule itself", () => {
  it("answers the estimate while nobody has revised it", () => {
    /* The case that looked wrong and is not: two hours estimated, nothing
       recorded against it, so two hours left — however long ago the row was
       last touched. */
    expect(
      remainingEffort({
        status: "IN_PROGRESS",
        effortHours: 2,
        remainingHours: 2,
      }),
    ).toBe(2);

    /* And the same for a row written before the seeding existed, which has an
       estimate and no remainder at all. */
    expect(
      remainingEffort({
        status: "IN_PROGRESS",
        effortHours: 2,
        remainingHours: null,
      }),
    ).toBe(2);
  });

  it("answers the remainder somebody recorded, once they have", () => {
    expect(
      remainingEffort({ status: "IN_PROGRESS", effortHours: 2, remainingHours: 1 }),
    ).toBe(1);
    expect(
      remainingEffort({ status: "IN_PROGRESS", effortHours: 2, remainingHours: 0 }),
    ).toBe(0);
  });

  it("answers nothing for work that is closed, whatever the column says", () => {
    for (const status of ["DONE", "REJECTED", "CANCELLED"] as const) {
      expect(
        remainingEffort({ status, effortHours: 2, remainingHours: 2 }),
        `${status} has nothing left`,
      ).toBe(0);
    }
  });

  it("does not turn work nobody estimated into nought by closing it", () => {
    /*
     * The line this rule must not cross. Closing an item says it is finished;
     * it does not say it was nought hours, and an em dash is the only honest
     * answer for a figure nobody ever gave. Prio keeps empty and zero apart
     * everywhere else — see `effort-remaining.test.ts`, "clears back to no
     * estimate rather than to zero" — and a reading that collapsed them here
     * would report every unestimated closed item as a measured nought.
     */
    for (const status of ["DONE", "REJECTED", "CANCELLED"] as const) {
      expect(
        remainingEffort({ status, effortHours: null, remainingHours: null }),
        `${status} and unestimated is still unestimated`,
      ).toBeNull();
    }

    /* An estimate alone is enough to have something to say. */
    expect(
      remainingEffort({ status: "DONE", effortHours: 2, remainingHours: null }),
    ).toBe(0);
  });

  it("does not call reopened work finished", () => {
    /* Reopening is the point at which the remainder matters again, so the
       rule has to stop applying the moment it does. */
    expect(
      remainingEffort({ status: "REOPENED", effortHours: 2, remainingHours: 2 }),
    ).toBe(2);
    expect(
      remainingEffort({ status: "IN_QA", effortHours: 2, remainingHours: 2 }),
    ).toBe(2);
  });

  it("keeps unestimated apart from nothing left", () => {
    /* Empty means nobody has said; zero means there is nothing to do. A rule
       that collapsed the two would report every unestimated item as finished. */
    expect(
      remainingEffort({
        status: "IN_PROGRESS",
        effortHours: null,
        remainingHours: null,
      }),
    ).toBeNull();

    /* A recorded nought is a figure somebody gave, and it survives. */
    expect(
      remainingEffort({
        status: "IN_PROGRESS",
        effortHours: null,
        remainingHours: 0,
      }),
    ).toBe(0);
  });
});

/* ------------------------------------------------------- against the row */

describe("an estimate nobody has revised", () => {
  it("still has all of it left, however long ago the row was touched", async () => {
    const issueId = await anIssue("Two hours, untouched");
    await updateIssue({ issueId, effortHours: 2 });

    const estimated = await readWork(issueId);
    expect(estimated.effortHours).toBe(2);
    expect(estimated.remainingHours).toBe(2);
    expect(remainingEffort(estimated)).toBe(2);

    /*
     * Now move the clock the way the application does: change something else
     * about the item. `updatedAt` advances, which is exactly the reading that
     * gets mistaken for effort consumed.
     */
    await updateIssue({ issueId, priority: "HIGH" });
    const touched = await readWork(issueId);

    expect(touched.updatedAt.getTime()).toBeGreaterThan(
      estimated.updatedAt.getTime(),
    );

    // And the two numbers have not moved an inch.
    expect(touched.effortHours).toBe(2);
    expect(touched.remainingHours).toBe(2);
    expect(remainingEffort(touched)).toBe(2);
  });

  it("is not reduced by an old timestamp, however old", async () => {
    /*
     * The claim stated directly: a row backdated a fortnight reads exactly as
     * it did today. Written straight to the column because there is no way to
     * ask the application to age a row — which is the point, since there is
     * also no code that would care if there were.
     */
    const issueId = await anIssue("Backdated");
    await updateIssue({ issueId, effortHours: 2 });

    const long = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
    await prisma.issue.update({
      where: { id: issueId },
      data: { updatedAt: long },
    });

    const aged = await readWork(issueId);
    expect(aged.updatedAt.getTime()).toBeLessThan(Date.now() - 86_400_000);
    expect(aged.remainingHours).toBe(2);
    expect(remainingEffort(aged)).toBe(2);
  });
});

describe("recording progress", () => {
  it("moves the remainder and leaves the estimate where it was", async () => {
    const issueId = await anIssue("One hour in");
    await updateIssue({ issueId, effortHours: 2 });

    await updateIssue({ issueId, remainingHours: 1 });
    expect(remainingEffort(await readWork(issueId))).toBe(1);

    await updateIssue({ issueId, remainingHours: 0 });
    const finished = await readWork(issueId);
    expect(finished.effortHours).toBe(2);
    expect(finished.remainingHours).toBe(0);
    expect(remainingEffort(finished)).toBe(0);
  });

  it("changes nothing else about the work", async () => {
    const issueId = await anIssue("Only the hours");
    await updateIssue({ issueId, effortHours: 2 });
    const before = await readWork(issueId);

    await updateIssue({ issueId, remainingHours: 1 });
    const after = await readWork(issueId);

    expect(after.remainingHours).toBe(1);
    expect({
      status: after.status,
      title: after.title,
      priority: after.priority,
      assigneeId: after.assigneeId,
      sprintId: after.sprintId,
      dueDate: after.dueDate,
      effortHours: after.effortHours,
    }).toEqual({
      status: before.status,
      title: before.title,
      priority: before.priority,
      assigneeId: before.assigneeId,
      sprintId: before.sprintId,
      dueDate: before.dueDate,
      effortHours: before.effortHours,
    });
  });
});

describe("work that is finished", () => {
  it("has nothing left, and keeps its estimate and its last reading", async () => {
    const issueId = await anIssue("Closed with hours on it");
    await updateIssue({ issueId, effortHours: 2 });

    /* Closed on the row rather than through the workflow: what is under test
       is how a closed item reads, not which transitions are allowed, and the
       status rules have their own suites. */
    await prisma.issue.update({
      where: { id: issueId },
      data: { status: "DONE", completedAt: new Date() },
    });

    const done = await readWork(issueId);

    // What the panel and the burndown both now answer.
    expect(remainingEffort(done)).toBe(0);

    /* And what is stored is untouched. This is the half that matters: writing
       a nought here would tell the burndown that a reopened item had been
       taken to zero, which nobody ever said. */
    expect(done.effortHours).toBe(2);
    expect(done.remainingHours).toBe(2);
  });

  it("gets its remainder back the moment it is reopened", async () => {
    const issueId = await anIssue("Reopened");
    await updateIssue({ issueId, effortHours: 8 });
    await updateIssue({ issueId, remainingHours: 3 });

    await prisma.issue.update({
      where: { id: issueId },
      data: { status: "DONE", completedAt: new Date() },
    });
    expect(remainingEffort(await readWork(issueId))).toBe(0);

    await prisma.issue.update({
      where: { id: issueId },
      data: { status: "REOPENED", completedAt: null },
    });

    /* Three hours, which is what somebody actually said — not the nought the
       closed reading gave, and not the whole estimate either. */
    expect(remainingEffort(await readWork(issueId))).toBe(3);
  });

  it("still says nothing about an unestimated item it never measured", async () => {
    /* The case the screen actually showed: a finished item with no estimate,
       reading "Remaining 0" beside "Effort —". Nobody measured it, so there is
       no nought to report. */
    const issueId = await anIssue("Finished, never estimated");
    await prisma.issue.update({
      where: { id: issueId },
      data: { status: "DONE", completedAt: new Date() },
    });

    const row = await readWork(issueId);
    expect(row.effortHours).toBeNull();
    expect(row.remainingHours).toBeNull();
    expect(remainingEffort(row)).toBeNull();
  });

  it("answers nothing for cancelled and rejected work too", async () => {
    for (const status of ["CANCELLED", "REJECTED"] as const) {
      const issueId = await anIssue(`Closed as ${status}`);
      await updateIssue({ issueId, effortHours: 5 });
      await prisma.issue.update({ where: { id: issueId }, data: { status } });

      const row = await readWork(issueId);
      expect(remainingEffort(row), `${status} has nothing left`).toBe(0);
      expect(row.effortHours, `${status} keeps its estimate`).toBe(5);
    }
  });
});
