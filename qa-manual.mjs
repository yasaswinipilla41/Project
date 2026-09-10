import { chromium } from "@playwright/test";

const BASE = "http://localhost:3000";
const SHOTS = process.env.SHOTS ?? ".";

async function signIn(page, email, password = "Prio@12345") {
  await page.context().clearCookies();
  await page.goto(`${BASE}/sign-in`);
  await page.fill("#email", email);
  await page.fill("#password", password);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL((u) => !u.pathname.includes("sign-in"), { timeout: 30000 });
}

async function pick(page, dialog, selector, text) {
  const input = dialog.locator(selector);
  await input.click();
  await input.fill(text);
  await page.waitForTimeout(500);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.on("pageerror", (e) => console.log("PAGE ERROR:", e.message));

/* ------------------------------------------------------------- ADMIN */
await signIn(page, "admin@symbiosystech.com");
await page.waitForTimeout(1200);

const card = page.locator(".prio-workstatus").first();
const before = (await card.innerText()).replace(/\n/g, " | ");
console.log("BEFORE:", before);

// --- Assign Work to QA, end to end
await page.getByRole("button", { name: /Assign Work to QA/ }).click();
let dialog = page.getByRole("dialog");
await dialog.waitFor();
await pick(page, dialog, "#workstatus-project", "Website");
await page.waitForTimeout(1500);
await pick(page, dialog, "#workstatus-issue", "WEB-53");
await pick(page, dialog, "#workstatus-person", "Sneha");
await page.screenshot({ path: `${SHOTS}/04-qa-ready.png` });
await dialog.getByRole("button", { name: "Assign", exact: true }).click();
await page.waitForTimeout(3000);

const afterQa = (await card.innerText()).replace(/\n/g, " | ");
console.log("AFTER QA ASSIGNMENT:", afterQa);
await page.screenshot({ path: `${SHOTS}/05-after-qa-assign.png` });

// --- Assign Work to Developer: all three statuses must be offered
await page.getByRole("button", { name: /Assign Work to Developer/ }).click();
dialog = page.getByRole("dialog");
await dialog.waitFor();
await pick(page, dialog, "#workstatus-project", "Website");
await page.waitForTimeout(1500);

const issueInput = dialog.locator("#workstatus-issue");
await issueInput.click();
await page.waitForTimeout(400);
console.log(
  "DEV LANE ISSUES IN WEB:",
  JSON.stringify(await dialog.locator("[role='option']").allInnerTexts()),
);
await page.screenshot({ path: `${SHOTS}/06-dev-issues.png` });

await issueInput.fill("WEB-3 ");
await page.waitForTimeout(400);
await issueInput.fill("WEB-3");
await page.waitForTimeout(400);
await page.keyboard.press("Enter");
await page.waitForTimeout(300);

const personInput = dialog.locator("#workstatus-person");
await personInput.click();
await page.waitForTimeout(400);
console.log(
  "DEV LANE PEOPLE IN WEB:",
  JSON.stringify(await dialog.locator("[role='option']").allInnerTexts()),
);
await personInput.fill("Kiran");
await page.waitForTimeout(400);
await page.keyboard.press("Enter");
await page.waitForTimeout(300);
await dialog.getByRole("button", { name: "Assign", exact: true }).click();
await page.waitForTimeout(3000);
console.log("AFTER DEV ASSIGNMENT:", (await card.innerText()).replace(/\n/g, " | "));
await page.screenshot({ path: `${SHOTS}/07-after-dev-assign.png` });

await browser.close();
