// HR-2B.1 (2026-08-18) — Employee-facing onboarding welcome.
// HR-2B.2 (2026-08-18) — Redemption reliability hardening.
//
// Path:      /hr/onboarding/[token]
// Auth:      public (no admin session required)
// Redeem:    resolved via the canonical acquireInvitationContext service,
//            which is idempotent within the invitation TTL. If a prior
//            redemption succeeded but cookie establishment failed, the
//            employee can safely retry the same link — the invitation
//            remains resumable while the session is INVITED or
//            IN_PROGRESS. See src/lib/hr/invitations.ts §
//            acquireInvitationContext for the full contract.
// Branding:  Club-branded per the invitation's own clubId (never
//            caller-supplied). No Spectre wordmark; no admin sidebar.
//
// On "Begin onboarding" the server action:
//   1. Rate-limit check (per-IP hash, per HR-2B §5)
//   2. Canonical acquireInvitationContext(rawToken, {ipHash}) —
//      idempotent redemption + session lookup in one atomic flow.
//      Returns {invitationId, clubId, employeeId, sessionId,
//      wasFirstRedemption}.
//   3. Stamp the employee-onboarding iron-session cookie.
//   4. Redirect to /hr/onboarding/about-you (HR-2B.2 conversational
//      About You).
//
// State transitions (INVITED → IN_PROGRESS) do NOT fire here. They
// fire on the FIRST real employee action inside About You, stamped
// with EmployeeOnboardingActor provenance (actorSource=EMPLOYEE),
// so a passive link-open does not consume state.

import { redirect } from "next/navigation";
import { cookies, headers } from "next/headers";
import { prisma } from "@/lib/prisma";
import {
  acquireInvitationContext,
  hashToken,
} from "@/lib/hr/invitations";
import { establishEmployeeOnboardingSession } from "@/lib/hr/employee-onboarding-session";
import { consumeRate } from "@/lib/security/rate-limit";
import { isAppError } from "@/lib/errors";
import BeginOnboardingButton from "./BeginOnboardingButton";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Single-use, httpOnly, 30-second TTL — inline pattern matches
// /survey/hospitality/[token]. Read-once, delete-once.
const ERROR_COOKIE = "spectre_hr_invitation_error";

// Simple SHA-256 hash of the client IP for the rate-limit identifier.
// We intentionally do NOT store the plaintext IP anywhere.
function hashIp(ip: string): string {
  const { createHash } = require("node:crypto") as typeof import("node:crypto");
  return createHash("sha256").update(ip).digest("hex").slice(0, 32);
}

function clientIp(): string {
  const h = headers();
  return (
    h.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    h.get("x-real-ip") ??
    "unknown"
  );
}

async function beginOnboardingAction(rawToken: string) {
  "use server";

  const ip = clientIp();
  const ipHash = hashIp(ip);

  // Rate-limit BEFORE calling the redemption service. Reuses the
  // canonical `login` profile (5 attempts, refill 1 per 5s) — same
  // shape as password reset: a low-cost per-IP throttle that hurts
  // token guessers without inconveniencing legitimate employees.
  const rateResult = await consumeRate("login", `hr_invitation:${ipHash}`);
  if (!rateResult.allowed) {
    cookies().set(
      ERROR_COOKIE,
      "Too many attempts from this location. Please wait a moment and try again.",
      { httpOnly: true, sameSite: "strict", maxAge: 30, path: "/hr" },
    );
    redirect(`/hr/onboarding/${encodeURIComponent(rawToken)}`);
  }

  try {
    const ctx = await acquireInvitationContext(rawToken, { ipHash });
    // Establish the employee-onboarding cookie. Because
    // acquireInvitationContext is idempotent within the TTL, a
    // failure between redemption and this cookie write is safe to
    // retry — the invitation stays resumable, and the retry lands
    // here again with the same context.
    await establishEmployeeOnboardingSession({
      invitationId: ctx.invitationId,
      sessionId: ctx.sessionId,
      employeeId: ctx.employeeId,
      clubId: ctx.clubId,
    });
  } catch (err) {
    if (isAppError(err)) {
      cookies().set(ERROR_COOKIE, err.safeMessage, {
        httpOnly: true,
        sameSite: "strict",
        maxAge: 30,
        path: "/hr",
      });
      redirect(`/hr/onboarding/${encodeURIComponent(rawToken)}`);
    }
    throw err;
  }

  redirect(`/hr/onboarding/about-you`);
}

