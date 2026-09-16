import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import type { CurrentUser } from "@/lib/session";
import { createIssue } from "@/server/issues";
import { createProject } from "@/server/projects";
import {
  countByStatus,
  exportIssues,
  listIssues,
  DEFAULT_PAGE_SIZE,
} from "@/server/queries/issues";
import { actAs } from "./helpers";

/**
 * A project is not capped at a number of issues.
 *
 * There is no business rule in Prio limiting how much work a project may hold
 * — no constant, no validation, no database constraint — and this is what says
 * so out loud. It exists because "no limit" is invisible: nothing in the code
 * announces its own absence, so a cap could be introduced later and nobody
 * would notice until a project stopped accepting work.
 *
 * The boundary tested is 2,000, and the assertion that matters is the one
 * after it: the 2,001st issue is created through the ordinary action and is
 * accepted like any other.
 *
 * Done efficiently rather than expensively. The 1,998 issues below the boundary
 * are inserted in one statement — they are scenery, and driving them through
 * the full action would test the same path 1,998 times for nothing. The three
 * that straddle the boundary go through `createIssue` itself, because those are
 * the ones a limit would refuse.
 *
 * Pagination is asserted alongside, and deliberately: a page size is not a cap
 * on the project, and the way to prove that is to hold far more issues than one
 * page and show that the total, the page count and the export all describe the
 * whole set.
 */

const ADMIN = "admin@symbiosystech.com";

/** Rows created in one statement, before the boundary is approached. */
const SCENERY = 1_998;

let projectId = "";
let projectKey = "";
let admin: CurrentUser;

beforeAll(async () => {
  await actAs(ADMIN);
  admin = await prisma.user.findUniqueOrThrow({
    where: { email: ADMIN },
    select: {
      id: true,
      name: true,
      email: true,
      image: true,
      role: true,
      jobTitle: true,
      isActive: true,
    },
  });

  projectKey = `CAP${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
  const created = await createProject({
    name: `Capacity ${Date.now()}`,
    key: projectKey,
    description: "Fixture proving a project is not capped at an issue count.",
  });
  if (!created.ok) throw new Error(created.error);
  projectId = created.data.id;

  /*
   * The scenery, in one statement, and the project's counter moved to match.
   * `createIssue` allocates the next number from `issueSequence`, so leaving it
   * behind would make the three real creates collide with keys already used.
   */
  await prisma.issue.createMany({
    data: Array.from({ length: SCENERY }, (_, index) => ({
      key: `${projectKey}-${index + 1}`,
      number: index + 1,
      projectId,
      type: "TASK" as const,
      title: `Capacity scenery ${index + 1}`,
      status: "BACKLOG" as const,
      priority: "MEDIUM" as const,
      reporterId: admin.id,
      sortIndex: (index + 1) * 1000,
    })),
  });
  await prisma.project.update({
    where: { id: projectId },
    data: { issueSequence: SCENERY },
  });
}, 120_000);

afterAll(async () => {
  /* The project cascades to its issues and everything hanging off them. */
  if (projectId) await prisma.project.deleteMany({ where: { id: projectId } });
  await prisma.$disconnect();
});

/** One issue through the ordinary action, as a person would create it. */
async function createOne(title: string) {
  await actAs(ADMIN);
  return createIssue({
    projectId,
    type: "TASK",
    title,
    description: "fixture",
    priority: "MEDIUM",
  });
}

describe("a project's issue count is not capped", () => {
  it("accepts the 1,999th, the 2,000th and the 2,001st issue", async () => {
    /*
     * Straddling the boundary on purpose. A cap at 2,000 would let the first
     * two through and refuse the third, so all three are asserted separately
     * rather than as a batch — the failure would otherwise not say which one
     * was refused.
     */
    const atBoundary: Record<number, string> = {};

    for (const expected of [1_999, 2_000, 2_001]) {
      const result = await createOne(`Capacity issue ${expected}`);
      expect(
        result.ok,
        result.ok ? "" : `issue ${expected} was refused: ${result.error}`,
      ).toBe(true);
      if (result.ok) atBoundary[expected] = result.data.key;
    }

    // The keys really are the ones expected, so nothing silently skipped.
    expect(atBoundary[1_999]).toBe(`${projectKey}-1999`);
    expect(atBoundary[2_000]).toBe(`${projectKey}-2000`);
    expect(atBoundary[2_001]).toBe(`${projectKey}-2001`);

    expect(
      await prisma.issue.count({ where: { projectId } }),
      "the project holds more than two thousand issues",
    ).toBe(2_001);
  });

  it("keeps counting past the boundary rather than saturating at it", async () => {
    /* A cap implemented as a clamp would report 2,000 for ever. */
    const before = await prisma.issue.count({ where: { projectId } });
    const extra = await createOne("Capacity issue beyond");
    expect(extra.ok).toBe(true);

    expect(await prisma.issue.count({ where: { projectId } })).toBe(before + 1);
  });
});

describe("the whole set is still reachable", () => {
  it("pages through it without the page size becoming a cap", async () => {
    const total = await prisma.issue.count({ where: { projectId } });
    expect(total).toBeGreaterThan(2_000);

    const firstPage = await listIssues(admin, { projectIds: [projectId] });

    /* The total describes the project, not the page: a page size is how much
       is fetched at once, which is a different question from how much exists. */
    expect(firstPage.total).toBe(total);
    expect(firstPage.pageSize).toBe(DEFAULT_PAGE_SIZE);
    expect(firstPage.rows.length).toBe(DEFAULT_PAGE_SIZE);
    expect(firstPage.pageCount).toBe(Math.ceil(total / DEFAULT_PAGE_SIZE));
    expect(firstPage.pageCount).toBeGreaterThan(80);

    /* And a page deep past the boundary really returns rows — a truncated
       query would come back empty here while still reporting a large total. */
    const deepPage = await listIssues(admin, {
      projectIds: [projectId],
      page: 81,
    });
    expect(deepPage.rows.length).toBeGreaterThan(0);

    const lastPage = await listIssues(admin, {
      projectIds: [projectId],
      page: firstPage.pageCount,
    });
    expect(lastPage.rows.length).toBeGreaterThan(0);
  });

  it("counts every issue in the status summary", async () => {
    const total = await prisma.issue.count({ where: { projectId } });
    const counts = await countByStatus(admin, { projectIds: [projectId] });

    const summed = Object.values(counts).reduce((a, b) => a + b, 0);
    expect(summed, "the chips add up to the whole project").toBe(total);
  });

  it("exports the whole project rather than truncating it", async () => {
    /*
     * The case that would *look* like a project cap without being one: an
     * export that quietly stops. Prio bounds an export to protect memory while
     * generating the workbook, and that bound is far above this project — so
     * the export carries all of it, and the limit is a safeguard rather than a
     * rule about how much a project may hold.
     */
    const total = await prisma.issue.count({ where: { projectId } });
    const rows = await exportIssues(admin, { projectIds: [projectId] });

    expect(rows.length).toBe(total);
    expect(rows.length).toBeGreaterThan(2_000);
  }, 60_000);
});
