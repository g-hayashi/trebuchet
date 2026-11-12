import type { BrowserContext, Locator, Page } from "@playwright/test";

/** 画面の `main`（ロケーターはこの中に絞る。`exact: true` でロールの名前を厳密に見る） */
export const mainOf = (page: Page): Locator => page.getByRole("main", { exact: true });

/** 事業体の画面（`/e/<id>…`）にいるとき、今の事業体の ID。いなければ例外 */
export function entityIdOf(page: Page): string {
  const id = new URL(page.url()).pathname.match(/^\/e\/([0-9a-f-]{36})(?:\/|$)/)?.[1];
  if (id === undefined) throw new Error(`事業体の画面ではありません: ${page.url()}`);
  return id;
}

/**
 * かんたん入力の科目の欄（combobox）に科目名を入れ、候補（「1030 売掛金」）から選ぶ。
 * `scope` は欄を含む範囲（画面の `main`）
 */
export async function pickQuickAccount(
  scope: Locator,
  label: "借方科目" | "貸方科目",
  account: string,
): Promise<void> {
  await scope.getByRole("combobox", { name: label, exact: true }).fill(account);
  await scope.getByRole("option", { name: new RegExp(`^\\d+ ${account}$`) }).click();
}

/**
 * 合成の HTML を別のページで描き、PNG に保存する（領収書の原本の合成。アプリの通常の追加に渡す）。
 * `clip` を省くとビューポート全体
 */
export async function renderHtmlToPng(
  context: BrowserContext,
  html: string,
  file: string,
  clip?: { x: number; y: number; width: number; height: number },
): Promise<void> {
  const page = await context.newPage();
  try {
    await page.setContent(html);
    await page.screenshot({ path: file, ...(clip === undefined ? {} : { clip }) });
  } finally {
    await page.close();
  }
}
