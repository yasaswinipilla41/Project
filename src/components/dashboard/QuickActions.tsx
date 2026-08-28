"use client";

import { useState } from "react";
import type { IssueType, Role } from "@prisma/client";
import { Button, ButtonLink } from "@/components/ui/primitives";
import { IconBug, IconPlus, IconProjects, IconUsers } from "@/components/ui/Icon";
import { CreateIssueDialog } from "@/components/create/CreateIssueDialog";

/**
 * Dashboard quick actions.
 *
 * Gated by the account's real role: administrative shortcuts are only rendered
 * for ADMIN. That is presentation only — the server still authorizes every one
 * of these routes and actions on its own. Hiding a button is a courtesy, never
 * the control.
 */
export function QuickActions({ role }: { role: Role }) {
  const [createType, setCreateType] = useState<IssueType | null>(null);

  return (
    <div className="prio-dash__actions">
      <Button variant="primary" onClick={() => setCreateType("TASK")}>
        <IconPlus size={14} />
        Create issue
      </Button>

      <Button variant="secondary" onClick={() => setCreateType("BUG")}>
        <IconBug size={14} />
        Report bug
      </Button>

      {role === "ADMIN" ? (
        <>
          <ButtonLink href="/projects" variant="ghost">
            <IconProjects size={14} />
            Projects
          </ButtonLink>
          <ButtonLink href="/admin" variant="ghost">
            <IconUsers size={14} />
            People
          </ButtonLink>
        </>
      ) : (
        <ButtonLink href="/my-work" variant="ghost">
          My work
        </ButtonLink>
      )}

      {/* Mounted only while open, so every open starts from a clean form. */}
      {createType ? (
        <CreateIssueDialog
          open
          defaultType={createType}
          onClose={() => setCreateType(null)}
        />
      ) : null}
    </div>
  );
}
