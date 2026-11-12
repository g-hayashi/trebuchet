import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { enterVault } from "./helpers/auth.ts";
import { createEntityViaApi } from "./helpers/entity.ts";
import { openImports, openNav } from "./helpers/nav.ts";
import { mainOf } from "./helpers/ui.ts";

const fixtures = resolve(import.meta.dirname, "../../../packages/domain/test/fixtures/freee");
const JOURNAL = resolve(fixtures, "journal-2025.csv");
const LEDGER = resolve(fixtures, "ledger-2025.csv");

test("freee の仕訳帳の取込から、元帳による期首残高、照合まで", async ({ page }) => {
  const main = mainOf(page);
  const menu = page.getByRole("navigation", { name: "事業体のメニュー", exact: true });

  await test.step("設定または解錠する", async () => {
    await enterVault(page);
  });

  await test.step("事業体を作成する（開始年度 2025）", async () => {
    // 作成の画面の操作は ledger-flow.spec.ts で確かめるので、ここでは API で作って開く
    const entityId = await createEntityViaApi(page, { name: "取込テスト", firstFiscalYear: 2025 });
    await page.goto(`/e/${entityId}`);
    await expect(menu).toBeVisible();
  });

  await test.step("仕訳帳を選ぶとプレビューが出る（帳簿はまだ変わらない）", async () => {
    await openImports(page);
    await main.getByRole("link", { name: "新しい取込", exact: true }).click();
    await expect(main.getByRole("heading", { name: "新しい取込", exact: true })).toBeVisible();

    await main.getByLabel("仕訳帳のファイル", { exact: true }).setInputFiles(JOURNAL);
    const summary = main.getByRole("region", { name: "プレビューの要約", exact: true });
    await expect(summary).toBeVisible();
    // ファイル名は「journal-2025.csv（UTF-8、N 行）。…」の文の一部
    await expect(summary.getByText(/journal-2025\.csv/)).toBeVisible();
    await expect(
      summary.locator("div", { has: page.getByText("新規", { exact: true }) }),
    ).toContainText("14件");
  });

  await test.step("未定の対応を決めるまで取り込めず、保存すると取り込める", async () => {
    const accountTable = main.getByRole("table", { name: "勘定科目の対応表", exact: true });
    const row = accountTable.getByRole("row", { name: /^事務用品費/ });
    const importButton = main.getByRole("button", { name: "取り込む", exact: true });
    await expect(importButton).toBeEnabled();

    await main
      .getByLabel("「事務用品費」の勘定科目", { exact: true })
      .selectOption({ label: "選んでください" });
    await expect(row).toContainText("未定");
    await expect(importButton).toBeDisabled();
    await expect(
      main.getByText("対応表の変更を保存してから取り込んでください。", { exact: true }),
    ).toBeVisible();

    await main
      .getByLabel("「事務用品費」の勘定科目", { exact: true })
      .selectOption({ label: "消耗品費" });
    await main.getByRole("button", { name: "対応表を保存", exact: true }).click();
    await expect(row).toContainText("保存済み");
    await expect(main.getByText("14件の仕訳を取り込みます。", { exact: true })).toBeVisible();
    await expect(importButton).toBeEnabled();
  });

  await test.step("取り込む", async () => {
    await main.getByRole("button", { name: "取り込む", exact: true }).click();
    await expect(
      page.getByRole("status").filter({ hasText: "14件の仕訳を取り込みました。" }),
    ).toBeVisible();

    await openNav(page, "仕訳", "一覧");
    const list = main.getByRole("table", { name: "仕訳の一覧", exact: true });
    await expect(
      list.getByRole("button", { name: /^仕訳 No\.\d+ の詳細$/, exact: true }),
    ).toHaveCount(14);
  });

  await test.step("元帳から期首残高を読み込んで保存する", async () => {
    await openNav(page, "事業体の設定", "会計期間と移行");
    await main
      .getByRole("region", { name: "2025年度", exact: true })
      .getByRole("listitem", { name: "期首残高", exact: true })
      .getByRole("link", { name: "期首残高を開く", exact: true })
      .click();
    await expect(
      main.getByRole("heading", { name: "2025年度の期首残高", exact: true }),
    ).toBeVisible();

    await main.getByLabel("総勘定元帳のファイル", { exact: true }).setInputFiles(LEDGER);
    const proposal = main.getByRole("region", { name: "freee の元帳から作った案", exact: true });
    await expect(proposal).toBeVisible();
    await expect(
      proposal.getByRole("table", { name: "科目ごとの比較", exact: true }),
    ).toBeVisible();

    const form = main.getByRole("form", { name: "期首残高", exact: true });
    await expect(form.getByLabel("合計", { exact: true })).toContainText("差額0 円");
    const save = form.getByRole("button", { name: "保存する", exact: true });
    await expect(save).toBeEnabled();
    const saved = page.waitForResponse(
      (r) => r.url().includes("/opening-balances") && r.request().method() === "PUT",
    );
    await save.click();
    expect((await saved).ok()).toBe(true);
    await expect(page.getByRole("status").filter({ hasText: "保存しました。" })).toBeVisible();
  });

  await test.step("元帳と照合するとすべて一致する", async () => {
    await openImports(page);
    await main.getByRole("link", { name: "元帳と照合", exact: true }).click();
    await expect(main.getByRole("heading", { name: "元帳と照合", exact: true })).toBeVisible();

    await main.getByLabel("年度", { exact: true }).selectOption({ label: "2025" });
    await main.getByLabel("総勘定元帳のファイル", { exact: true }).setInputFiles(LEDGER);
    await expect(main.getByText("すべての科目が一致しました。", { exact: true })).toBeVisible();
    await expect(main.getByRole("table", { name: "照合の結果", exact: true })).not.toContainText(
      "不一致",
    );
  });

  await test.step("同じ仕訳帳をもう一度選ぶと、新規は0件で取り込めない", async () => {
    await openImports(page);
    await main.getByRole("link", { name: "新しい取込", exact: true }).click();
    await main.getByLabel("仕訳帳のファイル", { exact: true }).setInputFiles(JOURNAL);

    const summary = main.getByRole("region", { name: "プレビューの要約", exact: true });
    await expect(summary).toBeVisible();
    await expect(
      summary.locator("div", { has: page.getByText("新規", { exact: true }) }),
    ).toContainText("0件");
    await expect(
      summary.locator("div", { has: page.getByText("取込済み", { exact: true }) }),
    ).toContainText("14件");
    // 前年分の決算振替が対象外のまま残るので、「すべて取込済み」の文言にはならない
    await expect(main.getByText("新しく取り込む仕訳はありません。", { exact: true })).toBeVisible();
    await expect(main.getByRole("button", { name: "取り込む", exact: true })).toBeDisabled();
  });
});
