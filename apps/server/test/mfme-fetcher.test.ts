import type { PastedRow } from "@trebuchet/domain";
import { describe, expect, it, vi } from "vitest";
import { MfmeFetchError } from "../src/lib/jobs.ts";
import { cashFlowUrl, LOGIN_URL, type MfmeDomPage } from "../src/lib/mfme/dom.ts";
import {
  createPlaywrightFetcher,
  type MfmeBrowser,
  type MfmePage,
} from "../src/lib/mfme/fetcher.ts";

// 006 T022: Playwright の取得器（偽の launch）。保存しない文脈（browser.newContext()）だけを使い、
// launchPersistentContext やユーザーデータの場所を使わないこと（FR-009）。終わったら必ず閉じる

const HOME = "https://moneyforward.com/";

const row = (date: string): PastedRow => ({
  accountName: "サンプル銀行",
  date,
  content: "ショップ001",
  amount: -100,
  transferFlag: false,
});

type FakeOptions = {
  /** `url()` の返す値を順に（尽きたら最後の値）。既定はログインの画面 → ホーム */
  urls?: string[];
  /** この回数の `url()` の後でウィンドウが閉じる */
  closeAfterUrlCalls?: number;
};

function fakeBrowser(options: FakeOptions = {}) {
  const urls = options.urls ?? [LOGIN_URL, LOGIN_URL, HOME];
  let urlCalls = 0;
  let pageClosed = false;
  const visited: string[] = [];
  const closeListeners: (() => void)[] = [];
  const page: MfmePage = {
    goto: vi.fn(async (url: string) => {
      visited.push(url);
    }),
    url: () => {
      const i = urlCalls++;
      if (options.closeAfterUrlCalls !== undefined && urlCalls > options.closeAfterUrlCalls) {
        pageClosed = true;
        for (const l of closeListeners) l();
      }
      return urls[Math.min(i, urls.length - 1)] as string;
    },
    isClosed: () => pageClosed,
    on: (_event, listener) => {
      closeListeners.push(listener);
    },
    evaluate: vi.fn(),
    waitForSelector: vi.fn(),
  };
  const context = { newPage: vi.fn(async () => page), close: vi.fn(async () => {}) };
  const closeBrowser = vi.fn(async () => {});
  // newContext と close 以外の使用（launchPersistentContext など）は失敗させる
  const browser = new Proxy(
    { newContext: vi.fn(async (..._args: unknown[]) => context), close: closeBrowser, on: vi.fn() },
    {
      get(target, prop, receiver) {
        // await が `then` を探す
        if (prop === "then") return undefined;
        if (!(prop in target)) throw new Error(`想定外の使用: ${String(prop)}`);
        return Reflect.get(target, prop, receiver);
      },
    },
  ) as unknown as MfmeBrowser & { newContext: ReturnType<typeof vi.fn> };
  const launch = vi.fn(async (_options: Record<string, unknown>) => browser);
  return { launch, browser, context, closeBrowser, page, visited };
}

const fetcherOf = (
  fake: ReturnType<typeof fakeBrowser>,
  readRows: (page: MfmeDomPage, year: number) => Promise<PastedRow[]>,
  over: { loginTimeoutMs?: number } = {},
) =>
  createPlaywrightFetcher({
    launch: fake.launch,
    readRows,
    pollMs: 1,
    loginTimeoutMs: 1000,
    ...over,
  });

