// Sprint 3 · Checkpoint 16H rejection #4 → audit approval (2026-08-06)
// AP Intelligence Benchmark — runner.
//
// Runs every case in the sealed corpus through the REAL production
// entrypoint `analyseIngestedInvoice`. No mocking of internal helpers.
// The runner:
//   1. Seeds a disposable Club + COA + Vendors (see seed.ts).
//   2. Ingests a fixture PDF stub per case (bytes generated locally
//      so no ops storage is touched).
//   3. Invokes `analyseIngestedInvoice` with the case's text override.
//   4. Runs every comparator (comparators/index.ts) against the
//      analyser's return + card-projection derivation.
//   5. Tears down the disposable Club.
//   6. Writes JSON + Markdown reports.
//
// The runner NEVER writes to production operational tables. Every
// write is Club-scoped to the disposable tenant. To make that
// operational-safety obvious, the runner refuses to start when
// DATABASE_URL host contains "prod".
//
// CLI:
//   npm run evaluate:ap-intelligence
//   npm run evaluate:ap-intelligence -- --phase0=off      # baseline
//   npm run evaluate:ap-intelligence -- --phase0=on       # post-containment (default)
//   npm run evaluate:ap-intelligence -- --split=dev       # dev only
//   npm run evaluate:ap-intelligence -- --seal-baseline   # write baselines/ file

/* eslint-disable no-console */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID, randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";

import type {
  BenchmarkCase, BenchmarkRunReport, CaseRunResult, ComparatorVerdict,
  ExpectedTruth,
} from "./types";
import { seedBenchmarkTenant, tearDownBenchmarkTenant } from "./seed";
import { runAllComparators, type AnalyserSnapshot } from "./comparators";

const ROOT = path.resolve(__dirname);
const CORPUS_ROOT = path.join(ROOT, "corpus");
const BASELINES_DIR = path.join(ROOT, "baselines");
const REPORTS_DIR = path.join(ROOT, "runs");

function assertNotProduction(): void {
  const dbUrl = process.env.DATABASE_URL ?? "";
  const host = (() => { try { return new URL(dbUrl).hostname; } catch { return ""; } })();
  if (/\bprod(uction)?\b/i.test(host)) {
    console.error(`REFUSED: DATABASE_URL host looks like production (${host}). Benchmark refuses to run.`);
    process.exit(3);
  }
  if (process.env.NODE_ENV === "production") {
    console.error(`REFUSED: NODE_ENV=production.`);
    process.exit(3);
  }
}

/** Create a completely disposable SQLite file for this benchmark
 *  run, applied via `prisma db push`. Guarantees zero contamination
 *  of any operational or dev database. Returns the file path so the
 *  caller can delete it on shutdown. */
function provisionDisposableDatabase(): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ap-bench-"));
  const dbFile = path.join(tmpDir, "bench.db");
  const url = `file:${dbFile.replace(/\\/g, "/")}`;
  process.env.DATABASE_URL = url;
  console.log(`  Disposable DB: ${url}`);
  // Push the SQLite schema into the fresh file. --accept-data-loss
  // is inert on an empty DB but suppresses interactive prompts.
  const push = spawnSync("npx", ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, DATABASE_URL: url },
    shell: true,
  });
  if (push.status !== 0) {
    console.error(`  Prisma db push failed:\n${push.stderr.toString()}`);
    process.exit(4);
  }
  return dbFile;
}

function teardownDisposableDatabase(dbFile: string): void {
  try {
    const dir = path.dirname(dbFile);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup.
  }
}

function parseArgs(argv: string[]) {
  const out = {
    phase0: true as boolean,
    phase2: true as boolean,
    split: null as string | null,
    sealBaseline: false as boolean,
    revealHoldout: false as boolean,
  };
  for (const a of argv.slice(2)) {
    if (a === "--phase0=off" || a === "--phase0=0" || a === "--phase0=false") out.phase0 = false;
    else if (a === "--phase0=on" || a === "--phase0=1" || a === "--phase0=true") out.phase0 = true;
    else if (a === "--phase2=off" || a === "--phase2=0" || a === "--phase2=false") out.phase2 = false;
    else if (a === "--phase2=on" || a === "--phase2=1" || a === "--phase2=true") out.phase2 = true;
    else if (a.startsWith("--split=")) out.split = a.slice("--split=".length);
    else if (a === "--seal-baseline") out.sealBaseline = true;
    else if (a === "--reveal-holdout") out.revealHoldout = true;
  }
  return out;
}

