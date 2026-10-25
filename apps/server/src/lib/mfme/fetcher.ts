import { addMonths, monthIndex, type PastedRow } from "@trebuchet/domain";
import { MfmeFetchError, type MfmeFetcher, type MfmeRange } from "../jobs.ts";
import {
  cashFlowUrl,
  isLoggedInUrl,
  LOGIN_URL,
  type MfmeDomPage,
  readCashFlowRows,
} from "./dom.ts";

/**
 * Playwright による MF ME の取得器（006 R13）。見えるウィンドウを開き、ログインと 2 段階認証は利用者が手で行う。
 * 保存しない文脈（`browser.newContext()`）だけを使い、クッキー・パスワードを残さない（FR-009）。
 * `launchPersistentContext` やユーザーデータの場所は使わない。終わったら（成功・失敗とも）必ず閉じる
 */

/** `Page` のうち取得器が使う操作（テストは偽物を渡す） */
export type MfmePage = MfmeDomPage & {
  goto(
    url: string,
    options?: { waitUntil?: "domcontentloaded"; timeout?: number },
  ): Promise<unknown>;
  url(): string;
  isClosed(): boolean;
  on(event: "close", listener: () => void): unknown;
};
export type MfmeContext = { newPage(): Promise<MfmePage>; close(): Promise<void> };
export type MfmeBrowser = {
  newContext(): Promise<MfmeContext>;
  close(): Promise<void>;
  on(event: "disconnected", listener: () => void): unknown;
};
export type LaunchBrowser = (options: { headless: false }) => Promise<MfmeBrowser>;

export type PlaywrightFetcherOptions = {
  /** 既定は Playwright の Chromium。テストは偽の `launch` を渡す */
  launch?: LaunchBrowser;
  /** 月の画面の読み取り。既定は `dom.ts` */
  readRows?: (page: MfmeDomPage, year: number) => Promise<PastedRow[]>;
  /** ログインの完了を待つ最長の時間（既定 5 分） */
  loginTimeoutMs?: number;
  /** ログインの完了を確かめる間隔（既定 1 秒） */
  pollMs?: number;
};

const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const POLL_MS = 1000;

const defaultLaunch: LaunchBrowser = async (options) => {
  const { chromium } = await import("playwright");
  return (await chromium.launch(options)) as unknown as MfmeBrowser;
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** 閉じる失敗は、取得の結果を隠さないよう握りつぶす */
const quietly = async (close: () => Promise<void>) => {
  try {
    await close();
  } catch {
    // 既に閉じている
  }
};

const windowClosed = () =>
  new MfmeFetchError(
    "MFME_WINDOW_CLOSED",
    "ブラウザのウィンドウが閉じられたため、取得を中止しました",
  );

export function createPlaywrightFetcher(options: PlaywrightFetcherOptions = {}): MfmeFetcher {
  const launch = options.launch ?? defaultLaunch;
  const readRows = options.readRows ?? readCashFlowRows;
  const loginTimeoutMs = options.loginTimeoutMs ?? LOGIN_TIMEOUT_MS;
  const pollMs = options.pollMs ?? POLL_MS;

  return {
    async fetch(range: MfmeRange, onStatus) {
      let browser: MfmeBrowser;
      try {
        browser = await launch({ headless: false });
      } catch {
        throw new MfmeFetchError(
          "MFME_BROWSER_UNAVAILABLE",
          "ブラウザを起動できません。`pnpm exec playwright install chromium` を実行するか、貼り付けで取り込んでください",
        );
      }
      let disconnected = false;
      browser.on("disconnected", () => {
        disconnected = true;
      });
      let context: MfmeContext | undefined;
      let page: MfmePage | undefined;
      let pageClosed = false;
      const closed = () => disconnected || pageClosed || page?.isClosed() === true;
      try {
        // 保存しない文脈（storageState も渡さない）
        context = await browser.newContext();
        page = await context.newPage();
        page.on("close", () => {
          pageClosed = true;
        });

        onStatus("waiting_login");
        await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });
        const deadline = Date.now() + loginTimeoutMs;
        while (!isLoggedInUrl(page.url())) {
          if (closed()) throw windowClosed();
          if (Date.now() >= deadline) {
            throw new MfmeFetchError(
              "MFME_LOGIN_TIMEOUT",
              "ログインが完了しませんでした（5 分で時間切れ）。もう一度取得するか、貼り付けで取り込んでください",
            );
          }
          await sleep(pollMs);
        }

        const rows: PastedRow[] = [];
        const total = monthIndex(range.to) - monthIndex(range.from) + 1;
        for (let done = 0; done < total; done++) {
          const month = addMonths(range.from, done);
          onStatus("running", { month, done, total });
          await page.goto(cashFlowUrl(month), { waitUntil: "domcontentloaded" });
          rows.push(...(await readRows(page, Number(month.slice(0, 4)))));
        }
        return rows;
      } catch (e) {
        if (e instanceof MfmeFetchError) throw e;
        if (closed()) throw windowClosed();
        throw e;
      } finally {
        if (context !== undefined) await quietly(() => (context as MfmeContext).close());
        await quietly(() => browser.close());
      }
    },
  };
}

/** 既定の取得器（`createApp` が使う）。Playwright は取得を始めるまで読み込まない */
export const playwrightFetcher: MfmeFetcher = createPlaywrightFetcher();
