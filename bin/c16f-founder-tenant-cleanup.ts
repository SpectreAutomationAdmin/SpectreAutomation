#!/usr/bin/env tsx
// Sprint 3 · Checkpoint 16F revised (2026-08-04) — founder-review
// tenant cleanup.
//
// Coulee Ridge is the sole staging / demo / founder-review tenant.
// This script removes the SYNTHETIC OPERATIONAL WRAPPERS
// (Work Intake cards, fixture Members + AR balances, fixture
// Vendors + APInvoices, fixture statements) from Coulee Ridge while
// PRESERVING the underlying regression IngestedDocuments in place on
// Coulee Ridge and capturing a per-SHA-256 RegressionExpectation so
// the benchmark runner can still evaluate them.
//
// Regression documents remain readable + benchmarkable on Coulee
// Ridge — they simply no longer materialise as visible Work Intake
// items, Members, Vendors, or AR balances.
//
// Preserves:
//   - real founder-sent Outlook attachments (Oakcreek, Oxio,
//     Microsoft, CPA Alberta, etc.)
//   - real system-generated Work Intake tied to those documents
//   - real Vendors backed by real invoices with no fixture markers
//
// Removes / suppresses:
//   - Work Intake items with fixture subject markers
//     (Verification-Invoice / C15D-Verify / c15h / c15g /
//      test baseline / ninety day / sixty day / onetwenty day)
//   - Work Intake items with a fixture classificationRuleKey
//   - Work Intake items with zero origins (orphans)
//   - AR-aging Work Intake items whose Member origin is a
//     @fixture.test member
//   - Fixture Members (@fixture.test) + MemberAccount rows
//   - Fixture Vendors (V-c15h-fixture-*) + APInvoice rows
//
// Refuses production. Defaults to --dry-run.
//
// Usage:
//   npx tsx bin/c16f-founder-tenant-cleanup.ts \
//     --founder-club=<coulee-ridge-id> \
//     [--dry-run|--apply]

import { prisma } from "../src/lib/prisma";

interface CleanupPlan {
  founderClubId: string;
  apply: boolean;
}

function parseArgs(argv: string[]): CleanupPlan {
  let founderClubId: string | null = null;
  let apply = false;
  for (const a of argv) {
    if (a.startsWith("--founder-club=")) founderClubId = a.slice("--founder-club=".length);
    else if (a === "--apply") apply = true;
    else if (a === "--dry-run") apply = false;
  }
  if (!founderClubId) {
    console.error("REFUSED: --founder-club=<id> required");
    process.exit(2);
  }
  return { founderClubId, apply };
}

function refuseProduction() {
  const appUrl = (process.env.APP_URL ?? "").toLowerCase();
  const isProdUrl = appUrl.includes("production") ||
    (appUrl.includes("spectreautomation.com") && !appUrl.includes("staging"));
  if (isProdUrl || process.env.NODE_ENV === "production") {
    console.error(`REFUSED: production environment (APP_URL=${appUrl}, NODE_ENV=${process.env.NODE_ENV})`);
    process.exit(3);
  }
  const dbUrl = process.env.DATABASE_URL ?? "";
  const dbHost = (() => { try { return new URL(dbUrl).hostname; } catch { return ""; } })();
  if (/\bprod(uction)?\b/i.test(dbHost)) {
    console.error(`REFUSED: DATABASE_URL host looks like production (${dbHost}).`);
    process.exit(4);
  }
}