function loadCorpus(splitFilter: string | null): BenchmarkCase[] {
  const manifest = JSON.parse(fs.readFileSync(path.join(CORPUS_ROOT, "manifest.json"), "utf8")) as {
    version: string;
    split: { dev: string[]; validation: string[]; holdout: string[] };
  };
  const paths: string[] = [];
  const push = (list: string[]) => list.forEach((p) => paths.push(path.join(ROOT, p)));
  if (splitFilter === null || splitFilter === "dev") push(manifest.split.dev);
  if (splitFilter === null || splitFilter === "validation") push(manifest.split.validation);
  if (splitFilter === null || splitFilter === "holdout") push(manifest.split.holdout);
  return paths.map((p) => JSON.parse(fs.readFileSync(p, "utf8")) as BenchmarkCase);
}

function makeStubPdf(): Buffer {
  return Buffer.concat([
    Buffer.from("%PDF-1.7\n"),
    Buffer.from("% AP benchmark fixture — bytes exist for magic-number check only.\n"),
    randomBytes(256),
  ]);
}

async function ingestStubDocument(
  prisma: PrismaClient,
  clubId: string,
  caseId: string,
): Promise<string> {
  const pdf = makeStubPdf();
  const { ingestAttachment } = await import("@/lib/documents/ingest");
  const { memoryDocumentStorageAdapter } = await import("@/lib/documents/storage");
  const storage = memoryDocumentStorageAdapter(`AP_BENCH_${caseId}`);
  const result = await ingestAttachment({
    clubId,
    sourceKind: "EMAIL_ATTACHMENT",
    sourceReferenceId: `bench:${caseId}:${randomBytes(4).toString("hex")}`,
    claimedContentType: "application/pdf",
    claimedSizeBytes: pdf.length,
    originalFilename: `${caseId}.pdf`,
    receivedAt: new Date("2026-08-06T00:00:00Z"),
    isInline: false,
    bytes: { async fetchBytes() { return pdf; } },
    classifySignals: {},
    autoAttachTo: null,
    storageOverride: storage,
  });
  if (!result.documentId) throw new Error(`ingest failed for case ${caseId}: ${result.outcome}`);
  // Force classification = INVOICE so the analyser runs the AP path
  // even when the case's declared expected class is something else
  // (the comparator handles the mismatch — the analyser needs to
  // execute against INVOICE so we can measure its behaviour).
  await prisma.ingestedDocument.update({
    where: { id: result.documentId },
    data: { classification: "INVOICE" },
  });
  return result.documentId;
}

async function projectAnalyserSnapshot(analysis: unknown): Promise<AnalyserSnapshot> {
  const a = analysis as {
    extraction?: {
      state?: string; supplier?: { guessedName?: string | null };
      invoiceNumber?: string | null; invoiceDate?: string | null;
      currency?: string | null;
      subtotal?: string | null; taxTotal?: string | null; total?: string | null;
      vendor?: { guessedName?: string | null };
    };
    vendor?: { state?: string };
    gl?: {
      accountNumber?: string | null; accountName?: string | null;
      source?: string | null; confidence?: number | null;
      candidates?: Array<{ accountNumber: string }>;
      reason?: string | null;
    };
  };
  const supplierName = a.extraction?.supplier?.guessedName ?? a.extraction?.vendor?.guessedName ?? null;
  // Phase 3 — compute the canonical workflow decision so per-case
  // scoring can measure state / false-ready / false-auto.
  const { computeApWorkflowDecision } = await import("@/lib/ap-intelligence/workflow/decision");
  const decision = computeApWorkflowDecision({
    analysis: analysis as import("@/lib/ap-intelligence/analyse").ApAnalyseResult,
    documentAnalysisPending: false,   // harness only runs terminal extractions
    duplicateRisk: false,
    tenantAutoApprovalPolicy: undefined,   // Coulee Ridge: no policy configured
    vendorIsNew: false,
  });
  return {
    extractionState: a.extraction?.state ?? null,
    supplier: supplierName,
    invoiceNumber: a.extraction?.invoiceNumber ?? null,
    invoiceDate: a.extraction?.invoiceDate ?? null,
    currency: a.extraction?.currency ?? null,
    subtotal: a.extraction?.subtotal ?? null,
    taxTotal: a.extraction?.taxTotal ?? null,
    total: a.extraction?.total ?? null,
    vendorState: a.vendor?.state ?? null,
    glLeaderAccountNumber: a.gl?.accountNumber ?? null,
    glLeaderName: a.gl?.accountName ?? null,
    glLeaderSource: a.gl?.source ?? null,
    glConfidence: a.gl?.confidence ?? null,
    glCandidateNumbers: (a.gl?.candidates ?? []).map((c) => c.accountNumber),
    glReason: a.gl?.reason ?? null,
    workflowState: decision.state,
    autoApprovalExclusions: decision.autoApprovalExclusions,
    workflowBlockers: decision.blockers.map((b) => b.code),
    workflowDimensionStatuses: Object.fromEntries(
      decision.dimensions.map((d) => [d.key, d.validationStatus]),
    ),
  };
}

