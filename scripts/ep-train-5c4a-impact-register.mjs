#!/usr/bin/env node
// EP-TRAIN-5C-4A (2026-11-02) — Activation-readiness impact register.
//
// READ-ONLY diagnostic.  Builds the per-pair impact register the
// directive §5 requires.  Also classifies every employee + course
// per directive §4.  No DB writes.  Zero obligations issued.  Zero
// completions / attempts / progress rows mutated.
//
// Runs inline via `flyctl ssh console` (base64 pattern) so no new
// image deploy is required.  See docs/ep-train-5c4a-readiness-report.md.

import { createRequire } from "node:module";
// Resolve Prisma from the Next.js standalone output so the script
// can be dropped anywhere on the Fly container's filesystem.
const req = createRequire("/app/.next/standalone/node_modules/@prisma/client/");
const { PrismaClient } = req("@prisma/client");

const prisma = new PrismaClient();

if (process.env.DRY_RUN === "0" || process.env.ALLOW_WRITES === "1") {
  console.error(JSON.stringify({
    ok: false,
    refused: "EP-TRAIN-5C-4A is READ-ONLY.  Any attempt to disable the guard is refused.  Live backfill is EP-TRAIN-5C-4B and requires separate founder authorization.",
  }));
  process.exit(2);
}

// -------------------------------------------------------------------
// Classification rules.  These are the ONLY heuristics applied; any
// row that doesn't match a positive signal is REVIEW_REQUIRED.
// -------------------------------------------------------------------

function classifyEmployee(emp, club) {
  // Fixture: EP-TRAIN-3 Slice 3 disposable fixture prefix.
  if (emp.employeeNumber && /^E-SLICE3-/.test(emp.employeeNumber)) {
    return { tier: "FIXTURE", subkind: "ep-train-3-slice3-disposable", reason: "employeeNumber matches E-SLICE3-* fixture prefix" };
  }
  // HR-2B.5 staging fixture club (per club.slug).
  if (club.slug && /^hr-2b5-staging/.test(club.slug)) {
    return { tier: "FIXTURE", subkind: "hr-2b5-staging", reason: "club is HR-2B.5 Staging Fixture" };
  }
  // SLICE C BENEFITS staging synthetic.
  if (club.name && /SLICE C BENEFITS TEST — Synthetic/i.test(club.name)) {
    return { tier: "FIXTURE", subkind: "slice-c-benefits-synthetic", reason: "club name matches SLICE C BENEFITS TEST synthetic" };
  }
  // Classified by lifecycle status.
  if (emp.employeeLifecycle === "ACTIVE" && emp.status === "ACTIVE" && emp.onboardingState === "APPROVED") {
    return { tier: "LEGITIMATE_ACTIVE", subkind: null, reason: "employeeLifecycle=ACTIVE + status=ACTIVE + onboardingState=APPROVED" };
  }
  if (emp.employeeLifecycle === "TERMINATED" || emp.status === "TERMINATED") {
    return { tier: "LEGITIMATE_INACTIVE", subkind: "terminated", reason: "lifecycle or status is TERMINATED" };
  }
  if (emp.employeeLifecycle === "LEAVE") {
    return { tier: "LEGITIMATE_INACTIVE", subkind: "on-leave", reason: "employeeLifecycle=LEAVE" };
  }
  if (emp.onboardingState && emp.onboardingState !== "APPROVED") {
    return { tier: "INCOMPLETE_ONBOARDING", subkind: emp.onboardingState, reason: `onboardingState=${emp.onboardingState}` };
  }
  return { tier: "REVIEW_REQUIRED", subkind: null, reason: "no positive classification signal" };
}

