import Link from "next/link";
import { cn } from "@/lib/ui";

export function StatCard({
  title,
  value,
  subtitle,
  href,
  tone = "default",
}: {
  title: string;
  value: string | number;
  subtitle?: string;
  href?: string;
  tone?: "default" | "warning" | "danger" | "success";
}) {
  const accent =
    tone === "warning"
      ? "border-l-amber-400"
      : tone === "danger"
        ? "border-l-red-500"
        : tone === "success"
          ? "border-l-club-green-500"
          : "border-l-stone-300";

  const inner = (
    <div className={cn("card card-body border-l-4", accent, href && "hover:shadow-elevated transition-shadow")}>
      <div className="card-title">{title}</div>
      <div className="stat-number">{value}</div>
      {subtitle && <div className="mt-1 text-sm text-stone-500">{subtitle}</div>}
    </div>
  );

  return href ? <Link href={href}>{inner}</Link> : inner;
}
