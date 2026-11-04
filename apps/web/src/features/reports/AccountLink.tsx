import { Link } from "@tanstack/react-router";

/** 科目名から、同じ期間のその科目の総勘定元帳へ（FR-039） */
export function AccountLink({
  entityId,
  accountId,
  name,
  from,
  to,
}: {
  entityId: string;
  accountId: string;
  name: string;
  from: string;
  to: string;
}) {
  return (
    <Link
      to="/e/$entityId/reports/general-ledger"
      params={{ entityId }}
      search={{ accountId, from, to }}
      activeOptions={{ exact: true }}
      className="underline-offset-4 hover:underline"
    >
      {name}
    </Link>
  );
}
