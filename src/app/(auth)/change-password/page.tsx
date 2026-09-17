import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { PRIO_TAGLINE, PrioLogo } from "@/components/brand/PrioLogo";
import { getCurrentUser, needsPasswordChange } from "@/lib/session";
import { ChangePasswordForm } from "./ChangePasswordForm";

export const metadata: Metadata = {
  title: "Choose a password",
};

export const dynamic = "force-dynamic";

/**
 * The screen an administrator-created account meets before anything else.
 *
 * It sits in the `(auth)` group rather than under the application shell, and
 * that placement is the whole design: the shell is what redirects here, so a
 * page inside it would redirect to itself forever. Here there is no shell, no
 * sidebar and nothing to navigate to — the only ways out are finishing the
 * form or signing out.
 *
 * Two redirects guard it, and neither trusts the browser:
 *
 *   - no session at all → sign in, with this page as the destination;
 *   - a session that does *not* owe a password change → the dashboard, so the
 *     page cannot be visited out of curiosity or left in a bookmark.
 *
 * The flag is read from the user row on every request, so the second check
 * answers correctly the moment the password is changed.
 */
export default async function ChangePasswordPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/sign-in?next=%2Fchange-password");

  if (!(await needsPasswordChange(user.id))) redirect("/");

  return (
    <main className="prio-auth">
      <aside className="prio-auth__brand">
        <PrioLogo variant="lockup" size="md" tone="dark" tagline={PRIO_TAGLINE} />

        <div>
          <h1 className="prio-auth__headline">One thing first.</h1>
          <p className="prio-auth__lede">
            Your account was created by an administrator, using a password they
            chose. Replace it with one only you know, and Prio will take you
            straight in.
          </p>
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

          <h2 className="prio-auth__title">Choose a password</h2>
          <p className="prio-auth__subtitle">
            Signed in as {user.email}. This is the last step.
          </p>

          <ChangePasswordForm />
        </div>
      </section>
    </main>
  );
}
