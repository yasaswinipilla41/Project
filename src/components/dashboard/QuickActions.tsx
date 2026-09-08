"use client";

import type { WorkRole } from "@/lib/domain";
import { ButtonLink } from "@/components/ui/primitives";
import { IconCheck, IconProjects, IconUsers } from "@/components/ui/Icon";

/**
 * Dashboard quick actions.
 *
 * Create issue and Report bug used to lead this row. They were removed from
 * Home on purpose — creating work is not what someone comes to a dashboard to
 * do, and both flows are still reachable everywhere they belong (the top bar's
 * create control, the Issues page, Report bug on a project). Nothing about the
 * underlying create actions or dialogs changed; this row simply stopped
 * offering them.
 *
 * What remains is gated by the account's real role. That is presentation only
 * — the server still authorizes every one of these routes on its own. Hiding a
 * link is a courtesy, never the control.
 */
export function QuickActions({
  role,
  userId,
}: {
  role: WorkRole;
  /** The signed-in person, so their queue link is theirs. */
  userId: string;
}) {
  return (
    <div className="prio-dash__actions">
      {role === "ADMIN" ? (
        <>
          <ButtonLink href="/projects" variant="ghost">
            <IconProjects size={14} />
            Projects
          </ButtonLink>
          <ButtonLink href="/admin" variant="ghost">
            <IconUsers size={14} />
            People
          </ButtonLink>
        </>
      ) : (
        <>
          <ButtonLink href="/my-work" variant="ghost">
            My work
          </ButtonLink>
          {/* A tester's queue: what has been handed to *them* for checking.
              Offered to a full stack developer as well, who does the QA half
              of the job. The link carries the reader's own assignee so it
              opens the same rows the dashboard tile counted. */}
          {role === "QA" || role === "FULLSTACK" ? (
            <ButtonLink
              href={`/issues?assignee=${userId}&status=IN_REVIEW`}
              variant="ghost"
            >
              <IconCheck size={14} />
              Ready for QA
            </ButtonLink>
          ) : null}
        </>
      )}
    </div>
  );
}
