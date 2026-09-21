import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { canMoveToNextSprint, nextOpenSprint } from "@/lib/sprintMove";
import { prisma } from "@/lib/prisma";
import { moveIssueToSprint } from "@/server/sprints";
import { actAs } from "./helpers";

/**
 * Whether "Move to · Next sprint" should be offered at all.
 *
 * The menu offered it on every sprint issue. On a project running its only
 * sprint — most projects, most of the time — that was an entry on every card
 * that came back "No future Sprint is available." every time it was used.
 * Restore beside it was already offered only when there was somewhere to
 * restore to; `lib/sprintMove` gives its neighbour the same treatment.
 *
 * The risk in a second expression of one rule is that the two drift, so the
 * second half of this file does not check the predicate against cases
 * somebody wrote down: it checks it against `moveIssueToSprint` itself, over
 * the situations that tell them apart. The sharpest of those is two sprints
 * beginning on the same day — the server compares start dates with `>=`, and
 * a predicate written with `>` would refuse a move the server allows.
 */

const ADMIN = "admin@symbiosystech.com";

const day = (offset: number) => {
  const date = new Date(2026, 8, 1, 12);
  date.setDate(date.getDate() + offset);
  return date;
};

describe("which sprint Next sprint would choose", () => {
  const active = { id: "a", status: "ACTIVE" as const, startDate: day(0) };
  const soon = { id: "b", status: "PLANNED" as const, startDate: day(7) };
  const later = { id: "c", status: "PLANNED" as const, startDate: day(21) };
  const finished = { id: "d", status: "COMPLETED" as const, startDate: day(14) };

  it("takes the soonest open one from here on", () => {
    expect(nextOpenSprint([active, later, soon], active)?.id).toBe("b");
  });

  it("counts a sprint that starts the same day this one did", () => {
    /* Two sprints across one fortnight is an ordinary way to split work, and
       the server moves between them — `>=`, not `>`. */
    const twin = { id: "t", status: "PLANNED" as const, startDate: day(0) };
    expect(nextOpenSprint([active, twin], active)?.id).toBe("t");
    expect(canMoveToNextSprint([active, twin], active)).toBe(true);
  });

  it("never offers the sprint the work is already in", () => {
    expect(nextOpenSprint([active], active)).toBeNull();
    expect(canMoveToNextSprint([active], active)).toBe(false);
  });

  it("will not reach into a sprint that has been completed", () => {
    expect(nextOpenSprint([active, finished], active)).toBeNull();
  });

  it("ignores sprints that began before this one", () => {
    const earlier = { id: "e", status: "ACTIVE" as const, startDate: day(-7) };
    expect(nextOpenSprint([earlier, active], active)).toBeNull();
  });

  it("reaches for the soonest open sprint when the work is in none", () => {
    expect(nextOpenSprint([later, soon, active], null)?.id).toBe("a");
  });

  it("says no when a project has no sprints at all", () => {
    expect(canMoveToNextSprint([], null)).toBe(false);
    expect(canMoveToNextSprint([], active)).toBe(false);
  });
});

/**
 * The same question, asked of the thing that actually decides.
 */
describe("the predicate agrees with the move itself", () => {
  let projectId = "";
  let onlySprintId = "";
  let issueId = "";

  beforeAll(async () => {
    await actAs(ADMIN);
    const admin = await prisma.user.findUniqueOrThrow({
      where: { email: ADMIN },
      select: { id: true },
    });

    const project = await prisma.project.create({
      data: {
        key: `NXT${Date.now().toString(36).toUpperCase()}`.slice(0, 10),
        name: "Next sprint availability fixture",
        createdById: admin.id,
        issueSequence: 1,
        members: { create: [{ userId: admin.id }] },
      },
      select: { id: true },
    });
    projectId = project.id;

    const only = await prisma.sprint.create({
      data: {
        projectId,
        createdById: admin.id,
        name: "The only sprint",
        status: "ACTIVE",
        startDate: day(0),
        endDate: day(6),
      },
      select: { id: true },
    });
    onlySprintId = only.id;

    const issue = await prisma.issue.create({
      data: {
        projectId,
        sprintId: only.id,
        key: `NXT-${Date.now()}`.slice(0, 30),
        number: 1,
        title: "Work with nowhere to go",
        type: "TASK",
        status: "TODO",
        reporterId: admin.id,
      },
      select: { id: true },
    });
    issueId = issue.id;
  });

  afterAll(async () => {
    if (projectId) {
      await prisma.issue.deleteMany({ where: { projectId } });
      await prisma.sprint.deleteMany({ where: { projectId } });
      await prisma.project.deleteMany({ where: { id: projectId } });
    }
    await prisma.$disconnect();
  });

  const sprintsOf = () =>
    prisma.sprint.findMany({
      where: { projectId },
      select: { id: true, status: true, startDate: true },
    });

  it("refuses the move exactly where the predicate says not to offer it", async () => {
    const sprints = await sprintsOf();
    const from = sprints.find((s) => s.id === onlySprintId)!;

    expect(canMoveToNextSprint(sprints, from)).toBe(false);

    await actAs(ADMIN);
    const result = await moveIssueToSprint({
      issueId,
      destination: { type: "NEXT_SPRINT" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/no future sprint/i);
  });

  it("accepts it as soon as one starting the same day exists", async () => {
    /*
     * The case that pins `>=`. Nothing about the issue or its sprint changes
     * — the project simply gains a second sprint over the same dates, which
     * the server will move into and a stricter predicate would not offer.
     */
    const admin = await prisma.user.findUniqueOrThrow({
      where: { email: ADMIN },
      select: { id: true },
    });
    const twin = await prisma.sprint.create({
      data: {
        projectId,
        createdById: admin.id,
        name: "The one alongside",
        status: "PLANNED",
        startDate: day(0),
        endDate: day(6),
      },
      select: { id: true },
    });

    const sprints = await sprintsOf();
    const from = sprints.find((s) => s.id === onlySprintId)!;

    expect(canMoveToNextSprint(sprints, from)).toBe(true);
    expect(nextOpenSprint(sprints, from)?.id).toBe(twin.id);

    await actAs(ADMIN);
    const result = await moveIssueToSprint({
      issueId,
      destination: { type: "NEXT_SPRINT" },
    });
    expect(result.ok).toBe(true);

    const after = await prisma.issue.findUniqueOrThrow({
      where: { id: issueId },
      select: { sprintId: true, status: true },
    });
    expect(after.sprintId).toBe(twin.id);
    /* Moving between sprints changes the sprint and nothing else. */
    expect(after.status).toBe("TODO");
  });
});
