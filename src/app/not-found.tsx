import Link from "next/link";
import { PRIO_TAGLINE, PrioLogo } from "@/components/brand/PrioLogo";
import { ButtonLink } from "@/components/ui/primitives";

export default function NotFound() {
  return (
    <main className="prio-notfound">
      <PrioLogo variant="lockup" size="md" tagline={PRIO_TAGLINE} />

      <h1 className="prio-notfound__code">404</h1>
      <p className="prio-notfound__title">We could not find that page</p>
      <p className="prio-notfound__body">
        The issue or project may have been removed, or you may not have access
        to it. If you followed an issue key, check that it is spelled correctly —
        for example <span className="prio-key">ENG-1</span>.
      </p>

      <div className="prio-notfound__actions">
        <ButtonLink href="/" variant="brand">
          Back to Home
        </ButtonLink>
        <Link href="/projects" className="prio-btn prio-btn--secondary">
          Browse projects
        </Link>
      </div>
    </main>
  );
}
