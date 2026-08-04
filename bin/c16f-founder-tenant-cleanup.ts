#!/usr/bin/env tsx
// Sprint 3 · Checkpoint 16F revised v2 (2026-08-04) — founder-review
// tenant cleanup, provenance-first.
//
// This cleanup engine uses a strict, ordered provenance hierarchy.
// Filenames and subjects are NEVER primary evidence. A genuine Outlook
// email or founder-uploaded document ALWAYS defaults to operational
// founder-review data unless POSITIVE provenance proves it is a fixture.
//
// PROVENANCE HIERARCHY (highest priority first):
//
//   Rule 1 — Seeded entity relationships:
//     A WorkIntakeItem is fixture if it has an origin (WorkIntakeOrigin
//     OR EmailWorkIntakeOrigin) that points at:
//       - a fixture Member (email endsWith @fixture.test)
//       - a fixture Vendor (vendorNumber startsWith V-c15h-fixture-)
//       - a fixture IngestedDocument (sourceReferenceId matches a
//         known fixture-generator namespace pattern — see
//         FIXTURE_DOC_SOURCE_REF_PATTERNS below)
//
//   Rule 2 — Fixture namespace on classificationRuleKey:
//     A WI is fixture if its classificationRuleKey references a
//     fixture namespace, e.g. contains "c15h-fixture" or "c15g", or
//     is a per-vendor statement rule key whose vendor is a fixture
//     vendor (matched by ID against §1 discovered fixture vendors).
//
//   Rule 3 — Truly-orphan absence-of-provenance:
//     A WI is fixture if it has ZERO EmailWorkIntakeOrigin AND ZERO
//     WorkIntakeOrigin AND ZERO ApIntakeSource rows. This is the
//     ABSENCE of any positive genuine origin — no real Outlook email
//     backs it, no real upload backs it, no real system detection
//     backs it. Manually-created or broken test-path artifacts.
//
//   Rule 4 — RegressionExpectation linkage (future):
//     Not applied here; captured for the runner. A WI whose
//     canonical doc has a RegressionExpectation row will be
//     recognised as regression by the runner.
//
//   Rule 5 (diagnostic ONLY, NOT decisive):
//     Filename / subject / sender text. Recorded in the audit log
//     for the human reviewer but does not decide DELETE. A future
//     genuine "Verification-Invoice.pdf" from a real vendor will
//     pass through this engine untouched because Rules 1-3 will
//     positively identify it as genuine.
//
// USAGE:
//   npx tsx bin/c16f-founder-tenant-cleanup.ts \
//     --founder-club=<coulee-ridge-id> \
//     [--dry-run|--apply]
//
// Refuses production. Defaults to --dry-run.

import { prisma } from "../src/lib/prisma";

// ---------------------------------------------------------------------------
// Provenance markers — POSITIVE evidence patterns for fixture data.
// ---------------------------------------------------------------------------

// IngestedDocument.sourceReferenceId patterns for fixture-generated docs.
// Real Outlook attachments produce cuid-format IDs (`cm...`, 25 chars). No
// fixture pattern matches a cuid. Adding a new fixture generator?
// Add its namespace here.
const FIXTURE_DOC_SOURCE_REF_PATTERNS: RegExp[] = [
  /^c15h-fixture:/i,       // bin/c15h-founder-fixture.ts
  /^c15d-verify-/i,        // c15d verification runs (timestamped)
  /^c15e-verify-/i,        // c15e verification runs (timestamped)
  /^stmt-0\./,             // ad-hoc statement fixture (Math.random-based)
  /^c15g/i,                // any future c15g fixture
  /:fixture:/i,            // generic fixture-namespace convention
];

// classificationRuleKey patterns for fixture-created WorkIntakeItems.
const FIXTURE_RULE_KEY_PATTERNS: RegExp[] = [
  /c15h-fixture/i,
  /c15g/i,
];

