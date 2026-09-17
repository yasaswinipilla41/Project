"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Avatar, Button } from "@/components/ui/primitives";
import { Dialog } from "@/components/ui/Dialog";
import { useToast } from "@/components/ui/Toast";
import { SearchSelect } from "@/components/admin/SearchSelect";
import { DISPLAY_ROLE_LABEL, ISSUE_TYPE_LABEL, STATUS_LABEL } from "@/lib/domain";
import type { IssueStatus, IssueType } from "@prisma/client";
import {
  issuesAssignedTo,
  listIssuesForProjects,
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
  /**
   * Every project this person should be on, and what they should hold in each.
   *
   * Kept per project rather than as one flat list of issues, because the set
   * of projects can change while the editor is open and a flat list gives no
   * way to say which issues a removed project took with it. An issue past the
   * picker's cap has no row to read a project id from, so a flat list would
   * either strand it — the save then refuses it as belonging to no selected
   * project — or drop it, which releases work nobody chose to release.
   */
  const [projectIds, setProjectIds] = useState<string[]>([]);
  const [byProject, setByProject] = useState<Record<string, string[]>>({});
  const [options, setOptions] = useState<RosterIssueOption[] | null>(null);
  const [loadingIssues, setLoadingIssues] = useState(false);
  const [saving, setSaving] = useState(false);

  /** Everything selected, in the shape both the picker and the save want. */
  const issueIds = Object.values(byProject).flat();

  /*
   * Which request is allowed to write its answer.
   *
   * Two quick changes to the projects field leave two loads in flight, and the
   * slower one landing last would revive a project that had just been taken
   * off. Only the most recent gets to finish.
   */
  const latest = useRef(0);

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

  /**
   * The projects this person should be on, and their work in each.
   *
   * Only the difference is fetched: a project just added is asked what they
   * hold there, and one just removed simply drops out of the map along with
   * its issues. Projects that were already selected keep whatever the
   * administrator has chosen for them, which is what stops editing the second
   * project from quietly rewriting the first.
   */
  async function chooseProjects(next: string[], previous = projectIds) {
    const request = (latest.current += 1);
    const added = next.filter((id) => !previous.includes(id));

    setProjectIds(next);
    setByProject((current) => {
      const kept: Record<string, string[]> = {};
      for (const id of next) kept[id] = previous.includes(id) ? (current[id] ?? []) : [];
      return kept;
    });

    setOptions(null);
    if (next.length === 0) {
      setLoadingIssues(false);
      return;
    }

    setLoadingIssues(true);
    const [listed, ...held] = await Promise.all([
      listIssuesForProjects(next),
      /*
       * Start each new project from what they already hold there, so saving
       * without touching the list is a no-op rather than an unassignment.
       *
       * Asked for directly rather than read off the rows above, for two
       * reasons and both of them lost data. The rows were matched by the
       * displayed assignee *name*, which is only the same answer while every
       * name is unique and spelled identically. And the rows are capped, while
       * a real project holds more — the seed's Engineering project has 985 —
       * so everything past the cap was invisible to the seeding and released
       * on save. `issuesAssignedTo` answers with the whole set.
       */
      ...added.map((id) => issuesAssignedTo(id, personId)),
    ]);
    if (latest.current !== request) return;
    setLoadingIssues(false);

    if (!listed.ok) {
      toast(listed.error, "error");
      setOptions([]);
    } else {
      setOptions(listed.data);
    }

    const seeded: Record<string, string[]> = {};
    for (const [index, id] of added.entries()) {
      const result = held[index];
      if (result?.ok) {
        seeded[id] = result.data;
      } else {
        if (result) toast(result.error, "error");
        /* Better to close the editor than to offer a selection that would
           release work nobody was shown. */
        stopEditing();
        return;
      }
    }
    setByProject((current) => ({ ...current, ...seeded }));
  }

  /**
   * The issue selection, put back into the project it belongs to.
   *
   * The picker hands back one flat list. An id it offered carries its project
   * on the option row; an id it never offered — one past the cap, seeded from
   * what this person already holds — keeps the project it is already filed
   * under. Between them every id can be placed, so nothing is lost on the way
   * back in.
   */
  function chooseIssues(next: string[]) {
    const projectOf = new Map<string, string>();
    for (const option of options ?? []) projectOf.set(option.id, option.projectId);
    for (const [projectId, ids] of Object.entries(byProject)) {
      for (const id of ids) if (!projectOf.has(id)) projectOf.set(id, projectId);
    }

    const grouped: Record<string, string[]> = {};
    for (const id of projectIds) grouped[id] = [];
    for (const id of next) {
      const projectId = projectOf.get(id);
      if (projectId && grouped[projectId]) grouped[projectId].push(id);
    }
    setByProject(grouped);
  }

  function startEditing() {
    setEditing(true);
    /* Everything they are on today, so an untouched save changes nothing.
       The baseline is empty rather than whatever a cancelled edit left
       behind, so every project is seeded from the database afresh. */
    void chooseProjects(
      profile ? profile.projects.map((project) => project.id) : [],
      [],
    );
  }

  function stopEditing() {
    latest.current += 1;
    setEditing(false);
    setProjectIds([]);
    setByProject({});
    setOptions(null);
    setLoadingIssues(false);
  }

  async function save() {
    setSaving(true);
    const result = await updateRosterAssignment({
      userId: personId,
      projectIds,
      issueIds,
    });
    setSaving(false);

    if (!result.ok) {
      toast(result.error, "error");
      return;
    }

    /* Only what actually happened. A save that assigned nothing and released
       nothing should not report two zeroes as though they were news. */
    const { assigned, released, joined, left } = result.data;
    const parts = [
      assigned > 0 ? `${assigned} assigned` : null,
      released > 0 ? `${released} released` : null,
      joined > 0 ? `${joined} project${joined === 1 ? "" : "s"} added` : null,
      left > 0 ? `${left} project${left === 1 ? "" : "s"} removed` : null,
    ].filter(Boolean);

    toast(
      parts.length > 0
        ? `${personName} updated · ${parts.join(", ")}`
        : `${personName} is unchanged`,
    );

    // Reload the profile in place so the sections below show what was saved,
    // and refresh the page behind so the roster blocks agree with it.
    const reloaded = await loadRosterProfile(personId);
    if (reloaded.ok) setProfile(reloaded.data);
    stopEditing();
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
            <Button variant="ghost" onClick={stopEditing} disabled={saving}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={() => void save()}
              loading={saving}
              disabled={saving}
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
            <span className="prio-rolebadge" data-role={profile.displayRole}>
              {DISPLAY_ROLE_LABEL[profile.displayRole]}
            </span>
          </div>

          <div className="prio-field" style={{ marginTop: "var(--prio-space-4)" }}>
            <span className="prio-label">
              Assigned projects
              {editing && projectIds.length > 0 ? ` · ${projectIds.length}` : ""}
            </span>
            {editing ? (
              <>
                <SearchSelect
                  id="roster-edit-project"
                  multiple
                  ariaLabel="Search projects"
                  placeholder="Search projects…"
                  options={projects.map((project) => ({
                    id: project.id,
                    label: project.name,
                    meta: project.key,
                  }))}
                  selected={projectIds}
                  onChange={(next) => void chooseProjects(next)}
                  disabled={saving}
                />
                <p className="prio-hint">
                  Every project {personName.split(" ")[0]} should be on. Adding
                  one brings across whatever they already hold there; taking one
                  off removes their access to it and puts down their work in it.
                  Projects left alone here are not touched.
                </p>
              </>
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
              projectIds.length === 0 ? (
                <p className="prio-text-muted">
                  Choose a project first — work belongs to one.
                </p>
              ) : loadingIssues ? (
                <p className="prio-text-muted">Loading issues…</p>
              ) : (
                <>
                  <SearchSelect
                    id="roster-edit-issues"
                    multiple
                    ariaLabel="Search issues in the chosen projects"
                    placeholder="Search issues by key or summary…"
                    emptyHint="These projects have no issues yet."
                    options={(options ?? []).map((issue) => ({
                      id: issue.id,
                      label: `${issue.key} — ${issue.title}`,
                      /* The project as well as the assignee: the list can now
                         span several, and a key alone does not always say
                         which one a row came from. */
                      meta: `${issue.projectKey} · ${
                        issue.assigneeName
                          ? `Assigned to ${issue.assigneeName}`
                          : "Unassigned"
                      }`,
                    }))}
                    selected={issueIds}
                    onChange={chooseIssues}
                    disabled={saving}
                  />
                  <p className="prio-hint">
                    What {personName.split(" ")[0]} should be holding across the
                    projects above. Anything of theirs in those projects that is
                    taken off the list is put down; work in any project not
                    listed above is untouched.
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