function overallVerdict(results: CaseRunResult["results"]): ComparatorVerdict {
  const anyUnsafe = results.some((r) => r.unsafe === true && r.verdict === "FAIL");
  if (anyUnsafe) return "FAIL";
  const anyFail = results.some((r) => r.verdict === "FAIL");
  if (anyFail) return "FAIL";
  const anyPartial = results.some((r) => r.verdict === "PARTIAL");
  if (anyPartial) return "PARTIAL";
  return results.some((r) => r.verdict === "PASS") ? "PASS" : "NOT_APPLICABLE";
}

async function runOneCase(
  prisma: PrismaClient,
  clubId: string,
  c: BenchmarkCase,
): Promise<CaseRunResult> {
  const { analyseIngestedInvoice } = await import("@/lib/ap-intelligence/analyse");
  const docId = await ingestStubDocument(prisma, clubId, c.id);
  const t0 = Number(process.hrtime.bigint() / 1_000_000n);
  const analysis = await analyseIngestedInvoice({
    clubId,
    ingestedDocumentId: docId,
    extractedTextOverride: c.source.text,
  });
  const t1 = Number(process.hrtime.bigint() / 1_000_000n);
  const snapshot = await projectAnalyserSnapshot(analysis);
  const results = runAllComparators(c.expected as ExpectedTruth, snapshot);
  const overall = overallVerdict(results);
  return {
    caseId: c.id, split: c.split, category: c.category, label: c.label,
    latencyMs: t1 - t0,
    results, overall,
    extract: {
      supplier: snapshot.supplier,
      invoiceNumber: snapshot.invoiceNumber,
      total: snapshot.total,
      currency: snapshot.currency,
      glLeaderAccountNumber: snapshot.glLeaderAccountNumber,
      glLeaderName: snapshot.glLeaderName,
      glConfidence: snapshot.glConfidence,
      workflowState: snapshot.workflowState,
    },
  };
}

function aggregate(cases: CaseRunResult[], phase0Enabled: boolean, corpusVersion: string, runId: string, startedAt: string, finishedAt: string): BenchmarkRunReport {
  const totals = {
    cases: cases.length,
    pass: cases.filter((c) => c.overall === "PASS").length,
    fail: cases.filter((c) => c.overall === "FAIL").length,
    partial: cases.filter((c) => c.overall === "PARTIAL").length,
    notApplicable: cases.filter((c) => c.overall === "NOT_APPLICABLE").length,
    unsafeRecommendations: cases.reduce((n, c) => n + c.results.filter((r) => r.unsafe === true && r.verdict === "FAIL").length, 0),
    abstentionOnUnreadable: cases.filter((c) => c.results.some((r) => r.dimension === "abstention" && r.expected === true && r.verdict === "PASS")).length,
    falseAbstention: cases.filter((c) => c.results.some((r) => r.dimension === "abstention" && r.expected === false && r.verdict === "FAIL")).length,
    latencyP50Ms: percentile(cases.map((c) => c.latencyMs), 0.5),
    latencyP95Ms: percentile(cases.map((c) => c.latencyMs), 0.95),
  };
  const perDimension: BenchmarkRunReport["perDimension"] = {};
  for (const c of cases) {
    for (const r of c.results) {
      const bucket = perDimension[r.dimension] ??= { pass: 0, fail: 0, partial: 0, notApplicable: 0, averageScore: 0 };
      if (r.verdict === "PASS") bucket.pass++;
      else if (r.verdict === "FAIL") bucket.fail++;
      else if (r.verdict === "PARTIAL") bucket.partial++;
      else bucket.notApplicable++;
      bucket.averageScore += r.score;
    }
  }
  for (const k of Object.keys(perDimension)) {
    const total = perDimension[k].pass + perDimension[k].fail + perDimension[k].partial + perDimension[k].notApplicable;
    perDimension[k].averageScore = total > 0 ? Number((perDimension[k].averageScore / total).toFixed(3)) : 0;
  }
  return { runId, startedAt, finishedAt, phase0Enabled, corpusVersion, totals, perDimension, cases };
}

