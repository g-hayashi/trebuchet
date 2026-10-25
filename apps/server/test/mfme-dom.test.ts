import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { afterAll, describe, expect, it } from "vitest";
import { MfmeFetchError } from "../src/lib/jobs.ts";
import {
  cashFlowUrl,
  isLoggedInUrl,
  LOGIN_URL,
  type MfmeDomPage,
  rawRowsToPasted,
  readCashFlowRows,
} from "../src/lib/mfme/dom.ts";

// 006 T022: MF ME の画面の読み取り。セレクターは暫定（実画面の DOM は T032 で確かめる）。
// 合成の HTML（fixtures/mfme/cf-month.html）を `page.setContent` で開く。Chromium がなければ飛ばす

const FIXTURE = readFileSync(
  fileURLToPath(new URL("./fixtures/mfme/cf-month.html", import.meta.url)),
  "utf8",
);

const EXPECTED = [
  {
    accountName: "サンプル銀行",
    date: "2026-05-10",
    content: "ショップ001",
    amount: -1200,
    categoryMajor: "食費",
    categoryMinor: "食料品",
    transferFlag: false,
    externalId: "tx-0001",
  },
  {
    accountName: "サンプル銀行",
    date: "2026-05-11",
    content: "売上入金",
    amount: 3000,
    categoryMajor: "収入",
    categoryMinor: "事業収入",
    memo: "メモあり",
    transferFlag: false,
    externalId: "tx-0002",
  },
  {
    accountName: "サンプルカード",
    date: "2026-05-12",
    content: "カード引落",
    amount: -5000,
    categoryMajor: "未分類",
    categoryMinor: "未分類",
    transferFlag: true,
    externalId: "tx-0003",
  },
];

describe("URL（暫定）", () => {
  it("月の入出金の URL は年と月を持つ。ログインの画面とホームを区別する", () => {
    expect(cashFlowUrl("2026-05")).toContain("year=2026");
    expect(cashFlowUrl("2026-05")).toContain("month=5");
    expect(isLoggedInUrl(LOGIN_URL)).toBe(false);
    expect(isLoggedInUrl("https://id.moneyforward.com/sign_in")).toBe(false);
    expect(isLoggedInUrl("https://moneyforward.com/")).toBe(true);
    expect(isLoggedInUrl("not a url")).toBe(false);
  });
});

describe("rawRowsToPasted（ブラウザ不要）", () => {
  const raw = (over: Record<string, unknown> = {}) => ({
    date: "05/10(日)",
    content: "ショップ001",
    amount: "-1,200",
    accountName: "サンプル銀行",
    categoryMajor: "食費",
    categoryMinor: "",
    memo: "",
    transfer: false,
    externalId: null,
    ...over,
  });

  it("貼り付けと同じ読み方で PastedRow にする（空の項目は持たない）", () => {
    expect(rawRowsToPasted([raw()], 2026)).toEqual([
      {
        accountName: "サンプル銀行",
        date: "2026-05-10",
        content: "ショップ001",
        amount: -1200,
        categoryMajor: "食費",
        transferFlag: false,
      },
    ]);
  });

  it("0 行は空の配列（取引のない月）", () => {
    expect(rawRowsToPasted([], 2026)).toEqual([]);
  });

  it("読めない行が 1 つでもあれば MFME_DOM_CHANGED（何も加えない）", () => {
    expect.assertions(2);
    try {
      rawRowsToPasted([raw(), raw({ amount: "あ" })], 2026);
    } catch (e) {
      expect(e).toBeInstanceOf(MfmeFetchError);
      expect((e as MfmeFetchError).code).toBe("MFME_DOM_CHANGED");
    }
  });

  it("タブ・改行を含むセルでも列がずれない", () => {
    const [row] = rawRowsToPasted([raw({ content: "A\tB\nC", memo: "x\ty" })], 2026);
    expect(row).toMatchObject({ content: "A B C", memo: "x y", amount: -1200 });
  });
});

/** 起動できる Chromium があれば起動する（なければ・サンドボックスで起動できなければ undefined → 飛ばす） */
async function tryLaunch() {
  try {
    if (!existsSync(chromium.executablePath())) return undefined;
    return await chromium.launch({ headless: true, timeout: 10_000 });
  } catch {
    return undefined;
  }
}
const launched = await tryLaunch();

describe.skipIf(launched === undefined)("readCashFlowRows（合成の HTML。Chromium が必要）", () => {
  const browser = launched as NonNullable<typeof launched>;
  afterAll(async () => {
    await launched?.close();
  });

  const open = async (html: string) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.setContent(html);
    return { page: page as unknown as MfmeDomPage, close: () => context.close() };
  };

  it("表の行を PastedRow にする（日付の年は引数、振替、取引の ID）", async () => {
    const { page, close } = await open(FIXTURE);
    try {
      expect(await readCashFlowRows(page, 2026)).toEqual(EXPECTED);
    } finally {
      await close();
    }
  });

  it("表がなければ MFME_DOM_CHANGED", async () => {
    const { page, close } = await open("<html><body><p>メンテナンス中</p></body></html>");
    try {
      await expect(readCashFlowRows(page, 2026, { timeoutMs: 300 })).rejects.toMatchObject({
        code: "MFME_DOM_CHANGED",
      });
    } finally {
      await close();
    }
  });

  it("行が 0 件の表は空の配列", async () => {
    const empty = FIXTURE.replace(/<tr class="transaction_list[\s\S]*?<\/tr>/g, "");
    const { page, close } = await open(empty);
    try {
      expect(await readCashFlowRows(page, 2026)).toEqual([]);
    } finally {
      await close();
    }
  });
});
