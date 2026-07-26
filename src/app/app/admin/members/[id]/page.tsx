import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { getActiveClubId } from "@/lib/active-club";
import { Badge } from "@/components/Badge";
import { formatCurrency, formatDate } from "@/lib/finance";
import { Tabs } from "@/components/Tabs";
import { isAppError } from "@/lib/errors";

// ----------- server actions -----------
async function setStatusAction(memberId: string, formData: FormData) {
  "use server";
  const status = String(formData.get("status"));
  await prisma.member.update({ where: { id: memberId }, data: { status } });
  redirect(`/app/admin/members/${memberId}`);
}

async function setAccessAction(memberId: string, formData: FormData) {
  "use server";
  const accessStatus = String(formData.get("accessStatus"));
  await prisma.member.update({ where: { id: memberId }, data: { accessStatus } });
  redirect(`/app/admin/members/${memberId}`);
}

async function updateContactAction(memberId: string, formData: FormData) {
  "use server";
  const { getCurrentPrincipal } = await import("@/lib/services/principal");
  const { updateProfile } = await import("@/lib/services/member-profile");
  const principal = await getCurrentPrincipal();
  if (!principal) redirect("/login");
  try {
    await updateProfile(principal, memberId, {
      email: String(formData.get("email") ?? ""),
      phone: String(formData.get("phone") ?? ""),
      dateOfBirth: String(formData.get("dateOfBirth") ?? ""),
      addressLine1: String(formData.get("addressLine1") ?? ""),
      addressLine2: String(formData.get("addressLine2") ?? ""),
      city: String(formData.get("city") ?? ""),
      state: String(formData.get("state") ?? ""),
      postalCode: String(formData.get("postalCode") ?? ""),
      country: String(formData.get("country") ?? ""),
    });
  } catch (err) {
    if (isAppError(err)) {
      redirect(`/app/admin/members/${memberId}?error=${encodeURIComponent(err.safeMessage)}`);
    }
    throw err;
  }
  revalidatePath(`/app/admin/members/${memberId}`);
  redirect(`/app/admin/members/${memberId}?saved=contact`);
}

async function triggerNoticeAction(memberId: string, formData: FormData) {
  "use server";
  const principal = await (await import("@/lib/services/principal")).getCurrentPrincipal();
  if (!principal) redirect("/login");
  const templateKey = String(formData.get("noticeType"));
  const { generateNoticeFromTemplate } = await import("@/lib/services/collections");
  try {
    await generateNoticeFromTemplate(principal, memberId, templateKey);
  } catch {
    // Swallow — admin redirected back with current state.
  }
  redirect(`/app/admin/members/${memberId}`);
}

