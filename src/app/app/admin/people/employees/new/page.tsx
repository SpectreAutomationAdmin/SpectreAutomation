// HR-2A (2026-08-16) — Add Employee page.
//
// Server component that hydrates the reference lists (departments,
// positions, current active managers) and hands them to the client
// form (`AddEmployeeForm`). Permission guard: `hr:employee:write`.
// The form itself POSTs to `/api/people/employees` — this file
// never mutates.

import Link from "next/link";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";
import AddEmployeeForm from "./AddEmployeeForm";

export default async function AddEmployeePage() {
  const principal = await getCurrentPrincipal();
  if (!principal) redirect("/login");
  const clubId = await getActiveClubId({ clubId: principal.activeClubId ?? null, role: "" });
  if (!hasPermission(principal, clubId, "hr:employee:write")) {
    redirect("/app/admin/people/employees");
  }

  // Organizational Foundation (2026-09-13) — canonical Position and
  // union manager selector. Positions come from OrganizationalPosition
  // (the canonical model); managers come from the union of Employees
  // and UserClubProfiles, deduped on the same-human link.
  const [departments, positions, managerBundle] = await Promise.all([
    prisma.department.findMany({
      where: { clubId, isActive: true },
      select: { id: true, name: true, code: true },
      orderBy: { name: "asc" },
    }),
    prisma.organizationalPosition.findMany({
      where: { clubId, isActive: true },
      select: { id: true, name: true, code: true, departmentId: true },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    }),
    (async () => {
      const { listManagerOptions } = await import("@/lib/organizational/manager-resolver");
      return listManagerOptions(clubId);
    })(),
  ]);

  return (
    <div>
      <Link
        href="/app/admin/people/employees"
        className="text-sm text-stone-500 hover:text-club-ink"
      >
        ← Employee Directory
      </Link>
      <div className="mt-3 mb-8">
        <h1 className="page-title">Add Employee</h1>
        <p className="mt-1 text-stone-500">
          Create a new pre-hire employee. After creation, the profile shell is available and
          the employee can be invited to complete onboarding.
        </p>
      </div>

      <AddEmployeeForm
        // HR-2B.3.2 §4 — user-facing label is name-only. The system
        // code remains the persistence key (id), never rendered in the
        // ordinary admin UI.
        departments={departments.map((d) => ({ id: d.id, label: d.name }))}
        positions={positions.map((p) => ({ id: p.id, label: p.name, departmentId: p.departmentId }))}
        managers={managerBundle.options.map((m) => ({
          // Encode kind + id in the option value so the server action
          // can route the write to Employee.managerEmployeeId or
          // Employee.managerProfileId.
          id: `${m.kind}:${m.id}`,
          label: m.positionName ? `${m.displayName} — ${m.positionName}` : m.displayName,
        }))}
        canCreatePosition={hasPermission(principal, clubId, "hr:employee:write")}
        canSetCompensation={hasPermission(principal, clubId, "hr:compensation:write")}
      />
    </div>
  );
}
