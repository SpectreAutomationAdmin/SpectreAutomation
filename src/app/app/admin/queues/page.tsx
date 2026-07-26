import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { captureQueueHealth, requeueJob, cancelJob, processPending } from "@/lib/queue";
import { Badge } from "@/components/Badge";
import { formatDate } from "@/lib/finance";

async function snapshotAction() {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  await captureQueueHealth();
  revalidatePath("/app/admin/queues");
}

async function processNowAction() {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  await processPending({ limit: 20, workerId: `manual-${p.id}` });
  revalidatePath("/app/admin/queues");
}

async function requeueAction(jobId: string) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  await requeueJob(jobId, p);
  revalidatePath("/app/admin/queues");
}

async function cancelAction(jobId: string) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  await cancelJob(jobId, p);
  revalidatePath("/app/admin/queues");
}

export default async function QueuesPage() {
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  const clubId = await getActiveClubId({ clubId: p.activeClubId ?? null, role: "" });
  if (!hasPermission(p, clubId, "settings:read")) redirect("/app/admin");
  const canWrite = hasPermission(p, clubId, "settings:write");

  const [jobs, recentRuns, latestHealth] = await Promise.all([
    prisma.backgroundJob.findMany({
      where: { OR: [{ clubId }, { clubId: null }] },
      orderBy: { createdAt: "desc" }, take: 50,
    }),
    prisma.jobRun.findMany({
      where: { OR: [{ clubId }, { clubId: null }] },
      orderBy: { startedAt: "desc" }, take: 25,
      include: { job: true },
    }),
    prisma.queueHealth.findMany({
      orderBy: { observedAt: "desc" }, take: 12,
    }),
  ]);

  const byQueue = new Map<string, { depth: number; inFlight: number; failed: number; dead: number; observedAt: Date }>();
  for (const h of latestHealth) {
    if (!byQueue.has(h.queue)) byQueue.set(h.queue, { depth: h.queueDepth, inFlight: h.inFlight, failed: h.failedLastHour, dead: h.deadLetterCount, observedAt: h.observedAt });
  }

  return (
    <div>
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="page-title">Queues</h1>
          <p className="mt-1 text-stone-500">Background jobs, retries, dead letters, and queue depth. Workers run separately via <span className="font-mono text-xs">tsx bin/worker.ts</span>.</p>
        </div>
        {canWrite && (
          <div className="space-x-2">
            <form action={snapshotAction} className="inline"><button className="btn btn-secondary">Snapshot health</button></form>
            <form action={processNowAction} className="inline"><button className="btn btn-secondary">Run pending now</button></form>
          </div>
        )}
      </div>

      <div className="mt-6 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
        {Array.from(byQueue.entries()).map(([queue, h]) => (
          <div key={queue} className="card card-body">
            <div className="text-xs uppercase tracking-widest text-stone-400">{queue}</div>
            <div className="mt-2 grid grid-cols-2 gap-2 text-sm">
              <div><span className="text-stone-500">Depth: </span><span className="font-mono">{h.depth}</span></div>
              <div><span className="text-stone-500">In flight: </span><span className="font-mono">{h.inFlight}</span></div>
              <div><span className="text-stone-500">Failed (1h): </span><span className="font-mono">{h.failed}</span></div>
              <div><span className="text-stone-500">Dead letter: </span><span className="font-mono">{h.dead}</span></div>
            </div>
            <div className="mt-2 text-xs text-stone-500">As of {formatDate(h.observedAt)}</div>
          </div>
        ))}
        {byQueue.size === 0 && (
          <div className="card card-body text-stone-500 text-sm">No health snapshots yet. Click <em>Snapshot health</em> to capture the first.</div>
        )}
      </div>

      <div className="mt-8 card overflow-hidden">
        <div className="px-6 py-4 border-b border-stone-200 font-medium">Recent jobs</div>
        <table className="table-base">
          <thead><tr><th>Created</th><th>Queue</th><th>Kind</th><th>Status</th><th>Attempts</th><th>Last error</th><th></th></tr></thead>
          <tbody>
            {jobs.length === 0 && <tr><td colSpan={7} className="px-4 py-6 text-center text-stone-500">No jobs.</td></tr>}
            {jobs.map((j) => (
              <tr key={j.id}>
                <td className="text-xs">{formatDate(j.createdAt)}</td>
                <td className="text-xs font-mono">{j.queue}</td>
                <td className="text-xs">{j.kind}</td>
                <td><Badge status={j.status} /></td>
                <td className="text-xs">{j.attempts} / {j.maxAttempts}</td>
                <td className="text-xs text-red-700 max-w-xs truncate">{j.lastError ?? ""}</td>
                <td className="text-right text-xs space-x-2">
                  {canWrite && (j.status === "FAILED" || j.status === "DEAD_LETTER") && (
                    <form action={requeueAction.bind(null, j.id)} className="inline"><button className="text-club-green-700 hover:underline">Requeue</button></form>
                  )}
                  {canWrite && j.status === "QUEUED" && (
                    <form action={cancelAction.bind(null, j.id)} className="inline"><button className="text-red-600 hover:underline">Cancel</button></form>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-8 card overflow-hidden">
        <div className="px-6 py-4 border-b border-stone-200 font-medium">Recent runs</div>
        <table className="table-base">
          <thead><tr><th>When</th><th>Kind</th><th>Attempt</th><th>Status</th><th>Duration</th><th>Error</th></tr></thead>
          <tbody>
            {recentRuns.length === 0 && <tr><td colSpan={6} className="px-4 py-6 text-center text-stone-500">No runs yet.</td></tr>}
            {recentRuns.map((r) => (
              <tr key={r.id}>
                <td className="text-xs">{formatDate(r.startedAt)}</td>
                <td className="text-xs">{r.job.kind}</td>
                <td className="text-xs">{r.attemptNumber}</td>
                <td><Badge status={r.status} /></td>
                <td className="text-xs font-mono">{r.durationMs}ms</td>
                <td className="text-xs text-red-700 max-w-md truncate">{r.errorMessage ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

void Link;