function percentile(nums: number[], p: number): number {
  if (nums.length === 0) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx];
}

function renderMarkdown(rep: BenchmarkRunReport, revealHoldout: boolean): string {
  const lines: string[] = [];
  lines.push(`# AP Intelligence Benchmark — ${rep.runId}`);
  lines.push("");
  lines.push(`| | |`);
  lines.push(`|---|---|`);
  lines.push(`| Corpus | \`${rep.corpusVersion}\` |`);
  lines.push(`| Phase 0 containment | \`${rep.phase0Enabled ? "ENABLED" : "DISABLED (baseline)"}\` |`);
  lines.push(`| Started | ${rep.startedAt} |`);
  lines.push(`| Finished | ${rep.finishedAt} |`);
  lines.push(`| Cases | ${rep.totals.cases} (pass ${rep.totals.pass} · partial ${rep.totals.partial} · fail ${rep.totals.fail} · n/a ${rep.totals.notApplicable}) |`);
  lines.push(`| Unsafe recommendations | **${rep.totals.unsafeRecommendations}** |`);
  lines.push(`| Correct abstention on unreadable | ${rep.totals.abstentionOnUnreadable} |`);
  lines.push(`| False abstention | ${rep.totals.falseAbstention} |`);
  lines.push(`| Latency p50 / p95 (ms) | ${rep.totals.latencyP50Ms} / ${rep.totals.latencyP95Ms} |`);
  lines.push("");
  lines.push(`## Per-dimension`);
  lines.push("");
  lines.push(`| Dimension | Pass | Fail | Partial | N/A | Avg score |`);
  lines.push(`|---|---:|---:|---:|---:|---:|`);
  for (const d of Object.keys(rep.perDimension).sort()) {
    const b = rep.perDimension[d];
    lines.push(`| \`${d}\` | ${b.pass} | ${b.fail} | ${b.partial} | ${b.notApplicable} | ${b.averageScore.toFixed(3)} |`);
  }
  lines.push("");
  lines.push(`## Case results`);
  lines.push("");
  for (const c of rep.cases) {
    if (c.split === "holdout" && !revealHoldout) {
      lines.push(`### ${c.label} · ${c.overall}`);
      lines.push(`_Holdout case — detail suppressed. Overall verdict only._`);
      lines.push("");
      continue;
    }
    lines.push(`### ${c.label}`);
    lines.push(`- Split: \`${c.split}\` · Category: \`${c.category}\` · Overall: **${c.overall}** · Latency: ${c.latencyMs} ms`);
    lines.push(`- Supplier: \`${c.extract.supplier ?? "(none)"}\``);
    lines.push(`- Invoice #: \`${c.extract.invoiceNumber ?? "(none)"}\``);
    lines.push(`- Total: \`${c.extract.total ?? "(none)"} ${c.extract.currency ?? ""}\``);
    lines.push(`- GL Top-1: \`${c.extract.glLeaderAccountNumber ?? "(abstained)"} ${c.extract.glLeaderName ?? ""}\` (confidence: \`${c.extract.glConfidence ?? "null"}\`)`);
    lines.push("");
    lines.push(`| Dimension | Verdict | Reason |`);
    lines.push(`|---|---|---|`);
    for (const r of c.results) {
      const badge = r.unsafe && r.verdict === "FAIL" ? `**UNSAFE / FAIL**` : r.verdict;
      lines.push(`| \`${r.dimension}\` | ${badge} | ${r.reason.replace(/\|/g, "\\|")} |`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

async function main() {
  const args = parseArgs(process.argv);

  // Env flags for the eligibility guards. Set BEFORE Prisma /
  // analyser imports so the modules read them at first evaluation.
  process.env.AP_INTELLIGENCE_PHASE0_SAFETY = args.phase0 ? "1" : "0";
  process.env.AP_INTELLIGENCE_PHASE2_ELIGIBILITY = args.phase2 ? "1" : "0";

  // Provision a disposable SQLite file BEFORE the production-guard
  // check reads DATABASE_URL — the guard's whole purpose is to
  // refuse a prod URL, which we replace here with a temp file.
  const dbFile = provisionDisposableDatabase();
  assertNotProduction();

  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  fs.mkdirSync(BASELINES_DIR, { recursive: true });

  const runId = `ap-bench-${new Date().toISOString().replace(/[:.]/g, "-")}-p0${args.phase0 ? "on" : "off"}-p2${args.phase2 ? "on" : "off"}`;
  const startedAt = new Date().toISOString();

  console.log(`AP Benchmark ${runId}`);
  console.log(`  Phase 0 containment (post-ranker guard): ${args.phase0 ? "ENABLED" : "DISABLED"}`);
  console.log(`  Phase 2 eligibility (pre-ranker gate):   ${args.phase2 ? "ENABLED" : "DISABLED"}`);
  console.log(`  Split filter: ${args.split ?? "all"}`);

  const prisma = new PrismaClient();
  let clubId: string | null = null;
  const runResults: CaseRunResult[] = [];
  try {
    const cases = loadCorpus(args.split);
    console.log(`  Cases loaded: ${cases.length}`);
    const seedResult = await seedBenchmarkTenant(prisma, randomUUID().slice(0, 8));
    clubId = seedResult.clubId;
    console.log(`  Seeded disposable club: ${clubId}`);
    for (const c of cases) {
      process.stdout.write(`  [${c.split}] ${c.id} ...`);
      try {
        const res = await runOneCase(prisma, clubId, c);
        runResults.push(res);
        process.stdout.write(` ${res.overall} (${res.latencyMs} ms)\n`);
      } catch (e) {
        console.error(`  ! case ${c.id} threw: ${(e as Error).message}`);
        runResults.push({
          caseId: c.id, split: c.split, category: c.category, label: c.label,
          latencyMs: 0,
          results: [{ dimension: "runner", verdict: "FAIL", score: 0, actual: null, expected: null, reason: `threw: ${(e as Error).message?.slice(0, 200)}` }],
          overall: "FAIL",
          extract: {},
        });
      }
    }
  } finally {
    if (clubId) {
      await tearDownBenchmarkTenant(prisma, clubId);
    }
    await prisma.$disconnect();
    teardownDisposableDatabase(dbFile);
  }
  const finishedAt = new Date().toISOString();

  const manifestVersion = (JSON.parse(fs.readFileSync(path.join(CORPUS_ROOT, "manifest.json"), "utf8")) as { version: string }).version;
  const report = aggregate(runResults, args.phase0, manifestVersion, runId, startedAt, finishedAt);

  const jsonPath = path.join(REPORTS_DIR, `${runId}.json`);
  const mdPath = path.join(REPORTS_DIR, `${runId}.md`);
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  fs.writeFileSync(mdPath, renderMarkdown(report, args.revealHoldout));

  console.log(`\nReport JSON: ${path.relative(process.cwd(), jsonPath)}`);
  console.log(`Report MD:   ${path.relative(process.cwd(), mdPath)}`);
  console.log(`Totals: cases=${report.totals.cases} pass=${report.totals.pass} fail=${report.totals.fail} unsafe=${report.totals.unsafeRecommendations}`);

  if (args.sealBaseline) {
    const baselinePath = path.join(BASELINES_DIR, `${runId}.baseline.json`);
    fs.writeFileSync(baselinePath, JSON.stringify(report, null, 2));
    console.log(`Baseline sealed: ${path.relative(process.cwd(), baselinePath)}`);
  }

  // Exit code: non-zero if ANY unsafe recommendation OR any FAIL
  // outside the holdout split. Holdout FAILs are advisory in V1 —
  // they should not block a release until the founder decides how
  // to weight them.
  const nonHoldoutFails = report.cases.filter((c) => c.split !== "holdout" && c.overall === "FAIL").length;
  const blocker = report.totals.unsafeRecommendations > 0 || nonHoldoutFails > 0;
  process.exit(blocker ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
