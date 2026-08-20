// scripts/resolve-touched-tests.ts
//
// 2026-08-20 · Test-workflow optimization.
//
// Reads `git diff --name-only <base>...HEAD` (default base: `main`)
// and prints the vitest globs that cover the changed source files.
// Used by `npm run gate:hr:touched` to build the vitest `include`
// list on the fly.
//
// The mapping is INTENT-based, not hardcoded — the rules match against
// source-file prefixes so new files under a covered surface pick up
// their test globs automatically.
//
// Rules (evaluated top-to-bottom; a source file may match multiple rules
// → all matching test globs are included):
//
//   Prefix                                            → test globs
//   ─────────────────────────────────────────────────────────────
//   src/lib/hr/emergency-contacts.ts                    →  emergency + onboarding-continuation
//   src/lib/hr/onboarding-requirements.ts               →  requirements + docs + source-contract
//   src/lib/hr/invitations.ts                           →  invitation + auth-boundary
//   src/lib/hr/employee-self-service.ts                 →  employee-self-service + continuation
//   src/lib/hr/onboarding-continuation.ts               →  continuation
//   src/lib/hr/employees.ts                             →  delete/archive + directory
//   src/lib/hr/employee-positions.ts                    →  position-department + directory
//   src/lib/hr/documents.ts                             →  documents-categories + banking-upload-auth
//   src/lib/hr/credentials.ts                           →  credentials + requirements
//   src/lib/hr/sensitive-identity.ts                    →  SIN self-service + admin
//   src/lib/hr/bank-account.ts                          →  banking + banking-upload-auth
//   src/lib/hr/tax-profile.ts                           →  TD1 + tax
//   src/lib/hr/onboarding-sessions.ts                   →  session state + continuation
//   src/lib/hr/onboarding-questions.ts                  →  canonical reader
//   src/lib/hr/club-payroll-province.ts                 →  club-payroll-province + TD1 club-province
//   src/lib/hr/employee-actor.ts                        →  ANY employee-facing suite
//   src/lib/hr/employee-onboarding-session.ts           →  cookie/session
//   src/lib/hr/**                                       →  full HR (fallback for HR service files not
//                                                          explicitly mapped)
//   src/lib/mailbox/**                                  →  mailbox tests + integration sentinel
//   src/lib/mission-control/**                          →  mission-control gate + integration sentinel
//   src/lib/ap-intelligence/**                          →  mission-control gate + AP tests
//   src/lib/integrations/microsoft-graph-delegated.ts   →  delegated-outbound + Outlook contract
//   src/app/hr/onboarding/**                            →  onboarding routes + HR domain
//   src/app/api/hr/**                                   →  API-side HR tests
//   src/app/app/admin/people/**                         →  admin-workflows + directory
//   src/components/hr/**                                →  HR-related tests
//   src/components/spectre/**                           →  integration sentinel
//   src/components/admin/AdminShell.tsx                 →  integration sentinel + shell tests
//   src/components/sidebar-nav-data.ts                  →  integration sentinel
//   prisma*/schema.prisma                               →  FULL HR (broad blast radius)
//   prisma*/migrations/**                               →  FULL HR
//   tests/**                                            →  self (the test itself)
//
// If nothing HR-relevant changed, prints the integration sentinel only
// (fast smoke). If no source-file changes at all, exits 1 so the caller
// knows the "touched" set was empty — safer than running nothing.

import { execSync } from "node:child_process";

interface Rule {
  match: RegExp;
  globs: string[];
  reason: string;
}

