import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { getActiveClubId } from "@/lib/active-club";
import { formatCurrency } from "@/lib/finance";

const SHARE_PRICE = 19600; // placeholder initiation/share price

async function payInFullAction(memberId: string) {
  "use server";
  const member = await prisma.member.findUnique({ where: { id: memberId } });
  if (!member) throw new Error("Member not found");
  // Simulate a successful share-purchase payment.
  const account = await prisma.memberAccount.findUnique({ where: { memberId } });
  if (account) {
    await prisma.payment.create({
      data: {
        clubId: member.clubId,
        memberId,
        accountId: account.id,
        amount: SHARE_PRICE,
        method: "CREDIT_CARD",
        status: "SUCCESS",
      },
    });
  }
  redirect(`/app/welcome/timeline?welcomeMember=${memberId}`);
}

async function waitlistDepositAction(memberId: string) {
  "use server";
  const member = await prisma.member.findUnique({ where: { id: memberId } });
  if (!member) throw new Error("Member not found");
  await prisma.member.update({ where: { id: memberId }, data: { status: "WAITLIST" } });
  redirect(`/app/admin/members/${memberId}`);
}

export default async function ApprovalPaymentPage({ params }: { params: { id: string } }) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const clubId = await getActiveClubId(user);

  const member = await prisma.member.findFirst({
    where: { id: params.id, clubId },
    include: { applicant: true, club: true },
  });
  if (!member) notFound();

  const payInFull = payInFullAction.bind(null, member.id);
  const waitlist = waitlistDepositAction.bind(null, member.id);

  return (
    <div className="max-w-4xl">
      <Link href={`/app/admin/applications/${member.applicantId ?? ""}`} className="text-sm text-stone-500 hover:text-club-ink">
        ← Back to application
      </Link>
      <h1 className="page-title mt-3">Approve &amp; Onboard — {member.firstName} {member.lastName}</h1>
      <p className="mt-1 text-stone-500">Select how this new member would like to fund their share purchase.</p>

      <div className="mt-4 card card-body bg-club-cream">
        <div className="flex items-baseline justify-between">
          <div>
            <div className="text-xs uppercase tracking-widest text-stone-500">Initiation / Share Price</div>
            <div className="font-serif text-4xl text-club-ink">{formatCurrency(SHARE_PRICE)}</div>
          </div>
          <div className="text-sm text-stone-500">{member.club?.name}</div>
        </div>
      </div>

      <div className="mt-6 grid grid-cols-1 md:grid-cols-3 gap-5">
        <form action={payInFull} className="card card-body">
          <h2 className="font-serif text-xl">Pay in full</h2>
          <p className="mt-2 text-sm text-stone-500">Member pays the full share price today using a payment method on file.</p>
          <button className="btn btn-primary w-full mt-4">Pay in full · {formatCurrency(SHARE_PRICE)}</button>
        </form>

        <Link
          href={`/app/admin/members/${member.id}/financing/new`}
          className="card card-body hover:shadow-elevated transition-shadow"
        >
          <h2 className="font-serif text-xl">Finance</h2>
          <p className="mt-2 text-sm text-stone-500">Generate an amortization schedule and have the member accept the promissory note.</p>
          <span className="btn btn-secondary w-full mt-4">Open financing →</span>
        </Link>

        <form action={waitlist} className="card card-body">
          <h2 className="font-serif text-xl">Waitlist deposit</h2>
          <p className="mt-2 text-sm text-stone-500">Hold a place on the waitlist (no share-purchase processed today).</p>
          <button className="btn btn-secondary w-full mt-4">Move to waitlist</button>
        </form>
      </div>
    </div>
  );
}
