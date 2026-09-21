"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Avatar } from "@/components/ui/primitives";
import { Menu, MenuItem, MenuLabel } from "@/components/ui/Menu";
import {
  PriorityIndicator,
  StatusPill,
} from "@/components/ui/Indicators";
import { useToast } from "@/components/ui/Toast";
import { IconChevronDown } from "@/components/ui/Icon";
import {
  PRIORITIES,
  PRIORITY_LABEL,
  STATUS_LABEL,
  allowedStatusesFor,
  type WorkRole,
} from "@/lib/domain";
import type { IssueStatus, Priority } from "@prisma/client";
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
  workRole,
}: BaseProps & { status: IssueStatus; workRole: WorkRole }) {
  const { update, busy } = useFieldUpdate(issueId);
  const options = allowedStatusesFor(workRole, status);

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
       * Every status this person may set, from wherever the issue is now.
       *
       * Not a workflow subset: the menu still offers the whole of what is
       * theirs regardless of where the issue sits, because a status that
       * exists being unreachable from where an issue happens to be — a bug
       * filed straight to Done with no way back — is what this deliberately
       * stopped doing. What it does exclude is what belongs to somebody else's
       * half of the job, and `updateIssue` refuses exactly the same set, so
       * this is the courtesy and not the control.
       */}
      {options.map((option) => (
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
  canEdit = true,
}: BaseProps & { priority: Priority; canEdit?: boolean }) {
  const { update, busy } = useFieldUpdate(issueId);

  /* Stated rather than offered, in the same place and the same shape the menu
     occupies — the meta row reads identically whoever is looking at it. The
     server refuses the change either way. */
  if (!canEdit) {
    return (
      <span
        className="prio-fieldtrigger"
        data-readonly
        title="How soon this is worked on is decided for you."
      >
        <PriorityIndicator priority={priority} />
      </span>
    );
  }

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

/* ---------------------------------------------------------------- effort */

/**
 * Effort and Remaining Hours, edited in place.
 *
 * Two fields rather than one, because they answer two questions: what this was
 * estimated to need, and how much of it somebody now thinks is left. The first
 * is set when the work is planned and then left alone; the second is revised
 * as the work goes, and is what a sprint's burndown is drawn from.
 *
 * Neither is "time worked". Prio does not ask anybody to log hours against a
 * work item, and these are not a back door to it: a remainder that stops
 * moving says the estimate needs revisiting, which is the conversation the
 * numbers exist to start.
 *
 * Saved on blur and on Enter rather than behind a Save button — the same way
 * the rest of this page edits — and only when the value actually changed, so
 * tabbing through writes nothing.
 */
export function EffortControl({
  issueId,
  effortHours,
  remainingHours,
  disabled,
}: BaseProps & {
  effortHours: number | null;
  remainingHours: number | null;
}) {
  const { update, busy } = useFieldUpdate(issueId);

  return (
    <span className="prio-effort">
      <HoursField
        label="Effort"
        name={`effort-${issueId}`}
        value={effortHours}
        disabled={disabled || busy}
        onCommit={(next) =>
          update(
            { effortHours: next },
            next === null ? "Estimate cleared" : `Effort set to ${next}h`,
          )
        }
      />
      <HoursField
        label="Remaining"
        name={`remaining-${issueId}`}
        value={remainingHours}
        disabled={disabled || busy}
        onCommit={(next) =>
          update(
            { remainingHours: next },
            next === null ? "Remaining cleared" : `${next}h remaining`,
          )
        }
      />
    </span>
  );
}

/** One hours box: a number, or empty for "nobody has said". */
function HoursField({
  label,
  name,
  value,
  disabled,
  onCommit,
}: {
  label: string;
  name: string;
  value: number | null;
  disabled?: boolean;
  onCommit: (next: number | null) => void;
}) {
  const asText = (v: number | null) => (v === null ? "" : String(v));
  const [text, setText] = useState(asText(value));

  /* What the server last confirmed, so a value changed elsewhere — or a save
     that was refused — is not overwritten by a stale box. */
  const [known, setKnown] = useState(asText(value));
  if (asText(value) !== known) {
    setKnown(asText(value));
    setText(asText(value));
  }

  function commit() {
    const trimmed = text.trim();
    if (trimmed === known.trim()) return;

    if (trimmed === "") {
      onCommit(null);
      return;
    }
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed) || parsed < 0) {
      setText(known);
      return;
    }
    onCommit(parsed);
  }

  return (
    <label className="prio-effort__field">
      <span className="prio-effort__label">{label}</span>
      <input
        id={name}
        type="number"
        inputMode="decimal"
        min={0}
        step="0.5"
        className="prio-input prio-effort__input"
        placeholder="—"
        value={text}
        disabled={disabled}
        onChange={(event) => setText(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            event.currentTarget.blur();
          }
          if (event.key === "Escape") setText(known);
        }}
      />
      <span className="prio-effort__unit">h</span>
    </label>
  );
}
