import { expect, type Page, test } from "@playwright/test";

type Line = { side?: "借方" | "貸方"; account: string; amount: string; description?: string };

/** 仕訳の入力画面の n 行目（1 始まり）を埋める */
async function fillLine(page: Page, n: number, line: Line) {
  const field = (name: string) => page.getByLabel(`${n}行目の${name}`, { exact: true });
  await field("勘定科目").selectOption({ label: line.account });
  if (line.side) await field("貸借").selectOption({ label: line.side });
  await field("金額").fill(line.amount);
  if (line.description) await field("摘要").fill(line.description);
}

test("事業体の作成から期首残高・仕訳の登録・貸借不一致の拒否・試算表の確認まで", async ({
  page,
}) => {
  const menu = page.getByRole("navigation", { name: "事業体のメニュー" });
  let entityId = "";

  await test.step("事業体を作成する", async () => {
    await page.goto("/");
    const form = page
      .locator("form")
      .filter({ has: page.getByRole("button", { name: "作成する" }) });
    await form.getByLabel("名称", { exact: true }).fill("個人事業");
    await form.getByLabel("種別").selectOption({ label: "個人" });
    await form.getByLabel("開始年度").fill("2026");
    await form.getByLabel("期首の月").selectOption({ label: "1月" });
    await form.getByRole("button", { name: "作成する" }).click();

    await expect(page).toHaveURL(/\/e\/[0-9a-f-]{36}$/);
    entityId = new URL(page.url()).pathname.split("/")[2] ?? "";
    await expect(menu).toBeVisible();
  });

  await test.step("期首残高を登録する（貸借が合うまで保存できない）", async () => {
    await menu.getByRole("link", { name: "会計期間" }).click();
    await page
      .getByRole("row", { name: /2026年度/ })
      .getByRole("link", { name: "期首残高" })
      .click();
    await expect(page.getByRole("heading", { name: "2026年度の期首残高" })).toBeVisible();

    const form = page.getByRole("form", { name: "期首残高" });
    await form.getByRole("button", { name: "行を追加" }).click();
    await form.getByRole("button", { name: "行を追加" }).click();
    await form.getByLabel("1行目の勘定科目").selectOption({ label: "普通預金" });
    await form.getByLabel("1行目の金額").fill("1,000,000");
    await form.getByLabel("2行目の勘定科目").selectOption({ label: "元入金" });
    await expect(form.getByLabel("2行目の貸借")).toHaveValue("credit");

    const save = form.getByRole("button", { name: "保存する" });
    await expect(save).toBeDisabled();
    await expect(form.getByText("差額が 0 円になると保存できます。")).toBeVisible();

    await form.getByLabel("2行目の金額").fill("1000000");
    await expect(form.getByLabel("合計", { exact: true })).toContainText("差額0 円");
    const saved = page.waitForResponse(
      (r) => r.url().includes("/opening-balances") && r.request().method() === "PUT",
    );
    await save.click();
    expect((await saved).ok()).toBe(true);

    await page.reload();
    await expect(form.getByLabel("1行目の金額")).toHaveValue("1000000");
    await expect(form.getByLabel("2行目の金額")).toHaveValue("1000000");
  });

  const result = page.getByRole("status", { name: "登録の結果" });

  await test.step("単一の仕訳を登録する", async () => {
    await menu.getByRole("link", { name: "仕訳" }).click();
    await page.getByRole("link", { name: "仕訳を入力" }).click();
    await expect(page.getByRole("heading", { name: "仕訳の入力" })).toBeVisible();

    await page.getByLabel("日付").fill("2026-10-31");
    await fillLine(page, 1, {
      account: "売掛金",
      amount: "495000",
      description: "10月分 取引先A",
    });
    await fillLine(page, 2, { account: "売上高", amount: "495000" });
    await page.getByRole("button", { name: "登録する" }).click();
    await expect(result).toContainText("仕訳 No.1 を登録しました。");
  });

  await test.step("複合仕訳（借方2行・貸方1行）を登録する", async () => {
    await expect(page.getByLabel("日付")).toHaveValue("2026-10-31");
    await page.getByRole("button", { name: "行を追加" }).click();
    await fillLine(page, 1, { side: "借方", account: "普通預金", amount: "487037" });
    await fillLine(page, 2, { side: "貸方", account: "売掛金", amount: "495000" });
    await fillLine(page, 3, {
      side: "借方",
      account: "事業主貸",
      amount: "7963",
      description: "源泉所得税",
    });
    await expect(page.getByLabel("合計", { exact: true })).toContainText("借方合計495,000 円");
    await page.getByRole("button", { name: "登録する" }).click();
    await expect(result).toContainText("仕訳 No.2 を登録しました。");
  });

  await test.step("貸借が一致しない仕訳は登録できない", async () => {
    await fillLine(page, 1, { account: "普通預金", amount: "500000" });
    await fillLine(page, 2, { account: "売上高", amount: "495000" });
    const totals = page.getByLabel("合計", { exact: true });
    await expect(totals).toContainText("借方合計500,000 円");
    await expect(totals).toContainText("貸方合計495,000 円");
    await expect(totals).toContainText("差額5,000 円");
    await expect(page.getByRole("button", { name: "登録する" })).toBeDisabled();
    await expect(page.getByText("差額が 0 円になると登録できます。")).toBeVisible();

    // 画面を通さずに送っても、サーバーが差額付きで拒否する
    const accounts = (await (
      await page.request.get(`/api/entities/${entityId}/accounts`)
    ).json()) as { accounts: { id: string; name: string }[] };
    const idOf = (name: string) => accounts.accounts.find((a) => a.name === name)?.id;
    const res = await page.request.post(`/api/entities/${entityId}/journals`, {
      data: {
        date: "2026-10-31",
        lines: [
          { side: "debit", accountId: idOf("普通預金"), amount: 500000 },
          { side: "credit", accountId: idOf("売上高"), amount: 495000 },
        ],
      },
    });
    expect(res.status()).toBe(422);
    expect(await res.json()).toMatchObject({
      error: { code: "UNBALANCED", details: { diff: 5000 } },
    });

    await menu.getByRole("link", { name: "仕訳" }).click();
    const list = page.getByRole("table", { name: "仕訳の一覧" });
    await expect(list.getByRole("link", { name: /^仕訳 No\.\d+ の詳細$/ })).toHaveCount(2);
  });

  await test.step("試算表の借方合計と貸方合計が一致する", async () => {
    await menu.getByRole("link", { name: "帳票" }).click();
    await expect(page.getByRole("heading", { name: "残高試算表" })).toBeVisible();
    const table = page.getByRole("table", { name: "残高試算表" });
    const cells = (name: string) => table.getByRole("row", { name }).getByRole("cell");

    await expect(page.getByText("貸借一致", { exact: true })).toBeVisible();
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
