import type { Page } from "@playwright/test";

/**
 * 事業体の 2 段のメニューで、別のグループの項目へ移る。
 * 先に 1 段目のグループを押し（最初の項目へ進む）、2 段目の項目を押す。
 * ロケーターはロールで探し、`exact: true` で、それぞれの nav の中に絞る
 */
export async function openNav(
  page: Page,
  group: "ホーム" | "記帳" | "請求" | "帳票" | "決算・申告" | "事業体の設定",
  item?: string,
): Promise<void> {
  await page
    .getByRole("navigation", { name: "事業体のメニュー", exact: true })
    .getByRole("link", { name: group, exact: true })
    .click();
  if (item === undefined) return;
  await page
    .getByRole("navigation", { name: "事業体のサブメニュー", exact: true })
    .getByRole("link", { name: item, exact: true })
    .click();
}
