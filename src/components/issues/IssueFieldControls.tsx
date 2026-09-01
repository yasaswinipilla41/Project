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
  allowedTransitions,
  PRIORITIES,
  PRIORITY_LABEL,
  SEVERITIES,
  SEVERITY_LABEL,
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
      {/* Only where this issue may actually go. Offering the rest and
          refusing the choice afterwards teaches people to distrust the menu;
          the server checks the same rule regardless. */}
      {allowedTransitions(status).map((option) => (
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
}: BaseProps & {
  assignee: AssignableMember | null;
  members: AssignableMember[];
}) {
  const { update, busy } = useFieldUpdate(issueId);

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
          {assignee ? (
            <span className="prio-fieldtrigger__person">
              <Avatar name={assignee.name} image={assignee.image} size="xs" />
              {assignee.name}
            </span>
          ) : (
            <span className="prio-fieldtrigger__person">
              <Avatar name={null} size="xs" empty />
              <span className="prio-text-muted">Unassigned</span>
            </span>
          )}
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
