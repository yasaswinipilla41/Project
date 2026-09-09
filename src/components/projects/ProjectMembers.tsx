"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { Avatar, Button } from "@/components/ui/primitives";
import { Dialog } from "@/components/ui/Dialog";
import { useToast } from "@/components/ui/Toast";
import { IconPlus } from "@/components/ui/Icon";
import { addProjectMember, removeProjectMember } from "@/server/projects";

export interface ProjectMemberPerson {
  id: string;
  name: string;
  email: string;
  image: string | null;
  jobTitle: string | null;
}

/**
 * A project's member roster, and adding to it.
 *
 * Both controls call `addProjectMember` / `removeProjectMember`, which already
 * existed and already require an administrator — no second permission path was
 * introduced for this. `canManage` decides what is worth rendering; the server
 * re-checks on every call, so a member who forged the request gets the same
 * refusal as if the buttons had never been hidden.
 *
 * `candidates` is everyone not already on the project, prepared by the page
 * (and only for someone allowed to add), so opening the dialog costs no
 * request and the list can be filtered as you type.
 */
export function ProjectMembers({
  projectId,
  members,
  candidates,
  canManage,
}: {
  projectId: string;
  members: ProjectMemberPerson[];
  candidates: ProjectMemberPerson[];
  canManage: boolean;
}) {
  const router = useRouter();
  const { toast } = useToast();

  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return candidates;
    return candidates.filter(
      (person) =>
        person.name.toLowerCase().includes(q) ||
        person.email.toLowerCase().includes(q),
    );
  }, [candidates, query]);

  async function add(userId: string) {
    setBusyId(userId);
    const result = await addProjectMember({ projectId, userId });
    setBusyId(null);

    if (!result.ok) {
      toast(result.error, "error");
      return;
    }
    toast("Member added");
    router.refresh();
  }

  async function remove(userId: string, name: string) {
    setBusyId(userId);
    const result = await removeProjectMember({ projectId, userId });
    setBusyId(null);

    if (!result.ok) {
      toast(result.error, "error");
      return;
    }
    toast(`${name} removed from this project`);
    router.refresh();
  }

  return (
    <>
      <div className="prio-projectmembers__head">
        <h2 className="prio-issue__section-title">
          Members · {members.length}
        </h2>
        {canManage ? (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setQuery("");
              setAdding(true);
            }}
          >
            <IconPlus size={14} />
            Add members
          </Button>
        ) : null}
      </div>

      <div>
        {members.map((member) => (
          <div key={member.id} className="prio-memberrow">
            <Avatar name={member.name} image={member.image} size="md" />
            <span className="prio-memberpicker__text">
              <span className="prio-memberpicker__name">{member.name}</span>
              <span className="prio-memberpicker__meta">
                {member.jobTitle ?? "Not set"}
              </span>
            </span>
            {canManage ? (
              <Button
                variant="ghost"
                size="sm"
                disabled={busyId === member.id}
                onClick={() => remove(member.id, member.name)}
              >
                Remove
              </Button>
            ) : null}
          </div>
        ))}
      </div>

      {adding ? (
        <Dialog
          open
          onClose={() => setAdding(false)}
          title="Add members"
          description="Everyone here can already sign in to Prio. Adding them to this project grants access to its issues."
          footer={
            <Button variant="ghost" onClick={() => setAdding(false)}>
              Done
            </Button>
          }
        >
          <div className="prio-field">
            <label className="prio-label" htmlFor="member-search">
              Search people
            </label>
            <input
              id="member-search"
              type="search"
              className="prio-input"
              placeholder="Name or email"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>

          {candidates.length === 0 ? (
            <p className="prio-text-muted">
              Everyone already has access to this project.
            </p>
          ) : matches.length === 0 ? (
            <p className="prio-text-muted">Nobody matches “{query}”.</p>
          ) : (
            <div className="prio-memberpicker">
              {matches.map((person) => (
                <div key={person.id} className="prio-memberrow">
                  <Avatar name={person.name} image={person.image} size="md" />
                  <span className="prio-memberpicker__text">
                    <span className="prio-memberpicker__name">
                      {person.name}
                    </span>
                    <span className="prio-memberpicker__meta">
                      {person.jobTitle ?? "Not set"}
                    </span>
                  </span>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={busyId === person.id}
                    loading={busyId === person.id}
                    onClick={() => add(person.id)}
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