// Member fixture marker.
const FIXTURE_MEMBER_EMAIL_SUFFIX = "@fixture.test";
// Vendor fixture marker.
const FIXTURE_VENDOR_NUMBER_PREFIX = "V-c15h-fixture-";

function isFixtureDocSourceRef(ref: string | null | undefined): boolean {
  if (!ref) return false;
  return FIXTURE_DOC_SOURCE_REF_PATTERNS.some((re) => re.test(ref));
}

function isFixtureRuleKey(key: string | null | undefined): boolean {
  if (!key) return false;
  return FIXTURE_RULE_KEY_PATTERNS.some((re) => re.test(key));
}

// ---------------------------------------------------------------------------
// Args + guards.
// ---------------------------------------------------------------------------

interface CleanupPlan { founderClubId: string; apply: boolean; }

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

// ---------------------------------------------------------------------------
// Classification.
// ---------------------------------------------------------------------------

interface WiClassification {
  id: string;
  subject: string;
  classification: string | null;
  status: string;
  ruleKey: string | null;
  action: "DELETE" | "PRESERVE";
  reasonRule: "R1_fixture_member_origin" | "R1_fixture_vendor_origin" | "R1_fixture_doc_origin"
    | "R2_fixture_rule_key" | "R2_fixture_vendor_in_rule_key"
    | "R3_no_provenance"
    | "PRESERVE_genuine_email_origin"
    | "PRESERVE_genuine_generic_origin"
    | "PRESERVE_no_positive_fixture_evidence";
  evidence: string;
  supportingDocIds: string[];
}

