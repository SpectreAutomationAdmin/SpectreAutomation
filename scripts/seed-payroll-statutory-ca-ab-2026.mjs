// Payroll-3B-5B-1c (2026-09-02) — one-shot seeder for the CA/AB
// 2026 H1 + H2 statutory packages.
//
// Idempotent + checksum-aware. Refuses to overwrite an existing
// package with divergent content — the SUPER_ADMIN operator must
// explicitly supersede or delete the prior row before re-seeding
// with different parameters.
//
// Usage:
//   node scripts/seed-payroll-statutory-ca-ab-2026.mjs
//
// The script:
//   1. Loads the founder-verified CA_AB_2026_PARAMS_H1 / H2 from
//      src/lib/payroll/statutory/seed-ca-ab-2026.ts (compiled).
//   2. Computes the SHA-256 checksum of each package's paramsJson.
//   3. Checks whether an existing package for the same window
//      already carries the SAME checksum — if so, exits successfully
//      (idempotent no-op).
//   4. If any existing package carries a DIFFERENT checksum for the
//      same window, exits with a clear conflict message and DOES NOT
//      overwrite.
//   5. Otherwise invokes `installStatutoryPackage` with a
//      SUPER_ADMIN principal loaded from the local DB.
//
// Never invokes on staging automatically — this is a manual step,
// gated on the founder's checkpoint approval for the Payroll
// staging acceptance run.

import { createHash } from "node:crypto";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const [{ CA_AB_2026_PARAMS_H1, CA_AB_2026_PARAMS_H2 }, { installStatutoryPackage }, { assertValidCanadianParamsV1 }] =
    await Promise.all([
      import("../src/lib/payroll/statutory/seed-ca-ab-2026.ts"),
      import("../src/lib/payroll/statutory-package.ts"),
      import("../src/lib/payroll/statutory-package.ts"),
    ]);

  // Validate before checksum — never install a malformed shape.
  assertValidCanadianParamsV1(CA_AB_2026_PARAMS_H1);
  assertValidCanadianParamsV1(CA_AB_2026_PARAMS_H2);

  const h1Json = JSON.stringify(CA_AB_2026_PARAMS_H1);
  const h2Json = JSON.stringify(CA_AB_2026_PARAMS_H2);
  const h1Checksum = createHash("sha256").update(h1Json).digest("hex");
  const h2Checksum = createHash("sha256").update(h2Json).digest("hex");

  console.log("Payroll-3B-5B-1c CA/AB 2026 seeder");
  console.log("  H1 checksum:", h1Checksum);
  console.log("  H2 checksum:", h2Checksum);

  // Resolve a SUPER_ADMIN principal for the audit trail.
  const superAdminUser = await prisma.user.findFirst({
    where: { role: "SUPER_ADMIN" },
    include: { clubRoles: true },
  });
  if (!superAdminUser) {
    console.error("Refuse: no SUPER_ADMIN user exists in this DB. Create one before seeding statutory packages.");
    process.exit(1);
  }
  const principal = {
    id: superAdminUser.id,
    name: superAdminUser.name,
    email: superAdminUser.email,
    status: superAdminUser.status,
    memberships: superAdminUser.clubRoles.map((r) => ({ clubId: r.clubId, roleKey: r.roleKey })),
    activeClubId: null,
    memberId: null,
  };

  // Idempotency + conflict guard.
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

  // Install any missing packages.
  if (!existingH1) {
    const r = await installStatutoryPackage(principal, {
      jurisdictionCountry: "CA",
      jurisdictionProvince: "AB",
      effectiveFrom: new Date(Date.UTC(2026, 0, 1)),
      effectiveTo: new Date(Date.UTC(2026, 6, 1)),
      packageVersion: "CRA-T4127-122E-CA-AB-2026-H1",
      algorithmVersion: "v1",
      sourcePublication: "T4127 Payroll Deductions Formulas + T4032-AB + Government of Canada 2026 CPP/EI + 2026 Federal/Alberta TD1",
      sourceEdition: "122nd Edition",
      sourcePublicationDate: new Date(Date.UTC(2025, 11, 1)),
      sourceUrl: "https://www.canada.ca/en/revenue-agency/services/forms-publications/payroll/t4127-payroll-deductions-formulas.html",
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
      sourcePublication: "T4127 Payroll Deductions Formulas + T4032-AB + Government of Canada 2026 CPP/EI + 2026 Federal/Alberta TD1",
      sourceEdition: "123rd Edition",
      sourcePublicationDate: new Date(Date.UTC(2026, 5, 1)),
      sourceUrl: "https://www.canada.ca/en/revenue-agency/services/forms-publications/payroll/t4127-payroll-deductions-formulas.html",
      params: CA_AB_2026_PARAMS_H2,
    });
    console.log(`  H2: installed id=${r.id} checksum=${r.checksum}`);
  }

  console.log("Seeder complete.");
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
