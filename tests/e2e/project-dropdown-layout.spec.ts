import { expect, test, type Page } from "@playwright/test";
import { prisma } from "@/lib/prisma";
import { MEMBER_EMAIL, MEMBER_STATE } from "./support";

/**
 * A project's name and its key, in the dropdowns that list projects.
 *
 * Both dropdowns — the Flow Board's "Project" filter and the topbar's project
 * switcher — are rows of `MenuItem`, which is where the fix is: the name used
 * to be sized to the room that was left but painted outside it, so a long
 * project name ran straight over the key beside it and past the menu's edge.
 *
 * What this checks is the property, not the styling: the name's box and the
 * key's box never intersect, the key is never squeezed, both stay inside the
 * menu, and the name is the one that gives way. Driven at several widths and
 * for both an administrator and a member, because the rows are the same
 * component for every role and the fix had to be made once.
 */

const LONG_NAME = "Symbiosys Internal Platform Modernisation Programme";
/*
 * Ten characters, which is the longest key the create form allows — the worst
 * case the row has to hold — and unique to this run. A fixed key would be a
 * fixture that collides with whatever a real project happens to be called:
 * "SYMBIOCOPY" is a key somebody's own project had, and this spec refused to
 * start because of it.
 */
const LONG_KEY = `QQ${Date.now().toString(36).toUpperCase()}`.slice(0, 10);

const created: string[] = [];

test.beforeAll(async () => {
  const [admin, member] = await Promise.all([
    prisma.user.findFirstOrThrow({
      where: { role: "ADMIN" },
      select: { id: true },
    }),
    prisma.user.findUniqueOrThrow({
      where: { email: MEMBER_EMAIL },
      select: { id: true },
    }),
  ]);

  /* A name far longer than the menu is wide, against a key at its full
     length. */
  const project = await prisma.project.create({
    data: {
      key: LONG_KEY,
      name: LONG_NAME,
      createdById: admin.id,
      members: { create: [{ userId: admin.id }, { userId: member.id }] },
    },
    select: { id: true },
  });
  created.push(project.id);
});

test.afterAll(async () => {
  for (const id of created) {
    await prisma.projectMember.deleteMany({ where: { projectId: id } });
    await prisma.project.deleteMany({ where: { id } });
  }
});

/**
 * Every row of the open menu, measured: where the name sits, where the note
 * at the end of it sits, and where the menu's own edges are.
 */
async function rows(page: Page) {
  return page.evaluate(() => {
    const panel = document.querySelector(".prio-menu")!;
    const box = panel.getBoundingClientRect();
    return Array.from(panel.querySelectorAll(".prio-menu__item"))
      .map((item) => {
        const label = item.querySelector(".prio-menu__itemlabel");
        const trail = item.querySelector(".prio-menu__itemtrail");
        if (!label || !trail) return null;
        const l = label.getBoundingClientRect();
        const t = trail.getBoundingClientRect();
        return {
          name: label.textContent ?? "",
          key: trail.textContent ?? "",
          /* Positive means the two boxes run into one another. */
          intersect: Math.round(l.right - t.left),
          /* Positive means something reached outside the menu. */
          spill: Math.round(
            Math.max(0, l.right - box.right, t.right - box.right),
          ),
          /* Whether the key is being squeezed: its own content against the
             room it has, both as the integers the browser reports, so this
             cannot turn a fraction of a pixel into a failure. */
          keySqueezed:
            (trail as HTMLElement).scrollWidth -
            (trail as HTMLElement).clientWidth,
          /* How much longer the name is than the room it has. Positive is
             the interesting case: that text has to go somewhere, and before
             the fix it went over the key. */
          nameOverruns: Math.round(label.scrollWidth - label.clientWidth),
          /* Which is only harmless if the box clips it. */
          clipsOverrun: getComputedStyle(label).overflow === "hidden",
          clipped: getComputedStyle(label).textOverflow,
        };
      })
      .filter((row): row is NonNullable<typeof row> => row !== null);
  });
}

async function check(page: Page, where: string) {
  const seen = await rows(page);
  expect(seen.length, `${where}: no project rows`).toBeGreaterThan(0);

  const long = seen.find((row) => row.key.trim() === LONG_KEY);
  expect(long, `${where}: the long-named project is missing`).toBeTruthy();

  for (const row of seen) {
    const what = `${where}: "${row.name}" / "${row.key}"`;
    /* The two boxes never touch — the gap between them is the row's own. */
    expect(row.intersect, `${what} overlap`).toBeLessThan(0);
    /* Neither escapes the menu. */
    expect(row.spill, `${what} outside the menu`).toBe(0);
    /* The key reads in full; it is the name that gives way. */
    expect(row.keySqueezed, `${what} key squeezed`).toBeLessThanOrEqual(0);
    /*
     * And a name too long for its room stays inside it.
     *
     * This is the half of "no overlap" that boxes alone cannot show: the
     * boxes never intersected even before the fix, because the name's box
     * was sized correctly all along — it was the text inside it that painted
     * across the key. So what has to hold is that any overrun is clipped to
     * the box, with the ellipsis that says the name goes on.
     */
    if (row.nameOverruns > 0) {
      expect(row.clipsOverrun, `${what} name paints outside its box`).toBe(
        true,
      );
      expect(row.clipped, `${what} name not truncated`).toBe("ellipsis");
    }
  }
}

/** The Flow Board's project filter, and the topbar's switcher. */
async function openBoth(page: Page, width: number) {
  await page.setViewportSize({ width, height: 900 });

  await page.goto("/board");
  const filter = page.getByRole("button", { name: "Project", exact: true });
  await filter.waitFor({ timeout: 45_000 });
  await filter.click();
  await page.locator(".prio-menu").waitFor();
  await check(page, `board menu @ ${width}px`);
  await page.keyboard.press("Escape");

  const switcher = page.locator(".prio-topbar__project-select");
  if (await switcher.isVisible()) {
    await switcher.click();
    await page.locator(".prio-menu").waitFor();
    await check(page, `topbar menu @ ${width}px`);
    await page.keyboard.press("Escape");
  }
}

test.describe("The project dropdowns", () => {
  test("keep a long project name clear of its key, as an administrator", async ({
    page,
  }) => {
    for (const width of [1440, 1024, 768]) await openBoth(page, width);
  });

  test.describe("as a member of the project", () => {
    test.use({ storageState: MEMBER_STATE });

    test("keep the same rows readable", async ({ page }) => {
      /* The same component renders the rows for every role, so a member sees
         the same layout — which is the point of fixing it in one place. */
      for (const width of [1440, 768]) await openBoth(page, width);
    });
  });
});
