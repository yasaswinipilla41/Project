"use client";

import { useRouter } from "next/navigation";
import { useMemo, useRef, useState } from "react";
import { Avatar, Button, Card, CardBody } from "@/components/ui/primitives";
import { SearchSelect } from "@/components/admin/SearchSelect";
import { ROLE_DESCRIPTION, ROLE_LABEL, ROLES } from "@/lib/domain";
import type { Role } from "@prisma/client";
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
  /** The account role the People screen grants — what Role filters on. */
  role?: Role;
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

  /*
   * Who may still be added: everybody not already on this team, narrowed by
   * the Role above when the dialog offers one.
   *
   * Role filtering the member list is what makes the two fields read as one
   * decision — "add these Members, as this Role" — rather than two unrelated
   * dropdowns. It applies only where Role is asked for, which is Development;
   * the plain dialog has no Role and offers everybody.
   *
   * Searching is the field's own now, so nothing filters by `query` here.
   */
  const candidates = useMemo(() => {
    if (!addingTo) return [];
    const already = new Set(addingTo.members.map((m) => m.id));
    const filtersByRole = addingTo.slug === DEVELOPMENT_SLUG;
    return everyone
      .filter((person) => !already.has(person.id) || chosen.includes(person.id))
      .filter(
        (person) =>
          !filtersByRole || person.role === undefined || person.role === role,
      );
  }, [addingTo, everyone, chosen, role]);

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
      {/*
       * The teams side by side rather than stacked.
       *
       * Development and Testing are two halves of the same question — who
       * builds and who checks — and reading one under the other made the page
       * scroll for no reason. Bootstrap's own grid, the one the rest of
       * Administration uses, so the pair drops back to full width on a narrow
       * screen with nothing extra written for it. `h-100` is what keeps the
       * two cards the same height when one team has more people than the
       * other.
       */}
      <div className="row g-3">
        {teams.map((team) => (
          <div key={team.id} className="col-12 col-lg-6">
        <Card className="prio-issue__section h-100">
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
                        {member.jobTitle ?? "Not set"}
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
          </div>
        ))}
      </div>

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
            {/* Typed into and picked from, like every field in this dialog.
                Choosing one still reloads the issues below and drops whatever
                was chosen from the previous project — `chooseProject` is
                unchanged, it is only reached a different way. */}
            <SearchSelect
              id="roster-project"
              ariaLabel="Search projects"
              placeholder="Search projects…"
              options={projects.map((project) => ({
                id: project.id,
                label: project.name,
                meta: project.key,
              }))}
              selected={projectId ? [projectId] : []}
              onChange={(next) => void chooseProject(next[0] ?? "")}
            />
          </div>

          {isDeveloperTeam ? (
            <>
              <div className="prio-field">
                <label className="prio-label" htmlFor="roster-issues">
                  Issues{chosenIssues.length > 0 ? ` · ${chosenIssues.length}` : ""}
                </label>
                {!projectId ? (
                  <p className="prio-text-muted">
                    Choose a project first — issues are this project&rsquo;s
                    only.
                  </p>
                ) : loadingIssues ? (
                  <p className="prio-text-muted">Loading issues…</p>
                ) : (
                  <SearchSelect
                    id="roster-issues"
                    multiple
                    ariaLabel="Search issues in the chosen project"
                    placeholder="Search issues by key or summary…"
                    emptyHint="This project has no issues yet. Members can still be added without any."
                    options={(issues ?? []).map((issue) => ({
                      id: issue.id,
                      label: `${issue.key} — ${issue.title}`,
                      meta: issue.assigneeName
                        ? `Assigned to ${issue.assigneeName}`
                        : "Unassigned",
                    }))}
                    selected={chosenIssues}
                    onChange={setChosenIssues}
                  />
                )}
              </div>

              <div className="prio-field">
                <label className="prio-label" htmlFor="roster-role">
                  Role
                </label>
                <SearchSelect
                  id="roster-role"
                  ariaLabel="Search roles"
                  placeholder="Search roles…"
                  options={ROLES.map((option) => ({
                    id: option,
                    label: ROLE_LABEL[option],
                    meta: ROLE_DESCRIPTION[option],
                  }))}
                  selected={[role]}
                  onChange={(next) => {
                    const picked = next[0] === "ADMIN" ? "ADMIN" : "MEMBER";
                    setRole(picked);
                    /* The people below are the ones this role can name, so a
                       different role means a different list — and anybody
                       chosen from the old one is no longer on it. Dropping
                       them is the same rule the project field follows with
                       issues: a selection that is no longer offered is not
                       quietly kept. */
                    setChosen((prev) =>
                      prev.filter((id) =>
                        everyone.some(
                          (person) =>
                            person.id === id &&
                            (person.role === undefined || person.role === picked),
                        ),
                      ),
                    );
                  }}
                />
                <p className="prio-hint">
                  The account role the People screen grants, and what the
                  Members list below is narrowed to. Whether a member tests or
                  builds is still their team.
                </p>
              </div>
            </>
          ) : null}

          <div className="prio-field">
            <label className="prio-label" htmlFor="team-search">
              Members{chosen.length > 0 ? ` · ${chosen.length}` : ""}
            </label>
            <SearchSelect
              id="team-search"
              multiple
              ariaLabel="Search people by name or email"
              placeholder="Search by name or email…"
              emptyHint={
                isDeveloperTeam
                  ? "Nobody with that role is left to add."
                  : "Everybody is already on this team."
              }
              options={candidates.map((person) => ({
                id: person.id,
                label: person.name,
                meta: person.jobTitle ?? "Not set",
                /* The field says "name or email", and it still means it — the
                   row shows a designation, and this is what keeps the promise
                   without printing an address beside every name. */
                keywords: person.email,
                adornment: (
                  <Avatar name={person.name} image={person.image} size="sm" />
                ),
              }))}
              selected={chosen}
              onChange={setChosen}
            />
          </div>

        </Dialog>
      ) : null}

      {profileFor ? (
        <RosterProfileDialog
          personId={profileFor.id}
          personName={profileFor.name}
          projects={projects}
          onClose={() => setProfileFor(null)}
        />
      ) : null}
    </>
  );
}
