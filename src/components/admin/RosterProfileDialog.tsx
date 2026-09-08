"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Avatar, Button } from "@/components/ui/primitives";
import { Dialog } from "@/components/ui/Dialog";
import { ISSUE_TYPE_LABEL, STATUS_LABEL, WORK_ROLE_LABEL } from "@/lib/domain";
import type { IssueStatus, IssueType } from "@prisma/client";
import { loadRosterProfile } from "@/server/roster";
import type { RosterProfile } from "@/server/roster";

/**
 * One roster member, and the work that is theirs.
 *
 * Opened from the profile icon beside a name in Administration. The teams block
 * already knows who somebody is, so this loads the two things it does not — the
 * projects they can open, and what is assigned to them — when it opens rather
 * than for every member of every team on page load.
 *
 * Each issue is a link into the ordinary issue page. It is the same route the
 * rest of Prio uses, with the same key, so this adds a way *to* the issue
 * detail and no second copy of it.
 */
export function RosterProfileDialog({
  personId,
  personName,
  onClose,
}: {
  personId: string;
  personName: string;
  onClose: () => void;
}) {
  const [profile, setProfile] = useState<RosterProfile | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    void loadRosterProfile(personId).then((result) => {
      if (cancelled) return;
      if (result.ok) setProfile(result.data);
      else setError(result.error);
    });

    return () => {
      cancelled = true;
    };
  }, [personId]);

  return (
    <Dialog
      open
      onClose={onClose}
      title={personName}
      description="What this person does, what they can open, and what is assigned to them."
      footer={
        <Button variant="ghost" onClick={onClose}>
          Done
        </Button>
      }
    >
      {error ? (
        <p className="prio-text-muted">{error}</p>
      ) : !profile ? (
        <p className="prio-text-muted">Loading…</p>
      ) : (
        <>
          <div className="prio-memberrow">
            <Avatar name={profile.name} image={profile.image} size="md" />
            <span className="prio-memberpicker__text">
              <span className="prio-memberpicker__name">{profile.name}</span>
              <span className="prio-memberpicker__meta">
                {profile.jobTitle ?? profile.email}
              </span>
            </span>
            <span className="prio-rolebadge" data-role={profile.workRole}>
              {WORK_ROLE_LABEL[profile.workRole]}
            </span>
          </div>

          <div className="prio-field" style={{ marginTop: "var(--prio-space-4)" }}>
            <span className="prio-label">Assigned project</span>
            {profile.projects.length === 0 ? (
              <p className="prio-text-muted">
                Not a member of any project yet.
              </p>
            ) : (
              <div className="prio-memberpicker">
                {profile.projects.map((project) => (
                  <Link
                    key={project.id}
                    href={`/projects/${project.key.toLowerCase()}/summary`}
                    className="prio-memberrow"
                    onClick={onClose}
                  >
                    <span className="prio-memberpicker__text">
                      <span className="prio-memberpicker__name">
                        {project.name}
                      </span>
                      <span className="prio-memberpicker__meta">
                        {project.key}
                      </span>
                    </span>
                  </Link>
                ))}
              </div>
            )}
          </div>

          <div className="prio-field" style={{ marginTop: "var(--prio-space-4)" }}>
            <span className="prio-label">
              Assigned work · {profile.issues.length}
            </span>
            {profile.issues.length === 0 ? (
              <p className="prio-text-muted">Nothing is assigned right now.</p>
            ) : (
              <div className="prio-memberpicker">
                {profile.issues.map((issue) => (
                  <Link
                    key={issue.id}
                    href={`/issues/${issue.key.toLowerCase()}`}
                    className="prio-memberrow"
                    onClick={onClose}
                  >
                    <span className="prio-memberpicker__text">
                      <span className="prio-memberpicker__name">
                        {issue.key} — {issue.title}
                      </span>
                      <span className="prio-memberpicker__meta">
                        {ISSUE_TYPE_LABEL[issue.type as IssueType] ?? issue.type}
                        {" · "}
                        {STATUS_LABEL[issue.status as IssueStatus] ??
                          issue.status}
                      </span>
                    </span>
                  </Link>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </Dialog>
  );
}
