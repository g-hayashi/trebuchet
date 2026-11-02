import { Link } from "@tanstack/react-router";
import type { BlueReturnWarning } from "@trebuchet/schema";
import { formatSignedYen } from "@/lib/format";

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

/** 一覧の key。同じ文面でも科目（details.accountId）が違えば別の警告にする */
function warningKey(w: BlueReturnWarning): string {
  const accountId = w.details?.accountId;
  return typeof accountId === "string"
    ? `${w.code}-${accountId}-${w.message}`
    : `${w.code}-${w.message}`;
}

/** 家事按分・地代家賃の内訳の画面へのリンク（警告から直す先） */
function HomeUseLink({ entityId, year, label }: { entityId: string; year: string; label: string }) {
  return (
    <Link
      to="/e/$entityId/blue-return/$year/home-use"
      params={{ entityId, year }}
      className="mt-1 block underline"
    >
      {label}
    </Link>
  );
}

/**
 * 決算書の警告の一覧。決算書は表示したまま知らせる。
 * 任意科目が欄に載らないとき（OPTIONAL_LINES_OVERFLOW。1ページ・4ページとも）は、載らなかった科目名と金額、
 * 科目の画面へのリンクを出す。期首の食い違い（OPENING_MISMATCH）は、登録した差の説明を警告の横に出す
 * （そのほかの警告は message のまま）
 */
export function WarningList({
  entityId,
  year,
  warnings,
}: {
  entityId: string;
  year: string;
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
            <li key={warningKey(w)} className="list-disc">
              {w.message}
              {omitted.length > 0 && (
                <>
                  <ul aria-label="欄に載らなかった科目" className="mt-1 list-none pl-3">
                    {omitted.map((o) => (
                      <li key={o.accountId}>
                        {o.name} {formatSignedYen(o.amount)} 円
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
              {w.code === "OPENING_MISMATCH" && typeof w.details?.note === "string" && (
                <span className="mt-1 block whitespace-pre-wrap">説明: {w.details.note}</span>
              )}
              {w.code === "HOME_USE_ADJUSTMENT_STALE" && (
                <HomeUseLink entityId={entityId} year={year} label="仕訳の案を見る" />
              )}
              {(w.code === "DEPRECIATION_MISMATCH" ||
                w.code === "ASSET_REGISTER_MISMATCH" ||
                w.code === "DEPRECIATION_PARAMETER_MISSING") && (
                <Link
                  to="/e/$entityId/fixed-assets"
                  params={{ entityId }}
                  search={{ year: Number(year) }}
                  className="mt-1 block underline"
                >
                  固定資産台帳を開く
                </Link>
              )}
              {w.code === "RENT_DETAILS_MISMATCH" && (
                <HomeUseLink entityId={entityId} year={year} label="地代家賃の内訳を直す" />
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