async function main() {
  const plan = parseArgs(process.argv.slice(2));
  refuseProduction();

  const founder = await prisma.club.findUnique({
    where: { id: plan.founderClubId },
    select: { id: true, slug: true, name: true, isDemoTenant: true, stagingDataMode: true },
  });
  if (!founder) { console.error("REFUSED: founder club not found"); process.exit(5); }
  // Guard: must be a staging/founder-review club, not production.
  if (founder.stagingDataMode !== "FOUNDER_REVIEW" && founder.stagingDataMode !== "REGRESSION") {
    console.error(
      `REFUSED: club ${founder.slug} has stagingDataMode=${founder.stagingDataMode}. ` +
      `Cleanup only runs on FOUNDER_REVIEW or REGRESSION tenants.`,
    );
    process.exit(6);
  }

  console.log(`Founder-review club: ${founder.slug} (${founder.name})`);
  console.log(`  stagingDataMode=${founder.stagingDataMode}, isDemoTenant=${founder.isDemoTenant}`);
  console.log(`Mode:                ${plan.apply ? "APPLY" : "DRY-RUN"}`);
  console.log(``);

  // -------------------------------------------------------------------------
  // Identify targets from the 16E inventory buckets.
  // -------------------------------------------------------------------------

  const fixtureMembers = await prisma.member.findMany({
    where: { clubId: founder.id, email: { endsWith: "@fixture.test" } },
    select: { id: true, firstName: true, lastName: true, email: true },
  });
  const fixtureMemberIds = new Set(fixtureMembers.map((m) => m.id));

  const fixtureVendors = await prisma.vendor.findMany({
    where: { clubId: founder.id, vendorNumber: { startsWith: "V-c15h-fixture-" } },
    select: { id: true, vendorNumber: true, legalName: true },
  });

  const allWorkIntakes = await prisma.workIntakeItem.findMany({
    where: { clubId: founder.id },
    select: {
      id: true, classification: true, status: true,
      displaySubject: true, displaySender: true, classificationRuleKey: true,
      origins: { select: { kind: true, referenceId: true } },
      apIntakeSourcesForCanonical: { select: { id: true, ingestedDocumentId: true } },
    },
  });

  const workIntakesToRemove: Array<{
    id: string; classification: string; subject: string;
    reason: string; supportingIngestedDocumentIds: string[];
  }> = [];
  for (const w of allWorkIntakes) {
    const supportingDocs = w.apIntakeSourcesForCanonical.map((s) => s.ingestedDocumentId);
    const subj = (w.displaySubject ?? "").toLowerCase();
    const isFixtureSubject = /verification-invoice|c15d-verify|c15h|c15g|test baseline|ninety day|sixty day|onetwenty day/i.test(subj);
    const isFixtureRuleKey = /c15h-fixture|c15g/.test(w.classificationRuleKey ?? "");
    const isOrphan = w.origins.length === 0;
    const isArAgingFixture = w.classification?.startsWith("AR_AGING_") &&
      w.origins.some((o) => o.kind === "MEMBER" && fixtureMemberIds.has(o.referenceId));

    if (isFixtureSubject) {
      workIntakesToRemove.push({ id: w.id, classification: w.classification ?? "", subject: subj.slice(0, 60), reason: "fixture_subject_marker", supportingIngestedDocumentIds: supportingDocs });
    } else if (isFixtureRuleKey) {
      workIntakesToRemove.push({ id: w.id, classification: w.classification ?? "", subject: subj.slice(0, 60), reason: "fixture_rule_key", supportingIngestedDocumentIds: supportingDocs });
    } else if (isOrphan) {
      workIntakesToRemove.push({ id: w.id, classification: w.classification ?? "", subject: subj.slice(0, 60), reason: "orphan_no_origins", supportingIngestedDocumentIds: supportingDocs });
    } else if (isArAgingFixture) {
      workIntakesToRemove.push({ id: w.id, classification: w.classification ?? "", subject: subj.slice(0, 60), reason: "ar_aging_fixture_member", supportingIngestedDocumentIds: supportingDocs });
    }
  }

  // Collect IngestedDocuments supporting the fixture work — these
  // remain on Coulee Ridge but each will get a RegressionExpectation.
  const regressionDocIds = new Set<string>();
  for (const w of workIntakesToRemove) {
    for (const d of w.supportingIngestedDocumentIds) regressionDocIds.add(d);
    const full = allWorkIntakes.find((x) => x.id === w.id);
    for (const o of full?.origins ?? []) {
      if (o.kind === "INGESTED_DOCUMENT") regressionDocIds.add(o.referenceId);
    }
  }
  const regressionDocsList = await prisma.ingestedDocument.findMany({
    where: { id: { in: [...regressionDocIds] }, clubId: founder.id },
    select: { id: true, filename: true, sha256Hash: true },
  });

  console.log(`=== TARGETS ===`);
  console.log(`Fixture Members:                 ${fixtureMembers.length}`);
  for (const m of fixtureMembers) console.log(`  · ${m.firstName} ${m.lastName} <${m.email}>`);
  console.log(`Fixture Vendors:                 ${fixtureVendors.length}`);
  for (const v of fixtureVendors) console.log(`  · ${v.vendorNumber} — ${v.legalName}`);
  console.log(`Work Intake items to remove:     ${workIntakesToRemove.length}`);
  const byReason: Record<string, number> = {};
  for (const w of workIntakesToRemove) byReason[w.reason] = (byReason[w.reason] ?? 0) + 1;
  for (const [r, n] of Object.entries(byReason)) console.log(`    ${r}: ${n}`);
  console.log(`IngestedDocuments preserved      ${regressionDocsList.length}`);
  console.log(`  (as regression assets on Coulee Ridge; NOT moved,`);
  console.log(`   NOT deleted — each gets a RegressionExpectation)`);

  if (!plan.apply) {
    console.log(``);
    console.log(`[DRY-RUN] Nothing written. Rerun with --apply to execute.`);
    await prisma.$disconnect();
    return;
  }

  console.log(``);
  console.log(`=== EXECUTING ===`);

  // 1. Capture RegressionExpectation for every supporting doc.
  //    Category inferred from filename; expected fields left null
  //    (curation pass fills them in later per §7). The runner treats
  //    null expected fields as "not asserted" and only reports the
  //    dimensions with expectations set.
  const upsertedExpectations: string[] = [];
  for (const doc of regressionDocsList) {
    const name = doc.filename ?? "";
    const category = /verification/i.test(name) ? "VERIFICATION_FIXTURE"
      : /c15h/i.test(name) ? "AP_FIXTURE_C15H"
      : /c15g/i.test(name) ? "STATEMENT_FIXTURE_C15G"
      : /oakcreek|oxio|microsoft|cpa/i.test(name) ? "REAL_REGRESSION"
      : "UNCATEGORIZED";
    const label = (doc.filename ?? doc.sha256Hash).slice(0, 80);
    try {
      await prisma.regressionExpectation.upsert({
        where: { documentSha256: doc.sha256Hash },
        create: {
          documentSha256: doc.sha256Hash, label, category,
          notes: `captured_by_16f_cleanup:founder=${founder.slug}`,
        },
        update: {},   // preserve any manual curation on re-runs
      });
      upsertedExpectations.push(doc.sha256Hash.slice(-8));
    } catch (e) {
      console.error(`  ! could not upsert expectation for ${name}: ${(e as Error).message.slice(0, 80)}`);
    }
  }
  console.log(`Captured ${upsertedExpectations.length} RegressionExpectations`);

  // 2. Delete Work Intake items. Findings, origins, and
  //    ApIntakeSource rows cascade per schema.
  const wiIds = workIntakesToRemove.map((w) => w.id);
  const wiDel = await prisma.workIntakeItem.deleteMany({ where: { id: { in: wiIds } } });
  console.log(`Deleted ${wiDel.count} WorkIntakeItems (regression IngestedDocuments preserved)`);

  // 3. Delete fixture Vendors + related APInvoice rows.
  if (fixtureVendors.length > 0) {
    const vendorIds = fixtureVendors.map((v) => v.id);
    const invoiceDel = await prisma.aPInvoice.deleteMany({
      where: { clubId: founder.id, vendorId: { in: vendorIds } },
    });
    const vendorDel = await prisma.vendor.deleteMany({
      where: { id: { in: vendorIds }, clubId: founder.id },
    });
    console.log(`Deleted ${invoiceDel.count} fixture APInvoices + ${vendorDel.count} fixture Vendors`);
  }

  // 4. Delete fixture Members + MemberAccount rows.
  if (fixtureMembers.length > 0) {
    const accountDel = await prisma.memberAccount.deleteMany({
      where: { memberId: { in: [...fixtureMemberIds] } },
    });
    const memberDel = await prisma.member.deleteMany({
      where: { id: { in: [...fixtureMemberIds] }, clubId: founder.id },
    });
    console.log(`Deleted ${accountDel.count} fixture MemberAccounts + ${memberDel.count} fixture Members`);
  }

  console.log(``);
  console.log(`=== POST-CLEANUP RECONCILIATION ===`);
  const [wi, members, vendors, apInvoices, ingested] = await Promise.all([
    prisma.workIntakeItem.count({ where: { clubId: founder.id } }),
    prisma.member.count({ where: { clubId: founder.id } }),
    prisma.vendor.count({ where: { clubId: founder.id } }),
    prisma.aPInvoice.count({ where: { clubId: founder.id } }),
    prisma.ingestedDocument.count({ where: { clubId: founder.id } }),
  ]);
  console.log(`Coulee Ridge remaining WorkIntakeItems:  ${wi}`);
  console.log(`Coulee Ridge remaining Members:          ${members}`);
  console.log(`Coulee Ridge remaining Vendors:          ${vendors}`);
  console.log(`Coulee Ridge remaining APInvoices:       ${apInvoices}`);
  console.log(`Coulee Ridge remaining IngestedDocs:     ${ingested}`);
  const expectations = await prisma.regressionExpectation.count();
  console.log(`Total RegressionExpectations:            ${expectations}`);

  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
