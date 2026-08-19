// Cross-cutting HR test helpers.
//
// Extends the per-slice helpers (`security-compliance/_helpers.ts`,
// `admin-workflows/_helpers.ts`, `financial-systems/_helpers.ts`) with
// a two-club fixture used by `tenant-isolation-matrix.test.ts`. Every
// non-trivial per-slice primitive is re-exported through the existing
// helpers — we do NOT duplicate seed logic.

import { prisma } from "@/lib/prisma";
import type { Principal } from "@/lib/rbac";
import type { RoleKey } from "@/lib/permissions";
import { makeClub, makeUser, principalFor } from "../../util/db";
import { makeEmployee } from "../security-compliance/_helpers";

export interface TwoClubHrFixture {
  clubA: { id: string; name: string };
  clubB: { id: string; name: string };
  employeeA: { id: string; clubId: string };
  employeeB: { id: string; clubId: string };
  // Principal in club A with the full HR write bundle (used to
  // legitimately seed rows we then attack from club B).
  seederA: Principal;
  // Principal in club B with the full HR write bundle. Since they hold
  // no membership in club A, ANY call this principal makes against an
  // entity owned by club A must be refused (either at the tenant guard
  // or at the RBAC gate).
  attackerB: Principal;
  // A super-admin — for tests that assert super-admin STILL refuses
  // cross-club member links etc. (out of scope for the general matrix
  // but useful as a sanity check).
  superAdmin: Principal;
}

function rnd() {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function makePrincipal(email: string, role: RoleKey, clubId: string | null): Promise<Principal> {
  await makeUser({ email, role, clubId });
  return principalFor(email);
}

export async function seedTwoClubsWithEmployees(): Promise<TwoClubHrFixture> {
  const clubA = await makeClub(`Twin Rivers ${rnd()}`);
  const clubB = await makeClub(`Cedarwood ${rnd()}`);
  const employeeA = await makeEmployee(clubA.id, { firstName: "Alex", lastName: "A" });
  const employeeB = await makeEmployee(clubB.id, { firstName: "Beth", lastName: "B" });

  // CLUB_ADMIN carries the widest HR write bundle at a single club
  // (every write / approve grant EXCEPT the three reveal-tier keys).
  // That covers every seed operation this suite performs (employees,
  // documents, credentials, emergency contacts, employment periods,
  // onboarding sessions/responses, compensation, payroll-profile,
  // banking approve). Reveal-tier is not needed at seed time; the
  // suite only exercises reveal from the attacker side.
  const seederA = await makePrincipal(`seeder-a-${rnd()}@example.com`, "CLUB_ADMIN", clubA.id);
  // Attacker is a CLUB_ADMIN at clubB with the same wide bundle at
  // its OWN club. Any attempt to operate on Club A entities must be
  // rejected because attackerB has no membership at Club A.
  const attackerB = await makePrincipal(`attacker-b-${rnd()}@example.com`, "CLUB_ADMIN", clubB.id);
  const superAdmin = await makePrincipal(`super-${rnd()}@example.com`, "SUPER_ADMIN", null);

  return { clubA, clubB, employeeA, employeeB, seederA, attackerB, superAdmin };
}

/**
 * Assertion helper — the promise MUST reject with any error whose
 * `code` marks it as a tenant/permission refusal (TENANT_VIOLATION,
 * FORBIDDEN, or NOT_FOUND — a NotFoundError is also acceptable
 * because service-layer reads for a wrong-tenant entity are allowed
 * to return "not found" rather than leak "wrong tenant"). The one
 * shape we NEVER accept is a successful resolution.
 */
export async function expectRefusal(promise: Promise<unknown>, label: string): Promise<void> {
  let outcome: { ok: true; value: unknown } | { ok: false; error: unknown };
  try {
    const value = await promise;
    outcome = { ok: true, value };
  } catch (err) {
    outcome = { ok: false, error: err };
  }
  if (outcome.ok) {
    throw new Error(
      `${label} — expected refusal but call resolved with: ${
        typeof outcome.value === "object" ? JSON.stringify(outcome.value) : String(outcome.value)
      }`,
    );
  }
  const err = outcome.error as { code?: string; name?: string; message?: string } | null;
  const code = err?.code;
  const name = err?.name;
  const message = err?.message ?? "";
  const acceptable =
    code === "TENANT_VIOLATION" ||
    code === "FORBIDDEN" ||
    code === "NOT_FOUND" ||
    name === "TenantViolationError" ||
    name === "ForbiddenError" ||
    name === "NotFoundError";
  if (!acceptable) {
    throw new Error(
      `${label} — refusal shape wrong; got code=${code} name=${name} message=${message}`,
    );
  }
}

/**
 * Latest AuditLog row for a given action string, or null.
 */
export async function latestAuditRow(action: string) {
  return prisma.auditLog.findFirst({
    where: { action },
    orderBy: { createdAt: "desc" },
  });
}

/**
 * Concatenate every possibly-plaintext-carrying column so leak-sweep
 * regex assertions have a single string to test against.
 */
export function auditRowFullText(
  row: { beforeJson: string | null; afterJson: string | null; metaJson: string | null } | null,
): string {
  if (!row) return "";
  return `${row.beforeJson ?? ""}|${row.afterJson ?? ""}|${row.metaJson ?? ""}`;
}
