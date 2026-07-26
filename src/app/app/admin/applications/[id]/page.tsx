import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getCurrentPrincipal } from "@/lib/services/principal";
import {
  approveApplication,
  denyApplication,
  waitlistApplication,
  appendInternalNote,
  requestMoreInformation,
  moveUnderReview,
  assignReviewer,
  listReviewers,
} from "@/lib/services/applications";
import { hasPermission } from "@/lib/rbac";
import { isAppError } from "@/lib/errors";
import { Badge } from "@/components/Badge";
import { formatDate } from "@/lib/finance";

// ---------- server actions --------------------------------------------------
function withRedirect(id: string) {
  return (err: unknown) => {
    if (isAppError(err)) redirect(`/app/admin/applications/${id}?error=${encodeURIComponent(err.safeMessage)}`);
    throw err;
  };
}

async function approveAction(applicantId: string) {
  "use server";
  const p = await getCurrentPrincipal();
  if (!p) redirect("/login");
  try {
    const { member } = await approveApplication(p, applicantId);
    redirect(`/app/admin/members/${member.id}/approve`);
  } catch (err) { withRedirect(applicantId)(err); }
}

async function denyAction(applicantId: string, formData: FormData) {
  "use server";
  const p = await getCurrentPrincipal();
  if (!p) redirect("/login");
  const reason = String(formData.get("reason") ?? "").trim() || null;
  try { await denyApplication(p, applicantId, reason); } catch (err) { withRedirect(applicantId)(err); }
  redirect(`/app/admin/applications/${applicantId}`);
}

async function waitlistAction(applicantId: string, formData: FormData) {
  "use server";
  const p = await getCurrentPrincipal();
  if (!p) redirect("/login");
  const raw = formData.get("priority"); const priority = raw ? Number(raw) : undefined;
  try { await waitlistApplication(p, applicantId, priority); } catch (err) { withRedirect(applicantId)(err); }
  redirect(`/app/admin/applications/${applicantId}`);
}

async function requestInfoAction(applicantId: string, formData: FormData) {
  "use server";
  const p = await getCurrentPrincipal();
  if (!p) redirect("/login");
  try { await requestMoreInformation(p, applicantId, String(formData.get("note") ?? "")); } catch (err) { withRedirect(applicantId)(err); }
  redirect(`/app/admin/applications/${applicantId}`);
}

async function underReviewAction(applicantId: string) {
  "use server";
  const p = await getCurrentPrincipal();
  if (!p) redirect("/login");
  try { await moveUnderReview(p, applicantId); } catch (err) { withRedirect(applicantId)(err); }
  redirect(`/app/admin/applications/${applicantId}`);
}

async function assignReviewerAction(applicantId: string, formData: FormData) {
  "use server";
  const p = await getCurrentPrincipal();
  if (!p) redirect("/login");
  const userId = String(formData.get("userId") ?? "");
  try { await assignReviewer(p, applicantId, userId || null); } catch (err) { withRedirect(applicantId)(err); }
  redirect(`/app/admin/applications/${applicantId}`);
}

async function noteAction(applicantId: string, formData: FormData) {
  "use server";
  const p = await getCurrentPrincipal();
  if (!p) redirect("/login");
  try { await appendInternalNote(p, applicantId, String(formData.get("note") ?? "")); } catch (err) { withRedirect(applicantId)(err); }
  redirect(`/app/admin/applications/${applicantId}`);
}