function classifyCourse(course, version) {
  // Fixture: EP-TRAIN-3 Slice 3 disposable course prefix.
  if (course.code && /^SLICE3_/.test(course.code)) {
    return { tier: "FIXTURE", subkind: "ep-train-3-slice3-disposable", reason: "course code matches SLICE3_* fixture prefix" };
  }
  // Retired at course level.
  if (course.retiredAt) {
    return { tier: "RETIRED", subkind: "course-retired", reason: `course.retiredAt=${course.retiredAt.toISOString?.() ?? course.retiredAt}` };
  }
  // Version state.
  if (version.state === "DRAFT") {
    return { tier: "DRAFT", subkind: null, reason: "courseVersion.state=DRAFT" };
  }
  if (version.state === "RETIRED") {
    return { tier: "RETIRED", subkind: "version-retired", reason: "courseVersion.state=RETIRED" };
  }
  if (version.state === "PUBLISHED" && !course.retiredAt) {
    return { tier: "LEGITIMATE_PUBLISHED", subkind: null, reason: "state=PUBLISHED + course not retired" };
  }
  return { tier: "REVIEW_REQUIRED", subkind: null, reason: "no positive classification signal" };
}

function parseIds(json) {
  if (!json) return [];
  try { const v = JSON.parse(json); return Array.isArray(v) ? v : []; }
  catch { return []; }
}

async function resolveApplicableForEmployee(employeeId) {
  const emp = await prisma.employee.findUnique({
    where: { id: employeeId },
    select: { id: true, clubId: true, departmentId: true, positionId: true },
  });
  if (!emp) return [];
  const now = new Date();
  const assignments = await prisma.employeeEmploymentAssignment.findMany({
    where: {
      employeeId: emp.id,
      effectiveFrom: { lte: now },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
    },
    select: { departmentId: true, positionId: true },
  });
  const deptIds = new Set();
  const positionIds = new Set();
  for (const a of assignments) {
    if (a.departmentId) deptIds.add(a.departmentId);
    if (a.positionId) positionIds.add(a.positionId);
  }
  if (emp.departmentId) deptIds.add(emp.departmentId);
  if (emp.positionId) positionIds.add(emp.positionId);

  const [publishedVersions, explicitAssignments] = await Promise.all([
    prisma.trainingCourseVersion.findMany({
      where: { state: "PUBLISHED", course: { clubId: emp.clubId, retiredAt: null } },
      include: { course: { select: { id: true, code: true, title: true, category: true, clubId: true, retiredAt: true } } },
      orderBy: [{ course: { title: "asc" } }, { version: "desc" }],
    }),
    prisma.trainingAssignment.findMany({ where: { clubId: emp.clubId, employeeId: emp.id }, select: { courseId: true } }),
  ]);
  const assignedCourseIds = new Set(explicitAssignments.map((a) => a.courseId));
  const out = [];
  const seen = new Set();
  for (const v of publishedVersions) {
    if (seen.has(v.course.id)) continue;
    let reason = null;
    if (assignedCourseIds.has(v.course.id)) reason = "assigned";
    else if (v.appliesToAll) reason = "all";
    else if (parseIds(v.appliesToDeptIds).some((id) => deptIds.has(id))) reason = "department";
    else if (parseIds(v.appliesToPositionIds).some((id) => positionIds.has(id))) reason = "position";
    if (reason === null) continue;
    seen.add(v.course.id);
    out.push({
      courseId: v.course.id, courseCode: v.course.code, courseTitle: v.course.title,
      category: v.course.category, course: v.course,
      versionId: v.id, versionNumber: v.version,
      required: v.required, applicabilityReason: reason,
      version: v,
    });
  }
  return out;
}

