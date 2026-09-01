"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Button, Card, CardBody } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/Toast";
import { IconPlus } from "@/components/ui/Icon";
import { createLabel, updateProject } from "@/server/projects";
import { LABEL_COLOURS } from "@/lib/domain";
import type { FieldErrors } from "@/server/schemas";

/**
 * Project settings (§36): details and labels.
 *
 * Membership is managed from the Admin Portal, not here — this page no
 * longer carries a Members section. The underlying `ProjectMember` rows, and
 * the `addProjectMember`/`removeProjectMember` actions behind them, are
 * deliberately left untouched: this was a UI removal, not a data change.
 *
 * Every control here calls the existing server action, which re-checks that the
 * caller is an admin. Hiding the UI from members is a convenience, not the
 * boundary.
 */

export interface SettingsLabel {
  id: string;
  name: string;
  color: string;
  issueCount: number;
}

export function ProjectSettings({
  project,
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
