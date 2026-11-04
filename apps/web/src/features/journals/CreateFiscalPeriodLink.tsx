import { Link } from "@tanstack/react-router";

/** 会計期間の外の日付で登録できなかったとき（`suggest: create_fiscal_period`）に、日付の欄の下へ出す導線 */
export function CreateFiscalPeriodLink({ entityId }: { entityId: string }) {
  return (
    <Link
      to="/e/$entityId/periods"
      params={{ entityId }}
      className="text-sm text-primary underline underline-offset-4"
    >
      会計期間を作成する
    </Link>
  );
}
