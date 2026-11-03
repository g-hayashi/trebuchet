import type { ReceiptLinkState } from "@trebuchet/schema";
import { describe, expect, it } from "vitest";
import { inputDeadline, receiptWarnings } from "../../src/receipts/warnings.ts";
import { TAX_PARAMETERS } from "../../src/seed/tax-parameters.ts";
import type { ReceiptFileRow, ReceiptRow, TaxParameter } from "../../src/types.ts";
import { makeReceiptFileRow, makeReceiptRow } from "../receipt-setup.ts";

// T011: 警告（data-model §2.2、research R2・R3）。値はすべて合成

const PARAMS = { cycleMonths: 2, graceBusinessDays: 7 };

describe("inputDeadline", () => {
  it("問23 の例: 4/21 に受領した書類は 2 か月の周期が 6/20 まで、そこから 7 営業日", () => {
    // 2025-06-20 は金曜。6/23〜27 の 5 営業日、6/30、7/1 で 7 営業日目
    expect(inputDeadline("2025-04-21", PARAMS)).toBe("2025-07-01");
  });

  it("周期の末日が土曜なら、次の月曜が 1 営業日目", () => {
    // 2026-06-20 は土曜。6/22(月)が 1、…、6/30(火)が 7
    expect(inputDeadline("2026-04-21", PARAMS)).toBe("2026-06-30");
  });

  it("月末: 12/31 の 2 か月後は 2/28（うるう年なら 2/29）に丸める", () => {
    // 2027-02-27 は土曜。3/1(月)が 1、…、3/9(火)が 7
    expect(inputDeadline("2026-12-31", PARAMS)).toBe("2027-03-09");
    // 2023-12-31 + 2 か月 = 2024-02-29（うるう年）、前日 2/28（水）、7 営業日後は 3/8（金）
    expect(inputDeadline("2023-12-31", PARAMS)).toBe("2024-03-08");
  });

  it("年をまたぐ: 10/31 の 2 か月後は 12/31、前日 12/30（水）から 7 営業日で 1/8", () => {
    expect(inputDeadline("2026-10-31", PARAMS)).toBe("2027-01-08");
  });

  it("営業日は土日だけを除く（祝日は除かない）。猶予 0 なら周期の末日のまま", () => {
    expect(inputDeadline("2026-04-21", { cycleMonths: 2, graceBusinessDays: 0 })).toBe(
      "2026-06-20",
    );
    // 1/1（祝日）をまたいでも数える: 2026-11-01 + 2 か月 = 2027-01-01、前日 2026-12-31（木）、1 営業日後は 1/1（金）
    expect(inputDeadline("2026-11-01", { cycleMonths: 2, graceBusinessDays: 1 })).toBe(
      "2027-01-01",
    );
  });
});

const params = (rows: Partial<TaxParameter>[]): TaxParameter[] =>
  rows.map((r) => ({
    key: "RECEIPT_SCAN_MIN_LONG_PX",
    effectiveFrom: "2024-01-01",
    effectiveTo: null,
    value: 0,
    sourceUrl: "https://example.test",
    ...r,
  }));

type Input = {
  receipt?: Partial<ReceiptRow>;
  file?: Partial<ReceiptFileRow>;
  linkState?: ReceiptLinkState;
  receivedDate?: string;
  taxParameters?: readonly TaxParameter[];
};

const warn = (input: Input = {}) =>
  receiptWarnings({
    receipt: makeReceiptRow({ partnerName: "合成の店", ...input.receipt }),
    // 既定はスマホの撮影の大きさ（目安を満たす）。makeReceiptFileRow の既定は 64 x 48
    currentFile: makeReceiptFileRow({ width: 4032, height: 3024, ...input.file }),
    linkState: input.linkState ?? "none",
    receivedDate: input.receivedDate ?? "2026-10-31",
    taxParameters: input.taxParameters ?? TAX_PARAMETERS,
  });

const codes = (input?: Input) => warn(input).map((w) => w.code);

describe("receiptWarnings: 未入力（FIELDS_MISSING）", () => {
  it("そろっていれば警告なし", () => {
    expect(warn()).toEqual([]);
  });

  it("取引年月日・金額・取引先のどれかが未入力なら出す", () => {
    expect(codes({ receipt: { transactionDate: null } })).toEqual(["FIELDS_MISSING"]);
    expect(codes({ receipt: { amount: null } })).toEqual(["FIELDS_MISSING"]);
    expect(codes({ receipt: { partnerName: null, partnerKey: null } })).toEqual(["FIELDS_MISSING"]);
  });

  it("メモは見ない", () => {
    expect(codes({ receipt: { memo: null } })).toEqual([]);
  });
});

