import { cn } from "@/lib/ui";

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded-md bg-stone-200/70", className)} />;
}

export function SkeletonRow() {
  return (
    <div className="flex items-center gap-4">
      <Skeleton className="h-4 w-32" />
      <Skeleton className="h-4 w-48" />
      <Skeleton className="h-4 w-24 ml-auto" />
    </div>
  );
}

export function SkeletonCard() {
  return (
    <div className="card card-body space-y-3">
      <Skeleton className="h-3 w-24" />
      <Skeleton className="h-8 w-40" />
      <Skeleton className="h-3 w-32" />
    </div>
  );
}
