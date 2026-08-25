"use client";

import { useState } from "react";
import { Button } from "@/components/ui/primitives";
import { IconPlus } from "@/components/ui/Icon";
import {
  CreateProjectDialog,
  type SelectableUser,
} from "./CreateProjectDialog";

/** The "New project" affordance. Admin-only — members never see it (§18). */
export function ProjectsHeaderActions({
  users,
  currentUserId,
}: {
  users: SelectableUser[];
  currentUserId: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button variant="brand" onClick={() => setOpen(true)}>
        <IconPlus />
        New project
      </Button>
      {/* Mounted only while open so every open starts from a clean form. */}
      {open ? (
        <CreateProjectDialog
          open
          onClose={() => setOpen(false)}
          users={users}
          currentUserId={currentUserId}
        />
      ) : null}
    </>
  );
}
