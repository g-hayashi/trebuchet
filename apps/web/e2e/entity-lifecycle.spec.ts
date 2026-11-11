import { expect, test } from "@playwright/test";
import { enterVault } from "./helpers/auth.ts";
import { MOBILE_VIEWPORT } from "./helpers/viewports.ts";

test("/listで種別説明・非表示・復元・完全削除を操作し、別組織を保持する", async ({ page }) => {
  await enterVault(page);
  for (const name of ["合成保持組織", "合成削除組織"]) {
    await page.goto("/list");
    const main = page.getByRole("main", { exact: true });
    if (name === "合成保持組織") {
      await main.getByText("個人・法人の違い", { exact: true }).click();
      await expect(main.getByText(/法人税の申告には対応していません/)).toBeVisible();
    }
    await main.getByRole("textbox", { name: "名称", exact: true }).fill(name);
    await main.getByRole("button", { name: "作成する", exact: true }).click();
    await expect(page).toHaveURL(/\/e\/[0-9a-f-]{36}$/);
  }
  await page.goto("/list");
  const main = page.getByRole("main", { exact: true });
  const row = main
    .getByRole("row", { exact: true })
    .filter({ has: page.getByRole("link", { name: "合成削除組織", exact: true }) });
  await row.getByRole("button", { name: "非表示にする", exact: true }).click();
  await expect(main.getByRole("link", { name: "合成削除組織", exact: true })).toHaveCount(0);
  await main.getByText("非表示の組織", { exact: true }).click();
  await main.getByRole("button", { name: "一覧に戻す", exact: true }).click();
  await expect(main.getByRole("link", { name: "合成削除組織", exact: true })).toBeVisible();
  await row.getByRole("button", { name: "非表示にする", exact: true }).click();
  await main.getByRole("button", { name: "完全に削除", exact: true }).click();
  const dialog = page.getByRole("dialog", { exact: true });
  const remove = dialog.getByRole("button", { name: "完全に削除", exact: true });
  await expect(remove).toBeDisabled();
  await dialog.getByRole("textbox", { name: "確認の名称", exact: true }).fill("合成削除組織");
  await remove.click();
  await expect(dialog).toHaveCount(0);
  await page.reload();
  await expect(main.getByRole("link", { name: "合成保持組織", exact: true })).toBeVisible();
  await main.getByText("非表示の組織", { exact: true }).click();
  await expect(main.getByText("非表示の組織はありません。", { exact: true })).toBeVisible();
  await page.setViewportSize(MOBILE_VIEWPORT);
  await expect(main.getByRole("button", { name: "非表示にする", exact: true })).toBeVisible();
});
