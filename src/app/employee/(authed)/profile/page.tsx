// HR-2B.5 §38 (2026-08-19) — Profile area.
//
// Read-only for HR-2B.5. Employee-self-edit of contact details is a
// future slice — for now the employee sees the Club-authoritative
// record. Compensation is NOT shown here — §14 says pay rate is
// sensitive and permission-gated even from directory reads; the
// Review page (during onboarding) is where the employee sees their
// offer.

import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getEmployeePortalPrincipal } from "@/lib/employee-portal-session";
import { getActiveAssignmentsAt } from "@/lib/hr/employment-assignments";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function formatEmploymentType(t: string | null): string {
  if (!t) return "—";
  return { FULL_TIME: "Full-time", PART_TIME: "Part-time", SEASONAL: "Seasonal", CONTRACT: "Contract" }[t] ?? t;
}

export default async function EmployeePortalProfilePage() {
  const principal = await getEmployeePortalPrincipal();
  if (!principal) redirect("/employee/login");

  // HR-2C Portal Parity (2026-08-24) — Employee identity + contact
  // only. Current position/department/employmentType come from the
  // canonical assignments, not the legacy Employee.position/department
  // fields (those go stale on primary-role changes).
  const employee = await prisma.employee.findFirst({
    where: { id: principal.employeeId, clubId: principal.clubId },
    select: {
      employeeNumber: true,
      firstName: true,
      middleName: true,
      lastName: true,
      preferredName: true,
      personalEmail: true,
      mobilePhone: true,
      profilePhotoDocumentId: true,
    },
  });
  if (!employee) redirect("/employee/login");

  // HR-2C Employment (2026-08-24) — active role assignments, read-only.
  const activeAssignments = await getActiveAssignmentsAt(principal.employeeId);
  const detailedAssignments = activeAssignments.length > 0
    ? await prisma.employeeEmploymentAssignment.findMany({
        where: { id: { in: activeAssignments.map((a) => a.id) } },
        select: {
          id: true, role: true, employmentType: true,
          departmentId: true, positionId: true, effectiveFrom: true,
        },
      })
    : [];
  const roleDeptIds = new Set(detailedAssignments.map((a) => a.departmentId).filter((v): v is string => !!v));
  const rolePosIds = new Set(detailedAssignments.map((a) => a.positionId).filter((v): v is string => !!v));
  const [roleDepts, rolePositions] = await Promise.all([
    roleDeptIds.size ? prisma.department.findMany({ where: { id: { in: [...roleDeptIds] } }, select: { id: true, name: true } }) : [],
    rolePosIds.size ? prisma.employeePosition.findMany({ where: { id: { in: [...rolePosIds] } }, select: { id: true, name: true } }) : [],
  ]);
  const deptMap = new Map(roleDepts.map((d) => [d.id, d.name]));
  const posMap = new Map(rolePositions.map((p) => [p.id, p.name]));
  const rolesForDisplay = detailedAssignments
    .sort((a, b) => (a.role === "PRIMARY" ? -1 : b.role === "PRIMARY" ? 1 : 0))
    .map((a) => ({
      id: a.id,
      role: a.role,
      positionName: a.positionId ? posMap.get(a.positionId) ?? null : null,
      departmentName: a.departmentId ? deptMap.get(a.departmentId) ?? null : null,
      employmentType: a.employmentType,
    }));

  const legalName = [employee.firstName, employee.middleName, employee.lastName].filter(Boolean).join(" ");

  return (
    <div data-testid="portal-profile">
      <h1 className="font-serif text-3xl text-club-ink">Profile</h1>
      <p className="mt-2 text-sm text-stone-500">
        Your Club record. To update personal contact information, please contact
        your manager or the Club&rsquo;s HR administrator.
      </p>

      <section className="mt-8 rounded-lg border border-stone-200 bg-white px-6 py-6 grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-4">
        <Item label="Employee number"><span className="font-mono">{employee.employeeNumber}</span></Item>
        <Item label="Legal name">{legalName}</Item>
        {employee.preferredName && <Item label="Preferred name">{employee.preferredName}</Item>}
        <Item label="Personal email">{employee.personalEmail ?? "—"}</Item>
        <Item label="Mobile phone">{employee.mobilePhone ?? "—"}</Item>
      </section>

      {rolesForDisplay.length > 0 && (
        <section
          className="mt-6 rounded-lg border border-stone-200 bg-white px-6 py-6"
          data-testid="portal-profile-roles"
        >
          <h2 className="text-[11px] uppercase tracking-[0.2em] text-stone-500">Your roles</h2>
          <ul className="mt-3 space-y-3">
            {rolesForDisplay.map((r) => (
              <li
                key={r.id}
                className="border-b border-stone-100 pb-3 last:border-b-0 last:pb-0"
                data-testid={`portal-profile-role-${r.id}`}
              >
                <div className="text-[10px] uppercase tracking-[0.16em] text-stone-500">
                  {r.role === "PRIMARY" ? "Primary" : "Additional role"}
                </div>
                <div className="mt-1 text-sm text-club-ink">
                  {r.positionName ?? "—"}
                  {r.departmentName && <span className="text-stone-500"> · {r.departmentName}</span>}
                </div>
                <div className="mt-0.5 text-xs text-stone-500">
                  {formatEmploymentType(r.employmentType)}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {rolesForDisplay.length === 0 && (
        <section className="mt-6 rounded-lg border border-stone-200 bg-white px-6 py-6">
          <h2 className="text-[11px] uppercase tracking-[0.2em] text-stone-500">Your roles</h2>
          {/* HR-2C Portal Parity (2026-08-24) — no fallback to legacy
              Employee.position/department/employmentType. Those columns
              are cache-only and get stale whenever the admin changes
              the canonical Primary Assignment. A truthful empty state
              renders instead. */}
          <p
            className="mt-3 text-sm text-stone-500"
            data-testid="portal-profile-roles-empty"
          >
            No role assigned yet. Your Club administrator will set your role.
          </p>
        </section>
      )}
    </div>
  );
}

function Item({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-[0.2em] text-stone-500">{label}</div>
      <div className="mt-1 text-sm text-club-ink">{children}</div>
    </div>
  );
}
