"use client";

import { useRouter } from "next/navigation";
import { useMemo, useRef, useState } from "react";
import { Avatar, Button, Card, CardBody } from "@/components/ui/primitives";
import { Dialog } from "@/components/ui/Dialog";
import { useToast } from "@/components/ui/Toast";
import { IconPlus, IconUser } from "@/components/ui/Icon";
import { RosterProfileDialog } from "@/components/admin/RosterProfileDialog";
import { removeTeamMember } from "@/server/teams";
import {
  assignDevelopers,
  assignTeamMembers,
  listProjectIssues,
} from "@/server/roster";
import type { RosterIssueOption } from "@/server/roster";

export interface TeamPerson {
  id: string;
  name: string;
  email: string;
  image: string | null;
  jobTitle: string | null;
}

export interface TeamProject {
  id: string;
  key: string;
  name: string;
}

export interface AdminTeam {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  members: TeamPerson[];
}

/** The one team whose dialog also hands out work. */
const DEVELOPMENT_SLUG = "development";

/**
 * Teams, and who is on them.
 *
 * This is the only way anybody joins a team. Nothing grants membership as a
 * side effect — not signing up, not being made an administrator, not being
 * added to a project — so a roster here is always a decision somebody made and
 * can be undone the same way.
 *
 * Administrators manage this because they already administer Prio; no separate
 * team-management permission was invented. The server re-checks on every call.
 *
 * Adding somebody now names a project as well as a person. The two are still
 * separate rows and separate facts — being on Testing grants access to nothing
 * — but an administrator putting a tester on a project means both, and having
 * to say so in two places was the thing worth fixing. `assignTeamMembers`
 * writes the pair; `TeamMember` is unchanged.
 *
 * Development gets a wider dialog than the rest, because onboarding a developer
 * is also handing them something to build. Which dialog opens is decided by the
 * team's slug, so every other team — Testing today, Design tomorrow — keeps the
 * plain one without another branch being added for it.
 */
