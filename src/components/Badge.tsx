import { cn, statusClass } from "@/lib/ui";

export function Badge({ status, label, className }: { status: string; label?: string; className?: string }) {
  return (
    <span className={cn("badge", statusClass(status), className)}>
      {label ?? status.replace(/_/g, " ")}
    </span>
  );
}
