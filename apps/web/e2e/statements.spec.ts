import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { BANK_TWO_COLUMNS } from "../../../packages/domain/test/fixtures/statements/expected.ts";
import { enterVault } from "./helpers/auth.ts";

// 007 US1（と 006 US1・US2）: 銀行の CSV（CP932、前置きつき、出金・入金の 2 列）のファイルを選ぶ → 列の案を確かめる →
// 取込の口座の名前を入れる → 確認 → 口座の対応 → 取り込む → 候補の承認 → 仕訳帳 → 仕訳の取消で未処理に戻る。
// AI は使わない（候補は「候補なし」のまま、利用者が科目を選んで承認する）。
// 日付は `2026/10/01` の形で年を持つので、対象の年の入力は出ない。事業体の開始年度は 2026（1 月始まり）で、10/01〜10/31 が収まる。
// 件数・合計は合成のフィクスチャの期待値（expected.ts）。
const FIXTURE = resolve(
  import.meta.dirname,
  "../../../packages/domain/test/fixtures/statements",
  BANK_TWO_COLUMNS.file,
);
const YEAR = "2026";
const BANK = "サンプル銀行";
/** 承認する明細（出金 80,000 円の家賃） */
const TARGET = "家賃 サンプル不動産";
const yen = (n: number) => n.toLocaleString("ja-JP");

