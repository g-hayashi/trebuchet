import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { type BrowserContext, expect, type Locator, type Page, test } from "@playwright/test";
import { renderSVG } from "uqr";
import { enterVault } from "./helpers/auth.ts";
import { openNav } from "./helpers/nav.ts";

/**
 * 宣伝動画の録画（`pnpm promo:record`。変換は `scripts/promo-encode.ts`）。
 * `PROMO_LANG=ja|en` で字幕を切り替える。画面は日本語のまま。
 * 手順: 録画しない context で解錠 → storageState を渡した録画用の context で本編を撮る。
 * 各場面の開始時刻（録画の開始からの ms）と、削る区間を `.tmp/promo/<lang>/timeline.json` に書く。
 *
 * AI は呼ばない。`page.route` で、決まった架空の応答に差し替える:
 * - GET /api/settings/ai（AI が有効に見える設定）
 * - POST /api/entities/:id/statements/infer と、明細の一覧の候補、承認の draft（明細の仕訳の案）
 * - POST /api/entities/:id/receipts/:id/readings と、証憑の詳細の readings（証憑の読み取り）
 * - POST /api/entities/:id/journals/ai-suggestion（仕訳の入力の AI の候補。押さないが、実際の呼び出しを防ぐ）
 * - GET /api/settings/remote/tailscale（接続済みの架空の名前。実機の名前を映さない）
 * 一覧・詳細の応答は実サーバーの応答に候補を足す。承認・取込・証憑の追加は実サーバーが行う。
 */

type Lang = "ja" | "en";
const langEnv = process.env.PROMO_LANG ?? "ja";
if (langEnv !== "ja" && langEnv !== "en") {
  throw new Error(`PROMO_LANG は ja か en にしてください: ${langEnv}`);
}
const LANG: Lang = langEnv;

const CAPTIONS = {
  intro: {
    ja: "個人事業主のための、手元で完結する会計アプリ",
    en: "Bookkeeping for sole proprietors, fully on your Mac",
  },
  entry: { ja: "毎日の記帳は、かんたん入力で", en: "Quick entry for everyday bookkeeping" },
  statements: {
    ja: "銀行やカードの明細から、仕訳の案を作成",
    en: "Turn bank and card statements into journal entries",
  },
  receipt: {
    ja: "領収書は撮るだけで読み取り",
    en: "Snap a receipt, it reads the details",
  },
  invoices: {
    ja: "請求書も、青色申告決算書も",
    en: "Invoices and blue-return statements",
  },
  mobile: {
    ja: "スマホからも、Tailscale で安全に",
    en: "Use it from your phone, securely over Tailscale",
  },
  closing: {
    ja: "データは、あなたの Mac の中だけに",
    en: "Your data never leaves your Mac",
  },
} satisfies Record<string, Record<Lang, string>>;

const root = resolve(import.meta.dirname, "../../..");
const outDir = resolve(root, ".tmp/promo", LANG);
const SIZE = { width: 1280, height: 720 };
const TZ = "Asia/Tokyo";
const FONT =
  '"Hiragino Sans","Hiragino Kaku Gothic ProN","Noto Sans JP","Yu Gothic",system-ui,sans-serif';

// ---- 字幕（画面の下の半透明の帯。DOM に足す。再読み込みしても sessionStorage で保つ） ----

/**
 * ブラウザの中で動く（自己完結の関数。外の変数は使えない）。`next` が文字列なら字幕を替え、null なら消す。
 * 省略なら、保存してある字幕を描くだけ（init script がページの読み込みのたびに呼ぶ）。
 * iframe の中（スマホの場面）には出さない
 */
