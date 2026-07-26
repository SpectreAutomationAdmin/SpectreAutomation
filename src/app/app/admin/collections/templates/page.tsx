import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { updateTemplate } from "@/lib/services/collections";
import { hasPermission } from "@/lib/rbac";
import { isAppError } from "@/lib/errors";

async function saveAction(templateId: string, formData: FormData) {
  "use server";
  const p = await getCurrentPrincipal();
  if (!p) redirect("/login");
  try {
    await updateTemplate(p, templateId, {
      name: String(formData.get("name") ?? ""),
      subject: String(formData.get("subject") ?? ""),
      body: String(formData.get("body") ?? ""),
    });
  } catch (err) {
    if (isAppError(err)) redirect(`/app/admin/collections/templates?error=${encodeURIComponent(err.safeMessage)}`);
    throw err;
  }
  revalidatePath("/app/admin/collections/templates");
}

export default async function CollectionTemplatesPage({ searchParams }: { searchParams: { error?: string } }) {
  const p = await getCurrentPrincipal();
  if (!p) redirect("/login");
  const clubId = await getActiveClubId({ clubId: p.activeClubId ?? null, role: "" });
  const canEdit = hasPermission(p, clubId, "collections:templates:write");

  const templates = await prisma.collectionNoticeTemplate.findMany({
    where: { clubId },
    orderBy: { name: "asc" },
  });

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <Link href="/app/admin/collections" className="text-sm text-stone-500 hover:text-club-ink">← Collections</Link>
          <h1 className="page-title mt-2">Notice templates</h1>
          <p className="mt-1 text-stone-500">
            Render variables: <code className="font-mono">{`{{firstName}}`}</code>, <code className="font-mono">{`{{lastName}}`}</code>, <code className="font-mono">{`{{currentBalance}}`}</code>.
          </p>
        </div>
      </div>

      {searchParams.error && (
        <div className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{searchParams.error}</div>
      )}

      <div className="mt-6 space-y-4">
        {templates.map((t) => (
          <form key={t.id} action={saveAction.bind(null, t.id)} className="card card-body space-y-3">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <div>
                <div className="text-xs uppercase tracking-wide text-stone-500">{t.key}</div>
                <div className="mt-1 font-serif text-lg">
                  <input className="input w-96 max-w-full" name="name" defaultValue={t.name} required disabled={!canEdit} />
                </div>
              </div>
              {t.isSystem && <span className="badge bg-stone-100 text-stone-600 ring-stone-200">System</span>}
            </div>
            <div>
              <label className="label">Subject</label>
              <input className="input" name="subject" defaultValue={t.subject} required disabled={!canEdit} />
            </div>
            <div>
              <label className="label">Body</label>
              <textarea name="body" defaultValue={t.body} rows={8} className="textarea font-serif text-sm" disabled={!canEdit} />
            </div>
            {canEdit && (
              <div className="flex justify-end">
                <button className="btn btn-primary">Save</button>
              </div>
            )}
          </form>
        ))}
        {templates.length === 0 && <div className="text-stone-500">No templates yet. They will be seeded automatically.</div>}
      </div>
    </div>
  );
}
