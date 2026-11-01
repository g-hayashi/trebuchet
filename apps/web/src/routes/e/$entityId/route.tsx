import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, Outlet, useRouterState } from "@tanstack/react-router";
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
  | "/e/$entityId/recurring"
  | "/e/$entityId/statements"
  | "/e/$entityId/work-hours"
  | "/e/$entityId/invoice-settings";

type NavItem = { label: string; to: NavTo };
type NavGroup = { label: string; items: NavItem[] };

/**
 * 事業体ごとの画面の共通レイアウトの 2 段のメニュー。ラベルとパスはここだけに書く。
 * 1 段目はグループ（押すと最初の項目へ進む）、2 段目は今いるグループの項目。
 * 今いる画面のグループと項目は、項目のパスの接頭辞で決める（請求の工数・設定は invoices の下にないので、項目として持つ）
 */
const NAV: NavGroup[] = [
  { label: "ホーム", items: [{ label: "ホーム", to: "/e/$entityId" }] },
  {
    label: "記帳",
    items: [
      { label: "仕訳", to: "/e/$entityId/journals" },
      // 銀行・カードの明細（006・007）。一覧から、取込・候補の確認と承認・しきい値の設定へ進む
      { label: "明細", to: "/e/$entityId/statements" },
      { label: "定期仕訳", to: "/e/$entityId/recurring" },
    ],
  },
  {
    label: "請求",
    items: [
      { label: "請求書", to: "/e/$entityId/invoices" },
      { label: "工数", to: "/e/$entityId/work-hours" },
      { label: "請求の設定", to: "/e/$entityId/invoice-settings" },
    ],
  },
  { label: "帳票", items: [{ label: "帳票", to: "/e/$entityId/reports" }] },
  {
    label: "決算・申告",
    items: [
      { label: "決算書", to: "/e/$entityId/blue-return" },
      { label: "固定資産台帳", to: "/e/$entityId/fixed-assets" },
      { label: "申告の控え", to: "/e/$entityId/tax-return/$year" },
    ],
  },
  {
    label: "事業体の設定",
    items: [
      { label: "勘定科目", to: "/e/$entityId/accounts" },
      { label: "取引先", to: "/e/$entityId/partners" },
      { label: "タグ", to: "/e/$entityId/tags" },
      { label: "消費税", to: "/e/$entityId/tax-settings" },
      { label: "会計期間", to: "/e/$entityId/periods" },
      { label: "freee から移行", to: "/e/$entityId/imports" },
    ],
  },
];

/** 項目のパス（年分などの末尾のパラメーターは除く）。ホームは完全一致、ほかは区切りで接頭辞が一致するか */
function isItemActive(item: NavItem, entityId: string, pathname: string) {
  const base = `/e/${entityId}`;
  if (item.to === "/e/$entityId") return pathname === base;
  const prefix = item.to.replace("/e/$entityId", base).replace(/\/\$year$/, "");
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

const ACTIVE_CLASS = "font-semibold underline";

function EntityLayout() {
  const { entityId } = Route.useParams();
  const { data: entities } = useQuery(entitiesQuery());
  const entity = entities?.find((e) => e.id === entityId);
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const currentGroup = NAV.find((g) => g.items.some((i) => isItemActive(i, entityId, pathname)));
  // 申告の控えは年分が要る。個人の年分は暦年なので、開くときは今年にする（画面で変えられる）
  const params = { entityId, year: String(thisYear()) };
  return (
    <div className="mx-auto max-w-6xl px-4 py-4">
      <p className="mb-2 text-sm text-muted-foreground">
        {entity?.name ?? (entities ? "（事業体が見つかりません）" : "読み込み中…")}
      </p>
      <nav
        aria-label="事業体のメニュー"
        className={`flex flex-wrap gap-4 border-b pb-2 text-sm ${currentGroup && currentGroup.items.length > 1 ? "" : "mb-4"}`}
      >
        {NAV.map((group) => {
          const first = group.items[0];
          if (!first) return null;
          const active = group === currentGroup;
          return (
            <Link
              key={group.label}
              to={first.to}
              params={params}
              className={active ? ACTIVE_CLASS : undefined}
              aria-current={active ? "page" : undefined}
            >
              {group.label}
            </Link>
          );
        })}
      </nav>
      {currentGroup && currentGroup.items.length > 1 ? (
        <nav
          aria-label="事業体のサブメニュー"
          className="mb-4 flex flex-wrap gap-4 border-b py-2 pl-2 text-sm"
        >
          {currentGroup.items.map((item) => {
            const active = isItemActive(item, entityId, pathname);
            return (
              <Link
                key={item.label}
                to={item.to}
                params={params}
                className={active ? ACTIVE_CLASS : undefined}
                aria-current={active ? "page" : undefined}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
      ) : null}
      {/* 自動で登録した定期仕訳の確認と、登録できなかった回の知らせ（005 FR-027・028） */}
      <RecurringNotice entityId={entityId} />
      <Outlet />
    </div>
  );
}
