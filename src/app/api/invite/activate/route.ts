// TA-1B closeout — Invitation activation endpoint.
//
// Two paths, chosen server-side based on whether the invitation email
// matches an existing User AND on the authenticated session:
//
//   Path A (new user):
//     No signed-in session, invitation email does not match a User.
//     Body must include `password` + `confirmPassword` (+ optional
//     `fullName`).
//
//   Path B (existing user):
//     Signed-in session whose User.id matches the User row with the
//     invitation email. Body does NOT need password. Never modifies
//     the existing password hash.
//
// Wrong-session refusal: signed in as User X but invitation belongs to
// User Y → ForbiddenError, no mutation.

import { NextRequest, NextResponse } from "next/server";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import {
  acceptAdminInvitationAsExistingUser,
  activateAdminInvitationAsNewUser,
  describeInvitationForLanding,
} from "@/lib/tenant-admin/invitations";

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { token?: string; password?: string; confirmPassword?: string; fullName?: string };
    if (!body.token) {
      return NextResponse.json({ error: "Missing invitation token." }, { status: 400 });
    }

    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? undefined;
    const userAgent = req.headers.get("user-agent") ?? undefined;

    // Dispatch: match against invitation state first so wrong-session
    // errors are precise.
    const summary = await describeInvitationForLanding(body.token);
    const principal = await getCurrentPrincipal();

    if (summary.requiresExistingUserSignIn) {
      // Existing-user path (B).
      if (!principal) {
        return NextResponse.json(
          {
            error: "This invitation is for an existing Spectre account. Sign in as that account, then re-open the invitation link.",
            requiresSignIn: true,
            invitationEmail: summary.email,
          },
          { status: 401 },
        );
      }
      const result = await acceptAdminInvitationAsExistingUser({
        token: body.token, principal, ip, userAgent,
      });
      return NextResponse.json({
        ok: true, path: "existing-user",
        invitationId: result.invitationId,
        userId: result.userId,
        clubId: result.clubId,
        bootstrapPrimaryAssigned: result.bootstrapPrimaryAssigned,
        createdUser: false,
        redirectPath: result.redirectPath,
      });
    }

    // New-user path (A) — never touches an existing password. If a
    // caller is signed in AND the invitation email doesn't match a
    // User, they're inviting a NEW identity — still fine to create.
    // But refuse if a signed-in session's own email already exists
    // (should never happen given the summary check above).
    if (!body.password || !body.confirmPassword) {
      return NextResponse.json(
        { error: "Password and confirmation are required to create a new Spectre account." },
        { status: 400 },
      );
    }
    const result = await activateAdminInvitationAsNewUser(
      { token: body.token, password: body.password, confirmPassword: body.confirmPassword, fullName: body.fullName },
      { ip, userAgent },
    );
    return NextResponse.json({
      ok: true, path: "new-user",
      invitationId: result.invitationId,
      userId: result.userId,
      clubId: result.clubId,
      bootstrapPrimaryAssigned: result.bootstrapPrimaryAssigned,
      createdUser: true,
      redirectPath: result.redirectPath,
    });
  } catch (err) {
    if (err instanceof ValidationError) {
      return NextResponse.json({ error: "Invalid input", details: err.issues }, { status: 400 });
    }
    if (err instanceof NotFoundError) return NextResponse.json({ error: err.message }, { status: 404 });
    if (err instanceof ConflictError) return NextResponse.json({ error: err.message }, { status: 409 });
    if (err instanceof ForbiddenError) return NextResponse.json({ error: err.message }, { status: 403 });
    // eslint-disable-next-line no-console
    console.error("[invite activate]", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
