import { expect, test, type Page } from "@playwright/test";
import { prisma } from "@/lib/prisma";
import { ADMIN_EMAIL, watchForProblems } from "./support";

/**
 * A notification row, after Mark read and the time swapped places.
 *
 *   [avatar] Actor message                               [5 minutes ago]
 *            ENG-1 Title
 *            [Status] [Mark read]
 *
 * Only the two moved: the time is on the right where Mark read was, and Mark
 * read is beside the type badge where the time was. What each of them does —
 * and what clicking the message does — is unchanged.
 */

const created: string[] = [];

test.afterAll(async () => {
  if (created.length > 0) {
    await prisma.notification.deleteMany({ where: { id: { in: created } } });
  }
});

async function aNotification(message: string) {
  const admin = await prisma.user.findUniqueOrThrow({
    where: { email: ADMIN_EMAIL },
    select: { id: true },
  });
  const actor = await prisma.user.findFirstOrThrow({
    where: { email: { not: ADMIN_EMAIL } },
    select: { id: true },
  });
  const issue = await prisma.issue.findFirstOrThrow({
    where: { project: { key: "ENG" } },
    select: { id: true },
  });
  const row = await prisma.notification.create({
    data: {
      userId: admin.id,
      actorId: actor.id,
      issueId: issue.id,
      type: "STATUS_CHANGED",
      message,
    },
    select: { id: true },
  });
  created.push(row.id);
}

async function checkLayout(page: Page, message: string) {
  const row = page.locator("li.prio-notification").filter({ hasText: message });
  await expect(row).toBeVisible();

  const time = row.locator(":scope > time.prio-notification__time");
  const meta = row.locator(".prio-notification__meta");
  const mark = meta.getByRole("button", { name: /^Mark (read|unread)$/ });
  const badge = meta.locator(".prio-badge");
  const text = row.locator(".prio-notification__text");
  const body = row.locator(".prio-notification__body");

  await expect(time).toHaveCount(1);
  await expect(time).not.toHaveText("");
  await expect(mark).toHaveCount(1);
  // Nothing left over in the old places.
  await expect(row.locator(":scope > button")).toHaveCount(0);
  await expect(meta.locator("time")).toHaveCount(0);

  const [rowBox, timeBox, markBox, badgeBox, textBox, bodyBox] = await Promise.all([
    row.boundingBox(),
    time.boundingBox(),
    mark.boundingBox(),
    badge.boundingBox(),
    text.boundingBox(),
    body.boundingBox(),
  ]);

  // The time is on the right, level with the top of the message.
  expect(timeBox!.x).toBeGreaterThanOrEqual(bodyBox!.x + bodyBox!.width - 1);
  expect(rowBox!.x + rowBox!.width - (timeBox!.x + timeBox!.width)).toBeLessThan(40);
  expect(Math.abs(timeBox!.y - textBox!.y)).toBeLessThan(16);

  // Mark read is on the meta line beside the type, below the message.
  expect(Math.abs(markBox!.y + markBox!.height / 2 - (badgeBox!.y + badgeBox!.height / 2))).toBeLessThan(6);
  expect(markBox!.x).toBeGreaterThan(badgeBox!.x);
  expect(markBox!.y).toBeGreaterThan(textBox!.y);
  expect(markBox!.x + markBox!.width).toBeLessThan(timeBox!.x);

  return { row, mark };
}

test("Mark read and the time have swapped places, and both still work", async ({ page }) => {
  const { consoleErrors } = watchForProblems(page);
  const message = `swapped layout ${Date.now()}`;
  await aNotification(message);

  await page.goto("/notifications");
  const { row, mark } = await checkLayout(page, message);
  await page.screenshot({ path: "test-results/notification-layout-light.png" });

  await expect(row).toHaveAttribute("data-read", "false");
  await expect(mark).toHaveText("Mark read");
  await mark.click();
  await expect(row).toHaveAttribute("data-read", "true");
  await expect(mark).toHaveText("Mark unread");
  await mark.click();
  await expect(row).toHaveAttribute("data-read", "false");

  // Clicking the message still opens it.
  await row.locator(".prio-notification__link").click();
  await expect(page.getByRole("button", { name: "Back to notifications" })).toBeVisible();

  expect(consoleErrors).toEqual([]);
});

test("the same layout holds in dark mode", async ({ page }) => {
  /* Dark is a stored choice in Prio, not the system preference, so it is
     chosen the way the Theme switcher chooses it. */
  await page.addInitScript(() => localStorage.setItem("prio-theme", "dark"));
  const message = `swapped layout dark ${Date.now()}`;
  await aNotification(message);

  await page.goto("/notifications");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await checkLayout(page, message);
  await page.screenshot({ path: "test-results/notification-layout-dark.png" });
});
