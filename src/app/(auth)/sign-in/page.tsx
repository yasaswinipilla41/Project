import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { PRIO_TAGLINE, PrioLogo } from "@/components/brand/PrioLogo";
import { IconActivity, IconBoard, IconBug } from "@/components/ui/Icon";
import { getCurrentUser } from "@/lib/session";
import { SignInForm } from "./SignInForm";

export const metadata: Metadata = {
  title: "Sign in",
};

/** Only same-origin paths are accepted, so `next` cannot be used as an open redirect. */
function safeNext(value: string | undefined): string {
  if (!value) return "/";
  if (!value.startsWith("/") || value.startsWith("//")) return "/";
  return value;
}

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; email?: string }>;
}) {
  const user = await getCurrentUser();
  const { next, email } = await searchParams;
  const target = safeNext(next);

  if (user) redirect(target);

  return (
    <main className="prio-auth">
      <aside className="prio-auth__brand">
        <PrioLogo variant="lockup" size="md" tone="dark" tagline={PRIO_TAGLINE} />

        <div>
          <h1 className="prio-auth__headline">
            Track. Prioritize. Deliver.
          </h1>
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

          <h2 className="prio-auth__title">Sign in</h2>
          <p className="prio-auth__subtitle">
            Use your Prio account to continue.
          </p>

          <SignInForm next={target} initialEmail={email ?? ""} />
        </div>
      </section>
    </main>
  );
}
