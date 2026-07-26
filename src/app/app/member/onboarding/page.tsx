import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getCurrentUser } from "@/lib/session";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveMember } from "@/lib/active-member";
import {
  ensureChecklistForMember,
  getChecklist,
  completeItem,
} from "@/lib/services/onboarding";
import { isAppError } from "@/lib/errors";

async function completeAction(memberId: string, itemKey: string) {
  "use server";
  const p = await getCurrentPrincipal();
  if (!p) redirect("/login");
  try {
    await completeItem(p, memberId, itemKey);
  } catch (err) {
    if (isAppError(err)) redirect(`/app/member/onboarding?error=${encodeURIComponent(err.safeMessage)}`);
    throw err;
  }
  revalidatePath("/app/member/onboarding");
  revalidatePath("/app/member");
}

export default async function MemberOnboardingPage({ searchParams }: { searchParams: { welcomeMember?: string; error?: string } }) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const member = await getActiveMember(user, searchParams.welcomeMember);
  if (!member) redirect(user.role === "MEMBER" ? "/login" : "/app/admin");

  // Idempotent — ensures pre-Phase-2 members also get a checklist.
  await ensureChecklistForMember(member.id);
  const items = await getChecklist(member.id);
  const required = items.filter((i) => i.required);
  const requiredDone = required.filter((i) => i.completedAt).length;
  const progress = required.length ? Math.round((requiredDone / required.length) * 100) : 100;

  return (
    <div className="max-w-3xl">
      <h1 className="page-title">Onboarding</h1>
      <p className="mt-1 text-stone-500">Your welcome checklist. Each step takes only a moment.</p>

      {searchParams.error && (
        <div className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{searchParams.error}</div>
      )}

      <div className="mt-6 card card-body">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-xs uppercase tracking-wide text-stone-500">Required steps</div>
            <div className="mt-1 font-serif text-2xl">{requiredDone} of {required.length} complete</div>
          </div>
          <div className="text-right text-3xl font-serif text-club-green-700">{progress}%</div>
        </div>
        <div className="mt-3 h-2 rounded-full bg-stone-100 overflow-hidden">
          <div className="h-full bg-club-green-700 transition-all" style={{ width: `${progress}%` }} />
        </div>
      </div>

      <ul className="mt-8 space-y-3">
        {items.map((it) => {
          const action = completeAction.bind(null, member.id, it.itemKey);
          const link = mapItemLink(it.itemKey, member.id);
          return (
            <li key={it.id} className="card card-body flex flex-col md:flex-row md:items-center gap-3">
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <span className={
                    "h-5 w-5 rounded-full flex items-center justify-center text-[10px] " +
                    (it.completedAt ? "bg-club-green-700 text-white" : "bg-stone-200 text-stone-500")
                  }>
                    {it.completedAt ? "✓" : ""}
                  </span>
                  <span className="font-medium">{it.title}</span>
                  {it.required && <span className="badge bg-stone-100 text-stone-600 ring-stone-200">Required</span>}
                </div>
                {it.description && <p className="mt-1 text-sm text-stone-600">{it.description}</p>}
              </div>
              <div className="flex items-center gap-2">
                {link && (
                  <Link href={link} className="btn btn-secondary text-sm">Open</Link>
                )}
                {!it.completedAt && (
                  <form action={action}><button className="btn btn-primary text-sm">Mark complete</button></form>
                )}
                {it.completedAt && <span className="text-xs text-stone-500">{new Date(it.completedAt).toLocaleDateString()}</span>}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function mapItemLink(itemKey: string, memberId: string): string | null {
  switch (itemKey) {
    case "TIMELINE":       return `/app/welcome/timeline?welcomeMember=${memberId}`;
    case "PREFERENCES":    return `/app/welcome/preferences?welcomeMember=${memberId}`;
    case "PAYMENT_METHOD": return `/app/member/payment-methods?welcomeMember=${memberId}`;
    default: return null;
  }
}