// ---------- page ------------------------------------------------------------
export default async function ApplicationDetailPage({
  params,
  searchParams,
}: {
  params: { id: string };
  searchParams: { error?: string };
}) {
  const principal = await getCurrentPrincipal();
  if (!principal) redirect("/login");

  const applicant = await prisma.applicant.findUnique({
    where: { id: params.id },
    include: {
      member: true,
      reviewer: true,
      household: { orderBy: { createdAt: "asc" } },
      documents: { orderBy: { uploadedAt: "asc" } },
    },
  });
  if (!applicant) notFound();
  if (!hasPermission(principal, applicant.clubId, "applications:read")) notFound();

  const canReview = hasPermission(principal, applicant.clubId, "applications:review");
  const canAssign = hasPermission(principal, applicant.clubId, "applications:assign");
  const canSeeDocs = hasPermission(principal, applicant.clubId, "applications:documents:read");
  const reviewers = canAssign ? await listReviewers(principal, applicant.clubId) : [];

  // Recent audit-log entries for this applicant form the activity timeline.
  const activity = await prisma.auditLog.findMany({
    where: { entityType: "Applicant", entityId: applicant.id },
    orderBy: { createdAt: "desc" },
    take: 25,
    include: { user: { select: { name: true } } },
  });

  const approve = approveAction.bind(null, applicant.id);
  const deny = denyAction.bind(null, applicant.id);
  const waitlist = waitlistAction.bind(null, applicant.id);
  const requestInfo = requestInfoAction.bind(null, applicant.id);
  const underReview = underReviewAction.bind(null, applicant.id);
  const assign = assignReviewerAction.bind(null, applicant.id);
  const note = noteAction.bind(null, applicant.id);

  return (
    <div>
      <div className="flex items-center gap-3 text-sm">
        <Link href="/app/admin/applications" className="text-stone-500 hover:text-club-ink">← All applications</Link>
      </div>

      <div className="mt-4 flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="page-title">{applicant.firstName} {applicant.lastName}</h1>
          <div className="mt-2 flex items-center gap-3 flex-wrap">
            <Badge status={applicant.applicationStatus} />
            <span className="text-sm text-stone-500">Received {formatDate(applicant.createdAt)}</span>
            {applicant.submittedAt && <span className="text-sm text-stone-500">· Submitted {formatDate(applicant.submittedAt)}</span>}
            {applicant.reviewer && <span className="text-sm text-stone-500">· Reviewer: {applicant.reviewer.name}</span>}
            {applicant.waitlistPriority != null && <span className="text-sm text-stone-500">· Waitlist priority {applicant.waitlistPriority}</span>}
          </div>
        </div>
        {applicant.applicationStatus === "APPROVED" && applicant.member && (
          <Link className="btn btn-primary" href={`/app/admin/members/${applicant.member.id}/approve`}>Continue onboarding →</Link>
        )}
      </div>

      {searchParams.error && (
        <div className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{searchParams.error}</div>
      )}

      <div className="mt-8 grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-6">
          <div className="card card-body">
            <h2 className="section-title text-xl">Applicant details</h2>
            <dl className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
              <Field label="Email">{applicant.email}</Field>
              <Field label="Phone">{applicant.phone ?? "—"}</Field>
              <Field label="Date of birth">{formatDate(applicant.dateOfBirth)}</Field>
              <Field label="Sponsor">{applicant.sponsorName ?? "—"}</Field>
              <Field label="Membership category">{applicant.membershipCategory ?? "—"}</Field>
              <Field label="Referral source">{applicant.referralSource ?? "—"}</Field>
              <Field label="Employment">{applicant.employmentInfo ?? "—"}</Field>
              <Field label="Credit score band">{applicant.creditScoreBand ?? "Pending credit check"}</Field>
              <Field label="Credit-check consent">{applicant.consentCreditCheck ? "Yes" : "No"}</Field>
              <Field label="Background-check consent">{applicant.consentBackgroundCheck ? "Yes" : "No"}</Field>
              <Field label="Submitted from">{applicant.signedSubmissionIp ?? "—"}</Field>
              <Field label="Address">
                {[applicant.address1, applicant.address2, [applicant.city, applicant.provinceState].filter(Boolean).join(", "), [applicant.postalCode, applicant.country].filter(Boolean).join(" · ")].filter(Boolean).join(" · ") || "—"}
              </Field>
            </dl>
          </div>

          <div className="card card-body">
            <h2 className="section-title text-xl">Household</h2>
            {applicant.household.length === 0 ? (
              <p className="mt-3 text-sm text-stone-500">None recorded.</p>
            ) : (
              <ul className="mt-3 space-y-2 text-sm">
                {applicant.household.map((h) => (
                  <li key={h.id} className="rounded-md bg-stone-50 px-3 py-2">
                    <div className="font-medium">{h.firstName} {h.lastName} <span className="text-stone-500 font-normal">· {h.relationship.toLowerCase()}</span></div>
                    <div className="text-xs text-stone-500">{[h.email, h.phone, h.dateOfBirth ? `b. ${formatDate(h.dateOfBirth)}` : null].filter(Boolean).join(" · ")}</div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {canSeeDocs && (
            <div className="card card-body">
              <h2 className="section-title text-xl">Documents</h2>
              {applicant.documents.length === 0 ? (
                <p className="mt-3 text-sm text-stone-500">No documents attached.</p>
              ) : (
                <ul className="mt-3 space-y-1 text-sm">
                  {applicant.documents.map((d) => (
                    <li key={d.id} className="flex items-center justify-between rounded-md bg-stone-50 px-3 py-2">
                      <div>
                        <div className="font-medium">{d.name}</div>
                        <div className="text-xs text-stone-500">{d.mimeType} · {Math.round(d.sizeBytes / 1024)} KB · uploaded {formatDate(d.uploadedAt)}</div>
                      </div>
                      <span className="text-xs text-stone-400">Storage integration pending</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <div className="card card-body">
            <h2 className="section-title text-xl">Internal notes</h2>
            <pre className="mt-3 whitespace-pre-wrap text-sm text-stone-700">{applicant.internalNotes?.trim() || "No notes yet."}</pre>
            {canReview && (
              <form action={note} className="mt-4 space-y-3">
                <textarea name="note" rows={3} className="textarea" placeholder="Add an internal note…" maxLength={4000} />
                <div className="flex justify-end"><button className="btn btn-secondary" type="submit">Add note</button></div>
              </form>
            )}
          </div>

          <div className="card card-body">
            <h2 className="section-title text-xl">Activity</h2>
            {activity.length === 0 ? (
              <p className="mt-3 text-sm text-stone-500">No activity yet.</p>
            ) : (
              <ul className="mt-4 space-y-3 text-sm">
                {activity.map((a) => (
                  <li key={a.id} className="border-l-2 border-stone-200 pl-3">
                    <div className="font-medium">{a.action}</div>
                    <div className="text-xs text-stone-500">
                      {formatDate(a.createdAt)} · {a.user?.name ?? "system"}
                      {a.ip ? ` · ${a.ip}` : ""}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {applicant.denialReason && (
            <div className="card card-body border-l-4 border-red-300">
              <h3 className="font-semibold text-red-700">Denial reason</h3>
              <p className="mt-2 text-sm text-stone-700">{applicant.denialReason}</p>
            </div>
          )}
        </div>

        <div className="space-y-4">
          {canAssign && (
            <form action={assign} className="card card-body">
              <h3 className="font-medium">Reviewer</h3>
              <select className="select mt-3" name="userId" defaultValue={applicant.reviewerId ?? ""}>
                <option value="">Unassigned</option>
                {reviewers.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
              <button className="btn btn-secondary mt-3 w-full">Save reviewer</button>
            </form>
          )}

          {canReview && applicant.applicationStatus === "SUBMITTED" && (
            <form action={underReview} className="card card-body">
              <h3 className="font-medium">Mark under review</h3>
              <p className="mt-1 text-sm text-stone-500">Indicates the committee is actively considering this application.</p>
              <button className="btn btn-secondary mt-3 w-full">Under review</button>
            </form>
          )}

          {canReview && applicant.applicationStatus !== "APPROVED" && (
            <form action={approve} className="card card-body">
              <h3 className="font-medium text-club-ink">Approve</h3>
              <p className="mt-1 text-sm text-stone-500">Creates a member record and continues onboarding.</p>
              <button className="btn btn-primary mt-3 w-full">Approve application</button>
            </form>
          )}

          {canReview && ["SUBMITTED", "UNDER_REVIEW", "WAITLISTED", "PENDING_INFORMATION"].includes(applicant.applicationStatus) && (
            <form action={requestInfo} className="card card-body">
              <h3 className="font-medium text-club-ink">Request information</h3>
              <p className="mt-1 text-sm text-stone-500">Sends the applicant a note explaining what you need.</p>
              <textarea name="note" rows={3} className="textarea mt-3" required maxLength={4000} placeholder="What do you need from the applicant?" />
              <button className="btn btn-secondary mt-3 w-full">Request info</button>
            </form>
          )}

          {canReview && applicant.applicationStatus !== "WAITLISTED" && applicant.applicationStatus !== "APPROVED" && (
            <form action={waitlist} className="card card-body">
              <h3 className="font-medium text-club-ink">Move to waitlist</h3>
              <input className="input mt-3" name="priority" type="number" min={1} max={9999} placeholder="Priority (1 = highest)" />
              <button className="btn btn-secondary mt-3 w-full">Move to waitlist</button>
            </form>
          )}

          {canReview && applicant.applicationStatus !== "DENIED" && applicant.applicationStatus !== "APPROVED" && (
            <form action={deny} className="card card-body">
              <h3 className="font-medium text-club-ink">Deny</h3>
              <textarea name="reason" rows={3} className="textarea mt-3" placeholder="Reason (optional)" maxLength={2000} />
              <button className="btn btn-danger mt-3 w-full">Deny application</button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-stone-500">{label}</dt>
      <dd className="mt-1 text-club-ink">{children}</dd>
    </div>
  );
}
