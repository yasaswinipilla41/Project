"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";
import { Menu, MenuItem, MenuLabel } from "@/components/ui/Menu";
import { IconChevronDown } from "@/components/ui/Icon";

/**
 * Which project's sprints the directory's Iterations/Sprints block shows.
 *
 * The choice lives in the URL, the same way every other single-select filter
 * in Prio does (see `ActivityFilters`) — shareable, survives a refresh, and
 * read back by the server page rather than filtered client-side. `projects`
 * is only ever what the page itself already scoped to this reader, so
 * picking one can never name a project this reader could not already see.
 */
export function ProjectSprintPicker({
  projects,
  selectedId,
}: {
  projects: { id: string; key: string; name: string }[];
  selectedId: string | null;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();

  const selected = projects.find((project) => project.id === selectedId);

  function select(id: string) {
    const next = new URLSearchParams(params.toString());
    next.set("project", id);
    startTransition(() => {
      router.push(`${pathname}?${next.toString()}`, { scroll: false });
    });
  }

  return (
    <Menu
      align="end"
      width={230}
      label="Choose a project"
      trigger={(props) => (
        <button
          type="button"
          className="prio-filterchip"
          data-active={Boolean(selected)}
          disabled={pending}
          {...props}
        >
          {selected ? selected.name : "Choose a project"}
          <IconChevronDown size={12} />
        </button>
      )}
    >
      <MenuLabel>Project</MenuLabel>
      {projects.map((project) => (
        <MenuItem
          key={project.id}
          selected={project.id === selectedId}
          onSelect={() => select(project.id)}
        >
          {project.name}
        </MenuItem>
      ))}
    </Menu>
  );
}
