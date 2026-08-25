"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import {
  Alert,
  Avatar,
  Button,
  Card,
  CardBody,
} from "@/components/ui/primitives";
import { Dialog } from "@/components/ui/Dialog";
import { Menu, MenuItem, MenuLabel, MenuSeparator } from "@/components/ui/Menu";
import { useToast } from "@/components/ui/Toast";
import { IconMore, IconPlus, IconWarning } from "@/components/ui/Icon";
import { ROLE_DESCRIPTION, ROLE_LABEL } from "@/lib/domain";
import { formatRelative } from "@/lib/format";
import {
  createUser,
  resetUserPassword,
  setUserActive,
  setUserRole,
} from "@/server/users";
import type { FieldErrors } from "@/server/schemas";
import type { Role } from "@prisma/client";

export interface AdminUserRow {
  id: string;
  name: string;
  email: string;
  image: string | null;
  jobTitle: string | null;
  role: Role;
  isActive: boolean;
  createdAt: Date;
  projectCount: number;
  assignedOpen: number;
}

export interface AdminProjectOption {
  id: string;
  key: string;
  name: string;
}

export function UserAdmin({
  users,
  projects,
  currentUserId,
}: {
  users: AdminUserRow[];
  projects: AdminProjectOption[];
  currentUserId: string;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [createOpen, setCreateOpen] = useState(false);
  const [resetFor, setResetFor] = useState<AdminUserRow | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function changeRole(user: AdminUserRow, role: Role) {
    setBusyId(user.id);
    const result = await setUserRole(user.id, role);
    setBusyId(null);

    if (!result.ok) {
      toast(result.error, "error");
      return;
    }
    toast(`${user.name} is now ${ROLE_LABEL[role]}`);
    router.refresh();
  }

  async function changeActive(user: AdminUserRow, isActive: boolean) {
    setBusyId(user.id);
    const result = await setUserActive(user.id, isActive);
    setBusyId(null);

    if (!result.ok) {
      toast(result.error, "error");
      return;
    }
    toast(
      isActive
        ? `${user.name} reactivated`
        : `${user.name} deactivated — their sessions were ended`,
    );
    router.refresh();
  }

  return (
    <>
      <Card>
        <CardBody>
          <div className="prio-settings__addrow">
            <h2 className="prio-issue__section-title" style={{ margin: 0, flex: 1 }}>
              People
              <span className="prio-text-muted">{users.length}</span>
            </h2>
            <Button variant="brand" onClick={() => setCreateOpen(true)}>
              <IconPlus />
              New user
            </Button>
          </div>

          <div className="prio-table-wrap prio-scroll">
            <table className="prio-table prio-table--compact">
              <thead>
                <tr>
                  <th scope="col">Person</th>
                  <th scope="col">Role</th>
                  <th scope="col">Status</th>
                  <th scope="col">Projects</th>
                  <th scope="col">Open work</th>
                  <th scope="col">Joined</th>
                  <th scope="col">
                    <span className="prio-visually-hidden">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {users.map((user) => (
                  <tr key={user.id} data-inactive={!user.isActive}>
                    <td>
                      <span className="prio-person">
                        <Avatar name={user.name} image={user.image} size="md" />
                        <span className="prio-memberpicker__text">
                          <span className="prio-memberpicker__name">
                            {user.name}
                            {user.id === currentUserId ? (
                              <span className="prio-badge" style={{ marginLeft: 6 }}>
                                You
                              </span>
                            ) : null}
                          </span>
                          <span className="prio-memberpicker__meta">
                            {user.email}
                          </span>
                        </span>
                      </span>
                    </td>
                    <td>
                      <span className="prio-badge">{ROLE_LABEL[user.role]}</span>
                    </td>
                    <td>
                      <span
                        className="prio-status"
                        data-status={user.isActive ? "DONE" : "CANCELLED"}
                      >
                        <span className="prio-status__dot" aria-hidden />
                        {user.isActive ? "Active" : "Deactivated"}
                      </span>
                    </td>
                    <td>{user.projectCount}</td>
                    <td>
                      {user.assignedOpen > 0 ? (
                        <Link
                          href={`/issues?assignee=${user.id}&resolution=open`}
                          className="prio-admin__drilldown"
                        >
                          {user.assignedOpen}
                        </Link>
                      ) : (
                        user.assignedOpen
                      )}
                    </td>
                    <td className="prio-text-muted">
                      {formatRelative(user.createdAt)}
                    </td>
                    <td>
                      <Menu
                        align="end"
                        width={230}
                        label={`Manage ${user.name}`}
                        trigger={(props) => (
                          <button
                            type="button"
                            className="prio-btn prio-btn--ghost prio-btn--icon prio-btn--sm"
                            aria-label={`Manage ${user.name}`}
                            disabled={busyId === user.id}
                            {...props}
                          >
                            <IconMore />
                          </button>
                        )}
                      >
                        <MenuLabel>Role</MenuLabel>
                        <MenuItem
                          selected={user.role === "ADMIN"}
                          onSelect={() => changeRole(user, "ADMIN")}
                        >
                          Admin
                        </MenuItem>
                        <MenuItem
                          selected={user.role === "MEMBER"}
                          onSelect={() => changeRole(user, "MEMBER")}
                        >
                          Member
                        </MenuItem>
                        <MenuSeparator />
                        <MenuItem onSelect={() => setResetFor(user)}>
                          Reset password…
                        </MenuItem>
                        <MenuSeparator />
                        {user.isActive ? (
                          <MenuItem danger onSelect={() => changeActive(user, false)}>
                            Deactivate account
                          </MenuItem>
                        ) : (
                          <MenuItem onSelect={() => changeActive(user, true)}>
                            Reactivate account
                          </MenuItem>
                        )}
                      </Menu>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="prio-hint" style={{ marginTop: "var(--prio-space-4)" }}>
            Prio has no public sign-up. Accounts exist only because an
            administrator created one here. Deactivating an account ends its
            sessions immediately.
          </p>
        </CardBody>
      </Card>

      {createOpen ? (
        <CreateUserDialog
          projects={projects}
          onClose={() => setCreateOpen(false)}
          onCreated={() => {
            setCreateOpen(false);
            router.refresh();
          }}
        />
      ) : null}

      {resetFor ? (
        <ResetPasswordDialog
          user={resetFor}
          onClose={() => setResetFor(null)}
          onDone={() => {
            setResetFor(null);
            router.refresh();
          }}
        />
      ) : null}
    </>
  );
}

/* --------------------------------------------------------- create user */

function CreateUserDialog({
  projects,
  onClose,
  onCreated,
}: {
  projects: AdminProjectOption[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const { toast } = useToast();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [jobTitle, setJobTitle] = useState("");
  const [role, setRole] = useState<Role>("MEMBER");
  const [password, setPassword] = useState("");
  const [projectIds, setProjectIds] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState<FieldErrors>({});

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setErrors({});

    const result = await createUser({
      name,
      email,
      jobTitle,
      role,
      password,
      projectIds,
    });

    setSubmitting(false);

    if (!result.ok) {
      setErrors(result.fieldErrors ?? {});
      toast(result.error, "error");
      return;
    }

    toast(`Account created for ${result.data.email}`);
    onCreated();
  }

  return (
    <Dialog
      open
      onClose={onClose}
      busy={submitting}
      title="Create user account"
      description="Prio has no public sign-up; accounts are created here."
      footer={
        <>
          <span className="prio-dialog__footer-note">
            Share the password securely and ask them to change it.
          </span>
          <Button variant="ghost" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button
            variant="brand"
            type="submit"
            form="prio-create-user"
            loading={submitting}
          >
            Create account
          </Button>
        </>
      }
    >
      <form id="prio-create-user" onSubmit={submit} noValidate>
        <div className="prio-field">
          <label className="prio-label" htmlFor="user-name">
            Full name <span className="prio-label__required">*</span>
          </label>
          <input
            id="user-name"
            className="prio-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            maxLength={80}
            aria-invalid={errors.name ? true : undefined}
          />
          {errors.name ? (
            <span className="prio-error" role="alert">
              {errors.name}
            </span>
          ) : null}
        </div>

        <div className="prio-field">
          <label className="prio-label" htmlFor="user-email">
            Work email <span className="prio-label__required">*</span>
          </label>
          <input
            id="user-email"
            type="email"
            className="prio-input"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            aria-invalid={errors.email ? true : undefined}
          />
          {errors.email ? (
            <span className="prio-error" role="alert">
              {errors.email}
            </span>
          ) : null}
        </div>

        <div className="prio-field">
          <label className="prio-label" htmlFor="user-title">
            Job title
          </label>
          <input
            id="user-title"
            className="prio-input"
            value={jobTitle}
            onChange={(e) => setJobTitle(e.target.value)}
            maxLength={80}
          />
        </div>

        <div className="prio-field">
          <label className="prio-label" htmlFor="user-role">
            Role
          </label>
          <select
            id="user-role"
            className="prio-select"
            value={role}
            onChange={(e) => setRole(e.target.value as Role)}
          >
            <option value="MEMBER">Member</option>
            <option value="ADMIN">Admin</option>
          </select>
          <span className="prio-hint">{ROLE_DESCRIPTION[role]}</span>
        </div>

        <div className="prio-field">
          <label className="prio-label" htmlFor="user-password">
            Initial password <span className="prio-label__required">*</span>
          </label>
          <input
            id="user-password"
            type="text"
            className="prio-input prio-mono"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={8}
            autoComplete="off"
            aria-invalid={errors.password ? true : undefined}
          />
          {errors.password ? (
            <span className="prio-error" role="alert">
              {errors.password}
            </span>
          ) : null}
          <span className="prio-hint">At least 8 characters.</span>
        </div>

        {projects.length > 0 ? (
          <div className="prio-field">
            <span className="prio-label" id="user-projects-label">
              Projects
            </span>
            <div
              className="prio-chipset"
              role="group"
              aria-labelledby="user-projects-label"
            >
              {projects.map((project) => {
                const selected = projectIds.includes(project.id);
                return (
                  <button
                    key={project.id}
                    type="button"
                    className="prio-chipset__chip"
                    data-selected={selected}
                    aria-pressed={selected}
                    onClick={() =>
                      setProjectIds((prev) =>
                        selected
                          ? prev.filter((id) => id !== project.id)
                          : [...prev, project.id],
                      )
                    }
                  >
                    {project.name}
                  </button>
                );
              })}
            </div>
            {projectIds.length === 0 ? (
              <div style={{ marginTop: "var(--prio-space-3)" }}>
                <Alert tone="warning" icon={<IconWarning />}>
                  No project selected. This account won&rsquo;t be assignable
                  to any issue or bug until it belongs to a project — pick one
                  above, or add it later from that project&rsquo;s
                  Settings&nbsp;→&nbsp;Members.
                </Alert>
              </div>
            ) : null}
          </div>
        ) : null}
      </form>
    </Dialog>
  );
}

/* ------------------------------------------------------ reset password */

function ResetPasswordDialog({
  user,
  onClose,
  onDone,
}: {
  user: AdminUserRow;
  onClose: () => void;
  onDone: () => void;
}) {
  const { toast } = useToast();
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);

    const result = await resetUserPassword({ userId: user.id, password });
    setSubmitting(false);

    if (!result.ok) {
      setError(result.fieldErrors?.password ?? result.error);
      return;
    }

    toast(`Password reset for ${user.name}. Their sessions were ended.`);
    onDone();
  }

  return (
    <Dialog
      open
      onClose={onClose}
      size="sm"
      busy={submitting}
      title={`Reset password — ${user.name}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button
            variant="primary"
            type="submit"
            form="prio-reset-password"
            loading={submitting}
          >
            Reset password
          </Button>
        </>
      }
    >
      <form id="prio-reset-password" onSubmit={submit} noValidate>
        <div className="prio-field">
          <label className="prio-label" htmlFor="reset-password">
            New password <span className="prio-label__required">*</span>
          </label>
          <input
            id="reset-password"
            type="text"
            className="prio-input prio-mono"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={8}
            autoComplete="off"
            aria-invalid={error ? true : undefined}
          />
          {error ? (
            <span className="prio-error" role="alert">
              {error}
            </span>
          ) : null}
          <span className="prio-hint">
            Every existing session for this account will be ended.
          </span>
        </div>
      </form>
    </Dialog>
  );
}
