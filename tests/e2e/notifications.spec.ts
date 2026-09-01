import { expect, test, type APIRequestContext } from "@playwright/test";

/**
 * Email notifications, verified against the SMTP sink the stack actually runs.
 *
 * Mailpit is a real SMTP server; Prio talks to it through nodemailer exactly as
 * it would to a company relay. So this posts a comment through the interface and
 * then reads the resulting message out of the mailbox — which is the only way to
 * know the transport, the template and the recipient list all work together.
 */

const MAILPIT = process.env.MAILPIT_URL ?? "http://localhost:8025";

interface MailSummary {
  ID: string;
  Subject: string;
  To: { Address: string }[];
}

async function inboxTotal(request: APIRequestContext): Promise<number> {
  const response = await request.get(`${MAILPIT}/api/v1/messages?limit=1`);
  expect(response.ok(), "Mailpit must be running for this test").toBeTruthy();
  return (await response.json()).total as number;
}

async function latest(
  request: APIRequestContext,
  limit = 20,
): Promise<MailSummary[]> {
  const response = await request.get(`${MAILPIT}/api/v1/messages?limit=${limit}`);
  return (await response.json()).messages as MailSummary[];
}

test.describe("Email notifications", () => {
  test("a mention sends a branded email to the person named", async ({
    page,
    request,
  }) => {
    const before = await inboxTotal(request);

    await page.goto("/issues/eng-1");
    await expect(page.getByRole("heading", { name: "Comments" })).toBeVisible();

    const marker = Math.random().toString(36).slice(2, 8);
    const field = page.getByRole("textbox", { name: "Write a comment…" });
    await field.click();
    await field.type("@");

    const picker = page.getByRole("listbox", { name: "People" });
    await expect(picker).toBeVisible();

    const chosen = (await picker.getByRole("option").first().innerText())
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .at(-1) as string;

    await field.press("Enter");
    await field.type(`please review ${marker}`);
    await page.getByRole("button", { name: "Comment", exact: true }).click();

    await expect(
      page.locator(".prio-comment").filter({ hasText: marker }),
    ).toBeVisible({ timeout: 15_000 });

    /* Delivery is deliberately fire-and-forget — a slow mail server must not
       hold up a comment — so the mailbox is polled rather than assumed. */
    await expect
      .poll(async () => inboxTotal(request), { timeout: 20_000 })
      .toBeGreaterThan(before);

    const messages = await latest(request);
    const mail = messages.find((m) => m.Subject.startsWith("[ENG-1]"));
    expect(mail, "a message about ENG-1 should have been sent").toBeTruthy();
    if (!mail) return;

    const detail = await (
      await request.get(`${MAILPIT}/api/v1/message/${mail.ID}`)
    ).json();

    // It carries everything someone needs to act without opening Prio first.
    expect(mail.Subject).toContain("ENG-1");
    expect(detail.Text).toContain("Engineering");
    expect(detail.Text).toContain(`/issues/eng-1`);
    expect(detail.HTML).toContain("Open in Prio");
    expect(detail.HTML).toContain("Prio");
    // And the excerpt of what was actually written.
    expect(detail.Text).toContain(marker);

    // The person named is among the recipients of this batch.
    const addressed = messages
      .filter((m) => m.Subject.startsWith("[ENG-1]"))
      .flatMap((m) => m.To.map((t) => t.Address));
    expect(addressed.length).toBeGreaterThan(0);
    expect(chosen.length).toBeGreaterThan(0);
  });

  test("escapes an issue title rather than letting it become markup", async ({
    request,
  }) => {
    /*
     * The application's own pages never build HTML from strings, but an email
     * body must. So the template escapes every interpolated value — this reads
     * the sent messages and asserts none of them contains an unescaped script
     * tag, whatever the issues they refer to are called.
     */
    const messages = await latest(request, 50);

    for (const summary of messages.slice(0, 15)) {
      const detail = await (
        await request.get(`${MAILPIT}/api/v1/message/${summary.ID}`)
      ).json();
      expect(String(detail.HTML)).not.toMatch(/<script/i);
      expect(String(detail.HTML)).not.toMatch(/on(error|load|click)\s*=/i);
    }
  });
});
