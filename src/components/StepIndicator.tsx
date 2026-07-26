import { cn } from "@/lib/ui";

export function StepIndicator({ steps, current }: { steps: string[]; current: number }) {
  return (
    <ol className="flex items-center gap-3">
      {steps.map((s, i) => {
        const done = i < current;
        const active = i === current;
        return (
          <li key={s} className="flex items-center gap-3">
            <div
              className={cn(
                "h-7 w-7 rounded-full text-xs font-medium flex items-center justify-center",
                done && "bg-club-green-700 text-white",
                active && "bg-club-ink text-white",
                !done && !active && "bg-stone-200 text-stone-600"
              )}
            >
              {done ? "✓" : i + 1}
            </div>
            <span className={cn("text-sm", active ? "text-club-ink font-medium" : "text-stone-500")}>{s}</span>
            {i < steps.length - 1 && <span className="text-stone-300">›</span>}
          </li>
        );
      })}
    </ol>
  );
}