function renderCaption(next?: string | null): void {
  if (window.top !== window) return;
  const key = "__promo_caption";
  try {
    if (next === null) sessionStorage.removeItem(key);
    else if (typeof next === "string") sessionStorage.setItem(key, next);
  } catch {
    // sessionStorage が使えない文書では、字幕を保たない
  }
  let text: string | null = null;
  try {
    text = sessionStorage.getItem(key);
  } catch {
    text = null;
  }
  let element = document.getElementById("promo-caption");
  if (!text) {
    element?.remove();
    return;
  }
  if (!element) {
    element = document.createElement("div");
    element.id = "promo-caption";
    element.style.cssText = [
      "position:fixed",
      "left:0",
      "right:0",
      "bottom:0",
      "z-index:2147483647",
      "box-sizing:border-box",
      "padding:20px 48px 24px",
      "background:rgba(15,23,42,0.78)",
      "color:#fff",
      'font:600 28px/1.35 "Hiragino Sans","Hiragino Kaku Gothic ProN","Noto Sans JP","Yu Gothic",system-ui,sans-serif',
      "letter-spacing:0.02em",
      "text-align:center",
      "pointer-events:none",
    ].join(";");
    (document.body ?? document.documentElement).append(element);
  }
  element.textContent = text;
}

const setCaption = (page: Page, text: string | null) => page.evaluate(renderCaption, text);

// ---- 日付 ----

const ymd = (date: Date) => new Intl.DateTimeFormat("sv-SE", { timeZone: TZ }).format(date); // YYYY-MM-DD

