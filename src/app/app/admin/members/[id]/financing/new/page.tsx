import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { getActiveClubId } from "@/lib/active-club";
import { calculateAmortization } from "@/lib/finance";
import { FinancingCalculator } from "@/components/FinancingCalculator";

async function acceptFinancingAction(memberId: string, formData: FormData) {
  "use server";

  const member = await prisma.member.findUnique({ where: { id: memberId } });
  if (!member) throw new Error("Member not found");

  const principal = Number(formData.get("principal"));
  const interestRate = Number(formData.get("interestRate"));
  const termMonths = Number(formData.get("termMonths"));
  const paymentFrequency = String(formData.get("paymentFrequency") || "MONTHLY");
  const signatureName = String(formData.get("signatureName") ?? "").trim();
  if (!signatureName) throw new Error("Signature required");

  const startDate = new Date();
  const amort = calculateAmortization(principal, interestRate, termMonths, startDate);

  const agreement = await prisma.financingAgreement.create({
    data: {
      clubId: member.clubId,
      memberId: member.id,
      principalAmount: principal,
      interestRate,
      termMonths,
      paymentFrequency,
      monthlyPayment: amort.monthlyPayment,
      totalInterest: amort.totalInterest,
      startDate,
      status: "ACTIVE",
      signedAt: new Date(),
      signatureName,
    },
  });

  await prisma.financingPaymentSchedule.createMany({
    data: amort.schedule.map((r) => ({
      clubId: member.clubId,
      financingAgreementId: agreement.id,
      paymentNumber: r.paymentNumber,
      dueDate: r.dueDate,
      paymentAmount: r.paymentAmount,
      principalAmount: r.principalAmount,
      interestAmount: r.interestAmount,
      remainingBalance: r.remainingBalance,
      status: "SCHEDULED",
    })),
  });

  redirect(`/app/welcome/timeline?welcomeMember=${member.id}`);
}

export default async function NewFinancingPage({ params }: { params: { id: string } }) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const clubId = await getActiveClubId(user);

  const member = await prisma.member.findFirst({
    where: { id: params.id, clubId },
    include: { club: true },
  });
  if (!member) notFound();

  const action = acceptFinancingAction.bind(null, member.id);

  return (
    <div>
      <Link href={`/app/admin/members/${member.id}/approve`} className="text-sm text-stone-500 hover:text-club-ink">
        ← Back to approval
      </Link>
      <h1 className="page-title mt-3">Financing — {member.firstName} {member.lastName}</h1>
      <p className="mt-1 text-stone-500">Configure the share-purchase financing and capture the member&rsquo;s acceptance.</p>

      <div className="mt-8">
        <FinancingCalculator memberId={member.id} acceptAction={action} />
      </div>
    </div>
  );
}
