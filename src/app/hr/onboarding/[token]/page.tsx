// HR-2B.1 (2026-08-18) — Employee-facing onboarding welcome.
//
// Path:      /hr/onboarding/[token]
// Auth:      public (no admin session required)
// Redeem:    validated on page load (lookup only — invitation is NOT
//            marked REDEEMED until the employee clicks "Begin
//            onboarding" so re-visits from the email link don't
//            consume the invitation)
// Branding:  Club-branded per the invitation's own clubId (never
//            caller-supplied). No Spectre wordmark; no admin sidebar.
//
// On "Begin onboarding" the server action:
//   1. Rate-limit check (per-IP hash, per HR-2B §5)
//   2. Canonical redeemInvitation() marks REDEEMED, returns
//      { invitationId, clubId, employeeId }
//   3. Look up the employee's active onboarding session
//   4. Stamp the employee-onboarding iron-session cookie
//   5. Redirect to /hr/onboarding/session (HR-2B.2+ continuation)

import { redirect } from "next/navigation";
import { cookies, headers } from "next/headers";
import { prisma } from "@/lib/prisma";
import { hashToken, redeemInvitation } from "@/lib/hr/invitations";
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

  // Rate-limit BEFORE calling the redemption service. Per HR-2B §5,
  // this is the HTTP-route obligation deferred from HR-1. Reuses the
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
    const { invitationId, clubId, employeeId } = await redeemInvitation(rawToken, { ipHash });

    // Look up the active DRAFT/INVITED onboarding session for this
    // employee. Transition it to IN_PROGRESS if it's currently
    // INVITED (invitation-issued session).
    const activeSession = await prisma.employeeOnboardingSession.findFirst({
      where: {
        employeeId,
        state: { notIn: ["REVOKED", "APPROVED", "REJECTED"] },
      },
      orderBy: { startedAt: "desc" },
      select: { id: true, state: true },
    });
    if (!activeSession) {
      cookies().set(
        ERROR_COOKIE,
        "No active onboarding session for this invitation. Please contact your Club.",
        { httpOnly: true, sameSite: "strict", maxAge: 30, path: "/hr" },
      );
      redirect(`/hr/onboarding/${encodeURIComponent(rawToken)}`);
    }

    // Establish the employee-onboarding session cookie. Session state
    // transitions (INVITED → IN_PROGRESS → SUBMITTED) are driven by
    // the About-You / submit paths in HR-2B.2+, where they naturally
    // align with the employee's actions rather than firing on link
    // open. HR-2B.1 stops at "cookie established, employee landed".
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

  // Re-fetch the session + establish the cookie AFTER the try/catch
  // completes. Both service calls succeeded; safe to stamp identity.
  const activeSession = await prisma.employeeOnboardingSession.findFirst({
    where: {
      employeeId: (await prisma.employeeOnboardingInvitation.findUnique({
        where: { tokenHash: hashToken(rawToken) },
        select: { employeeId: true },
      }))?.employeeId ?? "__none__",
      state: { notIn: ["REVOKED", "APPROVED", "REJECTED"] },
    },
    orderBy: { startedAt: "desc" },
    select: { id: true, state: true, employeeId: true, clubId: true },
  });
  if (!activeSession) {
    cookies().set(ERROR_COOKIE, "No active onboarding session for this invitation.", {
      httpOnly: true,
      sameSite: "strict",
      maxAge: 30,
      path: "/hr",
    });
    redirect(`/hr/onboarding/${encodeURIComponent(rawToken)}`);
  }
  const invitationRow = await prisma.employeeOnboardingInvitation.findUnique({
    where: { tokenHash: hashToken(rawToken) },
    select: { id: true },
  });
  if (!invitationRow) redirect(`/hr/onboarding/expired`);
  await establishEmployeeOnboardingSession({
    invitationId: invitationRow.id,
    sessionId: activeSession.id,
    employeeId: activeSession.employeeId,
    clubId: activeSession.clubId,
  });

  redirect(`/hr/onboarding/session`);
}

export default async function HrOnboardingWelcomePage({
  params,
}: {
  params: { token: string };
}) {
  const cookieStore = cookies();
  const actionError = cookieStore.get(ERROR_COOKIE)?.value ?? null;
  if (actionError) cookieStore.delete(ERROR_COOKIE);

  // Look up the invitation WITHOUT redeeming it. Redemption only
  // happens when the employee clicks "Begin onboarding".
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
    isRedeemed: boolean;
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
      invitation = {
        id: row.id,
        clubName: row.club.name,
        employeeFirstName: row.employee.firstName,
        employeePreferredName: row.employee.preferredName,
        departmentName: row.employee.department?.name ?? null,
        positionName: row.employee.position?.name ?? null,
        expectedStartDate: row.employee.expectedStartDate,
        expiresAt: row.expiresAt,
        isExpired: row.expiresAt < new Date(),
        isRevoked: row.revokedAt !== null,
        isRedeemed: row.redeemedAt !== null,
      };
    }
  } catch {
    // fall through — invitation stays null, invalid page renders
  }

  if (!invitation || invitation.isExpired || invitation.isRevoked || invitation.isRedeemed) {
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
