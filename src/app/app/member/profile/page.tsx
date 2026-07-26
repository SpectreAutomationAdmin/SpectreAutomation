import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveMember } from "@/lib/active-member";
import {
  updateProfile,
  addHouseholdMember,
  removeHouseholdMember,
  updatePreferences,
} from "@/lib/services/member-profile";
import { isAppError } from "@/lib/errors";

function bounce(err: unknown): never {
  if (isAppError(err)) redirect(`/app/member/profile?error=${encodeURIComponent(err.safeMessage)}`);
  throw err;
}

async function profileAction(memberId: string, formData: FormData) {
  "use server";
  const p = await getCurrentPrincipal();
  if (!p) redirect("/login");
  try {
    await updateProfile(p, memberId, {
      phone: String(formData.get("phone") ?? ""),
      email: String(formData.get("email") ?? ""),
    });
  } catch (err) { bounce(err); }
  revalidatePath("/app/member/profile");
}

async function addHouseholdAction(memberId: string, formData: FormData) {
  "use server";
  const p = await getCurrentPrincipal();
  if (!p) redirect("/login");
  try {
    await addHouseholdMember(p, memberId, {
      firstName: String(formData.get("firstName") ?? ""),
      lastName: String(formData.get("lastName") ?? ""),
      relationship: String(formData.get("relationship") ?? "SPOUSE"),
      email: String(formData.get("email") ?? ""),
      phone: String(formData.get("phone") ?? ""),
      dateOfBirth: String(formData.get("dateOfBirth") ?? ""),
    });
  } catch (err) { bounce(err); }
  revalidatePath("/app/member/profile");
}

async function removeHouseholdAction(memberId: string, householdId: string) {
  "use server";
  const p = await getCurrentPrincipal();
  if (!p) redirect("/login");
  try { await removeHouseholdMember(p, memberId, householdId); } catch (err) { bounce(err); }
  revalidatePath("/app/member/profile");
}

async function preferencesAction(memberId: string, formData: FormData) {
  "use server";
  const p = await getCurrentPrincipal();
  if (!p) redirect("/login");
  const flags: Record<string, boolean> = {};
  for (const k of [
    "interestedGolf", "interestedDining", "interestedEvents", "interestedLeagues",
    "interestedPracticeFacilities", "wantsProShopOffers", "wantsTeeTimeAlerts",
    "emailStatements", "emailAccountAlerts", "emailEventAnnouncements", "emailGeneralAnnouncements",
    "smsPaymentAlerts", "smsTeeTimeAlerts",
  ]) {
    flags[k] = formData.get(k) === "on";
  }
  try { await updatePreferences(p, memberId, flags); } catch (err) { bounce(err); }
  revalidatePath("/app/member/profile");
}

