import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { ISSUE_STATUSES, canSetDueDateInStatus } from "@/lib/domain";
import { createIssue, updateIssue } from "@/server/issues";
import { actAs, projectByKey } from "./helpers";

/**
 * A due date belongs to work that is still to be done.
 *
 * Done, Reject / Not an Issue and Cancelled are the three statuses that close
 * an issue, and none of them has a finishing left to plan — so none of them
 * takes a due date, not even from an administrator, who is otherwise the only
 * person who may set one at all. The page disables the control; this is why
 * that is only a courtesy, because every case here calls `updateIssue`
 * directly, which is the same call a hand-made request makes.
 *
 * Three things it deliberately does *not* do: it never touches a date already
 * stored — closing an issue keeps whatever date it had — it never remembers a
 * refusal, so work reopened out of a closed status can be dated again with
 * nothing to reset, and it does not stand in the way of either crossing. Work
 * being closed may be given the date it was wanted by in the same request,
 * and work being reopened may be dated in the same request too. What is
 * refused is a date changed on an issue that was closed before the request
 * and is still closed after it — the issue *remaining* in one of the three.
 */

const ADMIN = "admin@symbiosystech.com";
const CLOSED = ["DONE", "REJECTED", "CANCELLED"] as const;

const created: string[] = [];

afterAll(async () => {
  if (created.length > 0) {
    await prisma.notification.deleteMany({
      where: { issueId: { in: created } },
    });
    await prisma.activityLogEntry.deleteMany({
      where: { issueId: { in: created } },
    });
    await prisma.issue.deleteMany({ where: { id: { in: created } } });
  }
  await prisma.$disconnect();
});

/** An open ENG issue, already dated, as an administrator. */
async function aDatedIssue(title: string): Promise<string> {
  await actAs(ADMIN);
  const project = await projectByKey("ENG");
  const result = await createIssue({
    projectId: project.id,
    type: "TASK",
    title: `${title} ${Date.now()}`,
    description: "fixture",
    status: "TODO",
    priority: "MEDIUM",
    dueDate: "2099-06-01",
  });
  if (!result.ok) throw new Error(result.error);
  created.push(result.data.id);
  return result.data.id;
}

function stateOf(issueId: string) {
  return prisma.issue.findUniqueOrThrow({
    where: { id: issueId },
    select: { status: true, dueDate: true },
  });
}

const dateOf = (value: Date | null) =>
  value?.toISOString().slice(0, 10) ?? null;

describe("the rule itself", () => {
  it("dates open work and refuses the three closed statuses", () => {
    for (const status of ISSUE_STATUSES) {
      expect(canSetDueDateInStatus(status), status).toBe(
        !(CLOSED as readonly string[]).includes(status),
      );
    }
  });
});

describe("an administrator, on closed work", () => {
  for (const status of CLOSED) {
    it(`cannot set, move or clear a due date while it is ${status}`, async () => {
      const issueId = await aDatedIssue(`Due date on ${status}`);

      await actAs(ADMIN);
      expect((await updateIssue({ issueId, status })).ok).toBe(true);

      /* Closing it kept the date it already had — the status governs editing
         and never the stored value. */
      const closed = await stateOf(issueId);
      expect(closed.status).toBe(status);
      expect(dateOf(closed.dueDate)).toBe("2099-06-01");

      for (const dueDate of ["2099-07-01", ""]) {
        const result = await updateIssue({ issueId, dueDate });
        expect(result.ok, `${status} + dueDate=${dueDate || "(cleared)"}`).toBe(
          false,
        );
        if (!result.ok) expect(result.error).toMatch(/due date/i);
      }

      /* And the stored date is exactly where it was. */
      expect(dateOf((await stateOf(issueId)).dueDate)).toBe("2099-06-01");
    });
  }

  it("takes a final date in the same request that closes the work", async () => {
    /* One request that both closes the issue and records when it was wanted
       by: the issue was open when it was sent, so the date is a date on open
       work. Every form that posts its fields together does this. */
    const issueId = await aDatedIssue("Closed and dated at once");

    await actAs(ADMIN);
    const result = await updateIssue({
      issueId,
      status: "DONE",
      dueDate: "2099-07-15",
    });
    expect(result.ok).toBe(true);

    const after = await stateOf(issueId);
    expect(after.status).toBe("DONE");
    expect(dateOf(after.dueDate)).toBe("2099-07-15");

    /* And now that it is closed on both sides of a request, it is shut. */
    expect((await updateIssue({ issueId, dueDate: "2099-08-20" })).ok).toBe(
      false,
    );
    expect(dateOf((await stateOf(issueId)).dueDate)).toBe("2099-07-15");
  });

  it("stays shut when one closed status follows another", async () => {
    /* Done to Cancelled is still closed work throughout, so the date cannot
       ride along with the move. */
    const issueId = await aDatedIssue("Closed to closed");

    await actAs(ADMIN);
    await updateIssue({ issueId, status: "DONE" });

    const result = await updateIssue({
      issueId,
      status: "CANCELLED",
      dueDate: "2099-10-01",
    });
    expect(result.ok).toBe(false);
    expect(dateOf((await stateOf(issueId)).dueDate)).toBe("2099-06-01");
  });

  it("may re-save the date it already has, because nothing moves", async () => {
    /* A form that posts every field back must not be refused for carrying the
       values it was given. Only a real change is a change — the same rule the
       role checks beside it follow. */
    const issueId = await aDatedIssue("Due date re-saved");

    await actAs(ADMIN);
    await updateIssue({ issueId, status: "DONE" });

    const result = await updateIssue({ issueId, dueDate: "2099-06-01" });
    expect(result.ok).toBe(true);
    expect(dateOf((await stateOf(issueId)).dueDate)).toBe("2099-06-01");
  });
});

describe("work taken back out of a closed status", () => {
  it("can be dated again, with nothing to reset", async () => {
    const issueId = await aDatedIssue("Due date after reopening");

    await actAs(ADMIN);
    await updateIssue({ issueId, status: "DONE" });
    expect((await updateIssue({ issueId, dueDate: "2099-08-01" })).ok).toBe(
      false,
    );

    /* Back to active work, and the same request that was refused a moment ago
       is allowed. */
    expect((await updateIssue({ issueId, status: "IN_PROGRESS" })).ok).toBe(
      true,
    );
    expect((await updateIssue({ issueId, dueDate: "2099-08-01" })).ok).toBe(
      true,
    );
    expect(dateOf((await stateOf(issueId)).dueDate)).toBe("2099-08-01");

    /* And clearing it, which is the other half of editing. */
    expect((await updateIssue({ issueId, dueDate: "" })).ok).toBe(true);
    expect((await stateOf(issueId)).dueDate).toBeNull();
  });

  it("takes a date in the same breath as the reopening", async () => {
    /* The status this request leaves the issue in is what the rule reads, so
       reopening and dating together is one legitimate change rather than a
       date set on closed work. */
    const issueId = await aDatedIssue("Reopened and dated at once");

    await actAs(ADMIN);
    await updateIssue({ issueId, status: "DONE" });

    const result = await updateIssue({
      issueId,
      status: "REOPENED",
      dueDate: "2099-09-15",
    });
    expect(result.ok).toBe(true);

    const after = await stateOf(issueId);
    expect(after.status).toBe("REOPENED");
    expect(dateOf(after.dueDate)).toBe("2099-09-15");
  });
});
