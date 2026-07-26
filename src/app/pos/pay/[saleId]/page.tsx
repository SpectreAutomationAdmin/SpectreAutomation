// Public QR-pay landing page.
//
// The member scans the QR on their signature chit. The page surface
// is purposely minimal so a leaked URL doesn't expose itemized data:
// just the club, the location, the amount due, and the current
// payment lifecycle state.
//
// Lifecycle stages we reflect:
//   • PENDING — sale exists, gateway hasn't confirmed
//   • CONFIRMED — payment captured; sale is COMPLETED + check closed
//   • DECLINED / EXPIRED — failed; operator can retry from the POS
//
// Dev controls: when NODE_ENV !== "production", the page renders
// three simulator buttons that flip the gateway state. A production
// build would replace these with a real payment processor's UI.
//
// Auth: deliberately PUBLIC. The QR is the bearer credential.

import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { formatCurrency, formatDateTime } from "@/lib/finance";
import { QrPayDevControls } from "./QrPayDevControls";

export const runtime = "nodejs";
// Don't cache — payment status flips and the page needs to reflect
// the latest state on every visit / poll.
export const dynamic = "force-dynamic";

export default async function QrPayPage({ params }: { params: { saleId: string } }) {
  const sale = await prisma.pOSSale.findUnique({
    where: { id: params.saleId },
    select: {
      id: true,
      saleNumber: true,
      grandTotal: true,
      saleDate: true,
      chargeMode: true,
      status: true,
      club: { select: { name: true } },
      location: { select: { name: true } },
      payments: {
        take: 1,
        select: { externalPaymentStatus: true, failureReason: true, confirmedAt: true },
      },
    },
  });

  if (!sale || sale.chargeMode !== "QR_PAY") notFound();

  const grandTotal = Number(sale.grandTotal.toString());
  const payStatus = sale.payments[0]?.externalPaymentStatus ?? "PENDING";
  const failureReason = sale.payments[0]?.failureReason ?? null;
  const isDev = process.env.NODE_ENV !== "production";

  return (
    <div className="min-h-screen flex items-center justify-center bg-stone-50 px-4 py-10">
      <div className="w-full max-w-md bg-white rounded-2xl shadow-elevated p-8">
        <div className="text-xs uppercase tracking-[0.2em] text-stone-500 text-center">
          {sale.club.name}
        </div>
        <h1 className="mt-2 font-serif text-3xl text-club-ink text-center">
          {sale.location.name}
        </h1>
        <p className="mt-1 text-sm text-stone-500 text-center">{formatDateTime(sale.saleDate)}</p>

        <div className="mt-8 text-center">
          <div className="text-xs uppercase tracking-wide text-stone-500">Amount due</div>
          <div className="mt-2 font-serif text-5xl text-club-ink tabular-nums">
            {formatCurrency(grandTotal)}
          </div>
          <div className="mt-1 text-xs text-stone-500 font-mono">Sale {sale.saleNumber}</div>
        </div>

        {/* Lifecycle banner */}
        <PaymentStateBanner status={payStatus} failureReason={failureReason} />

        {/* Real payment integration would mount here. For now we hand
            this to the dev simulator below in non-production builds.
            In production, this button stays disabled until a
            processor is configured for the club. */}
        {payStatus === "PENDING" && !isDev && (
          <div className="mt-8 space-y-3">
            <button
              type="button"
              disabled
              className="btn btn-primary w-full opacity-60 cursor-not-allowed"
            >
              Tap to Pay (Apple / Google Pay)
            </button>
            <p className="text-[11px] text-stone-500 text-center">
              Payment integration is configured per club. Once enabled, this
              button opens your phone&rsquo;s native payment sheet.
            </p>
          </div>
        )}

        {/* Dev-only simulator. Lets the operator (or test author)
            walk a check through the full lifecycle without a real
            gateway. Hidden when NODE_ENV === "production". */}
        {isDev && payStatus === "PENDING" && (
          <QrPayDevControls saleId={sale.id} />
        )}

        <p className="mt-8 text-[11px] text-stone-400 text-center">
          Need help? Speak with your server in the lounge.
        </p>
      </div>
    </div>
  );
}

function PaymentStateBanner({ status, failureReason }: { status: string; failureReason: string | null }) {
  if (status === "CONFIRMED") {
    return (
      <div className="mt-6 rounded-md border border-club-green-300 bg-club-green-50 px-4 py-3 text-center">
        <div className="text-xs uppercase tracking-wide text-club-green-700">Payment confirmed</div>
        <div className="mt-1 text-sm text-club-green-800">Thank you — your receipt has been emailed.</div>
      </div>
    );
  }
  if (status === "DECLINED" || status === "EXPIRED") {
    return (
      <div className="mt-6 rounded-md border border-red-300 bg-red-50 px-4 py-3 text-center">
        <div className="text-xs uppercase tracking-wide text-red-700">
          {status === "EXPIRED" ? "Payment expired" : "Payment declined"}
        </div>
        <div className="mt-1 text-sm text-red-800">
          {failureReason ?? "Please speak with your server."}
        </div>
      </div>
    );
  }
  // PENDING — quiet message; the Tap to Pay button or dev controls
  // sit below.
  return (
    <div className="mt-6 rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-center">
      <div className="text-xs uppercase tracking-wide text-amber-700">Awaiting payment</div>
      <div className="mt-1 text-sm text-amber-900">Pay below — your server will see the confirmation immediately.</div>
    </div>
  );
}
