import { expect, type Page, test } from "@playwright/test";
import { enterVault, ORIGIN_HEADERS } from "./helpers/auth.ts";

// SC-010・FR-058・FR-059（011 US10、research R11）。スマホの幅（390 × 844）で、FR-058 の画面のどれも
// ページ全体が横にはみ出さないこと、メニューから各画面に届くこと、対象の外に「PC での操作を推奨」が出ること。
// jsdom は配置を計算しないので、はみ出しはここで確かめる。実行は利用者の端末（T049）
const MOBILE = { width: 390, height: 844 };

// 1×1 の PNG（証憑の追加の確認用。内容に意味はない）
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/** ページ全体（`document.documentElement`）が横にはみ出していない */
async function expectNoHorizontalOverflow(page: Page, where: string) {
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(
    scrollWidth,
    `${where}: scrollWidth (${scrollWidth}) <= clientWidth (${clientWidth})`,
  ).toBeLessThanOrEqual(clientWidth);
}

/** 画面の見出し（h1）が出るのを待ってから、横のはみ出しを確かめる（読み込み中の幅で判定しない） */
async function expectFits(page: Page, heading: string) {
  await expect(page.getByRole("heading", { name: heading, exact: true, level: 1 })).toBeVisible();
  await expectNoHorizontalOverflow(page, heading);
}

/** ヘッダーのボタン「メニュー」から Sheet を開き、項目（リンク）を押す。Sheet が閉じるまで待つ */
async function openFromMenu(page: Page, item: string) {
  const header = page.getByRole("banner");
  const button = header.getByRole("button", { name: "メニュー", exact: true });
  await button.click();
  await expect(button).toHaveAttribute("aria-expanded", "true");
  const sheet = page.getByRole("dialog", { name: "メニュー", exact: true });
  await expect(sheet).toBeVisible();
  await sheet.getByRole("link", { name: item, exact: true }).click();
  await expect(sheet).toBeHidden();
}

