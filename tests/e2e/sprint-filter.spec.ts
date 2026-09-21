import { expect, test, type Locator } from "@playwright/test";
import { prisma } from "@/lib/prisma";
import { ADMIN_STATE } from "./support";

/**
 * Filtering a project's issue list by iteration.
 *
 * The chip sits on the list's existing filter bar rather than in a sprint
 * surface of its own, because "show me this iteration's work" is a question
 * about issues and the bar is where issue questions are asked. It is labelled
 * "Iteration" and lists only real iterations: there is no Backlog entry.
 *
 * Everything is driven through the real bar and asserted on the real rows, so
 * this covers the whole chain — chip, URL, server query — rather than any one
 * link in it.
 */

const created: string[] = [];
const createdSprints: string[] = [];

function stamp() {
  return Date.now().toString(36);
}

/** An issue in Engineering, optionally already in a sprint. */
async function seedIssue(title: string, sprintId?: string) {
  const project = await prisma.project.update({
    where: { key: "ENG" },
    data: { issueSequence: { increment: 1 } },
    select: { id: true, issueSequence: true },
  });
  const reporter = await prisma.user.findFirstOrThrow({
    where: { role: "ADMIN" },
    select: { id: true },
  });

  const issue = await prisma.issue.create({
    data: {
      projectId: project.id,
      key: `ENG-${project.issueSequence}`,
      number: project.issueSequence,
      title,
      type: "TASK",
      status: "TODO",
      reporterId: reporter.id,
      sprintId: sprintId ?? null,
    },
    select: { id: true, key: true },
  });
  created.push(issue.id);
  return issue;
}

async function seedSprint(name: string, status: "PLANNED" | "COMPLETED" = "PLANNED") {
  const project = await prisma.project.findUniqueOrThrow({
    where: { key: "ENG" },
    select: { id: true },
  });
  const admin = await prisma.user.findFirstOrThrow({
    where: { role: "ADMIN" },
    select: { id: true },
  });
  const sprint = await prisma.sprint.create({
    data: {
      name,
      startDate: new Date(),
      endDate: new Date(Date.now() + 12 * 86_400_000),
      projectId: project.id,
      createdById: admin.id,
      status,
      completedAt: status === "COMPLETED" ? new Date() : null,
    },
    select: { id: true, name: true },
  });
  createdSprints.push(sprint.id);
  return sprint;
}

test.afterAll(async () => {
  if (created.length > 0) {
    await prisma.issue.deleteMany({ where: { id: { in: created } } });
  }
  if (createdSprints.length > 0) {
    await prisma.sprint.deleteMany({ where: { id: { in: createdSprints } } });
  }
});

/**
 * One iteration in the filter menu, matched by name *and* period.
 *
 * The options carry the range each iteration covers — the same bracketed form
 * the sprint cards and the details page print — so that choosing between
 * "Sprint 1" and "Sprint 2" is choosing between two dates rather than two
 * numbers. Matched on name-plus-range rather than on the exact name, which is
 * what this asserted before and which would now pass only if the range had
 * gone missing.
 */
function iterationOption(menu: Locator, name: string): Locator {
  const range = String.raw`\(\d{2} \w{3} \d{4} - \d{2} \w{3} \d{4}\)`;
  return menu.getByRole("menuitemradio", {
    name: new RegExp(`^${name} ${range}$`),
  });
}

test.describe("The iteration filter on a project's list", () => {
  test.use({ storageState: ADMIN_STATE });

  test("shows one iteration's work from the filter bar, and offers no Backlog entry", async ({
    page,
  }) => {
    const id = stamp();
    const sprint = await seedSprint(`E2E filter sprint ${id}`);
    const inSprint = await seedIssue(`Filter in sprint ${id}`, sprint.id);
    const inBacklog = await seedIssue(`Filter in backlog ${id}`);

    await page.goto("/projects/eng/list?q=" + encodeURIComponent(`Filter in`));

    // Both are here before anything is filtered.
    await expect(page.getByRole("link", { name: inSprint.key })).toBeVisible();
    await expect(page.getByRole("link", { name: inBacklog.key })).toBeVisible();

    // The chip is called Iteration now; there is no chip called Sprint.
    await expect(page.getByRole("button", { name: "Sprint", exact: true })).toHaveCount(0);

    // ------------------------------------------------ one iteration's work
    /* The bar's options are checkable, so they are `menuitemradio` — the
       same role every other chip on it uses. */
    await page.getByRole("button", { name: "Iteration" }).click();
    const menu = page.getByRole("menu", { name: "Iteration" });

    // Only real iterations are listed — no Backlog entry.
    await expect(menu.getByRole("menuitemradio", { name: /Backlog/ })).toHaveCount(0);

    await iterationOption(menu, sprint.name).click();
    await page.keyboard.press("Escape");

    await expect(page).toHaveURL(new RegExp(`sprint=${sprint.id}`));
    await expect(page.getByRole("link", { name: inSprint.key })).toBeVisible();
    await expect(page.getByRole("link", { name: inBacklog.key })).toHaveCount(0);

    // ------------------------------------------------------- clearing it
    /* Picking the ticked entry again clears it, which is how every chip on
       this bar clears; both issues are back. */
    await page.getByRole("button", { name: "Iteration" }).click();
    await iterationOption(menu, sprint.name).click();
    await page.keyboard.press("Escape");

    await expect(page).not.toHaveURL(new RegExp(`sprint=${sprint.id}`));
    await expect(page.getByRole("link", { name: inSprint.key })).toBeVisible();
    await expect(page.getByRole("link", { name: inBacklog.key })).toBeVisible();
  });

  test("marks a completed iteration with a check, and shows only its issues when picked", async ({
    page,
  }) => {
    const id = stamp();
    const open = await seedSprint(`E2E open iteration ${id}`);
    const done = await seedSprint(`E2E done iteration ${id}`, "COMPLETED");
    const inOpen = await seedIssue(`Iter open ${id}`, open.id);
    const inDone = await seedIssue(`Iter done ${id}`, done.id);
    const elsewhere = await seedIssue(`Iter none ${id}`);

    await page.goto("/projects/eng/list?q=" + encodeURIComponent(`Iter`));
    await expect(page.getByRole("link", { name: elsewhere.key })).toBeVisible();

    await page.getByRole("button", { name: "Iteration" }).click();
    const menu = page.getByRole("menu", { name: "Iteration" });

    // The check follows the sprint's real status: the completed one has it,
    // the open one does not.
    const doneItem = menu.getByRole("menuitemradio", { name: new RegExp(done.name) });
    const openItem = menu.getByRole("menuitemradio", { name: new RegExp(open.name) });
    await expect(doneItem.locator(".prio-filter__iteration-done")).toBeVisible();
    await expect(openItem.locator(".prio-filter__iteration-done")).toHaveCount(0);

    await doneItem.click();
    await page.keyboard.press("Escape");

    await expect(page).toHaveURL(new RegExp(`sprint=${done.id}`));
    await expect(page.getByRole("link", { name: inDone.key })).toBeVisible();
    await expect(page.getByRole("link", { name: inOpen.key })).toHaveCount(0);
    await expect(page.getByRole("link", { name: elsewhere.key })).toHaveCount(0);
  });
});
