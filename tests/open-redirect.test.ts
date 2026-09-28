import { describe, expect, it } from "vitest";
import { isSafeLocalPath, safeLocalPath } from "@/lib/safePath";
import { safeUrl } from "@/lib/richtext";

/**
 * The sign-in `next` parameter and links in comments must never leave Prio.
 *
 * "Starts with / but not //" was the old test, and it lets `/\host` through:
 * browsers read a backslash as a slash in the authority position and strip tabs
 * and newlines from anywhere in a URL, so those spellings become `//host`.
 */

const SAFE = [
  "/",
  "/issues",
  "/issues/ENG-1",
  "/projects/eng/board?status=TODO&priority=P0",
  "/issues?priority=P0&priority=P1#top",
  "/a/b%2Fc",
  "/%09/not-a-tab", // percent-encoded, stays a path on this origin
];

const UNSAFE = [
  "//evil.example",
  "//evil.example/path",
  "/\\evil.example",
  "/\\/evil.example",
  "\\\\evil.example",
  "/\t/evil.example",
  "/\n/evil.example",
  "/\r/evil.example",
  "/ /evil.example",
  "/\u0000/evil.example",
  "http://evil.example",
  "https://evil.example/x",
  "javascript:alert(1)",
  "data:text/html,<script>alert(1)</script>",
  "evil.example",
  "issues",
  "",
  "  /issues",
];

describe("safeLocalPath", () => {
  for (const value of SAFE) {
    it(`keeps ${JSON.stringify(value)}`, () => {
      expect(isSafeLocalPath(value)).toBe(true);
      expect(safeLocalPath(value)).toBe(value);
    });
  }

  for (const value of UNSAFE) {
    it(`refuses ${JSON.stringify(value)}`, () => {
      expect(isSafeLocalPath(value)).toBe(false);
      expect(safeLocalPath(value)).toBe("/");
    });
  }

  it("falls back for anything that is not a string", () => {
    for (const value of [undefined, null, 42, {}, []]) {
      expect(safeLocalPath(value)).toBe("/");
    }
    expect(safeLocalPath(undefined, "/home")).toBe("/home");
  });

  it("never returns something that resolves off-site", () => {
    for (const value of [...SAFE, ...UNSAFE]) {
      const result = safeLocalPath(value);
      expect(new URL(result, "http://prio.invalid").origin).toBe("http://prio.invalid");
    }
  });
});

describe("links inside comments", () => {
  it("still allows in-app paths, http(s) and mailto", () => {
    expect(safeUrl("/issues/ENG-1")).toBe("/issues/ENG-1");
    expect(safeUrl("https://example.com/a")).toBe("https://example.com/a");
    expect(safeUrl("mailto:someone@example.com")).toBe("mailto:someone@example.com");
  });

  it("refuses the backslash and protocol-relative spellings", () => {
    for (const value of ["//evil.example", "/\\evil.example", "/\\/evil.example"]) {
      expect(safeUrl(value), value).toBeNull();
    }
  });

  it("still refuses script-bearing schemes", () => {
    for (const value of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html,x", "vbscript:x"]) {
      expect(safeUrl(value), value).toBeNull();
    }
  });
});
