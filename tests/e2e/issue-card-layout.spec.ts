import { expect, test, type Page } from "@playwright/test";
import { prisma } from "@/lib/prisma";
import { ADMIN_STATE } from "./support";

/**
 * The shared issue card's footer: key, status, assignee — never on top of
 * one another.
 *
 * The card is one component (`BoardCard`), drawn both on the Flow Board and
 * in a sprint's own issue list, so this checks it in both places rather than
 * trusting that the second borrows the first correctly.
 *
 * The fixture is deliberate about what actually broke. The seeded projects
 * all have three-letter keys and nothing is in Reject / Not an Issue, so the
 * reported collision — a long key beside the longest status label in the set
 * — cannot happen against them at any width. A project whose key is ten
 * characters, with an issue in each of the long-labelled statuses and an
 * assignee to sit after them, is the case that reproduces it.
 *
 * What is asserted is geometry rather than CSS: whether two boxes share
 * pixels, and whether any text is wider than the box that holds it. A rule
 * can be rewritten without breaking this, and no rewrite that reintroduces
 * the overlap can pass it.
 */

test.use({ storageState: ADMIN_STATE });

/** Long enough to crowd the footer, which is the whole point of it. */
const KEY = `CARDLAYOUT${Date.now().toString(36).slice(-2)}`.toUpperCase().slice(0, 12);

let projectId = "";
let sprintId = "";

test.beforeAll(async () => {
  const admin = await prisma.user.findFirstOrThrow({
    where: { role: "ADMIN" },
    select: { id: true },
  });
  const member = await prisma.user.findFirstOrThrow({
    where: { role: "MEMBER", isActive: true },
    orderBy: { name: "asc" },
    select: { id: true },
  });

  const project = await prisma.project.create({
    data: {
      key: KEY,
      name: `Card layout fixture ${KEY}`,
      createdById: admin.id,
      members: { create: [{ userId: admin.id }, { userId: member.id }] },
    },
    select: { id: true },
  });
  projectId = project.id;

  const sprint = await prisma.sprint.create({
    data: {
      projectId: project.id,
      createdById: admin.id,
      name: `Card layout sprint ${KEY}`,
      status: "ACTIVE",
      startDate: new Date(Date.now() - 2 * 86_400_000),
      endDate: new Date(Date.now() + 5 * 86_400_000),
    },
    select: { id: true },
  });
  sprintId = sprint.id;

  /* The long-labelled statuses, which are the ones that crowd the footer.
     Every issue is assigned, so the avatar is there to be pushed off. */
  const statuses = [
    "REJECTED",
    "CANCELLED",
    "IN_REVIEW",
    "IN_QA",
    "REOPENED",
    "IN_PROGRESS",
  ] as const;

  for (const [index, status] of statuses.entries()) {
    await prisma.issue.create({
      data: {
        projectId: project.id,
        sprintId: sprint.id,
        key: `${KEY}-${index + 1}`,
        number: index + 1,
        title: `A title long enough to wrap onto a second line in a card ${index}`,
        type: "TASK",
        status,
        reporterId: admin.id,
        assigneeId: member.id,
      },
    });
  }
  await prisma.project.update({
    where: { id: project.id },
    data: { issueSequence: statuses.length },
  });
});

test.afterAll(async () => {
  if (sprintId) {
    await prisma.issue.deleteMany({ where: { sprintId } });
    await prisma.sprint.deleteMany({ where: { id: sprintId } });
  }
  if (projectId) {
    await prisma.issue.deleteMany({ where: { projectId } });
    await prisma.project.deleteMany({ where: { id: projectId } });
  }
});

/**
 * Every card's footer, measured in the browser.
 *
 * Two different failures are looked for, because the reported one produces
 * only the second:
 *
 *   `overlaps`  two of the three boxes sharing pixels.
 *   `spills`    text wider than the box holding it. This is what actually
 *               went wrong — the key is `white-space: nowrap`, so when its
 *               box was squeezed the glyphs carried on over the pill beside
 *               them while the boxes themselves stayed politely apart.
 */
