import { describe, expect, it } from "vitest";
import type { SuggestionContext } from "../../src/ports.ts";
import {
  compareReadingWithJournal,
  compareReadingWithSaved,
  parseReceiptReading,
  RECEIPT_READING_ERROR,
  type ReceiptCandidates,
} from "../../src/receipts/reading.ts";

// T032: AI の出力の検証と、保存した値・登録した仕訳との比べ（research R14、FR-016・017、INV-67）

const CONTEXT: SuggestionContext = {
  accounts: [
    { code: "5100", name: "消耗品費" },
    { code: "5200", name: "旅費交通費" },
  ],
  taxCategories: ["PURCHASE_10", "PURCHASE_8R", "NON_TAXABLE"],
};

const FULL = {
  transactionDate: "2026-10-20",
  amount: 1100,
  partnerName: "合成の店",
  accountCode: "5100",
  taxCategory: "PURCHASE_10",
  confidence: 80,
  reason: "文具の購入",
};
const NONE: ReceiptCandidates = {
  transactionDate: null,
  amount: null,
  partnerName: null,
  accountCode: null,
  taxCategory: null,
};

describe("parseReceiptReading", () => {
  it("検証を通る応答は succeeded。候補・確信度・説明を返す（文字列でも読み取り済みの値でも）", () => {
    for (const raw of [JSON.stringify(FULL), FULL]) {
      expect(parseReceiptReading(raw, CONTEXT)).toEqual({
        status: "succeeded",
        candidates: {
          transactionDate: "2026-10-20",
          amount: 1100,
          partnerName: "合成の店",
          accountCode: "5100",
          taxCategory: "PURCHASE_10",
        },
        confidence: 80,
        reason: "文具の購入",
      });
    }
  });

  it("コードフェンス・前後の文章つきの JSON も読む", () => {
    const raw = `読み取りました。\n\`\`\`json\n${JSON.stringify(FULL)}\n\`\`\``;
    expect(parseReceiptReading(raw, CONTEXT)).toMatchObject({
      status: "succeeded",
      candidates: { amount: 1100 },
    });
  });

  it("JSON でない・オブジェクトでない応答は invalid で全部 null", () => {
    for (const raw of ["読めません", "", "{", "[1,2]", "42", "null", null, undefined, 7, []]) {
      expect(parseReceiptReading(raw, CONTEXT)).toEqual({
        status: "invalid",
        candidates: NONE,
        confidence: null,
        reason: null,
      });
    }
  });

  it("期待する項目を 1 つも持たないオブジェクトは invalid", () => {
    expect(parseReceiptReading('{"foo": 1}', CONTEXT).status).toBe("invalid");
    expect(parseReceiptReading("{}", CONTEXT).status).toBe("invalid");
  });

  it("項目ごとに検証し、合わない項目だけ候補なしにする（ほかは残す）", () => {
    const bad = {
      ...FULL,
      transactionDate: "2026-02-30", // 存在しない日付
      amount: 1100.5, // 整数でない
    };
    expect(parseReceiptReading(bad, CONTEXT)).toMatchObject({
      status: "succeeded",
      candidates: {
        transactionDate: null,
        amount: null,
        partnerName: "合成の店",
        accountCode: "5100",
        taxCategory: "PURCHASE_10",
      },
      confidence: 80,
    });
  });

  it("金額は 0 以下・1 兆円以上・文字列を採らない。取引先は 100 文字まで（前後の空白は除く）", () => {
    for (const amount of [0, -5, 1e12, "1100", Number.NaN]) {
      expect(parseReceiptReading({ ...FULL, amount }, CONTEXT)).toMatchObject({
        candidates: { amount: null },
      });
    }
    expect(parseReceiptReading({ ...FULL, partnerName: "あ".repeat(101) }, CONTEXT)).toMatchObject({
      candidates: { partnerName: null },
    });
    expect(parseReceiptReading({ ...FULL, partnerName: "あ".repeat(100) }, CONTEXT)).toMatchObject({
      candidates: { partnerName: "あ".repeat(100) },
    });
    expect(parseReceiptReading({ ...FULL, partnerName: "  合成の店  " }, CONTEXT)).toMatchObject({
      candidates: { partnerName: "合成の店" },
    });
    expect(parseReceiptReading({ ...FULL, partnerName: "   " }, CONTEXT)).toMatchObject({
      candidates: { partnerName: null },
    });
  });

  it("科目は一覧にあるコードだけ、税区分は一覧にあるものだけ（一覧にないものは候補なし）", () => {
    expect(parseReceiptReading({ ...FULL, accountCode: "9999" }, CONTEXT)).toMatchObject({
      candidates: { accountCode: null, taxCategory: "PURCHASE_10" },
    });
    // 既知の税区分でも、文脈の一覧にないものは採らない
    expect(parseReceiptReading({ ...FULL, taxCategory: "SALES_10" }, CONTEXT)).toMatchObject({
      candidates: { accountCode: "5100", taxCategory: null },
    });
    expect(parseReceiptReading({ ...FULL, taxCategory: "nonsense" }, CONTEXT)).toMatchObject({
      candidates: { taxCategory: null },
    });
  });

  it("null の項目は候補なし。確信度が範囲外・整数でなければ null", () => {
    expect(
      parseReceiptReading({ ...FULL, amount: null, partnerName: null }, CONTEXT),
    ).toMatchObject({
      status: "succeeded",
      candidates: { amount: null, partnerName: null },
    });
    for (const confidence of [101, -1, 50.5, "80", null]) {
      expect(parseReceiptReading({ ...FULL, confidence }, CONTEXT)).toMatchObject({
        confidence: null,
      });
    }
  });

  it("reason は 200 字まで。超えれば reason だけ null で、ほかの項目は残す", () => {
    expect(parseReceiptReading({ ...FULL, reason: "あ".repeat(200) }, CONTEXT).reason).toBe(
      "あ".repeat(200),
    );
    expect(parseReceiptReading({ ...FULL, reason: "あ".repeat(201) }, CONTEXT)).toMatchObject({
      status: "succeeded",
      reason: null,
      candidates: { amount: 1100 },
    });
    expect(parseReceiptReading({ ...FULL, reason: 5 }, CONTEXT).reason).toBeNull();
  });
});

