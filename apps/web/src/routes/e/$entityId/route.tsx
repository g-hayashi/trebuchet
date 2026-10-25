import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, Outlet } from "@tanstack/react-router";
import { entitiesQuery } from "@/features/entities/api";
import { RecurringNotice } from "@/features/recurring/RecurringNotice";
import { thisYear } from "@/lib/dates";

export const Route = createFileRoute("/e/$entityId")({
  component: EntityLayout,
});

type NavTo =
  | "/e/$entityId"
  | "/e/$entityId/journals"
  | "/e/$entityId/accounts"
  | "/e/$entityId/partners"
  | "/e/$entityId/tags"
  | "/e/$entityId/tax-settings"
  | "/e/$entityId/periods"
  | "/e/$entityId/reports"
  | "/e/$entityId/blue-return"
  | "/e/$entityId/fixed-assets"
  | "/e/$entityId/tax-return/$year"
  | "/e/$entityId/imports"
  | "/e/$entityId/invoices"
  | "/e/$entityId/recurring";

/** 事業体ごとの画面の共通レイアウト。ナビの項目は各画面を追加するときに足す（US1〜US5） */
const NAV: { label: string; to: NavTo }[] = [
  { label: "ホーム", to: "/e/$entityId" },
  { label: "仕訳", to: "/e/$entityId/journals" },
  { label: "勘定科目", to: "/e/$entityId/accounts" },
  { label: "取引先", to: "/e/$entityId/partners" },
  { label: "タグ", to: "/e/$entityId/tags" },
  { label: "消費税", to: "/e/$entityId/tax-settings" },
  { label: "会計期間", to: "/e/$entityId/periods" },
  { label: "帳票", to: "/e/$entityId/reports" },
  { label: "決算書", to: "/e/$entityId/blue-return" },
  { label: "固定資産台帳", to: "/e/$entityId/fixed-assets" },
  { label: "申告の控え", to: "/e/$entityId/tax-return/$year" },
  { label: "取込", to: "/e/$entityId/imports" },
  // 請求書の一覧から、工数・請求書の作成・設定へ進む
  { label: "請求", to: "/e/$entityId/invoices" },
  { label: "定期仕訳", to: "/e/$entityId/recurring" },
];

function EntityLayout() {
  const { entityId } = Route.useParams();
  const { data: entities } = useQuery(entitiesQuery());
  const entity = entities?.find((e) => e.id === entityId);
  return (
    <div className="mx-auto max-w-6xl px-4 py-4">
      <p className="mb-2 text-sm text-muted-foreground">
        {entity?.name ?? (entities ? "（事業体が見つかりません）" : "読み込み中…")}
      </p>
      <nav
        aria-label="事業体のメニュー"
        className="mb-4 flex flex-wrap gap-4 border-b pb-2 text-sm"
      >
        {NAV.map((item) => (
          <Link
            key={item.label}
            to={item.to}
            // 申告の控えは年分が要る。個人の年分は暦年なので、開くときは今年にする（画面で変えられる）
            params={{ entityId, year: String(thisYear()) }}
            activeOptions={{ exact: item.to === "/e/$entityId" }}
            activeProps={{ className: "font-semibold underline", "aria-current": "page" }}
          >
            {item.label}
          </Link>
        ))}
      </nav>
      {/* 自動で登録した定期仕訳の確認と、登録できなかった回の知らせ（005 FR-027・028） */}
      <RecurringNotice entityId={entityId} />
      <Outlet />
    </div>
  );
}
