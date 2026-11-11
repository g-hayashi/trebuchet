import type { Warning } from "@trebuchet/schema";

/** 帳票の警告（FR-033）。マイナス残高・期首残高の未登録など。帳票は表示したまま知らせる */
export function WarningsBanner({ warnings }: { warnings: readonly Warning[] }) {
  if (warnings.length === 0) return null;
  return (
    <section
      aria-label="警告"
      className="rounded-md border border-amber-500/60 bg-amber-50 px-3 py-2 text-sm text-amber-900"
    >
      <ul className="list-disc pl-5">
        {warnings.map((w) => (
          <li key={`${w.code}-${w.message}`}>{w.message}</li>
        ))}
      </ul>
    </section>
  );
}