test("銀行の CSV の取込から、列の確認、口座の対応、候補の承認、仕訳帳、取消で未処理に戻るまで", async ({
  page,
}) => {
  const menu = page.getByRole("navigation", { name: "事業体のメニュー" });
  const statementRow = (content: string) =>
    page
      .getByRole("table", { name: "明細の一覧", exact: true })
      .getByRole("row")
      .filter({ has: page.getByRole("cell", { name: content, exact: true }) });
  let journalNo = "";

  await test.step("設定または解錠する", async () => {
    await enterVault(page);
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

  const input = page.getByRole("region", { name: "入力", exact: true });
  const columns = page.getByRole("region", { name: "列の対応", exact: true });
  const preview = page.getByRole("region", { name: "プレビュー", exact: true });
  const summary = preview.getByRole("region", { name: "プレビューの要約", exact: true });
  const summaryItem = (term: string) =>
    summary.locator("div", { has: page.getByText(term, { exact: true }) });
  const importButton = preview.getByRole("button", { name: "取り込む", exact: true });

  /** 取込の入力でファイルを選び、「読み取る」を押す */
  async function readFile() {
    await input.getByRole("radio", { name: "ファイル", exact: true }).check();
    await input.getByLabel("明細のファイル", { exact: true }).setInputFiles(FIXTURE);
    await input.getByRole("button", { name: "読み取る", exact: true }).click();
  }

  /** ファイルを読み取り、列の案を確かめて、取込の口座の名前を入れ、確認へ進む（取込元の名前は口座の名前が既定） */
  async function readFileAndConfirm(accountName: string) {
    await readFile();

    await expect(columns).toBeVisible();
    // 辞書の案で、日付・内容・出金・入金が選ばれている（前置き 3 行の次の行が見出し。CP932 は自動で判定される）
    await expect(columns.getByRole("columnheader", { name: "摘要", exact: true })).toBeVisible();
    await expect(columns.getByLabel("見出しの行", { exact: true })).toHaveValue(
      String(BANK_TWO_COLUMNS.preambleLines + 1),
    );
    await expect(columns.getByLabel("文字コード", { exact: true })).toHaveValue("");
    await expect(
      columns.getByRole("radio", { name: "出金・入金の 2 列", exact: true }),
    ).toBeChecked();
    await expect(columns.getByLabel("「取引日」の役割", { exact: true })).toHaveValue("date");
    await expect(columns.getByLabel("「摘要」の役割", { exact: true })).toHaveValue("content");
    await expect(columns.getByLabel("「出金額」の役割", { exact: true })).toHaveValue("outflow");
    await expect(columns.getByLabel("「入金額」の役割", { exact: true })).toHaveValue("inflow");
    // 残高の列は読まない
    await expect(columns.getByLabel("「残高」の役割", { exact: true })).toHaveValue("");
    // 年のある日付なので、対象の年は聞かれない
    await expect(columns.getByLabel("対象の年", { exact: true })).toHaveCount(0);

    // 口座名の列がないので、取込の口座を聞かれる。理由が出ている間は確認へ進めない
    const confirm = columns.getByRole("button", { name: "確認へ", exact: true });
    await expect(confirm).toBeDisabled();
    await expect(
      columns.getByRole("list", { name: "確認へ進めない理由", exact: true }),
    ).toContainText("取込の口座を選ぶか、新しい口座の名前を入れてください");
    await columns
      .getByLabel("取込の口座", { exact: true })
      .selectOption({ label: "新しい名前を入れる" });
    await columns.getByLabel("口座の名前", { exact: true }).fill(accountName);
    // 取込元の名前の既定は、取込の口座の名前（このまま取り込むと、列の対応を取込元として保存する）
    await expect(columns.getByLabel("取込元の名前", { exact: true })).toHaveValue(accountName);
    await expect(confirm).toBeEnabled();
    await confirm.click();
  }

  await test.step("ファイルを選ぶと列の案が出て、確認へ進むとプレビューが出る（帳簿はまだ変わらない）", async () => {
    await menu.getByRole("link", { name: "明細", exact: true }).click();
    await expect(page.getByRole("heading", { name: "明細", exact: true })).toBeVisible();
    await page.getByRole("link", { name: "明細を取り込む", exact: true }).click();
    await expect(page.getByRole("heading", { name: "明細の取込", exact: true })).toBeVisible();

    await readFileAndConfirm(BANK);

    await expect(summary).toBeVisible();
    await expect(summaryItem("期間")).toContainText("2026-10-01 〜 2026-10-31");
    await expect(summaryItem("新規")).toContainText(`${BANK_TWO_COLUMNS.rowCount}件`);
    await expect(summaryItem("読めない行")).toContainText("0件");
    await expect(summaryItem("入金の合計")).toContainText(`${yen(BANK_TWO_COLUMNS.inflowTotal)}円`);
    await expect(summaryItem("出金の合計")).toContainText(
      `${yen(BANK_TWO_COLUMNS.outflowTotal)}円`,
    );
  });

  await test.step("口座の対応（推定を初期値にする）は用途を選ぶまで取り込めない。確定で一緒に保存する（007 US3）", async () => {
    // 用途は案があっても未選択で始まる
    await expect(importButton).toBeDisabled();

    const group = preview.getByRole("group", { name: `${BANK}の対応`, exact: true });
    await expect(group.getByLabel(`${BANK}の用途`, { exact: true })).toHaveValue("");
    await group.getByLabel(`${BANK}の用途`, { exact: true }).selectOption({ label: "事業用" });
    // 推定の種類・科目はそのままでもよいが、この確認では明示して選ぶ
    await group.getByLabel(`${BANK}の種類`, { exact: true }).selectOption({ label: "銀行" });
    await group.getByLabel(`${BANK}の科目`, { exact: true }).selectOption({ label: "普通預金" });
    // 保存のボタンはない。取込の画面から口座の対応を 1 件ずつ保存しない
    await expect(group.getByRole("button")).toHaveCount(0);
    await expect(importButton).toBeEnabled();
  });

  await test.step("取り込む（同じファイルをもう一度読むと、新規は 0 件）", async () => {
    await importButton.click();
    await expect(
      page
        .getByRole("status")
        .filter({ hasText: `${BANK_TWO_COLUMNS.rowCount} 件を取り込みました。` }),
    ).toBeVisible();
    await expect(preview).toBeHidden();

    // 取り込むと入力から始め直す。同じ形のファイルなので、保存した取込元が当てはまり、列の画面は出ない（007 US2）
    await readFile();
    await expect(summary).toBeVisible();
    await expect(columns).toHaveCount(0);
    const applied = page.getByRole("region", { name: "取込元", exact: true });
    await expect(applied).toContainText(`取込元: ${BANK}`);
    await expect(
      applied.getByRole("button", { name: "列の対応を直す", exact: true }),
    ).toBeVisible();
    await expect(summaryItem("新規")).toContainText("0件");
    await expect(summaryItem("取込済み")).toContainText(`${BANK_TWO_COLUMNS.rowCount}件`);
    await expect(preview.getByText("新しく取り込む明細はありません。")).toBeVisible();
    await expect(importButton).toBeDisabled();
  });

  await test.step("候補を作り、候補なしの明細を、科目を選んで承認する", async () => {
    await menu.getByRole("link", { name: "明細", exact: true }).click();
    await expect(statementRow(TARGET)).toBeVisible();
    await expect(statementRow(TARGET)).toContainText("未処理");

    await page.getByRole("button", { name: "候補を作る", exact: true }).click();
    await expect(
      page.getByRole("status").filter({ hasText: /^候補を \d+ 件作りました/ }),
    ).toBeVisible();

    await statementRow(TARGET).getByRole("button", { name: "確認する", exact: true }).click();
    const review = page.getByRole("region", { name: "候補の確認", exact: true });
    await expect(review).toBeVisible();
    await expect(
      review.getByRole("heading", {
        name: new RegExp(`^候補の確認: 2026-10-10 ${BANK} ${TARGET}`),
      }),
    ).toBeVisible();

    // 明細の口座（普通預金）の行は入っている。相手の行（借方）の科目を選ぶ
    const form = review.getByRole("form", { name: "仕訳の案", exact: true });
    await form.getByLabel("1行目の勘定科目", { exact: true }).selectOption({ label: "地代家賃" });
    await expect(form.getByLabel("2行目の勘定科目", { exact: true })).toHaveValue(/.+/);
    await form.getByRole("button", { name: "承認して登録", exact: true }).click();

    const approved = page.getByRole("status").filter({ hasText: /承認しました（仕訳 No\.\d+）/ });
    await expect(approved).toBeVisible();
    journalNo = ((await approved.textContent()) ?? "").match(/仕訳 No\.(\d+)/)?.[1] ?? "";
    expect(journalNo).not.toBe("");
    await expect(review).toBeHidden();
    // 未処理の一覧から外れる
    await expect(statementRow(TARGET)).toHaveCount(0);
  });

  await test.step("仕訳帳に仕訳が出る", async () => {
    await menu.getByRole("link", { name: "仕訳", exact: true }).click();
    const list = page.getByRole("table", { name: "仕訳の一覧" });
    const row = list.getByRole("row").filter({
      has: page.getByRole("link", { name: `仕訳 No.${journalNo} の詳細`, exact: true }),
    });
    await expect(row).toContainText("地代家賃");
    await expect(row).toContainText("普通預金");
    await expect(row).toContainText(TARGET);
  });

  await test.step("明細は登録済みになり、仕訳の詳細に元の明細が出る", async () => {
    await menu.getByRole("link", { name: "明細", exact: true }).click();
    await page.getByLabel("状態", { exact: true }).selectOption({ label: "登録済み" });
    await expect(statementRow(TARGET)).toContainText("登録済み");
    await statementRow(TARGET).getByRole("link", { name: "仕訳を開く", exact: true }).click();

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
    await expect(statementRow(TARGET)).toContainText("未処理");
    await expect(
      statementRow(TARGET).getByRole("button", { name: "確認する", exact: true }),
    ).toBeVisible();
  });
});
