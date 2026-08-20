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
      employmentType: true,
      profilePhotoDocumentId: true,
      department: { select: { name: true } },
      position: { select: { name: true } },
    },
  });
  if (!employee) redirect("/employee/login");

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
        <Item label="Position">{employee.position?.name ?? "—"}</Item>
        <Item label="Department">{employee.department?.name ?? "—"}</Item>
        <Item label="Employment type">{formatEmploymentType(employee.employmentType)}</Item>
      </section>
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
