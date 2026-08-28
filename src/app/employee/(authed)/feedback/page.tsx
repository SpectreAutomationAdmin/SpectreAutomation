// HR-2C Anonymous Feedback — employee submit page (2026-08-27).
//
// Simple two-field form: category (optional dropdown) + message.
// Submit lands on `/api/anonymous-feedback` which derives clubId
// from the employee session and drops the employee identity before
// persisting. See src/lib/anonymous-feedback.ts for the storage
// contract.

import { redirect } from "next/navigation";
import { getEmployeePortalPrincipal } from "@/lib/employee-portal-session";
import FeedbackForm from "./FeedbackForm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function EmployeeFeedbackPage() {
  const principal = await getEmployeePortalPrincipal();
  if (!principal) redirect("/employee/login");

  return (
    <div className="max-w-2xl mx-auto px-4 md:px-8 py-8" data-testid="employee-feedback-page">
      <header className="pb-4">
        <h1 className="font-serif text-[24px] text-club-ink">Share anonymous feedback</h1>
        <p className="text-[13.5px] text-stone-600 mt-2 leading-relaxed">
          Your feedback goes to the Club. The application does not attach your name, email, or
          employee number to the submission — only which Club it belongs to. Keep your message
          professional and specific.
        </p>
      </header>
      <FeedbackForm />
    </div>
  );
}
