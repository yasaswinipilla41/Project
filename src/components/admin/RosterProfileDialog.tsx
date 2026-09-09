"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Avatar, Button } from "@/components/ui/primitives";
import { Dialog } from "@/components/ui/Dialog";
import { useToast } from "@/components/ui/Toast";
import { SearchSelect } from "@/components/admin/SearchSelect";
import { ISSUE_TYPE_LABEL, STATUS_LABEL, WORK_ROLE_LABEL } from "@/lib/domain";
import type { IssueStatus, IssueType } from "@prisma/client";
import {
  issuesAssignedTo,
  listProjectIssues,
  loadRosterProfile,
  updateRosterAssignment,
} from "@/server/roster";
import type { RosterIssueOption, RosterProfile } from "@/server/roster";

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
  projects,
  onClose,
}: {
  personId: string;
  personName: string;
  /** Every live project, so Edit can move this person to a different one. */
  projects: { id: string; key: string; name: string }[];
  onClose: () => void;
}) {
  const router = useRouter();
  const { toast } = useToast();

  const [profile, setProfile] = useState<RosterProfile | null>(null);
  const [error, setError] = useState<string | null>(null);

  /*
   * Editing is a mode of this dialog rather than a second one.
   *
   * What it edits is what the two sections below already show — the project
   * this person is on, and the work that is theirs — so opening the editor in
   * place, over the same values, is what makes the change obviously about the
   * person whose profile is open. `updateRosterAssignment` re-checks all of it.
   */
  const [editing, setEditing] = useState(false);
  const [projectId, setProjectId] = useState("");
  const [issueIds, setIssueIds] = useState<string[]>([]);
  const [options, setOptions] = useState<RosterIssueOption[] | null>(null);
  const [loadingIssues, setLoadingIssues] = useState(false);
  const [saving, setSaving] = useState(false);

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

  /** The issues of one project, and this person's among them pre-selected. */
  async function chooseProject(nextId: string) {
    setProjectId(nextId);
    setIssueIds([]);
    setOptions(null);
    if (!nextId) return;

    setLoadingIssues(true);
    const result = await listProjectIssues(nextId);
    setLoadingIssues(false);

    if (!result.ok) {
      toast(result.error, "error");
      setOptions([]);
      return;
    }
    setOptions(result.data);

    /*
     * Start from what they already hold there, so saving without touching the
     * list is a no-op rather than an unassignment.
     *
     * Asked for directly rather than read off the rows above, for two reasons
     * and both of them lost data. The rows were matched by the displayed
     * assignee *name*, which is only the same answer while every name is
     * unique and spelled identically. And the rows are capped at 500, while a
     * real project holds more — the seed's Engineering project has 985 — so
     * everything past the cap was invisible to the seeding and released on
     * save.
     *
     * `issuesAssignedTo` answers with the whole set. An issue outside the
     * visible rows stays selected and therefore stays theirs.
     */
    const current = await issuesAssignedTo(nextId, personId);
    if (current.ok) setIssueIds(current.data);
    else {
      toast(current.error, "error");
      /* Better to offer nothing than a selection that would release work. */
      setEditing(false);
    }
  }

  function startEditing() {
    setEditing(true);
    // Their current project, when it is unambiguous, is the obvious start.
    const first = profile?.projects[0];
    void chooseProject(first ? first.id : "");
  }

  async function save() {
    if (!projectId) {
      toast("Choose a project.", "error");
      return;
    }
    setSaving(true);
    const result = await updateRosterAssignment({
      userId: personId,
      projectId,
      issueIds,
    });
    setSaving(false);

    if (!result.ok) {
      toast(result.error, "error");
      return;
    }

    toast(
      result.data.released > 0
        ? `${personName} updated · ${result.data.assigned} assigned, ${result.data.released} released`
        : `${personName} updated · ${result.data.assigned} assigned`,
    );

    // Reload the profile in place so the sections below show what was saved,
    // and refresh the page behind so the roster blocks agree with it.
    const reloaded = await loadRosterProfile(personId);
    if (reloaded.ok) setProfile(reloaded.data);
    setEditing(false);
    router.refresh();
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={personName}
      description="What this person does, what they can open, and what is assigned to them."
      busy={saving}
      footer={
        editing ? (
          <>
            <Button
              variant="ghost"
              onClick={() => setEditing(false)}
              disabled={saving}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={() => void save()}
              loading={saving}
              disabled={saving || !projectId}
            >
              Save changes
            </Button>
          </>
        ) : (
          <>
            <Button
              variant="secondary"
              onClick={startEditing}
              disabled={!profile}
            >
              Edit
            </Button>
            <Button variant="ghost" onClick={onClose}>
              Done
            </Button>
          </>
        )
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
            {editing ? (
              <SearchSelect
                id="roster-edit-project"
                ariaLabel="Search projects"
                placeholder="Search projects…"
                options={projects.map((project) => ({
                  id: project.id,
                  label: project.name,
                  meta: project.key,
                }))}
                selected={projectId ? [projectId] : []}
                onChange={(next) => void chooseProject(next[0] ?? "")}
                disabled={saving}
              />
            ) : profile.projects.length === 0 ? (
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
              Assigned work · {editing ? issueIds.length : profile.issues.length}
            </span>
            {editing ? (
              !projectId ? (
                <p className="prio-text-muted">
                  Choose a project first — work is that project&rsquo;s only.
                </p>
              ) : loadingIssues ? (
                <p className="prio-text-muted">Loading issues…</p>
              ) : (
                <>
                  <SearchSelect
                    id="roster-edit-issues"
                    multiple
                    ariaLabel="Search issues in the chosen project"
                    placeholder="Search issues by key or summary…"
                    emptyHint="This project has no issues yet."
                    options={(options ?? []).map((issue) => ({
                      id: issue.id,
                      label: `${issue.key} — ${issue.title}`,
                      meta: issue.assigneeName
                        ? `Assigned to ${issue.assigneeName}`
                        : "Unassigned",
                    }))}
                    selected={issueIds}
                    onChange={setIssueIds}
                    disabled={saving}
                  />
                  <p className="prio-hint">
                    What {personName.split(" ")[0]} should be holding in this
                    project. Anything of theirs here that is taken off the list
                    is put down; their work in other projects is untouched.
                  </p>
                </>
              )
            ) : profile.issues.length === 0 ? (
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
