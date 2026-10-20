// SIGNUP-1 — POST /api/signup/admin-position.
//
// Receives the position dropdown value from Screen 2's second-stage
// form (shown after Microsoft identity is verified).  Persists it,
// then redirects to the status screen.

import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { resolveRegistrationByToken } from "@/lib/signup/registration";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const form = await req.formData();
  const token = String(form.get("token") ?? "").trim();
  const chosen = String(form.get("position") ?? "").trim();
  const other = String(form.get("positionOther") ?? "").trim();
  const position = chosen === "Other" ? other : chosen;

  if (!token) {
    return NextResponse.redirect(new URL("/signup?error=missing_token", env.APP_URL), { status: 303 });
  }
  const reg = await resolveRegistrationByToken(token);
  if (!reg) {
    return NextResponse.redirect(new URL("/signup?error=session_expired", env.APP_URL), { status: 303 });
  }
  if (!position || position.length < 2 || position.length > 120) {
    return NextResponse.redirect(
      new URL(
        `/signup/t/${encodeURIComponent(token)}/admin?error=${encodeURIComponent("Please provide a valid role.")}`,
        env.APP_URL,
      ),
      { status: 303 },
    );
  }
  // Must be post-Microsoft-verification.
  if (!reg.adminVerifiedAt) {
    return NextResponse.redirect(
      new URL(`/signup/t/${encodeURIComponent(token)}/admin`, env.APP_URL),
      { status: 303 },
    );
  }
  await prisma.signupRegistration.update({
    where: { id: reg.id },
    data: { adminPosition: position },
  });
  return NextResponse.redirect(
    new URL(`/signup/t/${encodeURIComponent(token)}/status`, env.APP_URL),
    { status: 303 },
  );
}