export default async function HrOnboardingWelcomePage({
  params,
}: {
  params: { token: string };
}) {
  const cookieStore = cookies();
  const actionError = cookieStore.get(ERROR_COOKIE)?.value ?? null;
  if (actionError) cookieStore.delete(ERROR_COOKIE);

  // Look up the invitation WITHOUT redeeming it. Redemption is
  // deferred until the employee clicks "Begin onboarding" so a
  // preview-link crawler (e.g. an email-client's link scanner)
  // cannot consume the invitation on the employee's behalf.
  let invitation: {
    id: string;
    clubName: string;
    employeeFirstName: string;
    employeePreferredName: string | null;
    departmentName: string | null;
    positionName: string | null;
    expectedStartDate: Date | null;
    expiresAt: Date;
    isExpired: boolean;
    isRevoked: boolean;
    isTerminallySpent: boolean;
  } | null = null;

  try {
    const tokenHash = hashToken(params.token);
    const row = await prisma.employeeOnboardingInvitation.findUnique({
      where: { tokenHash },
      select: {
        id: true,
        expiresAt: true,
        revokedAt: true,
        redeemedAt: true,
        clubId: true,
        employeeId: true,
        club: { select: { name: true } },
        employee: {
          select: {
            firstName: true,
            preferredName: true,
            expectedStartDate: true,
            department: { select: { name: true } },
            position: { select: { name: true } },
          },
        },
      },
    });
    if (row) {
      const isExpired = row.expiresAt < new Date();
      const isRevoked = row.revokedAt !== null;
      // If already-redeemed AND the session is terminal, treat as
      // spent. If already-redeemed AND session is still resumable,
      // the welcome page is safe to render — clicking Begin
      // onboarding will re-acquire the context (idempotent).
      let isTerminallySpent = false;
      if (row.redeemedAt && !isExpired && !isRevoked) {
        const session = await prisma.employeeOnboardingSession.findFirst({
          where: { employeeId: row.employeeId, clubId: row.clubId },
          orderBy: { startedAt: "desc" },
          select: { state: true },
        });
        const resumable = session && ["DRAFT", "INVITED", "IN_PROGRESS"].includes(session.state);
        isTerminallySpent = !resumable;
      }
      invitation = {
        id: row.id,
        clubName: row.club.name,
        employeeFirstName: row.employee.firstName,
        employeePreferredName: row.employee.preferredName,
        departmentName: row.employee.department?.name ?? null,
        positionName: row.employee.position?.name ?? null,
        expectedStartDate: row.employee.expectedStartDate,
        expiresAt: row.expiresAt,
        isExpired,
        isRevoked,
        isTerminallySpent,
      };
    }
  } catch {
    // fall through — invitation stays null, invalid page renders
  }

  if (!invitation || invitation.isExpired || invitation.isRevoked || invitation.isTerminallySpent) {
    return <InvalidInvitationPage />;
  }

  const displayName = invitation.employeePreferredName?.trim().length
    ? invitation.employeePreferredName
    : invitation.employeeFirstName;
  const roleContext =
    invitation.departmentName && invitation.positionName
      ? `our ${invitation.departmentName} team as ${invitation.positionName}`
      : invitation.departmentName
        ? `our ${invitation.departmentName} team`
        : invitation.positionName
          ? `us as ${invitation.positionName}`
          : "our team";
  const startLine = invitation.expectedStartDate
    ? `Before your first day on ${formatFriendlyDate(invitation.expectedStartDate)}, we'll help you`
    : "Before your first day, we'll help you";

  const action = beginOnboardingAction.bind(null, params.token);

  return (
    <main className="flex items-start justify-center px-4 py-12 md:py-20">
      <div className="w-full max-w-xl">
        <header className="text-center">
          <p className="text-[11px] uppercase tracking-[0.25em] text-stone-500">
            {invitation.clubName}
          </p>
          <h1 className="mt-3 font-serif text-3xl md:text-4xl leading-tight text-stone-900">
            Welcome to {invitation.clubName}, {displayName}.
          </h1>
        </header>

        {actionError && (
          <div
            role="alert"
            className="mt-6 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
          >
            {actionError}
          </div>
        )}

        <section className="mt-8 rounded-lg bg-white border border-stone-200 px-6 py-8 md:px-8 md:py-10 space-y-6">
          <p className="text-base leading-relaxed text-stone-700">
            We're looking forward to having you join {roleContext}.
          </p>
          <p className="text-base leading-relaxed text-stone-700">
            {startLine} complete everything we need for payroll and your employee file.
          </p>
          <p className="text-sm text-stone-500">
            You can save and return at any time.
          </p>
          <form action={action} className="pt-2">
            <BeginOnboardingButton />
          </form>
        </section>

        <p className="mt-6 text-center text-[11px] text-stone-400">
          This invitation is valid until {formatFriendlyDate(invitation.expiresAt)}.
        </p>
      </div>
    </main>
  );
}

function InvalidInvitationPage() {
  return (
    <main className="flex items-center justify-center px-4 py-20">
      <div className="w-full max-w-md rounded-lg bg-white border border-stone-200 px-8 py-10 text-center">
        <h1 className="font-serif text-2xl text-stone-900">
          This invitation is no longer available.
        </h1>
        <p className="mt-3 text-sm text-stone-600 leading-relaxed">
          The link may have expired, already been used, or been revoked. If
          you're expecting to complete onboarding, please contact your Club and
          we'll issue a new invitation.
        </p>
      </div>
    </main>
  );
}

function formatFriendlyDate(d: Date): string {
  return d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}
