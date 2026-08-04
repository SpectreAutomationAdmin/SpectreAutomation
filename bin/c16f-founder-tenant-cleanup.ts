#!/usr/bin/env tsx
// Sprint 3 · Checkpoint 16F (2026-08-04) — founder-review tenant
// cleanup.
//
// Removes synthetic Work Intake artefacts from the specified
// founder-review tenant (Coulee Ridge) while PRESERVING regression
// documents by capturing RegressionExpectation rows keyed by
// document SHA-256. Fixture IngestedDocument rows are MOVED to the
// target demo/regression tenant so the AP intelligence engine can
// still evaluate them independently of the founder tenant's Work
// Intake feed.
//
// Usage:
//   npx tsx bin/c16f-founder-tenant-cleanup.ts \
//     --founder-club=<coulee-ridge-id> \
//     --demo-club=<demo-club-id> \
//     [--dry-run|--apply]
//
// Refuses production, always defaults to --dry-run, and prints a
// full audit summary before writing anything.

import { prisma } from "../src/lib/prisma";

interface CleanupPlan {
  founderClubId: string;
  demoClubId: string;
  apply: boolean;
}

function parseArgs(argv: string[]): CleanupPlan {
  let founderClubId: string | null = null;
  let demoClubId: string | null = null;
  let apply = false;
  for (const a of argv) {
    if (a.startsWith("--founder-club=")) founderClubId = a.slice("--founder-club=".length);
    else if (a.startsWith("--demo-club=")) demoClubId = a.slice("--demo-club=".length);
    else if (a === "--apply") apply = true;
    else if (a === "--dry-run") apply = false;
  }
  if (!founderClubId || !demoClubId) {
    console.error("REFUSED: --founder-club=<id> and --demo-club=<id> required");
    process.exit(2);
  }
  return { founderClubId, demoClubId, apply };
}

function refuseProduction() {
  const appUrl = (process.env.APP_URL ?? "").toLowerCase();
  const isProdUrl = appUrl.includes("production") ||
    (appUrl.includes("spectreautomation.com") && !appUrl.includes("staging"));
  if (isProdUrl || process.env.NODE_ENV === "production") {
    console.error(`REFUSED: production environment (APP_URL=${appUrl}, NODE_ENV=${process.env.NODE_ENV})`);
    process.exit(3);
  }
}