async function footers(page: Page) {
  return page.evaluate(() => {
    const overlaps: string[] = [];
    const spills: string[] = [];
    const seen: string[] = [];

    for (const card of document.querySelectorAll(".prio-board__card")) {
      const name = card.querySelector(".prio-key")?.textContent ?? "?";
      const status =
        card
          .querySelector(".prio-board__card-status .prio-status")
          ?.getAttribute("data-status") ?? "?";
      seen.push(`${name}/${status}`);

      const parts: [string, Element][] = [];
      for (const [label, selector] of [
        ["key", ".prio-board__card-key"],
        ["status", ".prio-board__card-status"],
        ["avatar", ".prio-board__card-footer > .prio-avatar"],
      ] as const) {
        const el = card.querySelector(selector);
        if (el) parts.push([label, el]);
      }

      for (let i = 0; i < parts.length; i += 1) {
        for (let j = i + 1; j < parts.length; j += 1) {
          const a = parts[i]![1].getBoundingClientRect();
          const b = parts[j]![1].getBoundingClientRect();
          const x = Math.min(a.right, b.right) - Math.max(a.left, b.left);
          const y = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
          if (x > 0.5 && y > 0.5) {
            overlaps.push(
              `${name} ${status}: ${parts[i]![0]} over ${parts[j]![0]} by ${x.toFixed(1)}px`,
            );
          }
        }
      }

      /* The key must never be the thing that gives way: a truncated key is
         not a key. The status label may shorten — that is what it is for —
         so it is checked for being readable, not for being whole. */
      const key = card.querySelector(".prio-board__card-key");
      if (key && key.scrollWidth - key.clientWidth > 1) {
        spills.push(`${name} ${status}: key by ${key.scrollWidth - key.clientWidth}px`);
      }
    }

    return { cards: seen.length, seen, overlaps, spills };
  });
}

const WIDTHS = [1920, 1440, 1280, 1024, 900, 800] as const;

test.describe("the shared issue card's footer", () => {
  test("keeps key, status and assignee apart on the Flow Board", async ({
    page,
  }) => {
    await page.goto(`/projects/${KEY.toLowerCase()}/board`);
    await expect(page.locator(".prio-board__card").first()).toBeVisible();

    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 900 });
      /* The board re-measures its columns on resize; give it a frame. */
      await page.waitForTimeout(250);

      const result = await footers(page);
      expect(result.cards, `cards at ${width}px`).toBeGreaterThan(0);
      expect(result.overlaps, `overlaps at ${width}px`).toEqual([]);
      expect(result.spills, `text spilling its box at ${width}px`).toEqual([]);
    }
  });

  test("keeps them apart in a sprint's own issue list too", async ({ page }) => {
    await page.goto(`/projects/${KEY.toLowerCase()}/sprints/${sprintId}`);
    await expect(page.locator(".prio-board__card").first()).toBeVisible();

    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(250);

      const result = await footers(page);
      expect(result.cards, `cards at ${width}px`).toBeGreaterThan(0);
      expect(result.overlaps, `overlaps at ${width}px`).toEqual([]);
      expect(result.spills, `text spilling its box at ${width}px`).toEqual([]);
    }
  });

  test("still shows the icon, key, status and assignee on every card", async ({
    page,
  }) => {
    await page.goto(`/projects/${KEY.toLowerCase()}/sprints/${sprintId}`);

    const reject = page
      .locator(".prio-board__card")
      .filter({ hasText: `${KEY}-1` })
      .first();
    await expect(reject).toBeVisible();

    /* Nothing was dropped from the card to make room — the fix is a layout
       one, and every part the card carried before is still carried. */
    await expect(reject.locator(".prio-board__card-key svg")).toHaveCount(1);
    await expect(reject.locator(".prio-key")).toHaveText(`${KEY}-1`);
    await expect(
      reject.locator(".prio-board__card-status .prio-status"),
    ).toHaveAttribute("data-status", "REJECTED");
    await expect(reject.locator(".prio-avatar")).toHaveCount(1);
    await expect(
      reject.getByRole("button", { name: `Actions for ${KEY}-1` }),
    ).toHaveCount(1);

    /* And the longest label in the set still reads as itself rather than as
       a clipped rectangle: the pill keeps its dot and its words. */
    const label = reject.locator(".prio-status__label");
    await expect(label).toHaveText("Reject / Not an Issue");
    await expect(reject.locator(".prio-status__dot")).toHaveCount(1);
  });
});
