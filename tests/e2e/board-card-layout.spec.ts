import { expect, test, type Page } from "@playwright/test";
import { prisma } from "@/lib/prisma";
import { ISSUE_STATUSES } from "@/lib/domain";

/**
 * An issue card's footer never draws on top of itself.
 *
 * The footer holds three things — the issue's key, its status and its
 * assignee — and a board column is not always wide enough for all three in a
 * row. With a long project key and the longest status in the set ("Reject /
 * Not an Issue") they used to collide: the key escaped its own box and the
 * status trigger refused to shrink, so the pill was drawn over the avatar.
 *
 * The card is shared, so this drives both places it is used — a project's
 * Flow Board and a sprint's own page — and checks every status column rather
 * than the one that was reported, at three widths. Geometry is read from the
 * rendered page: two boxes on the same line must not overlap, and nothing may
 * escape the card.
 */

const createdProjects: string[] = [];
const createdIssues: string[] = [];
const createdSprints: string[] = [];

test.afterAll(async () => {
  if (createdSprints.length > 0) {
    await prisma.sprint.deleteMany({ where: { id: { in: createdSprints } } });
  }
  if (createdIssues.length > 0) {
    await prisma.issue.deleteMany({ where: { id: { in: createdIssues } } });
  }
  if (createdProjects.length > 0) {
    await prisma.project.deleteMany({ where: { id: { in: createdProjects } } });
  }
});

/**
 * A project whose key is as long as Prio allows — ten characters, the length
 * of the reported `SYMBIOCOPY-17` — holding one assigned issue in every
 * status, all of them in one sprint.
 *
 * The long key is the point: `ENG-2` leaves room the reported case did not
 * have, so a fixture with a short key would pass while the bug was still
 * there. Seeded once and shared, since both tests want the same rows.
 */
let fixture: Promise<{ key: string; sprintId: string }> | null = null;

function boardFixture() {
  fixture ??= seedBoardFixture();
  return fixture;
}

async function seedBoardFixture() {
  const admin = await prisma.user.findFirstOrThrow({
    where: { role: "ADMIN" },
    select: { id: true },
  });
  const assignee = await prisma.user.findFirstOrThrow({
    where: { isActive: true },
    select: { id: true },
  });
  /* Ten characters, the most a project key may be, and unique per run: the
     prefix alone would collide on a second call. */
  const key = `SY${Date.now().toString(36).toUpperCase()}`.slice(0, 10);
  const project = await prisma.project.create({
    data: {
      key,
      name: `Card layout fixture ${key}`,
      createdById: admin.id,
      members: {
        create: [...new Set([admin.id, assignee.id])].map((userId) => ({
          userId,
        })),
      },
    },
    select: { id: true, key: true },
  });
  createdProjects.push(project.id);

  const sprint = await prisma.sprint.create({
    data: {
      name: `E2E card layout ${Date.now()}`,
      startDate: new Date(),
      endDate: new Date(Date.now() + 12 * 86_400_000),
      projectId: project.id,
      createdById: admin.id,
      status: "ACTIVE",
      startedAt: new Date(),
    },
    select: { id: true },
  });
  createdSprints.push(sprint.id);

  /* One issue per status, so every column on both boards is covered — the
     statuses come from the application's own list, so a status added later
     is covered here without this test being edited. */
  for (const [index, status] of ISSUE_STATUSES.entries()) {
    const number = index + 1;
    const issue = await prisma.issue.create({
      data: {
        projectId: project.id,
        key: `${project.key}-${number}`,
        number,
        title: `Card layout ${status}`,
        type: "TASK",
        status,
        reporterId: admin.id,
        assigneeId: assignee.id,
        sprintId: sprint.id,
      },
      select: { id: true },
    });
    createdIssues.push(issue.id);
  }

  await prisma.project.update({
    where: { id: project.id },
    data: { issueSequence: ISSUE_STATUSES.length },
  });

  return { key: project.key.toLowerCase(), sprintId: sprint.id };
}

/**
 * Every card's footer geometry, read from the page: the key, the status pill
 * and the avatar, plus the card they sit in.
 */
async function footerProblems(page: Page) {
  return page.evaluate(() => {
    const problems: string[] = [];

    document.querySelectorAll(".prio-board__card").forEach((card) => {
      const status =
        card.querySelector(".prio-status")?.textContent?.trim() ?? "?";
      const parts: [string, DOMRect][] = [];
      const add = (name: string, node: Element | null) => {
        if (node) parts.push([name, node.getBoundingClientRect()]);
      };
      add("key", card.querySelector(".prio-board__card-key"));
      add("keytext", card.querySelector(".prio-board__card-key .prio-key"));
      add(
        "status",
        card.querySelector(".prio-board__card-statustrigger .prio-status"),
      );
      add("avatar", card.querySelector(".prio-board__card-meta > .prio-avatar"));

      /* Two pieces on the same line may sit beside each other, never over
         each other. A pair on different lines is exactly what wrapping is
         for, so only same-line pairs are compared. */
      for (let i = 0; i < parts.length; i += 1) {
        for (let j = i + 1; j < parts.length; j += 1) {
          const [nameA, a] = parts[i]!;
          const [nameB, b] = parts[j]!;
          if (nameA === "key" && nameB === "keytext") continue;
          const sameLine = Math.abs(a.top - b.top) < 8;
          const overlap =
            Math.min(a.right, b.right) - Math.max(a.left, b.left);
          if (sameLine && overlap > 0.5) {
            problems.push(
              `${status}: ${nameA} overlaps ${nameB} by ${Math.round(overlap)}px`,
            );
          }
        }
      }

      /* Nothing may run out of the card either — the avatar being pushed
         past the edge was the other half of the reported case. */
      const box = card.getBoundingClientRect();
      parts.forEach(([name, rect]) => {
        if (rect.right > box.right - 4) {
          problems.push(
            `${status}: ${name} escapes the card by ${Math.round(rect.right - box.right)}px`,
          );
        }
      });

      /* And the assignee is always there to be seen. */
      const avatar = card.querySelector(
        ".prio-board__card-meta > .prio-avatar",
      );
      if (avatar) {
        const rect = avatar.getBoundingClientRect();
        if (rect.width < 12 || rect.height < 12) {
          problems.push(`${status}: avatar squashed to ${Math.round(rect.width)}px`);
        }
      }
    });

    return problems;
  });
}

const WIDTHS = [1500, 1000, 420];

test.describe("Issue card footers", () => {
  test("keep the key, the status and the assignee apart on a sprint's own page", async ({
    page,
  }) => {
    const { key, sprintId } = await boardFixture();

    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto(`/projects/${key}/sprints/${sprintId}`);
      await expect(page.getByText("Issues in this sprint")).toBeVisible();

      /* Every status is in this sprint, so every card design is on screen —
         including "Reject / Not an Issue", the longest of them. */
      const cards = page.locator(".prio-board__card");
      expect(await cards.count()).toBe(9);
      await expect(
        page.locator(".prio-status", { hasText: "Reject / Not an Issue" }).first(),
      ).toBeVisible();

      expect(await footerProblems(page), `at ${width}px`).toEqual([]);
    }
  });

  test("keep them apart on the project's Flow Board too", async ({ page }) => {
    const { key } = await boardFixture();

    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto(`/projects/${key}/board`);
      await expect(page.locator(".prio-board__card").first()).toBeVisible();

      expect(await footerProblems(page), `at ${width}px`).toEqual([]);
    }
  });
});
