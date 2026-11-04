import { cn } from "@/lib/utils";

const CIRCLED = ["①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧", "⑨"];

/** 手順の段階（①〜）。今の段階（`current` は 0 始まり）に aria-current="step" をつける */
export function Steps({
  steps,
  current,
  label = "手順",
  className,
}: {
  steps: readonly string[];
  current: number;
  label?: string;
  className?: string;
}) {
  return (
    <ol aria-label={label} className={cn("flex flex-wrap items-center gap-x-4 gap-y-1", className)}>
      {steps.map((step, index) => {
        const isCurrent = index === current;
        return (
          <li
            key={step}
            aria-current={isCurrent ? "step" : undefined}
            className={cn(
              "text-sm",
              isCurrent ? "font-semibold" : "text-muted-foreground",
              index < current && "line-through decoration-muted-foreground/40",
            )}
          >
            <span aria-hidden="true">{CIRCLED[index] ?? index + 1} </span>
            {step}
          </li>
        );
      })}
    </ol>
  );
}