async function run() {
  const register = [];
  const employeeClassifications = [];
  const courseClassifications = [];

  const clubs = await prisma.club.findMany({ select: { id: true, name: true, slug: true } });
  const clubById = new Map(clubs.map((c) => [c.id, c]));

  // Classify every ACTIVE / PRE_HIRE / LEAVE employee (same scope the
  // dry-run uses) — this is the universe of potentially-affected rows.
  const employees = await prisma.employee.findMany({
    where: { employeeLifecycle: { in: ["ACTIVE", "PRE_HIRE", "LEAVE"] } },
    select: {
      id: true, clubId: true, employeeNumber: true, firstName: true, lastName: true,
      email: true, status: true, employeeLifecycle: true, onboardingState: true,
      createdAt: true,
    },
  });
  for (const emp of employees) {
    const club = clubById.get(emp.clubId) ?? { id: emp.clubId, name: "(unknown club)", slug: null };
    employeeClassifications.push({
      employeeId: emp.id, employeeNumber: emp.employeeNumber,
      displayName: `${emp.firstName ?? ""} ${emp.lastName ?? ""}`.trim(),
      email: emp.email, clubId: emp.clubId, clubName: club.name,
      status: emp.status, employeeLifecycle: emp.employeeLifecycle,
      onboardingState: emp.onboardingState,
      createdAt: emp.createdAt?.toISOString?.() ?? null,
      classification: classifyEmployee(emp, club),
    });
  }

  // Classify every course + version (snapshot current publication state).
  const courses = await prisma.trainingCourse.findMany({
    select: {
      id: true, clubId: true, code: true, title: true, category: true, retiredAt: true,
      currentVersionId: true,
      versions: {
        select: { id: true, version: true, state: true, required: true, appliesToAll: true,
                  appliesToDeptIds: true, appliesToPositionIds: true, title: true, retiredAt: true },
      },
    },
  });
  for (const course of courses) {
    const club = clubById.get(course.clubId) ?? { id: course.clubId, name: "(unknown)", slug: null };
    for (const v of course.versions) {
      courseClassifications.push({
        courseId: course.id, courseCode: course.code, courseTitle: course.title,
        category: course.category, clubId: course.clubId, clubName: club.name,
        versionId: v.id, versionNumber: v.version, versionState: v.state,
        required: v.required, appliesToAll: v.appliesToAll,
        isCurrentVersion: course.currentVersionId === v.id,
        courseRetiredAt: course.retiredAt?.toISOString?.() ?? null,
        versionRetiredAt: v.retiredAt?.toISOString?.() ?? null,
        classification: classifyCourse(course, v),
      });
    }
  }

  // Build the per-pair register using the applicability resolver.
  for (const emp of employees) {
    const empClass = employeeClassifications.find((e) => e.employeeId === emp.id).classification;
    const applicable = await resolveApplicableForEmployee(emp.id);
    const club = clubById.get(emp.clubId);

    if (applicable.length === 0) {
      register.push({
        clubId: emp.clubId, clubName: club?.name ?? null,
        employeeId: emp.id, employeeNumber: emp.employeeNumber,
        employeeDisplayName: `${emp.firstName ?? ""} ${emp.lastName ?? ""}`.trim(),
        employeeLifecycle: emp.employeeLifecycle,
        employeeClassification: empClass.tier,
        courseId: null, courseTitle: null, courseVersionId: null, category: null,
        applicabilityReason: null, required: null,
        historicalCompletionId: null, historicalCompletedAt: null, historicalScore: null,
        existingObligationId: null, existingObligationStatus: null, existingObligationReason: null,
        proposedObligationReason: null, proposedIssuanceKey: null,
        legacyCompliance: "no-applicable",
        expectedComplianceAfter: "no-applicable",
        schedulingImpact: "none",
        recommendedAction: "SKIP_NONAPPLICABLE",
        actionRationale: "no training courses apply to this employee",
      });
      continue;
    }

    // Prefetch completions + obligations for all applicable (employee,
    // courseVersion) pairs in one query each.
    const applicableCourseIds = applicable.map((a) => a.courseId);
    const applicableVersionIds = applicable.map((a) => a.versionId);
    const [completions, obligations] = await Promise.all([
      prisma.trainingCompletion.findMany({
        where: { employeeId: emp.id, courseId: { in: applicableCourseIds } },
        select: { id: true, courseId: true, courseVersionId: true, completedAt: true, score: true },
      }),
      prisma.trainingObligation.findMany({
        where: { employeeId: emp.id, courseId: { in: applicableCourseIds }, status: "OUTSTANDING" },
        select: { id: true, courseId: true, courseVersionId: true, reason: true, issuanceKey: true, issuedAt: true },
      }),
    ]);

    for (const applicableRow of applicable) {
      const course = applicableRow.course;
      const version = applicableRow.version;
      const historicalCompletion = completions.find((c) => c.courseVersionId === applicableRow.versionId);
      const anyHistoricalForCourse = completions.find((c) => c.courseId === applicableRow.courseId);
      const existingObligation = obligations.find((o) => o.courseId === applicableRow.courseId);

      const courseClass = classifyCourse(course, version);

      // Legacy compliance = scheduling-eligibility interpretation: a
      // historical completion on ANY version of the course counts.
      // (Current scheduling resolver merges completions by courseId.)
      const legacyCompliance = anyHistoricalForCourse ? "compliant" : "noncompliant";

      // Expected compliance after backfill (per 5C-1 resolver):
      // - compliant if historical completion on THIS version AND no outstanding
      // - outstanding otherwise (new INITIAL would be issued)
      // - already-outstanding if existing obligation
      const expectedComplianceAfter = (() => {
        if (existingObligation) return "already-outstanding";
        if (historicalCompletion) return "compliant";
        return "outstanding";
      })();

      // Scheduling impact: does the directive protect against unexpected flips?
      // "same" means no shift in effective allow/deny.
      const schedulingImpact = (() => {
        if (legacyCompliance === "compliant" && expectedComplianceAfter === "outstanding") return "newly-blocked";
        if (legacyCompliance === "noncompliant" && expectedComplianceAfter === "compliant") return "newly-allowed";
        if (legacyCompliance === "noncompliant" && expectedComplianceAfter === "outstanding") return "already-blocked";
        return "same";
      })();

      // Proposed issuance key format from the schema comments:
      //   INITIAL -> init:${applicabilityWindowBucket}
      // The bucket format is "owned by the service" (not externalised yet).
      // For audit purposes we propose a readable deterministic key.
      const proposedIssuanceKey = existingObligation
        ? null
        : historicalCompletion
          ? null
          : `init:v${version.version}:${applicableRow.applicabilityReason}:5C-4B-initial-backfill`;

      // Recommended action per directive §5 7-tier classification.
      const recommendedAction = (() => {
        if (empClass.tier === "FIXTURE") return "SKIP_FIXTURE";
        if (courseClass.tier === "FIXTURE") return "SKIP_FIXTURE";
        if (empClass.tier === "LEGITIMATE_INACTIVE") return "SKIP_INACTIVE";
        if (empClass.tier === "INCOMPLETE_ONBOARDING") return "REVIEW_REQUIRED";
        if (empClass.tier === "REVIEW_REQUIRED") return "REVIEW_REQUIRED";
        if (courseClass.tier !== "LEGITIMATE_PUBLISHED") return "REVIEW_REQUIRED";
        if (existingObligation) return "ALREADY_COVERED";
        if (historicalCompletion) return "PRESERVE_COMPLIANT";
        return "CREATE_INITIAL";
      })();

      const actionRationale = (() => {
        if (recommendedAction === "SKIP_FIXTURE") return `fixture scope: emp=${empClass.tier}/${empClass.subkind ?? ""}; course=${courseClass.tier}/${courseClass.subkind ?? ""}`;
        if (recommendedAction === "SKIP_INACTIVE") return `inactive: ${empClass.subkind ?? empClass.reason}`;
        if (recommendedAction === "ALREADY_COVERED") return `existing OUTSTANDING ${existingObligation?.reason} obligation covers this requirement`;
        if (recommendedAction === "PRESERVE_COMPLIANT") return `historical completion on this version satisfies requirement`;
        if (recommendedAction === "CREATE_INITIAL") return `legitimate active employee + applicable published course + no completion/obligation`;
        if (recommendedAction === "REVIEW_REQUIRED") return `ambiguous classification — emp=${empClass.tier}; course=${courseClass.tier}`;
        return "unclassified";
      })();

      register.push({
        clubId: emp.clubId, clubName: club?.name ?? null,
        employeeId: emp.id, employeeNumber: emp.employeeNumber,
        employeeDisplayName: `${emp.firstName ?? ""} ${emp.lastName ?? ""}`.trim(),
        employeeLifecycle: emp.employeeLifecycle,
        employeeClassification: empClass.tier,
        courseId: applicableRow.courseId, courseTitle: applicableRow.courseTitle,
        courseCode: applicableRow.courseCode, courseVersionId: applicableRow.versionId,
        category: applicableRow.category,
        applicabilityReason: applicableRow.applicabilityReason,
        required: applicableRow.required,
        courseClassification: courseClass.tier,
        historicalCompletionId: historicalCompletion?.id ?? null,
        historicalCompletedAt: historicalCompletion?.completedAt?.toISOString() ?? null,
        historicalScore: historicalCompletion?.score ?? null,
        existingObligationId: existingObligation?.id ?? null,
        existingObligationStatus: existingObligation ? "OUTSTANDING" : null,
        existingObligationReason: existingObligation?.reason ?? null,
        proposedObligationReason: recommendedAction === "CREATE_INITIAL" ? "INITIAL" : null,
        proposedIssuanceKey,
        legacyCompliance,
        expectedComplianceAfter,
        schedulingImpact,
        recommendedAction,
        actionRationale,
      });
    }
  }

  // Idempotency check: are any proposed issuanceKeys ambiguous or colliding?
  const proposedKeys = register
    .filter((r) => r.proposedIssuanceKey)
    .map((r) => ({ emp: r.employeeId, course: r.courseId, version: r.courseVersionId, key: r.proposedIssuanceKey }));
  const keyCollisions = [];
  const seen = new Map();
  for (const row of proposedKeys) {
    const compoundKey = `${row.emp}::${row.course}::${row.version}::${row.key}`;
    if (seen.has(compoundKey)) keyCollisions.push({ compoundKey, prev: seen.get(compoundKey), curr: row });
    else seen.set(compoundKey, row);
  }

  // Summary rollups.
  const summary = {
    employees: employeeClassifications.length,
    courses: courseClassifications.length,
    pairs: register.length,
    actions: {},
    employeeTiers: {},
    courseTiers: {},
    schedulingImpact: {},
    legacyCompliance: {},
    expectedCompliance: {},
  };
  for (const r of register) summary.actions[r.recommendedAction] = (summary.actions[r.recommendedAction] ?? 0) + 1;
  for (const e of employeeClassifications) summary.employeeTiers[e.classification.tier] = (summary.employeeTiers[e.classification.tier] ?? 0) + 1;
  for (const c of courseClassifications) summary.courseTiers[c.classification.tier] = (summary.courseTiers[c.classification.tier] ?? 0) + 1;
  for (const r of register) {
    summary.schedulingImpact[r.schedulingImpact] = (summary.schedulingImpact[r.schedulingImpact] ?? 0) + 1;
    summary.legacyCompliance[r.legacyCompliance] = (summary.legacyCompliance[r.legacyCompliance] ?? 0) + 1;
    summary.expectedCompliance[r.expectedComplianceAfter] = (summary.expectedCompliance[r.expectedComplianceAfter] ?? 0) + 1;
  }

  console.log("REGISTER " + JSON.stringify({
    ok: true, generatedAt: new Date().toISOString(),
    summary, keyCollisions,
    employeeClassifications, courseClassifications, register,
  }));
}

run().then(() => prisma.$disconnect()).then(() => process.exit(0))
  .catch((e) => { console.error("ERR " + (e && e.message ? e.message : String(e))); process.exit(1); });
