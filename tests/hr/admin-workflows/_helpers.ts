// Shared HR admin-workflows test helpers.
//
// Extends `tests/hr/security-compliance/_helpers.ts` with fixtures
// specific to the admin-workflows slice:
//   - a second club (for cross-tenant tests)
//   - a Member row (for Employee<->Member link tests)
//   - a super-admin principal (for global onboarding-question writes)
//   - a document upload helper

import { prisma } from "@/lib/prisma";
import type { Principal } from "@/lib/rbac";
import type { RoleKey } from "@/lib/permissions";
import { makeClub, makeMember, makeUser, principalFor } from "../../util/db";
import { makeEmployee } from "../security-compliance/_helpers";

export interface AdminHrFixture {
  club: { id: string; name: string };
  foreignClub: { id: string; name: string };
  employee: { id: string; clubId: string };
  clubAdmin: Principal;
  payrollAdmin: Principal;
  gm: Principal;
  auditor: Principal;
  superAdmin: Principal;
  foreignClubAdmin: Principal;
}

async function makePrincipal(email: string, role: RoleKey, clubId: string | null): Promise<Principal> {
  await makeUser({ email, role, clubId });
  return principalFor(email);
}

function rnd() {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export async function makeAdminHrFixture(
  primaryClubName = "Nightingale HR Club",
): Promise<AdminHrFixture> {
  const club = await makeClub(primaryClubName);
  const foreignClub = await makeClub(`Foreign ${primaryClubName} ${Math.floor(Math.random() * 999)}`);
  const employee = await makeEmployee(club.id, { firstName: "River", lastName: "Sensitive" });

  const clubAdmin = await makePrincipal(`clubadmin-${rnd()}@example.com`, "CLUB_ADMIN", club.id);
  const payrollAdmin = await makePrincipal(`payroll-${rnd()}@example.com`, "PAYROLL_ADMIN", club.id);
  const gm = await makePrincipal(`gm-${rnd()}@example.com`, "GENERAL_MANAGER", club.id);
  const auditor = await makePrincipal(`auditor-${rnd()}@example.com`, "AUDITOR_READ_ONLY", club.id);
  const superAdmin = await makePrincipal(`super-${rnd()}@example.com`, "SUPER_ADMIN", null);
  const foreignClubAdmin = await makePrincipal(`fclubadmin-${rnd()}@example.com`, "CLUB_ADMIN", foreignClub.id);

  return {
    club,
    foreignClub,
    employee,
    clubAdmin,
    payrollAdmin,
    gm,
    auditor,
    superAdmin,
    foreignClubAdmin,
  };
}

export async function makeMemberFor(clubId: string, opts?: { firstName?: string; lastName?: string }) {
  return makeMember(clubId, opts);
}

/**
 * Build the raw input a document-upload service call expects.
 * SHA-256 is fabricated deterministically so tests do not need to
 * carry real content.
 */
export function fakeDocInput(category: string, extras?: Partial<{
  storageKey: string;
  contentSha256: string;
  sizeBytes: number;
  mimeType: string;
  displayName: string;
}>) {
  const sha = extras?.contentSha256 ?? "a".repeat(64);
  return {
    category,
    storageKey: extras?.storageKey ?? `s3://test/${category}-${rnd()}`,
    contentSha256: sha,
    sizeBytes: extras?.sizeBytes ?? 1024,
    mimeType: extras?.mimeType ?? "application/pdf",
    displayName: extras?.displayName ?? null,
  };
}

export async function latestAuditForAction(action: string) {
  return prisma.auditLog.findFirst({
    where: { action },
    orderBy: { createdAt: "desc" },
  });
}
