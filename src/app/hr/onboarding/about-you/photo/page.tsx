// HR-2B.2 (2026-08-18) — About You · Employee photo.

import { redirect } from "next/navigation";
import Link from "next/link";
import { resolveEmployeeOnboardingActor } from "@/lib/hr/employee-actor";
import { prisma } from "@/lib/prisma";
import { uploadPhotoAction } from "../_actions";
import PhotoUploadFields from "./PhotoUploadFields";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function PhotoStep() {
  const actor = await resolveEmployeeOnboardingActor();
  if (!actor) redirect("/hr/onboarding/expired");

  const employee = await prisma.employee.findFirst({
    where: { id: actor.employeeId, clubId: actor.clubId },
    select: {
      profilePhotoDocumentId: true,
      profilePhoto: {
        select: { mimeType: true, sizeBytes: true, uploadedAt: true },
      },
    },
  });
  if (!employee) redirect("/hr/onboarding/expired");

  const hasPhoto = Boolean(employee.profilePhotoDocumentId);

  return (
    <article className="rounded-lg border border-stone-200 bg-white px-6 py-8 md:px-10 md:py-10">
      <h2 className="font-serif text-2xl leading-tight text-stone-900">
        Add a photo of yourself.
      </h2>
      <p className="mt-2 text-sm text-stone-500 leading-relaxed">
        A clear shoulders-up photo works best. It doesn't need to be formal —
        this helps your teammates recognise you in your first week.
      </p>

      {hasPhoto && (
        <div className="mt-6 rounded-md border border-emerald-100 bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
          You've already uploaded a photo
          {employee.profilePhoto?.uploadedAt
            ? ` on ${formatDate(employee.profilePhoto.uploadedAt)}`
            : ""}
          . Upload a new one to replace it, or continue to the next step.
        </div>
      )}

      <form
        action={uploadPhotoAction}
        encType="multipart/form-data"
        className="mt-8 space-y-6"
        noValidate
      >
        <PhotoUploadFields />

        <div className="flex items-center justify-between pt-2">
          <Link
            href="/hr/onboarding/about-you/employment"
            className="text-sm text-stone-500 hover:text-stone-800"
          >
            ← Back
          </Link>
          <div className="flex items-center gap-3">
            {hasPhoto && (
              <Link
                href="/hr/onboarding/about-you/complete"
                className="rounded-md border border-stone-300 px-4 py-2 text-sm text-stone-700 hover:border-stone-400"
              >
                Skip
              </Link>
            )}
            <button
              type="submit"
              className="rounded-md bg-emerald-800 px-5 py-2.5 text-sm font-medium text-white hover:bg-emerald-900 focus:outline-none focus:ring-2 focus:ring-emerald-700 focus:ring-offset-2"
            >
              {hasPhoto ? "Replace and continue" : "Upload and continue"}
            </button>
          </div>
        </div>
      </form>
    </article>
  );
}

function formatDate(d: Date): string {
  return d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}