describe("receiptWarnings: 削除済み", () => {
  it("削除済みは、どの条件でも空", () => {
    const deleted = {
      deletedAt: "2026-10-31T09:00:00.000Z",
      deletedReason: "重複",
      category: "paper_scan",
      transactionDate: null,
    } as const;
    expect(
      warn({
        receipt: deleted,
        file: { width: 10, height: 10, fullColor: false },
        linkState: "journal_voided",
      }),
    ).toEqual([]);
  });
});

describe("receiptWarnings: 入力期間（INPUT_PERIOD_EXCEEDED）", () => {
  // 取引 2026-04-21（火）の期限は 2026-06-30
  const paper = { category: "paper_scan", transactionDate: "2026-04-21" } as const;

  it("期限の日までは出さず、翌日から出す。details に期限", () => {
    expect(codes({ receipt: paper, receivedDate: "2026-06-30" })).toEqual([]);
    expect(warn({ receipt: paper, receivedDate: "2026-07-01" })).toEqual([
      { code: "INPUT_PERIOD_EXCEEDED", details: { deadline: "2026-06-30" } },
    ]);
  });

  it("比べるのは受領日。取引年月日を後から入れた日ではない（受領日が期限内なら出ない）", () => {
    expect(codes({ receipt: paper, receivedDate: "2026-05-01" })).toEqual([]);
  });

  it("区分が electronic なら判定しない", () => {
    expect(
      codes({
        receipt: { ...paper, category: "electronic" },
        receivedDate: "2027-01-01",
      }),
    ).toEqual([]);
  });

  it("取引年月日が未入力なら判定しない（未入力の警告だけ）", () => {
    expect(
      codes({
        receipt: { category: "paper_scan", transactionDate: null },
        receivedDate: "2030-01-01",
      }),
    ).toEqual(["FIELDS_MISSING"]);
  });

  it("税制の値を取引年月日で解決できなければ出さない（適用の開始前、行がない）", () => {
    expect(
      codes({
        receipt: { ...paper, transactionDate: "2023-12-31" },
        receivedDate: "2030-01-01",
      }),
    ).toEqual([]);
    expect(codes({ receipt: paper, receivedDate: "2030-01-01", taxParameters: [] })).toEqual([]);
    // 猶予の日数だけがない
    const onlyMonths = TAX_PARAMETERS.filter((p) => p.key !== "RECEIPT_INPUT_GRACE_BUSINESS_DAYS");
    expect(
      codes({ receipt: paper, receivedDate: "2030-01-01", taxParameters: onlyMonths }),
    ).toEqual([]);
  });

  it("税制の値は取引年月日で選ぶ（周期を 1 か月にした行があれば期限が早まる）", () => {
    const shorter = [
      ...TAX_PARAMETERS,
      ...params([
        { key: "RECEIPT_INPUT_CYCLE_MONTHS", effectiveFrom: "2026-01-01", value: 1 },
        { key: "RECEIPT_INPUT_GRACE_BUSINESS_DAYS", effectiveFrom: "2026-01-01", value: 7 },
      ]),
    ];
    // 2026-04-21 + 1 か月 = 5/21、前日 5/20（水）、7 営業日後は 5/29（金）
    expect(warn({ receipt: paper, receivedDate: "2026-05-30", taxParameters: shorter })).toEqual([
      { code: "INPUT_PERIOD_EXCEEDED", details: { deadline: "2026-05-29" } },
    ]);
    expect(codes({ receipt: paper, receivedDate: "2026-05-29", taxParameters: shorter })).toEqual(
      [],
    );
  });
});

