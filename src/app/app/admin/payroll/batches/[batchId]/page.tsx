// Payroll-3B-5B-3A (2026-09-01) — Payroll Review workspace.
//
// Deep-link target of the Work Intake PAYROLL_FINAL_APPROVAL card.
// The founder / Controller uses this page to visually inspect a
// complete CALCULATED batch BEFORE any approval / posting action
// exists. No calculator runs in the browser — this server component
// reads persisted canonical results through the sanitized
// `getBatchReview` DTO.

import { redirect } from "next/navigation";
import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { hasPermission } from "@/lib/rbac";
import { getActiveClubId } from "@/lib/active-club";
import { getBatchReview } from "@/lib/payroll/review-dto";
import PayrollReviewWorkspace from "./PayrollReviewWorkspace";

export const runtime  = "nodejs";
export const dynamic  = "force-dynamic";

interface Props { params: { batchId: string } }

export default async function PayrollReviewPage({ params }: Props) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const clubId    = await getActiveClubId(user);
  const principal = await getCurrentPrincipal();
  if (!principal || !hasPermission(principal, clubId, "payroll:read")) redirect("/app/admin");

  const review = await getBatchReview(principal, clubId, params.batchId);
  const club   = await prisma.club.findFirst({ where: { id: clubId }, select: { name: true } });

  return (
    <div className="max-w-[1200px]" data-testid="payroll-review-page">
      <header className="mb-spectre-6">
        <div
          className="text-[11px] font-semibold uppercase tracking-[0.06em]"
          style={{ color: "var(--spectre-text-muted)" }}
        >
          Operations · Payroll · Batch review
        </div>
        <h1
          className="mt-1 text-spectre-h1 font-semibold"
          style={{ color: "var(--spectre-text-primary)" }}
          data-testid="payroll-review-title"
        >
          Payroll review · {review.header.payGroupName}
        </h1>
        <p
          className="mt-2 text-spectre-body"
          style={{ color: "var(--spectre-text-secondary)" }}
        >
          {club?.name ?? "Your Club"} — visual inspection of a fully calculated payroll batch.
          The final-approval action lives on the Controller&rsquo;s Work Intake card and is not
          exposed on this page.
        </p>
        <nav className="mt-4 flex gap-3 text-sm">
          <Link
            href="/app/admin/payroll/process"
            className="underline"
            style={{ color: "var(--spectre-text-secondary)" }}
          >
            ← Payroll processing
          </Link>
        </nav>
      </header>

      <PayrollReviewWorkspace clubId={clubId} review={review} />
    </div>
  );
}
