// AP-MOTION-1 (2026-10-13) — isolated motion prototype route.
//
// Dedicated staging-only surface for founder review of the proposed
// AP Invoice Review motion sequence.  Keeps the restored production
// review page untouched; renders a self-contained demonstration
// using DEMO_INVOICE constants.
//
// Isolation invariants:
//   - Server-side the page performs the SAME session + principal
//     + active-club checks the production review route uses so the
//     founder can only land here after authenticating; this is
//     purely a visibility gate, NOT a mutation gate (the prototype
//     has no mutation surface).
//   - Zero DB reads for review content: every rendered field comes
//     from DEMO_INVOICE in `scenes.ts`.
//   - Zero server actions, no vendor-create, no invoice-post, no
//     Work Intake writes.  A persistent ribbon in the client
//     component makes the demonstration nature unambiguous.
//
// Route: /app/admin/work-intake/review-prototype

import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/session";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import ReviewMotionPrototype from "@/components/work-intake/review-prototype/ReviewMotionPrototype";

export const dynamic = "force-dynamic";
export const metadata = {
  title: "AP Review · Motion Prototype",
};

export default async function ReviewMotionPrototypePage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const principal = await getCurrentPrincipal();
  if (!principal) redirect("/login");
  await getActiveClubId(user); // consistency with production review route; result unused

  return <ReviewMotionPrototype />;
}
