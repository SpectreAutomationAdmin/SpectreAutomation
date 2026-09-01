// Payroll-3B-5B-1d CORRECTION (2026-08-31) — one-shot seeder for
// the CA/AB 2026 H1 + H2 statutory packages.
//
// Idempotent + checksum-aware. Refuses to overwrite an existing
// package with divergent content — the SUPER_ADMIN operator must
// explicitly supersede or delete the prior row before re-seeding
// with different parameters.
//
// Usage (from repo root, tsx already declared in devDependencies):
//   npx tsx scripts/seed-payroll-statutory-ca-ab-2026.ts
//
// This is a .ts script because it imports typed statutory-package
// modules directly; Node's bare .mjs loader does not resolve TS.
// Never invoked on staging automatically — this is a manual step,
// gated on the founder's checkpoint approval for the Payroll
// staging acceptance run.

import { createHash } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { CA_AB_2026_PARAMS_H1, CA_AB_2026_PARAMS_H2 } from "../src/lib/payroll/statutory/seed-ca-ab-2026";
import { installStatutoryPackage, assertValidCanadianParamsV1 } from "../src/lib/payroll/statutory-package";
import type { Principal } from "../src/lib/rbac";
import type { RoleKey } from "../src/lib/permissions";

const prisma = new PrismaClient();

async function main() {
  // Validate before checksum — never install a malformed shape.
  assertValidCanadianParamsV1(CA_AB_2026_PARAMS_H1);
  assertValidCanadianParamsV1(CA_AB_2026_PARAMS_H2);

  const h1Json = JSON.stringify(CA_AB_2026_PARAMS_H1);
  const h2Json = JSON.stringify(CA_AB_2026_PARAMS_H2);
  const h1Checksum = createHash("sha256").update(h1Json).digest("hex");
  const h2Checksum = createHash("sha256").update(h2Json).digest("hex");

  console.log("Payroll-3B-5B-1d CORRECTION CA/AB 2026 seeder");
  console.log("  H1 checksum:", h1Checksum);
  console.log("  H2 checksum:", h2Checksum);

  const superAdminUser = await prisma.user.findFirst({
    where: { role: "SUPER_ADMIN" },
    include: { clubRoles: true },
  });
  if (!superAdminUser) {
    console.error(
      "Refuse: no SUPER_ADMIN user exists in this DB. Create one before seeding statutory packages.",
    );
    process.exit(1);
  }
  const principal: Principal = {
    id: superAdminUser.id,
    name: superAdminUser.name,
    email: superAdminUser.email,
    status: superAdminUser.status,
    memberships: superAdminUser.clubRoles.map((r) => ({ clubId: r.clubId, roleKey: r.roleKey as RoleKey })),
    activeClubId: null,
    memberId: null,
  };

  const [existingH1, existingH2] = await Promise.all([
    prisma.payrollStatutoryPackage.findFirst({
      where: {
        jurisdictionCountry: "CA",
        jurisdictionProvince: "AB",
        effectiveFrom: new Date(Date.UTC(2026, 0, 1)),
      },
    }),
    prisma.payrollStatutoryPackage.findFirst({
      where: {
        jurisdictionCountry: "CA",
        jurisdictionProvince: "AB",
        effectiveFrom: new Date(Date.UTC(2026, 6, 1)),
      },
    }),
  ]);

  if (existingH1) {
    if (existingH1.checksum === h1Checksum) {
      console.log("  H1: already installed with matching checksum — no-op.");
    } else {
      console.error(
        `Refuse: existing H1 package ${existingH1.id} carries checksum ${existingH1.checksum} — ` +
          `different from the seed's ${h1Checksum}. Supersede or delete the row explicitly before re-seeding.`,
      );
      process.exit(2);
    }
  }
  if (existingH2) {
    if (existingH2.checksum === h2Checksum) {
      console.log("  H2: already installed with matching checksum — no-op.");
    } else {
      console.error(
        `Refuse: existing H2 package ${existingH2.id} carries checksum ${existingH2.checksum} — ` +
          `different from the seed's ${h2Checksum}. Supersede or delete the row explicitly before re-seeding.`,
      );
      process.exit(2);
    }
  }

  if (!existingH1) {
    const r = await installStatutoryPackage(principal, {
      jurisdictionCountry: "CA",
      jurisdictionProvince: "AB",
      effectiveFrom: new Date(Date.UTC(2026, 0, 1)),
      effectiveTo: new Date(Date.UTC(2026, 6, 1)),
      packageVersion: "CRA-T4127-122E-CA-AB-2026-H1",
      algorithmVersion: "v1",
      sourcePublication:
        "T4127 Payroll Deductions Formulas + T4032-AB + Government of Canada 2026 CPP/EI + 2026 Federal/Alberta TD1",
      sourceEdition: "122nd Edition",
      sourcePublicationDate: new Date(Date.UTC(2025, 11, 1)),
      sourceUrl:
        "https://www.canada.ca/en/revenue-agency/services/forms-publications/payroll/t4127-payroll-deductions-formulas.html",
      params: CA_AB_2026_PARAMS_H1,
    });
    console.log(`  H1: installed id=${r.id} checksum=${r.checksum}`);
  }
  if (!existingH2) {
    const r = await installStatutoryPackage(principal, {
      jurisdictionCountry: "CA",
      jurisdictionProvince: "AB",
      effectiveFrom: new Date(Date.UTC(2026, 6, 1)),
      effectiveTo: new Date(Date.UTC(2027, 0, 1)),
      packageVersion: "CRA-T4127-123E-CA-AB-2026-H2",
      algorithmVersion: "v1",
      sourcePublication:
        "T4127 Payroll Deductions Formulas + T4032-AB + Government of Canada 2026 CPP/EI + 2026 Federal/Alberta TD1",
      sourceEdition: "123rd Edition",
      sourcePublicationDate: new Date(Date.UTC(2026, 5, 1)),
      sourceUrl:
        "https://www.canada.ca/en/revenue-agency/services/forms-publications/payroll/t4127-payroll-deductions-formulas.html",
      params: CA_AB_2026_PARAMS_H2,
    });
    console.log(`  H2: installed id=${r.id} checksum=${r.checksum}`);
  }

  console.log("Seeder complete.");
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
