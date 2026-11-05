import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { BANK_TWO_COLUMNS } from "../../../packages/domain/test/fixtures/statements/expected.ts";
import { manualSources } from "../../../scripts/lib/manual-sources.ts";
import { manualArticles, manualImages } from "../src/features/manual/content.ts";
import { enterVault } from "./helpers/auth.ts";
import { openNav } from "./helpers/nav.ts";

const root = resolve(import.meta.dirname, "../../..");
const staging = resolve(root, ".tmp/manual-capture");
const output = resolve(root, "apps/web/public/manual");

/** 実画面の上に枠と番号だけを重ねる。本文・ラベル・データは書き換えない。 */
async function capture(page: Page, id: string, targets: Locator[]) {
  console.log(`撮影: ${id}`);
  // 汎用のh1だけを先に測ると、遷移中の旧画面を拾う。固有の操作対象まで揃えてから測る。
  for (const target of targets) await expect(target).toBeVisible();
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  await expect(page.getByText(/^読み込み中(?:…|\.{3})$/)).toHaveCount(0);
  await expect(page.locator(".pointer-events-none.fixed > [role]")).toHaveCount(0, {
    timeout: 7_000,
  });
  const boxes = [];
  for (const [index, target] of targets.entries()) {
    await expect(target).toBeVisible();
    let box = await target.boundingBox();
    await expect
      .poll(async () => {
        box = await target.boundingBox();
        return box !== null;
      })
      .toBe(true);
    if (!box) throw new Error(`${id}: annotation ${index + 1} not found`);
    boxes.push({ ...box, number: index + 1 });
  }
  await page.evaluate((rects) => {
    const layer = document.createElement("div");
    layer.id = "manual-annotations";
    layer.style.cssText = "position:absolute;inset:0;pointer-events:none;z-index:10000";
    for (const rect of rects) {
      const box = document.createElement("div");
      box.style.cssText = `position:absolute;left:${rect.x + window.scrollX - 3}px;top:${rect.y + window.scrollY - 3}px;width:${rect.width + 6}px;height:${rect.height + 6}px;border:2px solid #b91c1c;border-radius:4px`;
      const label = document.createElement("span");
      label.textContent = String(rect.number);
      label.style.cssText =
        "position:absolute;top:-15px;left:0;min-width:24px;height:24px;padding:0 5px;border-radius:4px;background:#b91c1c;color:white;font:bold 16px/24px system-ui;text-align:center";
      box.append(label);
      layer.append(box);
    }
    document.body.append(layer);
  }, boxes);
  try {
    await page.screenshot({
      path: resolve(staging, `${id}.png`),
      fullPage: true,
      animations: "disabled",
    });
  } finally {
    await page.evaluate(() => document.getElementById("manual-annotations")?.remove());
  }
}

