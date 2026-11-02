import { describe, expect, it } from "vitest";
import type {
  ReceiptImageTool,
  ReceiptReader,
  ReceiptReadingRequest,
  SuggestionContext,
} from "../../src/ports.ts";
import {
  evaluateReceiptReadings,
  RECEIPT_EVAL_FIELDS,
  RECEIPT_EVAL_TARGETS,
  type ReceiptEvalCase,
  type ReceiptEvalExpected,
  receiptEvalTargets,
} from "../../src/receipts/evals.ts";
import { domainError, err, ok, type Result } from "../../src/types.ts";
import { RECEIPT_EVAL_EXPECTED } from "../fixtures/receipts/expected.ts";
import { jpegBytes, readExif } from "../fixtures/receipts/sample-files.ts";

// T036（research R17、Constitution IV）。証憑の読み取りの評価の集計。AI・sips は呼ばない（偽の reader・画像の変換）

const CONTEXT: SuggestionContext = {
  accounts: [
    { code: "6100", name: "消耗品費" },
    { code: "6200", name: "旅費交通費" },
  ],
  taxCategories: ["PURCHASE_10", "PURCHASE_8R", "OUT_OF_SCOPE"],
};

const EXPECTED: ReceiptEvalExpected = {
  transactionDate: "2026-10-20",
  amount: 1100,
  partnerName: "ABC商店",
  accountCode: "6100",
  taxCategory: "PURCHASE_10",
};

const caseOf = (name: string, expected: Partial<ReceiptEvalExpected> = {}): ReceiptEvalCase => ({
  name,
  bytes: jpegBytes({ gps: true, comment: `SENTINEL_${name}` }),
  mediaType: "image/jpeg",
  expected: { ...EXPECTED, ...expected },
});

const reading = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    transactionDate: "2026-10-20",
    amount: 1100,
    partnerName: "ABC商店",
    accountCode: "6100",
    taxCategory: "PURCHASE_10",
    confidence: 80,
    reason: "合成の説明",
    ...over,
  });

/** 呼ばれた順に決めた応答を返す reader（同時に 1 つしか呼ばれないことも確かめる） */
function scripted(responses: Result<unknown>[]): ReceiptReader & {
  requests: ReceiptReadingRequest[];
  maxConcurrent: number;
} {
  let active = 0;
  const self = {
    requests: [] as ReceiptReadingRequest[],
    maxConcurrent: 0,
    async model() {
      return "fake-model";
    },
    async read(request: ReceiptReadingRequest): Promise<Result<unknown>> {
      self.requests.push(request);
      active += 1;
      self.maxConcurrent = Math.max(self.maxConcurrent, active);
      await Promise.resolve();
      active -= 1;
      return (
        responses[self.requests.length - 1] ?? err(domainError("VALIDATION", "応答がありません"))
      );
    },
  };
  return self;
}

/** 入力の JPEG をそのまま返す変換（メタデータの除去は評価の側が行う） */
function passthroughImages(
  override?: (n: number) => Result<Uint8Array> | undefined,
): ReceiptImageTool & { calls: number } {
  const self = {
    calls: 0,
    async probe() {
      return ok(undefined);
    },
    async toDisplay(bytes: Uint8Array) {
      return ok({ bytes, mediaType: "image/jpeg" });
    },
    async toAiJpeg(bytes: Uint8Array): Promise<Result<Uint8Array>> {
      self.calls += 1;
      return override?.(self.calls) ?? ok(bytes);
    },
  };
  return self;
}

const evaluate = (
  cases: readonly ReceiptEvalCase[],
  reader: ReceiptReader,
  images: ReceiptImageTool = passthroughImages(),
) => evaluateReceiptReadings(cases, { reader, images, context: CONTEXT });

