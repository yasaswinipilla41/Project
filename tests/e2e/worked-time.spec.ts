import { expect, test } from "@playwright/test";
import { prisma } from "@/lib/prisma";
import { ADMIN_STATE } from "./support";

/**
 * Worked time, on the page that shows it.
 *
 * The arithmetic is pinned in `tests/worked-time.test.ts`; this is the other
 * half — that the row appears where it was asked for, reads the two stored
 * timestamps, and stays away from work that has not finished.
 *
 * Both fixtures are made here with timestamps written directly, because the
 * span being measured is between `createdAt` and `completedAt` and there is no
 * way to make a real two-day-old issue inside a test.
 */

const created: string[] = [];

test.describe("Worked time on a work item", () => {
  test.use({ storageState: ADMIN_STATE });

  test.afterAll(async () => {
    if (created.length > 0) {
      await prisma.issue.deleteMany({ where: { id: { in: created } } });
    }
  });

  async function seed(options: {
    title: string;
    createdAt: Date;
    completedAt: Date | null;
  }) {
    const project = await prisma.project.findUniqueOrThrow({
      where: { key: "ENG" },
      select: { id: true, key: true, issueSequence: true },
    });
    const admin = await prisma.user.findFirstOrThrow({
      where: { role: "ADMIN" },
      select: { id: true },
    });

    const number = project.issueSequence + 1;
    const issue = await prisma.issue.create({
      data: {
        key: `${project.key}-${number}`,
        number,
        projectId: project.id,
        type: "TASK",
        title: options.title,
        status: options.completedAt ? "DONE" : "IN_PROGRESS",
        priority: "MEDIUM",
        reporterId: admin.id,
        createdAt: options.createdAt,
        completedAt: options.completedAt,
      },
      select: { id: true, key: true },
    });
    await prisma.project.update({
      where: { id: project.id },
      data: { issueSequence: number },
    });

    created.push(issue.id);
    return issue;
  }

  test("shows the span between created and completed, under the completed date", async ({
    page,
  }) => {
    /* Two days, four hours and thirty minutes — which reads as "2d 4h", the
       minutes being false precision on a span that long. */
    const createdAt = new Date("2026-09-15T10:00:00.000Z");
    const completedAt = new Date("2026-09-17T14:30:00.000Z");
    const issue = await seed({
      title: `Worked fixture ${Date.now()}`,
      createdAt,
      completedAt,
    });

    await page.goto(`/issues/${issue.key.toLowerCase()}`);

    const worked = page.locator(".prio-meta-row", { hasText: "Worked" }).first();
    await expect(worked).toBeVisible();
    await expect(worked).toContainText("2d 4h");

    /* Directly below the completed date, which is where it was asked for. */
    const rows = await page
      .locator(".prio-meta-row")
      .allInnerTexts();
    const completedAtIndex = rows.findIndex((t) => /Completed date/i.test(t));
    const workedIndex = rows.findIndex((t) => /Worked/i.test(t));
    expect(completedAtIndex).toBeGreaterThan(-1);
    expect(workedIndex).toBe(completedAtIndex + 1);
  });

  test("shows no worked row for work that has not finished", async ({ page }) => {
    /* The claim that matters: an open item must not carry a duration, because
       a number there reads as "this took that long" on work still running. */
    const issue = await seed({
      title: `Unfinished fixture ${Date.now()}`,
      createdAt: new Date("2026-09-15T10:00:00.000Z"),
      completedAt: null,
    });

    await page.goto(`/issues/${issue.key.toLowerCase()}`);

    // The page is the right one…
    await expect(page.getByText(issue.key).first()).toBeVisible();
    // …and carries neither a completion date nor a worked span.
    await expect(
      page.locator(".prio-meta-row", { hasText: "Completed date" }),
    ).toHaveCount(0);
    await expect(
      page.locator(".prio-meta-row", { hasText: "Worked" }),
    ).toHaveCount(0);
  });
});
