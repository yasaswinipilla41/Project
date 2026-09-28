"use client";

import { PASSWORD_RULES } from "@/lib/passwordPolicy";

/**
 * What a new password must contain, shown while somebody types one.
 *
 * A hint, never a gate: it renders `PASSWORD_RULES`, the same list the server
 * validates against, and ticking a line here decides nothing — a password that
 * looks complete in the form is still checked again on the server, and one that
 * is not is refused there whatever this component says.
 *
 * `aria-live` is polite so a screen reader hears a rule become met without
 * being interrupted mid-word, and each line carries its state as text as well
 * as a symbol, so it never depends on a colour or a glyph.
 */
export function PasswordRequirements({
  password,
  id,
}: {
  password: string;
  id?: string;
}) {
  return (
    <div className="prio-pwreq" id={id}>
      <span className="prio-pwreq__title">Password must contain:</span>
      <ul className="prio-pwreq__list" aria-live="polite">
        {PASSWORD_RULES.map((rule) => {
          const met = rule.test(password);
          return (
            <li key={rule.id} className="prio-pwreq__item" data-met={met || undefined}>
              <span className="prio-pwreq__mark" aria-hidden>
                {met ? "✓" : "○"}
              </span>
              {rule.label}
              <span className="prio-visually-hidden">
                {met ? " (met)" : " (not met)"}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
