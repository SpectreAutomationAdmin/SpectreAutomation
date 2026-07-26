import { redirect } from "next/navigation";
import { getActiveBranding } from "@/lib/branding";
import { getSession, getCurrentUser } from "@/lib/session";

// Member Area = the public site's entry point into the member portal. We
// don't render a separate page — we route the visitor:
//   - signed in already? straight to their portal.
//   - otherwise to /login, which is already club-branded on this host.
//
// Reachable from the nav and the footer on every public page.
export default async function MemberArea() {
  const branding = await getActiveBranding();
  if (branding.mode === "unknown") redirect("/unknown-domain");

  const session = await getSession();
  if (session.userId) {
    const user = await getCurrentUser();
    if (user?.role === "MEMBER") redirect("/app/member");
    if (user) redirect("/app/admin");
  }
  redirect("/login");
}
