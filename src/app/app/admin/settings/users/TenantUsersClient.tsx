"use client";

// TA-1C — Tenant Users client with three tabs:
//   People        · list of active administrative users with inline
//                    editing of title / position / department / manager
//                    (never modifies UserClubRole).
//   Invitations   · pending invitations, resend/revoke (unchanged).
//   Organization  · read-only hierarchical tree derived from
//                    reportsToProfileId; each node shows title +
//                    department + Tenant Admin badge.
//
// Access role editing is deliberately absent — organizational
// structure is display + routing input, never authorization.

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ROLE_LABELS, TENANT_ASSIGNABLE_ROLES } from "@/lib/tenant-admin/constants";
import type { OrgNode } from "@/lib/tenant-admin/org-structure";

type TenantUserRow = {
  id: string;
  userId: string;
  name: string;
  email: string;
  userStatus: string;
  profileStatus: string;
  displayTitle: string | null;
  positionId: string | null;
  positionName: string | null;
  department: { id: string; name: string } | null;
  reportsToProfileId: string | null;
  roleKeys: string[];
  roleLabels: string[];
  lastLoginAt: string | null;
  isTenantAdmin: boolean;
  hasEmployeeLink: boolean;
};

type EmployeeOption = {
  id: string;
  employeeNumber: string;
  name: string;
  email: string | null;
  lifecycle: string;
  departmentName: string | null;
  alreadyLinked: boolean;
};

type InvitationRow = {
  id: string;
  email: string;
  displayName: string | null;
  displayTitle: string | null;
  status: string;
  expiresAt: string;
  sentAt: string | null;
  createdAt: string;
  initialRoleKeys: string[];
  bootstrap: boolean;
  invitedByName: string;
  department: { id: string; name: string } | null;
};

type DepartmentOption = { id: string; name: string; code: string };
type PositionOption = {
  id: string;
  name: string;
  departmentId: string | null;
  departmentName: string | null;
  sortOrder: number;
  isActive: boolean;
};

type Tab = "people" | "invitations" | "organization";

