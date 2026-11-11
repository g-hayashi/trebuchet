import { expect, type Page, test } from "@playwright/test";
import { enterVault } from "./helpers/auth.ts";
import { createEntityViaUi, postJournalViaApi } from "./helpers/entity.ts";
import { openNav } from "./helpers/nav.ts";
import { mainOf, pickQuickAccount } from "./helpers/ui.ts";

type Line = { side?: "借方" | "貸方"; account: string; amount: string; description?: string };

/** 仕訳の入力画面の n 行目（1 始まり）を埋める */
async function fillLine(page: Page, n: number, line: Line) {
  const field = (name: string) => mainOf(page).getByLabel(`${n}行目の${name}`, { exact: true });
  await field("勘定科目").selectOption({ label: line.account });
  if (line.side) await field("貸借").selectOption({ label: line.side });
  await field("金額").fill(line.amount);
  // 利用者は金額を入れたあと Tab で次へ移る。この blur で、最後の行の差額補完が先に働く
  // （blur を待たずに次の行の金額へ fill すると、補完された値に追記される）
  await field("金額").blur();
  if (line.description) await field("摘要").fill(line.description);
}

/** 「かんたん入力」から「詳細」へ切り替える（登録のたびにかんたん入力へ戻る） */
async function openDetailed(page: Page) {
  const detailed = mainOf(page).getByRole("button", { name: "詳細", exact: true });
  await detailed.click();
  await expect(detailed).toHaveAttribute("aria-pressed", "true");
}

