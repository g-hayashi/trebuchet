import { Link } from "@tanstack/react-router";
import { buttonVariants } from "@/components/ui/button";
import { useCurrentPeriod } from "@/features/periods/current";

const linkClass = buttonVariants({ variant: "outline" });

/**
 * 取込の画面の上に置く入口（011 FR-051）。期首残高（freee の元帳から作る）と、元帳との照合へ 1 回で届く。
 * 期首残高は、今日を含む（なければ最新の）会計期間の年度の画面へ。会計期間がまだなければ会計期間の画面へ
 */
export function LedgerShortcuts({ entityId }: { entityId: string }) {
  const { period } = useCurrentPeriod(entityId);

  return (
    <nav aria-label="期首残高と照合" className="flex flex-wrap items-center gap-3">
      {period ? (
        <Link
          to="/e/$entityId/periods/$year/opening-balances"
          params={{ entityId, year: String(period.fiscalYear) }}
          className={linkClass}
        >
          期首残高（元帳から作る）
        </Link>
      ) : (
        <Link to="/e/$entityId/periods" params={{ entityId }} className={linkClass}>
          期首残高（元帳から作る）
        </Link>
      )}
      <Link to="/e/$entityId/imports/reconcile" params={{ entityId }} className={linkClass}>
        元帳と照合
      </Link>
    </nav>
  );
}