export default async function MemberProfilePage({ searchParams }: { searchParams: { welcomeMember?: string; error?: string } }) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const member = await getActiveMember(user, searchParams.welcomeMember);
  if (!member) redirect(user.role === "MEMBER" ? "/login" : "/app/admin");

  const [household, prefs] = await Promise.all([
    prisma.memberHouseholdMember.findMany({ where: { memberId: member.id }, orderBy: { createdAt: "asc" } }),
    prisma.memberPreference.findUnique({ where: { memberId: member.id } }),
  ]);
  const p = prefs ?? { interestedGolf: false, interestedDining: false, interestedEvents: false, interestedLeagues: false, interestedPracticeFacilities: false, wantsProShopOffers: false, wantsTeeTimeAlerts: false, emailStatements: true, emailAccountAlerts: true, emailEventAnnouncements: true, emailGeneralAnnouncements: true, smsPaymentAlerts: false, smsTeeTimeAlerts: false };

  const profile = profileAction.bind(null, member.id);
  const addH = addHouseholdAction.bind(null, member.id);
  const updPrefs = preferencesAction.bind(null, member.id);

  return (
    <div className="max-w-3xl">
      <h1 className="page-title">Profile &amp; Household</h1>
      <p className="mt-1 text-stone-500">Manage your contact information, household, and how you&rsquo;d like to hear from the club.</p>

      {searchParams.error && (
        <div className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{searchParams.error}</div>
      )}

      <form action={profile} className="mt-6 card card-body space-y-4">
        <h2 className="section-title text-lg">Contact</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div><label className="label">Email</label><input className="input" type="email" name="email" defaultValue={member.email} maxLength={254} /></div>
          <div><label className="label">Phone</label><input className="input" name="phone" defaultValue={member.phone ?? ""} maxLength={40} /></div>
        </div>
        <div className="flex justify-end"><button className="btn btn-primary">Save contact</button></div>
      </form>

      <div className="mt-6 card overflow-hidden">
        <div className="px-6 py-4 border-b border-stone-200 font-medium">Household</div>
        <table className="table-base">
          <thead><tr><th>Name</th><th>Relationship</th><th>Contact</th><th></th></tr></thead>
          <tbody>
            {household.length === 0 && <tr><td colSpan={4} className="px-4 py-6 text-center text-stone-500">No household members.</td></tr>}
            {household.map((h) => (
              <tr key={h.id}>
                <td>{h.firstName} {h.lastName}</td>
                <td className="capitalize">{h.relationship.toLowerCase()}</td>
                <td className="text-stone-600 text-xs">{[h.email, h.phone].filter(Boolean).join(" · ") || "—"}</td>
                <td className="text-right">
                  <form action={removeHouseholdAction.bind(null, member.id, h.id)} className="inline">
                    <button className="text-xs text-red-600 hover:underline">Remove</button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <form action={addH} className="px-6 py-4 border-t border-stone-200 grid grid-cols-1 md:grid-cols-12 gap-3 items-end">
          <div className="md:col-span-3"><label className="label">First name</label><input className="input" name="firstName" required maxLength={100} /></div>
          <div className="md:col-span-3"><label className="label">Last name</label><input className="input" name="lastName" required maxLength={100} /></div>
          <div className="md:col-span-2">
            <label className="label">Relationship</label>
            <select className="select" name="relationship" defaultValue="SPOUSE">
              <option value="SPOUSE">Spouse</option>
              <option value="PARTNER">Partner</option>
              <option value="CHILD">Child</option>
              <option value="OTHER">Other</option>
            </select>
          </div>
          <div className="md:col-span-2"><label className="label">Email</label><input className="input" type="email" name="email" maxLength={254} /></div>
          <div className="md:col-span-2"><label className="label">Phone</label><input className="input" name="phone" maxLength={40} /></div>
          <div className="md:col-span-12 flex justify-end"><button className="btn btn-secondary">Add household member</button></div>
        </form>
      </div>

      <form action={updPrefs} className="mt-6 card card-body space-y-4">
        <h2 className="section-title text-lg">Interests</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-sm">
          <Check name="interestedGolf"               label="Golf"                   checked={p.interestedGolf} />
          <Check name="interestedDining"             label="Dining"                 checked={p.interestedDining} />
          <Check name="interestedEvents"             label="Club Events"            checked={p.interestedEvents} />
          <Check name="interestedLeagues"            label="Leagues"                checked={p.interestedLeagues} />
          <Check name="interestedPracticeFacilities" label="Practice Facilities"    checked={p.interestedPracticeFacilities} />
          <Check name="wantsProShopOffers"           label="Pro Shop Offers"        checked={p.wantsProShopOffers} />
          <Check name="wantsTeeTimeAlerts"           label="Tee-time Alerts"        checked={p.wantsTeeTimeAlerts} />
        </div>

        <h2 className="section-title text-lg pt-4 border-t border-stone-100">Notifications</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-sm">
          <Check name="emailStatements"            label="Email — monthly statement"            checked={p.emailStatements} />
          <Check name="emailAccountAlerts"         label="Email — account alerts"                checked={p.emailAccountAlerts} />
          <Check name="emailEventAnnouncements"    label="Email — event announcements"          checked={p.emailEventAnnouncements} />
          <Check name="emailGeneralAnnouncements"  label="Email — general club news"             checked={p.emailGeneralAnnouncements} />
          <Check name="smsPaymentAlerts"           label="SMS — payment failure alerts"           checked={p.smsPaymentAlerts} />
          <Check name="smsTeeTimeAlerts"           label="SMS — last-minute tee-time alerts"      checked={p.smsTeeTimeAlerts} />
        </div>

        <div className="flex justify-end pt-3"><button className="btn btn-primary">Save preferences</button></div>
      </form>
    </div>
  );
}

function Check({ name, label, checked }: { name: string; label: string; checked?: boolean }) {
  return (
    <label className="flex items-center gap-2 rounded-md bg-stone-50 px-3 py-2">
      <input type="checkbox" name={name} defaultChecked={!!checked} />
      <span>{label}</span>
    </label>
  );
}
