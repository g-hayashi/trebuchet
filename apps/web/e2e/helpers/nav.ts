import { expect, type Locator, type Page } from "@playwright/test";

/**
 * 事業体の 2 段のメニューで、別のグループの項目へ移る。
 * 先に 1 段目のグループを押し（最初の項目へ進む）、2 段目の項目を押す。
 * ロケーターはロールで探し、`exact: true` で、それぞれの nav の中に絞る。
 * 押した後は、その項目が今の画面になるまで待つ（待たないと、前の画面の入力欄に書いてしまう）
 */
export async function openNav(
  page: Page,
  group: "ホーム" | "記帳" | "請求" | "帳票" | "決算・申告" | "事業体の設定",
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

async function clickAndWait(link: Locator): Promise<void> {
  await link.click();
  await expect(link).toHaveAttribute("aria-current", "page");
}