export function TeamAdmin({
  teams,
  everyone,
  projects,
}: {
  teams: AdminTeam[];
  everyone: TeamPerson[];
  projects: TeamProject[];
}) {
  const router = useRouter();
  const { toast } = useToast();

  const [addingTo, setAddingTo] = useState<AdminTeam | null>(null);
  const [query, setQuery] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [profileFor, setProfileFor] = useState<TeamPerson | null>(null);

  /* Dialog state. Reset every time one opens, so a previous choice never
     carries into the next assignment. */
  const [projectId, setProjectId] = useState("");
  const [chosen, setChosen] = useState<string[]>([]);
  const [chosenIssues, setChosenIssues] = useState<string[]>([]);
  const [role, setRole] = useState<"ADMIN" | "MEMBER">("MEMBER");
  const [issues, setIssues] = useState<RosterIssueOption[] | null>(null);
  const [loadingIssues, setLoadingIssues] = useState(false);

  const isDeveloperTeam = addingTo?.slug === DEVELOPMENT_SLUG;

  /*
   * The issue list follows the project, and nothing survives the change.
   *
   * Choosing a project reloads the options and drops every previously chosen
   * issue rather than filtering the old selection down: an issue that is still
   * valid can only be so by coincidence, and keeping it would mean the field
   * sometimes remembers and sometimes forgets. The server re-checks that every
   * submitted issue belongs to the submitted project regardless — this is the
   * affordance, not the guarantee.
   *
   * Done here, in the handler, rather than in an effect watching `projectId`.
   * The fetch is a consequence of the administrator picking something, not of
   * the component rendering, and writing it this way keeps the reset and the
   * request in the one place the choice happens.
   *
   * `latestProject` is what makes a slow answer harmless: two quick changes
   * leave two requests in flight, and only the one still selected is allowed
   * to write its result.
   */
  const latestProject = useRef("");

  async function chooseProject(nextId: string) {
    latestProject.current = nextId;

    setProjectId(nextId);
    setChosenIssues([]);

    if (!isDeveloperTeam) return;

    if (!nextId) {
      setIssues(null);
      return;
    }

    setIssues(null);
    setLoadingIssues(true);

    const result = await listProjectIssues(nextId);
    if (latestProject.current !== nextId) return;

    setLoadingIssues(false);
    if (result.ok) {
      setIssues(result.data);
    } else {
      setIssues([]);
      toast(result.error, "error");
    }
  }

  function openDialog(team: AdminTeam) {
    latestProject.current = "";
    setQuery("");
    setProjectId("");
    setChosen([]);
    setChosenIssues([]);
    setRole("MEMBER");
    setIssues(null);
    setAddingTo(team);
  }

  function closeDialog() {
    setAddingTo(null);
  }

  const candidates = useMemo(() => {
    if (!addingTo) return [];
    const already = new Set(addingTo.members.map((m) => m.id));
    const q = query.trim().toLowerCase();
    return everyone
      .filter((person) => !already.has(person.id) || chosen.includes(person.id))
      .filter(
        (person) =>
          !q ||
          person.name.toLowerCase().includes(q) ||
          person.email.toLowerCase().includes(q),
      );
  }, [addingTo, everyone, query, chosen]);

  function toggle(list: string[], id: string): string[] {
    return list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
  }

  async function submit() {
    if (!addingTo) return;

    if (!projectId) {
      toast("Choose a project.", "error");
      return;
    }
    if (chosen.length === 0) {
      toast("Choose at least one person.", "error");
      return;
    }

    setSaving(true);
    const result = isDeveloperTeam
      ? await assignDevelopers({
          teamId: addingTo.id,
          projectId,
          issueIds: chosenIssues,
          role,
          userIds: chosen,
        })
      : await assignTeamMembers({
          teamId: addingTo.id,
          projectId,
          userIds: chosen,
        });
    setSaving(false);

    if (!result.ok) {
      toast(result.error, "error");
      return;
    }

    const people = `${chosen.length} ${chosen.length === 1 ? "person" : "people"}`;
    toast(
      isDeveloperTeam && chosenIssues.length > 0
        ? `${people} added · ${chosenIssues.length} issue${
            chosenIssues.length === 1 ? "" : "s"
          } assigned`
        : `${people} added to ${addingTo.name}`,
    );
    closeDialog();
    router.refresh();
  }

  async function remove(teamId: string, userId: string, name: string) {
    setBusyId(userId);
    const result = await removeTeamMember({ teamId, userId });
    setBusyId(null);

    if (!result.ok) {
      toast(result.error, "error");
      return;
    }
    toast(`${name} removed from the team`);
    router.refresh();
  }

  return (
    <>
      {teams.map((team) => (
        <Card key={team.id} className="prio-issue__section">
          <CardBody>
            <div className="prio-projectmembers__head">
              <h2 className="prio-issue__section-title">
                {team.name} · {team.members.length}
              </h2>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => openDialog(team)}
              >
                <IconPlus size={14} />
                Add members
              </Button>
            </div>

            {team.description ? (
              <p className="prio-hint" style={{ marginTop: 0 }}>
                {team.description}
              </p>
            ) : null}

            {team.members.length === 0 ? (
              <p className="prio-text-muted">
                Nobody is on this team yet. Members added here gain the views
                that belong to it.
              </p>
            ) : (
              <div>
                {team.members.map((member) => (
                  <div key={member.id} className="prio-memberrow">
                    <Avatar name={member.name} image={member.image} size="md" />
                    <span className="prio-memberpicker__text">
                      <span className="prio-memberpicker__name">
                        {member.name}
                      </span>
                      <span className="prio-memberpicker__meta">
                        {member.jobTitle ?? member.email}
                      </span>
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`Profile of ${member.name}`}
                      title={`Profile of ${member.name}`}
                      onClick={() => setProfileFor(member)}
                    >
                      <IconUser size={14} />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busyId === member.id}
                      onClick={() => remove(team.id, member.id, member.name)}
                    >
                      Remove
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </CardBody>
        </Card>
      ))}

      {addingTo ? (
        <Dialog
          open
          onClose={closeDialog}
          title={`Add to ${addingTo.name}`}
          busy={saving}
          description={
            isDeveloperTeam
              ? "Choose a project, the work to hand over, the account role and the people. Issues can only come from the project chosen above them."
              : "Choose a project and the people to put on it. Team membership and project access are separate facts; this writes both."
          }
          footer={
            <>
              <Button variant="ghost" onClick={closeDialog} disabled={saving}>
                Cancel
              </Button>
              <Button
                variant="primary"
                onClick={submit}
                loading={saving}
                disabled={saving || !projectId || chosen.length === 0}
              >
                Assign
              </Button>
            </>
          }
        >
          <div className="prio-field">
            <label className="prio-label" htmlFor="roster-project">
              Project
            </label>
            <select
              id="roster-project"
              className="prio-input"
              value={projectId}
              onChange={(event) => void chooseProject(event.target.value)}
            >
              <option value="">Choose a project…</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.key} — {project.name}
                </option>
              ))}
            </select>
          </div>

          {isDeveloperTeam ? (
            <>
              <div className="prio-field">
                <span className="prio-label">
                  Issues{chosenIssues.length > 0 ? ` · ${chosenIssues.length}` : ""}
                </span>
                {!projectId ? (
                  <p className="prio-text-muted">
                    Choose a project first — issues are this project&rsquo;s
                    only.
                  </p>
                ) : loadingIssues ? (
                  <p className="prio-text-muted">Loading issues…</p>
                ) : !issues || issues.length === 0 ? (
                  <p className="prio-text-muted">
                    This project has no issues yet. Members can still be added
                    without any.
                  </p>
                ) : (
                  <div className="prio-memberpicker">
                    {issues.map((issue) => (
                      <button
                        key={issue.id}
                        type="button"
                        className="prio-memberrow"
                        data-selected={
                          chosenIssues.includes(issue.id) || undefined
                        }
                        onClick={() =>
                          setChosenIssues((prev) => toggle(prev, issue.id))
                        }
                      >
                        <span className="prio-memberpicker__text">
                          <span className="prio-memberpicker__name">
                            {issue.key} — {issue.title}
                          </span>
                          <span className="prio-memberpicker__meta">
                            {issue.assigneeName
                              ? `Assigned to ${issue.assigneeName}`
                              : "Unassigned"}
                          </span>
                        </span>
                        {chosenIssues.includes(issue.id) ? (
                          <span className="prio-hint">Selected</span>
                        ) : null}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <div className="prio-field">
                <label className="prio-label" htmlFor="roster-role">
                  Role
                </label>
                <select
                  id="roster-role"
                  className="prio-input"
                  value={role}
                  onChange={(event) =>
                    setRole(event.target.value === "ADMIN" ? "ADMIN" : "MEMBER")
                  }
                >
                  <option value="MEMBER">Member</option>
                  <option value="ADMIN">Admin</option>
                </select>
                <p className="prio-hint">
                  The account role the People screen grants. Whether a member
                  tests or builds is still their team.
                </p>
              </div>
            </>
          ) : null}

          <div className="prio-field">
            <label className="prio-label" htmlFor="team-search">
              Members{chosen.length > 0 ? ` · ${chosen.length}` : ""}
            </label>
            <input
              id="team-search"
              type="search"
              className="prio-input"
              placeholder="Name or email"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>

          {candidates.length === 0 ? (
            <p className="prio-text-muted">
              {query
                ? `Nobody matches “${query}”.`
                : "Everybody is already on this team."}
            </p>
          ) : (
            <div className="prio-memberpicker">
              {candidates.map((person) => (
                <button
                  key={person.id}
                  type="button"
                  className="prio-memberrow"
                  data-selected={chosen.includes(person.id) || undefined}
                  onClick={() => setChosen((prev) => toggle(prev, person.id))}
                >
                  <Avatar name={person.name} image={person.image} size="md" />
                  <span className="prio-memberpicker__text">
                    <span className="prio-memberpicker__name">
                      {person.name}
                    </span>
                    <span className="prio-memberpicker__meta">
                      {person.jobTitle ?? person.email}
                    </span>
                  </span>
                  {chosen.includes(person.id) ? (
                    <span className="prio-hint">Selected</span>
                  ) : null}
                </button>
              ))}
            </div>
          )}
        </Dialog>
      ) : null}

      {profileFor ? (
        <RosterProfileDialog
          personId={profileFor.id}
          personName={profileFor.name}
          onClose={() => setProfileFor(null)}
        />
      ) : null}
    </>
  );
}
