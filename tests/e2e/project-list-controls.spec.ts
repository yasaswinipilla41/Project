import { expect, test } from "@playwright/test";
import { prisma } from "@/lib/prisma";

/**
 * A project's List tab, with the controls the global list has.
 *
 * The two surfaces render the same table from the same query, and one of them
 * had a column chooser and an Import button while the other did not — so a
 * person who hid Reporter on `/issues` met it again the moment they opened a
 * project's own list.
 *
 * The export was worse than missing: it was wrong. The project lives in the
 * route rather than the query string, and the button sent only the address
 * bar, so "Export Excel" on the Engineering tab produced a workbook of every
 * project the reader could see. Nothing was disclosed that they could not
 * already open — the scope is the session's either way — but the file did not
 * match the table above it, which is its own kind of wrong.
 */

async function aProject() {
  return prisma.project.findFirstOrThrow({
    where: { isArchived: false, issues: { some: {} } },
    select: { id: true, key: true, name: true },
    orderBy: { key: "asc" },
  });
}

test.describe("the controls the global list has", () => {
  test("offers Columns and Import, like /issues does", async ({ page }) => {
    const project = await aProject();
    await page.goto(`/projects/${project.key.toLowerCase()}/list`);

    await expect(page.getByRole("button", { name: /^Columns/ })).toBeVisible();
    await expect(page.getByRole("button", { name: "Import" })).toBeVisible();
  });

  test("hides a column here after it was hidden on the global list", async ({
    page,
  }) => {
    /* One preference, one cookie, both surfaces — rather than each list
       remembering its own answer to the same question. */
    const project = await aProject();

    await page.goto("/issues");
    await page.getByRole("button", { name: /^Columns/ }).click();
    await page
      .getByRole("menuitemradio", { name: "Reporter" })
      .click();
    await expect(
      page.getByRole("columnheader", { name: "Reporter" }),
    ).toHaveCount(0);

    await page.goto(`/projects/${project.key.toLowerCase()}/list`);
    await expect(
      page.getByRole("columnheader", { name: "Reporter" }),
    ).toHaveCount(0);

    /* Put it back, so the next test in this file starts where it expects. */
    await page.getByRole("button", { name: /^Columns/ }).click();
    await page.getByRole("menuitemradio", { name: "Reporter" }).click();
    await expect(
      page.getByRole("columnheader", { name: "Reporter" }),
    ).toBeVisible();
  });

  test("the import dialog says which project it will file into", async ({
    page,
  }) => {
    const project = await aProject();
    await page.goto(`/projects/${project.key.toLowerCase()}/list`);
    await page.getByRole("button", { name: "Import" }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(project.key);
  });
});

test.describe("export from a project's list", () => {
  test("exports that project, not every project", async ({ page }) => {
    const project = await aProject();
    await page.goto(`/projects/${project.key.toLowerCase()}/list`);

    /* The figure on screen, which is what the file is supposed to match. */
    const shown = Number(
      (
        await page.locator(".prio-filters__total").innerText()
      ).replace(/\D+/g, ""),
    );
    expect(shown).toBeGreaterThan(0);

    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: "Export Excel" }).click(),
    ]);
    /*
     * Named after the project it came from.
     *
     * This used to expect `prio-issues-…` from every surface, which told
     * somebody who had exported three projects on the same day nothing about
     * which file was which. The name is derived from the project's own name,
     * so it is asserted against that name rather than against a literal.
     */
    const slug = project.name
      .normalize("NFKD")
      .replace(/[^a-zA-Z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase();
    expect(download.suggestedFilename()).toBe(
      `${slug}-issues-${new Date().toISOString().slice(0, 10)}.xlsx`,
    );

    /* The header the route sets, read from the response rather than by
       opening the workbook: it says how many rows went into the file. */
    const response = await page.request.get(
      `/api/issues/export?project=${project.id}`,
    );
    expect(response.headers()["x-prio-export-rows"]).toBe(String(shown));
  });

  test("offers CSV and HTML beside Excel", async ({ page }) => {
    const project = await aProject();
    await page.goto(`/projects/${project.key.toLowerCase()}/list`);

    await page.getByRole("button", { name: "Choose an export format" }).click();
    const menu = page.getByRole("menu").first();
    await expect(menu.getByText("CSV (.csv)")).toBeVisible();
    await expect(menu.getByText("HTML (.html)")).toBeVisible();

    const [download] = await Promise.all([
      page.waitForEvent("download"),
      menu.getByText("CSV (.csv)").click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/\.csv$/);
  });
});

test.describe("what the formats actually contain", () => {
  test("CSV is a real CSV, scoped to the project asked for", async ({ page }) => {
    const project = await aProject();
    const response = await page.request.get(
      `/api/issues/export?format=csv&project=${project.id}`,
    );

    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("text/csv");

    const body = await response.text();
    expect(body.charCodeAt(0)).toBe(0xfeff); // The BOM Excel needs.
    const [header, ...rows] = body.replace("﻿", "").trim().split("\r\n");
    expect(header).toContain("Key");
    expect(header).toContain("Project key");
    expect(rows.length).toBeGreaterThan(0);

    /* Every row belongs to the project that was asked for. */
    const keyColumn = header!.split(",").indexOf("Key");
    for (const row of rows.slice(0, 20)) {
      expect(row.split(",")[keyColumn]).toContain(project.key);
    }
  });

  test("HTML is a whole document with a table in it", async ({ page }) => {
    const project = await aProject();
    const response = await page.request.get(
      `/api/issues/export?format=html&project=${project.id}`,
    );

    expect(response.headers()["content-type"]).toContain("text/html");
    const body = await response.text();
    expect(body.startsWith("<!doctype html>")).toBe(true);
    expect(body).toContain("<th scope=\"col\">Key</th>");
    expect(body).toContain("<tbody>");
  });

  test("an unknown format is a spreadsheet rather than an error", async ({
    page,
  }) => {
    /* Unrecognised values are dropped rather than trusted, here as everywhere
       else a parameter is read. */
    const response = await page.request.get("/api/issues/export?format=exe");
    expect(response.headers()["content-type"]).toContain("spreadsheetml");
  });
});