/** `YYYY-MM-DD` に日数を足す（UTC の暦で計算する。時刻の影響を受けない） */
function addDaysTo(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** 明細・仕訳の日付。デモ事業の年度（作成日の月が 3 月以上なら今年、1・2 月なら前の年）に収める */
function recentDates(today: string): string[] {
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  const fiscalYear = month < 3 ? year - 1 : year;
  return fiscalYear === year
    ? [-2, -4, -6, -8].map((n) => addDaysTo(today, n))
    : [`${fiscalYear}-12-24`, `${fiscalYear}-12-22`, `${fiscalYear}-12-20`, `${fiscalYear}-12-18`];
}

// ---- 架空の AI の応答の材料 ----

type Draft = {
  date: string;
  memo: string;
  lines: {
    side: "debit" | "credit";
    accountId: string;
    subAccountId?: string;
    amount: number;
    taxCategory?: string;
  }[];
};

/** 貼り付ける明細（デモ事業の取込元と同じ見出し。同じ形なので、列の対応は飛ばされる） */
const STATEMENT_ROWS = [
  { content: "クラウドサーバー利用料 デモ社", out: 3_300, account: "通信費", confidence: 94 },
  { content: "コピー用紙 サンプル文具店", out: 1_980, account: "消耗品費", confidence: 91 },
  { content: "電車 新宿から渋谷", out: 1_240, account: "旅費交通費", confidence: 88 },
] as const;

const RECEIPT = { partnerName: "デモ文具店", amount: 2_480, accountName: "消耗品費" } as const;

const TAILSCALE_NAME = "demo-mac.example.ts.net";

type Account = { id: string; code: string; name: string };
type StatementAccount = {
  name: string;
  accountId: string | null;
  subAccountId: string | null;
};

type Mocks = {
  /** 明細の内容 → 架空の AI の案（承認の draft にもなる） */
  suggestions: Map<string, { draft: Draft; confidence: number; reason: string }>;
  /** 明細の ID → 案。一覧に候補を足したときに覚え、承認のときに draft として足す */
  drafts: Map<string, Draft>;
  /** 架空の読み取りの結果（証憑の取引日・金額・取引先・科目・税区分） */
  receipt?: { transactionDate: string; accountCode: string | null } | undefined;
};

const json = (value: unknown) => ({
  status: 200,
  contentType: "application/json",
  body: JSON.stringify(value),
});

function fakeReading(mocks: Mocks, readAt: string) {
  return {
    id: "00000000-0000-4000-8000-0000000000a1",
    readAt,
    model: "demo-vision",
    status: "succeeded",
    errorCode: null,
    candidates: {
      transactionDate: mocks.receipt?.transactionDate ?? null,
      amount: RECEIPT.amount,
      partnerName: RECEIPT.partnerName,
      accountCode: mocks.receipt?.accountCode ?? null,
      taxCategory: "PURCHASE_10",
    },
    confidence: 93,
    reason: "レシートの印字から読み取りました",
  };
}

async function installMocks(context: BrowserContext, mocks: Mocks) {
  // Tailscale: 接続済みの架空の名前（外部環境の情報を映さない）
  await context.route("**/api/settings/remote/tailscale", (route) =>
    route.request().method() === "GET"
      ? route.fulfill(
          json({ installed: true, running: true, dnsName: TAILSCALE_NAME, serving: true }),
        )
      : route.fallback(),
  );

  // AI の設定: 端末内・外部・証憑の画像の送信がすべて有効に見える（外部へは何も送らない）
  await context.route("**/api/settings/ai", (route) =>
    route.request().method() === "GET"
      ? route.fulfill(
          json({
            localEnabled: true,
            localAvailable: true,
            externalEnabled: true,
            externalBaseUrl: "https://ai.example.invalid/v1",
            externalModel: "demo-model",
            receiptImagesEnabled: true,
            apiKeySet: true,
          }),
        )
      : route.fallback(),
  );

  // 仕訳の入力の AI の候補（押さないが、実際の呼び出しを防ぐ）
  await context.route(/\/api\/entities\/[^/]+\/journals\/ai-suggestion$/, (route) =>
    route.fulfill(json({ suggestion: null, reason: "デモでは使いません" })),
  );

  // 明細の推定: 少し待って、端末内の AI で推定したことにする（案は一覧の応答に足す）
  await context.route(/\/api\/entities\/[^/]+\/statements\/infer$/, async (route) => {
    const body = route.request().postDataJSON() as { statementIds: string[] };
    await new Promise((done) => setTimeout(done, 1_600));
    await route.fulfill(
      json({
        results: body.statementIds.map((statementId) => ({
          statementId,
          method: "local_ai",
          confidence: 92,
        })),
        localAvailable: true,
        externalUsed: false,
      }),
    );
  });

  // 明細の一覧: 候補のない新しい明細に、架空の AI の案を足す（実サーバーの応答をもとにする）
  await context.route(/\/api\/entities\/[^/]+\/statements(\?.*)?$/, async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const response = await route.fetch();
    const body = (await response.json()) as {
      statements: {
        id: string;
        content: string;
        status: string;
        candidate: { method: string } | null;
      }[];
    };
    for (const statement of body.statements) {
      const suggestion = mocks.suggestions.get(statement.content);
      const open = statement.candidate === null || statement.candidate.method === "none";
      if (suggestion === undefined || statement.status !== "unprocessed" || !open) continue;
      mocks.drafts.set(statement.id, suggestion.draft);
      Object.assign(statement, {
        candidate: {
          method: "local_ai",
          purpose: "business",
          confidence: suggestion.confidence,
          reason: suggestion.reason,
          draft: suggestion.draft,
          model: "demo-local",
        },
      });
    }
    return route.fulfill(json(body));
  });

  // 承認: 案は画面の候補（架空）なので、実サーバーへは draft として足して送る
  await context.route(/\/api\/entities\/[^/]+\/statements\/approve-bulk$/, async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const body = route.request().postDataJSON() as {
      items: { statementId: string; draft?: Draft }[];
    };
    for (const item of body.items) {
      const draft = mocks.drafts.get(item.statementId);
      if (item.draft === undefined && draft !== undefined) item.draft = draft;
    }
    return route.continue({ postData: JSON.stringify(body) });
  });

  // 証憑の読み取り: 読み取りの記録を返し、詳細の応答にも足す（今の版の追加の日時と同じ時刻にする）
  await context.route(/\/api\/entities\/[^/]+\/receipts\/[^/]+\/readings$/, async (route) => {
    await new Promise((done) => setTimeout(done, 1_200));
    await route.fulfill({
      ...json({ reading: fakeReading(mocks, new Date().toISOString()) }),
      status: 201,
    });
  });
  await context.route(/\/api\/entities\/[^/]+\/receipts\/[0-9a-f-]{36}$/, async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const response = await route.fetch();
    const body = (await response.json()) as {
      receipt: { currentFile: { addedAt: string }; readings: unknown[] };
    };
    if (mocks.receipt !== undefined) {
      body.receipt.readings = [fakeReading(mocks, body.receipt.currentFile.addedAt)];
    }
    return route.fulfill(json(body));
  });
}

