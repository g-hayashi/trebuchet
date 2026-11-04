import { describe, expect, it } from "vitest";
import { buildAiPayload } from "../../src/statements/mask.ts";
import { buildPrompt } from "../../src/statements/prompt.ts";
import type { StatementRecord } from "../../src/types.ts";

// 011 T042: 明細の場面（`scene: "statement"`）の指示文と、送る中身（user の JSON）を 1 バイトも変えない固定のテスト。
// 期待値は、場面を足す前のコードで `buildPrompt` を実行して得た文字列（評価の前後の比較を保つため。憲法 IV）。
// この期待値を変えるときは、`pnpm eval:statements` の前後比較が崩れる（FIXTURE_VERSION と ADR を見直す）

const GOLDEN_SYSTEM = [
  "あなたは日本の個人事業主の経理を手伝います。与えられた銀行・カード・現金の明細 1 件に対し、",
  "仕訳の相手の勘定科目、税区分、事業か私用かの判定を推定してください。",
  "",
  "勘定科目（コード 名前）:",
  "5130 広告宣伝費",
  "5120 通信費",
  "",
  "税区分のコード: PURCHASE_10, SALES_10, OUT_OF_SCOPE",
  "",
  "出力は次の形の JSON オブジェクトだけにしてください（前後に文章を付けない）:",
  '{"accountCode": 勘定科目のコード（上の一覧のもの）, "taxCategory": 税区分のコード（上のもの）,',
  ' "purpose": "business" か "private", "confidence": 0〜100 の整数, "reason": 根拠を 200 字以内で}',
  "一覧にないコードを作らないでください。分からないときは confidence を低くしてください。",
].join("\n");

const ACCOUNTS = [
  { code: "5130", name: "広告宣伝費" },
  { code: "5120", name: "通信費" },
];
const TAXES = ["PURCHASE_10", "SALES_10", "OUT_OF_SCOPE"];

const statement = (
  over: Partial<StatementRecord> = {},
): Pick<StatementRecord, "date" | "amount" | "content" | "categoryMajor" | "categoryMinor"> => ({
  date: "2026-05-10",
  amount: -1200,
  content: "ショップ",
  categoryMajor: "食費",
  categoryMinor: "外食",
  ...over,
});

const CASES = [
  {
    name: "銀行・事業・出金",
    statement: statement(),
    account: { kind: "bank", usage: "business" },
    user: '{"date":"2026-05-10","amount":1200,"direction":"out","content":"ショップ","categoryMajor":"食費","categoryMinor":"外食","accountKind":"bank","accountUsage":"business"}',
  },
  {
    name: "カード・混在・入金・名義のマスク・分類なし",
    statement: statement({
      amount: 55000,
      content: "振込 ヤマダ タロウ",
      categoryMajor: null,
      categoryMinor: null,
    }),
    account: { kind: "card", usage: "mixed" },
    user: '{"date":"2026-05-10","amount":55000,"direction":"in","content":"振込 [名義]","categoryMajor":null,"categoryMinor":null,"accountKind":"card","accountUsage":"mixed"}',
  },
  {
    name: "現金・私用・連絡先と数字のマスク",
    statement: statement({
      date: "2026-01-02",
      amount: -3300,
      content: "連絡 a@example.com 03-1234-5678 カード 1234567890",
    }),
    account: { kind: "cash", usage: "private" },
    user: '{"date":"2026-01-02","amount":3300,"direction":"out","content":"連絡 [連絡先] [連絡先] カード ####","categoryMajor":"食費","categoryMinor":"外食","accountKind":"cash","accountUsage":"private"}',
  },
] as const;

describe("明細の場面の指示文・送る中身の固定（011 T042。場面を足す前と 1 バイトも変えない）", () => {
  for (const c of CASES) {
    it(`buildPrompt の出力が変更前と完全に一致する: ${c.name}`, () => {
      const prompt = buildPrompt(buildAiPayload(c.statement, c.account), ACCOUNTS, TAXES);
      expect(prompt.system).toBe(GOLDEN_SYSTEM);
      expect(prompt.user).toBe(c.user);
    });
  }

  it("user の JSON に scene を含めない（キーの順も変えない）", () => {
    const prompt = buildPrompt(buildAiPayload(statement(), CASES[0].account), ACCOUNTS, TAXES);
    expect(prompt.user).not.toContain("scene");
    expect(Object.keys(JSON.parse(prompt.user) as object)).toEqual([
      "date",
      "amount",
      "direction",
      "content",
      "categoryMajor",
      "categoryMinor",
      "accountKind",
      "accountUsage",
    ]);
  });
});
