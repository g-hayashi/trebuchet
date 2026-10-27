import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { ensureSignedIn } from "./helpers/auth.ts";

// 006 US1・US2: 合成の貼り付け → 口座の対応 → 取込 → 候補の承認 → 仕訳帳 → 仕訳の取消で未処理に戻る。
// AI は使わない（候補は「候補なし」のまま、利用者が科目を選んで承認する）。
// 貼り付けの日付は `MM/DD(曜)` で年を持たないので、対象の年を 2026 に固定する（実行日に依存しない）。
// 事業体の開始年度も 2026（1 月始まり）で、貼り付けの 10/01〜10/08 が収まる
const PASTE = resolve(
  import.meta.dirname,
  "../../../packages/domain/test/fixtures/statements/mfme-paste.txt",
);
const YEAR = "2026";

test("貼り付けの取込から、口座の対応、候補の承認、仕訳帳、取消で未処理に戻るまで", async ({
  page,
}) => {
  const menu = page.getByRole("navigation", { name: "事業体のメニュー" });
  const statementRow = (content: string) =>
    page
      .getByRole("table", { name: "明細の一覧", exact: true })
      .getByRole("row")
      .filter({ has: page.getByRole("cell", { name: content, exact: true }) });
  let journalNo = "";

  await test.step("登録またはサインインする", async () => {
    await ensureSignedIn(page);
  });

  await test.step("事業体を作成する（開始年度 2026）", async () => {
    await page.goto("/");
    const form = page
      .locator("form")
      .filter({ has: page.getByRole("button", { name: "作成する" }) });
    await form.getByLabel("名称", { exact: true }).fill("明細テスト");
    await form.getByLabel("種別").selectOption({ label: "個人" });
    await form.getByLabel("開始年度").fill(YEAR);
    await form.getByLabel("期首の月").selectOption({ label: "1月" });
    await form.getByRole("button", { name: "作成する" }).click();
    await expect(page).toHaveURL(/\/e\/[0-9a-f-]{36}$/);
    await expect(menu).toBeVisible();
  });

  const paste = page.getByRole("region", { name: "貼り付け", exact: true });
  const preview = page.getByRole("region", { name: "プレビュー", exact: true });
  const summary = preview.getByRole("region", { name: "プレビューの要約", exact: true });
  const summaryItem = (term: string) =>
    summary.locator("div", { has: page.getByText(term, { exact: true }) });
  const importButton = preview.getByRole("button", { name: "取り込む", exact: true });

  await test.step("貼り付けるとプレビューが出る（帳簿はまだ変わらない）", async () => {
    await menu.getByRole("link", { name: "明細", exact: true }).click();
    await expect(page.getByRole("heading", { name: "明細", exact: true })).toBeVisible();
    await page.getByRole("link", { name: "明細を取り込む", exact: true }).click();
    await expect(page.getByRole("heading", { name: "明細の取込", exact: true })).toBeVisible();

    await paste
      .getByLabel("貼り付けのテキスト", { exact: true })
      .fill(await readFile(PASTE, "utf8"));
    await paste.getByLabel("対象の年", { exact: true }).fill(YEAR);
    await paste.getByRole("button", { name: "プレビュー", exact: true }).click();

    await expect(summary).toBeVisible();
    await expect(summaryItem("期間")).toContainText("2026-10-01 〜 2026-10-08");
    await expect(summaryItem("新規")).toContainText("9件");
    // 末尾の「合計」の行は読めない行になる
    await expect(summaryItem("読めない行")).toContainText("1件");
  });

  await test.step("口座の対応を決めるまで取り込めない", async () => {
    await expect(importButton).toBeDisabled();

    const mappings: { name: string; kind: string; account: string }[] = [
      { name: "サンプル銀行", kind: "銀行", account: "普通預金" },
      { name: "テストカードA", kind: "カード", account: "未払金" },
      { name: "テスト現金", kind: "現金", account: "現金" },
    ];
    for (const m of mappings) {
      const group = preview.getByRole("group", { name: `${m.name}の対応`, exact: true });
      await group.getByLabel(`${m.name}の用途`, { exact: true }).selectOption({ label: "事業用" });
      await group.getByLabel(`${m.name}の種類`, { exact: true }).selectOption({ label: m.kind });
      await group.getByLabel(`${m.name}の科目`, { exact: true }).selectOption({ label: m.account });
      await group.getByRole("button", { name: `${m.name}の対応を保存`, exact: true }).click();
      // 保存すると、同じ入力でプレビューを作り直し、対応づいた口座の入力が消える
      await expect(group).toBeHidden();
    }
    await expect(importButton).toBeEnabled();
  });

  await test.step("取り込む（同じ内容をもう一度貼ると、新規は 0 件）", async () => {
    await importButton.click();
    await expect(
      page.getByRole("status").filter({ hasText: "9 件を取り込みました。" }),
    ).toBeVisible();
    await expect(preview).toBeHidden();

    await paste.getByRole("button", { name: "プレビュー", exact: true }).click();
    await expect(summaryItem("新規")).toContainText("0件");
    await expect(summaryItem("取込済み")).toContainText("9件");
    await expect(preview.getByText("新しく取り込む明細はありません。")).toBeVisible();
    await expect(importButton).toBeDisabled();
  });

  await test.step("候補を作り、候補なしの明細を、科目を選んで承認する", async () => {
    await page.getByRole("link", { name: "明細の一覧へ", exact: true }).click();
    await expect(statementRow("ショップ001")).toBeVisible();
    await expect(statementRow("ショップ001")).toContainText("未処理");

    await page.getByRole("button", { name: "候補を作る", exact: true }).click();
    await expect(
      page.getByRole("status").filter({ hasText: /^候補を \d+ 件作りました/ }),
    ).toBeVisible();

    await statementRow("ショップ001")
      .getByRole("button", { name: "確認する", exact: true })
      .click();
    const review = page.getByRole("region", { name: "候補の確認", exact: true });
    await expect(review).toBeVisible();
    await expect(
      review.getByRole("heading", { name: /^候補の確認: 2026-10-01 サンプル銀行 ショップ001/ }),
    ).toBeVisible();

    // 明細の口座（普通預金）の行は入っている。相手の行（借方）の科目を選ぶ
    const form = review.getByRole("form", { name: "仕訳の案", exact: true });
    await form.getByLabel("1行目の勘定科目", { exact: true }).selectOption({ label: "消耗品費" });
    await expect(form.getByLabel("2行目の勘定科目", { exact: true })).toHaveValue(/.+/);
    await form.getByRole("button", { name: "承認して登録", exact: true }).click();

    const approved = page.getByRole("status").filter({ hasText: /承認しました（仕訳 No\.\d+）/ });
    await expect(approved).toBeVisible();
    journalNo = ((await approved.textContent()) ?? "").match(/仕訳 No\.(\d+)/)?.[1] ?? "";
    expect(journalNo).not.toBe("");
    await expect(review).toBeHidden();
    // 未処理の一覧から外れる
    await expect(statementRow("ショップ001")).toHaveCount(0);
  });

  await test.step("仕訳帳に仕訳が出る", async () => {
    await menu.getByRole("link", { name: "仕訳", exact: true }).click();
    const list = page.getByRole("table", { name: "仕訳の一覧" });
    const row = list.getByRole("row").filter({
      has: page.getByRole("link", { name: `仕訳 No.${journalNo} の詳細`, exact: true }),
    });
    await expect(row).toContainText("消耗品費");
    await expect(row).toContainText("普通預金");
    await expect(row).toContainText("ショップ001");
  });

  await test.step("明細は登録済みになり、仕訳の詳細に元の明細が出る", async () => {
    await menu.getByRole("link", { name: "明細", exact: true }).click();
    await page.getByLabel("状態", { exact: true }).selectOption({ label: "登録済み" });
    await expect(statementRow("ショップ001")).toContainText("登録済み");
    await statementRow("ショップ001")
      .getByRole("link", { name: "仕訳を開く", exact: true })
      .click();

    await expect(
      page.getByRole("heading", { name: `仕訳 No.${journalNo}`, exact: true }),
    ).toBeVisible();
    const origin = page.getByRole("list", { name: "元の明細", exact: true });
    await expect(origin).toContainText("明細から登録した仕訳です。");
    await expect(origin.getByRole("link", { name: "元の明細を開く", exact: true })).toBeVisible();
  });

  await test.step("仕訳を取り消すと、明細は未処理に戻る", async () => {
    await page.getByRole("button", { name: "取り消す", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "取消の理由", exact: true });
    await dialog.getByLabel("理由", { exact: true }).fill("E2E: 取消のテスト");
    await dialog.getByRole("button", { name: "取消を確定", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("button", { name: "取り消す", exact: true })).toBeHidden();

    await menu.getByRole("link", { name: "明細", exact: true }).click();
    // 既定の絞り込みは「未処理」
    await expect(page.getByLabel("状態", { exact: true })).toHaveValue("unprocessed");
    await expect(statementRow("ショップ001")).toContainText("未処理");
    await expect(
      statementRow("ショップ001").getByRole("button", { name: "確認する", exact: true }),
    ).toBeVisible();
  });
});
