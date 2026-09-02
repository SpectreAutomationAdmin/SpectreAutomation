"use client";

// TA-1B — Tenant Users client. Renders two sections + the invite modal.

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ROLE_LABELS, TENANT_ASSIGNABLE_ROLES } from "@/lib/tenant-admin/constants";

type TenantUserRow = {
  id: string;
  userId: string;
  name: string;
  email: string;
  userStatus: string;
  profileStatus: string;
  displayTitle: string | null;
  department: { id: string; name: string } | null;
  roleKeys: string[];
  roleLabels: string[];
  lastLoginAt: string | null;
  isTenantAdmin: boolean;
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

export function TenantUsersClient({
  clubId,
  initialUsers,
  initialInvitations,
  departments,
}: {
  clubId: string;
  initialUsers: TenantUserRow[];
  initialInvitations: InvitationRow[];
  departments: DepartmentOption[];
}) {
  const [users, setUsers] = useState<TenantUserRow[]>(initialUsers);
  const [invitations, setInvitations] = useState<InvitationRow[]>(initialInvitations);
  const [showInvite, setShowInvite] = useState(false);
  const [lastActivationUrl, setLastActivationUrl] = useState<string | null>(null);
  const [banner, setBanner] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  async function refresh() {
    const res = await fetch(`/api/clubs/${clubId}/tenant-users`);
    if (!res.ok) return;
    const j = (await res.json()) as { users: TenantUserRow[]; invitations: InvitationRow[] };
    setUsers(j.users);
    setInvitations(j.invitations);
  }

  async function handleResend(invitationId: string) {
    setBanner(null);
    const res = await fetch(`/api/clubs/${clubId}/tenant-users/invitations/${invitationId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "resend" }),
    });
    const j = (await res.json().catch(() => ({}))) as { activationUrl?: string; error?: string };
    if (!res.ok) {
      setBanner({ tone: "error", text: j.error ?? `Resend failed (HTTP ${res.status})` });
      return;
    }
    setLastActivationUrl(j.activationUrl ?? null);
    setBanner({ tone: "success", text: "Invitation resent. New activation link shown below." });
    startTransition(() => { void refresh(); router.refresh(); });
  }

  async function handleRevoke(invitationId: string) {
    if (!confirm("Revoke this invitation? The invitee will no longer be able to activate.")) return;
    setBanner(null);
    const res = await fetch(`/api/clubs/${clubId}/tenant-users/invitations/${invitationId}`, {
      method: "DELETE",
    });
    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      setBanner({ tone: "error", text: j.error ?? `Revoke failed (HTTP ${res.status})` });
      return;
    }
    setBanner({ tone: "success", text: "Invitation revoked." });
    startTransition(() => { void refresh(); router.refresh(); });
  }

  return (
    <div className="space-y-8" data-testid="tenant-users-client">
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

      {lastActivationUrl ? (
        <div
          className="rounded-md border px-4 py-3 text-sm"
          style={{ borderColor: "#c8b46e", background: "#fdf6d8", color: "#3f2f00" }}
          data-testid="tenant-users-activation-url"
        >
          <div className="font-semibold">Activation link</div>
          <p className="mt-1 text-xs">
            This link is shown once. Copy it to your email — in production, an email is dispatched
            automatically; during founder acceptance we surface the raw link so you can test end-to-end.
          </p>
          <code className="mt-2 block break-all rounded bg-white px-2 py-1 text-xs">
            {lastActivationUrl}
          </code>
        </div>
      ) : null}

      <section data-testid="tenant-users-active" className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 className="text-lg font-semibold" style={{ color: "var(--spectre-text-primary, #1a1a1a)" }}>
            Active Users
          </h2>
          <button
            type="button"
            className="rounded-md px-4 py-2 text-sm font-semibold text-white"
            style={{ background: "#1e3a2a" }}
            onClick={() => setShowInvite(true)}
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
          <div
            className="overflow-x-auto rounded-md border"
            style={{ borderColor: "var(--spectre-border-muted, #d0c9bd)" }}
          >
            <table className="w-full text-sm" data-testid="tenant-users-table">
              <thead>
                <tr style={{ background: "#f9f5eb" }}>
                  <Th>Name</Th>
                  <Th>Email</Th>
                  <Th>Title</Th>
                  <Th>Department</Th>
                  <Th>Roles</Th>
                  <Th>Tenant Admin</Th>
                  <Th>Last login</Th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id} data-testid={`tenant-user-row:${u.userId}`}>
                    <Td>
                      <div className="font-medium">{u.name}</div>
                      <div className="text-xs uppercase tracking-wide text-gray-600">
                        {u.userStatus === "ACTIVE" ? u.profileStatus : u.userStatus}
                      </div>
                    </Td>
                    <Td>{u.email}</Td>
                    <Td>{u.displayTitle ?? "—"}</Td>
                    <Td>{u.department?.name ?? "—"}</Td>
                    <Td>
                      {u.roleLabels.length ? (
                        <div className="flex flex-wrap gap-1">
                          {u.roleLabels.map((r) => (
                            <span
                              key={r}
                              className="rounded-full border px-2 py-0.5 text-xs"
                              style={{ borderColor: "#c8b46e", color: "#3f2f00" }}
                            >
                              {r}
                            </span>
                          ))}
                        </div>
                      ) : "—"}
                    </Td>
                    <Td>
                      {u.isTenantAdmin ? (
                        <span
                          className="rounded-full border px-2 py-0.5 text-xs font-semibold"
                          style={{ borderColor: "#166534", color: "#166534" }}
                          data-testid={`tenant-admin-badge:${u.userId}`}
                        >
                          Primary
                        </span>
                      ) : "—"}
                    </Td>
                    <Td>{u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleDateString() : "—"}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section data-testid="tenant-users-invitations" className="space-y-3">
        <h2 className="text-lg font-semibold" style={{ color: "var(--spectre-text-primary, #1a1a1a)" }}>
          Pending Invitations
        </h2>
        {invitations.length === 0 ? (
          <div
            className="rounded-md border p-6 text-center text-sm"
            style={{ borderColor: "#d0c9bd", color: "#4a453d" }}
            data-testid="tenant-invitations-empty"
          >
            No outstanding invitations.
          </div>
        ) : (
          <div
            className="overflow-x-auto rounded-md border"
            style={{ borderColor: "var(--spectre-border-muted, #d0c9bd)" }}
          >
            <table className="w-full text-sm" data-testid="tenant-invitations-table">
              <thead>
                <tr style={{ background: "#f9f5eb" }}>
                  <Th>Invitee</Th>
                  <Th>Title</Th>
                  <Th>Invited by</Th>
                  <Th>Status</Th>
                  <Th>Sent</Th>
                  <Th>Expires</Th>
                  <Th>Actions</Th>
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
                        style={{
                          borderColor: statusColor(inv.status),
                          color: statusColor(inv.status),
                        }}
                        data-testid={`tenant-invitation-status:${inv.id}`}
                      >
                        {inv.status}
                      </span>
                    </Td>
                    <Td className="text-xs">{inv.sentAt ? new Date(inv.sentAt).toLocaleDateString() : "—"}</Td>
                    <Td className="text-xs">{new Date(inv.expiresAt).toLocaleDateString()}</Td>
                    <Td>
                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          className="rounded-md border px-3 py-1 text-xs"
                          style={{ borderColor: "#1e3a2a", color: "#1e3a2a" }}
                          onClick={() => handleResend(inv.id)}
                          disabled={pending || inv.status === "REVOKED"}
                          data-testid={`invitation-resend-btn:${inv.id}`}
                        >
                          Resend
                        </button>
                        <button
                          type="button"
                          className="rounded-md border px-3 py-1 text-xs"
                          style={{ borderColor: "#b91c1c", color: "#b91c1c" }}
                          onClick={() => handleRevoke(inv.id)}
                          disabled={pending || inv.status === "REVOKED" || inv.status === "ACTIVATED"}
                          data-testid={`invitation-revoke-btn:${inv.id}`}
                        >
                          Revoke
                        </button>
                      </div>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {showInvite ? (
        <InviteModal
          clubId={clubId}
          departments={departments}
          onClose={() => setShowInvite(false)}
          onSuccess={(activationUrl) => {
            setShowInvite(false);
            setLastActivationUrl(activationUrl);
            setBanner({ tone: "success", text: "Invitation created. Activation link shown below." });
            startTransition(() => { void refresh(); router.refresh(); });
          }}
        />
      ) : null}
    </div>
  );
}

function statusColor(status: string): string {
  switch (status) {
    case "PENDING":
    case "SENT":
    case "OPENED":
      return "#3f2f00";
    case "ACTIVATED":
      return "#166534";
    case "REVOKED":
    case "EXPIRED":
    case "FAILED":
      return "#b91c1c";
    default:
      return "#4a453d";
  }
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th
      className="px-4 py-2 text-left text-[11px] font-semibold uppercase tracking-wide"
      style={{ color: "#6b6357" }}
    >
      {children}
    </th>
  );
}
function Td({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <td className={`px-4 py-3 align-top ${className}`}>{children}</td>;
}

function InviteModal({
  clubId,
  departments,
  onClose,
  onSuccess,
}: {
  clubId: string;
  departments: DepartmentOption[];
  onClose: () => void;
  onSuccess: (activationUrl: string) => void;
}) {
  const [email, setEmail] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [displayTitle, setDisplayTitle] = useState("");
  const [departmentId, setDepartmentId] = useState<string>("");
  const [selectedRoles, setSelectedRoles] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const roleOptions = useMemo(
    () => TENANT_ASSIGNABLE_ROLES.map((r) => ({ key: r, label: ROLE_LABELS[r] })),
    [],
  );

  function toggleRole(role: string) {
    setSelectedRoles((prev) => (prev.includes(role) ? prev.filter((r) => r !== role) : [...prev, role]));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (selectedRoles.length === 0) {
      setError("Select at least one role.");
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch(`/api/clubs/${clubId}/tenant-users`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: email.trim(),
          firstName: firstName.trim() || undefined,
          lastName: lastName.trim() || undefined,
          displayTitle: displayTitle.trim() || undefined,
          departmentId: departmentId || undefined,
          initialRoleKeys: selectedRoles,
        }),
      });
      const j = (await res.json().catch(() => ({}))) as { activationUrl?: string; error?: string };
      if (!res.ok) {
        setError(j.error ?? `Invitation failed (HTTP ${res.status})`);
        setSubmitting(false);
        return;
      }
      onSuccess(j.activationUrl ?? "");
    } catch (err) {
      setError((err as Error).message);
      setSubmitting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      data-testid="invite-modal"
    >
      <div
        className="w-full max-w-lg rounded-lg bg-white p-6 shadow-2xl"
      >
        <h2 className="mb-4 text-lg font-semibold" style={{ color: "#1a1a1a" }}>Invite an administrative user</h2>
        <form onSubmit={submit} className="space-y-4">
          <Field label="Email" required>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded border px-3 py-2 text-sm"
              style={{ borderColor: "#d0c9bd" }}
              required
              autoFocus
              data-testid="invite-form-email"
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="First name">
              <input
                type="text"
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                className="w-full rounded border px-3 py-2 text-sm"
                style={{ borderColor: "#d0c9bd" }}
                data-testid="invite-form-first-name"
              />
            </Field>
            <Field label="Last name">
              <input
                type="text"
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
                className="w-full rounded border px-3 py-2 text-sm"
                style={{ borderColor: "#d0c9bd" }}
                data-testid="invite-form-last-name"
              />
            </Field>
          </div>
          <Field label="Title (optional)">
            <input
              type="text"
              value={displayTitle}
              onChange={(e) => setDisplayTitle(e.target.value)}
              placeholder="e.g. Office Manager"
              className="w-full rounded border px-3 py-2 text-sm"
              style={{ borderColor: "#d0c9bd" }}
              data-testid="invite-form-title"
            />
          </Field>
          <Field label="Department (optional)">
            <select
              value={departmentId}
              onChange={(e) => setDepartmentId(e.target.value)}
              className="w-full rounded border px-3 py-2 text-sm"
              style={{ borderColor: "#d0c9bd" }}
              data-testid="invite-form-department"
            >
              <option value="">— None —</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>{d.name}</option>
              ))}
            </select>
          </Field>
          <Field label="Access" required>
            <div className="space-y-1 rounded border p-3" style={{ borderColor: "#d0c9bd" }} data-testid="invite-form-roles">
              {roleOptions.map((r) => (
                <label key={r.key} className="flex cursor-pointer items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={selectedRoles.includes(r.key)}
                    onChange={() => toggleRole(r.key)}
                    data-testid={`invite-form-role:${r.key}`}
                  />
                  <span>{r.label}</span>
                </label>
              ))}
            </div>
          </Field>
          {error ? (
            <div
              className="rounded-md border px-3 py-2 text-sm"
              style={{ borderColor: "#b91c1c", background: "#fef2f2", color: "#7f1d1d" }}
              data-testid="invite-form-error"
            >
              {error}
            </div>
          ) : null}
          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              className="rounded-md border px-4 py-2 text-sm"
              style={{ borderColor: "#d0c9bd", color: "#4a453d" }}
              onClick={onClose}
              disabled={submitting}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="rounded-md px-4 py-2 text-sm font-semibold text-white"
              style={{ background: submitting ? "#4a5a4f" : "#1e3a2a" }}
              disabled={submitting}
              data-testid="invite-form-submit"
            >
              {submitting ? "Sending…" : "Send invitation"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-semibold" style={{ color: "#4a453d" }}>
        {label} {required ? <span style={{ color: "#b91c1c" }}>*</span> : null}
      </span>
      {children}
    </label>
  );
}
