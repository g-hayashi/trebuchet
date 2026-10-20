import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ApiErrorMessage } from "@/components/ui/form-error";
import { AdjustmentPanel } from "@/features/blue-return/AdjustmentPanel";
import { adjustmentsQuery, homeUseQuery, rentDetailsQuery } from "@/features/blue-return/api";
import { HomeUseForm } from "@/features/blue-return/HomeUseForm";
import { RentDetailsTable } from "@/features/blue-return/RentDetailsTable";
import { accountsQuery } from "@/lib/queries";

export const Route = createFileRoute("/e/$entityId/blue-return/$year/home-use")({
  component: HomeUsePage,
});

/** 家事按分の登録、決算整理の仕訳の案、地代家賃の内訳（US2、FR-012〜017） */
function HomeUsePage() {
  const { entityId, year } = Route.useParams();
  const homeUse = useQuery(homeUseQuery(entityId, year));
  const rent = useQuery(rentDetailsQuery(entityId, year));
  const adjustments = useQuery(adjustmentsQuery(entityId, year));
  const { data: accounts } = useQuery(accountsQuery(entityId));
  const error = homeUse.error ?? rent.error ?? adjustments.error;
  const loading = homeUse.isPending || rent.isPending || adjustments.isPending;

  return (
    <main className="grid gap-6">
      <Link
        to="/e/$entityId/blue-return/$year"
        params={{ entityId, year }}
        className="text-sm underline"
      >
        決算書に戻る
      </Link>
      <h1 className="text-xl font-semibold">家事按分・地代家賃の内訳（{year}年分）</h1>
      <ApiErrorMessage error={error} />
      {loading && !error && <p className="text-sm text-muted-foreground">読み込み中…</p>}
      {homeUse.data && (
        <HomeUseForm
          entityId={entityId}
          year={year}
          allocations={homeUse.data.allocations}
          previousYear={homeUse.data.previousYear}
        />
      )}
      {homeUse.data && adjustments.data && accounts && (
        <AdjustmentPanel
          entityId={entityId}
          year={year}
          proposals={adjustments.data}
          accounts={accounts}
          allocations={homeUse.data.allocations}
        />
      )}
      {rent.data && (
        <RentDetailsTable
          // 保存した内訳が読み込まれたら入力欄を作り直す
          key={JSON.stringify(rent.data)}
          entityId={entityId}
          year={year}
          rows={rent.data}
        />
      )}
    </main>
  );
}
