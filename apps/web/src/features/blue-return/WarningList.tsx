import { Link } from "@tanstack/react-router";
import type { BlueReturnWarning } from "@trebuchet/schema";
import { formatYen } from "@/lib/format";

type Omitted = { accountId: string; name: string; amount: number };

/** details.omitted を、形の合うものだけ取り出す（details は型のない record） */
function omittedOf(details: BlueReturnWarning["details"]): Omitted[] {
  const raw = details?.omitted;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((o: unknown) => {
    if (typeof o !== "object" || o === null) return [];
    const { accountId, name, amount } = o as Record<string, unknown>;
    return typeof accountId === "string" && typeof name === "string" && typeof amount === "number"
      ? [{ accountId, name, amount }]
      : [];
  });
}

/**
 * 決算書の警告の一覧。決算書は表示したまま知らせる。
 * 任意科目が欄に載らないとき（OPTIONAL_LINES_OVERFLOW）は、載らなかった科目名と金額、科目の画面へのリンクを出す
 */
export function WarningList({
  entityId,
  warnings,
}: {
  entityId: string;
  warnings: readonly BlueReturnWarning[];
}) {
  if (warnings.length === 0) return null;
  return (
    <section
      aria-label="警告"
      className="no-print rounded-md border border-amber-500/60 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100"
    >
      <ul className="grid gap-2 pl-5">
        {warnings.map((w) => {
          const omitted = w.code === "OPTIONAL_LINES_OVERFLOW" ? omittedOf(w.details) : [];
          return (
            <li key={`${w.code}-${w.message}`} className="list-disc">
              {w.message}
              {omitted.length > 0 && (
                <>
                  <ul aria-label="欄に載らなかった科目" className="mt-1 list-none pl-3">
                    {omitted.map((o) => (
                      <li key={o.accountId}>
                        {o.name} {formatYen(o.amount)} 円
                      </li>
                    ))}
                  </ul>
                  <Link
                    to="/e/$entityId/accounts"
                    params={{ entityId }}
                    className="mt-1 inline-block underline"
                  >
                    科目の画面で決算書の欄を変更する
                  </Link>
                </>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
