import { Link } from "@tanstack/react-router";
import type { Warning } from "@trebuchet/schema";
import type { ReactNode } from "react";
import { ApiErrorMessage } from "@/components/ui/form-error";
import type { DateRange } from "./periods";
import { WarningsBanner } from "./WarningsBanner";

const tabProps = {
  activeProps: { className: "font-semibold underline", "aria-current": "page" as const },
};

/** 帳票の切替。表示中の期間を引き継ぐ（貸借対照表には終了日を基準日として渡す） */
function ReportTabs({ entityId, range }: { entityId: string; range: DateRange | undefined }) {
  const params = { entityId };
  const search = range ? { from: range.from, to: range.to } : {};
  return (
    <nav aria-label="帳票" className="flex flex-wrap gap-4 text-sm">
      <Link to="/e/$entityId/reports/trial-balance" params={params} search={search} {...tabProps}>
        残高試算表
      </Link>
      <Link to="/e/$entityId/reports/profit-and-loss" params={params} search={search} {...tabProps}>
        損益計算書
      </Link>
      <Link
        to="/e/$entityId/reports/balance-sheet"
        params={params}
        search={range ? { asOf: range.to } : {}}
        {...tabProps}
      >
        貸借対照表
      </Link>
      <Link to="/e/$entityId/reports/general-ledger" params={params} search={search} {...tabProps}>
        総勘定元帳
      </Link>
      <Link to="/e/$entityId/reports/journal-book" params={params} search={search} {...tabProps}>
        仕訳帳
      </Link>
    </nav>
  );
}

/** 帳票の画面の共通の枠（切替・見出し・条件・CSV・エラー・警告） */
export function ReportPage({
  entityId,
  title,
  range,
  controls,
  actions,
  error,
  warnings,
  children,
}: {
  entityId: string;
  title: string;
  range: DateRange | undefined;
  controls?: ReactNode;
  actions?: ReactNode;
  error: unknown;
  warnings: readonly Warning[] | undefined;
  children?: ReactNode;
}) {
  return (
    <main className="grid gap-4">
      <ReportTabs entityId={entityId} range={range} />
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-xl font-semibold">{title}</h1>
        {actions}
      </div>
      {controls}
      <ApiErrorMessage error={error} />
      <WarningsBanner warnings={warnings ?? []} />
      {children}
    </main>
  );
}

/** 貸借の一致の表示 */
export function BalancedBadge({ balanced }: { balanced: boolean }) {
  return balanced ? (
    <p className="text-sm text-muted-foreground">貸借一致</p>
  ) : (
    <p className="text-sm font-medium text-destructive">貸借が一致していません</p>
  );
}