describe("evaluateReceiptReadings", () => {
  it("すべて一致なら全項目 1000（千分率）、失敗は 0 件", async () => {
    const reader = scripted([ok(reading()), ok(reading())]);
    const result = await evaluate([caseOf("a"), caseOf("b")], reader);
    expect(result.caseCount).toBe(2);
    expect(result.succeededRate).toBe(1000);
    expect(result.failures).toEqual({
      AI_TIMEOUT: 0,
      AI_HTTP_ERROR: 0,
      AI_INVALID_OUTPUT: 0,
      RECEIPT_READ_UNSUPPORTED: 0,
      RECEIPT_CONVERSION_FAILED: 0,
    });
    expect(result.fields.map((f) => f.field)).toEqual([...RECEIPT_EVAL_FIELDS]);
    for (const f of result.fields) {
      expect(f).toMatchObject({ count: 2, matchRate: 1000 });
    }
  });

  it("項目ごとに一致を数える。null（読めない）と違う値は不一致、取引先は正規化して比べる", async () => {
    const reader = scripted([
      ok(reading({ transactionDate: "2026-10-21" })), // 日付だけ違う
      ok(reading({ amount: null })), // 金額は読めない
      ok(reading({ partnerName: "　ａｂｃ 商店 " })), // 空白・全角差・大小は一致（NFKC）
      ok(reading({ accountCode: "6200", taxCategory: "OUT_OF_SCOPE" })),
    ]);
    const result = await evaluate([caseOf("a"), caseOf("b"), caseOf("c"), caseOf("d")], reader);
    const rate = (field: string) => result.fields.find((f) => f.field === field)?.matchRate;
    expect(rate("transactionDate")).toBe(750);
    expect(rate("amount")).toBe(750);
    expect(rate("partnerName")).toBe(1000);
    expect(rate("accountCode")).toBe(750);
    expect(rate("taxCategory")).toBe(750);
  });

  it("正解が null の項目は数えない（件数 0・率 0）", async () => {
    const reader = scripted([ok(reading()), ok(reading({ accountCode: "6200" }))]);
    const result = await evaluate(
      [caseOf("a", { accountCode: null }), caseOf("b", { accountCode: "6100" })],
      reader,
    );
    const account = result.fields.find((f) => f.field === "accountCode");
    expect(account).toEqual({ field: "accountCode", count: 1, matchRate: 0 });
    const none = await evaluate([caseOf("a", { taxCategory: null })], scripted([ok(reading())]));
    expect(none.fields.find((f) => f.field === "taxCategory")).toEqual({
      field: "taxCategory",
      count: 0,
      matchRate: 0,
    });
  });

  it("失敗は理由別に数え、数えた項目は不一致にする（R13 の写像）", async () => {
    const timeout = err(domainError("VALIDATION", "時間切れ", { timeout: true }));
    const http = err(domainError("VALIDATION", "AI がエラーを返しました"));
    const reader = scripted([timeout, http, ok("これは JSON ではない"), ok(reading())]);
    const result = await evaluate([caseOf("a"), caseOf("b"), caseOf("c"), caseOf("d")], reader);
    expect(result.failures).toMatchObject({
      AI_TIMEOUT: 1,
      AI_HTTP_ERROR: 1,
      AI_INVALID_OUTPUT: 1,
    });
    expect(result.succeededRate).toBe(250);
    expect(result.fields.find((f) => f.field === "amount")).toEqual({
      field: "amount",
      count: 4,
      matchRate: 250,
    });
  });

  it("変換の失敗は AI を呼ばずに数える。PDF を描けない → RECEIPT_READ_UNSUPPORTED、それ以外 → RECEIPT_CONVERSION_FAILED", async () => {
    const reader = scripted([ok(reading())]);
    const images = passthroughImages((n) =>
      n === 1
        ? err(domainError("RECEIPT_READ_UNSUPPORTED", "PDF を描けません"))
        : n === 2
          ? err(domainError("VALIDATION", "変換に失敗"))
          : undefined,
    );
    const result = await evaluate([caseOf("a"), caseOf("b"), caseOf("c")], reader, images);
    expect(result.failures.RECEIPT_READ_UNSUPPORTED).toBe(1);
    expect(result.failures.RECEIPT_CONVERSION_FAILED).toBe(1);
    expect(reader.requests).toHaveLength(1);
    expect(result.succeededRate).toBe(333);
  });

  it("R13 と同じ経路: メタデータを除いた JPEG と、科目・税区分だけの選択肢を、1 件ずつ順に送る", async () => {
    const reader = scripted([ok(reading()), ok(reading()), ok(reading())]);
    await evaluate([caseOf("name-a"), caseOf("name-b"), caseOf("name-c")], reader);
    expect(reader.requests).toHaveLength(3);
    expect(reader.maxConcurrent).toBe(1);
    for (const request of reader.requests) {
      expect(readExif(request.image.bytes)?.hasGps ?? false).toBe(false);
      expect(new TextDecoder("latin1").decode(request.image.bytes)).not.toContain("SENTINEL_");
      expect(request.choices).toContain("6100 消耗品費");
      expect(request.choices).not.toContain("name-");
      expect(request.system).not.toContain("name-");
    }
  });

  it("件数 0 は率 0・失敗 0", async () => {
    const result = await evaluate([], scripted([]));
    expect(result.caseCount).toBe(0);
    expect(result.succeededRate).toBe(0);
    for (const f of result.fields) expect(f).toMatchObject({ count: 0, matchRate: 0 });
  });

  it("結果は件数と率だけ（例の名前・取引先・値を含まない）", async () => {
    const reader = scripted([ok(reading({ partnerName: "NAME_SENTINEL" }))]);
    const result = await evaluate([caseOf("case-sentinel")], reader);
    const json = JSON.stringify(result);
    for (const word of ["case-sentinel", "NAME_SENTINEL", "合成の店", "2026-10-20"]) {
      expect(json).not.toContain(word);
    }
  });
});

