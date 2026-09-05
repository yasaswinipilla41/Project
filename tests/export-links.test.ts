import { afterEach, describe, expect, it } from "vitest";
import { PUBLIC_BASE_URL_FALLBACK, publicBaseUrl } from "@/lib/env";

/**
 * Where an exported link points.
 *
 * A spreadsheet outlives the request that made it. `BASE_URL` defaults to
 * `http://localhost:3000` so a developer can run Prio without configuring
 * anything, and that default leaking into an export produces a file of links
 * that open nothing on the reader's machine — days later, on somebody else's
 * laptop, with no clue why.
 *
 * So the rule these pin is: localhost only ever appears because somebody
 * configured it. Absent configuration the answer is the production host, never
 * the loopback default.
 */

const KEYS = ["NEXT_PUBLIC_APP_URL", "APP_BASE_URL", "BASE_URL"] as const;

const original = Object.fromEntries(
  KEYS.map((key) => [key, process.env[key]]),
) as Record<(typeof KEYS)[number], string | undefined>;

afterEach(() => {
  for (const key of KEYS) {
    if (original[key] === undefined) delete process.env[key];
    else process.env[key] = original[key];
  }
});

function only(set: Partial<Record<(typeof KEYS)[number], string>>) {
  for (const key of KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(set)) process.env[key] = value;
}

describe("The public base URL used by exports", () => {
  it("prefers NEXT_PUBLIC_APP_URL", () => {
    only({
      NEXT_PUBLIC_APP_URL: "https://prio.symbiosystech.in",
      APP_BASE_URL: "https://second.example",
      BASE_URL: "http://localhost:3000",
    });
    expect(publicBaseUrl()).toBe("https://prio.symbiosystech.in");
  });

  it("falls back to APP_BASE_URL", () => {
    only({
      APP_BASE_URL: "https://prio.symbiosystech.in",
      BASE_URL: "http://localhost:3000",
    });
    expect(publicBaseUrl()).toBe("https://prio.symbiosystech.in");
  });

  it("then to BASE_URL, which is how development keeps working", () => {
    /* A developer who has set `BASE_URL` to their own machine means it — the
       export should point where their server actually is. */
    only({ BASE_URL: "http://localhost:3000" });
    expect(publicBaseUrl()).toBe("http://localhost:3000");
  });

  it("uses the production host when nothing is configured", () => {
    only({});
    expect(publicBaseUrl()).toBe(PUBLIC_BASE_URL_FALLBACK);
    expect(publicBaseUrl()).toBe("https://prio.symbiosystech.in");
  });

  it("never falls back to localhost", () => {
    /* The whole point. `getEnv().BASE_URL` would answer `http://localhost:3000`
       here, because the schema default fills it in — which is exactly why this
       reads `process.env` instead. */
    only({});
    expect(publicBaseUrl()).not.toContain("localhost");
    expect(publicBaseUrl()).not.toContain("0.0.0.0");
    expect(publicBaseUrl()).not.toContain("127.0.0.1");
  });

  it("ignores blank configuration rather than building a link from it", () => {
    only({ NEXT_PUBLIC_APP_URL: "   ", APP_BASE_URL: "" });
    expect(publicBaseUrl()).toBe(PUBLIC_BASE_URL_FALLBACK);
  });

  it("strips trailing slashes so a URL is never doubled", () => {
    only({ NEXT_PUBLIC_APP_URL: "https://prio.symbiosystech.in///" });
    expect(publicBaseUrl()).toBe("https://prio.symbiosystech.in");
    expect(`${publicBaseUrl()}/api/attachments/abc`).toBe(
      "https://prio.symbiosystech.in/api/attachments/abc",
    );
  });

  it("builds the attachment URL shape the export writes", () => {
    only({ NEXT_PUBLIC_APP_URL: "https://prio.symbiosystech.in" });
    const url = `${publicBaseUrl()}/api/attachments/cabc123`;

    expect(url).toBe("https://prio.symbiosystech.in/api/attachments/cabc123");
    // The endpoint itself is unchanged — same route, same authorization.
    expect(url).toContain("/api/attachments/");
    expect(url).not.toContain("localhost:3000");
  });
});