describe("receiptWarnings: 解像度（RESOLUTION_BELOW_GUIDE）", () => {
  const paper = { category: "paper_scan" } as const;
  const size = (width: number, height: number) => ({ width, height, fullColor: true });

  it("A4 の目安（長辺 2,338・短辺 1,654）を下回れば出す。details に寸法と目安", () => {
    expect(warn({ receipt: paper, file: size(2000, 1500) })).toEqual([
      {
        code: "RESOLUTION_BELOW_GUIDE",
        details: { width: 2000, height: 1500, minLong: 2338, minShort: 1654 },
      },
    ]);
  });

  it("ちょうど目安なら出さず、長辺か短辺が 1 画素足りなければ出す。縦横は問わない", () => {
    expect(codes({ receipt: paper, file: size(2338, 1654) })).toEqual([]);
    expect(codes({ receipt: paper, file: size(1654, 2338) })).toEqual([]);
    expect(codes({ receipt: paper, file: size(2337, 1654) })).toEqual(["RESOLUTION_BELOW_GUIDE"]);
    expect(codes({ receipt: paper, file: size(2338, 1653) })).toEqual(["RESOLUTION_BELOW_GUIDE"]);
    expect(codes({ receipt: paper, file: size(1653, 2338) })).toEqual(["RESOLUTION_BELOW_GUIDE"]);
  });

  it("スマホの撮影（4032 x 3024）は満たす", () => {
    expect(codes({ receipt: paper, file: size(4032, 3024) })).toEqual([]);
  });

  it("paper_scan だけ。electronic・寸法不明（PDF など）は出さない", () => {
    expect(codes({ receipt: { category: "electronic" }, file: size(100, 100) })).toEqual([]);
    expect(
      codes({
        receipt: paper,
        file: { mediaType: "application/pdf", width: null, height: null, fullColor: null },
      }),
    ).toEqual([]);
  });

  it("目安の値は取引年月日で選び、なければ受領日で選ぶ", () => {
    const rows = params([
      { key: "RECEIPT_SCAN_MIN_LONG_PX", effectiveFrom: "2026-01-01", value: 2338 },
      { key: "RECEIPT_SCAN_MIN_SHORT_PX", effectiveFrom: "2026-01-01", value: 1654 },
    ]);
    const small = size(2000, 1500);
    // 取引年月日が適用の開始前なら解決できず、出さない
    expect(
      codes({
        receipt: { ...paper, transactionDate: "2025-06-01" },
        file: small,
        taxParameters: rows,
      }),
    ).toEqual([]);
    // 取引年月日が未入力なら受領日（2026-10-31）で解決できて、出る
    expect(
      codes({
        receipt: { ...paper, transactionDate: null },
        file: small,
        taxParameters: rows,
      }),
    ).toEqual(["FIELDS_MISSING", "RESOLUTION_BELOW_GUIDE"]);
  });
});

describe("receiptWarnings: 階調（NOT_FULL_COLOR）", () => {
  it("paper_scan で fullColor が false のときだけ出す", () => {
    const paper = { category: "paper_scan" } as const;
    expect(codes({ receipt: paper, file: { fullColor: false } })).toEqual(["NOT_FULL_COLOR"]);
    expect(codes({ receipt: paper, file: { fullColor: true } })).toEqual([]);
    expect(codes({ receipt: paper, file: { fullColor: null } })).toEqual([]);
    expect(codes({ receipt: { category: "electronic" }, file: { fullColor: false } })).toEqual([]);
  });

  it("目安の値がなくても出す（解像度とは別の判定）", () => {
    expect(
      codes({
        receipt: { category: "paper_scan" },
        file: { fullColor: false },
        taxParameters: [],
      }),
    ).toEqual(["NOT_FULL_COLOR"]);
  });
});

describe("receiptWarnings: 仕訳の取消（JOURNAL_VOIDED）", () => {
  it("結びつきの状態が journal_voided のときだけ出す", () => {
    expect(codes({ linkState: "journal_voided" })).toEqual(["JOURNAL_VOIDED"]);
    expect(codes({ linkState: "linked" })).toEqual([]);
    expect(codes({ linkState: "none" })).toEqual([]);
  });
});

describe("receiptWarnings: 並び", () => {
  it("未入力 → 入力期間 → 解像度 → 階調 → 仕訳の取消の順", () => {
    expect(
      codes({
        receipt: { category: "paper_scan", transactionDate: "2026-04-21", amount: null },
        file: { width: 100, height: 100, fullColor: false },
        linkState: "journal_voided",
        receivedDate: "2026-12-01",
      }),
    ).toEqual([
      "FIELDS_MISSING",
      "INPUT_PERIOD_EXCEEDED",
      "RESOLUTION_BELOW_GUIDE",
      "NOT_FULL_COLOR",
      "JOURNAL_VOIDED",
    ]);
  });
});
