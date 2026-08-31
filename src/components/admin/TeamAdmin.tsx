"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { Avatar, Button, Card, CardBody } from "@/components/ui/primitives";
import { Dialog } from "@/components/ui/Dialog";
import { useToast } from "@/components/ui/Toast";
import { IconPlus } from "@/components/ui/Icon";
import { addTeamMember, removeTeamMember } from "@/server/teams";

export interface TeamPerson {
  id: string;
  name: string;
  email: string;
  image: string | null;
  jobTitle: string | null;
}

export interface AdminTeam {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  members: TeamPerson[];
}

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
 */
export function TeamAdmin({
  teams,
  everyone,
}: {
  teams: AdminTeam[];
  everyone: TeamPerson[];
}) {
  const router = useRouter();
  const { toast } = useToast();

  const [addingTo, setAddingTo] = useState<AdminTeam | null>(null);
  const [query, setQuery] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);

  const candidates = useMemo(() => {
    if (!addingTo) return [];
    const already = new Set(addingTo.members.map((m) => m.id));
    const q = query.trim().toLowerCase();
    return everyone
      .filter((person) => !already.has(person.id))
      .filter(
        (person) =>
          !q ||
          person.name.toLowerCase().includes(q) ||
          person.email.toLowerCase().includes(q),
      );
  }, [addingTo, everyone, query]);

  async function add(teamId: string, userId: string) {
    setBusyId(userId);
    const result = await addTeamMember({ teamId, userId });
    setBusyId(null);

    if (!result.ok) {
      toast(result.error, "error");
      return;
    }
    toast("Added to the team");
    setAddingTo(null);
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
                onClick={() => {
                  setQuery("");
                  setAddingTo(team);
                }}
              >
                <IconPlus size={14} />
                Add member
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
          onClose={() => setAddingTo(null)}
          title={`Add to ${addingTo.name}`}
          description="Team membership is separate from a person's role and from the projects they belong to. Adding somebody here changes neither."
          footer={
            <Button variant="ghost" onClick={() => setAddingTo(null)}>
              Done
            </Button>
          }
        >
          <div className="prio-field">
            <label className="prio-label" htmlFor="team-search">
              Search people
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
                <div key={person.id} className="prio-memberrow">
                  <Avatar name={person.name} image={person.image} size="md" />
                  <span className="prio-memberpicker__text">
                    <span className="prio-memberpicker__name">
                      {person.name}
                    </span>
                    <span className="prio-memberpicker__meta">
                      {person.jobTitle ?? person.email}
                    </span>
                  </span>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={busyId === person.id}
                    loading={busyId === person.id}
                    onClick={() => add(addingTo.id, person.id)}
                  >
                    Add
                  </Button>
                </div>
              ))}
            </div>
          )}
        </Dialog>
      ) : null}
    </>
  );
}
