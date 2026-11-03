import { expect, type Locator, type Page } from "@playwright/test";

/**
 * 事業体の 2 段のメニューで、別のグループの項目へ移る（specs/011-ui-overhaul/contracts/ui-shell.md §2）。
 * 先に 1 段目のグループを押し（2 段目の最初の項目へ進む。「帳票」は直接のリンク）、2 段目の項目を押す。
 * 2 段目の項目: 仕訳 = 入力する・一覧・定期仕訳、明細 = 取り込む・一覧と確認・ルール・明細の設定、
 * 証憑 = 追加する・一覧、請求 = 請求の流れ・工数・請求の設定、決算・申告 = 決算書・固定資産台帳・開業費、
 * 事業体の設定 = 基本・勘定科目・取引先・タグ・消費税・会計期間と移行。
 * ロケーターはロールで探し、`exact: true` で、それぞれの nav の中に絞る。
 * 押した後は、その項目が今の画面になるまで待つ（待たないと、前の画面の入力欄に書いてしまう）
 */
export async function openNav(
  page: Page,
  group: "ホーム" | "仕訳" | "明細" | "証憑" | "請求" | "帳票" | "決算・申告" | "事業体の設定",
  item?: string,
): Promise<void> {
  await clickAndWait(
    page
      .getByRole("navigation", { name: "事業体のメニュー", exact: true })
      .getByRole("link", { name: group, exact: true }),
  );
  if (item === undefined) return;
  await clickAndWait(
    page
      .getByRole("navigation", { name: "事業体のサブメニュー", exact: true })
      .getByRole("link", { name: item, exact: true }),
  );
}

/**
 * freee の取込の画面を開く。メニューに項目はなく、入口は「会計期間と移行」の画面に置く（011/T036）。
 * それまでは、今の事業体の URL から直接開く
 */
export async function openImports(page: Page): Promise<void> {
  const entityRoot = new URL(page.url()).pathname.match(/^\/e\/[^/]+/)?.[0];
  expect(entityRoot).toBeDefined();
  await page.goto(`${entityRoot}/imports`);
  await expect(
    page
      .getByRole("navigation", { name: "事業体のサブメニュー", exact: true })
      .getByRole("link", { name: "会計期間と移行", exact: true }),
  ).toHaveAttribute("aria-current", "page");
}

async function clickAndWait(link: Locator): Promise<void> {
  await link.click();
  await expect(link).toHaveAttribute("aria-current", "page");
}