describe("compareReadingWithSaved", () => {
  const candidates: ReceiptCandidates = {
    transactionDate: "2026-10-20",
    amount: 1100,
    partnerName: "ｶﾌｪ　ドトール",
    accountCode: null,
    taxCategory: null,
  };

  it("日付・金額は等しいか、取引先は normalizeReceiptText で比べる", () => {
    expect(
      compareReadingWithSaved(candidates, {
        transactionDate: "2026-10-20",
        amount: 1100,
        partnerName: "カフェドトール",
      }),
    ).toEqual({ dateMatch: true, amountMatch: true, partnerMatch: true });
    expect(
      compareReadingWithSaved(candidates, {
        transactionDate: "2026-10-21",
        amount: 1000,
        partnerName: "別の店",
      }),
    ).toEqual({ dateMatch: false, amountMatch: false, partnerMatch: false });
  });

  it("候補が null の項目、保存した値が null の項目は比べない（null）", () => {
    expect(
      compareReadingWithSaved(
        { ...candidates, amount: null },
        { transactionDate: null, amount: 1100, partnerName: "カフェドトール" },
      ),
    ).toEqual({ dateMatch: null, amountMatch: null, partnerMatch: true });
  });
});

describe("compareReadingWithJournal", () => {
  const lines = [
    { accountCode: "1100", taxCategory: "OUT_OF_SCOPE" },
    { accountCode: "5100", taxCategory: "PURCHASE_10" },
  ];

  it("仕訳のどれかの行の科目コード・税区分が候補と同じか", () => {
    expect(
      compareReadingWithJournal(
        { ...NONE, accountCode: "5100", taxCategory: "PURCHASE_10" },
        { lines },
      ),
    ).toEqual({ accountMatch: true, taxMatch: true });
    expect(
      compareReadingWithJournal(
        { ...NONE, accountCode: "5200", taxCategory: "PURCHASE_8R" },
        { lines },
      ),
    ).toEqual({ accountMatch: false, taxMatch: false });
  });

  it("候補が null の項目は null", () => {
    expect(compareReadingWithJournal(NONE, { lines })).toEqual({
      accountMatch: null,
      taxMatch: null,
    });
  });
});

describe("RECEIPT_READING_ERROR", () => {
  it("失敗の記録に使う 5 つの文字列の定数", () => {
    expect(Object.values(RECEIPT_READING_ERROR).sort()).toEqual([
      "AI_HTTP_ERROR",
      "AI_INVALID_OUTPUT",
      "AI_TIMEOUT",
      "RECEIPT_CONVERSION_FAILED",
      "RECEIPT_READ_UNSUPPORTED",
    ]);
  });
});
