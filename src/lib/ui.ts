import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// Status badge color maps. Keeping this centralized so a single change
// updates every status pill across the app.
export const statusStyles: Record<string, string> = {
  // applications
  SUBMITTED: "bg-blue-50 text-blue-700 ring-blue-200",
  UNDER_REVIEW: "bg-amber-50 text-amber-800 ring-amber-200",
  PENDING_INFORMATION: "bg-amber-50 text-amber-800 ring-amber-200",
  APPROVED: "bg-club-green-50 text-club-green-700 ring-club-green-200",
  DENIED: "bg-red-50 text-red-700 ring-red-200",
  WAITLISTED: "bg-purple-50 text-purple-700 ring-purple-200",
  WITHDRAWN: "bg-stone-100 text-stone-500 ring-stone-200",
  DRAFT: "bg-stone-100 text-stone-700 ring-stone-200",

  // member status
  ONBOARDING: "bg-amber-50 text-amber-800 ring-amber-200",
  ACTIVE: "bg-club-green-50 text-club-green-700 ring-club-green-200",
  SUSPENDED: "bg-red-50 text-red-700 ring-red-200",
  INACTIVE: "bg-stone-100 text-stone-700 ring-stone-200",
  WAITLIST: "bg-purple-50 text-purple-700 ring-purple-200",

  // access
  FULL_ACCESS: "bg-club-green-50 text-club-green-700 ring-club-green-200",
  CHARGE_ACCOUNT_SUSPENDED: "bg-amber-50 text-amber-800 ring-amber-200",
  TEE_SHEET_SUSPENDED: "bg-amber-50 text-amber-800 ring-amber-200",
  FULL_SUSPENSION: "bg-red-50 text-red-700 ring-red-200",

  // payments
  SUCCESS: "bg-club-green-50 text-club-green-700 ring-club-green-200",
  FAILED: "bg-red-50 text-red-700 ring-red-200",
  PENDING: "bg-amber-50 text-amber-800 ring-amber-200",

  // notices
  SENT: "bg-blue-50 text-blue-700 ring-blue-200",
  ACKNOWLEDGED: "bg-purple-50 text-purple-700 ring-purple-200",
  RESOLVED: "bg-club-green-50 text-club-green-700 ring-club-green-200",

  // financing
  PAID: "bg-club-green-50 text-club-green-700 ring-club-green-200",
  PAID_OFF: "bg-club-green-50 text-club-green-700 ring-club-green-200",
  DEFAULTED: "bg-red-50 text-red-700 ring-red-200",
  SCHEDULED: "bg-stone-100 text-stone-700 ring-stone-200",
  MISSED: "bg-red-50 text-red-700 ring-red-200",

  // payment method
  EXPIRED: "bg-amber-50 text-amber-800 ring-amber-200",
  REMOVED: "bg-stone-100 text-stone-700 ring-stone-200",

  // events
  PUBLISHED: "bg-club-green-50 text-club-green-700 ring-club-green-200",
  CANCELLED: "bg-red-50 text-red-700 ring-red-200",
  CLOSED: "bg-stone-100 text-stone-700 ring-stone-200",
  REGISTERED: "bg-club-green-50 text-club-green-700 ring-club-green-200",

  // payment method status
  NONE: "bg-red-50 text-red-700 ring-red-200",
  PRIMARY_ON_FILE: "bg-amber-50 text-amber-800 ring-amber-200",
  PRIMARY_AND_BACKUP: "bg-club-green-50 text-club-green-700 ring-club-green-200",

  // periods / journals (CLOSED + APPROVED already defined above)
  OPEN: "bg-club-green-50 text-club-green-700 ring-club-green-200",
  SOFT_LOCKED: "bg-amber-50 text-amber-700 ring-amber-200",
  HARD_LOCKED: "bg-red-50 text-red-700 ring-red-200",
  POSTED: "bg-club-green-50 text-club-green-700 ring-club-green-200",
  VOIDED: "bg-stone-100 text-stone-500 ring-stone-200",
  REVERSED: "bg-purple-50 text-purple-700 ring-purple-200",
};

export function statusClass(status: string): string {
  return statusStyles[status] ?? "bg-stone-100 text-stone-700 ring-stone-200";
}
