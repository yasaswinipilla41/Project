/**
 * Is this a path *inside* Prio — safe to redirect or link to without leaving?
 *
 * The obvious test, "starts with `/` but not `//`", is not enough. Browsers
 * treat a backslash as a slash in a URL's authority position, and strip tabs and
 * newlines from anywhere in one, so `/\evil.example` and `/<TAB>/evil.example`
 * both slip past it and are then read as `//evil.example` — another site.
 *
 * So the rule is stricter and stated positively: a single leading `/`, then
 * something that is not another `/` or a `\`, with no whitespace, control
 * character or backslash anywhere. As a second, independent check the value is
 * resolved against a throwaway origin and must still land on that origin — the
 * browser's own parser has the last word rather than this regex.
 */
export function isSafeLocalPath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  if (!/^\/(?![/\\])/.test(value)) return false;
  if (/[\u0000- \u007f\\]/.test(value)) return false;
  try {
    const probe = "http://prio.invalid";
    return new URL(value, probe).origin === probe;
  } catch {
    return false;
  }
}

/** `value` if it is a safe local path, otherwise `fallback`. */
export function safeLocalPath(value: unknown, fallback = "/"): string {
  return isSafeLocalPath(value) ? value : fallback;
}
