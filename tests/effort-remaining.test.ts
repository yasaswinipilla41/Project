import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { createIssue, updateIssue } from "@/server/issues";
import { actAs, projectByKey } from "./helpers";

/**
 * Effort, and how much of it is left.
 *
 * Two numbers that are deliberately not one. Effort is what the work was
 * estimated to need and is written once; Remaining is a judgement somebody
 * revises as they go. Subtracting hours worked from the estimate would give a
 * third number that is neither, and a burndown drawn from it would describe
 * arithmetic rather than the work.
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

async function hoursOf(issueId: string) {
  return prisma.issue.findUniqueOrThrow({
    where: { id: issueId },
    select: { effortHours: true, remainingHours: true },
  });
}

describe("estimating a work item", () => {
  it("starts Remaining Hours at the whole of the estimate", async () => {
    const issueId = await anIssue("Effort seeds remaining");

    const result = await updateIssue({ issueId, effortHours: 8 });
    expect(result.ok, result.ok ? "" : result.error).toBe(true);

    /* Nothing has been done yet, so all of it is left. Any other starting
       value would be an invention. */
    expect(await hoursOf(issueId)).toEqual({
      effortHours: 8,
      remainingHours: 8,
    });
  });

  it("keeps the estimate still while the remainder comes down", async () => {
    const issueId = await anIssue("Remaining moves alone");
    await updateIssue({ issueId, effortHours: 8 });

    await updateIssue({ issueId, remainingHours: 6 });
    expect(await hoursOf(issueId)).toEqual({
      effortHours: 8,
      remainingHours: 6,
    });

    await updateIssue({ issueId, remainingHours: 3 });
    await updateIssue({ issueId, remainingHours: 0 });

    /*
     * The claim the whole feature rests on: eight hours is still what this was
     * estimated at, even now that none of it is left. An implementation that
     * stored one number and derived the other would have lost the estimate
     * somewhere around here, and the burndown would have had nothing to
     * measure against.
     */
    expect(await hoursOf(issueId)).toEqual({
      effortHours: 8,
      remainingHours: 0,
    });
  });

  it("does not overwrite a remainder the caller set in the same breath", async () => {
    const issueId = await anIssue("Both at once");

    await updateIssue({ issueId, effortHours: 10, remainingHours: 4 });

    expect(await hoursOf(issueId)).toEqual({
      effortHours: 10,
      remainingHours: 4,
    });
  });

  it("leaves a remainder alone when the estimate is corrected later", async () => {
    /* Re-estimating is not starting again: somebody who has burned six of
       eight hours and re-reads the job as twelve still has what they had
       left, and says so themselves. */
    const issueId = await anIssue("Re-estimated");
    await updateIssue({ issueId, effortHours: 8 });
    await updateIssue({ issueId, remainingHours: 2 });

    await updateIssue({ issueId, effortHours: 12 });

    expect(await hoursOf(issueId)).toEqual({
      effortHours: 12,
      remainingHours: 2,
    });
  });

  it("records both in the trail, so a burndown has a history to read", async () => {
    const issueId = await anIssue("Trail");
    await updateIssue({ issueId, effortHours: 8 });
    await updateIssue({ issueId, remainingHours: 5 });

    const trail = await prisma.activityLogEntry.findMany({
      where: { issueId, field: { in: ["effortHours", "remainingHours"] } },
      select: { field: true, oldValue: true, newValue: true },
      orderBy: { createdAt: "asc" },
    });

    expect(trail).toEqual([
      { field: "effortHours", oldValue: null, newValue: "8" },
      { field: "remainingHours", oldValue: null, newValue: "8" },
      { field: "remainingHours", oldValue: "8", newValue: "5" },
    ]);
  });

  it("clears back to no estimate rather than to zero", async () => {
    /* An empty field means nobody has estimated this; zero means there is
       nothing left to do. They are different answers and the column keeps
       them apart. */
    const issueId = await anIssue("Cleared");
    await updateIssue({ issueId, effortHours: 4 });

    await updateIssue({ issueId, effortHours: null, remainingHours: null });

    expect(await hoursOf(issueId)).toEqual({
      effortHours: null,
      remainingHours: null,
    });
  });
});

describe("what it refuses", () => {
  it("refuses negative hours", async () => {
    const issueId = await anIssue("Negative");
    const result = await updateIssue({ issueId, effortHours: -3 });

    expect(result.ok).toBe(false);
    expect((await hoursOf(issueId)).effortHours).toBeNull();
  });

  it("refuses an absurd estimate", async () => {
    const issueId = await anIssue("Absurd");
    const result = await updateIssue({ issueId, effortHours: 99_999 });

    expect(result.ok).toBe(false);
    expect((await hoursOf(issueId)).effortHours).toBeNull();
  });

  it("reads hours typed into a form as numbers", async () => {
    /* A form field hands over a string; the estimate is a number. */
    const issueId = await anIssue("From a form");
    const result = await updateIssue({ issueId, effortHours: "7.5" });

    expect(result.ok, result.ok ? "" : result.error).toBe(true);
    expect((await hoursOf(issueId)).effortHours).toBe(7.5);
  });
});
