import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";

export default async function ConfirmationPage({
  params,
  searchParams,
}: {
  params: { clubSlug: string };
  searchParams: { ref?: string };
}) {
  const club = await prisma.club.findUnique({ where: { slug: params.clubSlug } });
  if (!club) notFound();

  const applicant = searchParams.ref
    ? await prisma.applicant.findUnique({ where: { id: searchParams.ref } })
    : null;

  return (
    <main className="min-h-screen bg-club-cream">
      <section className="max-w-2xl mx-auto px-8 py-24 text-center">
        <div className="inline-flex h-14 w-14 items-center justify-center rounded-full bg-club-green-700 text-white text-2xl mx-auto">✓</div>
        <h1 className="mt-6 page-title">Thank you{applicant ? `, ${applicant.firstName}` : ""}.</h1>
        <p className="mt-4 text-stone-600">
          Your application to <strong>{club.name}</strong> has been received. A member of our committee will be in touch shortly.
        </p>
        <div className="mt-8">
          <Link href="/" className="btn btn-secondary">Return to home</Link>
        </div>
      </section>
    </main>
  );
}
