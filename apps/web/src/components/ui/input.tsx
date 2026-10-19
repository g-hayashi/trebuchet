import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

const fieldClass =
  "flex h-9 w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none transition-[color,box-shadow] placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20";

export function Input({ className, type = "text", ...props }: ComponentProps<"input">) {
  return <input data-slot="input" type={type} className={cn(fieldClass, className)} {...props} />;
}

/** ネイティブの <select>（Radix の Select より軽く、React Hook Form の register がそのまま使える） */
export function NativeSelect({ className, ...props }: ComponentProps<"select">) {
  return <select data-slot="select" className={cn(fieldClass, "pr-8", className)} {...props} />;
}