test("合成帳簿で手順を操作し、マニュアル画像を再撮影する", async ({ page }) => {
  await mkdir(staging, { recursive: true });
  const sources = Object.fromEntries(
    manualArticles.map((article) => [article.id, manualSources(root, article)]),
  );
  await unlink(resolve(staging, "success.json")).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
  await page.goto("/");
  // Tailscaleだけは外部環境の情報を表示しない合成応答。実接続の検証ではない。
  await page.route("**/api/settings/remote/tailscale", (route) =>
    route.fulfill({
      json: { installed: false, running: false, dnsName: null, serving: false },
    }),
  );
  await capture(page, "start", [page.getByRole("button", { name: "パスキーを作成", exact: true })]);
  await enterVault(page);
  await page.goto("/list");
  const main = () => page.getByRole("main", { exact: true });
  await main().getByRole("textbox", { name: "名称", exact: true }).fill("マニュアル用の合成事業");
  await main().getByLabel("開始年度", { exact: true }).fill("2026");
  await capture(page, "entities", [
    main().getByLabel("名称", { exact: true }),
    main().getByLabel("種別", { exact: true }),
    main().getByRole("button", { name: "作成する", exact: true }),
  ]);
  await main().getByRole("button", { name: "作成する", exact: true }).click();
  await expect(page).toHaveURL(/\/e\/[0-9a-f-]{36}$/);
  const entityId = new URL(page.url()).pathname.split("/")[2];
  const entityRoot = `/e/${entityId}`;
  await capture(page, "home", [
    main().getByText("今日やること", { exact: true }),
    main().getByText("今期の数字", { exact: true }),
  ]);

  // 初期表示から既定のかんたん入力で登録し、その結果を撮る。
  await openNav(page, "仕訳", "入力する");
  await expect(main().getByRole("button", { name: "かんたん入力", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await main().getByLabel("日付", { exact: true }).fill("2026-10-31");
  for (const [label, name] of [
    ["借方科目", "普通預金"],
    ["貸方科目", "売上高"],
  ] as const) {
    await main()
      .getByRole("combobox", { name: label, exact: true })
      .fill(name ?? "");
    await main()
      .getByRole("option", { name: new RegExp(`^\\d+ ${name}$`) })
      .click();
  }
  await main().getByLabel("金額", { exact: true }).fill("12000");
  await main().getByLabel("摘要", { exact: true }).fill("合成サービスの売上");
  await capture(page, "journals", [
    main().getByLabel("日付", { exact: true }),
    main().getByRole("button", { name: "詳細", exact: true }),
  ]);
  await main().getByRole("button", { name: "詳細", exact: true }).click();
  await capture(page, "journals-detailed", [
    main().getByLabel("1行目の勘定科目", { exact: true }),
    main().getByLabel("2行目の勘定科目", { exact: true }),
  ]);
  await main().getByRole("button", { name: "かんたん入力", exact: true }).click();
  // マニュアルを参照しても実際の入力が保たれることを確認。
  await page.getByRole("button", { name: "マニュアル", exact: true }).click();
  const manual = page.getByRole("dialog", { name: "マニュアル", exact: true });
  await manual.getByRole("button", { name: "この画面：仕訳を入力する", exact: true }).click();
  await expect(manual.getByRole("heading", { name: "仕訳を入力する", exact: true })).toBeVisible();
  await manual.getByRole("button", { name: "マニュアルを閉じる", exact: true }).click();
  await expect(main().getByLabel("摘要", { exact: true })).toHaveValue("合成サービスの売上");
  await main().getByRole("button", { name: "登録", exact: true }).click();
  await expect(main().getByRole("status", { name: "登録の結果", exact: true })).toContainText(
    "を登録しました",
  );
  const journals = (await (
    await page.request.get(`/api/entities/${entityId}/journals`)
  ).json()) as { journals: { id: string }[] };
  const journalId = journals.journals[0]?.id;
  expect(journalId).toBeTruthy();
  await page.goto(`${entityRoot}/journals/${journalId}`);
  await capture(page, "journal-detail", [
    main().getByRole("button", { name: "訂正する", exact: true }),
    main().getByRole("button", { name: "取り消す", exact: true }),
  ]);

  // 請求の準備・工数・案の確認・発行を画面から行う。
  await openNav(page, "請求", "請求の設定");
  await main().getByLabel("氏名", { exact: true }).fill("合成 太郎");
  await main().getByLabel("屋号", { exact: true }).fill("マニュアル用合成サービス");
  await main().getByLabel("住所", { exact: true }).fill("合成県合成市1-1（架空）");
  await main().getByLabel("連絡先", { exact: true }).fill("manual@example.test");
  await main().getByLabel("振込先", { exact: true }).fill("合成銀行 合成本店 普通 0000000（架空）");
  await main().getByRole("button", { name: "保存", exact: true }).click();
  await capture(page, "invoice-settings", [
    main().getByLabel("氏名", { exact: true }),
    main().getByRole("button", { name: "保存", exact: true }),
  ]);
  await openNav(page, "事業体の設定", "取引先");
  await main().getByRole("button", { name: "取引先を登録", exact: true }).click();
  const partner = page.getByRole("dialog", { name: "取引先の登録", exact: true });
  await partner.getByLabel("名称", { exact: true }).fill("合成取引先");
  await partner.getByLabel("請求の条件を設定する", { exact: true }).check();
  await partner
    .getByLabel("請求の型", { exact: true })
    .selectOption({ label: "時間単価型（工数 × 単価）" });
  await partner.getByLabel("時間単価（円）", { exact: true }).fill("3000");
  await partner.getByLabel("既定の品名", { exact: true }).fill("合成サービス");
  await partner.getByRole("button", { name: "保存", exact: true }).click();
  await expect(partner).toBeHidden();
  await openNav(page, "請求", "工数");
  await expect(main().getByRole("heading", { name: "工数の入力", exact: true })).toBeVisible();
  await main().getByLabel("対象月", { exact: true }).fill("2026-10");
  await main().getByLabel("合成取引先 の時間", { exact: true }).fill("4");
  await main().getByRole("button", { name: "保存", exact: true }).click();
  await capture(page, "work-hours", [
    main().getByLabel("対象月", { exact: true }),
    main().getByRole("button", { name: "保存", exact: true }),
  ]);
  await openNav(page, "請求", "請求の流れ");
  await main().getByRole("link", { name: "請求書を作る", exact: true }).click();
  await expect(main().getByRole("heading", { name: "請求書を作る", exact: true })).toBeVisible();
  await main().getByLabel("対象月", { exact: true }).fill("2026-10");
  await main().getByRole("button", { name: "内容を確認する", exact: true }).click();
  const draft = main().getByRole("region", { name: "請求書の案（合成取引先）", exact: true });
  await expect(draft).toBeVisible();
  await capture(page, "invoices", [
    main().getByLabel("対象月", { exact: true }),
    draft.getByRole("button", { name: "発行する", exact: true }),
  ]);
  await draft.getByLabel("発行日", { exact: true }).fill("2026-11-01");
  await draft.getByRole("button", { name: "発行する", exact: true }).click();
  await main().getByRole("link", { name: "請求書の一覧へ", exact: true }).click();
  const invoiceList = (await (
    await page.request.get(`/api/entities/${entityId}/invoices`)
  ).json()) as { invoices: { invoiceNo: string }[] };
  const invoiceLink = main().getByRole("link", {
    name: invoiceList.invoices[0]?.invoiceNo ?? "missing",
    exact: true,
  });
  await expect(invoiceLink).toHaveCount(1);
  await invoiceLink.click();
  await capture(page, "payments", [
    main().getByRole("heading", { level: 1 }),
    main().getByRole("heading", { name: "入金を消し込む", exact: true }),
  ]);

  // 原本も合成。別ページで描画してPNGにし、アプリの通常の追加を通す。
  const receiptPage = await page.context().newPage();
  await receiptPage.setContent(
    '<html lang="ja"><body style="font:24px sans-serif;padding:48px"><h1>合成領収書</h1><p>マニュアル撮影専用・架空の取引</p><p>2026年10月31日</p><p>合成取引先　12,000円</p></body></html>',
  );
  const receiptFile = resolve(staging, "synthetic-receipt.png");
  await receiptPage.screenshot({ path: receiptFile });
  await receiptPage.close();
  await openNav(page, "証憑", "追加する");
  await capture(page, "receipts", [
    main().getByLabel("ファイルを選ぶ", { exact: true }),
    main().getByRole("radio", { name: "電子取引", exact: true }),
  ]);
  await main().getByLabel("ファイルを選ぶ", { exact: true }).setInputFiles(receiptFile);
  await main().getByLabel("電子取引", { exact: true }).check();
  await main().getByRole("button", { name: "追加する", exact: true }).click();
  await expect(main().getByRole("region", { name: "追加した証憑の値", exact: true })).toBeVisible();
  const fields = main().getByRole("region", { name: "追加した証憑の値", exact: true });
  await fields.getByLabel("取引年月日", { exact: true }).fill("2026-10-31");
  await fields.getByLabel("金額", { exact: true }).fill("12000");
  await fields.getByLabel("取引先", { exact: true }).fill("合成取引先");
  await capture(page, "receipts-fields", [
    fields.getByLabel("取引年月日", { exact: true }),
    fields.getByRole("button", { name: "保存", exact: true }),
  ]);
  const receiptSaved = page.waitForResponse(
    (response) => response.request().method() === "PATCH" && response.url().includes("/receipts/"),
  );
  await fields.getByRole("button", { name: "保存", exact: true }).click();
  expect((await receiptSaved).status()).toBe(200);
  await main().getByRole("link", { name: "証憑を開く", exact: true }).click();
  await capture(page, "receipt-detail", [
    main().getByRole("heading", { level: 1 }),
    main().getByRole("button", { name: "仕訳に結びつける", exact: true }),
  ]);

  await openNav(page, "明細", "取り込む");
  await expect(main().getByRole("heading", { name: "明細の取込", exact: true })).toBeVisible();
  const input = main().getByRole("region", { name: "入力", exact: true });
  await capture(page, "statements-import", [
    input.getByRole("group", { name: "入力の方法", exact: true }),
    input.getByRole("button", { name: "読み取る", exact: true }),
  ]);
  await input.getByRole("radio", { name: "ファイル", exact: true }).check();
  await input
    .getByLabel("明細のファイル", { exact: true })
    .setInputFiles(
      resolve(root, "packages/domain/test/fixtures/statements", BANK_TWO_COLUMNS.file),
    );
  await input.getByRole("button", { name: "読み取る", exact: true }).click();
  const columns = main().getByRole("region", { name: "列の対応", exact: true });
  await columns
    .getByLabel("取込の口座", { exact: true })
    .selectOption({ label: "新しい名前を入れる" });
  await columns.getByLabel("口座の名前", { exact: true }).fill("合成銀行");
  await capture(page, "statements-columns", [
    columns.getByLabel("「取引日」の役割", { exact: true }),
    columns.getByLabel("取込の口座", { exact: true }),
  ]);
  await columns.getByRole("button", { name: "確認へ", exact: true }).click();
  const preview = main().getByRole("region", { name: "プレビュー", exact: true });
  await preview.getByLabel("合成銀行の用途", { exact: true }).selectOption({ label: "事業用" });
  await preview.getByLabel("合成銀行の種類", { exact: true }).selectOption({ label: "銀行" });
  await preview.getByLabel("合成銀行の科目", { exact: true }).selectOption({ label: "普通預金" });
  await capture(page, "statements-preview", [
    preview.getByLabel("合成銀行の用途", { exact: true }),
    preview.getByRole("button", { name: "取り込む", exact: true }),
  ]);
  await preview.getByRole("button", { name: "取り込む", exact: true }).click();
  await expect(preview).toBeHidden();

  // 残る設定・帳票。読み込み後の実画面と操作対象を記録する。
  const screens: [string, string, (scope: Locator) => Locator[]][] = [
    [
      "recurring",
      "/recurring/new",
      (scope) => [
        scope.getByLabel("毎月の予定日", { exact: true }),
        scope.getByLabel("開始月", { exact: true }),
      ],
    ],
    [
      "statements-review",
      "/statements",
      (scope) => [
        scope.getByRole("heading", { level: 1 }),
        scope.getByRole("combobox", { name: "状態", exact: true }),
      ],
    ],
    [
      "statement-settings",
      "/statements/settings",
      (scope) => [
        scope.getByRole("heading", { name: "取込元", exact: true }),
        scope.getByRole("button", { name: "保存", exact: true }),
      ],
    ],
    [
      "reports",
      "/reports/profit-and-loss",
      (scope) => [
        scope.getByRole("combobox", { name: "会計期間", exact: true }),
        scope.getByLabel("開始日", { exact: true }),
      ],
    ],
    [
      "blue-return",
      "/blue-return/2026",
      (scope) => [
        scope.getByLabel("年度", { exact: true }),
        scope.getByRole("button", { name: "印刷", exact: true }),
      ],
    ],
    [
      "home-use",
      "/blue-return/2026/home-use",
      (scope) => [
        scope.getByRole("combobox", { name: "科目", exact: true }),
        scope.getByLabel("事業専用割合（%）", { exact: true }),
      ],
    ],
    [
      "fixed-assets",
      "/fixed-assets",
      (scope) => [
        scope.getByText("固定資産の登録", { exact: true }),
        scope.getByLabel("年分", { exact: true }),
      ],
    ],
    [
      "deferred-assets",
      "/deferred-assets",
      (scope) => [
        scope.getByText("開業費の登録", { exact: true }),
        scope.getByLabel("年分", { exact: true }),
      ],
    ],
    [
      "masters",
      "/settings",
      (scope) => [
        page.getByRole("navigation", { name: "事業体のサブメニュー", exact: true }),
        scope.getByRole("button", { name: "変更する", exact: true }),
      ],
    ],
    [
      "periods",
      "/periods",
      (scope) => [
        scope.getByRole("region", { name: "2026年度", exact: true }),
        scope.getByRole("button", { name: "翌年度を作成", exact: true }),
      ],
    ],
    [
      "freee",
      "/imports/new",
      (scope) => [
        scope.getByRole("heading", { level: 1 }),
        scope.getByLabel("仕訳帳のファイル", { exact: true }),
      ],
    ],
    [
      "tax-settings",
      "/tax-settings",
      (scope) => [
        scope.getByLabel("課税区分", { exact: true }),
        scope.getByLabel("経理方式", { exact: true }),
        scope.getByRole("button", { name: "追加して保存", exact: true }),
      ],
    ],
  ];
  const captureFailures: string[] = [];
  for (const [id, path, targets] of screens) {
    await page.goto(`${entityRoot}${path}`);
    try {
      await capture(page, id, targets(main()));
    } catch (error) {
      console.error(`${id}: ${String(error).slice(0, 1600)}`);
      const controls = await main().evaluate((element) =>
        [...element.querySelectorAll("label,button,h1,h2,h3,[data-slot=card-title]")]
          .map((node) => node.textContent?.trim())
          .filter(Boolean),
      );
      captureFailures.push(`${id}: ${JSON.stringify(controls)}`);
    }
  }
  for (const id of ["security", "backup", "ai", "remote"]) {
    await page.goto(`/settings/${id}`);
    const targets =
      id === "security"
        ? [
            main().getByRole("heading", { name: "パスキー", exact: true }),
            main().getByRole("heading", { name: "回復キー", exact: true }),
          ]
        : id === "backup"
          ? [
              main().getByLabel("置き場所", { exact: true }),
              main().getByRole("button", { name: "今すぐバックアップ", exact: true }),
            ]
          : id === "ai"
            ? [
                main().getByLabel("端末内の AI を使う", { exact: true }),
                main().getByRole("button", { name: "保存", exact: true }),
              ]
            : [
                main().getByText("Tailscale", { exact: true }),
                main().getByLabel("リモートを有効にする", { exact: true }),
              ];
    try {
      await capture(page, id, targets);
    } catch (error) {
      console.error(`${id}: ${String(error).slice(0, 1600)}`);
      const controls = await main().evaluate((element) =>
        [...element.querySelectorAll("label,button,h1,h2,h3,[data-slot=card-title]")]
          .map((node) => node.textContent?.trim())
          .filter(Boolean),
      );
      captureFailures.push(`${id}: ${JSON.stringify(controls)}`);
    }
  }
  expect(captureFailures, captureFailures.join("\n")).toEqual([]);

  // 削除の確認も合成の別組織だけを対象にし、保持する帳簿は消さない。
  await page.goto("/list");
  await main().getByLabel("名称", { exact: true }).fill("削除確認用の合成事業");
  await main().getByRole("button", { name: "作成する", exact: true }).click();
  await expect(page).toHaveURL(/\/e\/[0-9a-f-]{36}$/);
  await page.goto("/list");
  const row = main()
    .getByRole("row", { exact: true })
    .filter({ has: page.getByRole("link", { name: "削除確認用の合成事業", exact: true }) });
  await row.getByRole("button", { name: "非表示にする", exact: true }).click();
  await main().getByText("非表示の組織", { exact: true }).click();
  await main().getByRole("button", { name: "完全に削除", exact: true }).click();
  const purge = page.getByRole("dialog", { exact: true });
  await capture(page, "entity-lifecycle", [
    purge.getByLabel("確認の名称", { exact: true }),
    purge.getByRole("button", { name: "完全に削除", exact: true }),
  ]);
  await purge.getByRole("button", { name: "キャンセル", exact: true }).click();

  await mkdir(output, { recursive: true });
  const images: Record<string, string> = {};
  for (const shot of manualArticles.flatMap(manualImages)) {
    const from = resolve(staging, `${shot.image}.png`);
    await copyFile(from, resolve(output, `${shot.image}.png`));
    images[`apps/web/public/manual/${shot.image}.png`] = createHash("sha256")
      .update(await readFile(from))
      .digest("hex");
  }
  // 記事の画像、検索、FAQ、モバイルとPCの表示を確認する。
  for (const viewport of [
    { width: 1280, height: 900 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    await page.getByRole("button", { name: "マニュアル", exact: true }).click();
    await manual
      .getByRole("searchbox", { name: "マニュアルを検索", exact: true })
      .fill("JOURNAL_LINKED");
    await manual.getByRole("button", { name: "仕訳を訂正・取消する", exact: true }).click();
    await expect(manual.getByRole("img")).toHaveJSProperty("naturalWidth", 1280);
    await manual.getByText("JOURNAL_LINKEDで訂正できない", { exact: true }).click();
    await expect(manual.getByText(/請求書の詳細を開き/)).toBeVisible();
    expect(await manual.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    );
    await page.screenshot({ path: resolve(staging, `manual-${viewport.width}.png`) });
    await manual.getByRole("button", { name: "マニュアルを閉じる", exact: true }).click();
    // 開閉で記事の位置を保持する。次の確認のため一覧に戻す。
    await page.getByRole("button", { name: "マニュアル", exact: true }).click();
    await manual.getByRole("button", { name: "目的の一覧へ", exact: true }).click();
    await manual.getByRole("button", { name: "マニュアルを閉じる", exact: true }).click();
  }
  await writeFile(
    resolve(staging, "success.json"),
    `${JSON.stringify({ images, sources }, null, 2)}\n`,
  );
});
