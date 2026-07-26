import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { getActiveClubId } from "@/lib/active-club";

async function createMilestoneAction(clubId: string, formData: FormData) {
  "use server";
  await prisma.clubMilestone.create({
    data: {
      clubId,
      year: parseInt(String(formData.get("year") ?? "2000"), 10) || 2000,
      title: String(formData.get("title") ?? "").trim(),
      description: String(formData.get("description") ?? "").trim(),
      mediaUrl: String(formData.get("mediaUrl") ?? "").trim() || null,
      sortOrder: parseInt(String(formData.get("sortOrder") ?? "0"), 10) || 0,
    },
  });
  revalidatePath("/app/admin/milestones");
}

async function updateMilestoneAction(id: string, formData: FormData) {
  "use server";
  await prisma.clubMilestone.update({
    where: { id },
    data: {
      year: parseInt(String(formData.get("year") ?? "2000"), 10) || 2000,
      title: String(formData.get("title") ?? "").trim(),
      description: String(formData.get("description") ?? "").trim(),
      mediaUrl: String(formData.get("mediaUrl") ?? "").trim() || null,
      sortOrder: parseInt(String(formData.get("sortOrder") ?? "0"), 10) || 0,
    },
  });
  revalidatePath("/app/admin/milestones");
}

async function deleteMilestoneAction(id: string) {
  "use server";
  await prisma.clubMilestone.delete({ where: { id } });
  revalidatePath("/app/admin/milestones");
}

export default async function MilestonesAdminPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const clubId = await getActiveClubId(user);

  const milestones = await prisma.clubMilestone.findMany({ where: { clubId }, orderBy: { sortOrder: "asc" } });

  return (
    <div>
      <h1 className="page-title">Club Milestones</h1>
      <p className="mt-1 text-stone-500">These milestones appear on the magical welcome timeline shown to new members.</p>

      <div className="mt-6 grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-4">
          {milestones.map((m) => (
            <form key={m.id} action={updateMilestoneAction.bind(null, m.id)} className="card card-body">
              <div className="grid grid-cols-1 md:grid-cols-12 gap-3">
                <div className="md:col-span-2">
                  <label className="label">Year</label>
                  <input className="input" name="year" type="number" defaultValue={m.year} />
                </div>
                <div className="md:col-span-2">
                  <label className="label">Order</label>
                  <input className="input" name="sortOrder" type="number" defaultValue={m.sortOrder} />
                </div>
                <div className="md:col-span-8">
                  <label className="label">Title</label>
                  <input className="input" name="title" defaultValue={m.title} />
                </div>
                <div className="md:col-span-12">
                  <label className="label">Description</label>
                  <textarea className="textarea" name="description" rows={3} defaultValue={m.description} />
                </div>
                <div className="md:col-span-12">
                  <label className="label">Media URL (optional)</label>
                  <input className="input" name="mediaUrl" defaultValue={m.mediaUrl ?? ""} placeholder="https://..." />
                </div>
              </div>
              <div className="mt-3 flex justify-end gap-2">
                <button formAction={deleteMilestoneAction.bind(null, m.id)} className="btn btn-secondary text-red-600 border-red-200">Delete</button>
                <button className="btn btn-primary">Save</button>
              </div>
            </form>
          ))}
        </div>

        <form action={createMilestoneAction.bind(null, clubId)} className="card card-body h-fit">
          <h2 className="section-title text-lg">Add a milestone</h2>
          <div className="mt-4 space-y-3">
            <div>
              <label className="label">Year</label>
              <input className="input" name="year" type="number" defaultValue={new Date().getFullYear()} />
            </div>
            <div>
              <label className="label">Title</label>
              <input className="input" name="title" required />
            </div>
            <div>
              <label className="label">Description</label>
              <textarea className="textarea" name="description" rows={3} required />
            </div>
            <div>
              <label className="label">Sort order</label>
              <input className="input" name="sortOrder" type="number" defaultValue={milestones.length + 1} />
            </div>
            <div>
              <label className="label">Media URL (optional)</label>
              <input className="input" name="mediaUrl" placeholder="https://..." />
            </div>
          </div>
          <button className="btn btn-primary mt-4">Add milestone</button>
        </form>
      </div>
    </div>
  );
}
