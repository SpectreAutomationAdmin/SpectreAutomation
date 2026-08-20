// HR-2B.5 §37 (2026-08-19) — Documents area.
//
// Employee-visible documents only. Sensitive documents (SIN scans,
// void cheque, restricted admin-only documents) are explicitly
// filtered out — see the `NEVER_EMPLOYEE_VISIBLE` allowlist below.
// The intent is a positive allowlist per §37: employees see policy
// acknowledgements, employee-visible credentials, and future pay
// documents, and nothing else without an explicit policy decision.

import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getEmployeePortalPrincipal } from "@/lib/employee-portal-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Categories the employee should NEVER see through this surface. If a
// new sensitive category is added elsewhere, add it here too.
const NEVER_EMPLOYEE_VISIBLE = new Set([
  "void_cheque",
  "direct_deposit_form",
  "sin_scan",
  "identity_document",
  "resume",
]);

function formatDate(d: Date | null | undefined): string {
  if (!d) return "—";
  return d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}

export default async function EmployeePortalDocumentsPage() {
  const principal = await getEmployeePortalPrincipal();
  if (!principal) redirect("/employee/login");

  const [docs, credentials] = await Promise.all([
    prisma.employeeDocument.findMany({
      where: { employeeId: principal.employeeId, clubId: principal.clubId },
      orderBy: { uploadedAt: "desc" },
      select: { id: true, category: true, displayName: true, uploadedAt: true },
    }),
    prisma.employeeCredential.findMany({
      where: { employeeId: principal.employeeId, clubId: principal.clubId },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        displayName: true,
        credentialCode: true,
        reference: true,
        issuer: true,
        expiresAt: true,
        issuedAt: true,
      },
    }),
  ]);

  const visibleDocs = docs.filter((d) => !NEVER_EMPLOYEE_VISIBLE.has(d.category));

  return (
    <div data-testid="portal-documents">
      <h1 className="font-serif text-3xl text-club-ink">Documents</h1>
      <p className="mt-2 text-sm text-stone-500">
        Your employee documents and credentials.
      </p>

      <section className="mt-8 rounded-lg border border-stone-200 bg-white px-6 py-6">
        <h2 className="font-serif text-lg text-stone-900">Credentials</h2>
        {credentials.length === 0 ? (
          <p className="mt-3 text-sm text-stone-500" data-testid="portal-credentials-empty">
            No credentials on file yet.
          </p>
        ) : (
          <ul className="mt-3 divide-y divide-stone-100" data-testid="portal-credentials-list">
            {credentials.map((c) => (
              <li key={c.id} className="py-2.5 flex items-center justify-between text-sm">
                <div>
                  <div className="text-club-ink">{c.displayName}</div>
                  <div className="text-xs text-stone-500">
                    {c.reference && `#${c.reference} · `}
                    Issued {formatDate(c.issuedAt)}
                    {c.expiresAt && ` · Expires ${formatDate(c.expiresAt)}`}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mt-6 rounded-lg border border-stone-200 bg-white px-6 py-6">
        <h2 className="font-serif text-lg text-stone-900">Documents</h2>
        {visibleDocs.length === 0 ? (
          <p className="mt-3 text-sm text-stone-500" data-testid="portal-documents-empty">
            No documents shared with you yet.
          </p>
        ) : (
          <ul className="mt-3 divide-y divide-stone-100" data-testid="portal-documents-list">
            {visibleDocs.map((d) => (
              <li key={d.id} className="py-2.5 flex items-center justify-between text-sm">
                <span className="text-club-ink">{d.displayName ?? d.category}</span>
                <span className="text-xs text-stone-500">{formatDate(d.uploadedAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
