// PAY-1A/5 (2026-09-26) — PaymentRun detail page.

import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";
import { readSnapshotMasked } from "@/lib/payments";
import { Prisma } from "@prisma/client";
import PaymentRunActions from "./PaymentRunActions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function fmtMoney(v: Prisma.Decimal | string): string {
  const d = v instanceof Prisma.Decimal ? v : new Prisma.Decimal(v);
  return "$" + d.toFixed(2);
}

export default async function PaymentRunPage({
  params,
}: {
  params: { runId: string };
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const clubId = await getActiveClubId(user);
  const principal = await getCurrentPrincipal();
  if (!principal) redirect("/login");
  if (!hasPermission(principal, clubId, "payment:read")) redirect("/app/admin");

  const run = await prisma.paymentRun.findFirst({
    where: { id: params.runId, clubId },
    include: {
      fundingBankAccount: { select: { displayName: true, maskedIdentifier: true, currency: true } },
      instructions: {
        orderBy: [{ recipientType: "asc" }, { recipientId: "asc" }],
        select: {
          id: true, recipientType: true, recipientId: true, amount: true,
          status: true, providerReference: true, destinationSnapshotId: true,
          settledAt: true, returnedAt: true, returnCode: true, returnDescription: true,
        },
      },
      authorization: {
        select: { authorizedAt: true, authorizedByUserId: true, paymentFingerprint: true, status: true },
      },
    },
  });
  if (!run) redirect("/app/admin");

  // Resolve masked destinations + employee names.
  const employeeIds = run.instructions.filter((i) => i.recipientType === "EMPLOYEE").map((i) => i.recipientId);
  const employees = employeeIds.length
    ? await prisma.employee.findMany({
        where: { id: { in: employeeIds }, clubId },
        select: { id: true, firstName: true, lastName: true, preferredName: true },
      })
    : [];
  const empById = new Map(employees.map((e) => [e.id, e]));
  const rows: Array<{
    id: string; label: string; amount: string; status: string;
    masked: string; providerReference: string | null; returnedAt: Date | null; returnDescription: string | null;
  }> = [];
  for (const inst of run.instructions) {
    const emp = empById.get(inst.recipientId);
    const label = emp ? `${emp.preferredName ?? emp.firstName} ${emp.lastName}` : inst.recipientId;
    const snap = await readSnapshotMasked(principal, inst.destinationSnapshotId);
    rows.push({
      id: inst.id, label,
      amount: fmtMoney(inst.amount),
      status: inst.status,
      masked: snap.maskedIdentifier,
      providerReference: inst.providerReference,
      returnedAt: inst.returnedAt,
      returnDescription: inst.returnDescription,
    });
  }

  const canPrepare = hasPermission(principal, clubId, "payment:prepare");
  const canAuthorize = hasPermission(principal, clubId, "payment:authorize");
  const canCancel = hasPermission(principal, clubId, "payment:cancel");

  return (
    <main data-testid="payments-run-page" className="mx-auto max-w-5xl px-6 py-10">
      <div className="mb-1 text-xs uppercase tracking-[0.16em] text-stone-500">Payments</div>
      <h1 className="text-2xl font-semibold text-stone-900">
        Payment run <span className="font-mono">{run.runNumber}</span>
      </h1>
      <p className="mt-1 text-sm text-stone-600">
        Payroll · execute {run.requestedExecutionDate.toISOString().slice(0, 10)}
      </p>

      <section className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2" data-testid="run-summary">
        <div className="rounded-md border border-stone-200 bg-white px-4 py-4">
          <div className="text-xs uppercase tracking-[0.16em] text-stone-500">Status</div>
          <div className="mt-1 text-lg text-stone-900" data-testid="run-status">{run.status}</div>
        </div>
        <div className="rounded-md border border-stone-200 bg-white px-4 py-4">
          <div className="text-xs uppercase tracking-[0.16em] text-stone-500">Total</div>
          <div className="mt-1 text-lg text-stone-900" data-testid="run-total">{fmtMoney(run.totalAmount)} {run.currency}</div>
        </div>
        <div className="rounded-md border border-stone-200 bg-white px-4 py-4">
          <div className="text-xs uppercase tracking-[0.16em] text-stone-500">Recipients</div>
          <div className="mt-1 text-lg text-stone-900">{run.instructionCount}</div>
        </div>
        <div className="rounded-md border border-stone-200 bg-white px-4 py-4">
          <div className="text-xs uppercase tracking-[0.16em] text-stone-500">Funding</div>
          <div className="mt-1 text-lg text-stone-900">{run.fundingBankAccount.displayName} · {run.fundingBankAccount.maskedIdentifier}</div>
        </div>
      </section>

      {run.authorization && (
        <section className="mt-8 rounded-md border border-stone-200 bg-white px-4 py-4" data-testid="run-authorization">
          <h2 className="text-sm font-medium text-stone-900">Authorization</h2>
          <dl className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 text-sm">
            <dt className="text-stone-500">Status</dt><dd className="text-stone-900">{run.authorization.status}</dd>
            <dt className="text-stone-500">Authorized at</dt><dd className="text-stone-900">{run.authorization.authorizedAt?.toISOString().slice(0, 19) ?? "—"}</dd>
            <dt className="text-stone-500">Fingerprint</dt><dd className="font-mono text-xs text-stone-700">{run.authorization.paymentFingerprint.slice(0, 32)}…</dd>
          </dl>
        </section>
      )}

      <section className="mt-8">
        <h2 className="text-sm font-medium text-stone-900">Recipients</h2>
        <div className="mt-2 overflow-hidden rounded-md border border-stone-200 bg-white">
          <table className="min-w-full text-sm">
            <thead className="bg-stone-50 text-left text-xs uppercase tracking-[0.14em] text-stone-500">
              <tr>
                <th className="px-4 py-2">Recipient</th>
                <th className="px-4 py-2 text-right">Amount</th>
                <th className="px-4 py-2">Destination</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2">Provider ref</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-200" data-testid="run-recipients">
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="px-4 py-2 text-stone-900">{r.label}</td>
                  <td className="px-4 py-2 text-right font-mono text-stone-900">{r.amount}</td>
                  <td className="px-4 py-2 text-stone-600">{r.masked}</td>
                  <td className="px-4 py-2 text-stone-600">
                    {r.status}
                    {r.returnedAt && (
                      <span className="ml-2 text-red-700">
                        · {r.returnDescription ?? "returned"}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2 font-mono text-xs text-stone-500">{r.providerReference ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <PaymentRunActions
        runId={run.id}
        status={run.status}
        canPrepare={canPrepare}
        canAuthorize={canAuthorize}
        canCancel={canCancel}
      />
    </main>
  );
}