async function main() {
  const plan = parseArgs(process.argv.slice(2));
  refuseProduction();

  const founder = await prisma.club.findUnique({
    where: { id: plan.founderClubId },
    select: { id: true, slug: true, name: true, isDemoTenant: true, stagingDataMode: true },
  });
  if (!founder) { console.error("REFUSED: founder club not found"); process.exit(5); }
  if (founder.stagingDataMode !== "FOUNDER_REVIEW" && founder.stagingDataMode !== "REGRESSION") {
    console.error(`REFUSED: club ${founder.slug} has stagingDataMode=${founder.stagingDataMode}. Cleanup only runs on FOUNDER_REVIEW or REGRESSION.`);
    process.exit(6);
  }

  console.log(`Founder-review club: ${founder.slug} (${founder.name})`);
  console.log(`  stagingDataMode=${founder.stagingDataMode}`);
  console.log(`Mode:                ${plan.apply ? "APPLY" : "DRY-RUN"}`);
  console.log(``);

  // ------------------------------------------------------------------
  // Discover fixture entity sets (positive provenance).
  // ------------------------------------------------------------------

  const fixtureMembers = await prisma.member.findMany({
    where: { clubId: founder.id, email: { endsWith: FIXTURE_MEMBER_EMAIL_SUFFIX } },
    select: { id: true, firstName: true, lastName: true, email: true },
  });
  const fixtureMemberIds = new Set(fixtureMembers.map((m) => m.id));

  const fixtureVendors = await prisma.vendor.findMany({
    where: { clubId: founder.id, vendorNumber: { startsWith: FIXTURE_VENDOR_NUMBER_PREFIX } },
    select: { id: true, vendorNumber: true, legalName: true },
  });
  const fixtureVendorIds = new Set(fixtureVendors.map((v) => v.id));

  // Fixture MemberAccounts belong to fixture members. AR-aging cards
  // point at MemberAccount via MEMBER_ACCOUNT origins.
  const fixtureMemberAccounts = await prisma.memberAccount.findMany({
    where: { memberId: { in: [...fixtureMemberIds] } },
    select: { id: true },
  });
  const fixtureMemberAccountIds = new Set(fixtureMemberAccounts.map((a) => a.id));

  // Fixture IngestedDocuments (positive fixture namespace evidence).
  const allDocs = await prisma.ingestedDocument.findMany({
    where: { clubId: founder.id },
    select: { id: true, filename: true, sha256Hash: true, sourceKind: true, sourceReferenceId: true, mimeType: true, byteLength: true },
  });
  const fixtureDocIds = new Set(allDocs.filter((d) => isFixtureDocSourceRef(d.sourceReferenceId)).map((d) => d.id));
  const genuineDocIds = new Set(allDocs.filter((d) => !fixtureDocIds.has(d.id)).map((d) => d.id));

  // Fixture vendor IDs may appear inside per-vendor statement classification
  // rule keys like: ap-statement:{clubId}:{vendorId}
  const fixtureVendorRuleKeyPatterns = [...fixtureVendorIds].map((vid) => new RegExp(`:${vid}(:|$)`));

  // ------------------------------------------------------------------
  // Classify every WI item.
  // ------------------------------------------------------------------

  const allWi = await prisma.workIntakeItem.findMany({
    where: { clubId: founder.id },
    select: {
      id: true, classification: true, status: true,
      displaySubject: true, displaySender: true, classificationRuleKey: true,
      emailOrigins: { select: { id: true } },
      origins: { select: { kind: true, referenceId: true } },
      apIntakeSourcesForCanonical: {
        select: { id: true, ingestedDocumentId: true },
      },
    },
    orderBy: { createdAt: "asc" },
  });

  const classifications: WiClassification[] = [];
  for (const w of allWi) {
    const supportingDocIds = w.apIntakeSourcesForCanonical.map((s) => s.ingestedDocumentId);
    const docOriginIds = w.origins.filter((o) => o.kind === "INGESTED_DOCUMENT").map((o) => o.referenceId);
    const allDocRefs = [...new Set([...supportingDocIds, ...docOriginIds])];

    // Rule 1a — Fixture-Member origin.
    const memberOrigin = w.origins.find((o) => o.kind === "MEMBER" && fixtureMemberIds.has(o.referenceId));
    if (memberOrigin) {
      classifications.push({
        id: w.id, subject: (w.displaySubject ?? "").slice(0, 70),
        classification: w.classification, status: w.status, ruleKey: w.classificationRuleKey,
        action: "DELETE", reasonRule: "R1_fixture_member_origin",
        evidence: `origin.kind=MEMBER refs fixture member ${memberOrigin.referenceId.slice(-8)}`,
        supportingDocIds: allDocRefs,
      });
      continue;
    }
    // Rule 1a' — MEMBER_ACCOUNT origin belonging to fixture member.
    const memberAccountOrigin = w.origins.find((o) => o.kind === "MEMBER_ACCOUNT" && fixtureMemberAccountIds.has(o.referenceId));
    if (memberAccountOrigin) {
      classifications.push({
        id: w.id, subject: (w.displaySubject ?? "").slice(0, 70),
        classification: w.classification, status: w.status, ruleKey: w.classificationRuleKey,
        action: "DELETE", reasonRule: "R1_fixture_member_origin",
        evidence: `origin.kind=MEMBER_ACCOUNT refs fixture-member's account`,
        supportingDocIds: allDocRefs,
      });
      continue;
    }
    // Rule 1b — Fixture-Vendor origin.
    const vendorOrigin = w.origins.find((o) => o.kind === "VENDOR" && fixtureVendorIds.has(o.referenceId));
    if (vendorOrigin) {
      classifications.push({
        id: w.id, subject: (w.displaySubject ?? "").slice(0, 70),
        classification: w.classification, status: w.status, ruleKey: w.classificationRuleKey,
        action: "DELETE", reasonRule: "R1_fixture_vendor_origin",
        evidence: `origin.kind=VENDOR refs fixture vendor`,
        supportingDocIds: allDocRefs,
      });
      continue;
    }
    // Rule 1c — Fixture-IngestedDocument origin.
    const fixtureDocOrigin = allDocRefs.find((id) => fixtureDocIds.has(id));
    if (fixtureDocOrigin) {
      classifications.push({
        id: w.id, subject: (w.displaySubject ?? "").slice(0, 70),
        classification: w.classification, status: w.status, ruleKey: w.classificationRuleKey,
        action: "DELETE", reasonRule: "R1_fixture_doc_origin",
        evidence: `INGESTED_DOCUMENT origin refs fixture doc (sourceReferenceId matches fixture namespace)`,
        supportingDocIds: allDocRefs,
      });
      continue;
    }
    // Rule 2 — Fixture rule key.
    if (isFixtureRuleKey(w.classificationRuleKey)) {
      classifications.push({
        id: w.id, subject: (w.displaySubject ?? "").slice(0, 70),
        classification: w.classification, status: w.status, ruleKey: w.classificationRuleKey,
        action: "DELETE", reasonRule: "R2_fixture_rule_key",
        evidence: `classificationRuleKey matches fixture namespace`,
        supportingDocIds: allDocRefs,
      });
      continue;
    }
    // Rule 2' — Fixture-vendor ID embedded in per-vendor statement rule key.
    if (w.classificationRuleKey && fixtureVendorRuleKeyPatterns.some((re) => re.test(w.classificationRuleKey!))) {
      classifications.push({
        id: w.id, subject: (w.displaySubject ?? "").slice(0, 70),
        classification: w.classification, status: w.status, ruleKey: w.classificationRuleKey,
        action: "DELETE", reasonRule: "R2_fixture_vendor_in_rule_key",
        evidence: `classificationRuleKey embeds fixture vendorId`,
        supportingDocIds: allDocRefs,
      });
      continue;
    }
    // Rule 3 — Truly orphan (no positive genuine origin at all).
    const emailOriginCount = w.emailOrigins.length;
    const genericOriginCount = w.origins.length;
    const apCanonCount = w.apIntakeSourcesForCanonical.length;
    if (emailOriginCount === 0 && genericOriginCount === 0 && apCanonCount === 0) {
      classifications.push({
        id: w.id, subject: (w.displaySubject ?? "").slice(0, 70),
        classification: w.classification, status: w.status, ruleKey: w.classificationRuleKey,
        action: "DELETE", reasonRule: "R3_no_provenance",
        evidence: `no emailOrigins, no origins, no apIntakeSources`,
        supportingDocIds: allDocRefs,
      });
      continue;
    }
    // Otherwise: PRESERVE. Positive genuine provenance.
    let preserveRule: WiClassification["reasonRule"];
    let evidence: string;
    if (emailOriginCount > 0) {
      preserveRule = "PRESERVE_genuine_email_origin";
      evidence = `emailOrigins=${emailOriginCount} (positive Outlook provenance)`;
    } else if (genericOriginCount > 0 || apCanonCount > 0) {
      preserveRule = "PRESERVE_genuine_generic_origin";
      evidence = `origins=${genericOriginCount}, apIntakeSources=${apCanonCount} (positive genuine provenance)`;
    } else {
      preserveRule = "PRESERVE_no_positive_fixture_evidence";
      evidence = "default-preserve (no positive fixture evidence)";
    }
    classifications.push({
      id: w.id, subject: (w.displaySubject ?? "").slice(0, 70),
      classification: w.classification, status: w.status, ruleKey: w.classificationRuleKey,
      action: "PRESERVE", reasonRule: preserveRule, evidence,
      supportingDocIds: allDocRefs,
    });
  }

  const deleteList = classifications.filter((c) => c.action === "DELETE");
  const preserveList = classifications.filter((c) => c.action === "PRESERVE");

  // ------------------------------------------------------------------
  // Regression assets: fixture docs backed by DELETE WIs, capture
  // RegressionExpectation for each.
  // ------------------------------------------------------------------

  const regressionDocIds = new Set<string>();
  for (const c of deleteList) {
    for (const id of c.supportingDocIds) if (fixtureDocIds.has(id)) regressionDocIds.add(id);
  }
  const regressionDocs = allDocs.filter((d) => regressionDocIds.has(d.id));

  // ------------------------------------------------------------------
  // Report.
  // ------------------------------------------------------------------

  console.log(`=== DISCOVERED FIXTURE ENTITIES (positive provenance) ===`);
  console.log(`Fixture Members (email @fixture.test):   ${fixtureMembers.length}`);
  console.log(`Fixture MemberAccounts (derived):        ${fixtureMemberAccounts.length}`);
  console.log(`Fixture Vendors (V-c15h-fixture-* #):    ${fixtureVendors.length}`);
  console.log(`Fixture IngestedDocs (sourceRef prefix): ${fixtureDocIds.size}`);
  console.log(`Genuine IngestedDocs (real Outlook):     ${genuineDocIds.size}`);
  console.log(``);
  console.log(`=== WORK INTAKE CLASSIFICATION (${allWi.length} total) ===`);
  const byRule: Record<string, number> = {};
  for (const c of classifications) byRule[c.reasonRule] = (byRule[c.reasonRule] ?? 0) + 1;
  for (const [k, v] of Object.entries(byRule)) console.log(`  ${k.padEnd(45)} ${v}`);
  console.log(``);
  console.log(`=== WORK INTAKE DELETE (${deleteList.length}) ===`);
  for (const c of deleteList) {
    console.log(`  · [${c.reasonRule}] ${c.status.padEnd(14)} ${(c.classification ?? "").padEnd(24)} — ${c.subject}`);
    console.log(`    evidence: ${c.evidence}`);
  }
  console.log(``);
  console.log(`=== WORK INTAKE PRESERVE (${preserveList.length}) ===`);
  for (const c of preserveList) {
    console.log(`  · [${c.reasonRule}] ${c.status.padEnd(14)} ${(c.classification ?? "").padEnd(24)} — ${c.subject}`);
    console.log(`    evidence: ${c.evidence}`);
  }
  console.log(``);
  console.log(`=== FIXTURE MEMBERS (Decision A → DELETE cascade) ===`);
  for (const m of fixtureMembers) console.log(`  · ${m.firstName} ${m.lastName} <${m.email}>`);
  console.log(``);
  console.log(`=== FIXTURE VENDORS (${fixtureVendors.length}) ===`);
  for (const v of fixtureVendors) console.log(`  · ${v.vendorNumber} — ${v.legalName}`);
  console.log(``);
  console.log(`=== REGRESSION DOCS (preserved in place, ${regressionDocs.length}) ===`);
  for (const d of regressionDocs) console.log(`  · sha:${d.sha256Hash.slice(-8)}  ${d.filename}`);

  if (!plan.apply) {
    console.log(``);
    console.log(`[DRY-RUN] Nothing written. Rerun with --apply to execute.`);
    await prisma.$disconnect();
    return;
  }

  // ------------------------------------------------------------------
  // Execute.
  // ------------------------------------------------------------------

  console.log(``);
  console.log(`=== EXECUTING ===`);

  // 1. Capture RegressionExpectation for each fixture doc.
  let capturedRegressions = 0;
  for (const d of regressionDocs) {
    const name = d.filename ?? "";
    const category =
      /^c15h-fixture:/i.test(d.sourceReferenceId ?? "") ? "AP_FIXTURE_C15H"
      : /^c15d-verify-/i.test(d.sourceReferenceId ?? "") ? "AP_FIXTURE_C15D_VERIFY"
      : /^c15e-verify-/i.test(d.sourceReferenceId ?? "") ? "AP_FIXTURE_C15E_VERIFY"
      : /^stmt-0\./.test(d.sourceReferenceId ?? "") ? "STATEMENT_FIXTURE_ADHOC"
      : "UNCATEGORIZED_FIXTURE";
    try {
      await prisma.regressionExpectation.upsert({
        where: { documentSha256: d.sha256Hash },
        create: {
          documentSha256: d.sha256Hash, label: (name || d.sha256Hash).slice(0, 80),
          category, notes: `captured_by_16f_cleanup_v2:founder=${founder.slug}:sourceRef=${(d.sourceReferenceId ?? "").slice(0, 40)}`,
        },
        update: {},
      });
      capturedRegressions++;
    } catch (e) {
      console.error(`  ! could not upsert expectation for ${name}: ${(e as Error).message.slice(0, 80)}`);
    }
  }
  console.log(`Captured ${capturedRegressions} RegressionExpectations`);

  // 2. Delete WorkIntakeItems (cascade WorkIntakeOrigin, EmailWorkIntakeOrigin,
  //    WorkIntakeItemFinding, ApIntakeSource per schema).
  const wiDel = await prisma.workIntakeItem.deleteMany({
    where: { id: { in: deleteList.map((c) => c.id) } },
  });
  console.log(`Deleted ${wiDel.count} WorkIntakeItems`);

  // 3. Delete fixture Vendors + FK dependencies that don't cascade
  //    automatically. Order: VendorStatementReconciliation →
  //    VendorPayment → APInvoice → Vendor (Vendor cascades to its
  //    contacts / banking / documents / risk flags / aliases via
  //    schema onDelete: Cascade).
  if (fixtureVendors.length > 0) {
    const vendorIds = fixtureVendors.map((v) => v.id);
    const vsrDel = await prisma.vendorStatementReconciliation.deleteMany({
      where: { canonicalVendorId: { in: vendorIds } },
    }).catch(() => ({ count: 0 }));
    const vpDel = await prisma.vendorPayment.deleteMany({
      where: { clubId: founder.id, vendorId: { in: vendorIds } },
    });
    const invoiceDel = await prisma.aPInvoice.deleteMany({
      where: { clubId: founder.id, vendorId: { in: vendorIds } },
    });
    const vendorDel = await prisma.vendor.deleteMany({
      where: { id: { in: vendorIds }, clubId: founder.id },
    });
    console.log(`Deleted ${vsrDel.count} VendorStatementReconciliations, ${vpDel.count} VendorPayments, ${invoiceDel.count} fixture APInvoices, ${vendorDel.count} fixture Vendors`);
  }

  // 4. Cascade-delete fixture Members: Charges + Payments + CollectionNotices
  //    + MemberAccount + Member. NONE of these have onDelete:Cascade at the
  //    Prisma level for Member, so this order is required.
  if (fixtureMembers.length > 0) {
    const memberIds = [...fixtureMemberIds];
    const collectionNoticeDel = await prisma.collectionNotice.deleteMany({
      where: { clubId: founder.id, memberId: { in: memberIds } },
    }).catch(() => ({ count: 0 }));
    const chargeDel = await prisma.charge.deleteMany({
      where: { clubId: founder.id, memberId: { in: memberIds } },
    });
    const paymentDel = await prisma.payment.deleteMany({
      where: { clubId: founder.id, memberId: { in: memberIds } },
    });
    const accountDel = await prisma.memberAccount.deleteMany({
      where: { memberId: { in: memberIds } },
    });
    const memberDel = await prisma.member.deleteMany({
      where: { id: { in: memberIds }, clubId: founder.id },
    });
    console.log(`Deleted ${collectionNoticeDel.count} CollectionNotices, ${chargeDel.count} Charges, ${paymentDel.count} Payments, ${accountDel.count} MemberAccounts, ${memberDel.count} Members`);
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
  const expectations = await prisma.regressionExpectation.count();
  console.log(`Coulee Ridge remaining WorkIntakeItems:  ${wi}`);
  console.log(`Coulee Ridge remaining Members:          ${members}`);
  console.log(`Coulee Ridge remaining Vendors:          ${vendors}`);
  console.log(`Coulee Ridge remaining APInvoices:       ${apInvoices}`);
  console.log(`Coulee Ridge remaining IngestedDocs:     ${ingested}`);
  console.log(`Total RegressionExpectations:            ${expectations}`);

  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