async function main() {
  const plan = parseArgs(process.argv.slice(2));
  refuseProduction();

  const founder = await prisma.club.findUnique({
    where: { id: plan.founderClubId },
    select: { id: true, slug: true, name: true, isDemoTenant: true },
  });
  const demo = await prisma.club.findUnique({
    where: { id: plan.demoClubId },
    select: { id: true, slug: true, name: true, isDemoTenant: true },
  });
  if (!founder) { console.error("REFUSED: founder club not found"); process.exit(4); }
  if (!demo) { console.error("REFUSED: demo club not found"); process.exit(4); }
  if (founder.isDemoTenant) {
    console.error(`REFUSED: founder club ${founder.slug} has isDemoTenant=true. This script targets founder-review tenants (isDemoTenant=false).`);
    process.exit(5);
  }
  if (!demo.isDemoTenant) {
    console.error(`REFUSED: demo club ${demo.slug} has isDemoTenant=false. Set isDemoTenant=true before targeting a demo destination.`);
    process.exit(6);
  }
  console.log(`Founder club: ${founder.slug} (${founder.name}) [isDemoTenant=false] ✓`);
  console.log(`Demo club:    ${demo.slug} (${demo.name}) [isDemoTenant=true] ✓`);
  console.log(`Mode:         ${plan.apply ? "APPLY" : "DRY-RUN"}`);

  // -------------------------------------------------------------------------
  // Identify targets. Uses the same evidence as the 16E inventory:
  //   * fixture members: email ends with @fixture.test
  //   * fixture vendor: vendorNumber starts with "V-c15h-fixture-"
  //   * fixture Work Intake items: displaySubject contains
  //     "Verification-Invoice" / "C15D-Verify" / "c15h" / "c15g" (case-insensitive)
  //     OR classificationRuleKey contains "c15h-fixture" or "c15g"
  //   * orphan Work Intake items: origins array is empty
  //   * AR Work Intake items whose Member origin is a fixture member
  // -------------------------------------------------------------------------

  const fixtureMembers = await prisma.member.findMany({
    where: { clubId: founder.id, email: { endsWith: "@fixture.test" } },
    select: { id: true, firstName: true, lastName: true },
  });
  const fixtureMemberIds = new Set(fixtureMembers.map((m) => m.id));

  const fixtureVendor = await prisma.vendor.findFirst({
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
      workIntakesToRemove.push({ id: w.id, classification: w.classification ?? "", subject: subj.slice(0, 40), reason: "fixture_subject_marker", supportingIngestedDocumentIds: supportingDocs });
    } else if (isFixtureRuleKey) {
      workIntakesToRemove.push({ id: w.id, classification: w.classification ?? "", subject: subj.slice(0, 40), reason: "fixture_rule_key", supportingIngestedDocumentIds: supportingDocs });
    } else if (isOrphan) {
      workIntakesToRemove.push({ id: w.id, classification: w.classification ?? "", subject: subj.slice(0, 40), reason: "orphan_no_origins", supportingIngestedDocumentIds: supportingDocs });
    } else if (isArAgingFixture) {
      workIntakesToRemove.push({ id: w.id, classification: w.classification ?? "", subject: subj.slice(0, 40), reason: "ar_aging_fixture_member", supportingIngestedDocumentIds: supportingDocs });
    }
  }

  // Collect IngestedDocuments used by these Work Intakes (via origins + apIntakeSources).
  const docsToMove = new Set<string>();
  for (const w of workIntakesToRemove) {
    for (const d of w.supportingIngestedDocumentIds) docsToMove.add(d);
    // Also collect INGESTED_DOCUMENT primary origins
    const full = allWorkIntakes.find((x) => x.id === w.id);
    for (const o of full?.origins ?? []) {
      if (o.kind === "INGESTED_DOCUMENT") docsToMove.add(o.referenceId);
    }
  }
  const docsToMoveList = await prisma.ingestedDocument.findMany({
    where: { id: { in: [...docsToMove] }, clubId: founder.id },
    select: { id: true, filename: true, sha256Hash: true },
  });

  console.log(``);
  console.log(`=== TARGETS ===`);
  console.log(`Fixture Members:                 ${fixtureMembers.length}`);
  console.log(`Fixture Vendor:                  ${fixtureVendor ? 1 : 0}`);
  console.log(`Work Intake items to remove:     ${workIntakesToRemove.length}`);
  console.log(`  by reason:`);
  const byReason: Record<string, number> = {};
  for (const w of workIntakesToRemove) byReason[w.reason] = (byReason[w.reason] ?? 0) + 1;
  for (const [r, n] of Object.entries(byReason)) console.log(`    ${r}: ${n}`);
  console.log(`IngestedDocuments to MOVE:       ${docsToMoveList.length}`);

  if (!plan.apply) {
    console.log(``);
    console.log(`[DRY-RUN] Nothing written. Rerun with --apply to execute.`);
    await prisma.$disconnect();
    return;
  }

  console.log(``);
  console.log(`=== EXECUTING ===`);

  // 1. Capture RegressionExpectation for every doc we're about to move.
  //    Category inferred from filename pattern; expected fields left null
  //    (to be filled in by a follow-up curation pass with founder
  //    approval per §7).
  const upsertedExpectations: string[] = [];
  for (const doc of docsToMoveList) {
    const category = /verification/i.test(doc.filename ?? "") ? "VERIFICATION_FIXTURE"
      : /c15h/i.test(doc.filename ?? "") ? "AP_FIXTURE_C15H"
      : /c15g/i.test(doc.filename ?? "") ? "STATEMENT_FIXTURE_C15G"
      : /oakcreek|oxio|microsoft|cpa/i.test(doc.filename ?? "") ? "REAL_REGRESSION"
      : "UNCATEGORIZED";
    const label = (doc.filename ?? doc.sha256Hash).slice(0, 80);
    try {
      await prisma.regressionExpectation.upsert({
        where: { documentSha256: doc.sha256Hash },
        create: {
          documentSha256: doc.sha256Hash,
          label,
          category,
          notes: `captured_by_16f_cleanup:founder=${founder.slug}`,
        },
        update: {}, // preserve any manual curation on re-runs
      });
      upsertedExpectations.push(doc.sha256Hash.slice(-8));
    } catch (e) {
      console.error(`  ! could not upsert expectation for ${doc.filename}: ${(e as Error).message.slice(0, 80)}`);
    }
  }
  console.log(`Captured ${upsertedExpectations.length} RegressionExpectations`);

  // 2. Delete Work Intake items + cascade (findings, origins,
  //    apIntakeSources, evidenceLinks, etc.). Prisma cascade handles
  //    most; explicit deletes for those without cascade.
  await prisma.$transaction(async (tx) => {
    const wiIds = workIntakesToRemove.map((w) => w.id);
    // Findings + origins cascade via schema.
    // ApIntakeSource references are cascade-deleted with canonicalApIntake.
    const del = await tx.workIntakeItem.deleteMany({ where: { id: { in: wiIds } } });
    console.log(`Deleted ${del.count} WorkIntakeItems`);
  });

  // 3. Move fixture IngestedDocuments to the demo tenant. The
  //    underlying R2 storage key includes the founder clubId in
  //    its path; the bytes stay where they are (immutable),
  //    only the DB row moves.
  await prisma.$transaction(async (tx) => {
    const moved = await tx.ingestedDocument.updateMany({
      where: { id: { in: docsToMoveList.map((d) => d.id) } },
      data: { clubId: demo.id },
    });
    console.log(`Moved ${moved.count} IngestedDocuments to demo tenant ${demo.slug}`);
  });

  // 4. Delete fixture Vendor + related APInvoice rows (fixture only).
  if (fixtureVendor) {
    await prisma.$transaction(async (tx) => {
      const invoiceDel = await tx.aPInvoice.deleteMany({
        where: { clubId: founder.id, vendorId: fixtureVendor.id },
      });
      const vendorDel = await tx.vendor.deleteMany({
        where: { id: fixtureVendor.id, clubId: founder.id },
      });
      console.log(`Deleted ${invoiceDel.count} fixture APInvoices + ${vendorDel.count} fixture Vendor`);
    });
  }

  // 5. Delete fixture Members + MemberAccount rows.
  if (fixtureMembers.length > 0) {
    await prisma.$transaction(async (tx) => {
      const accountDel = await tx.memberAccount.deleteMany({
        where: { memberId: { in: [...fixtureMemberIds] } },
      });
      const memberDel = await tx.member.deleteMany({
        where: { id: { in: [...fixtureMemberIds] }, clubId: founder.id },
      });
      console.log(`Deleted ${accountDel.count} fixture MemberAccounts + ${memberDel.count} fixture Members`);
    });
  }

  console.log(``);
  console.log(`=== SUMMARY ===`);
  const remaining = await prisma.workIntakeItem.count({ where: { clubId: founder.id } });
  const remainingMembers = await prisma.member.count({ where: { clubId: founder.id } });
  const remainingVendors = await prisma.vendor.count({ where: { clubId: founder.id } });
  console.log(`Coulee Ridge remaining Work Intake items: ${remaining}`);
  console.log(`Coulee Ridge remaining Members:           ${remainingMembers}`);
  console.log(`Coulee Ridge remaining Vendors:           ${remainingVendors}`);
  const demoDocs = await prisma.ingestedDocument.count({ where: { clubId: demo.id } });
  const expectations = await prisma.regressionExpectation.count();
  console.log(`Demo tenant IngestedDocuments:            ${demoDocs}`);
  console.log(`RegressionExpectations total:             ${expectations}`);

  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
