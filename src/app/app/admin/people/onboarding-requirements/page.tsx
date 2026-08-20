// HR-2B.4 (2026-08-19) — Admin config surface for OnboardingRequirement.
//
// Minimum viable — list + create + activate/deactivate. Sits under the
// canonical People navigation. The founder brief §24 says: reuse the
// EmployeeOnboardingQuestion architecture ONLY if it can express the
// required semantics. It can't (Q&A model, no doc/expiry/dept-position
// applicability), so we added a purpose-built OnboardingRequirement
// table + this admin surface.

import { redirect } from "next/navigation";
import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";
import { listClubOnboardingRequirements } from "@/lib/hr/onboarding-requirements";
import AdminOnboardingRequirementsClient from "./AdminOnboardingRequirementsClient";

export const dynamic = "force-dynamic";

export default async function OnboardingRequirementsAdminPage() {
  const principal = await getCurrentPrincipal();
  if (!principal) redirect("/login");
  const clubId = await getActiveClubId({ clubId: principal.activeClubId ?? null, role: "" });
  if (!hasPermission(principal, clubId, "hr:employee:write")) {
    redirect("/app/admin/people/employees");
  }

  const [requirements, departments, positions] = await Promise.all([
    listClubOnboardingRequirements(principal, clubId, { includeInactive: true }),
    prisma.department.findMany({
      where: { clubId, isActive: true },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
    prisma.employeePosition.findMany({
      where: { clubId, isActive: true },
      select: { id: true, name: true, departmentId: true },
      orderBy: { name: "asc" },
    }),
  ]);

  return (
    <div>
      <Link
        href="/app/admin/people/onboarding"
        className="text-sm text-stone-500 hover:text-club-ink"
      >
        ← Onboarding
      </Link>
      <div className="mt-3 mb-6">
        <h1 className="page-title">Onboarding Requirements</h1>
        <p className="mt-1 text-stone-500">
          Documents and credentials your Club asks new employees to provide
          during onboarding. Configure once here; each employee sees only
          the items applicable to their role.
        </p>
      </div>

      <AdminOnboardingRequirementsClient
        clubId={clubId}
        requirements={requirements.map((r) => ({
          id: r.id,
          code: r.code,
          displayName: r.displayName,
          explanation: r.explanation,
          kind: r.kind,
          documentCategory: r.documentCategory,
          appliesToAll: r.appliesToAll,
          appliesToDeptIds: (() => { try { return JSON.parse(r.appliesToDeptIds ?? "[]"); } catch { return []; } })(),
          appliesToPositionIds: (() => { try { return JSON.parse(r.appliesToPositionIds ?? "[]"); } catch { return []; } })(),
          required: r.required,
          requireExpiry: r.requireExpiry,
          active: r.active,
          displayOrder: r.displayOrder,
        }))}
        departments={departments}
        positions={positions}
      />
    </div>
  );
}
