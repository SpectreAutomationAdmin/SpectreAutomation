// SIGNUP-1 (2026-10-19) — /signup/t/[token]
//
// Resumes a registration based on the opaque token in the URL.
// Branches to the right step:
//   IDENTITY        → shouldn't happen (that step uses /signup);
//                     fall through to the admin screen anyway.
//   ADMIN_PENDING   → /signup/t/[token]/admin
//   ADMIN_VERIFIED  → /signup/t/[token]/status
//
// Expired or unknown tokens render a dedicated "token invalid" state
// WITHOUT disclosing whether the token ever existed.

import { redirect, notFound } from "next/navigation";
import { resolveRegistrationByToken } from "@/lib/signup/registration";

export const dynamic = "force-dynamic";

export default async function TokenResumePage({
  params,
}: {
  params: { token: string };
}) {
  const reg = await resolveRegistrationByToken(params.token);
  if (!reg) notFound();
  // notFound() renders the generic 404; this is the correct non-disclosure
  // behaviour for an unknown/expired token.
  if (reg.step === "ADMIN_VERIFIED" || reg.status === "VERIFIED") {
    redirect(`/signup/t/${encodeURIComponent(params.token)}/status`);
  }
  redirect(`/signup/t/${encodeURIComponent(params.token)}/admin`);
}
