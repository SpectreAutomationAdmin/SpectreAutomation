import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";

// Shared chrome for the multi-step apply flow. Step indicator lives inside
// each page since the active step varies.
export default async function ApplyTokenLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: { clubSlug: string; token: string };
}) {
  const club = await prisma.club.findUnique({ where: { slug: params.clubSlug } });
  if (!club) notFound();
  return (
    <main className="min-h-screen bg-club-cream">
      <header className="px-8 py-6 border-b border-stone-200 bg-white">
        <div className="max-w-4xl mx-auto flex items-center justify-between">
          <Link href="/" className="text-xs uppercase tracking-[0.3em] text-club-green-700">Spectre</Link>
          <div className="text-sm text-stone-500">{club.name}</div>
        </div>
      </header>
      <section className="max-w-3xl mx-auto px-8 py-12">{children}</section>
    </main>
  );
}
