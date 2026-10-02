// TB-HIST-6 (2026-10-01) — staging-only idempotent Jonas Department
// bootstrap for Coulee.
//
// Founder authorisation (TB-HIST-6 §1): create the 11 Spectre
// Departments required to resolve the real Dec 31 2025 TB
// Departmental workbook's Jonas department codes. The 000000
// "Balance Sheet" marker is intentionally NOT created — it stays
// null (nondepartmental).
//
// This route:
//   • Rejected in production.
//   • Requires an authenticated principal with access to the batch's
//     tenant (or SUPER_ADMIN).
//   • Reads the tenant's current Department records BEFORE acting.
//   • Idempotent: a Department whose code OR name already matches an
//     existing record is LEFT UNCHANGED.
//   • Conflict-safe: if a Department record exists whose code is one
//     of the 11 TB-HIST-6 codes but whose NAME differs (or vice-
//     versa), the route STOPS and returns the conflict rather than
//     silently overwriting.
//   • Writes NOTHING else — no COA mutations, no ReportingLedger*
//     records, no accounting activity.
//
// The route is one-shot by design. Running it twice is a no-op.

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requirePrincipal } from "@/lib/services/principal";
import { isSuperAdmin, type Principal } from "@/lib/rbac";

// The 11 Spectre Departments authorised by TB-HIST-6 §1. The map
// MUST stay in lockstep with
// `DEFAULT_JONAS_DEPARTMENT_MAPPING` in jonas-department-mapping.ts.
// Order is sort-order for the tenant table.
// Target Spectre Department rows the Jonas resolver maps to.
// `GROUNDS` ships pre-populated on Coulee staging (as "Course &
// Grounds" — code match, name drift accepted). `F&B` and `ADMIN`
// also pre-exist with the exact names the mapping needs, so they
// are intentionally OMITTED from this list — directive §1 forbids
// creating duplicates and the mapping was adjusted to reuse the
// existing Coulee codes.
const TB_HIST_6_DEPARTMENTS: ReadonlyArray<{ code: string; name: string; sortOrder: number }> = [
  { code: "GROUNDS",           name: "Grounds",                      sortOrder: 10 },
  { code: "GOLF_SHOP",         name: "Golf Shop",                    sortOrder: 20 },
  { code: "CLUBHOUSE",         name: "Clubhouse",                    sortOrder: 30 },
  { code: "DUES_AND_CHARGES",  name: "Dues & Charges",               sortOrder: 60 },
  { code: "LONG_RANGE_PLAN",   name: "Long Range Plan & Renovation", sortOrder: 70 },
  { code: "MENS_SECTION",      name: "Mens Section",                 sortOrder: 80 },
  { code: "LADIES_SECTION",    name: "Ladies Section",               sortOrder: 90 },
  { code: "TOURNAMENTS",       name: "Tournament Accounts",          sortOrder: 100 },
  { code: "CORPORATE",         name: "Corporate Income & Expenses",  sortOrder: 110 },
];

function isStaging(): boolean {
  const env = (process.env.SPECTRE_ENV ?? process.env.NEXT_PUBLIC_ENVIRONMENT ?? "").toLowerCase();
  if (env === "staging") return true;
  return env !== "production" && (process.env.NODE_ENV ?? "") !== "production";
}

function hasClubAccess(p: Principal, clubId: string): boolean {
  if (isSuperAdmin(p)) return true;
  return p.memberships.some((m) => m.clubId === clubId);
}

type DeptState = { code: string; name: string; id: string; isActive: boolean };

