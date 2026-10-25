import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { journalOriginQuery } from "./api";

const linkClass = "text-primary underline underline-offset-4";

/**
 * 仕訳の出所（FR-009、FR-028。`GET /journals/:id/origin`）。請求書・入金の消し込み・定期仕訳から作られた仕訳に、
 * 元の請求書へのリンクなどを出す。出所がなければ（手入力の仕訳など）、読めなくても何も出さない
 */
export function JournalOrigin({ entityId, journalId }: { entityId: string; journalId: string }) {
  const { data: origin } = useQuery(journalOriginQuery(entityId, journalId));
  if (!origin) return null;

  switch (origin.kind) {
    case "invoice":
    case "payment":
      return (
        <p className="text-sm">
          この仕訳は{" "}
          <Link
            to="/e/$entityId/invoices/$invoiceId"
            params={{ entityId, invoiceId: origin.invoiceId }}
            className={linkClass}
          >
            {`請求書 ${origin.invoiceNo}`}
          </Link>{" "}
          {origin.kind === "invoice" ? "の売上の仕訳です。" : "の入金の消し込みの仕訳です。"}
        </p>
      );
    case "recurring":
      // 定期仕訳の画面は US3 で足す。それまでは名前と対象月だけを示す
      return (
        <p className="text-sm">
          {`この仕訳は定期仕訳「${origin.name}」（${origin.targetMonth}）から自動で登録されました。`}
        </p>
      );
  }
}