// 事業体の作成の画面の操作は、このテストだけが確かめる（ほかのテストは API で作る）
test("事業体の作成から期首残高・仕訳の登録・貸借不一致の拒否・試算表の確認まで", async ({
  page,
}) => {
  const main = mainOf(page);
  const menu = page.getByRole("navigation", { name: "事業体のメニュー", exact: true });
  let entityId = "";

  await test.step("設定または解錠する", async () => {
    await enterVault(page);
  });

  await test.step("事業体を作成する", async () => {
    entityId = await createEntityViaUi(page, { name: "個人事業", firstFiscalYear: 2026 });
    await expect(menu).toBeVisible();
  });

  await test.step("期首残高を登録する（貸借が合うまで保存できない）", async () => {
    await openNav(page, "事業体の設定", "会計期間と移行");
    await main
      .getByRole("region", { name: "2026年度", exact: true })
      .getByRole("listitem", { name: "期首残高", exact: true })
      .getByRole("link", { name: "期首残高を開く", exact: true })
      .click();
    await expect(
      main.getByRole("heading", { name: "2026年度の期首残高", exact: true }),
    ).toBeVisible();

    const form = main.getByRole("form", { name: "期首残高", exact: true });
    await form.getByRole("button", { name: "行を追加", exact: true }).click();
    await form.getByRole("button", { name: "行を追加", exact: true }).click();
    await form.getByLabel("1行目の勘定科目", { exact: true }).selectOption({ label: "普通預金" });
    await form.getByLabel("1行目の金額", { exact: true }).fill("1,000,000");
    await form.getByLabel("2行目の勘定科目", { exact: true }).selectOption({ label: "元入金" });
    await expect(form.getByLabel("2行目の貸借", { exact: true })).toHaveValue("credit");

    const save = form.getByRole("button", { name: "保存する", exact: true });
    await expect(save).toBeDisabled();
    await expect(
      form.getByText("差額が 0 円になると保存できます。", { exact: true }),
    ).toBeVisible();

    await form.getByLabel("2行目の金額", { exact: true }).fill("1000000");
    await expect(form.getByLabel("合計", { exact: true })).toContainText("差額0 円");
    const saved = page.waitForResponse(
      (r) => r.url().includes("/opening-balances") && r.request().method() === "PUT",
    );
    await save.click();
    expect((await saved).ok()).toBe(true);

    await page.reload();
    await expect(form.getByLabel("1行目の金額", { exact: true })).toHaveValue("1000000");
    await expect(form.getByLabel("2行目の金額", { exact: true })).toHaveValue("1000000");
  });

  const result = main.getByRole("status", { name: "登録の結果", exact: true });

  await test.step("単一の仕訳を登録する", async () => {
    await openNav(page, "仕訳", "入力する");
    await expect(main.getByRole("heading", { name: "仕訳の入力", exact: true })).toBeVisible();

    // 既定は「かんたん入力」（日付・借方科目・貸方科目・金額・摘要）
    await expect(main.getByRole("button", { name: "かんたん入力", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await main.getByLabel("日付", { exact: true }).fill("2026-10-31");
    await pickQuickAccount(main, "借方科目", "売掛金");
    await pickQuickAccount(main, "貸方科目", "売上高");
    await main.getByLabel("金額", { exact: true }).fill("495000");
    await main.getByLabel("摘要", { exact: true }).fill("10月分 取引先A");
    await main.getByRole("button", { name: "登録", exact: true }).click();
    await expect(result).toContainText("仕訳 No.1 を登録しました。");
  });

  await test.step("複合仕訳（借方2行・貸方1行）を登録する", async () => {
    await expect(main.getByLabel("日付", { exact: true })).toHaveValue("2026-10-31");
    // 複数行の仕訳は「詳細」で入力する
    await openDetailed(page);
    await main.getByRole("button", { name: "行を追加", exact: true }).click();
    await fillLine(page, 1, { side: "借方", account: "普通預金", amount: "487037" });
    await fillLine(page, 2, { side: "貸方", account: "売掛金", amount: "495000" });
    await fillLine(page, 3, {
      side: "借方",
      account: "事業主貸",
      amount: "7963",
      description: "源泉所得税",
    });
    await expect(main.getByLabel("合計", { exact: true })).toContainText("借方合計495,000 円");
    await main.getByRole("button", { name: "登録", exact: true }).click();
    await expect(result).toContainText("仕訳 No.2 を登録しました。");
  });

  await test.step("貸借が一致しない仕訳は登録できない", async () => {
    await openDetailed(page);
    await fillLine(page, 1, { account: "普通預金", amount: "500000" });
    await fillLine(page, 2, { account: "売上高", amount: "495000" });
    const totals = main.getByLabel("合計", { exact: true });
    await expect(totals).toContainText("借方合計500,000 円");
    await expect(totals).toContainText("貸方合計495,000 円");
    await expect(totals).toContainText("差額5,000 円");
    await expect(main.getByRole("button", { name: "登録", exact: true })).toBeDisabled();
    await expect(
      main.getByText("差額が 0 円になると登録できます。", { exact: true }),
    ).toBeVisible();

    // 画面を通さずに送っても、サーバーが差額付きで拒否する
    const res = await postJournalViaApi(page, entityId, {
      date: "2026-10-31",
      lines: [
        { side: "debit", account: "普通預金", amount: 500000 },
        { side: "credit", account: "売上高", amount: 495000 },
      ],
    });
    expect(res.status()).toBe(422);
    expect(await res.json()).toMatchObject({
      error: { code: "UNBALANCED", details: { diff: 5000 } },
    });

    await openNav(page, "仕訳", "一覧");
    const list = main.getByRole("table", { name: "仕訳の一覧", exact: true });
    await expect(
      list.getByRole("button", { name: /^仕訳 No\.\d+ の詳細$/, exact: true }),
    ).toHaveCount(2);
  });

  await test.step("摘要を選択・コピーし、行クリックとキーボードで詳細を開閉する", async () => {
    const list = main.getByRole("table", { name: "仕訳の一覧", exact: true });
    const row = list.getByRole("row").filter({
      has: page.getByRole("button", { name: "仕訳 No.1 の詳細", exact: true }),
    });
    const note = row.getByText("10月分 取引先A", { exact: true });
    const box = await note.boundingBox();
    if (!box) throw new Error("摘要が表示されていない");
    await page.mouse.move(box.x + 1, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, { steps: 15 });
    await page.mouse.up();
    await expect
      .poll(() => page.evaluate(() => window.getSelection()?.toString()))
      .toBe("10月分 取引先A");
    const sheet = page.getByRole("dialog", { name: "仕訳の詳細", exact: true });
    await expect(sheet).toBeHidden();
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.keyboard.press("ControlOrMeta+c");
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe("10月分 取引先A");
    await page.evaluate(() => window.getSelection()?.removeAllRanges());
    await row.getByRole("cell", { name: "2026-10-31", exact: true }).click();
    await expect(sheet).toBeVisible();
    const open = row.getByRole("button", { name: "仕訳 No.1 の詳細", exact: true });
    await sheet.getByRole("button", { name: "閉じる", exact: true }).click();
    await expect(open).toBeFocused();
    for (const key of ["Enter", "Space"]) {
      await page.keyboard.press(key);
      await expect(sheet).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(sheet).toBeHidden();
      await expect(open).toBeFocused();
    }
  });

  await test.step("試算表の借方合計と貸方合計が一致する", async () => {
    // 「帳票」は損益計算書へ進む。帳票のタブで試算表へ移る
    await openNav(page, "帳票");
    await page
      .getByRole("navigation", { name: "帳票", exact: true })
      .getByRole("link", { name: "残高試算表", exact: true })
      .click();
    await expect(main.getByRole("heading", { name: "残高試算表", exact: true })).toBeVisible();
    const table = main.getByRole("table", { name: "残高試算表", exact: true });
    const cells = (name: string) => table.getByRole("row", { name }).getByRole("cell");

    await expect(main.getByText("貸借一致", { exact: true })).toBeVisible();
    await expect(table.locator("tfoot").getByRole("cell")).toHaveText([
      "",
      "合計",
      "",
      "990,000",
      "990,000",
      "",
    ]);
    await expect(cells("普通預金")).toHaveText([
      "1020",
      "普通預金",
      "1,000,000",
      "487,037",
      "0",
      "1,487,037",
    ]);
    await expect(cells("売掛金")).toHaveText(["1030", "売掛金", "0", "495,000", "495,000", "0"]);
    await expect(cells("売上高")).toHaveText(["4010", "売上高", "0", "0", "495,000", "495,000"]);
  });
});
