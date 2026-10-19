import { Link, useParams } from "@tanstack/react-router";

/** 仕訳番号から仕訳の詳細へのリンク（元帳・仕訳帳の行から移る） */
export function JournalLink({ journalId, journalNo }: { journalId: string; journalNo: number }) {
  const { entityId } = useParams({ strict: false });
  if (entityId === undefined) return <>{journalNo}</>;
  return (
    <Link
      to="/e/$entityId/journals/$journalId"
      params={{ entityId, journalId }}
      className="underline underline-offset-2"
    >
      {journalNo}
    </Link>
  );
}
