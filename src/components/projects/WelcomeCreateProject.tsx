"use client";

import { useState } from "react";
import {
  CreateProjectDialog,
  type SelectableUser,
} from "./CreateProjectDialog";

/**
 * "Create a new project", from the Welcome page's closing line.
 *
 * A text button rather than a second "New project" button, because the
 * directory already owns that affordance and this is a sentence, not a
 * toolbar. What it opens is the existing `CreateProjectDialog` — the same
 * form, the same `createProject` server action, the same admin-only rule and
 * the same redirect afterwards. There is no second creation path here, only a
 * second place to reach the one that exists.
 */
export function WelcomeCreateProject({
  users,
  currentUserId,
}: {
  users: SelectableUser[];
  currentUserId: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        className="prio-linkbutton"
        onClick={() => setOpen(true)}
      >
        Create a new project
      </button>
      {/* Mounted only while open, so every open starts from a clean form —
          the same rule `ProjectsHeaderActions` follows. */}
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
