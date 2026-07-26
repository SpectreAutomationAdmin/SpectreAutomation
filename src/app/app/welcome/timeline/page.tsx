import Link from "next/link";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { formatDate } from "@/lib/finance";

// Welcome flow: timeline. Reached:
//   1. After an admin approves+funds a member (redirect with ?welcomeMember=id)
//   2. When a freshly approved member signs in for the first time (TODO: link from member hub)
export default async function WelcomeTimelinePage({ searchParams }: { searchParams: { welcomeMember?: string } }) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  let memberId = searchParams.welcomeMember ?? user.memberId ?? null;

  if (!memberId) {
    const fallback = await prisma.member.findFirst({
      where: { clubId: user.clubId ?? undefined, status: "ONBOARDING" },
      orderBy: { createdAt: "desc" },
    });
    memberId = fallback?.id ?? null;
  }
  if (!memberId) redirect(user.role === "MEMBER" ? "/app/member" : "/app/admin");

  const member = await prisma.member.findUnique({
    where: { id: memberId },
    include: { club: { include: { milestones: { orderBy: { sortOrder: "asc" } } } } },
  });
  if (!member || !member.club) redirect("/app/admin");

  return (
    <div className="text-white">
      <div className="max-w-4xl mx-auto px-8 py-16">
        <div className="text-xs uppercase tracking-[0.4em] text-club-green-200">A welcome from</div>
        <h1 className="mt-3 font-serif text-5xl">{member.club.name}</h1>
        <p className="mt-4 text-club-green-100 max-w-2xl">
          Take a moment to walk through the story of our club. Many hands and many years have shaped what you&rsquo;re joining today.
        </p>

        <ol className="relative mt-14 border-l border-club-green-700/60 pl-8 space-y-10">
          {member.club.milestones.map((m, idx) => (
            <li
              key={m.id}
              className="relative animate-fadeup"
              style={{ animationDelay: `${idx * 120}ms` }}
            >
              <span className="absolute -left-[37px] top-1 h-3 w-3 rounded-full bg-club-gold ring-4 ring-club-green-900" />
              <div className="text-xs uppercase tracking-widest text-club-green-300">{m.year}</div>
              <h3 className="mt-1 font-serif text-2xl">{m.title}</h3>
              <p className="mt-2 text-club-green-100 leading-relaxed">{m.description}</p>
            </li>
          ))}

          <li className="relative animate-fadeup" style={{ animationDelay: `${member.club.milestones.length * 120}ms` }}>
            <span className="absolute -left-[37px] top-1 h-3 w-3 rounded-full bg-white ring-4 ring-club-green-900" />
            <div className="text-xs uppercase tracking-widest text-club-green-200">{formatDate(member.joinDate ?? new Date())}</div>
            <h3 className="mt-1 font-serif text-3xl text-white">
              {member.firstName} {member.lastName} became a member of {member.club.name}.
            </h3>
            <p className="mt-3 text-club-green-100 italic">Welcome to the next chapter.</p>
          </li>
        </ol>

        <div className="mt-14 flex justify-center">
          <Link
            href={`/app/welcome/preferences?welcomeMember=${member.id}`}
            className="rounded-full bg-club-gold text-club-ink font-medium px-8 py-3 hover:bg-amber-300"
          >
            Continue to your Member Hub →
          </Link>
        </div>
      </div>

      <style>{`
        @keyframes fadeup { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: none; } }
        .animate-fadeup { opacity: 0; animation: fadeup 700ms ease forwards; }
      `}</style>
    </div>
  );
}