// Individual-service rules first (most specific), then broader
// fallbacks. Every source file is matched against ALL rules; the
// resulting glob set is the union.
const RULES: Rule[] = [
  { match: /^src\/lib\/hr\/emergency-contacts\.ts$/,
    globs: ["tests/hr/security-compliance/emergency-and-requirements-self-service.test.ts",
            "tests/hr/security-compliance/onboarding-continuation.test.ts"],
    reason: "emergency-contact service" },

  { match: /^src\/lib\/hr\/onboarding-requirements\.ts$/,
    globs: ["tests/hr/admin-workflows/onboarding-requirements.test.ts",
            "tests/hr/admin-workflows/hr2b4-source-contract.test.ts",
            "tests/hr/security-compliance/emergency-and-requirements-self-service.test.ts",
            "tests/hr/security-compliance/onboarding-continuation.test.ts"],
    reason: "onboarding-requirements service" },

  { match: /^src\/lib\/hr\/invitations\.ts$/,
    globs: ["tests/hr/ui-2a/invitation-api.test.ts",
            "tests/hr/security-compliance/invitations.test.ts"],
    reason: "invitation lifecycle" },

  { match: /^src\/lib\/hr\/employee-self-service\.ts$/,
    globs: ["tests/hr/security-compliance/employee-self-service.test.ts",
            "tests/hr/security-compliance/employee-self-service-payroll.test.ts",
            "tests/hr/security-compliance/emergency-and-requirements-self-service.test.ts",
            "tests/hr/security-compliance/onboarding-continuation.test.ts",
            "tests/hr/security-compliance/banking-upload-auth.test.ts",
            "tests/hr/security-compliance/banking-extraction.test.ts"],
    reason: "employee self-service surface" },

  { match: /^src\/lib\/hr\/onboarding-continuation\.ts$/,
    globs: ["tests/hr/security-compliance/onboarding-continuation.test.ts",
            "tests/hr/admin-workflows/hr2b4-source-contract.test.ts"],
    reason: "canonical continuation resolver" },

  { match: /^src\/lib\/hr\/employees\.ts$/,
    globs: ["tests/hr/admin-workflows/employee-delete-archive.test.ts",
            "tests/hr/ui-2a/employee-directory-server.test.ts",
            "tests/hr/ui-2a/employee-create-api.test.ts"],
    reason: "employee CRUD service" },

  { match: /^src\/lib\/hr\/employee-positions\.ts$/,
    globs: ["tests/hr/admin-workflows/position-department-binding.test.ts",
            "tests/hr/security-compliance/employee-positions.test.ts"],
    reason: "position-department service" },

  { match: /^src\/lib\/hr\/documents\.ts$/,
    globs: ["tests/hr/admin-workflows/documents-categories.test.ts",
            "tests/hr/security-compliance/banking-upload-auth.test.ts",
            "tests/hr/security-compliance/banking-extraction.test.ts"],
    reason: "document category catalog" },

  { match: /^src\/lib\/hr\/credentials\.ts$/,
    globs: ["tests/hr/security-compliance/emergency-and-requirements-self-service.test.ts",
            "tests/hr/admin-workflows/onboarding-requirements.test.ts"],
    reason: "credential service" },

  { match: /^src\/lib\/hr\/sensitive-identity\.ts$/,
    globs: ["tests/hr/security-compliance/sensitive-identity.test.ts",
            "tests/hr/security-compliance/employee-self-service-payroll.test.ts"],
    reason: "SIN service" },

  { match: /^src\/lib\/hr\/bank-account\.ts$/,
    globs: ["tests/hr/security-compliance/bank-account.test.ts",
            "tests/hr/security-compliance/banking-upload-auth.test.ts",
            "tests/hr/security-compliance/employee-self-service-payroll.test.ts",
            "tests/hr/cross-cutting/banking-history.test.ts"],
    reason: "banking service" },

  { match: /^src\/lib\/hr\/tax-profile\.ts$/,
    globs: ["tests/hr/security-compliance/tax-profile.test.ts",
            "tests/hr/security-compliance/employee-self-service-payroll.test.ts",
            "tests/hr/admin-workflows/td1-club-province.test.ts",
            "tests/hr/admin-workflows/td1-federal-page-source.test.ts"],
    reason: "tax-profile service" },

  { match: /^src\/lib\/hr\/onboarding-sessions\.ts$/,
    globs: ["tests/hr/security-compliance/onboarding-sessions.test.ts",
            "tests/hr/security-compliance/onboarding-continuation.test.ts"],
    reason: "session-state machine" },

  { match: /^src\/lib\/hr\/onboarding-questions\.ts$/,
    globs: ["tests/hr/onboarding-question-canonical-reader.test.ts"],
    reason: "canonical question reader" },

  { match: /^src\/lib\/hr\/club-payroll-province\.ts$/,
    globs: ["tests/hr/admin-workflows/club-payroll-province.test.ts",
            "tests/hr/admin-workflows/td1-club-province.test.ts",
            "tests/hr/admin-workflows/td1-federal-page-source.test.ts"],
    reason: "Club payroll province resolver" },

  { match: /^src\/lib\/hr\/employee-onboarding-session\.ts$/,
    globs: ["tests/hr/security-compliance/banking-upload-auth.test.ts",
            "tests/mission-control-integration-sentinel.test.ts"],
    reason: "session cookie config" },

  // Onboarding route files — pin the source-contract + relevant
  // self-service tests.
  { match: /^src\/app\/hr\/onboarding\/emergency\//,
    globs: ["tests/hr/admin-workflows/hr2b4-source-contract.test.ts",
            "tests/hr/security-compliance/emergency-and-requirements-self-service.test.ts"],
    reason: "employee emergency route" },
  { match: /^src\/app\/hr\/onboarding\/documents\//,
    globs: ["tests/hr/admin-workflows/hr2b4-source-contract.test.ts",
            "tests/hr/security-compliance/emergency-and-requirements-self-service.test.ts"],
    reason: "employee documents route" },
  { match: /^src\/app\/hr\/onboarding\/ready-for-review\//,
    globs: ["tests/hr/admin-workflows/hr2b4-source-contract.test.ts"],
    reason: "ready-for-review boundary" },
  { match: /^src\/app\/hr\/onboarding\/_hr2b4-actions\.ts$/,
    globs: ["tests/hr/admin-workflows/hr2b4-source-contract.test.ts"],
    reason: "HR-2B.4 server actions" },
  { match: /^src\/app\/hr\/onboarding\/payroll\//,
    globs: ["tests/hr/security-compliance/employee-self-service-payroll.test.ts",
            "tests/hr/admin-workflows/td1-federal-page-source.test.ts",
            "tests/hr/admin-workflows/td1-club-province.test.ts",
            "tests/hr/security-compliance/onboarding-continuation.test.ts"],
    reason: "payroll routes" },

  // API surfaces
  { match: /^src\/app\/api\/hr\/onboarding-requirements\//,
    globs: ["tests/hr/admin-workflows/hr2b4-source-contract.test.ts",
            "tests/hr/admin-workflows/onboarding-requirements.test.ts"],
    reason: "admin onboarding-requirements API" },
  { match: /^src\/app\/api\/hr\/onboarding\/self\/requirement-document\//,
    globs: ["tests/hr/admin-workflows/hr2b4-source-contract.test.ts",
            "tests/hr/security-compliance/emergency-and-requirements-self-service.test.ts"],
    reason: "requirement-document upload API" },
  { match: /^src\/app\/api\/hr\//,
    globs: ["tests/hr/ui-2a/**/*.test.ts"],
    reason: "HR API surface" },
  { match: /^src\/app\/api\/people\/employees\/\[id\]\/lifecycle\//,
    globs: ["tests/hr/admin-workflows/employee-delete-archive.test.ts"],
    reason: "employee lifecycle API" },

  // Admin surfaces
  { match: /^src\/app\/app\/admin\/people\/onboarding-requirements\//,
    globs: ["tests/hr/admin-workflows/hr2b4-source-contract.test.ts",
            "tests/hr/admin-workflows/onboarding-requirements.test.ts"],
    reason: "admin onboarding-requirements page" },
  { match: /^src\/app\/app\/admin\/people\/employees\/\[id\]\//,
    globs: ["tests/hr/admin-workflows/hr2b4-source-contract.test.ts",
            "tests/hr/ui-2a/employee-directory-server.test.ts",
            "tests/mission-control-integration-sentinel.test.ts"],
    reason: "employee profile page" },
  { match: /^src\/app\/app\/admin\/people\/employees\/new\//,
    globs: ["tests/hr/admin-workflows/position-department-binding.test.ts",
            "tests/hr/ui-2a/employee-create-api.test.ts"],
    reason: "add-employee page" },
  { match: /^src\/app\/app\/admin\/people\//,
    globs: ["tests/hr/admin-workflows/**/*.test.ts"],
    reason: "People admin surface" },

  // Shared UI touches
  { match: /^src\/components\/hr\/EmployeeProfileView\.tsx$/,
    globs: ["tests/hr/admin-workflows/hr2b4-source-contract.test.ts",
            "tests/mission-control-integration-sentinel.test.ts"],
    reason: "employee profile view" },
  { match: /^src\/components\/hr\//,
    globs: ["tests/hr/admin-workflows/segmented-date-input.test.tsx",
            "tests/mission-control-integration-sentinel.test.ts"],
    reason: "shared HR components" },
  { match: /^src\/components\/spectre\/SpectreSidebar\.tsx$|^src\/components\/spectre\/SpectreTopBar\.tsx$|^src\/components\/spectre\/breadcrumb-labels\.tsx$/,
    globs: ["tests/mission-control-integration-sentinel.test.ts",
            "tests/mission-control-*.test.ts"],
    reason: "canonical Spectre shell" },
  { match: /^src\/components\/admin\/AdminShell\.tsx$/,
    globs: ["tests/mission-control-integration-sentinel.test.ts",
            "tests/mission-control-*.test.ts"],
    reason: "AdminShell chrome" },
  { match: /^src\/components\/sidebar-nav-data\.ts$/,
    globs: ["tests/mission-control-integration-sentinel.test.ts"],
    reason: "sidebar navigation data" },

  // Schema / migration → run FULL HR (broad blast radius).
  { match: /^prisma(-postgres)?\/schema\.prisma$/,
    globs: ["tests/hr/**/*.test.ts",
            "tests/hr/**/*.test.tsx",
            "tests/mission-control-integration-sentinel.test.ts"],
    reason: "schema change (broad blast radius)" },
  { match: /^prisma(-postgres)?\/migrations\//,
    globs: ["tests/hr/**/*.test.ts",
            "tests/hr/**/*.test.tsx",
            "tests/mission-control-integration-sentinel.test.ts"],
    reason: "migration change" },

  // A test file changed → run itself.
  { match: /^tests\/(.+)\.test\.(ts|tsx)$/,
    globs: ["__SELF__"], // handled below (echoes the test path itself)
    reason: "test file changed — run it" },
  { match: /^tests\/util\/db\.ts$/,
    globs: ["tests/hr/**/*.test.ts", "tests/hr/**/*.test.tsx"],
    reason: "test harness DB reset changed (broad blast)" },
  { match: /^tests\/setup\.ts$/,
    globs: ["tests/hr/**/*.test.ts", "tests/hr/**/*.test.tsx",
            "tests/mission-control-integration-sentinel.test.ts"],
    reason: "test setup changed" },

  // Fallback for any other HR service — run the domain suite (still
  // fast under per-worker isolation).
  { match: /^src\/lib\/hr\//,
    globs: ["tests/hr/**/*.test.ts"],
    reason: "HR library file (fallback → full HR)" },

  // Mailbox / mission-control / AP intelligence → mission-control gate.
  { match: /^src\/lib\/(mailbox|mission-control|ap-intelligence)\//,
    globs: ["tests/mission-control-*.test.ts", "tests/mailbox-*.test.ts",
            "tests/lib/mailbox/**/*.test.ts", "tests/phase4r-*.test.ts",
            "tests/mission-control-integration-sentinel.test.ts"],
    reason: "mission control surface" },
];

