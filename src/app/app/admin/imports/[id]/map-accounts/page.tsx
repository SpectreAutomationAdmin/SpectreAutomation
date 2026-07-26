// Founder rule 2026-07-01 v14.16/v14.17 — Map / Add unmatched TB accounts.
//
// Route: /app/admin/imports/[id]/map-accounts
//
// This page is a Server Component that loads the batch + suggestions +
// dropdown options, then passes them as serializable props into
// `MapAccountsForm` (a Client Component). The final submit uses the
// `approveTbMappingsAction` Server Action for the create + revalidate
// pipeline. Splitting into server-fetch + client-form is required by
// Next.js because the bulk-approve checkbox carries an onChange
// handler (which cannot exist inside a Server Component).

import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { hasPermission } from "@/lib/rbac";
import { getUnmatchedTbAccountSuggestions } from "@/lib/imports/tb-map-accounts";
import { MapAccountsForm } from "./MapAccountsForm";

export default async function MapAccountsPage({
  params,
}: {
  params: { id: string };
}) {
  const principal = await getCurrentPrincipal();
  if (!principal) redirect("/login");
  const batch = await prisma.importBatch.findUnique({ where: { id: params.id } });
  if (!batch) notFound();
  if (!hasPermission(principal, batch.clubId, "settings:write")) redirect("/app/admin");
  if (batch.domain !== "OPENING_TRIAL_BALANCE") {
    redirect(`/app/admin/imports/${params.id}`);
  }

  const [suggestions, categories, fsGroups, departments] = await Promise.all([
    getUnmatchedTbAccountSuggestions(principal, params.id),
    prisma.accountCategory.findMany({ where: { clubId: batch.clubId }, orderBy: { sortOrder: "asc" } }),
    prisma.financialStatementGroup.findMany({ where: { clubId: batch.clubId }, orderBy: { sortOrder: "asc" } }),
    prisma.department.findMany({ where: { clubId: batch.clubId }, orderBy: { sortOrder: "asc" } }),
  ]);

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <Link href={`/app/admin/imports/${params.id}`} className="text-xs text-stone-500 hover:text-club-ink">
            ← Back to Trial Balance preview
          </Link>
          <h1 className="page-title mt-2">Map / Add accounts</h1>
          <p className="mt-1 text-stone-500 text-sm">
            {suggestions.length} account{suggestions.length === 1 ? "" : "s"} from the imported Trial Balance are not
            yet in the Chart of Accounts. Review each suggestion, edit as needed, tick <strong>Approve</strong>, and
            submit — the accounts will be created in the live COA and the batch re-validated automatically.
          </p>
        </div>
      </div>

      {suggestions.length === 0 ? (
        <div className="mt-6 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          No unmatched accounts to map — the batch is ready to commit.
        </div>
      ) : (
        <MapAccountsForm
          batchId={params.id}
          suggestions={suggestions.map((s) => ({
            rowNumber: s.rowNumber,
            accountNumber: s.accountNumber,
            description: s.description,
            debit: s.debit,
            credit: s.credit,
            prediction: {
              type: s.prediction.type,
              categoryKey: s.prediction.categoryKey,
              fsGroupKey: s.prediction.fsGroupKey,
              defaultDepartmentCode: s.prediction.defaultDepartmentCode,
              // Founder rule 2026-07-02 v15.1 — thread the
              // predictor's Fund Applicability default into the
              // client form so pre-checked boxes reflect the
              // predicted classification.
              fundApplicability: s.prediction.fundApplicability,
              confidence: s.prediction.confidence,
              source: s.prediction.source,
            },
            alreadyExists: s.alreadyExists,
          }))}
          categories={categories.map((c) => ({ key: c.key, name: c.name }))}
          fsGroups={fsGroups.map((g) => ({ key: g.key, name: g.name }))}
          departments={departments.map((d) => ({ code: d.code, name: d.name }))}
        />
      )}
    </div>
  );
}
