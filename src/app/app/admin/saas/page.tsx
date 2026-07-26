import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { isSuperAdmin } from "@/lib/rbac";
import { listPlans, assignPlan, suspendClub, reactivateClub, summarizeUsage } from "@/lib/entitlements";
import { prisma } from "@/lib/prisma";
import { Badge } from "@/components/Badge";
import { fmtMoney } from "@/lib/accounting/format";

async function assignPlanAction(formData: FormData) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  await assignPlan(p, String(formData.get("clubId") ?? ""), {
    planKey: String(formData.get("planKey") ?? ""),
    status: formData.get("status") as "PILOT" | "ACTIVE" | "TRIAL" | "PAUSED" | "CANCELLED" | undefined,
    seatCount: Number(formData.get("seatCount") ?? 0),
  });
  revalidatePath("/app/admin/saas");
}

async function suspendAction(clubId: string) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  await suspendClub(p, clubId, "Manual suspension via admin UI");
  revalidatePath("/app/admin/saas");
}

async function reactivateAction(clubId: string) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  await reactivateClub(p, clubId);
  revalidatePath("/app/admin/saas");
}

export default async function SaaSPage() {
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  if (!isSuperAdmin(p)) redirect("/app/admin");

  const [clubs, plans] = await Promise.all([
    prisma.club.findMany({
      orderBy: { name: "asc" },
      include: { clubSubscription: { include: { plan: true } } },
    }),
    listPlans(),
  ]);
  const usage = await Promise.all(clubs.map(async (c) => ({ clubId: c.id, rows: await summarizeUsage(c.id) })));

  return (
    <div>
      <h1 className="page-title">SaaS Management</h1>
      <p className="mt-1 text-stone-500">SUPER_ADMIN view — subscription plans, club tiering, usage metering. Pilot clubs without a subscription default to unlimited access.</p>

      <div className="mt-6 grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 card overflow-hidden">
          <div className="px-6 py-4 border-b border-stone-200 font-medium">Clubs ({clubs.length})</div>
          <table className="table-base">
            <thead><tr><th>Club</th><th>Plan</th><th>Status</th><th>Seats</th><th>Usage (this month)</th><th></th></tr></thead>
            <tbody>
              {clubs.map((c) => {
                const u = usage.find((x) => x.clubId === c.id)?.rows ?? [];
                const apiCalls = u.find((r) => r.kind === "API_CALLS")?.value ?? 0;
                const webhookDeliveries = u.find((r) => r.kind === "WEBHOOK_DELIVERIES")?.value ?? 0;
                return (
                  <tr key={c.id}>
                    <td>{c.name}</td>
                    <td className="text-xs">{c.clubSubscription?.plan?.name ?? "—"}</td>
                    <td><Badge status={c.clubSubscription?.status ?? "PILOT"} /></td>
                    <td className="text-xs">{c.clubSubscription?.seatCount ?? 0}</td>
                    <td className="text-xs">api {apiCalls.toString()} · webhooks {webhookDeliveries.toString()}</td>
                    <td className="text-right text-xs space-x-2">
                      {c.clubSubscription?.status === "ACTIVE" && (
                        <form action={suspendAction.bind(null, c.id)} className="inline"><button className="text-red-600 hover:underline">Suspend</button></form>
                      )}
                      {c.clubSubscription?.status === "PAUSED" && (
                        <form action={reactivateAction.bind(null, c.id)} className="inline"><button className="text-club-green-700 hover:underline">Reactivate</button></form>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <form action={assignPlanAction} className="card card-body h-fit space-y-3">
          <h2 className="section-title text-lg">Assign plan</h2>
          <div>
            <label className="label">Club</label>
            <select className="select" name="clubId" required>
              {clubs.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div>
            <label className="label">Plan</label>
            <select className="select" name="planKey" required>
              {plans.map((p) => <option key={p.id} value={p.key}>{p.name} — {fmtMoney(p.monthlyPrice as unknown as number, { showZero: true })}/mo</option>)}
            </select>
          </div>
          <div>
            <label className="label">Status</label>
            <select className="select" name="status">
              <option value="ACTIVE">Active</option>
              <option value="PILOT">Pilot</option>
              <option value="TRIAL">Trial</option>
              <option value="PAUSED">Paused</option>
            </select>
          </div>
          <div><label className="label">Seat count</label><input className="input" type="number" name="seatCount" defaultValue={0} /></div>
          <button className="btn btn-primary">Save</button>
        </form>
      </div>
    </div>
  );
}

void Link;
