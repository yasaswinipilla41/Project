import { expect, test, type Page } from "@playwright/test";
import { prisma } from "@/lib/prisma";

/**
 * The Iteration filter shows each sprint in full.
 *
 * Every row in it is a sprint's name *and* its start and end dates with their
 * years, and the panel used to be the filters' shared 230px with one-line,
 * ellipsised rows — so every sprint was cut off mid-date, and a completed
 * sprint's green check was clipped away with the end of its name. A long
 * enough list also put its scrollbar over the ends of the rows.
 *
 * What has to hold, with a list long enough to scroll and a name longer than
 * the panel can hold on one line: no row is truncated, no painted text runs
 * under the scrollbar or past the panel, nothing scrolls sideways, the
 * completed check is visible, the panel stays on screen, and choosing a
 * sprint still filters by it. The other filters keep their width.
 */

const createdProjects: string[] = [];
const DAY = 86_400_000;

test.afterAll(async () => {
  for (const id of createdProjects) {
    await prisma.sprint.deleteMany({ where: { projectId: id } });
    await prisma.project.deleteMany({ where: { id } });
  }
});

async function seedManySprints() {
  const admin = await prisma.user.findFirstOrThrow({
    where: { role: "ADMIN" },
    select: { id: true },
  });
  const key = `IT${Date.now().toString(36).toUpperCase()}`.slice(0, 10);
  const project = await prisma.project.create({
    data: {
      key,
      name: `Iteration filter fixture ${key}`,
      createdById: admin.id,
      members: { create: { userId: admin.id } },
    },
    select: { id: true, key: true },
  });
  createdProjects.push(project.id);

  const names = [
    /* Longer than the panel's widest measure on one line. */
    "Payments reconciliation and ledger export hardening sprint",
    ...Array.from({ length: 13 }, (_, index) => `sprint ${index + 1}`),
  ];
  const sprints = [];
  for (const [index, name] of names.entries()) {
    sprints.push(
      await prisma.sprint.create({
        data: {
          name,
          startDate: new Date(Date.now() + (index * 14 - 60) * DAY),
          endDate: new Date(Date.now() + (index * 14 - 47) * DAY),
          projectId: project.id,
          createdById: admin.id,
          /* One closed, so it carries the check; the next one running, so it
             carries the current-sprint mark; the rest upcoming. */
          status:
            index === 1 ? "COMPLETED" : index === 2 ? "ACTIVE" : "PLANNED",
        },
        select: { id: true, name: true },
      }),
    );
  }
  return { key: project.key.toLowerCase(), sprints };
}

/** Every row of the open Iteration panel, measured as it is painted. */
const measure = (page: Page) =>
  page.getByRole("menu", { name: "Iteration" }).evaluate((node) => {
    const panel = node.getBoundingClientRect();
    /* The right edge of the panel's content box: left of the scrollbar. */
    const contentRight = panel.left + node.clientLeft + node.clientWidth;
    const rows = Array.from(
      node.querySelectorAll<HTMLElement>(".prio-menu__itemlabel"),
    );
    const paintedRight = (row: HTMLElement) => {
      let right = -Infinity;
      const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
      const range = document.createRange();
      for (let text = walker.nextNode(); text; text = walker.nextNode()) {
        /* The screen-reader "(completed)" is off-canvas by design. */
        if (text.parentElement?.closest(".prio-visually-hidden")) continue;
        range.selectNodeContents(text);
        for (const rect of Array.from(range.getClientRects())) {
          right = Math.max(right, rect.right);
        }
      }
      return right;
    };
    const check = node.querySelector(".prio-filter__iteration-done");
    const checkBox = check?.getBoundingClientRect();
    return {
      rows: rows.map((row) => ({
        text: row.textContent!.trim(),
        truncated: row.scrollWidth > row.clientWidth + 1,
        /* Room left before the scrollbar (or the panel edge). */
        room: Math.round(contentRight - paintedRight(row)),
      })),
      scrollsDown: node.scrollHeight > node.clientHeight,
      scrollsSideways: node.scrollWidth > node.clientWidth,
      offScreen: Math.max(0, panel.right - innerWidth, -panel.left),
      check: checkBox
        ? {
            painted: checkBox.width > 0 && checkBox.height > 0,
            room: Math.round(contentRight - checkBox.right),
          }
        : null,
    };
  });

