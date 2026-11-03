import { expect, test } from "@playwright/test";
import { enterVault } from "./helpers/auth.ts";
import { openNav } from "./helpers/nav.ts";

// 日付は実行日に左右されないよう、対象月・発行日・入金日をすべて明示する。
// 開始年度 2026（1 月始まり）の期間に収まる値にする。事業体は新規で、消費税は免税（既定）
const TARGET_MONTH = "2026-09";
const ISSUE_DATE = "2026-10-05";
const RECEIVED_ON = "2026-10-20";

test("発行者の設定から、工数・請求書の発行・印刷用の画面・入金の消し込みまで", async ({ page }) => {
  const menu = page.getByRole("navigation", { name: "事業体のメニュー" });
  const saved = page.getByRole("status").filter({ hasText: "保存しました。" });
  let invoiceNo = "";

  await test.step("設定または解錠する", async () => {
    await enterVault(page);
  });

  await test.step("事業体を作成する（開始年度 2026）", async () => {
    await page.goto("/");
    const form = page
      .locator("form")
      .filter({ has: page.getByRole("button", { name: "作成する" }) });
    await form.getByLabel("名称", { exact: true }).fill("請求テスト");
    await form.getByLabel("種別").selectOption({ label: "個人" });
    await form.getByLabel("開始年度").fill("2026");
    await form.getByLabel("期首の月").selectOption({ label: "1月" });
    await form.getByRole("button", { name: "作成する" }).click();
    await expect(page).toHaveURL(/\/e\/[0-9a-f-]{36}$/);
    await expect(menu).toBeVisible();
  });

  await test.step("発行者を設定する", async () => {
    await openNav(page, "請求", "請求の設定");
    await expect(page.getByRole("heading", { name: "請求の設定" })).toBeVisible();

    await page.getByLabel("氏名", { exact: true }).fill("山田 太郎");
    await page.getByLabel("屋号", { exact: true }).fill("山田開発");
    await page.getByLabel("住所", { exact: true }).fill("東京都千代田区1-1-1");
    await page.getByLabel("連絡先", { exact: true }).fill("info@example.test");
    await page.getByLabel("振込先", { exact: true }).fill("テスト銀行 本店 普通 1234567");
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect(saved).toBeVisible();
  });

  await test.step("取引先を追加し、請求の条件（時間単価型・翌月末払い）を設定する", async () => {
    await openNav(page, "事業体の設定", "取引先");
    await page.getByLabel("名称", { exact: true }).fill("取引先A");
    await page.getByRole("button", { name: "追加する" }).click();
    await expect(page.getByRole("cell", { name: "取引先A", exact: true })).toBeVisible();

    await page.getByRole("button", { name: /^請求の条件\s*（取引先A）$/ }).click();
    const terms = page.getByRole("form", { name: "請求の条件（取引先A）" });
    await terms.getByLabel("請求の型").selectOption({ label: "時間単価型（工数 × 単価）" });
    await terms.getByLabel("時間単価（円）").fill("5000");
    await terms.getByLabel("支払期限（月）").selectOption({ label: "翌月" });
    await terms.getByLabel("支払期限（日）").selectOption({ label: "末日" });
    await terms.getByLabel("既定の品名").fill("システム開発（準委任）");
    await terms.getByLabel("請求書の敬称").selectOption({ label: "様" });
    await terms.getByRole("button", { name: "保存", exact: true }).click();
    await expect(terms.getByRole("status").filter({ hasText: "保存しました。" })).toBeVisible();
    await expect(page.getByRole("row", { name: /^取引先A/ })).toContainText("時間単価 5,000 円");
  });

  await test.step("対象月の工数を入力する", async () => {
    await openNav(page, "請求", "請求の流れ");
    await page.getByRole("link", { name: "工数の入力" }).click();
    await expect(page.getByRole("heading", { name: "工数の入力" })).toBeVisible();

    await page.getByLabel("対象月", { exact: true }).fill(TARGET_MONTH);
    await page.getByLabel("取引先A の時間").fill("40.5");
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect(saved).toBeVisible();
  });

  await test.step("請求書の案を作り、発行日を決めて発行する", async () => {
    await page.getByRole("link", { name: "請求書の案を作る" }).click();
    await expect(page.getByRole("heading", { name: "請求書の発行" })).toBeVisible();
    await expect(page.getByLabel("対象月", { exact: true })).toHaveValue(TARGET_MONTH);
    await page.getByRole("button", { name: "案を作る" }).click();

    const draft = page.getByRole("region", { name: "請求書の案（取引先A）" });
    await expect(draft).toBeVisible();
    // 40.5 時間 × 5,000 円（免税の事業体なので、税込のみの請求書になる）
    await expect(draft.getByLabel("数量 1")).toHaveValue("40.5");
    await expect(draft.getByLabel("単価 1")).toHaveValue("5000");
    await expect(draft.getByLabel("金額 1")).toHaveValue("202,500");
    await expect(draft.getByText("合計 202,500 円")).toBeVisible();
    await expect(draft.getByLabel("売上の計上日")).toHaveValue("2026-09-30");

    await draft.getByLabel("発行日").fill(ISSUE_DATE);
    await draft.getByRole("button", { name: "発行する" }).click();

    const notice = draft.getByRole("status").filter({ hasText: /^発行しました（請求書 .+）。$/ });
    await expect(notice).toBeVisible();
    invoiceNo = /請求書 (\S+)）/.exec((await notice.textContent()) ?? "")?.[1] ?? "";
    expect(invoiceNo).toMatch(/^20261005-\d{3}$/);
    await draft.getByRole("link", { name: `請求書 ${invoiceNo} を開く` }).click();
  });

  await test.step("詳細に発行時の内容と未入金の状態が出る", async () => {
    await expect(page.getByRole("heading", { name: `請求書 ${invoiceNo}` })).toBeVisible();
    await expect(page.getByText("取引先A 様", { exact: true })).toBeVisible();
    await expect(page.getByText("未入金", { exact: true })).toBeVisible();
    await expect(page.getByText("支払期限 2026-10-31", { exact: true })).toBeVisible();
    await expect(page.getByText("合計 202,500 円", { exact: true })).toBeVisible();
    await expect(page.getByText("残額 202,500 円", { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "売上の仕訳を開く" })).toBeVisible();
  });

  await test.step("印刷用の画面の title が請求番号になる", async () => {
    await page.getByRole("link", { name: "印刷・PDF に保存" }).click();
    await expect(page).toHaveURL(/\/invoices\/[0-9a-f-]{36}\/print$/);
    const sheet = page.getByRole("article", { name: `請求書 ${invoiceNo}` });
    await expect(sheet).toBeVisible();
    await expect(sheet).toContainText("山田 太郎");
    await expect(sheet).toContainText("ご請求金額 202,500 円");
    await expect(sheet).toContainText("テスト銀行 本店 普通 1234567");
    await expect(page).toHaveTitle(invoiceNo);

    await page.getByRole("link", { name: "請求書の詳細へ戻る" }).click();
    await expect(page.getByRole("heading", { name: `請求書 ${invoiceNo}` })).toBeVisible();
  });

  await test.step("全額を消し込むと、状態が入金済みになる", async () => {
    const form = page.getByRole("form", { name: "入金の消し込み" });
    await form.getByLabel("入金日").fill(RECEIVED_ON);
    await expect(form.getByLabel("入金額")).toHaveValue("202500");
    await form.getByLabel("入金先の科目").selectOption({ label: "普通預金" });
    await form.getByRole("button", { name: "消し込む" }).click();

    await expect(page.getByText("入金済み", { exact: true })).toBeVisible();
    await expect(page.getByText("残額 0 円", { exact: true })).toBeVisible();
    const payments = page.getByRole("table", { name: "消し込みの一覧" });
    await expect(payments.getByRole("row", { name: new RegExp(RECEIVED_ON) })).toContainText(
      "有効",
    );
    // 残額がないので、消し込みの入力欄は消える
    await expect(form).toBeHidden();
  });

  await test.step("一覧でも入金済みと残額 0 が見える", async () => {
    await openNav(page, "請求", "請求の流れ");
    const list = page.getByRole("table", { name: "請求書の一覧" });
    const row = list.getByRole("row", { name: new RegExp(invoiceNo) });
    await expect(row).toContainText("入金済み");
    await expect(row).toContainText("202,500");
  });
});
