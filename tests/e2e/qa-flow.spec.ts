import { expect, test } from "@playwright/test";
import { prisma } from "@/lib/prisma";
import { ADMIN_STATE, MEMBER_STATE } from "./support";

/**
 * The developer ↔ tester round trip, driven through the real browser.
 *
 * `tests/qa-collaboration.test.ts` proves the server actions behave; this
 * proves a person can actually reach them — that the Submit button appears for
 * the right person, the verdict buttons appear for the other one, and the two
 * halves of the loop agree about the same issue afterwards.
 *
 * The developer here is the seeded member (Priya) and the tester is the
 * administrator, purely because the suite already keeps signed-in states for
 * exactly those two. The tester is also the issue's reporter, because
 * recording a verdict belongs to whoever raised the problem — a developer
 * cannot sign off their own work simply by having filed the ticket.
 */

const DEV_EMAIL = "priya.nair@symbiosystech.com";
const TESTER_EMAIL = "admin@symbiosystech.com";

/** A fresh issue assigned to the developer, removed however the test ends. */
async function fixture() {
  const project = await prisma.project.findUniqueOrThrow({
    where: { key: "ENG" },
    select: { id: true, issueSequence: true },
  });
  const dev = await prisma.user.findUniqueOrThrow({
    where: { email: DEV_EMAIL },
    select: { id: true },
  });
  /* The tester raises the issue and the developer is assigned it, which is
     what makes this a two-person loop: recording the verdict belongs to
     whoever reported the problem, so the reporter has to be the tester and
     not the developer being tested. */
  const tester = await prisma.user.findUniqueOrThrow({
    where: { email: TESTER_EMAIL },
    select: { id: true },
  });

  const number = project.issueSequence + 1;
  const [, issue] = await prisma.$transaction([
    prisma.project.update({
      where: { id: project.id },
      data: { issueSequence: number },
    }),
    prisma.issue.create({
      data: {
        key: `ENG-${number}`,
        number,
        projectId: project.id,
        type: "TASK",
        title: `QA browser flow fixture ${Date.now()}`,
        description: "Created by the E2E suite.",
        status: "TODO",
        priority: "URGENT",
        assigneeId: dev.id,
        reporterId: tester.id,
      },
      select: { id: true, key: true },
    }),
  ]);

  return issue;
}