// ---- 合成の画面 ----

const cardStyle = `
  html,body{margin:0;height:100%;background:linear-gradient(135deg,#0f172a,#1e293b);color:#fff;font-family:${FONT}}
  .caption{position:fixed;left:0;right:0;bottom:0;box-sizing:border-box;padding:20px 48px 24px;background:rgba(15,23,42,0.78);font:600 28px/1.35 ${FONT};letter-spacing:.02em;text-align:center}
`;

/** 1280x720 の中に、スマホの枠（390x844 を縮小した iframe）と、横に接続用の QR を並べる */
function mobileHtml(appUrl: string, text: string): string {
  const qr = renderSVG(`https://${TAILSCALE_NAME}/pair?token=demo-only`);
  const labels =
    LANG === "ja"
      ? { scan: "スマホで QR を読み取る", status: "Tailscale 接続済み" }
      : { scan: "Scan with your phone", status: "Tailscale connected" };
  return `<!doctype html><html lang="${LANG}"><head><meta charset="utf-8"><style>
  ${cardStyle}
  .stage{position:absolute;inset:0 0 96px 0;display:flex;align-items:center;justify-content:center;gap:96px}
  .phone{width:258px;height:558px;border:10px solid #0b1220;border-radius:38px;overflow:hidden;background:#fff;box-shadow:0 20px 60px rgba(0,0,0,.5)}
  .phone iframe{width:390px;height:844px;border:0;transform:scale(.66);transform-origin:0 0}
  .qr{display:grid;gap:18px;justify-items:center}
  .qr .box{width:260px;height:260px;box-sizing:border-box;padding:16px;border-radius:20px;background:#fff}
  .qr .box svg{width:100%;height:100%;display:block}
  .qr h2{margin:0;font:700 30px/1.3 ${FONT}}
  .qr .host{font:500 24px/1.3 ui-monospace,Menlo,monospace;color:#cbd5e1}
  .qr .chip{display:flex;align-items:center;gap:10px;padding:6px 16px;border-radius:999px;background:rgba(34,197,94,.18);color:#86efac;font:600 20px/1.3 ${FONT}}
  .qr .chip i{width:12px;height:12px;border-radius:50%;background:#22c55e}
  </style></head><body>
  <div class="stage">
    <div class="phone"><iframe id="phone" src="${appUrl}"></iframe></div>
    <div class="qr">
      <h2>${labels.scan}</h2>
      <div class="box">${qr}</div>
      <div class="host">${TAILSCALE_NAME}</div>
      <div class="chip"><i></i>${labels.status}</div>
    </div>
  </div>
  <div class="caption" id="composite-caption">${text}</div>
  </body></html>`;
}

/** 締めのカード（アプリ名と一言） */
function closingHtml(text: string): string {
  return `<!doctype html><html lang="${LANG}"><head><meta charset="utf-8"><style>
  ${cardStyle}
  .card{position:absolute;inset:0;display:grid;place-content:center;gap:28px;text-align:center}
  .card h1{margin:0;font:800 120px/1.1 ${FONT};letter-spacing:.04em}
  .card p{margin:0;font:600 40px/1.4 ${FONT};color:#e2e8f0}
  </style></head><body><div class="card"><h1>Trebuchet</h1><p>${text}</p></div></body></html>`;
}