export function TenantUsersClient({
  clubId,
  initialUsers,
  initialInvitations,
  departments,
  initialPositions,
  initialOrgTree,
  initialEmployees,
}: {
  clubId: string;
  initialUsers: TenantUserRow[];
  initialInvitations: InvitationRow[];
  departments: DepartmentOption[];
  initialPositions: PositionOption[];
  initialOrgTree: OrgNode[];
  initialEmployees: EmployeeOption[];
}) {
  const [users, setUsers] = useState<TenantUserRow[]>(initialUsers);
  const [invitations, setInvitations] = useState<InvitationRow[]>(initialInvitations);
  const [positions, setPositions] = useState<PositionOption[]>(initialPositions);
  const [orgTree, setOrgTree] = useState<OrgNode[]>(initialOrgTree);
  const [employees, setEmployees] = useState<EmployeeOption[]>(initialEmployees);
  const [tab, setTab] = useState<Tab>("people");
  const [showInvite, setShowInvite] = useState(false);
  const [banner, setBanner] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  async function refresh() {
    const res = await fetch(`/api/clubs/${clubId}/tenant-users`);
    if (!res.ok) return;
    const j = (await res.json()) as {
      users: TenantUserRow[];
      invitations: InvitationRow[];
      positions: PositionOption[];
      orgTree: OrgNode[];
      employees: EmployeeOption[];
    };
    setUsers(j.users);
    setInvitations(j.invitations);
    setPositions(j.positions);
    setOrgTree(j.orgTree);
    setEmployees(j.employees);
  }

  async function handleResend(invitationId: string) {
    setBanner(null);
    const res = await fetch(`/api/clubs/${clubId}/tenant-users/invitations/${invitationId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "resend" }),
    });
    const j = (await res.json().catch(() => ({}))) as {
      invitation?: { email?: string };
      delivery?: { status?: string; failureReason?: string | null };
      error?: string;
    };
    if (!res.ok) {
      setBanner({ tone: "error", text: j.error ?? `Resend failed (HTTP ${res.status})` });
      return;
    }
    const email = j.invitation?.email ?? "the invitee";
    setBanner(deliveryBanner(email, j.delivery, "resent"));
    startTransition(() => { void refresh(); router.refresh(); });
  }

  async function handleRevoke(invitationId: string) {
    if (!confirm("Revoke this invitation? The invitee will no longer be able to activate.")) return;
    setBanner(null);
    const res = await fetch(`/api/clubs/${clubId}/tenant-users/invitations/${invitationId}`, { method: "DELETE" });
    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      setBanner({ tone: "error", text: j.error ?? `Revoke failed (HTTP ${res.status})` });
      return;
    }
    setBanner({ tone: "success", text: "Invitation revoked." });
    startTransition(() => { void refresh(); router.refresh(); });
  }

  async function saveProfileField(
    profileId: string,
    patch: Partial<Pick<TenantUserRow, "displayTitle" | "positionId"> & { departmentId: string | null; reportsToProfileId: string | null }>,
  ) {
    setBanner(null);
    const res = await fetch(`/api/clubs/${clubId}/tenant-users/profiles/${profileId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      setBanner({ tone: "error", text: j.error ?? `Update failed (HTTP ${res.status})` });
      return false;
    }
    setBanner({ tone: "success", text: "Saved." });
    startTransition(() => { void refresh(); router.refresh(); });
    return true;
  }

  return (
    <div className="space-y-6" data-testid="tenant-users-client">
      <nav
        className="flex gap-1 border-b"
        style={{ borderColor: "var(--spectre-border-muted, #d0c9bd)" }}
        data-testid="tenant-users-tabs"
      >
        {(["people", "invitations", "organization"] as Tab[]).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className="px-4 py-2 text-sm font-medium"
            style={{
              color: tab === t ? "#1e3a2a" : "#6b6357",
              borderBottom: tab === t ? "2px solid #1e3a2a" : "2px solid transparent",
              background: "transparent",
              marginBottom: -1,
            }}
            data-testid={`tenant-users-tab:${t}`}
            aria-current={tab === t ? "page" : undefined}
          >
            {t === "people" ? "People" : t === "invitations" ? "Invitations" : "Organization"}
          </button>
        ))}
      </nav>

      {banner ? (
        <div
          className="rounded-md border px-4 py-3 text-sm"
          style={{
            borderColor: banner.tone === "success" ? "#166534" : "#b91c1c",
            background: banner.tone === "success" ? "#f0fdf4" : "#fef2f2",
            color: banner.tone === "success" ? "#14532d" : "#7f1d1d",
          }}
          data-testid="tenant-users-banner"
        >
          {banner.text}
        </div>
      ) : null}

      {tab === "people" ? (
        <PeopleTab
          users={users}
          positions={positions.filter((p) => p.isActive)}
          departments={departments}
          allProfiles={users}
          onInviteClick={() => setShowInvite(true)}
          onSaveField={saveProfileField}
          pending={pending}
        />
      ) : null}

      {tab === "invitations" ? (
        <InvitationsTab
          invitations={invitations}
          onResend={handleResend}
          onRevoke={handleRevoke}
          pending={pending}
        />
      ) : null}

      {tab === "organization" ? (
        <OrganizationTab nodes={orgTree} />
      ) : null}

      {showInvite ? (
        <InviteModal
          clubId={clubId}
          departments={departments}
          positions={positions.filter((p) => p.isActive)}
          employees={employees.filter((e) => !e.alreadyLinked)}
          onClose={() => setShowInvite(false)}
          onSuccess={(email, delivery, existingUser) => {
            setShowInvite(false);
            setBanner(deliveryBanner(email, delivery, "sent", existingUser));
            startTransition(() => { void refresh(); router.refresh(); });
          }}
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------
// People tab
// ---------------------------------------------------------------------
function PeopleTab({
  users, positions, departments, allProfiles, onInviteClick, onSaveField, pending,
}: {
  users: TenantUserRow[];
  positions: PositionOption[];
  departments: DepartmentOption[];
  allProfiles: TenantUserRow[];
  onInviteClick: () => void;
  onSaveField: (
    profileId: string,
    patch: Partial<Pick<TenantUserRow, "displayTitle" | "positionId"> & { departmentId: string | null; reportsToProfileId: string | null }>,
  ) => Promise<boolean>;
  pending: boolean;
}) {
  return (
    <section data-testid="tenant-users-active" className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="text-lg font-semibold" style={{ color: "var(--spectre-text-primary, #1a1a1a)" }}>People</h2>
        <button
          type="button"
          className="rounded-md px-4 py-2 text-sm font-semibold text-white"
          style={{ background: "#1e3a2a" }}
          onClick={onInviteClick}
          data-testid="invite-user-btn"
        >
          + Invite user
        </button>
      </div>
      {users.length === 0 ? (
        <div
          className="rounded-md border p-6 text-center text-sm"
          style={{ borderColor: "#d0c9bd", color: "#4a453d" }}
          data-testid="tenant-users-empty"
        >
          No administrative users at this Club yet. Invite someone to get started.
        </div>
      ) : (
        <div className="space-y-3">
          {users.map((u) => (
            <PersonRow
              key={u.id}
              user={u}
              positions={positions}
              departments={departments}
              allProfiles={allProfiles.filter((p) => p.id !== u.id)}
              onSaveField={onSaveField}
              pending={pending}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function PersonRow({
  user, positions, departments, allProfiles, onSaveField, pending,
}: {
  user: TenantUserRow;
  positions: PositionOption[];
  departments: DepartmentOption[];
  allProfiles: TenantUserRow[];
  onSaveField: (
    profileId: string,
    patch: Partial<Pick<TenantUserRow, "displayTitle" | "positionId"> & { departmentId: string | null; reportsToProfileId: string | null }>,
  ) => Promise<boolean>;
  pending: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(user.displayTitle ?? "");
  const [positionId, setPositionId] = useState(user.positionId ?? "");
  const [departmentId, setDepartmentId] = useState(user.department?.id ?? "");
  const [reportsToProfileId, setReportsToProfileId] = useState(user.reportsToProfileId ?? "");
  const manager = allProfiles.find((p) => p.id === user.reportsToProfileId);

  async function save() {
    const ok = await onSaveField(user.id, {
      displayTitle: title.trim() === "" ? null : title.trim(),
      positionId: positionId === "" ? null : positionId,
      departmentId: departmentId === "" ? null : departmentId,
      reportsToProfileId: reportsToProfileId === "" ? null : reportsToProfileId,
    });
    if (ok) setEditing(false);
  }

  const initials = user.name.split(/\s+/).map((w) => w[0]).filter(Boolean).slice(0, 2).join("").toUpperCase();

  return (
    <div
      className="rounded-lg border p-4"
      style={{ borderColor: "var(--spectre-border-muted, #d0c9bd)", background: "white" }}
      data-testid={`tenant-user-row:${user.userId}`}
    >
      <div className="flex items-start gap-4">
        <div
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-sm font-semibold"
          style={{ background: "#f1ead5", color: "#3f2f00" }}
          aria-hidden="true"
        >
          {initials}
        </div>
        <div className="flex-1">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <div className="text-base font-semibold" style={{ color: "#1a1a1a" }}>{user.name}</div>
            <div className="text-xs" style={{ color: "#6b6357" }}>{user.email}</div>
            {user.isTenantAdmin ? (
              <span
                className="rounded-full border px-2 py-0.5 text-[11px] font-semibold"
                style={{ borderColor: "#166534", color: "#166534" }}
                data-testid={`tenant-admin-badge:${user.userId}`}
              >
                Tenant Admin · Primary
              </span>
            ) : null}
            {user.hasEmployeeLink ? (
              <span
                className="rounded-full border px-2 py-0.5 text-[11px] font-semibold"
                style={{ borderColor: "#0f766e", color: "#0f766e" }}
                data-testid={`employee-badge:${user.userId}`}
                title="This administrative User is linked to an Employee record."
              >
                Employee
              </span>
            ) : (
              <span
                className="rounded-full border px-2 py-0.5 text-[11px]"
                style={{ borderColor: "#a8a29e", color: "#78716c" }}
                data-testid={`external-badge:${user.userId}`}
                title="External (non-employee) Spectre User."
              >
                External
              </span>
            )}
          </div>
          {editing ? (
            <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
              <label className="block">
                <span className="mb-1 block text-xs font-semibold" style={{ color: "#4a453d" }}>Position</span>
                <select
                  value={positionId}
                  onChange={(e) => setPositionId(e.target.value)}
                  className="w-full rounded border px-3 py-2 text-sm"
                  style={{ borderColor: "#d0c9bd" }}
                  data-testid={`person-position-select:${user.userId}`}
                >
                  <option value="">— None —</option>
                  {positions.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}{p.departmentName ? ` · ${p.departmentName}` : ""}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-semibold" style={{ color: "#4a453d" }}>Display title (optional override)</span>
                <input
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="e.g. Controller & Corporate Secretary"
                  className="w-full rounded border px-3 py-2 text-sm"
                  style={{ borderColor: "#d0c9bd" }}
                  data-testid={`person-title-input:${user.userId}`}
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-semibold" style={{ color: "#4a453d" }}>Department</span>
                <select
                  value={departmentId}
                  onChange={(e) => setDepartmentId(e.target.value)}
                  className="w-full rounded border px-3 py-2 text-sm"
                  style={{ borderColor: "#d0c9bd" }}
                  data-testid={`person-department-select:${user.userId}`}
                >
                  <option value="">— None —</option>
                  {departments.map((d) => (<option key={d.id} value={d.id}>{d.name}</option>))}
                </select>
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-semibold" style={{ color: "#4a453d" }}>Reports to</span>
                <select
                  value={reportsToProfileId}
                  onChange={(e) => setReportsToProfileId(e.target.value)}
                  className="w-full rounded border px-3 py-2 text-sm"
                  style={{ borderColor: "#d0c9bd" }}
                  data-testid={`person-manager-select:${user.userId}`}
                >
                  <option value="">— None —</option>
                  {allProfiles.map((p) => (<option key={p.id} value={p.id}>{p.name} — {p.displayTitle ?? p.positionName ?? "—"}</option>))}
                </select>
              </label>
              <div className="md:col-span-2 mt-1 flex flex-wrap justify-end gap-2">
                <button
                  type="button"
                  className="rounded-md border px-4 py-2 text-sm"
                  style={{ borderColor: "#d0c9bd", color: "#4a453d" }}
                  onClick={() => {
                    setEditing(false);
                    setTitle(user.displayTitle ?? "");
                    setPositionId(user.positionId ?? "");
                    setDepartmentId(user.department?.id ?? "");
                    setReportsToProfileId(user.reportsToProfileId ?? "");
                  }}
                  disabled={pending}
                >Cancel</button>
                <button
                  type="button"
                  className="rounded-md px-4 py-2 text-sm font-semibold text-white"
                  style={{ background: pending ? "#4a5a4f" : "#1e3a2a" }}
                  onClick={save}
                  disabled={pending}
                  data-testid={`person-save-btn:${user.userId}`}
                >Save</button>
              </div>
            </div>
          ) : (
            <div className="mt-2 flex flex-wrap items-center gap-x-6 gap-y-1 text-sm" style={{ color: "#4a453d" }}>
              <Field label="Title" value={user.displayTitle ?? user.positionName ?? "—"} testid={`person-title:${user.userId}`} />
              <Field label="Department" value={user.department?.name ?? "—"} testid={`person-department:${user.userId}`} />
              <Field label="Reports to" value={manager?.name ?? "—"} testid={`person-manager:${user.userId}`} />
              <div className="flex items-center gap-1">
                <span className="text-xs" style={{ color: "#6b6357" }}>Access</span>
                <div className="flex flex-wrap gap-1">
                  {user.roleLabels.length ? (
                    user.roleLabels.map((r) => (
                      <span
                        key={r}
                        className="rounded-full border px-2 py-0.5 text-[11px]"
                        style={{ borderColor: "#c8b46e", color: "#3f2f00" }}
                      >{r}</span>
                    ))
                  ) : (<span>—</span>)}
                </div>
              </div>
              <button
                type="button"
                className="ml-auto rounded-md border px-3 py-1 text-xs"
                style={{ borderColor: "#1e3a2a", color: "#1e3a2a" }}
                onClick={() => setEditing(true)}
                data-testid={`person-edit-btn:${user.userId}`}
              >Edit</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Field({ label, value, testid }: { label: string; value: string; testid?: string }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="text-xs" style={{ color: "#6b6357" }}>{label}</span>
      <span data-testid={testid}>{value}</span>
    </div>
  );
}

// ---------------------------------------------------------------------
// Invitations tab (unchanged from TA-1B closeout — copied inline)
// ---------------------------------------------------------------------
function InvitationsTab({
  invitations, onResend, onRevoke, pending,
}: {
  invitations: InvitationRow[];
  onResend: (id: string) => void | Promise<void>;
  onRevoke: (id: string) => void | Promise<void>;
  pending: boolean;
}) {
  return (
    <section data-testid="tenant-users-invitations" className="space-y-3">
      <h2 className="text-lg font-semibold" style={{ color: "var(--spectre-text-primary, #1a1a1a)" }}>Pending Invitations</h2>
      {invitations.length === 0 ? (
        <div
          className="rounded-md border p-6 text-center text-sm"
          style={{ borderColor: "#d0c9bd", color: "#4a453d" }}
          data-testid="tenant-invitations-empty"
        >No outstanding invitations.</div>
      ) : (
        <div
          className="overflow-x-auto rounded-md border"
          style={{ borderColor: "var(--spectre-border-muted, #d0c9bd)" }}
        >
          <table className="w-full text-sm" data-testid="tenant-invitations-table">
            <thead>
              <tr style={{ background: "#f9f5eb" }}>
                <Th>Invitee</Th><Th>Title</Th><Th>Invited by</Th><Th>Status</Th><Th>Sent</Th><Th>Expires</Th><Th>Actions</Th>
              </tr>
            </thead>
            <tbody>
              {invitations.map((inv) => (
                <tr key={inv.id} data-testid={`tenant-invitation-row:${inv.id}`}>
                  <Td>
                    <div className="font-medium">{inv.displayName ?? inv.email}</div>
                    <div className="text-xs text-gray-600">{inv.email}</div>
                  </Td>
                  <Td>{inv.displayTitle ?? "—"}</Td>
                  <Td className="text-xs">{inv.invitedByName}</Td>
                  <Td>
                    <span
                      className="rounded-full border px-2 py-0.5 text-xs font-semibold"
                      style={{ borderColor: statusColor(inv.status), color: statusColor(inv.status) }}
                      data-testid={`tenant-invitation-status:${inv.id}`}
                    >{inv.status}</span>
                  </Td>
                  <Td className="text-xs">{inv.sentAt ? new Date(inv.sentAt).toLocaleDateString() : "—"}</Td>
                  <Td className="text-xs">{new Date(inv.expiresAt).toLocaleDateString()}</Td>
                  <Td>
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        className="rounded-md border px-3 py-1 text-xs"
                        style={{ borderColor: "#1e3a2a", color: "#1e3a2a" }}
                        onClick={() => onResend(inv.id)}
                        disabled={pending || inv.status === "REVOKED"}
                        data-testid={`invitation-resend-btn:${inv.id}`}
                      >Resend</button>
                      <button
                        type="button"
                        className="rounded-md border px-3 py-1 text-xs"
                        style={{ borderColor: "#b91c1c", color: "#b91c1c" }}
                        onClick={() => onRevoke(inv.id)}
                        disabled={pending || inv.status === "REVOKED" || inv.status === "ACTIVATED"}
                        data-testid={`invitation-revoke-btn:${inv.id}`}
                      >Revoke</button>
                    </div>
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------
// Organization tab — read-only hierarchical tree
// ---------------------------------------------------------------------
function OrganizationTab({ nodes }: { nodes: OrgNode[] }) {
  const byParent = useMemo(() => {
    const map = new Map<string | null, OrgNode[]>();
    for (const n of nodes) {
      const key = n.reportsToProfileId;
      const arr = map.get(key) ?? [];
      arr.push(n);
      map.set(key, arr);
    }
    for (const arr of map.values()) arr.sort((a, b) => a.userName.localeCompare(b.userName));
    return map;
  }, [nodes]);

  const roots = byParent.get(null) ?? [];
  const orphans = nodes.filter((n) => n.reportsToProfileId && !nodes.some((m) => m.profileId === n.reportsToProfileId));

  return (
    <section data-testid="tenant-users-organization" className="space-y-4">
      <h2 className="text-lg font-semibold" style={{ color: "#1a1a1a" }}>Organization</h2>
      {nodes.length === 0 ? (
        <div className="rounded-md border p-6 text-center text-sm" style={{ borderColor: "#d0c9bd", color: "#4a453d" }}>
          No administrative users at this Club yet.
        </div>
      ) : (
        <div className="space-y-2">
          {roots.map((n) => (<TreeNode key={n.profileId} node={n} byParent={byParent} depth={0} />))}
          {orphans.length ? (
            <div className="mt-6 border-t pt-4" style={{ borderColor: "#d0c9bd" }}>
              <div className="mb-2 text-[11px] uppercase tracking-wide" style={{ color: "#6b6357" }}>Unlinked reports</div>
              {orphans.map((n) => (<TreeNode key={n.profileId} node={n} byParent={byParent} depth={0} />))}
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}

function TreeNode({ node, byParent, depth }: { node: OrgNode; byParent: Map<string | null, OrgNode[]>; depth: number }) {
  const children = byParent.get(node.profileId) ?? [];
  return (
    <div style={{ marginLeft: depth === 0 ? 0 : 24 }}>
      <div
        className="rounded-md border p-3"
        style={{ borderColor: "var(--spectre-border-muted, #d0c9bd)", background: "white" }}
        data-testid={`org-node:${node.profileId}`}
      >
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <div className="text-sm font-semibold" style={{ color: "#1a1a1a" }}>{node.userName}</div>
          <div className="text-xs" style={{ color: "#4a453d" }}>{node.displayTitle ?? node.positionName ?? "—"}</div>
          {node.departmentName ? (<div className="text-xs" style={{ color: "#6b6357" }}>· {node.departmentName}</div>) : null}
          {node.isTenantAdmin ? (
            <span
              className="rounded-full border px-2 py-0.5 text-[10px] font-semibold"
              style={{ borderColor: "#166534", color: "#166534" }}
            >Tenant Admin</span>
          ) : null}
        </div>
      </div>
      {children.length ? (
        <div className="mt-2 space-y-2">
          {children.map((c) => (<TreeNode key={c.profileId} node={c} byParent={byParent} depth={depth + 1} />))}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------
// Invite modal (unchanged from TA-1B closeout — copied inline)
// ---------------------------------------------------------------------
function InviteModal({
  clubId, departments, positions, employees, onClose, onSuccess,
}: {
  clubId: string;
  departments: DepartmentOption[];
  positions: PositionOption[];
  employees: EmployeeOption[];
  onClose: () => void;
  onSuccess: (
    email: string,
    delivery: { status?: string; externalSendConfirmed?: boolean; operatorAlert?: boolean; failureReason?: string | null } | undefined,
    existingUser: boolean,
  ) => void;
}) {
  const [email, setEmail] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [displayTitle, setDisplayTitle] = useState("");
  const [departmentId, setDepartmentId] = useState<string>("");
  const [selectedRoles, setSelectedRoles] = useState<string[]>([]);
  const [employmentRelationship, setEmploymentRelationship] = useState<"EMPLOYEE" | "EXTERNAL">("EMPLOYEE");
  const [employeeId, setEmployeeId] = useState<string>(""); // empty = create new pre-hire Employee
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const roleOptions = useMemo(() => TENANT_ASSIGNABLE_ROLES.map((r) => ({ key: r, label: ROLE_LABELS[r] })), []);
  const suggestedPositions = useMemo(
    () => positions.filter((p) => !departmentId || p.departmentId === departmentId).map((p) => p.name),
    [positions, departmentId],
  );
  const emailSuggestion = useMemo(() => {
    const e = email.trim().toLowerCase();
    if (!e) return null;
    return employees.find((emp) => emp.email?.toLowerCase() === e) ?? null;
  }, [email, employees]);

  function toggleRole(role: string) {
    setSelectedRoles((prev) => (prev.includes(role) ? prev.filter((r) => r !== role) : [...prev, role]));
  }
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (selectedRoles.length === 0) { setError("Select at least one role."); return; }
    setSubmitting(true);
    try {
      const res = await fetch(`/api/clubs/${clubId}/tenant-users`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: email.trim(),
          firstName: firstName.trim() || undefined,
          lastName: lastName.trim() || undefined,
          displayTitle: displayTitle.trim() || undefined,
          departmentId: departmentId || undefined,
          employmentRelationship,
          employeeId: employmentRelationship === "EMPLOYEE" && employeeId ? employeeId : undefined,
          initialRoleKeys: selectedRoles,
        }),
      });
      const j = (await res.json().catch(() => ({}))) as {
        invitation?: { email?: string };
        delivery?: { status?: string; externalSendConfirmed?: boolean; operatorAlert?: boolean; failureReason?: string | null };
        existingUser?: boolean;
        error?: string;
      };
      if (!res.ok) { setError(j.error ?? `Invitation failed (HTTP ${res.status})`); setSubmitting(false); return; }
      onSuccess(j.invitation?.email ?? email.trim(), j.delivery, Boolean(j.existingUser));
    } catch (err) { setError((err as Error).message); setSubmitting(false); }
  }

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4"
      role="dialog" aria-modal="true"
      data-testid="invite-modal"
    >
      <div className="w-full max-w-lg rounded-lg bg-white p-6 shadow-2xl">
        <h2 className="mb-4 text-lg font-semibold" style={{ color: "#1a1a1a" }}>Invite an administrative user</h2>
        <form onSubmit={submit} className="space-y-4">
          <FormField label="Email" required>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus className="w-full rounded border px-3 py-2 text-sm" style={{ borderColor: "#d0c9bd" }} data-testid="invite-form-email" />
          </FormField>
          <div className="grid grid-cols-2 gap-3">
            <FormField label="First name">
              <input type="text" value={firstName} onChange={(e) => setFirstName(e.target.value)} className="w-full rounded border px-3 py-2 text-sm" style={{ borderColor: "#d0c9bd" }} data-testid="invite-form-first-name" />
            </FormField>
            <FormField label="Last name">
              <input type="text" value={lastName} onChange={(e) => setLastName(e.target.value)} className="w-full rounded border px-3 py-2 text-sm" style={{ borderColor: "#d0c9bd" }} data-testid="invite-form-last-name" />
            </FormField>
          </div>
          <FormField label="Title (optional)">
            <input type="text" value={displayTitle} onChange={(e) => setDisplayTitle(e.target.value)} placeholder={suggestedPositions[0] ?? "e.g. Office Manager"} className="w-full rounded border px-3 py-2 text-sm" style={{ borderColor: "#d0c9bd" }} data-testid="invite-form-title" list="tenant-users-invite-title-suggestions" />
            {suggestedPositions.length ? (
              <datalist id="tenant-users-invite-title-suggestions">
                {suggestedPositions.map((n) => (<option key={n} value={n} />))}
              </datalist>
            ) : null}
          </FormField>
          <FormField label="Department (optional)">
            <select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)} className="w-full rounded border px-3 py-2 text-sm" style={{ borderColor: "#d0c9bd" }} data-testid="invite-form-department">
              <option value="">— None —</option>
              {departments.map((d) => (<option key={d.id} value={d.id}>{d.name}</option>))}
            </select>
          </FormField>
          <FormField label="Employment relationship" required>
            <div className="space-y-1 rounded border p-3" style={{ borderColor: "#d0c9bd" }} data-testid="invite-form-employment">
              <label className="flex cursor-pointer items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="employmentRelationship"
                  value="EMPLOYEE"
                  checked={employmentRelationship === "EMPLOYEE"}
                  onChange={() => setEmploymentRelationship("EMPLOYEE")}
                  data-testid="invite-employment-employee"
                />
                <span>Employee of this Club</span>
              </label>
              <label className="flex cursor-pointer items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="employmentRelationship"
                  value="EXTERNAL"
                  checked={employmentRelationship === "EXTERNAL"}
                  onChange={() => { setEmploymentRelationship("EXTERNAL"); setEmployeeId(""); }}
                  data-testid="invite-employment-external"
                />
                <span>External Spectre User (accountant, auditor, board, consultant)</span>
              </label>
            </div>
            {employmentRelationship === "EMPLOYEE" ? (
              <div className="mt-2">
                <label className="mb-1 block text-xs font-semibold" style={{ color: "#4a453d" }}>
                  Link an existing Employee record (optional — otherwise a pre-hire record is created)
                </label>
                <select
                  value={employeeId}
                  onChange={(e) => setEmployeeId(e.target.value)}
                  className="w-full rounded border px-3 py-2 text-sm"
                  style={{ borderColor: "#d0c9bd" }}
                  data-testid="invite-form-employee-picker"
                >
                  <option value="">— Create new pre-hire Employee record —</option>
                  {employees.map((emp) => (
                    <option key={emp.id} value={emp.id}>
                      {emp.name} · #{emp.employeeNumber}
                      {emp.departmentName ? ` · ${emp.departmentName}` : ""}
                      {" "}[{emp.lifecycle}]
                    </option>
                  ))}
                </select>
                {emailSuggestion ? (
                  <div
                    className="mt-2 rounded border px-3 py-2 text-xs"
                    style={{ borderColor: "#c8b46e", background: "#fdf6d8", color: "#3f2f00" }}
                    data-testid="invite-form-employee-suggestion"
                  >
                    <strong>Possible match:</strong> {emailSuggestion.name} (#{emailSuggestion.employeeNumber})
                    already has an Employee record with this email. Select them from the list above to link — do not click if these are different people.
                  </div>
                ) : null}
                <div className="mt-1 text-[11px]" style={{ color: "#6b6357" }}>
                  A new pre-hire Employee record captures name / email / department only.
                  Payroll rate, SIN, banking, and TD1 are collected later through HR onboarding.
                </div>
              </div>
            ) : null}
          </FormField>
          <FormField label="Access" required>
            <div className="space-y-1 rounded border p-3" style={{ borderColor: "#d0c9bd" }} data-testid="invite-form-roles">
              {roleOptions.map((r) => (
                <label key={r.key} className="flex cursor-pointer items-center gap-2 text-sm">
                  <input type="checkbox" checked={selectedRoles.includes(r.key)} onChange={() => toggleRole(r.key)} data-testid={`invite-form-role:${r.key}`} />
                  <span>{r.label}</span>
                </label>
              ))}
            </div>
          </FormField>
          {error ? (
            <div className="rounded-md border px-3 py-2 text-sm" style={{ borderColor: "#b91c1c", background: "#fef2f2", color: "#7f1d1d" }} data-testid="invite-form-error">{error}</div>
          ) : null}
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" className="rounded-md border px-4 py-2 text-sm" style={{ borderColor: "#d0c9bd", color: "#4a453d" }} onClick={onClose} disabled={submitting}>Cancel</button>
            <button type="submit" className="rounded-md px-4 py-2 text-sm font-semibold text-white" style={{ background: submitting ? "#4a5a4f" : "#1e3a2a" }} disabled={submitting} data-testid="invite-form-submit">{submitting ? "Sending…" : "Send invitation"}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

function FormField({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-semibold" style={{ color: "#4a453d" }}>
        {label} {required ? <span style={{ color: "#b91c1c" }}>*</span> : null}
      </span>
      {children}
    </label>
  );
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------
function statusColor(status: string): string {
  switch (status) {
    case "PENDING": case "SENT": case "OPENED": return "#3f2f00";
    case "ACTIVATED": return "#166534";
    case "REVOKED": case "EXPIRED": case "FAILED": return "#b91c1c";
    default: return "#4a453d";
  }
}
function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="px-4 py-2 text-left text-[11px] font-semibold uppercase tracking-wide" style={{ color: "#6b6357" }}>{children}</th>
  );
}
function Td({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <td className={`px-4 py-3 align-top ${className}`}>{children}</td>;
}
function deliveryBanner(
  email: string,
  delivery: { status?: string; externalSendConfirmed?: boolean; operatorAlert?: boolean; failureReason?: string | null } | undefined,
  verb: "sent" | "resent",
  existingUser?: boolean,
): { tone: "success" | "error"; text: string } {
  const suffix = existingUser ? " They already have a Spectre account and will be prompted to sign in." : "";
  if (!delivery) return { tone: "success", text: `Invitation ${verb} to ${email}.${suffix}` };
  switch (delivery.status) {
    case "DELIVERED": return { tone: "success", text: `Invitation ${verb} to ${email}.${suffix}` };
    case "DEV_LOGGED": return { tone: "success", text: `Invitation ${verb} to ${email} (console adapter — no real email dispatched).${suffix}` };
    case "FAILED": return { tone: "error", text: `We couldn't send the invitation to ${email}. ${delivery.failureReason ?? "Try again."}` };
    case "NOT_ATTEMPTED": return { tone: "error", text: `We couldn't send the invitation to ${email}. ${delivery.failureReason ?? "Delivery was skipped."}` };
    default: return { tone: "success", text: `Invitation ${verb} to ${email}.${suffix}` };
  }
}
