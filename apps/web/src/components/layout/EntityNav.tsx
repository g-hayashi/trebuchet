import { Link, useRouterState } from "@tanstack/react-router";

export type NavTo =
  | "/e/$entityId"
  | "/e/$entityId/journals/new"
  | "/e/$entityId/journals"
  | "/e/$entityId/recurring"
  | "/e/$entityId/statements/import"
  | "/e/$entityId/statements"
  | "/e/$entityId/statements/rules"
  | "/e/$entityId/statements/settings"
  | "/e/$entityId/receipts/new"
  | "/e/$entityId/receipts"
  | "/e/$entityId/invoices"
  | "/e/$entityId/work-hours"
  | "/e/$entityId/invoice-settings"
  | "/e/$entityId/reports/profit-and-loss"
  | "/e/$entityId/blue-return"
  | "/e/$entityId/fixed-assets"
  | "/e/$entityId/deferred-assets"
  | "/e/$entityId/settings"
  | "/e/$entityId/accounts"
  | "/e/$entityId/partners"
  | "/e/$entityId/tags"
  | "/e/$entityId/tax-settings"
  | "/e/$entityId/periods";

/**
 * `match`: この項目が「今の画面」になる、事業体の下のパス（区切りでの接頭辞）。省略時は `to` のパス。
 * `""` はホーム（完全一致だけ）。
 * `mobile`: スマホのメニュー（`MobileNav`）に出すときの名前。ないものはスマホのメニューに出さない（FR-059）
 */
type NavItem = { label: string; to: NavTo; match?: readonly string[]; mobile?: string };
type NavGroup = { label: string; items: NavItem[] };

/**
 * 事業体ごとの画面の 2 段のメニュー（research R1、contracts/ui-shell.md §2）。ラベルとパスはここだけに書く。
 * 1 段目はグループ（押すと最初の項目へ進む）、2 段目は今いるグループの項目。
 * 項目が 1 つのグループは作らず、直接のリンクにする（FR-003）
 */
const NAV: NavGroup[] = [
  {
    label: "ホーム",
    items: [{ label: "ホーム", to: "/e/$entityId", match: [""], mobile: "ホーム" }],
  },
  {
    label: "仕訳",
    items: [
      { label: "入力する", to: "/e/$entityId/journals/new" },
      { label: "一覧", to: "/e/$entityId/journals", mobile: "仕訳の一覧" },
      { label: "定期仕訳", to: "/e/$entityId/recurring" },
    ],
  },
  {
    label: "明細",
    items: [
      { label: "取り込む", to: "/e/$entityId/statements/import" },
      { label: "一覧と確認", to: "/e/$entityId/statements" },
      { label: "ルール", to: "/e/$entityId/statements/rules" },
      { label: "明細の設定", to: "/e/$entityId/statements/settings" },
    ],
  },
  {
    label: "証憑",
    items: [
      { label: "追加する", to: "/e/$entityId/receipts/new", mobile: "証憑を追加" },
      { label: "一覧", to: "/e/$entityId/receipts", mobile: "証憑の一覧" },
    ],
  },
  {
    label: "請求",
    items: [
      { label: "請求の流れ", to: "/e/$entityId/invoices" },
      { label: "工数", to: "/e/$entityId/work-hours" },
      { label: "請求の設定", to: "/e/$entityId/invoice-settings" },
    ],
  },
  // 帳票の中は、画面のタブで行き来する。1 項目なので直接のリンク
  {
    label: "帳票",
    items: [
      {
        label: "帳票",
        to: "/e/$entityId/reports/profit-and-loss",
        match: ["/reports"],
        mobile: "帳票",
      },
    ],
  },
  {
    label: "決算・申告",
    items: [
      { label: "決算書", to: "/e/$entityId/blue-return" },
      { label: "固定資産台帳", to: "/e/$entityId/fixed-assets" },
      { label: "開業費", to: "/e/$entityId/deferred-assets" },
    ],
  },
  {
    label: "事業体の設定",
    items: [
      { label: "基本", to: "/e/$entityId/settings" },
      { label: "勘定科目", to: "/e/$entityId/accounts" },
      { label: "取引先", to: "/e/$entityId/partners" },
      { label: "タグ", to: "/e/$entityId/tags" },
      { label: "消費税", to: "/e/$entityId/tax-settings" },
      // freee の取込は会計期間の画面から入る
      { label: "会計期間と移行", to: "/e/$entityId/periods", match: ["/periods", "/imports"] },
    ],
  },
];

/** スマホのメニューの項目（FR-059）。ラベルとパスの正本は上の `NAV` で、ここでは絞り込むだけ */
export function mobileNavItems(): { label: string; to: NavTo }[] {
  return NAV.flatMap((g) => g.items).flatMap((i) =>
    i.mobile === undefined ? [] : [{ label: i.mobile, to: i.to }],
  );
}

const ACTIVE_CLASS = "font-semibold underline";

/**
 * Link の「今の画面」の判定は、パスが完全に同じときだけにする（Link は判定が真だと `aria-current` を上書きする）。
 * 完全に同じパスの項目は、こちらの判定（いちばん長い接頭辞）でも必ず今の画面になるので、食い違わない
 */
const ACTIVE_OPTIONS = { exact: true } as const;

const matchesOf = (item: NavItem) => item.match ?? [item.to.replace("/e/$entityId", "")];

/** `rest`（事業体の下のパス）が項目の接頭辞に当たるときの長さ。当たらなければ -1 */
function matchLength(item: NavItem, rest: string): number {
  let best = -1;
  for (const prefix of matchesOf(item)) {
    const hit = prefix === "" ? rest === "" : rest === prefix || rest.startsWith(`${prefix}/`);
    if (hit) best = Math.max(best, prefix.length);
  }
  return best;
}

/** 今の画面の項目: 当たる接頭辞がいちばん長い項目（「入力する」と「一覧」のように、一方が他方の接頭辞のとき） */
function currentItem(rest: string): NavItem | undefined {
  let found: NavItem | undefined;
  let foundLength = -1;
  for (const item of NAV.flatMap((g) => g.items)) {
    const length = matchLength(item, rest);
    if (length > foundLength) {
      found = item;
      foundLength = length;
    }
  }
  return found;
}

export function EntityNav({ entityId }: { entityId: string }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const base = `/e/${entityId}`;
  const item = pathname.startsWith(base) ? currentItem(pathname.slice(base.length)) : undefined;
  const currentGroup = item && NAV.find((g) => g.items.includes(item));
  const params = { entityId };
  const showSub = currentGroup !== undefined && currentGroup.items.length > 1;
  return (
    <>
      <nav
        aria-label="事業体のメニュー"
        className={`flex flex-wrap gap-4 border-b pb-2 text-sm ${showSub ? "" : "mb-4"}`}
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
              activeOptions={ACTIVE_OPTIONS}
              className={active ? ACTIVE_CLASS : undefined}
              aria-current={active ? "page" : undefined}
            >
              {group.label}
            </Link>
          );
        })}
      </nav>
      {showSub ? (
        <nav
          aria-label="事業体のサブメニュー"
          className="mb-4 flex flex-wrap gap-4 border-b py-2 pl-2 text-sm"
        >
          {currentGroup.items.map((groupItem) => {
            const active = groupItem === item;
            return (
              <Link
                key={groupItem.label}
                to={groupItem.to}
                params={params}
                activeOptions={ACTIVE_OPTIONS}
                className={active ? ACTIVE_CLASS : undefined}
                aria-current={active ? "page" : undefined}
              >
                {groupItem.label}
              </Link>
            );
          })}
        </nav>
      ) : null}
    </>
  );
}
