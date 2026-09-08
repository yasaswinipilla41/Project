import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { PRIO_TAGLINE, PrioLogo } from "@/components/brand/PrioLogo";
import { IconActivity, IconBoard, IconBug } from "@/components/ui/Icon";
import { getCurrentUser } from "@/lib/session";
import { SignUpForm } from "./SignUpForm";

export const metadata: Metadata = {
  title: "Create account",
};

/**
 * Public registration.
 *
 * Mirrors `/sign-in`'s layout exactly — same brand panel, same form shell —
 * so arriving here from "Don't have an account?" does not feel like a
 * different product. The one structural difference is what happens after
 * submission: sign-in ends the request signed in, sign-up ends it back at
 * `/sign-in`, on purpose (see `SignUpForm`).
 */
export default async function SignUpPage() {
  const user = await getCurrentUser();
  if (user) redirect("/");

  return (
    <main className="prio-auth">
      <aside className="prio-auth__brand">
        <PrioLogo variant="lockup" size="md" tone="dark" tagline={PRIO_TAGLINE} />

        <div>
          <h1 className="prio-auth__headline">Track. Prioritize. Deliver.</h1>
          <p className="prio-auth__lede">
            One place for the projects, issues and bugs your team is working on
            — with the full history behind every change.
          </p>

          <ul className="prio-auth__points">
            <li className="prio-auth__point">
              <span className="prio-auth__point-icon">
                <IconBug />
              </span>
              <span>
                Bug reports that record where the problem was found, its
                environment and how soon it matters — not just a coloured label.
              </span>
            </li>
            <li className="prio-auth__point">
              <span className="prio-auth__point-icon">
                <IconBoard />
              </span>
              <span>
                Boards, lists and backlogs that move work from Backlog through
                to Done.
              </span>
            </li>
            <li className="prio-auth__point">
              <span className="prio-auth__point-icon">
                <IconActivity />
              </span>
              <span>
                An immutable activity trail on every issue, so nothing is lost.
              </span>
            </li>
          </ul>
        </div>

        <p className="prio-auth__footnote">
          Prio · Internal system for Symbiosys Technologies
        </p>
      </aside>

      <section className="prio-auth__panel">
        <div className="prio-auth__form">
          <div className="prio-auth__form-brand">
            <PrioLogo variant="lockup" size="md" tagline={PRIO_TAGLINE} />
          </div>

          <h2 className="prio-auth__title">Create account</h2>
          <p className="prio-auth__subtitle">
            Set up your own Prio account to get started.
          </p>

          <SignUpForm />
        </div>
      </section>
    </main>
  );
}
