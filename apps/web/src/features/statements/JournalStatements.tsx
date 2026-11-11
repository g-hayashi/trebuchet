import { Link } from "@tanstack/react-router";
import type { StatementLinkKind } from "@trebuchet/schema";
import { linkClass } from "@/lib/styles";

const KIND_TEXT: Record<StatementLinkKind, string> = {
  created: "明細から登録した仕訳です。",
  matched: "既存の仕訳に結びつけた明細があります。",
};

/**
 * 仕訳の詳細の「元の明細」（006 FR-020。`GET /journals/:id` の `statements`）。
 * 明細の一覧が、その明細に印を付けて開く。結びついた明細がなければ何も出さない
 */
export function JournalStatements({
  entityId,
  statements,
}: {
  entityId: string;
  statements: { statementId: string; kind: StatementLinkKind }[];
}) {
  if (statements.length === 0) return null;
  return (
    <ul aria-label="元の明細" className="grid gap-1 text-sm">
      {statements.map((s) => (
        <li key={s.statementId}>
          {KIND_TEXT[s.kind]}{" "}
          <Link
            to="/e/$entityId/statements"
            params={{ entityId }}
            search={{ statementId: s.statementId }}
            className={linkClass}
          >
            元の明細を開く
          </Link>
        </li>
      ))}
    </ul>
  );
}