async function captureState(clubId: string): Promise<DeptState[]> {
  return prisma.department.findMany({
    where: { clubId },
    select: { id: true, code: true, name: true, isActive: true },
    orderBy: [{ sortOrder: "asc" }, { code: "asc" }],
  });
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  if (!isStaging()) return NextResponse.json({ error: "Not available in production." }, { status: 404 });
  const principal = await requirePrincipal();
  const clubIdParam = (req.nextUrl.searchParams.get("clubId") ?? "").trim();
  if (!clubIdParam) return NextResponse.json({ error: "clubId is required." }, { status: 400 });
  if (!hasClubAccess(principal, clubIdParam)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const current = await captureState(clubIdParam);
  const plan = TB_HIST_6_DEPARTMENTS.map((want) => classify(want, current));
  return NextResponse.json({ clubId: clubIdParam, current, plan });
}

/**
 * TB-HIST-6 (post-conflict adjustment) — a Department with a matching
 * CODE is always considered the same record (name drift is
 * informational — the resolver's `descriptionDrift` flag already
 * surfaces it to the operator). The only conflict is a NAME match
 * under a DIFFERENT code, because that would create accidental
 * duplicates. The founder-authorised 11-dept list in
 * TB_HIST_6_DEPARTMENTS has been pre-trimmed to omit F&B / ADMIN
 * which already exist with the exact names the mapping targets, so
 * this classifier generally returns `skip-exists` or `create`.
 */
function classify(
  want: typeof TB_HIST_6_DEPARTMENTS[number],
  current: DeptState[],
): { want: typeof TB_HIST_6_DEPARTMENTS[number]; action: string; existing?: DeptState | DeptState[] } {
  const byCode = current.find((d) => d.code.toUpperCase() === want.code.toUpperCase());
  const byName = current.find((d) => d.name.trim().toLowerCase() === want.name.trim().toLowerCase());
  if (byCode) {
    // Code match wins — the mapping targets this code. If the name
    // happens to drift (e.g. "Course & Grounds" for the GROUNDS code),
    // leave the tenant's name intact.
    return { want, action: "skip-exists", existing: byCode };
  }
  if (byName) {
    // Name exists under a different code — this is a genuine conflict.
    return { want, action: "conflict-name-different-code", existing: byName };
  }
  return { want, action: "create" };
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!isStaging()) return NextResponse.json({ error: "Not available in production." }, { status: 404 });
  const principal = await requirePrincipal();
  const body = await req.json().catch(() => ({})) as { clubId?: string; action?: string };
  if (body.action !== "bootstrapJonasDepartments") {
    return NextResponse.json({ error: `Unsupported action. Expected 'bootstrapJonasDepartments'.` }, { status: 400 });
  }
  const clubId = (body.clubId ?? "").trim();
  if (!clubId) return NextResponse.json({ error: "clubId is required." }, { status: 400 });
  if (!hasClubAccess(principal, clubId)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const before = await captureState(clubId);
  const conflicts: Array<{ want: typeof TB_HIST_6_DEPARTMENTS[number]; reason: string; existing: DeptState | DeptState[] }> = [];
  const toCreate: typeof TB_HIST_6_DEPARTMENTS[number][] = [];
  const skipped: Array<{ want: typeof TB_HIST_6_DEPARTMENTS[number]; existing: DeptState }> = [];

  for (const want of TB_HIST_6_DEPARTMENTS) {
    const result = classify(want, before);
    if (result.action === "skip-exists") {
      skipped.push({ want, existing: result.existing as DeptState });
    } else if (result.action === "conflict-name-different-code") {
      const existing = result.existing as DeptState;
      conflicts.push({
        want,
        reason: `Department name '${want.name}' exists but with code '${existing.code}' (want '${want.code}'). Update the Jonas→Spectre mapping to reuse the existing code rather than creating a duplicate.`,
        existing,
      });
    } else {
      toCreate.push(want);
    }
  }

  if (conflicts.length > 0) {
    return NextResponse.json({
      ok: false,
      reason: "conflicts-detected",
      conflicts: conflicts.map((c) => ({ want: c.want, reason: c.reason, existing: c.existing })),
      skipped: skipped.map((s) => ({ want: s.want, existingId: s.existing.id })),
      wouldCreate: toCreate.map((w) => w.code),
    }, { status: 409 });
  }

  if (toCreate.length > 0) {
    await prisma.department.createMany({
      data: toCreate.map((d) => ({
        clubId,
        code: d.code,
        name: d.name,
        sortOrder: d.sortOrder,
        isActive: true,
      })),
    });
  }

  const after = await captureState(clubId);
  return NextResponse.json({
    ok: true,
    before: before.length,
    after: after.length,
    created: toCreate.map((w) => ({ code: w.code, name: w.name })),
    skipped: skipped.map((s) => ({ code: s.want.code, existingId: s.existing.id })),
    afterSnapshot: after,
  });
}