describe("Playwright の取得器（偽の launch）", () => {
  it("見えるウィンドウを開き、保存しない文脈（newContext）だけを使う。永続の文脈・ユーザーデータは使わない", async () => {
    const fake = fakeBrowser();
    await fetcherOf(fake, async () => []).fetch({ from: "2026-05", to: "2026-05" }, () => {});
    expect(fake.launch).toHaveBeenCalledTimes(1);
    const launchOptions = fake.launch.mock.calls[0]?.[0] ?? {};
    expect(launchOptions).toEqual({ headless: false });
    expect(JSON.stringify(launchOptions)).not.toMatch(/userDataDir|user-data-dir/i);
    expect(fake.browser.newContext).toHaveBeenCalledTimes(1);
    // storageState などの引数で、保存した状態を読み込まない
    expect(fake.browser.newContext.mock.calls[0]).toEqual([]);
  });

  it("ログインの画面を開き、ホームに着くまで待ってから、月ごとに入出金の画面を読む。終わったら閉じる", async () => {
    const fake = fakeBrowser();
    const years: number[] = [];
    const reads = vi.fn(async (_page: MfmeDomPage, year: number) => {
      years.push(year);
      return [row(`${year}-01-01`)];
    });
    const statuses: [string, unknown][] = [];
    const rows = await fetcherOf(fake, reads).fetch(
      { from: "2025-12", to: "2026-02" },
      (status, progress) => statuses.push([status, progress]),
    );
    expect(fake.visited).toEqual([
      LOGIN_URL,
      cashFlowUrl("2025-12"),
      cashFlowUrl("2026-01"),
      cashFlowUrl("2026-02"),
    ]);
    expect(years).toEqual([2025, 2026, 2026]);
    expect(rows.map((r) => r.date)).toEqual(["2025-01-01", "2026-01-01", "2026-01-01"]);
    expect(statuses[0]?.[0]).toBe("waiting_login");
    expect(statuses.slice(1).map(([s]) => s)).toEqual(["running", "running", "running"]);
    expect(statuses.at(-1)?.[1]).toEqual({ month: "2026-02", done: 2, total: 3 });
    expect(fake.context.close).toHaveBeenCalledTimes(1);
    expect(fake.closeBrowser).toHaveBeenCalledTimes(1);
  });

  it("ログインが時間内に終わらなければ MFME_LOGIN_TIMEOUT。閉じる", async () => {
    const fake = fakeBrowser({ urls: [LOGIN_URL] });
    const reads = vi.fn(async () => []);
    await expect(
      fetcherOf(fake, reads, { loginTimeoutMs: 30 }).fetch(
        { from: "2026-05", to: "2026-05" },
        () => {},
      ),
    ).rejects.toMatchObject({ name: "MfmeFetchError", code: "MFME_LOGIN_TIMEOUT" });
    expect(reads).not.toHaveBeenCalled();
    expect(fake.closeBrowser).toHaveBeenCalledTimes(1);
  });

  it("ログインの途中で利用者がウィンドウを閉じたら MFME_WINDOW_CLOSED。閉じる", async () => {
    const fake = fakeBrowser({ urls: [LOGIN_URL], closeAfterUrlCalls: 2 });
    await expect(
      fetcherOf(fake, async () => []).fetch({ from: "2026-05", to: "2026-05" }, () => {}),
    ).rejects.toMatchObject({ code: "MFME_WINDOW_CLOSED" });
    expect(fake.closeBrowser).toHaveBeenCalledTimes(1);
  });

  it("読み取りが失敗したら、その例外のまま失敗する（途中の行は返さない）。閉じる", async () => {
    const fake = fakeBrowser();
    const reads = vi
      .fn<(page: MfmeDomPage, year: number) => Promise<PastedRow[]>>()
      .mockResolvedValueOnce([row("2026-05-01")])
      .mockRejectedValueOnce(new MfmeFetchError("MFME_DOM_CHANGED", "形が違います"));
    await expect(
      fetcherOf(fake, reads).fetch({ from: "2026-05", to: "2026-06" }, () => {}),
    ).rejects.toMatchObject({ code: "MFME_DOM_CHANGED" });
    expect(fake.context.close).toHaveBeenCalledTimes(1);
    expect(fake.closeBrowser).toHaveBeenCalledTimes(1);
  });

  it("起動に失敗したら MFME_BROWSER_UNAVAILABLE（Chromium の案内）", async () => {
    const launch = vi.fn(async () => {
      throw new Error("Executable doesn't exist at /somewhere");
    });
    const fetcher = createPlaywrightFetcher({ launch, readRows: async () => [] });
    await expect(fetcher.fetch({ from: "2026-05", to: "2026-05" }, () => {})).rejects.toMatchObject(
      { code: "MFME_BROWSER_UNAVAILABLE" },
    );
  });

  it("ブラウザの終了の失敗は、取得の結果を隠さない", async () => {
    const fake = fakeBrowser();
    fake.closeBrowser.mockRejectedValueOnce(new Error("already closed"));
    await expect(
      fetcherOf(fake, async () => [row("2026-05-01")]).fetch(
        { from: "2026-05", to: "2026-05" },
        () => {},
      ),
    ).resolves.toHaveLength(1);
  });
});
