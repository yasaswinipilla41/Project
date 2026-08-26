"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Avatar, Button, Card, CardBody } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/Toast";
import { IconPlus, IconTrash } from "@/components/ui/Icon";
import {
  addProjectMember,
  createLabel,
  removeProjectMember,
  updateProject,
} from "@/server/projects";
import type { FieldErrors } from "@/server/schemas";

/**
 * Project settings (§36): details, members and labels.
 *
 * Every control here calls the existing server action, which re-checks that the
 * caller is an admin. Hiding the UI from members is a convenience, not the
 * boundary.
 */

export interface SettingsMember {
  id: string;
  name: string;
  email: string;
  image: string | null;
  jobTitle: string | null;
}

export interface SettingsLabel {
  id: string;
  name: string;
  color: string;
  issueCount: number;
}

const LABEL_COLOURS = [
  "#3B82F6",
  "#8B5CF6",
  "#E5484D",
  "#F0961F",
  "#14A06D",
  "#0D9488",
  "#6B7C98",
];

export function ProjectSettings({
  project,
  members,
  candidates,
  labels,
}: {
  project: {
    id: string;
    key: string;
    name: string;
    description: string | null;
    isDefaultProject: boolean;
    isArchived: boolean;
  };
  members: SettingsMember[];
  candidates: SettingsMember[];
  labels: SettingsLabel[];
}) {
  const router = useRouter();
  const { toast } = useToast();

  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description ?? "");
  const [isDefaultProject, setIsDefaultProject] = useState(
    project.isDefaultProject,
  );
  const [isArchived, setIsArchived] = useState(project.isArchived);
  const [savingDetails, setSavingDetails] = useState(false);
  const [detailErrors, setDetailErrors] = useState<FieldErrors>({});

  const [memberToAdd, setMemberToAdd] = useState("");
  const [busyMember, setBusyMember] = useState<string | null>(null);

  const [labelName, setLabelName] = useState("");
  const [labelColor, setLabelColor] = useState(LABEL_COLOURS[0]!);
  const [savingLabel, setSavingLabel] = useState(false);

  async function saveDetails(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSavingDetails(true);
    setDetailErrors({});

    const result = await updateProject({
      projectId: project.id,
      name,
      description,
      isDefaultProject,
      isArchived,
    });

    setSavingDetails(false);

    if (!result.ok) {
      setDetailErrors(result.fieldErrors ?? {});
      toast(result.error, "error");
      return;
    }

    toast("Project details saved");
    router.refresh();
  }

  async function addMember(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!memberToAdd) return;

    setBusyMember(memberToAdd);
    const result = await addProjectMember({
      projectId: project.id,
      userId: memberToAdd,
    });
    setBusyMember(null);

    if (!result.ok) {
      toast(result.error, "error");
      return;
    }

    setMemberToAdd("");
    toast("Member added");
    router.refresh();
  }

  async function removeMember(userId: string, memberName: string) {
    setBusyMember(userId);
    const result = await removeProjectMember({ projectId: project.id, userId });
    setBusyMember(null);

    if (!result.ok) {
      toast(result.error, "error");
      return;
    }

    toast(`${memberName} removed from ${project.key}`);
    router.refresh();
  }

  async function addLabel(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSavingLabel(true);

    const result = await createLabel({
      projectId: project.id,
      name: labelName,
      color: labelColor,
    });

    setSavingLabel(false);

    if (!result.ok) {
      toast(result.error, "error");
      return;
    }

    setLabelName("");
    toast(`Label “${result.data.name}” added`);
    router.refresh();
  }

  return (
    <div className="row g-4">
      {/* ------------------------------------------------------- details */}
      <div className="col-12 col-xl-6">
        <Card style={{ height: "100%" }}>
          <CardBody>
            <h2 className="prio-issue__section-title">Project details</h2>

            <form onSubmit={saveDetails}>
              <div className="prio-field">
                <label className="prio-label" htmlFor="settings-name">
                  Name
                </label>
                <input
                  id="settings-name"
                  className="prio-input"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={80}
                  required
                  aria-invalid={detailErrors.name ? true : undefined}
                />
                {detailErrors.name ? (
                  <span className="prio-error" role="alert">
                    {detailErrors.name}
                  </span>
                ) : null}
              </div>

              <div className="prio-field">
                <label className="prio-label" htmlFor="settings-key">
                  Project key
                </label>
                <input
                  id="settings-key"
                  className="prio-input prio-mono"
                  value={project.key}
                  disabled
                  style={{ maxWidth: 180 }}
                  aria-describedby="settings-key-hint"
                />
                <span className="prio-hint" id="settings-key-hint">
                  The key is immutable — every issue key ever issued in this
                  project is built from it.
                </span>
              </div>

              <div className="prio-field">
                <label className="prio-label" htmlFor="settings-description">
                  Description
                </label>
                <textarea
                  id="settings-description"
                  className="prio-textarea"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={4}
                  maxLength={2000}
                />
              </div>

              <div className="prio-field">
                <label className="prio-checkbox">
                  <input
                    type="checkbox"
                    checked={isDefaultProject}
                    onChange={(e) => setIsDefaultProject(e.target.checked)}
                  />
                  Default project for new self-registered users
                </label>
                <span className="prio-hint">
                  {isDefaultProject
                    ? "Default project: ON — everyone who creates their own Prio account joins this project automatically."
                    : "Default project: OFF — new self-registered accounts do not join this project automatically."}
                </span>
              </div>

              <div className="prio-field">
                <label className="prio-checkbox">
                  <input
                    type="checkbox"
                    checked={isArchived}
                    onChange={(e) => setIsArchived(e.target.checked)}
                  />
                  Archived
                </label>
                <span className="prio-hint">
                  {isArchived
                    ? "This project is archived — hidden from the project list, board switcher and sidebar for everyone. Uncheck and save to restore it."
                    : "Archiving hides this project everywhere in Prio without deleting anything. It can always be restored here."}
                </span>
              </div>

              <Button type="submit" variant="primary" loading={savingDetails}>
                Save details
              </Button>
            </form>
          </CardBody>
        </Card>
      </div>

      {/* ------------------------------------------------------- members */}
      <div className="col-12 col-xl-6">
        <Card style={{ height: "100%" }}>
          <CardBody>
            <h2 className="prio-issue__section-title">
              Members
              <span className="prio-text-muted">{members.length}</span>
            </h2>

            {candidates.length > 0 ? (
              <form onSubmit={addMember} className="prio-settings__addrow">
                <label className="prio-visually-hidden" htmlFor="settings-add-member">
                  Add a member
                </label>
                <select
                  id="settings-add-member"
                  className="prio-select"
                  value={memberToAdd}
                  onChange={(e) => setMemberToAdd(e.target.value)}
                >
                  <option value="">Add someone to this project…</option>
                  {candidates.map((person) => (
                    <option key={person.id} value={person.id}>
                      {person.name} — {person.jobTitle ?? person.email}
                    </option>
                  ))}
                </select>
                <Button
                  type="submit"
                  variant="secondary"
                  disabled={!memberToAdd || busyMember !== null}
                >
                  <IconPlus size={13} />
                  Add
                </Button>
              </form>
            ) : (
              <p className="prio-hint">
                Everyone in the organization is already a member.
              </p>
            )}

            <div className="prio-settings__list">
              {members.map((member) => (
                <div key={member.id} className="prio-memberrow">
                  <Avatar name={member.name} image={member.image} size="md" />
                  <span className="prio-memberpicker__text">
                    <span className="prio-memberpicker__name">{member.name}</span>
                    <span className="prio-memberpicker__meta">
                      {member.jobTitle ?? member.email}
                    </span>
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => removeMember(member.id, member.name)}
                    disabled={busyMember === member.id}
                    aria-label={`Remove ${member.name} from ${project.key}`}
                  >
                    <IconTrash size={13} />
                  </Button>
                </div>
              ))}
            </div>

            <p className="prio-hint" style={{ marginTop: "var(--prio-space-4)" }}>
              Removing someone revokes their access. Work already assigned to
              them stays assigned, so nothing is silently lost.
            </p>
          </CardBody>
        </Card>
      </div>

      {/* -------------------------------------------------------- labels */}
      <div className="col-12">
        <Card>
          <CardBody>
            <h2 className="prio-issue__section-title">
              Labels
              <span className="prio-text-muted">{labels.length}</span>
            </h2>

            <form onSubmit={addLabel} className="prio-settings__addrow">
              <label className="prio-visually-hidden" htmlFor="settings-label-name">
                Label name
              </label>
              <input
                id="settings-label-name"
                className="prio-input"
                value={labelName}
                onChange={(e) => setLabelName(e.target.value)}
                placeholder="New label name"
                maxLength={40}
                required
                style={{ maxWidth: 260 }}
              />

              <div
                className="prio-settings__swatches"
                role="radiogroup"
                aria-label="Label colour"
              >
                {LABEL_COLOURS.map((colour) => (
                  <button
                    key={colour}
                    type="button"
                    role="radio"
                    aria-checked={labelColor === colour}
                    aria-label={`Colour ${colour}`}
                    className="prio-settings__swatch"
                    data-selected={labelColor === colour}
                    style={{ background: colour }}
                    onClick={() => setLabelColor(colour)}
                  />
                ))}
              </div>

              <Button
                type="submit"
                variant="secondary"
                loading={savingLabel}
                disabled={labelName.trim().length === 0}
              >
                <IconPlus size={13} />
                Add label
              </Button>
            </form>

            {labels.length === 0 ? (
              <p className="prio-hint">
                No labels yet. Labels group related work within this project.
              </p>
            ) : (
              <div className="prio-labelrow" style={{ marginTop: "var(--prio-space-4)" }}>
                {labels.map((label) => (
                  <span key={label.id} className="prio-label-chip">
                    <span
                      className="prio-label-chip__swatch"
                      style={{ background: label.color }}
                      aria-hidden
                    />
                    {label.name}
                    <span className="prio-text-muted">{label.issueCount}</span>
                  </span>
                ))}
              </div>
            )}
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