// ----------- page -----------
export default async function MemberProfilePage({
  params,
  searchParams,
}: {
  params: { id: string };
  searchParams: { saved?: string; error?: string };
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const clubId = await getActiveClubId(user);

  const member = await prisma.member.findFirst({
    where: { id: params.id, clubId },
    include: {
      account: true,
      paymentMethods: true,
      charges: { orderBy: { transactionDate: "desc" }, take: 25 },
      payments: { orderBy: { paymentDate: "desc" }, take: 25 },
      financingAgreements: { include: { schedule: { orderBy: { paymentNumber: "asc" } } } },
      collectionNotices: { orderBy: { createdAt: "desc" } },
      preferences: true,
      registrations: { include: { event: true } },
    },
  });
  if (!member) notFound();

  // Phase 18C — dining summary + recent reservations for the Dining tab.
  const { getMemberDiningSummary } = await import("@/lib/hospitality/dining-analytics");
  const { listUpcomingReservationsForMember, listPastReservationsForMember } = await import("@/lib/hospitality/reservations");
  const [diningSummary, upcomingDining, pastDining] = await Promise.all([
    getMemberDiningSummary(member.id),
    listUpcomingReservationsForMember(member.id, 5),
    listPastReservationsForMember(member.id, 10),
  ]);

  const setStatus = setStatusAction.bind(null, member.id);
  const setAccess = setAccessAction.bind(null, member.id);
  const updateContact = updateContactAction.bind(null, member.id);
  const triggerNotice = triggerNoticeAction.bind(null, member.id);

  // Format dateOfBirth for <input type="date"> (YYYY-MM-DD, no TZ shift).
  const dobInput = member.dateOfBirth
    ? new Date(member.dateOfBirth).toISOString().slice(0, 10)
    : "";

  return (
    <div>
      <Link href="/app/admin/members" className="text-sm text-stone-500 hover:text-club-ink">← All members</Link>
      <div className="mt-3 flex flex-wrap items-end gap-4 justify-between">
        <div>
          <h1 className="page-title">{member.firstName} {member.lastName}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Badge status={member.status} />
            <Badge status={member.accessStatus} />
            <Badge status={member.paymentMethodStatus} />
            <span className="text-sm text-stone-500">{member.memberNumber} · {member.membershipCategory ?? "—"}</span>
          </div>
        </div>
        <div className="text-right">
          <div className="text-xs uppercase tracking-wide text-stone-500">Current balance</div>
          <div className="font-serif text-3xl">{formatCurrency(member.account?.currentBalance ?? 0)}</div>
        </div>
      </div>

      {searchParams.saved === "contact" && (
        <div className="mt-4 rounded-md border border-club-green-300 bg-club-green-50 px-3 py-2 text-sm text-club-green-800">
          Contact information saved.
        </div>
      )}
      {searchParams.error && (
        <div className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{searchParams.error}</div>
      )}

      <div className="mt-8">
        <Tabs
          tabs={[
            {
              id: "profile",
              label: "Profile",
              content: (
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                  <form action={updateContact} className="card card-body lg:col-span-2 space-y-5">
                    <div className="flex items-center justify-between">
                      <h3 className="section-title text-lg">Contact &amp; personal</h3>
                      <span className="text-[10px] uppercase tracking-wide text-stone-400">
                        Editable
                      </span>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div>
                        <label className="label" htmlFor="member-email">Email</label>
                        <input
                          id="member-email"
                          className="input"
                          type="email"
                          name="email"
                          defaultValue={member.email}
                          maxLength={254}
                          required
                        />
                      </div>
                      <div>
                        <label className="label" htmlFor="member-phone">Phone</label>
                        <input
                          id="member-phone"
                          className="input"
                          name="phone"
                          defaultValue={member.phone ?? ""}
                          maxLength={40}
                          placeholder="(555) 555-1234"
                        />
                      </div>
                      <div>
                        <label className="label" htmlFor="member-dob">Birthday</label>
                        <input
                          id="member-dob"
                          className="input"
                          type="date"
                          name="dateOfBirth"
                          defaultValue={dobInput}
                        />
                      </div>
                      <div className="text-sm">
                        <div className="label">Member number</div>
                        <div className="mt-1 text-club-ink">{member.memberNumber}</div>
                        <div className="mt-2 text-xs text-stone-500">
                          Joined {formatDate(member.joinDate)} · {member.membershipCategory ?? "—"}
                        </div>
                      </div>
                    </div>

                    <div className="pt-3 border-t border-stone-100">
                      <h4 className="text-xs uppercase tracking-wide text-stone-500">Mailing address</h4>
                      <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div className="md:col-span-2">
                          <label className="label" htmlFor="member-addr1">Address line 1</label>
                          <input
                            id="member-addr1"
                            className="input"
                            name="addressLine1"
                            defaultValue={member.addressLine1 ?? ""}
                            maxLength={200}
                          />
                        </div>
                        <div className="md:col-span-2">
                          <label className="label" htmlFor="member-addr2">Address line 2</label>
                          <input
                            id="member-addr2"
                            className="input"
                            name="addressLine2"
                            defaultValue={member.addressLine2 ?? ""}
                            maxLength={200}
                            placeholder="Apt, suite, etc. (optional)"
                          />
                        </div>
                        <div>
                          <label className="label" htmlFor="member-city">City</label>
                          <input
                            id="member-city"
                            className="input"
                            name="city"
                            defaultValue={member.city ?? ""}
                            maxLength={100}
                          />
                        </div>
                        <div className="grid grid-cols-2 gap-3">
                          <div>
                            <label className="label" htmlFor="member-state">State / Province</label>
                            <input
                              id="member-state"
                              className="input"
                              name="state"
                              defaultValue={member.state ?? ""}
                              maxLength={100}
                            />
                          </div>
                          <div>
                            <label className="label" htmlFor="member-zip">Postal code</label>
                            <input
                              id="member-zip"
                              className="input"
                              name="postalCode"
                              defaultValue={member.postalCode ?? ""}
                              maxLength={20}
                            />
                          </div>
                        </div>
                        <div>
                          <label className="label" htmlFor="member-country">Country</label>
                          <input
                            id="member-country"
                            className="input"
                            name="country"
                            defaultValue={member.country ?? ""}
                            maxLength={100}
                          />
                        </div>
                      </div>
                    </div>

                    <div className="flex justify-end pt-2 border-t border-stone-100">
                      <button className="btn btn-primary">Save changes</button>
                    </div>
                  </form>
                  <div className="space-y-4">
                    <form action={setStatus} className="card card-body">
                      <h3 className="font-medium">Adjust status</h3>
                      <select className="select mt-3" name="status" defaultValue={member.status}>
                        {["ONBOARDING", "ACTIVE", "SUSPENDED", "INACTIVE", "WAITLIST"].map((s) => (
                          <option key={s}>{s}</option>
                        ))}
                      </select>
                      <button className="btn btn-secondary mt-3 w-full">Save status</button>
                    </form>
                    <form action={setAccess} className="card card-body">
                      <h3 className="font-medium">Access controls</h3>
                      <select className="select mt-3" name="accessStatus" defaultValue={member.accessStatus}>
                        {["FULL_ACCESS", "CHARGE_ACCOUNT_SUSPENDED", "TEE_SHEET_SUSPENDED", "FULL_SUSPENSION"].map((s) => (
                          <option key={s}>{s}</option>
                        ))}
                      </select>
                      <button className="btn btn-secondary mt-3 w-full">Apply access</button>
                    </form>
                    <form action={triggerNotice} className="card card-body">
                      <h3 className="font-medium">Trigger collection notice</h3>
                      <select className="select mt-3" name="noticeType" defaultValue="OVER_30">
                        {["CARD_DECLINED", "PAP_FAILED", "OVER_30", "OVER_60", "OVER_90", "FINAL_NOTICE"].map((s) => (
                          <option key={s}>{s.replace(/_/g, " ")}</option>
                        ))}
                      </select>
                      <button className="btn btn-secondary mt-3 w-full">Create notice</button>
                    </form>
                  </div>
                </div>
              ),
            },
            {
              id: "account",
              label: "Account",
              content: (
                <div className="card card-body max-w-2xl">
                  <h3 className="section-title text-lg">AR aging</h3>
                  <div className="mt-4 grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                    <Stat label="Current" value={formatCurrency(member.account?.currentBalance ?? 0)} />
                    <Stat label="30 days" value={formatCurrency(member.account?.thirtyDayBalance ?? 0)} />
                    <Stat label="60 days" value={formatCurrency(member.account?.sixtyDayBalance ?? 0)} />
                    <Stat label="90+ days" value={formatCurrency(member.account?.ninetyDayBalance ?? 0)} />
                  </div>
                </div>
              ),
            },
            {
              id: "paymentMethods",
              label: "Payment Methods",
              content: (
                <div className="card overflow-hidden">
                  <table className="table-base">
                    <thead>
                      <tr><th>Type</th><th>Nickname</th><th>Last four</th><th>Roles</th><th>Status</th></tr>
                    </thead>
                    <tbody>
                      {member.paymentMethods.length === 0 && (
                        <tr><td colSpan={5} className="px-4 py-8 text-center text-stone-500">No payment methods on file.</td></tr>
                      )}
                      {member.paymentMethods.map((pm) => (
                        <tr key={pm.id}>
                          <td>{pm.type === "CREDIT_CARD" ? "Credit Card" : "EFT"}</td>
                          <td>{pm.nickname ?? "—"}</td>
                          <td className="font-mono">•••• {pm.lastFour}</td>
                          <td className="space-x-1">
                            {pm.isPrimary && <span className="badge bg-club-green-50 text-club-green-700 ring-club-green-200">Primary</span>}
                            {pm.isBackup && <span className="badge bg-blue-50 text-blue-700 ring-blue-200">Backup</span>}
                          </td>
                          <td><Badge status={pm.status} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ),
            },
            {
              id: "charges",
              label: "Charges",
              content: <ActivityTable rows={member.charges.map((c) => ({ date: c.transactionDate, label: c.description, sub: c.category.replace(/_/g, " "), amount: c.amount, status: c.status }))} />,
            },
            {
              id: "payments",
              label: "Payments",
              content: <ActivityTable rows={member.payments.map((p) => ({ date: p.paymentDate, label: p.method, sub: p.failureReason ?? "", amount: p.amount, status: p.status }))} />,
            },
            {
              id: "financing",
              label: "Financing",
              content: (
                <div className="space-y-6">
                  {member.financingAgreements.length === 0 && (
                    <div className="card card-body text-stone-500">No financing agreements.</div>
                  )}
                  {member.financingAgreements.map((a) => (
                    <div key={a.id} className="card overflow-hidden">
                      <div className="px-6 py-4 border-b border-stone-200 flex flex-wrap items-center justify-between gap-2">
                        <div>
                          <div className="font-medium">{formatCurrency(a.principalAmount)} · {a.termMonths} months · {(a.interestRate * 100).toFixed(2)}%</div>
                          <div className="text-xs text-stone-500">Started {formatDate(a.startDate)} {a.signedAt ? `· Signed ${formatDate(a.signedAt)}` : ""}</div>
                        </div>
                        <Badge status={a.status} />
                      </div>
                      <div className="overflow-x-auto max-h-[320px]">
                        <table className="table-base">
                          <thead>
                            <tr><th>#</th><th>Due</th><th>Payment</th><th>Principal</th><th>Interest</th><th>Remaining</th><th>Status</th></tr>
                          </thead>
                          <tbody>
                            {a.schedule.map((r) => (
                              <tr key={r.id}>
                                <td>{r.paymentNumber}</td>
                                <td>{formatDate(r.dueDate)}</td>
                                <td>{formatCurrency(r.paymentAmount)}</td>
                                <td>{formatCurrency(r.principalAmount)}</td>
                                <td>{formatCurrency(r.interestAmount)}</td>
                                <td>{formatCurrency(r.remainingBalance)}</td>
                                <td><Badge status={r.status} /></td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  ))}
                </div>
              ),
            },
            {
              id: "collections",
              label: "Collections",
              content: (
                <div className="card overflow-hidden">
                  <table className="table-base">
                    <thead>
                      <tr><th>Type</th><th>Created</th><th>Sent</th><th>Status</th></tr>
                    </thead>
                    <tbody>
                      {member.collectionNotices.length === 0 && (
                        <tr><td colSpan={4} className="px-4 py-8 text-center text-stone-500">No collection notices.</td></tr>
                      )}
                      {member.collectionNotices.map((n) => (
                        <tr key={n.id}>
                          <td>{n.noticeType.replace(/_/g, " ")}</td>
                          <td>{formatDate(n.createdAt)}</td>
                          <td>{formatDate(n.sentAt)}</td>
                          <td><Badge status={n.status} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ),
            },
            {
              id: "preferences",
              label: "Preferences",
              content: (
                <div className="card card-body max-w-2xl">
                  {member.preferences ? (
                    <ul className="grid grid-cols-1 md:grid-cols-2 gap-2 text-sm">
                      <Pref label="Golf" v={member.preferences.interestedGolf} />
                      <Pref label="Dining" v={member.preferences.interestedDining} />
                      <Pref label="Events" v={member.preferences.interestedEvents} />
                      <Pref label="Leagues" v={member.preferences.interestedLeagues} />
                      <Pref label="Practice facilities" v={member.preferences.interestedPracticeFacilities} />
                      <Pref label="Pro Shop offers" v={member.preferences.wantsProShopOffers} />
                      <Pref label="Tee time alerts" v={member.preferences.wantsTeeTimeAlerts} />
                    </ul>
                  ) : (
                    <div className="text-stone-500">No preferences captured yet.</div>
                  )}
                </div>
              ),
            },
            {
              id: "dining",
              label: "Dining",
              content: (
                <div className="space-y-6">
                  <div className="card card-body">
                    <h3 className="section-title text-lg">Dining summary (YTD)</h3>
                    <dl className="mt-3 grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                      <Stat label="Visits" value={String(diningSummary.visitsYtd)} />
                      <Stat label="Total spend" value={formatCurrency(diningSummary.totalSpendYtd)} />
                      <Stat label="Avg / visit" value={diningSummary.avgSpendPerVisit !== null ? formatCurrency(diningSummary.avgSpendPerVisit) : "—"} />
                      <Stat label="Avg rating" value={diningSummary.avgRating !== null ? diningSummary.avgRating.toFixed(2) : "—"} />
                      <Stat label="Avg party" value={diningSummary.avgPartySize !== null ? diningSummary.avgPartySize.toFixed(1) : "—"} />
                      <Stat label="No-shows" value={String(diningSummary.noShows)} />
                      <Stat label="Cancellations" value={String(diningSummary.cancellations)} />
                      <Stat label="Last visit" value={diningSummary.lastVisit ? formatDate(diningSummary.lastVisit) : "—"} />
                    </dl>
                  </div>

                  <div className="card overflow-hidden">
                    <div className="px-5 py-3 border-b border-stone-200 font-medium">
                      Upcoming reservations ({upcomingDining.length})
                    </div>
                    <table className="table-base">
                      <thead><tr><th>Date</th><th>Area</th><th>Party</th><th>Status</th><th></th></tr></thead>
                      <tbody>
                        {upcomingDining.length === 0 && (
                          <tr><td colSpan={5} className="px-4 py-6 text-center text-stone-500">No upcoming reservations.</td></tr>
                        )}
                        {upcomingDining.map((r) => (
                          <tr key={r.id}>
                            <td className="text-xs">{formatDate(r.startTime)} {r.startTime.toISOString().slice(11, 16)}</td>
                            <td className="text-xs">{r.diningArea.name}</td>
                            <td className="text-sm">{r.partySize}</td>
                            <td className="text-xs">{r.status.replace("_", " ")}</td>
                            <td className="text-right text-xs">
                              <Link href={`/app/admin/hospitality/reservations/${r.id}`} className="text-club-green-700 hover:underline">Open</Link>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  <div className="card overflow-hidden">
                    <div className="px-5 py-3 border-b border-stone-200 font-medium">
                      Recent dining history
                    </div>
                    <table className="table-base">
                      <thead><tr><th>Date</th><th>Area</th><th>Party</th><th>Status</th><th className="text-right">Spend</th></tr></thead>
                      <tbody>
                        {pastDining.length === 0 && (
                          <tr><td colSpan={5} className="px-4 py-6 text-center text-stone-500">No previous dining visits.</td></tr>
                        )}
                        {pastDining.map((r) => {
                          const spend = r.checkLinks.reduce(
                            (sum, l) => sum + (l.posSale?.grandTotal ? Number(l.posSale.grandTotal.toString()) : 0),
                            0,
                          );
                          return (
                            <tr key={r.id}>
                              <td className="text-xs">{formatDate(r.startTime)}</td>
                              <td className="text-xs">{r.diningArea.name}</td>
                              <td className="text-sm">{r.partySize}</td>
                              <td className="text-xs">{r.status.replace("_", " ")}</td>
                              <td className="text-xs text-right tabular-nums">{spend > 0 ? formatCurrency(spend) : "—"}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              ),
            },
            {
              id: "events",
              label: "Events",
              content: (
                <div className="card overflow-hidden">
                  <table className="table-base">
                    <thead><tr><th>Event</th><th>Date</th><th>Guests</th><th>Charged</th><th>Status</th></tr></thead>
                    <tbody>
                      {member.registrations.length === 0 && (
                        <tr><td colSpan={5} className="px-4 py-8 text-center text-stone-500">No event registrations.</td></tr>
                      )}
                      {member.registrations.map((r) => (
                        <tr key={r.id}>
                          <td>{r.event.title}</td>
                          <td>{formatDate(r.event.eventDate)}</td>
                          <td>{r.numberOfGuests}</td>
                          <td>{formatCurrency(r.amountCharged)}</td>
                          <td><Badge status={r.status} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ),
            },
          ]}
        />
      </div>
    </div>
  );
}

function DT({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-stone-500">{label}</dt>
      <dd className="mt-1 text-club-ink">{children}</dd>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-stone-50 px-3 py-2">
      <div className="text-xs uppercase tracking-wide text-stone-500">{label}</div>
      <div className="mt-1 font-serif text-xl text-club-ink">{value}</div>
    </div>
  );
}

function Pref({ label, v }: { label: string; v: boolean }) {
  return (
    <li className="flex items-center justify-between rounded-md bg-stone-50 px-3 py-2">
      <span>{label}</span>
      <span className={v ? "text-club-green-700 font-medium" : "text-stone-400"}>{v ? "Yes" : "—"}</span>
    </li>
  );
}

function ActivityTable({ rows }: { rows: Array<{ date: Date; label: string; sub?: string; amount: number; status: string }> }) {
  return (
    <div className="card overflow-hidden">
      <table className="table-base">
        <thead><tr><th>Date</th><th>Description</th><th className="text-right">Amount</th><th>Status</th></tr></thead>
        <tbody>
          {rows.length === 0 && (
            <tr><td colSpan={4} className="px-4 py-8 text-center text-stone-500">Nothing yet.</td></tr>
          )}
          {rows.map((r, i) => (
            <tr key={i}>
              <td>{formatDate(r.date)}</td>
              <td>
                <div className="font-medium">{r.label}</div>
                {r.sub && <div className="text-xs text-stone-500">{r.sub}</div>}
              </td>
              <td className="text-right tabular-nums">{formatCurrency(r.amount)}</td>
              <td><Badge status={r.status} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