test.describe("Developer → Submit → Tester → verdict", () => {
  test("runs the whole loop in the browser and persists it", async ({
    browser,
  }) => {
    const issue = await fixture();
    const path = `/issues/${issue.key.toLowerCase()}`;

    const devContext = await browser.newContext({ storageState: MEMBER_STATE });
    const devPage = await devContext.newPage();

    /** Set once the tester files a bug, so cleanup can remove it too. */
    let reportedBugKey: string | null = null;

    try {
      /* ---------------------------------------------- developer submits */
      await devPage.goto(path);

      /* Their own work: they get Submit, and are told who records the verdict.
         That is now the person who raised the issue rather than "anybody but
         you" — the developer is not the reporter here, so they still get no
         verdict controls, which is what this asserts. */
      const submit = devPage.getByRole("button", { name: "Submit for review" });
      await expect(submit).toBeVisible();
      await expect(
        devPage.getByText("The person who raised this issue records the test result"),
      ).toBeVisible();
      await expect(devPage.locator(".prio-qa__actions")).toHaveCount(0);

      await submit.click();
      await expect(devPage.locator(".prio-toast").last()).toContainText(
        "submitted for review",
      );

      // The transition really happened, not just a toast.
      await expect
        .poll(
          async () =>
            (
              await prisma.issue.findUniqueOrThrow({
                where: { id: issue.id },
                select: { status: true },
              })
            ).status,
          { timeout: 10_000 },
        )
        .toBe("IN_REVIEW");

      /* ------------------------------------------------- tester verdict */
      // The stored admin session, rather than signing in again — the suite
      // shares better-auth's 3-per-10s sign-in throttle across every spec.
      const qaContext = await browser.newContext({ storageState: ADMIN_STATE });
      const qaPage = await qaContext.newPage();
      await qaPage.goto(path);

      // Not their work: they get the verdict buttons and no Submit.
      await expect(
        qaPage.getByRole("button", { name: "Submit for review" }),
      ).toHaveCount(0);
      const actions = qaPage.locator(".prio-qa__actions");
      await expect(actions).toBeVisible();

      await actions.getByRole("button", { name: "Failed" }).click();
      await expect(qaPage.locator(".prio-toast").last()).toContainText(
        "Marked failed",
      );

      await expect(qaPage.locator(".prio-testresult")).toHaveText("Failed");

      /* ---------------------------------- tester files a bug against it */
      await qaPage.getByRole("button", { name: "Report a problem" }).click();
      const dialog = qaPage.getByRole("dialog");
      await expect(dialog).toBeVisible();

      const bugSummary = `Login button stops responding ${Date.now()}`;
      await dialog.getByLabel("Summary").fill(bugSummary);
      await dialog.getByLabel("Where you found it").fill("Login page");

      await dialog.getByRole("button", { name: "Report problem" }).click();

      // Lands on the new bug, which carries the context nobody typed.
      await expect(qaPage).toHaveURL(/\/issues\/eng-\d+$/);
      await expect(
        qaPage.getByRole("heading", { name: bugSummary }),
      ).toBeVisible();

      const bugKey = (
        await qaPage.locator(".prio-issue__crumb-current .prio-key").innerText()
      ).trim();
      reportedBugKey = bugKey;

      // Filed against the right work, assigned back to the developer.
      const bug = await prisma.issue.findUniqueOrThrow({
        where: { key: bugKey },
        select: {
          type: true,
          assigneeId: true,
          affectedModule: true,
        },
      });
      expect(bug.type).toBe("BUG");
      expect(bug.affectedModule).toBe("Login page");

      const dev = await prisma.user.findUniqueOrThrow({
        where: { email: DEV_EMAIL },
        select: { id: true },
      });
      expect(bug.assigneeId).toBe(dev.id);

      // Linked both ways, and the developer was notified.
      expect(
        await prisma.issueLink.count({
          where: { target: { key: bugKey }, source: { id: issue.id } },
        }),
      ).toBe(1);
      expect(
        await prisma.notification.count({
          where: { userId: dev.id, issue: { key: bugKey } },
        }),
      ).toBeGreaterThan(0);

      /* ------------------------------- developer sees it, tester passes it */
      await devPage.goto(path);
      await expect(devPage.locator(".prio-testresult")).toHaveText("Failed");

      await qaPage.goto(path);
      await actions.getByRole("button", { name: "Passed" }).click();
      await expect(qaPage.locator(".prio-testresult")).toHaveText("Passed");

      // The verdict, who set it and when are all in PostgreSQL.
      const stored = await prisma.issue.findUniqueOrThrow({
        where: { id: issue.id },
        select: { status: true, testResult: true, testedById: true, testedAt: true },
      });
      expect(stored.status).toBe("IN_REVIEW");
      expect(stored.testResult).toBe("PASSED");
      expect(stored.testedById).not.toBeNull();
      expect(stored.testedAt).not.toBeNull();

      // Both verdicts survive in the append-only trail.
      const trail = await prisma.activityLogEntry.findMany({
        where: { issueId: issue.id, field: "testResult" },
        orderBy: { createdAt: "asc" },
        select: { newValue: true },
      });
      expect(trail.map((t) => t.newValue)).toEqual(["FAILED", "PASSED"]);

      await qaContext.close();
    } finally {
      await devContext.close();
      if (reportedBugKey) {
        await prisma.issue.deleteMany({ where: { key: reportedBugKey } });
      }
      await prisma.issue.delete({ where: { id: issue.id } });
    }
  });
});