/** 領収書の合成の画像（読み取りの架空の結果と同じ値） */
function receiptHtml(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><style>
  html,body{margin:0;background:#f3f4f6;font-family:${FONT};color:#111}
  .paper{width:420px;height:560px;margin:40px auto;box-sizing:border-box;padding:32px 36px;background:#fff;box-shadow:0 2px 12px rgba(0,0,0,.2)}
  h1{margin:0 0 4px;font-size:30px;text-align:center}
  .sub{text-align:center;color:#555;font-size:15px;margin-bottom:20px}
  .row{display:flex;justify-content:space-between;font-size:20px;margin:10px 0}
  hr{border:0;border-top:2px dashed #999;margin:18px 0}
  .total{font-size:28px;font-weight:700}
  </style></head><body><div class="paper">
  <h1>領収書</h1><div class="sub">${RECEIPT.partnerName}（架空の店舗）</div>
  <div class="row"><span>日付</span><span>${y}年${m}月${d}日</span></div><hr>
  <div class="row"><span>コピー用紙 A4</span><span>1,480円</span></div>
  <div class="row"><span>ボールペン 3本</span><span>1,000円</span></div><hr>
  <div class="row total"><span>合計（税込）</span><span>${RECEIPT.amount.toLocaleString("en-US")}円</span></div>
  <div class="sub" style="margin-top:28px">ありがとうございました</div>
  </div></body></html>`;
}

// ---- 本編 ----

test(`宣伝動画を録画する（${LANG}）`, async ({ browser, baseURL }) => {
  await rm(outDir, { recursive: true, force: true });
  await mkdir(resolve(outDir, "raw"), { recursive: true });
  const today = ymd(new Date());
  const dates = recentDates(today);
  const date0 = dates[0] as string;
  const receiptFile = resolve(outDir, "synthetic-receipt.png");

  // 1. 録画しない context で解錠し、領収書の合成の画像を作る
  const setup = await browser.newContext({
    baseURL: baseURL ?? "http://localhost:5173",
    locale: "ja-JP",
    timezoneId: TZ,
    viewport: SIZE,
  });
  const setupPage = await setup.newPage();
  await enterVault(setupPage);
  await setupPage.setContent(receiptHtml(date0));
  await setupPage.screenshot({ path: receiptFile, clip: { x: 0, y: 0, width: 500, height: 640 } });
  const storageState = await setup.storageState();
  await setup.close();

  // 2. 録画用の context
  const context = await browser.newContext({
    baseURL: baseURL ?? "http://localhost:5173",
    locale: "ja-JP",
    timezoneId: TZ,
    viewport: SIZE,
    storageState,
    recordVideo: { dir: resolve(outDir, "raw"), size: SIZE },
  });
  const mocks: Mocks = { suggestions: new Map(), drafts: new Map() };
  await installMocks(context, mocks);
  await context.addInitScript(
    `(() => { const render = (${renderCaption.toString()}); const run = () => render(); if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", run); else run(); })();`,
  );

  const t0 = Date.now();
  const page = await context.newPage();
  const now = () => Date.now() - t0;
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") pageErrors.push(message.text());
  });

  // 場面の開始時刻と、削る区間。場面は、削った分を除いて目標の長さまで待って終える
  const scenes: { id: string; startMs: number; targetMs: number }[] = [];
  const cuts: { startMs: number; endMs: number }[] = [];
  let sceneStart = 0;
  let sceneTarget = 0;
  let sceneCut = 0;
  const cutTotal = () => cuts.reduce((sum, c) => sum + (c.endMs - c.startMs), 0);
  const beginScene = async (id: keyof typeof CAPTIONS, targetMs: number) => {
    sceneStart = now();
    sceneTarget = targetMs;
    sceneCut = cutTotal();
    scenes.push({ id, startMs: sceneStart, targetMs });
    await setCaption(page, CAPTIONS[id][LANG]);
  };
  /** 場面の開始から目標の長さになるまで待つ（先に長さを超えていたら、そのまま進む） */
  const holdScene = async (elapsedMs: number) => {
    const rest = sceneStart + elapsedMs + (cutTotal() - sceneCut) - now();
    if (rest > 0) await page.waitForTimeout(rest);
  };
  const endScene = async () => {
    const over = now() - (sceneStart + sceneTarget + (cutTotal() - sceneCut));
    if (over > 0) console.warn(`場面 ${scenes.at(-1)?.id}: 目標より ${over} ms 長い`);
    await holdScene(sceneTarget);
  };

  const main = (): Locator => page.getByRole("main", { exact: true });
  const pause = (ms: number) => page.waitForTimeout(ms);

  // ---- 0〜3 秒: 空の一覧で「デモ事業を作って試す」 ----
  await page.goto("/");
  const demoButton = main().getByRole("button", { name: "デモ事業を作って試す", exact: true });
  await expect(demoButton).toBeVisible();
  await beginScene("intro", 3_000);
  await pause(1_700);
  const clickedAt = now();
  await demoButton.click();
  await page.waitForURL(/\/e\/[0-9a-f-]{36}$/, { timeout: 120_000 });
  await expect(main().getByText("今日やること", { exact: true })).toBeVisible({ timeout: 30_000 });
  // 定期仕訳の知らせは各画面の上を占めるので、削る区間の中で閉じる
  const recurringNotice = page.getByRole("region", { name: "定期仕訳の知らせ", exact: true });
  // 知らせは仕訳の自動登録の後に出るので、現れるまで少し待つ
  await recurringNotice.waitFor({ state: "visible", timeout: 8_000 }).catch(() => undefined);
  if (await recurringNotice.isVisible()) {
    await recurringNotice.getByRole("button", { name: "確認した", exact: true }).click();
    await expect(recurringNotice).toBeHidden();
  }
  // デモ事業を作っている間（待ち）は動画から削る
  const cutStart = clickedAt + 600;
  const cutEnd = now() - 400;
  if (cutEnd > cutStart) cuts.push({ startMs: cutStart, endMs: cutEnd });
  await endScene();

  const entityId = new URL(page.url()).pathname.split("/")[2] as string;
  const entityRoot = `/e/${entityId}`;

  // 架空の AI の案の材料（実サーバーの科目・口座の ID を使い、承認は実サーバーが行う）
  const accounts = (
    (await (await page.request.get(`/api/entities/${entityId}/accounts`)).json()) as {
      accounts: Account[];
    }
  ).accounts;
  const accountNamed = (name: string): Account => {
    const found = accounts.find((a) => a.name === name);
    if (found === undefined) throw new Error(`科目がありません: ${name}`);
    return found;
  };
  const statementAccounts = (
    (await (await page.request.get(`/api/entities/${entityId}/statement-accounts`)).json()) as {
      accounts: StatementAccount[];
    }
  ).accounts;
  const bank = statementAccounts.find((a) => a.name === "サンプル銀行");
  if (bank?.accountId == null) throw new Error("取込元の口座（サンプル銀行）の科目がありません");
  const bankAccountId = bank.accountId;
  for (const [index, row] of STATEMENT_ROWS.entries()) {
    const date = dates[index] as string;
    mocks.suggestions.set(row.content, {
      confidence: row.confidence,
      reason: `摘要から「${row.account}」と推定しました`,
      draft: {
        date,
        memo: row.content,
        lines: [
          { side: "debit", accountId: accountNamed(row.account).id, amount: row.out },
          {
            side: "credit",
            accountId: bankAccountId,
            ...(bank.subAccountId === null ? {} : { subAccountId: bank.subAccountId }),
            amount: row.out,
            taxCategory: "OUT_OF_SCOPE",
          },
        ],
      },
    });
  }
  mocks.receipt = {
    transactionDate: date0,
    accountCode: accountNamed(RECEIPT.accountName).code,
  };
  const invoices = (
    (await (await page.request.get(`/api/entities/${entityId}/invoices`)).json()) as {
      invoices: { invoiceNo: string }[];
    }
  ).invoices;
  const invoiceNo = invoices[0]?.invoiceNo;
  if (invoiceNo === undefined) throw new Error("デモ事業に請求書がありません");

  // ---- 3〜8 秒: ホーム → かんたん入力で 1 件を登録 ----
  await beginScene("entry", 5_000);
  await holdScene(1_200);
  await openNav(page, "仕訳", "入力する");
  await expect(main().getByRole("button", { name: "かんたん入力", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await main().getByLabel("日付", { exact: true }).fill(date0);
  for (const [label, name] of [
    ["借方科目", "消耗品費"],
    ["貸方科目", "現金"],
  ] as const) {
    await main().getByRole("combobox", { name: label, exact: true }).fill(name);
    await main()
      .getByRole("option", { name: new RegExp(`^\\d+ ${name}$`) })
      .click();
    await pause(250);
  }
  await main().getByLabel("金額", { exact: true }).pressSequentially("1980", { delay: 90 });
  await main().getByLabel("摘要", { exact: true }).pressSequentially("コピー用紙", { delay: 90 });
  await pause(400);
  await main().getByRole("button", { name: "登録", exact: true }).click();
  await expect(main().getByRole("status", { name: "登録の結果", exact: true })).toContainText(
    "を登録しました",
  );
  await endScene();

  // ---- 8〜13 秒: 明細の CSV を貼る → 仕訳の案（AI）→ 承認 ----
  await beginScene("statements", 5_000);
  await openNav(page, "明細", "取り込む");
  await expect(main().getByRole("heading", { name: "明細の取込", exact: true })).toBeVisible();
  const csv = `${[
    '"取引日","摘要","出金額","入金額"',
    ...STATEMENT_ROWS.map((row, index) =>
      [
        `"${(dates[index] as string).replaceAll("-", "/")}"`,
        `"${row.content}"`,
        `"${row.out}"`,
        '""',
      ].join(","),
    ),
  ].join("\n")}\n`;
  const input = main().getByRole("region", { name: "入力", exact: true });
  await input.getByLabel("貼り付けのテキスト", { exact: true }).fill(csv);
  await pause(500);
  await input.getByRole("button", { name: "読み取る", exact: true }).click();
  const preview = main().getByRole("region", { name: "プレビュー", exact: true });
  const importButton = preview.getByRole("button", { name: "取り込む", exact: true });
  await expect(importButton).toBeEnabled({ timeout: 30_000 });
  await pause(400);
  await importButton.click();
  await expect(main().getByRole("status", { name: "候補の作成の進み", exact: true })).toBeVisible();
  const rowCheckbox = (content: string) =>
    main().getByRole("checkbox", { name: `${content} を選択`, exact: true });
  const [first, second] = STATEMENT_ROWS;
  await expect(rowCheckbox(first.content)).toBeVisible({ timeout: 60_000 });
  await expect(main().getByText("端末内の AI", { exact: true }).first()).toBeVisible();
  await pause(900);
  await rowCheckbox(first.content).check();
  await rowCheckbox(second.content).check();
  await pause(300);
  await main().getByRole("button", { name: "選択した 2 件を承認", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "承認する", exact: true }).click();
  await expect(main().getByText("2 件を承認しました。", { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await endScene();

  // ---- 13〜18 秒: 領収書の画像を追加 → 読み取りで値が入る ----
  await beginScene("receipt", 5_000);
  await openNav(page, "証憑", "追加する");
  await main().getByLabel("ファイルを選ぶ", { exact: true }).setInputFiles(receiptFile);
  await main()
    .getByRole("radio", { name: /^紙を撮影/ })
    .check();
  await pause(500);
  await main().getByRole("button", { name: "追加する", exact: true }).click();
  const fields = main().getByRole("region", { name: "追加した証憑の値", exact: true });
  await expect(fields).toBeVisible({ timeout: 30_000 });
  // 読み取った値の欄は画面の下に出るので、見える位置まで送る
  await fields.evaluate((element) =>
    element.scrollIntoView({ behavior: "smooth", block: "center" }),
  );
  await expect(fields.getByLabel("取引年月日", { exact: true })).toHaveValue(date0, {
    timeout: 30_000,
  });
  await pause(1_800);
  await endScene();

  // ---- 18〜24 秒: 請求書の一覧と詳細（3 秒）→ 青色申告決算書（3 秒） ----
  await beginScene("invoices", 6_000);
  await page.goto(`${entityRoot}/invoices`);
  const invoiceLink = main().getByRole("link", { name: invoiceNo, exact: true });
  await expect(invoiceLink).toBeVisible();
  await pause(900);
  await invoiceLink.click();
  await page.waitForURL((url) => url.pathname.startsWith(`${entityRoot}/invoices/`));
  await expect(main().getByRole("heading", { level: 1 })).toBeVisible();
  await holdScene(3_000);
  // 1 段目の「決算・申告」だけを押す（決算書の画面で 2 段目の「決算書」を押し直すと、入口の転送が進まない）
  await openNav(page, "決算・申告");
  // 決算書は初回の読み込みが遅いことがある。待ちは動画から削る
  const blueReturnWaitStart = now() + 300;
  const blueReturnHeading = main().getByRole("heading", { name: /^青色申告決算書 \d{4}年分$/ });
  try {
    await expect(blueReturnHeading).toBeVisible({ timeout: 6_000 });
  } catch {
    // 調査用: 入口（/blue-return）の転送が進まないときの状態を出し、年度の URL を直接開く
    console.warn("決算書が出ない:", {
      url: page.url(),
      mains: await page.locator("main").count(),
      errors: pageErrors,
    });
    const year =
      new Date().getMonth() + 1 >= 3 ? new Date().getFullYear() : new Date().getFullYear() - 1;
    await page.goto(`${entityRoot}/blue-return/${year}`);
    await expect(blueReturnHeading).toBeVisible({ timeout: 20_000 });
  }
  const blueReturnWaitEnd = now() - 300;
  if (blueReturnWaitEnd > blueReturnWaitStart)
    cuts.push({ startMs: blueReturnWaitStart, endMs: blueReturnWaitEnd });
  await endScene();

  // ---- 24〜28 秒: スマホの幅（390px）の画面と、接続用の QR ----
  await beginScene("mobile", 4_000);
  await page.goto("/settings/remote");
  await expect(main().getByText(TAILSCALE_NAME, { exact: true }).first()).toBeVisible();
  await holdScene(1_400);
  // 1280x720 の中に、スマホの枠（iframe）と QR を並べた合成ページ（同じオリジンのまま差し替える）
  await setCaption(page, null);
  await page.setContent(
    mobileHtml(`${new URL(page.url()).origin}${entityRoot}`, CAPTIONS.mobile[LANG]),
    { waitUntil: "domcontentloaded" },
  );
  await expect(page.frameLocator("#phone").locator("main")).toBeVisible({ timeout: 30_000 });
  await endScene();

  // ---- 28〜30 秒: 締めのカード ----
  await beginScene("closing", 2_000);
  await setCaption(page, null);
  await page.setContent(closingHtml(CAPTIONS.closing[LANG]));
  await endScene();
  const endMs = now();

  await writeFile(
    resolve(outDir, "timeline.json"),
    `${JSON.stringify({ lang: LANG, scenes, cuts, endMs }, null, 2)}\n`,
  );

  const video = page.video();
  await context.close();
  if (video === null) throw new Error("録画がありません");
  await copyFile(await video.path(), resolve(outDir, "video.webm"));
  console.log(`録画: ${resolve(outDir, "video.webm")}（${endMs} ms、削る区間 ${cuts.length} 件）`);
});
