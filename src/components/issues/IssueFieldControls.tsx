"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Avatar } from "@/components/ui/primitives";
import { Menu, MenuItem, MenuLabel } from "@/components/ui/Menu";
import {
  PriorityIndicator,
  SeverityChip,
  StatusPill,
} from "@/components/ui/Indicators";
import { useToast } from "@/components/ui/Toast";
import { IconChevronDown } from "@/components/ui/Icon";
import {
  PRIORITIES,
  PRIORITY_LABEL,
  SEVERITIES,
  SEVERITY_LABEL,
  ISSUE_STATUSES,
  STATUS_LABEL,
} from "@/lib/domain";
import type { IssueStatus, Priority, Severity } from "@prisma/client";
import { updateIssue } from "@/server/issues";

/**
 * Inline editors on the issue detail page.
 *
 * Each control writes through `updateIssue`, so the same validation, activity
 * logging and notification rules apply as anywhere else — there is no
 * detail-page-only write path.
 */

interface BaseProps {
  issueId: string;
  disabled?: boolean;
}

function useFieldUpdate(issueId: string) {
  const router = useRouter();
  const { toast } = useToast();
  const [pending, startTransition] = useTransition();
  const [saving, setSaving] = useState(false);

  const update = (
    patch: Record<string, unknown>,
    successMessage: string,
  ): void => {
    setSaving(true);
    void (async () => {
      const result = await updateIssue({ issueId, ...patch });
      setSaving(false);

      if (!result.ok) {
        toast(result.error, "error");
        return;
      }

      toast(successMessage);
      startTransition(() => router.refresh());
    })();
  };

  return { update, busy: saving || pending };
}

/* ---------------------------------------------------------------- status */

export function StatusControl({
  issueId,
  status,
  disabled,
}: BaseProps & { status: IssueStatus }) {
  const { update, busy } = useFieldUpdate(issueId);

  return (
    <Menu
      align="start"
      width={210}
      label="Change status"
      trigger={(props) => (
        <button
          type="button"
          className="prio-fieldtrigger"
          disabled={disabled || busy}
          {...props}
        >
          <StatusPill status={status} />
          <IconChevronDown size={12} />
        </button>
      )}
    >
      <MenuLabel>Move to</MenuLabel>
      {/*
       * Every status the project has, not a subset.
       *
       * This menu used to offer only `allowedTransitions(status)`, which meant
       * a status that existed could be unreachable from where an issue happened
       * to be -- a bug filed straight to Done had no way to Reject, and nothing
       * on the page explained why the option was missing rather than merely
       * disabled. Showing the whole vocabulary and letting the person choose is
       * what was asked for; `STATUS_TRANSITIONS` still describes the ordinary
       * path and still shapes the board's drag and drop.
       */}
      {ISSUE_STATUSES.map((option) => (
        <MenuItem
          key={option}
          selected={option === status}
          onSelect={() =>
            option !== status &&
            update({ status: option }, `Moved to ${STATUS_LABEL[option]}`)
          }
        >
          <StatusPill status={option} />
        </MenuItem>
      ))}
    </Menu>
  );
}

/* -------------------------------------------------------------- priority */

export function PriorityControl({
  issueId,
  priority,
  disabled,
}: BaseProps & { priority: Priority }) {
  const { update, busy } = useFieldUpdate(issueId);

  return (
    <Menu
      align="start"
      width={190}
      label="Change priority"
      trigger={(props) => (
        <button
          type="button"
          className="prio-fieldtrigger"
          disabled={disabled || busy}
          {...props}
        >
          <PriorityIndicator priority={priority} />
          <IconChevronDown size={12} />
        </button>
      )}
    >
      <MenuLabel>Priority</MenuLabel>
      {PRIORITIES.map((option) => (
        <MenuItem
          key={option}
          selected={option === priority}
          onSelect={() =>
            option !== priority &&
            update(
              { priority: option },
              `Priority set to ${PRIORITY_LABEL[option]}`,
            )
          }
        >
          <PriorityIndicator priority={option} />
        </MenuItem>
      ))}
    </Menu>
  );
}

/* -------------------------------------------------------------- severity */

/** Bugs only — severity is meaningless on tasks and stories (§8). */
export function SeverityControl({
  issueId,
  severity,
  disabled,
}: BaseProps & { severity: Severity | null }) {
  const { update, busy } = useFieldUpdate(issueId);

  return (
    <Menu
      align="start"
      width={190}
      label="Change severity"
      trigger={(props) => (
        <button
          type="button"
          className="prio-fieldtrigger"
          disabled={disabled || busy}
          {...props}
        >
          {severity ? (
            <SeverityChip severity={severity} />
          ) : (
            <span className="prio-text-muted">Not set</span>
          )}
          <IconChevronDown size={12} />
        </button>
      )}
    >
      <MenuLabel>Severity</MenuLabel>
      {SEVERITIES.map((option) => (
        <MenuItem
          key={option}
          selected={option === severity}
          onSelect={() =>
            option !== severity &&
            update(
              { severity: option },
              `Severity set to ${SEVERITY_LABEL[option]}`,
            )
          }
        >
          <SeverityChip severity={option} />
        </MenuItem>
      ))}
    </Menu>
  );
}

/* -------------------------------------------------------------- assignee */

export interface AssignableMember {
  id: string;
  name: string;
  image: string | null;
}

export function AssigneeControl({
  issueId,
  assignee,
  members,
  disabled,
  canAssign = true,
}: BaseProps & {
  assignee: AssignableMember | null;
  members: AssignableMember[];
  /**
   * Whether this reader may decide who the work belongs to — an administrator.
   * Everybody else sees who has it and cannot change it here; a developer
   * takes work through Start / Take over instead, which only ever takes it for
   * themselves. `updateIssue` enforces the same rule, so this decides what is
   * drawn rather than what is allowed.
   */
  canAssign?: boolean;
}) {
  const { update, busy } = useFieldUpdate(issueId);

  const who = assignee ? (
    <span className="prio-fieldtrigger__person">
      <Avatar name={assignee.name} image={assignee.image} size="xs" />
      {assignee.name}
    </span>
  ) : (
    <span className="prio-fieldtrigger__person">
      <Avatar name={null} size="xs" empty />
      <span className="prio-text-muted">Unassigned</span>
    </span>
  );

  /* Still the field, still in its place in the row — just stated rather than
     offered, so the meta row does not change shape between roles. */
  if (!canAssign) {
    return (
      <span
        className="prio-fieldtrigger"
        data-readonly
        title="Only an administrator can change who this belongs to."
      >
        {who}
      </span>
    );
  }

  return (
    <Menu
      align="start"
      width={230}
      label="Change assignee"
      trigger={(props) => (
        <button
          type="button"
          className="prio-fieldtrigger"
          disabled={disabled || busy}
          {...props}
        >
          {who}
          <IconChevronDown size={12} />
        </button>
      )}
    >
      <MenuLabel>Assign to</MenuLabel>
      <MenuItem
        selected={assignee === null}
        onSelect={() =>
          assignee !== null && update({ assigneeId: "" }, "Assignee removed")
        }
        icon={<Avatar name={null} size="xs" empty />}
      >
        Unassigned
      </MenuItem>
      {members.map((member) => (
        <MenuItem
          key={member.id}
          selected={member.id === assignee?.id}
          icon={<Avatar name={member.name} image={member.image} size="xs" />}
          onSelect={() =>
            member.id !== assignee?.id &&
            update({ assigneeId: member.id }, `Assigned to ${member.name}`)
          }
        >
          {member.name}
        </MenuItem>
      ))}
    </Menu>
  );
}