test("スマホの幅で、メニューから各画面に届き、どの画面もページ全体が横にはみ出さない", async ({
  page,
}) => {
  let entityId = "";
  let journalId = "";

  await test.step("設定または解錠する（PC の幅。ヘッダーの「設定」を使う）", async () => {
    await enterVault(page);
  });

  await test.step("事業体と仕訳を API で作る", async () => {
    const name = `スマホ ${Date.now()}`;
    const created = await page.request.post("/api/entities", {
      headers: ORIGIN_HEADERS,
      data: { name, kind: "individual", fiscalStartMonth: 1, firstFiscalYear: 2026 },
    });
    expect(created.status()).toBe(201);
    const list = (await (await page.request.get("/api/entities")).json()) as {
      entities: { id: string; name: string }[];
    };
    entityId = list.entities.find((e) => e.name === name)?.id ?? "";
    expect(entityId).not.toBe("");

    const accounts = (await (
      await page.request.get(`/api/entities/${entityId}/accounts`)
    ).json()) as { accounts: { id: string; name: string }[] };
    const idOf = (accountName: string) => accounts.accounts.find((a) => a.name === accountName)?.id;
    const journal = await page.request.post(`/api/entities/${entityId}/journals`, {
      headers: ORIGIN_HEADERS,
      data: {
        date: "2026-10-31",
        lines: [
          { side: "debit", accountId: idOf("普通預金"), amount: 500000 },
          { side: "credit", accountId: idOf("売上高"), amount: 500000 },
        ],
      },
    });
    expect(journal.status()).toBe(201);
    journalId = ((await journal.json()) as { id: string }).id;
    expect(journalId).not.toBe("");
  });

  await test.step("スマホの幅にする。ヘッダーはロゴ・事業体の名前・メニューのボタンだけ", async () => {
    await page.setViewportSize(MOBILE);
    await page.goto(`/e/${entityId}`);
    const header = page.getByRole("banner");
    await expect(header.getByRole("button", { name: "メニュー", exact: true })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    await expect(header.getByRole("link", { name: "設定", exact: true })).toHaveCount(0);
    await expect(
      header.getByRole("button", { name: "施錠してサインアウト", exact: true }),
    ).toHaveCount(0);
    await expectFits(page, "ホーム");
  });

  await test.step("メニューの Sheet を開いたままでも、はみ出さない。項目は対象の画面と設定・施錠", async () => {
    await page.getByRole("banner").getByRole("button", { name: "メニュー", exact: true }).click();
    const sheet = page.getByRole("dialog", { name: "メニュー", exact: true });
    await expect(sheet).toBeVisible();
    for (const name of ["ホーム", "仕訳の一覧", "証憑を追加", "証憑の一覧", "帳票", "設定"]) {
      await expect(sheet.getByRole("link", { name, exact: true })).toBeVisible();
    }
    await expect(
      sheet.getByRole("button", { name: "施錠してサインアウト", exact: true }),
    ).toBeVisible();
    await expect(sheet.getByRole("link", { name: "請求の流れ", exact: true })).toHaveCount(0);
    await expectNoHorizontalOverflow(page, "メニュー");
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
  });

  await test.step("証憑を追加する（画面と、追加の結果）", async () => {
    await openFromMenu(page, "証憑を追加");
    await expectFits(page, "証憑を追加");
    const form = page.getByRole("form", { name: "証憑を追加", exact: true });
    await form.getByLabel("ファイルを選ぶ", { exact: true }).setInputFiles({
      name: "mobile-check.png",
      mimeType: "image/png",
      buffer: PNG_1X1,
    });
    await form.getByRole("button", { name: "追加する", exact: true }).click();
    const results = page.getByRole("list", { name: "追加の結果", exact: true });
    await expect(results.getByText("追加しました。", { exact: true })).toBeVisible();
    await expectNoHorizontalOverflow(page, "証憑を追加（追加の結果）");
  });

  await test.step("証憑の詳細", async () => {
    await page
      .getByRole("list", { name: "追加の結果", exact: true })
      .getByRole("link", { name: "証憑を開く", exact: true })
      .click();
    await expectFits(page, "証憑");
  });

  await test.step("証憑の一覧", async () => {
    await openFromMenu(page, "証憑の一覧");
    await expectFits(page, "証憑");
    await expect(page.getByRole("table", { name: "証憑の一覧", exact: true })).toBeVisible();
    await expectNoHorizontalOverflow(page, "証憑の一覧（表）");
  });

  await test.step("仕訳の一覧と、仕訳の中身", async () => {
    await openFromMenu(page, "仕訳の一覧");
    await expectFits(page, "仕訳");
    await expect(page.getByRole("table", { name: "仕訳の一覧", exact: true })).toBeVisible();
    await expectNoHorizontalOverflow(page, "仕訳の一覧（表）");

    await page.goto(`/e/${entityId}/journals/${journalId}`);
    await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
    await expect(page.getByRole("table", { name: "仕訳の内容", exact: true })).toBeVisible();
    await expectNoHorizontalOverflow(page, "仕訳の中身");
  });

  await test.step("帳票（損益計算書・貸借対照表・試算表・総勘定元帳・仕訳帳）", async () => {
    await openFromMenu(page, "帳票");
    await expectFits(page, "損益計算書");
    const reports = [
      ["balance-sheet", "貸借対照表"],
      ["trial-balance", "残高試算表"],
      ["general-ledger", "総勘定元帳"],
      ["journal-book", "仕訳帳"],
    ] as const;
    for (const [path, title] of reports) {
      await page.goto(`/e/${entityId}/reports/${path}`);
      await expectFits(page, title);
    }
  });

  await test.step("設定（メニューの「設定」から、セキュリティ・バックアップ・AI・リモート）", async () => {
    await openFromMenu(page, "設定");
    await expectFits(page, "セキュリティ");
    const nav = page.getByRole("navigation", { name: "設定のメニュー", exact: true });
    for (const title of ["バックアップ", "AI", "リモート"]) {
      await nav.getByRole("link", { name: title, exact: true }).click();
      await expectFits(page, title);
    }
  });

  await test.step("メニューから施錠してサインアウトの確認に届く（押してもやめる）", async () => {
    await page.getByRole("banner").getByRole("button", { name: "メニュー", exact: true }).click();
    const sheet = page.getByRole("dialog", { name: "メニュー", exact: true });
    await sheet.getByRole("button", { name: "施錠してサインアウト", exact: true }).click();
    const confirm = page.getByRole("dialog", { name: "施錠してサインアウト", exact: true });
    await expect(confirm).toBeVisible();
    await expectNoHorizontalOverflow(page, "施錠の確認");
    await confirm.getByRole("button", { name: "やめる", exact: true }).click();
    await expect(confirm).toBeHidden();
  });

  await test.step("対象の外の画面（請求）には「PC での操作を推奨」が出て、はみ出さない。事業体のメニューで移れる", async () => {
    await page.goto(`/e/${entityId}/invoices`);
    await expect(page.getByRole("note").filter({ hasText: "PC での操作を推奨" })).toHaveCount(1);
    await expect(
      page.getByRole("navigation", { name: "事業体のメニュー", exact: true }),
    ).toBeVisible();
    await expectNoHorizontalOverflow(page, "請求（PC の推奨）");
  });
});
