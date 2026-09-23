import { expect, test, type Page } from "@playwright/test";
import { prisma } from "@/lib/prisma";
import { STATUS_LABEL } from "@/lib/domain";

/**
 * The due date, on work that is finished with.
 *
 * Done, Reject / Not an Issue and Cancelled close an issue, and closed work
 * has no finishing left to plan — so the due date cannot be changed while it
 * sits in one of them, not even by an administrator, who is the only person
 * who may set one at all. The rule is in `canSetDueDateInStatus` and
 * `updateIssue` enforces it (see `tests/due-date-closed-status.test.ts`);
 * what this drives is the page: the control is *disabled* rather than gone,
 * the date it already carries still reads, and moving the issue back to
 * active work enables it again with nothing to reset.
 */

const CLOSED = ["DONE", "REJECTED", "CANCELLED"] as const;

let projectId: string | null = null;
const KEY = `DD${Date.now().toString(36).toUpperCase()}`.slice(0, 10);
const issues: { key: string; status: string }[] = [];

test.beforeAll(async () => {
  const admin = await prisma.user.findFirstOrThrow({
    where: { role: "ADMIN" },
    select: { id: true },
  });
  const project = await prisma.project.create({
    data: {
      key: KEY,
      name: `Due date fixture ${KEY}`,
      createdById: admin.id,
      members: { create: { userId: admin.id } },
      issueSequence: 4,
    },
    select: { id: true },
  });
  projectId = project.id;

  /* One issue per closed status, and one still in progress — each already
     dated, because the date has to survive the status. */
  const statuses = [...CLOSED, "IN_PROGRESS"] as const;
  for (const [index, status] of statuses.entries()) {
    const issue = await prisma.issue.create({
      data: {
        projectId: project.id,
        key: `${KEY}-${index + 1}`,
        number: index + 1,
        title: `Dated work in ${status}`,
        type: "TASK",
        status,
        reporterId: admin.id,
        dueDate: new Date("2099-06-01T00:00:00.000Z"),
      },
      select: { key: true },
    });
    issues.push({ key: issue.key, status });
  }
});

test.afterAll(async () => {
  if (projectId) {
    await prisma.activityLogEntry.deleteMany({
      where: { issue: { projectId } },
    });
    await prisma.notification.deleteMany({ where: { issue: { projectId } } });
    await prisma.issue.deleteMany({ where: { projectId } });
    await prisma.projectMember.deleteMany({ where: { projectId } });
    await prisma.project.deleteMany({ where: { id: projectId } });
  }
});

/**
 * The due-date control's state on the issue page, as a reader meets it.
 *
 * Found by the due-date pill it wraps: the page has other inline editables —
 * the parent field is one — and they are the same component.
 */
async function dueDateControl(page: Page) {
  return page.evaluate(() => {
    const field = document.querySelector(
      ".prio-editable--inline:has(.prio-due)",
    ) as HTMLElement | null;
    const trigger = field?.querySelector(
      ".prio-editable__trigger",
    ) as HTMLElement | null;
    if (!field || !trigger) return null;
    return {
      /* What the row says the date is — unchanged by any of this. */
      reads: field.textContent?.trim() ?? "",
      disabled:
        trigger.getAttribute("aria-disabled") === "true" ||
        (trigger as HTMLButtonElement).disabled,
      /* Why, in the words the page offers on hover and to a reader. */
      why:
        field.getAttribute("title") ?? trigger.getAttribute("aria-label") ?? "",
      /* A disabled control must not answer a click. */
      clickable: getComputedStyle(trigger).pointerEvents !== "none",
    };
  });
}

test.describe("The due date on closed work", () => {
  for (const status of CLOSED) {
    test(`is disabled while the issue is ${STATUS_LABEL[status]}`, async ({
      page,
    }) => {
      const issue = issues.find((row) => row.status === status)!;
      await page.goto(`/issues/${issue.key.toLowerCase()}`);
      await page
        .locator(".prio-editable--inline:has(.prio-due)")
        .waitFor({ timeout: 45_000 });

      const seen = (await dueDateControl(page))!;
      /* The date it was given is still on the issue and still on the page —
         the status governs editing, never the stored value. */
      expect(seen.reads).toContain("Jun 1, 2099");
      expect(seen.disabled, `${status}: the pencil still offers to edit`).toBe(
        true,
      );
      expect(seen.clickable, `${status}: the pencil still takes a click`).toBe(
        false,
      );
      expect(seen.why).toContain(STATUS_LABEL[status]);

      /* And there is no date input to type into. */
      await expect(page.locator("#due-date-edit")).toHaveCount(0);
    });
  }

  test("is editable on active work, and again once the issue is reopened", async ({
    page,
  }) => {
    const open = issues.find((row) => row.status === "IN_PROGRESS")!;
    await page.goto(`/issues/${open.key.toLowerCase()}`);
    await page
      .locator(".prio-editable--inline:has(.prio-due)")
      .waitFor({ timeout: 45_000 });

    /* Active work: the control works, and the form it opens is the ordinary
       one. */
    expect((await dueDateControl(page))!.disabled).toBe(false);
    await page.getByRole("button", { name: "Edit due date" }).click();
    await expect(page.locator("#due-date-edit")).toBeVisible();
    await page.getByRole("button", { name: "Cancel" }).click();

    /* Move it to Done through the control the page actually offers. */
    await page.locator(".prio-fieldtrigger").first().click();
    await page
      .getByRole("menu", { name: "Change status" })
      .getByRole("menuitemradio", { name: STATUS_LABEL.DONE, exact: true })
      .click();
    await expect
      .poll(async () => (await dueDateControl(page))?.disabled, {
        timeout: 15_000,
      })
      .toBe(true);

    /* Take it back out again: the rule follows the status, so nothing had to
       be reset and the control is simply usable once more. */
    await page.locator(".prio-fieldtrigger").first().click();
    await page
      .getByRole("menu", { name: "Change status" })
      .getByRole("menuitemradio", { name: STATUS_LABEL.REOPENED, exact: true })
      .click();
    await expect
      .poll(async () => (await dueDateControl(page))?.disabled, {
        timeout: 15_000,
      })
      .toBe(false);

    /* And the date it had all along is still there. */
    await expect
      .poll(async () =>
        (
          await prisma.issue.findFirstOrThrow({
            where: { key: open.key },
            select: { dueDate: true },
          })
        ).dueDate
          ?.toISOString()
          .slice(0, 10),
      )
      .toBe("2099-06-01");
  });
});