test.describe("The Iteration filter", () => {
  for (const [width, height] of [
    [1440, 600],
    [390, 640],
  ] as const) {
    test(`shows every sprint's name and dates in full at ${width}px`, async ({
      page,
    }) => {
      const { key, sprints } = await seedManySprints();
      await page.setViewportSize({ width, height });
      await page.goto(`/projects/${key}/list`);

      await page.getByRole("button", { name: /^Iteration/ }).click();
      const menu = page.getByRole("menu", { name: "Iteration" });
      await expect(menu).toBeVisible();

      for (const scrolled of ["top", "bottom"] as const) {
        await menu.evaluate(
          (node, to) => (node.scrollTop = to === "top" ? 0 : node.scrollHeight),
          scrolled,
        );
        const seen = await measure(page);
        const where = `${width}px, scrolled to ${scrolled}`;

        expect(seen.rows, where).toHaveLength(sprints.length);
        /* Long enough to scroll, or this proves nothing about the bar. */
        expect(seen.scrollsDown, `${where}: the list does not scroll`).toBe(
          true,
        );
        expect(seen.scrollsSideways, `${where}: scrolls sideways`).toBe(false);
        expect(seen.offScreen, `${where}: off the screen`).toBe(0);

        for (const row of seen.rows) {
          expect(row.truncated, `${where}: "${row.text}" is cut off`).toBe(
            false,
          );
          /* Clear of the scrollbar, with a little air before it. */
          expect(
            row.room,
            `${where}: "${row.text}" runs under the scrollbar`,
          ).toBeGreaterThanOrEqual(4);
          /* And the dates, with their years, are really there. */
          expect(row.text, where).toMatch(
            /\(\d{2} \w{3} \d{4} - \d{2} \w{3} \d{4}\)/,
          );
        }

        expect(seen.check, `${where}: no completed check`).not.toBeNull();
        expect(seen.check!.painted, `${where}: check not painted`).toBe(true);
        expect(
          seen.check!.room,
          `${where}: check under the scrollbar`,
        ).toBeGreaterThanOrEqual(4);
      }

      /* Choosing a sprint still filters by it. */
      await menu
        .getByRole("menuitemradio", {
          name: new RegExp(`^${sprints[3]!.name} \\(`),
        })
        .click();
      await expect(page).toHaveURL(new RegExp(`sprint=${sprints[3]!.id}`));
      await page.keyboard.press("Escape");

      /* The other filters keep the width they had. */
      await page.getByRole("button", { name: /^Status/ }).click();
      const status = page.getByRole("menu", { name: "Status" });
      await expect(status).toBeVisible();
      /* Its layout width: the bounding box would include the opening
         animation's scale, and read 229 or 230 depending on timing. */
      expect(
        await status.evaluate((node) => (node as HTMLElement).offsetWidth),
      ).toBe(230);
    });
  }
});

test.describe("The Iteration filter's current sprint", () => {
  test("is marked at the start of its name; completed and upcoming are as they were", async ({
    page,
  }) => {
    /*
     * The sprint being worked now carries a small dot before its name, read
     * from its real status. The completed sprint keeps its green check, after
     * its name, exactly as it was; the upcoming ones carry neither.
     */
    const { key, sprints } = await seedManySprints();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/projects/${key}/list`);
    await page.getByRole("button", { name: /^Iteration/ }).click();
    const menu = page.getByRole("menu", { name: "Iteration" });
    await expect(menu).toBeVisible();

    const rows = await menu.evaluate((node) =>
      Array.from(node.querySelectorAll(".prio-filter__iteration")).map(
        (row) => {
          const dot = row.querySelector(".prio-filter__iteration-active");
          const check = row.querySelector(".prio-filter__iteration-done");
          /* Where the visible name starts: its first painted text. */
          const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
          let nameLeft = Infinity;
          const range = document.createRange();
          for (let text = walker.nextNode(); text; text = walker.nextNode()) {
            if (text.parentElement?.closest(".prio-visually-hidden")) continue;
            if (!text.textContent?.trim()) continue;
            range.selectNodeContents(text);
            nameLeft = range.getBoundingClientRect().left;
            break;
          }
          const dotBox = dot?.getBoundingClientRect();
          return {
            text: row.textContent!.replace(/\s+/g, " ").trim(),
            dot: dotBox
              ? {
                  beforeName: dotBox.right <= nameLeft,
                  size: Math.round(dotBox.width),
                  colour: getComputedStyle(dot!).backgroundColor,
                }
              : null,
            check: check
              ? {
                  afterName: check.getBoundingClientRect().left > nameLeft,
                  stroke: check.getAttribute("stroke"),
                }
              : null,
          };
        },
      ),
    );

    const current = sprints[2]!.name;
    const completed = sprints[1]!.name;
    const marked = rows.filter((row) => row.dot);
    expect(marked, "exactly one sprint is marked current").toHaveLength(1);
    expect(marked[0]!.text).toContain(`${current} (`);
    expect(marked[0]!.dot!.beforeName, "the mark leads the name").toBe(true);
    expect(marked[0]!.dot!.size).toBeLessThanOrEqual(8);
    /* Said in words for a screen reader, not by the dot alone. */
    await expect(
      menu.getByRole("menuitemradio", { name: /^Current sprint: / }),
    ).toHaveCount(1);

    /* The completed sprint: its check, after its name, in its own green —
       and no current mark. */
    const done = rows.find((row) => row.text.startsWith(`${completed} (`))!;
    expect(done.dot).toBeNull();
    expect(done.check).toEqual({ afterName: true, stroke: "#10B981" });

    /* Upcoming sprints carry neither. */
    for (const row of rows) {
      if (row === done || row === marked[0]) continue;
      expect(row.dot, row.text).toBeNull();
      expect(row.check, row.text).toBeNull();
    }

    /* And in order: the active sprint at the top, the upcoming ones below
       it, the completed one at the bottom. */
    const groups = rows.map((row) => (row.dot ? 0 : row.check ? 2 : 1));
    expect(groups, "active, then upcoming, then completed").toEqual(
      [...groups].sort((a, b) => a - b),
    );
    expect(groups[0]).toBe(0);
    expect(groups[groups.length - 1]).toBe(2);

    /* Choosing the current sprint still filters by it. */
    await menu
      .getByRole("menuitemradio", { name: /^Current sprint: / })
      .click();
    await expect(page).toHaveURL(new RegExp(`sprint=${sprints[2]!.id}`));
  });
});
