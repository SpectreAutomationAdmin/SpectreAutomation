// HR-2B.5 §38 (2026-08-19) — Employee Portal Profile.
// HR-2C Portal Refinement (2026-08-24 / expanded 2026-08-28) —
// editable for employee-owned fields (personal contact, home address,
// emergency contact, direct deposit via canonical HR-1H writer).
// Club-authoritative employment / compensation / allowances /
// lifecycle remain read-only here — those are Club-side data and the
// admin surface is the only writer.

import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getEmployeePortalPrincipal } from "@/lib/employee-portal-session";
import { getActiveAssignmentsAt } from "@/lib/hr/employment-assignments";
import {
  getSelfPrimaryEmergencyContact,
  getSelfHomeAddress,
  getSelfBankMasked,
} from "@/lib/hr/portal-self-service-profile";
import {
  updatePersonalContactAction,
  upsertPrimaryEmergencyContactAction,
  updateHomeAddressAction,
  submitDirectDepositAction,
} from "./_actions";
import {
  PersonalContactSection,
  AddressSection,
  EmergencyContactSection,
  DirectDepositSection,
} from "./ProfileEditForms";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function formatEmploymentType(t: string | null): string {
  if (!t) return "—";
  return { FULL_TIME: "Full-time", PART_TIME: "Part-time", SEASONAL: "Seasonal", CONTRACT: "Contract" }[t] ?? t;
}

export default async function EmployeePortalProfilePage() {
  const principal = await getEmployeePortalPrincipal();
  if (!principal) redirect("/employee/login");

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
      hireDate: true,
      activatedAt: true,
    },
  });
  if (!employee) redirect("/employee/login");

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
  const [roleDepts, rolePositions, primaryEmergency, address, bankingMasked] = await Promise.all([
    roleDeptIds.size ? prisma.department.findMany({ where: { id: { in: [...roleDeptIds] } }, select: { id: true, name: true } }) : [],
    rolePosIds.size ? prisma.employeePosition.findMany({ where: { id: { in: [...rolePosIds] } }, select: { id: true, name: true } }) : [],
    getSelfPrimaryEmergencyContact(principal),
    getSelfHomeAddress(principal),
    getSelfBankMasked(principal),
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
  const startDate = employee.activatedAt ?? employee.hireDate ?? null;

  return (
    <div className="space-y-6" data-testid="portal-profile">
      <header>
        <h1 className="font-serif text-3xl text-club-ink">Profile</h1>
        <p className="mt-2 text-sm text-stone-500">
          Your Club record. You can update your contact, address,
          emergency contact and direct-deposit information here.
          Employment and pay information is Club-authoritative — contact
          your manager or your Club&rsquo;s HR administrator to request
          changes.
        </p>
      </header>

      {/* Personal information — identity (read-only) */}
      <section className="rounded-lg border border-stone-200 bg-white px-6 py-6" data-testid="portal-profile-personal">
        <h2 className="text-[11px] uppercase tracking-[0.2em] text-stone-500">
          Personal information
        </h2>
        <dl className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-4">
          <div>
            <div className="text-[11px] uppercase tracking-[0.2em] text-stone-500">Employee number</div>
            <div className="mt-1 text-sm text-club-ink font-mono">{employee.employeeNumber}</div>
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-[0.2em] text-stone-500">Legal name</div>
            <div className="mt-1 text-sm text-club-ink">{legalName}</div>
          </div>
          {employee.preferredName && (
            <div>
              <div className="text-[11px] uppercase tracking-[0.2em] text-stone-500">Preferred name</div>
              <div className="mt-1 text-sm text-club-ink">{employee.preferredName}</div>
            </div>
          )}
        </dl>
      </section>

      {/* Personal contact — editable */}
      <PersonalContactSection
        personalEmail={employee.personalEmail ?? null}
        mobilePhone={employee.mobilePhone ?? null}
        action={updatePersonalContactAction}
      />

      {/* Home / mailing address — editable */}
      <AddressSection address={address} action={updateHomeAddressAction} />

      {/* Emergency contact — editable */}
      <EmergencyContactSection
        contact={primaryEmergency}
        action={upsertPrimaryEmergencyContactAction}
      />

      {/* Direct deposit — masked read + secure replacement.
          Composes the canonical HR-1H submitSelfBankAccount writer;
          the portal never touches EmployeeBankAccount directly. */}
      <DirectDepositSection masked={bankingMasked} action={submitDirectDepositAction} />

      {/* Your roles — read-only, canonical current primary + additional */}
      {rolesForDisplay.length > 0 ? (
        <section
          className="rounded-lg border border-stone-200 bg-white px-6 py-6"
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
            {startDate && (
              <li className="text-xs text-stone-500 pt-1">
                Start date: {startDate.toLocaleDateString()}
              </li>
            )}
          </ul>
        </section>
      ) : (
        <section className="rounded-lg border border-stone-200 bg-white px-6 py-6">
          <h2 className="text-[11px] uppercase tracking-[0.2em] text-stone-500">Your roles</h2>
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
