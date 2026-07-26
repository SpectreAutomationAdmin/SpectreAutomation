import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/session";
import { getActiveMember } from "@/lib/active-member";
import { listForMember, widgetsByCategory, type WidgetKey, type WidgetCategory } from "@/lib/member-widgets";
import { addHubWidgetAction, removeHubWidgetAction } from "../_actions";

const CATEGORY_LABELS: Record<WidgetCategory, string> = {
  ACCOUNT: "Your Account",
  GOLF: "Golf",
  DINING: "Dining & Pro Shop",
  EVENTS: "Events",
};

const CATEGORY_ORDER: WidgetCategory[] = ["ACCOUNT", "GOLF", "DINING", "EVENTS"];

export default async function WidgetCatalogPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const member = await getActiveMember(user);
  if (!member) redirect(user.role === "MEMBER" ? "/login" : "/app/admin");

  const currentWidgets = await listForMember(member.id);
  const enabled = new Set<WidgetKey>(currentWidgets.filter((w) => w.enabled).map((w) => w.widgetType));
  const groups = widgetsByCategory();

  async function addAction(widgetType: string) {
    "use server";
    await addHubWidgetAction(widgetType);
  }
  async function removeAction(widgetType: string) {
    "use server";
    await removeHubWidgetAction(widgetType);
  }

  return (
    <div>
      <Link href="/app/member" className="text-sm text-stone-500 hover:text-club-ink">← Back to your hub</Link>
      <h1 className="mt-3 page-title">Widget catalog</h1>
      <p className="mt-2 text-stone-600 max-w-2xl">
        Add the cards that matter to you. They&rsquo;ll appear at the end of your
        hub and can be rearranged at any time by dragging.
      </p>

      <div className="mt-6 text-xs text-stone-500">
        <span className="inline-flex items-center gap-1 mr-4">
          <span className="inline-block h-2 w-2 rounded-full bg-club-green-700" /> On your hub
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="inline-block h-2 w-2 rounded-full bg-stone-300" /> Available
        </span>
      </div>

      {CATEGORY_ORDER.map((cat) => (
        <section key={cat} className="mt-10">
          <h2 className="section-title text-xl">{CATEGORY_LABELS[cat]}</h2>
          <div className="mt-4 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {groups[cat].map((w) => {
              const isOn = enabled.has(w.key);
              return (
                <article
                  key={w.key}
                  className={`card card-body flex flex-col gap-3 ${isOn ? "ring-1 ring-club-green-300" : ""}`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="font-serif text-lg text-club-ink">{w.title}</div>
                      <div className="mt-1 text-xs uppercase tracking-wide text-stone-500">{w.category}</div>
                    </div>
                    {isOn ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-club-green-50 text-club-green-700 px-2.5 py-0.5 text-xs font-medium ring-1 ring-club-green-200">
                        On your hub
                      </span>
                    ) : null}
                  </div>
                  <p className="text-sm text-stone-600 leading-relaxed flex-1">{w.description}</p>
                  <div className="pt-2">
                    {isOn ? (
                      <form action={removeAction.bind(null, w.key)}>
                        <button type="submit" className="btn btn-secondary text-sm">Remove from hub</button>
                      </form>
                    ) : (
                      <form action={addAction.bind(null, w.key)}>
                        <button type="submit" className="btn btn-primary text-sm">+ Add to my hub</button>
                      </form>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        </section>
      ))}

      <div className="mt-12 text-sm text-stone-500">
        Don&rsquo;t see what you&rsquo;re looking for?{" "}
        <Link href="/contact" className="text-club-green-700 hover:underline">Let the club know</Link>.
      </div>
    </div>
  );
}
