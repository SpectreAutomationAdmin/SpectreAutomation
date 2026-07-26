import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission, isSuperAdmin } from "@/lib/rbac";
import { operationalDiagnostics, pauseQueue, resumeQueue, isQueuePaused } from "@/lib/ops/replay";
import { Badge } from "@/components/Badge";

async function pauseAction(queue: string) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  await pauseQueue(p, queue);
  revalidatePath("/app/admin/ops/system");
}

async function resumeAction(queue: string) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  await resumeQueue(p, queue);
  revalidatePath("/app/admin/ops/system");
}

export default async function SystemOpsPage() {
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  const clubId = await getActiveClubId({ clubId: p.activeClubId ?? null, role: "" });
  if (!hasPermission(p, clubId, "settings:read")) redirect("/app/admin");
  const isSuper = isSuperAdmin(p);

  const diagnostics = await operationalDiagnostics();
  const queues = ["default", "exports", "notifications", "webhook-delivery", "pos-webhooks", "llm"];
  const pauseStatus = await Promise.all(queues.map(async (q) => ({ queue: q, paused: await isQueuePaused(q) })));

  return (
    <div>
      <Link href="/app/admin" className="text-sm text-stone-500 hover:text-club-ink">← Admin</Link>
      <h1 className="mt-3 page-title">System Operations</h1>
      <p className="mt-1 text-stone-500">Operational diagnostics, queue control, replay tooling, and disaster-recovery surfaces.</p>

      <div className="mt-6 grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3 text-sm">
        <div className="card card-body"><div className="text-xs uppercase text-stone-400">Queued</div><div className="mt-1 font-serif text-3xl">{diagnostics.queuedJobs}</div></div>
        <div className="card card-body"><div className="text-xs uppercase text-stone-400">Running</div><div className="mt-1 font-serif text-3xl">{diagnostics.runningJobs}</div></div>
        <div className="card card-body"><div className="text-xs uppercase text-stone-400">Dead-letter</div><div className="mt-1 font-serif text-3xl text-red-700">{diagnostics.deadLetter}</div></div>
        <div className="card card-body"><div className="text-xs uppercase text-stone-400">Job fails 1h</div><div className="mt-1 font-serif text-3xl text-amber-700">{diagnostics.recentFailures}</div></div>
        <div className="card card-body"><div className="text-xs uppercase text-stone-400">Webhook fails</div><div className="mt-1 font-serif text-3xl text-amber-700">{diagnostics.recentWebhookFails}</div></div>
        <div className="card card-body"><div className="text-xs uppercase text-stone-400">Push fails 1h</div><div className="mt-1 font-serif text-3xl text-amber-700">{diagnostics.pushFailures}</div></div>
      </div>

      {isSuper && (
        <div className="mt-8 card overflow-hidden">
          <div className="px-6 py-4 border-b border-stone-200 font-medium">Queue control (SUPER_ADMIN)</div>
          <table className="table-base">
            <thead><tr><th>Queue</th><th>State</th><th></th></tr></thead>
            <tbody>
              {pauseStatus.map((q) => (
                <tr key={q.queue}>
                  <td className="font-mono text-xs">{q.queue}</td>
                  <td><Badge status={q.paused ? "PAUSED" : "RUNNING"} /></td>
                  <td className="text-right text-xs">
                    {q.paused ? (
                      <form action={resumeAction.bind(null, q.queue)} className="inline"><button className="text-club-green-700 hover:underline">Resume</button></form>
                    ) : (
                      <form action={pauseAction.bind(null, q.queue)} className="inline"><button className="text-red-600 hover:underline">Pause</button></form>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="mt-8 card card-body">
        <h2 className="section-title text-lg">Disaster recovery quick-reference</h2>
        <ol className="mt-2 text-sm text-stone-700 list-decimal pl-5 space-y-2">
          <li><strong>Worker crash:</strong> the BackgroundJob row stays in RUNNING. Run <span className="font-mono text-xs">SELECT * FROM "BackgroundJob" WHERE status=&apos;RUNNING&apos; AND startedAt &lt; now() - interval &apos;15 minutes&apos;</span> and requeue via this UI.</li>
          <li><strong>Webhook endpoint outage:</strong> failed deliveries retry with exponential backoff. After 5 attempts they move to FAILED. Re-enable + replay via /app/admin/webhooks.</li>
          <li><strong>Database restore:</strong> run <span className="font-mono text-xs">npx prisma migrate deploy</span> then restore from the most recent snapshot. The audit log makes the pre-restore state recoverable for forensics.</li>
          <li><strong>Redis loss:</strong> queue continues via in-memory fallback. Re-enqueue any in-flight jobs by setting their status from RUNNING back to QUEUED.</li>
          <li><strong>Production hot-pause:</strong> Use SUPER_ADMIN queue pause above to halt new work without crashing workers.</li>
        </ol>
      </div>
    </div>
  );
}
