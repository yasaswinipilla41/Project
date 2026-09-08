"use client";

import { useState } from "react";
import { Button } from "@/components/ui/primitives";
import { IconPlus } from "@/components/ui/Icon";
import { CreateIssueDialog } from "@/components/create/CreateIssueDialog";
import type { WorkRole } from "@/lib/domain";

/**
 * "Create Issue" on the issue list.
 *
 * Opens the one Create dialog the rest of the app already uses — this adds an
 * entry point, not a second way to create an issue, so every field, rule and
 * permission check is whatever `CreateIssueDialog` and `createIssue` already
 * enforce.
 *
 * `defaultProjectId` comes from the list's own project filter. Someone who
 * arrived from a project (its Issues tab links to `/issues?project=<id>`) is
 * already looking at exactly one project's work, so that is the project they
 * mean; the dialog still shows the picker, and still lets them change it.
 * With no filter, or several projects filtered at once, there is no single
 * project to infer and the dialog opens unset as before.
 */
export function CreateIssueButton({
  defaultProjectId = null,
  disabled = false,
  workRole,
}: {
  defaultProjectId?: string | null;
  disabled?: boolean;
  /** Forwarded to the dialog, which shapes itself around the job. */
  workRole: WorkRole;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      {/*
       * `prio-create-issue` carries no rules of its own today — it is a
       * scope, put here on purpose. This button and the top bar's global
       * Create control are both `prio-btn prio-btn--brand`, so styling the
       * Issue module by reaching for that shared variant would repaint the
       * top bar too. Anything this button ever needs visually hangs off this
       * class instead, where it cannot travel.
       *
       * Deliberately not `prio-create`: that class already belongs to the
       * top bar's control, so borrowing it would create the very collision
       * this exists to prevent.
       */}
      <Button
        variant="brand"
        className="prio-create-issue"
        onClick={() => setOpen(true)}
        disabled={disabled}
      >
        <IconPlus />
        Create Issue
      </Button>
      {/* Mounted only while open so every open starts from a clean form. */}
      {open ? (
        <CreateIssueDialog
          open
          workRole={workRole}
          defaultProjectId={defaultProjectId}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}
