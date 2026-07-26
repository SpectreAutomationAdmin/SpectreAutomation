import Link from "next/link";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { getActiveClubId } from "@/lib/active-club";
import { Badge } from "@/components/Badge";
import { cn } from "@/lib/ui";

const FILTERS = [
  { value: "", label: "All" },
  { value: "DRAFT", label: "Draft" },
  { value: "SUBMITTED", label: "Submitted" },
  { value: "UNDER_REVIEW", label: "Under review" },
  { value: "PENDING_INFORMATION", label: "Pending info" },
  { value: "WAITLISTED", label: "Waitlisted" },
  { value: "APPROVED", label: "Approved" },
  { value: "DENIED", label: "Denied" },
  { value: "WITHDRAWN", label: "Withdrawn" },
];

export default async function ApplicationsListPage({ searchParams }: { searchParams: { status?: string } }) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const clubId = await getActiveClubId(user);

  const status = searchParams.status?.toUpperCase();
  const applicants = await prisma.applicant.findMany({
    where: { clubId, ...(status && status !== "ALL" ? { applicationStatus: status } : {}) },
    orderBy: { createdAt: "desc" },
  });

  return (
    <div>
      <div className="flex items-end justify-between flex-wrap gap-4">
        <div>
          <h1 className="page-title">Applications</h1>
          <p className="mt-1 text-stone-500">Review and process membership applications.</p>
        </div>
      </div>

      <div className="mt-6 flex items-center gap-2 flex-wrap">
        {FILTERS.map((f) => {
          const active = (status ?? "") === f.value;
          const href = f.value ? `/app/admin/applications?status=${f.value}` : "/app/admin/applications";
          return (
            <Link
              key={f.value || "all"}
              href={href}
              className={cn(
                "rounded-full px-3 py-1 text-xs font-medium ring-1 ring-inset",
                active ? "bg-club-green-700 text-white ring-club-green-700" : "bg-white text-stone-600 ring-stone-200 hover:bg-stone-50"
              )}
            >
              {f.label}
            </Link>
          );
        })}
      </div>

      <div className="card mt-6">
        <table className="table-base">
          <thead>
            <tr>
              <th>Applicant</th>
              <th>Email</th>
              <th>Sponsor</th>
              <th>Category</th>
              <th>Status</th>
              <th>Received</th>
            </tr>
          </thead>
          <tbody>
            {applicants.length === 0 && (
              <tr><td colSpan={6} className="px-4 py-8 text-center text-stone-500">No applications match this filter.</td></tr>
            )}
            {applicants.map((a) => (
              <tr key={a.id}>
                <td>
                  <Link href={`/app/admin/applications/${a.id}`} className="font-medium text-club-ink hover:text-club-green-700">
                    {a.firstName} {a.lastName}
                  </Link>
                </td>
                <td className="text-stone-600">{a.email}</td>
                <td className="text-stone-600">{a.sponsorName ?? "—"}</td>
                <td className="text-stone-600">{a.membershipCategory ?? "—"}</td>
                <td><Badge status={a.applicationStatus} /></td>
                <td className="text-stone-600">{new Date(a.createdAt).toLocaleDateString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