describe("receiptEvalTargets（R17: 取引年月日・金額が 90% 以上）", () => {
  it("目標は取引年月日と金額だけ（取引先・科目・税区分は記録だけ）", () => {
    expect(RECEIPT_EVAL_TARGETS).toEqual({ transactionDate: 900, amount: 900 });
  });

  it("20 枚中 18 枚（900）で達成、17 枚で未達、件数 0 は未達", async () => {
    const make = async (matched: number) => {
      const reader = scripted(
        Array.from({ length: 20 }, (_, i) => ok(reading(i < matched ? {} : { amount: 1 }))),
      );
      return evaluate(
        Array.from({ length: 20 }, (_, i) => caseOf(`c${i}`)),
        reader,
      );
    };
    const targets = (r: Awaited<ReturnType<typeof make>>) =>
      receiptEvalTargets(r).map((t) => [t.field, t.target, t.met]);
    expect(targets(await make(18))).toEqual([
      ["transactionDate", 900, true],
      ["amount", 900, true],
    ]);
    expect(targets(await make(17))).toEqual([
      ["transactionDate", 900, true],
      ["amount", 900, false],
    ]);
    expect(receiptEvalTargets(await evaluate([], scripted([]))).every((t) => !t.met)).toBe(true);
  });
});

describe("fixtures/receipts/expected.ts（評価用の画像 20 枚の正解。画像は T042）", () => {
  it("ファイル名は重複せず、各項目は形式どおり（日付 YYYY-MM-DD、金額は正の整数）", () => {
    const names = Object.keys(RECEIPT_EVAL_EXPECTED);
    expect(new Set(names).size).toBe(names.length);
    for (const [name, expected] of Object.entries(RECEIPT_EVAL_EXPECTED)) {
      expect(name).toMatch(/^[\w.-]+\.(jpe?g|png|heic|pdf)$/i);
      if (expected.transactionDate !== null) {
        expect(expected.transactionDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
      if (expected.amount !== null) {
        expect(Number.isInteger(expected.amount) && expected.amount > 0).toBe(true);
      }
    }
  });
});