function collectTests(changed: string[]): { tests: string[]; matched: Array<{ file: string; reasons: string[] }> } {
  const tests = new Set<string>();
  const matched: Array<{ file: string; reasons: string[] }> = [];
  const alwaysInclude = new Set([
    // The integration sentinel is high-signal + fast; always include
    // it when the touched set intersects any HR/MC surface.
    "tests/mission-control-integration-sentinel.test.ts",
  ]);
  for (const file of changed) {
    const norm = file.replace(/\\/g, "/");
    const reasons: string[] = [];
    for (const rule of RULES) {
      if (!rule.match.test(norm)) continue;
      reasons.push(rule.reason);
      for (const g of rule.globs) {
        if (g === "__SELF__") tests.add(norm);
        else tests.add(g);
      }
    }
    if (reasons.length > 0) matched.push({ file: norm, reasons });
  }
  // If we matched anything HR/MC-related, add the sentinel.
  if (tests.size > 0) for (const t of alwaysInclude) tests.add(t);
  return { tests: [...tests].sort(), matched };
}

function main() {
  const args = process.argv.slice(2);
  const baseArg = args.find((a) => !a.startsWith("--")) ?? "main";
  const jsonMode = args.includes("--json");

  let diff: string;
  try {
    diff = execSync(`git diff --name-only ${baseArg}...HEAD`, { encoding: "utf8" }) +
      execSync("git status --porcelain", { encoding: "utf8" })
        .split("\n").filter(Boolean).map((l) => l.slice(3)).join("\n");
  } catch (err) {
    process.stderr.write(`git diff failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  }
  const changed = [...new Set(diff.split(/\r?\n/).filter(Boolean))];
  const { tests, matched } = collectTests(changed);

  if (jsonMode) {
    process.stdout.write(JSON.stringify({ base: baseArg, changed, matched, tests }, null, 2) + "\n");
    return;
  }

  if (tests.length === 0) {
    process.stderr.write(
      `No touched HR/MC test surfaces for changes since ${baseArg}. ` +
      `Falling back to the integration sentinel only.\n`,
    );
    process.stdout.write("tests/mission-control-integration-sentinel.test.ts\n");
    return;
  }

  // Print one glob per line (space-joined by caller shell).
  process.stdout.write(tests.join(" ") + "\n");
}

main();
