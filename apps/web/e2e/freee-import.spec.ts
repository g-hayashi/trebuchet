import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { enterVault } from "./helpers/auth.ts";
import { openImports, openNav } from "./helpers/nav.ts";

const fixtures = resolve(import.meta.dirname, "../../../packages/domain/test/fixtures/freee");
const JOURNAL = resolve(fixtures, "journal-2025.csv");
const LEDGER = resolve(fixtures, "ledger-2025.csv");

test("freee の仕訳帳の取込から、元帳による期首残高、照合まで", async ({ page }) => {
  const menu = page.getByRole("navigation", { name: "事業体のメニュー" });

  await test.step("設定または解錠する", async () => {
    await enterVault(page);
  });

  await test.step("事業体を作成する（開始年度 2025）", async () => {
    // 事業体が 1 件だとトップはそのホームへ移るので、一覧と作成を開く
    await page.goto("/?list=1");
    const form = page
      .locator("form")
      .filter({ has: page.getByRole("button", { name: "作成する" }) });
    await form.getByLabel("名称", { exact: true }).fill("取込テスト");
    await form.getByLabel("種別").selectOption({ label: "個人" });
    await form.getByLabel("開始年度").fill("2025");
    await form.getByLabel("期首の月").selectOption({ label: "1月" });
    await form.getByRole("button", { name: "作成する" }).click();
    await expect(page).toHaveURL(/\/e\/[0-9a-f-]{36}$/);
    await expect(menu).toBeVisible();
  });

  await test.step("仕訳帳を選ぶとプレビューが出る（帳簿はまだ変わらない）", async () => {
    await openImports(page);
    await page.getByRole("link", { name: "新しい取込" }).click();
    await expect(page.getByRole("heading", { name: "新しい取込" })).toBeVisible();

    await page.getByLabel("仕訳帳のファイル").setInputFiles(JOURNAL);
    const summary = page.getByRole("region", { name: "プレビューの要約" });
    await expect(summary).toBeVisible();
    await expect(summary.getByText("journal-2025.csv")).toBeVisible();
    await expect(
      summary.locator("div", { has: page.getByText("新規", { exact: true }) }),
    ).toContainText("14件");
  });

  await test.step("未定の対応を決めるまで取り込めず、保存すると取り込める", async () => {
    const accountTable = page.getByRole("table", { name: "勘定科目の対応表" });
    const row = accountTable.getByRole("row", { name: /^事務用品費/ });
    const importButton = page.getByRole("button", { name: "取り込む" });
    await expect(importButton).toBeEnabled();

    await page.getByLabel("「事務用品費」の勘定科目").selectOption({ label: "選んでください" });
    await expect(row).toContainText("未定");
    await expect(importButton).toBeDisabled();
    await expect(page.getByText("対応表の変更を保存してから取り込んでください。")).toBeVisible();

    await page.getByLabel("「事務用品費」の勘定科目").selectOption({ label: "消耗品費" });
    await page.getByRole("button", { name: "対応表を保存" }).click();
    await expect(row).toContainText("保存済み");
    await expect(page.getByText("14件の仕訳を取り込みます。")).toBeVisible();
    await expect(importButton).toBeEnabled();
  });

  await test.step("取り込む", async () => {
    await page.getByRole("button", { name: "取り込む" }).click();
    await expect(
      page.getByRole("status").filter({ hasText: "14件の仕訳を取り込みました。" }),
    ).toBeVisible();

    await openNav(page, "仕訳", "一覧");
    const list = page.getByRole("table", { name: "仕訳の一覧" });
    await expect(
      list.getByRole("button", { name: /^仕訳 No\.\d+ の詳細$/, exact: true }),
    ).toHaveCount(14);
  });

  await test.step("元帳から期首残高を読み込んで保存する", async () => {
    await openNav(page, "事業体の設定", "会計期間と移行");
    await page
      .getByRole("region", { name: "2025年度", exact: true })
      .getByRole("listitem", { name: "期首残高", exact: true })
      .getByRole("link", { name: "期首残高を開く", exact: true })
      .click();
    await expect(page.getByRole("heading", { name: "2025年度の期首残高" })).toBeVisible();

    await page.getByLabel("総勘定元帳のファイル").setInputFiles(LEDGER);
    const proposal = page.getByRole("region", { name: "freee の元帳から作った案" });
    await expect(proposal).toBeVisible();
    await expect(proposal.getByRole("table", { name: "科目ごとの比較" })).toBeVisible();

    const form = page.getByRole("form", { name: "期首残高" });
    await expect(form.getByLabel("合計", { exact: true })).toContainText("差額0 円");
    const save = form.getByRole("button", { name: "保存する" });
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
    await page.getByRole("link", { name: "元帳と照合" }).click();
    await expect(page.getByRole("heading", { name: "元帳と照合" })).toBeVisible();

    await page.getByLabel("年度", { exact: true }).selectOption({ label: "2025" });
    await page.getByLabel("総勘定元帳のファイル").setInputFiles(LEDGER);
    await expect(page.getByText("すべての科目が一致しました。")).toBeVisible();
    await expect(page.getByRole("table", { name: "照合の結果" })).not.toContainText("不一致");
  });

  await test.step("同じ仕訳帳をもう一度選ぶと、新規は0件で取り込めない", async () => {
    await openImports(page);
    await page.getByRole("link", { name: "新しい取込" }).click();
    await page.getByLabel("仕訳帳のファイル").setInputFiles(JOURNAL);

    const summary = page.getByRole("region", { name: "プレビューの要約" });
    await expect(summary).toBeVisible();
    await expect(
      summary.locator("div", { has: page.getByText("新規", { exact: true }) }),
    ).toContainText("0件");
    await expect(
      summary.locator("div", { has: page.getByText("取込済み", { exact: true }) }),
    ).toContainText("14件");
    // 前年分の決算振替が対象外のまま残るので、「すべて取込済み」の文言にはならない
    await expect(page.getByText("新しく取り込む仕訳はありません。")).toBeVisible();
    await expect(page.getByRole("button", { name: "取り込む" })).toBeDisabled();
  });
});
