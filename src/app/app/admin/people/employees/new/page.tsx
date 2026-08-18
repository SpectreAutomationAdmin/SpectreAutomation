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

  const [departments, positions, managers] = await Promise.all([
    prisma.department.findMany({
      where: { clubId, isActive: true },
      select: { id: true, name: true, code: true },
      orderBy: { name: "asc" },
    }),
    prisma.employeePosition.findMany({
      where: { clubId, isActive: true },
      select: { id: true, name: true, code: true },
      orderBy: { name: "asc" },
    }),
    prisma.employee.findMany({
      where: { clubId, employeeLifecycle: "ACTIVE" },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        preferredName: true,
        position: { select: { name: true } },
      },
      orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
    }),
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
        departments={departments.map((d) => ({ id: d.id, label: `${d.name} (${d.code})` }))}
        positions={positions.map((p) => ({ id: p.id, label: `${p.name} (${p.code})` }))}
        managers={managers.map((m) => {
          const displayName = m.preferredName?.trim().length
            ? `${m.preferredName} ${m.lastName}`
            : `${m.firstName} ${m.lastName}`;
          const suffix = m.position?.name ? ` · ${m.position.name}` : "";
          return { id: m.id, label: `${displayName}${suffix}` };
        })}
        canCreatePosition={hasPermission(principal, clubId, "hr:employee:write")}
      />
    </div>
  );
}
