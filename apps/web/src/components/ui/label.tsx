import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

export function Label({ className, ...props }: ComponentProps<"label">) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: htmlFor は呼び出し側で指定する
    <label
      data-slot="label"
      className={cn("flex items-center gap-2 text-sm font-medium leading-none", className)}
      {...props}
    />
  );
}
