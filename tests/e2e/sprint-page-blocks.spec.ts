import { expect, test, type Page } from "@playwright/test";
import { prisma } from "@/lib/prisma";
import { openBurndown } from "./support";

/**
 * The sprint details page as one set of bordered blocks.
 *
 * The sprint block's border is the page's: every other block — the Burndown
 * Chart, Issues in this sprint, Issues by status — takes the same one, so the
 * page reads as a set of blocks rather than one strong one and three faint
 * ones. The sprint block itself is untouched, accent bar and all, and nothing
 * nested inside a block grows a border of its own.
 */

const createdProjects: string[] = [];

test.afterAll(async () => {
  for (const id of createdProjects) {
    await prisma.issue.deleteMany({ where: { projectId: id } });
    await prisma.sprint.deleteMany({ where: { projectId: id } });
    await prisma.project.deleteMany({ where: { id } });
  }
});

async function seed(status: "ACTIVE" | "PLANNED") {
  const admin = await prisma.user.findFirstOrThrow({
    where: { role: "ADMIN" },
    select: { id: true },
  });
  const key = `SP${Date.now().toString(36).toUpperCase()}`.slice(0, 10);
  const project = await prisma.project.create({
    data: {
      key,
      name: `Sprint blocks fixture ${key}`,
      createdById: admin.id,
      members: { create: { userId: admin.id } },
      issueSequence: 1,
    },
    select: { id: true, key: true },
  });
  createdProjects.push(project.id);
  const sprint = await prisma.sprint.create({
    data: {
      name: `E2E blocks ${Date.now()}`,
      startDate: new Date(Date.now() - 3 * 86_400_000),
      endDate: new Date(Date.now() + 10 * 86_400_000),
      projectId: project.id,
      createdById: admin.id,
      status,
      startedAt:
        status === "ACTIVE" ? new Date(Date.now() - 3 * 86_400_000) : null,
    },
    select: { id: true },
  });
  await prisma.issue.create({
    data: {
      projectId: project.id,
      key: `${project.key}-1`,
      number: 1,
      title: "Estimated work",
      type: "TASK",
      status: "IN_PROGRESS",
      reporterId: admin.id,
      sprintId: sprint.id,
      effortHours: 6,
      remainingHours: 6,
    },
  });
  return `/projects/${project.key.toLowerCase()}/sprints/${sprint.id}`;
}

/** Every block on the page, with the border it is drawn with. */
const blocks = (page: Page) =>
  page.evaluate(() => {
    const sprint = document.querySelector(".prio-sprint")!;
    const border = (node: Element) => {
      const style = getComputedStyle(node);
      return `${style.borderTopWidth} ${style.borderTopStyle} ${style.borderTopColor}`;
    };
    const siblings = Array.from(sprint.parentElement!.children).filter(
      (node) => node !== sprint && node.classList.contains("prio-card"),
    );
    return {
      sprint: border(sprint),
      sprintAccent: getComputedStyle(sprint).boxShadow.includes("inset"),
      others: siblings.map((node) => ({
        name: node.querySelector("h2")?.textContent?.trim() ?? node.className,
        border: border(node),
        radius: getComputedStyle(node).borderTopLeftRadius,
        accent: getComputedStyle(node).boxShadow.includes("inset"),
      })),
      /* The columns inside Issues in this sprint: nested, and not given
         the page's border. */
      nested: Array.from(document.querySelectorAll(".prio-sprint__column")).map(
        (node) => getComputedStyle(node).borderTopColor,
      ),
      overflow: document.documentElement.scrollWidth - window.innerWidth,
    };
  });

