// Hospitality analytics landing. Forwards straight to prep-times for
// now since that's the only slice that ships in this phase.

import { redirect } from "next/navigation";

export default function HospitalityAnalyticsLanding() {
  redirect("/app/admin/analytics/hospitality/prep-times");
}