test.describe("The sprint page's blocks", () => {
  for (const theme of ["light", "dark"] as const) {
    test(`all share the sprint block's border on a running sprint (${theme})`, async ({
      page,
    }) => {
      const url = await seed("ACTIVE");
      await page.goto(url);
      await page.evaluate(
        (value) => document.documentElement.setAttribute("data-theme", value),
        theme,
      );
      await openBurndown(page);
      await page.locator(".prio-burndown").waitFor({ timeout: 45_000 });

      const seen = await blocks(page);
      /* The sprint block: its own border and its accent bar, as before. */
      expect(seen.sprintAccent).toBe(true);
      expect(seen.sprint).toMatch(/^1px solid /);

      /* Every other block — the chart, the issues, the status chart — in
         exactly that border, at the same radius, without the accent. */
      expect(seen.others.map((block) => block.name)).toEqual(
        expect.arrayContaining([
          "Burndown Chart",
          "Issues in this sprint",
          "Issues by status",
        ]),
      );
      for (const block of seen.others) {
        expect(block.border, block.name).toBe(seen.sprint);
        expect(block.radius, block.name).toBe("10px");
        expect(block.accent, block.name).toBe(false);
      }

      /* Nothing nested inside a block takes the page's border. */
      for (const colour of seen.nested) {
        expect(seen.sprint).not.toContain(colour);
      }
    });
  }

  test("keep the ordinary card border on a sprint that is not running", async ({
    page,
  }) => {
    const url = await seed("PLANNED");
    await page.goto(url);
    const seen = await blocks(page);
    expect(seen.sprintAccent).toBe(false);
    for (const block of seen.others) {
      expect(block.border, block.name).toBe(seen.sprint);
    }
  });

  test("leave the Sprints list alone, except the Upcoming group's border", async ({
    page,
  }) => {
    /*
     * The details page's border rule used to reach the Sprints list, where
     * sprints are the same kind of card one after another: every card after
     * the running sprint's took its purple edge. It no longer does — and the
     * Upcoming group is drawn without a border at all, while the running
     * sprint and the completed ones keep theirs exactly.
     */
    const url = await seed("ACTIVE");
    const listUrl = url.replace(/\/sprints\/[^/]+$/, "/sprints");
    const projectId = createdProjects[createdProjects.length - 1]!;
    const admin = await prisma.user.findFirstOrThrow({
      where: { role: "ADMIN" },
      select: { id: true },
    });
    const later = (
      name: string,
      status: "PLANNED" | "COMPLETED",
      from: number,
    ) =>
      prisma.sprint.create({
        data: {
          name: `${name} ${Date.now()}`,
          startDate: new Date(Date.now() + from * 86_400_000),
          endDate: new Date(Date.now() + (from + 13) * 86_400_000),
          projectId,
          createdById: admin.id,
          status,
          completedAt: status === "COMPLETED" ? new Date() : null,
        },
      });
    await later("Upcoming", "PLANNED", 14);
    await later("Also upcoming", "PLANNED", 28);
    await later("Finished", "COMPLETED", -30);

    await page.goto(listUrl);
    await page.locator(".prio-sprints").waitFor();
    /* Open the completed group, so its cards can be read too. */
    await page.getByRole("button", { name: /Completed sprints/i }).click();

    const seen = await page.evaluate(() => {
      const edge = (node: Element) => {
        const style = getComputedStyle(node);
        return {
          width: style.borderTopWidth,
          colour: style.borderTopColor,
          accent: style.boxShadow.includes("inset"),
        };
      };
      const plainCard = document.createElement("div");
      plainCard.className = "prio-card";
      document.body.append(plainCard);
      const plain = getComputedStyle(plainCard).borderTopColor;
      plainCard.remove();
      return {
        plain,
        active: Array.from(
          document.querySelectorAll(
            '.prio-sprints .prio-sprint[data-status="ACTIVE"]',
          ),
        ).map(edge),
        upcoming: Array.from(
          document.querySelectorAll(".prio-sprints__upcoming > .prio-card"),
        ).map(edge),
        completed: Array.from(
          document.querySelectorAll(
            '.prio-sprints .prio-sprint[data-status="COMPLETED"]',
          ),
        ).map(edge),
      };
    });

    /* The running sprint: its own edge and accent bar, as always. */
    expect(seen.active).toHaveLength(1);
    expect(seen.active[0]!.accent).toBe(true);
    expect(seen.active[0]!.colour).not.toBe(seen.plain);

    /* Upcoming: no visible border — and the same box, so nothing moved. */
    expect(seen.upcoming).toHaveLength(2);
    for (const card of seen.upcoming) {
      expect(card.colour).toBe("rgba(0, 0, 0, 0)");
      expect(card.width).toBe("1px");
    }

    /* Completed: the ordinary card border, untouched. */
    expect(seen.completed.length).toBeGreaterThan(0);
    for (const card of seen.completed) {
      expect(card.colour).toBe(seen.plain);
    }
  });

  test("cause no horizontal overflow on a phone", async ({ page }) => {
    const url = await seed("ACTIVE");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(url);
    await openBurndown(page);
    await page.locator(".prio-burndown").waitFor({ timeout: 45_000 });
    expect((await blocks(page)).overflow).toBeLessThanOrEqual(0);
  });
});
