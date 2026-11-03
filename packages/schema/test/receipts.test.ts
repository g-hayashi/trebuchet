import { describe, expect, it } from "vitest";
import {
  AiReceiptReading,
  ErrorCode,
  RECEIPT_MAX_BYTES,
  RECEIPT_MAX_PIXELS,
  ReceiptCategory,
  ReceiptChannel,
  ReceiptCreateOptions,
  ReceiptDeleteInput,
  ReceiptDetail,
  ReceiptFileParam,
  ReceiptHistoryEntry,
  ReceiptJournalInput,
  ReceiptLinkInput,
  ReceiptLinkState,
  ReceiptMediaType,
  ReceiptParam,
  ReceiptQuery,
  ReceiptReadingView,
  ReceiptReplaceOptions,
  ReceiptSummary,
  ReceiptUnlinkInput,
  ReceiptUpdateInput,
  ReceiptWarning,
  ReceiptWarningCode,
} from "../src/index.ts";

// T002: 010-receipts の schema（contracts/http-api.md §1・§7、data-model §2.1・§2.3、R14）

const ID = "0192f0c4-7b1a-7000-8000-000000000001";
const SHA = "a".repeat(64);
const NOW = "2026-11-02T01:00:00.000Z";

describe("ErrorCode（010 の 9 コード）", () => {
  const added = [
    "RECEIPT_NOT_FOUND",
    "RECEIPT_FORMAT_UNSUPPORTED",
    "RECEIPT_DUPLICATE",
    "RECEIPT_DELETED",
    "RECEIPT_LINKED",
    "RECEIPT_ALREADY_LINKED",
    "RECEIPT_FILE_UNREADABLE",
    "RECEIPT_CONVERSION_FAILED",
    "RECEIPT_READ_UNSUPPORTED",
  ];
  it("9 種がすべて入っている", () => {
    expect(new Set(added).size).toBe(9);
    for (const code of added) expect(ErrorCode.safeParse(code).success, code).toBe(true);
  });
});

describe("定数と列挙", () => {
  it("上限: 20 MB と 1 億画素", () => {
    expect(RECEIPT_MAX_BYTES).toBe(20 * 1024 * 1024);
    expect(RECEIPT_MAX_PIXELS).toBe(100_000_000);
  });
  it("区分・経路・形式・結びつきの状態・警告のコード", () => {
    expect(ReceiptCategory.options).toEqual(["paper_scan", "electronic"]);
    expect(ReceiptChannel.options).toEqual(["local", "remote"]);
    expect(ReceiptMediaType.options).toEqual([
      "image/jpeg",
      "image/png",
      "image/heic",
      "application/pdf",
    ]);
    expect(ReceiptLinkState.options).toEqual(["none", "linked", "journal_voided"]);
    expect(ReceiptWarningCode.options).toEqual([
      "FIELDS_MISSING",
      "INPUT_PERIOD_EXCEEDED",
      "RESOLUTION_BELOW_GUIDE",
      "NOT_FULL_COLOR",
      "JOURNAL_VOIDED",
    ]);
  });
});

describe("ReceiptCreateOptions", () => {
  it("区分だけで通る（値は任意、未入力は null でもよい）", () => {
    expect(ReceiptCreateOptions.safeParse({ category: "electronic" }).success).toBe(true);
    expect(
      ReceiptCreateOptions.safeParse({
        category: "paper_scan",
        transactionDate: null,
        amount: null,
        partnerName: null,
        memo: null,
      }).success,
    ).toBe(true);
  });

  it("区分がない・不正なら失敗", () => {
    expect(ReceiptCreateOptions.safeParse({}).success).toBe(false);
    expect(ReceiptCreateOptions.safeParse({ category: "scan" }).success).toBe(false);
  });

  it("金額は 0 が失敗、1 が通り、1e12 - 1 が通り、1e12 が失敗。小数も失敗", () => {
    const parse = (amount: number) =>
      ReceiptCreateOptions.safeParse({ category: "electronic", amount });
    expect(parse(0).success).toBe(false);
    expect(parse(1).success).toBe(true);
    expect(parse(999_999_999_999).success).toBe(true);
    expect(parse(1_000_000_000_000).success).toBe(false);
    expect(parse(10.5).success).toBe(false);
    expect(parse(-1).success).toBe(false);
  });

  it("日付は実在する YYYY-MM-DD だけ", () => {
    const parse = (transactionDate: string) =>
      ReceiptCreateOptions.safeParse({ category: "electronic", transactionDate });
    expect(parse("2026-10-31").success).toBe(true);
    expect(parse("2026-02-30").success).toBe(false);
    expect(parse("2026/10/31").success).toBe(false);
  });

  it("取引先は 1〜100 文字（空・空白だけは失敗）、メモは 500 文字まで", () => {
    const partner = (partnerName: string) =>
      ReceiptCreateOptions.safeParse({ category: "electronic", partnerName });
    expect(partner("あ".repeat(100)).success).toBe(true);
    expect(partner("あ".repeat(101)).success).toBe(false);
    expect(partner("").success).toBe(false);
    expect(partner("   ").success).toBe(false);
    const memo = (m: string) => ReceiptCreateOptions.safeParse({ category: "electronic", memo: m });
    expect(memo("a".repeat(500)).success).toBe(true);
    expect(memo("a".repeat(501)).success).toBe(false);
  });
});

describe("ReceiptUpdateInput・ReceiptReplaceOptions・ReceiptDeleteInput", () => {
  it("更新は version が要り、項目は任意（null で空にできる）、reason は任意", () => {
    expect(ReceiptUpdateInput.safeParse({ version: 1 }).success).toBe(true);
    expect(
      ReceiptUpdateInput.safeParse({
        category: "paper_scan",
        transactionDate: null,
        amount: 1200,
        partnerName: "テスト商事",
        memo: null,
        reason: "金額の読み違い",
        version: 3,
      }).success,
    ).toBe(true);
    expect(ReceiptUpdateInput.safeParse({ amount: 100 }).success).toBe(false);
    expect(ReceiptUpdateInput.safeParse({ version: 0 }).success).toBe(false);
    expect(ReceiptUpdateInput.safeParse({ version: 1, amount: 0 }).success).toBe(false);
  });

  it("差し替え・削除は reason（文字列。空の判定はドメイン）と version が要る", () => {
    expect(ReceiptReplaceOptions.safeParse({ reason: "撮り直し", version: 1 }).success).toBe(true);
    expect(ReceiptReplaceOptions.safeParse({ version: 1 }).success).toBe(false);
    expect(ReceiptDeleteInput.safeParse({ reason: "誤って追加", version: 2 }).success).toBe(true);
    expect(ReceiptDeleteInput.safeParse({ reason: "x" }).success).toBe(false);
  });
});

describe("結びつきの入力", () => {
  it("link は journalId が要り、replace・reason は任意", () => {
    expect(ReceiptLinkInput.safeParse({ journalId: ID }).success).toBe(true);
    expect(
      ReceiptLinkInput.safeParse({ journalId: ID, replace: true, reason: "付け替え" }).success,
    ).toBe(true);
    expect(ReceiptLinkInput.safeParse({ journalId: "x" }).success).toBe(false);
    expect(ReceiptLinkInput.safeParse({}).success).toBe(false);
  });
  it("unlink は reason が要る", () => {
    expect(ReceiptUnlinkInput.safeParse({ reason: "紐づけの誤り" }).success).toBe(true);
    expect(ReceiptUnlinkInput.safeParse({}).success).toBe(false);
  });
  it("journal は 001 の JournalInput と readingId（任意・null 可）", () => {
    const journal = {
      date: "2026-10-31",
      lines: [
        { side: "debit", accountId: ID, amount: 1000 },
        { side: "credit", accountId: ID, amount: 1000 },
      ],
    };
    expect(ReceiptJournalInput.safeParse({ journal }).success).toBe(true);
    expect(ReceiptJournalInput.safeParse({ journal, readingId: ID }).success).toBe(true);
    expect(ReceiptJournalInput.safeParse({ journal, readingId: null }).success).toBe(true);
    expect(
      ReceiptJournalInput.safeParse({ journal: { date: "2026-10-31", lines: [] } }).success,
    ).toBe(false);
  });
});

describe("パスのパラメーター", () => {
  it("ReceiptParam は UUID", () => {
    expect(ReceiptParam.safeParse({ receiptId: ID }).success).toBe(true);
    expect(ReceiptParam.safeParse({ receiptId: "abc" }).success).toBe(false);
  });
  it("ReceiptFileParam の sha256 は小文字の 16 進 64 文字", () => {
    expect(ReceiptFileParam.safeParse({ receiptId: ID, sha256: SHA }).success).toBe(true);
    expect(
      ReceiptFileParam.safeParse({ receiptId: ID, sha256: "0123456789abcdef".repeat(4) }).success,
    ).toBe(true);
    for (const sha256 of [
      "a".repeat(63),
      "a".repeat(65),
      "A".repeat(64),
      `${"a".repeat(63)}g`,
      "",
    ]) {
      expect(ReceiptFileParam.safeParse({ receiptId: ID, sha256 }).success, sha256).toBe(false);
    }
  });
});

describe("ReceiptQuery（data-model §2.3）", () => {
  it("空の検索は既定値（includeDeleted は false、limit は 100）", () => {
    const q = ReceiptQuery.parse({});
    expect(q.includeDeleted).toBe(false);
    expect(q.limit).toBe(100);
  });

  it("クエリ文字列（すべて文字列）を受け付ける", () => {
    const q = ReceiptQuery.parse({
      dateFrom: "2026-10-01",
      dateTo: "2026-10-31",
      amountMin: "1000",
      amountMax: "5000",
      partner: "テスト",
      category: "paper_scan",
      missing: "true",
      link: "journal_voided",
      includeDeleted: "true",
      limit: "50",
    });
    expect(q).toMatchObject({
      amountMin: 1000,
      amountMax: 5000,
      missing: true,
      includeDeleted: true,
      limit: 50,
      link: "journal_voided",
    });
  });

  it("limit は 1〜200、金額は 0 以上 1e12 未満、取引先は 1〜100 文字、link は 3 値", () => {
    expect(ReceiptQuery.safeParse({ limit: 0 }).success).toBe(false);
    expect(ReceiptQuery.safeParse({ limit: 201 }).success).toBe(false);
    expect(ReceiptQuery.safeParse({ limit: 200 }).success).toBe(true);
    expect(ReceiptQuery.safeParse({ amountMin: 1_000_000_000_000 }).success).toBe(false);
    expect(ReceiptQuery.safeParse({ partner: "" }).success).toBe(false);
    expect(ReceiptQuery.safeParse({ partner: "a".repeat(101) }).success).toBe(false);
    expect(ReceiptQuery.safeParse({ link: "voided" }).success).toBe(false);
    expect(ReceiptQuery.safeParse({ dateFrom: "2026-13-01" }).success).toBe(false);
  });
});

describe("出力の型", () => {
  const file = {
    sha256: SHA,
    fileVersion: 1,
    mediaType: "image/jpeg",
    sizeBytes: 1234,
    originalName: "receipt.jpg",
    width: 1654,
    height: 2338,
    fullColor: true,
    addedAt: NOW,
    channel: "local",
  };
  const summary = {
    id: ID,
    receivedAt: NOW,
    channel: "local",
    category: "paper_scan",
    transactionDate: null,
    amount: null,
    partnerName: null,
    mediaType: "image/jpeg",
    deleted: false,
    linkState: "none",
    journal: null,
    warnings: [{ code: "FIELDS_MISSING" }],
  };

  it("ReceiptSummary は値が null でも通り、warnings は details を持てる", () => {
    expect(ReceiptSummary.safeParse(summary).success).toBe(true);
    expect(
      ReceiptSummary.safeParse({
        ...summary,
        warnings: [{ code: "INPUT_PERIOD_EXCEEDED", details: { deadline: "2026-12-31" } }],
      }).success,
    ).toBe(true);
    expect(ReceiptWarning.safeParse({ code: "UNKNOWN" }).success).toBe(false);
  });

  it("ReceiptSummary の journal は JournalRef", () => {
    const journal = { id: ID, journalNo: 7, date: "2026-10-31", status: "active" };
    expect(ReceiptSummary.safeParse({ ...summary, linkState: "linked", journal }).success).toBe(
      true,
    );
  });

  it("ReceiptDetail は版・読み取り・削除の情報を持つ", () => {
    const detail = {
      ...summary,
      memo: null,
      version: 1,
      currentFile: file,
      files: [file],
      readings: [],
      deletedAt: null,
      deletedReason: null,
    };
    expect(ReceiptDetail.safeParse(detail).success).toBe(true);
    expect(
      ReceiptDetail.safeParse({ ...detail, currentFile: { ...file, sha256: "x" } }).success,
    ).toBe(false);
    // PDF は寸法・色を持たない
    expect(
      ReceiptDetail.safeParse({
        ...detail,
        currentFile: {
          ...file,
          mediaType: "application/pdf",
          width: null,
          height: null,
          fullColor: null,
        },
      }).success,
    ).toBe(true);
  });

  it("ReceiptReadingView は候補が null でもよく、reason は null か文字列", () => {
    const reading = {
      id: ID,
      readAt: NOW,
      model: "test-model",
      status: "succeeded",
      errorCode: null,
      candidates: {
        transactionDate: "2026-10-31",
        amount: 1100,
        partnerName: null,
        accountCode: null,
        taxCategory: "PURCHASE_10",
      },
      confidence: 80,
      reason: null,
    };
    expect(ReceiptReadingView.safeParse(reading).success).toBe(true);
    expect(ReceiptReadingView.safeParse({ ...reading, status: "unknown" }).success).toBe(false);
    expect(ReceiptReadingView.safeParse({ ...reading, confidence: 101 }).success).toBe(false);
  });

  it("ReceiptHistoryEntry の before・after は任意の値（null を含む）", () => {
    expect(
      ReceiptHistoryEntry.safeParse({
        occurredAt: NOW,
        targetType: "receipt",
        action: "create",
        reason: null,
        before: null,
        after: { category: "electronic" },
      }).success,
    ).toBe(true);
    expect(
      ReceiptHistoryEntry.safeParse({
        occurredAt: NOW,
        targetType: "receipt_link",
        action: "frobnicate",
        reason: null,
        before: null,
        after: null,
      }).success,
    ).toBe(false);
  });
});

describe("AiReceiptReading（R14）", () => {
  const ok = {
    transactionDate: "2026-10-31",
    amount: 1100,
    partnerName: "テスト商事",
    accountCode: "6000",
    taxCategory: "PURCHASE_10",
    confidence: 85,
    reason: "レシートの合計欄から読み取った",
  };

  it("全項目がそろえば通る", () => {
    expect(AiReceiptReading.safeParse(ok).success).toBe(true);
  });

  it("取引年月日・金額・取引先・科目・税区分は項目ごとに null を許す", () => {
    for (const key of [
      "transactionDate",
      "amount",
      "partnerName",
      "accountCode",
      "taxCategory",
    ] as const) {
      expect(AiReceiptReading.safeParse({ ...ok, [key]: null }).success, key).toBe(true);
    }
    expect(
      AiReceiptReading.safeParse({
        ...ok,
        transactionDate: null,
        amount: null,
        partnerName: null,
        accountCode: null,
        taxCategory: null,
      }).success,
    ).toBe(true);
  });

  it("項目ごとの検査: 実在しない日付・金額 0・1e12・101 文字の取引先・不明な税区分は失敗", () => {
    expect(AiReceiptReading.shape.transactionDate.safeParse("2026-02-30").success).toBe(false);
    expect(AiReceiptReading.shape.amount.safeParse(0).success).toBe(false);
    expect(AiReceiptReading.shape.amount.safeParse(1_000_000_000_000).success).toBe(false);
    expect(AiReceiptReading.shape.partnerName.safeParse("a".repeat(101)).success).toBe(false);
    expect(AiReceiptReading.shape.partnerName.safeParse("a".repeat(100)).success).toBe(true);
    expect(AiReceiptReading.shape.taxCategory.safeParse("PURCHASE_5").success).toBe(false);
    expect(AiReceiptReading.shape.confidence.safeParse(101).success).toBe(false);
    expect(AiReceiptReading.shape.confidence.safeParse(50.5).success).toBe(false);
  });

  it("reason は 200 字まで（201 字は失敗）", () => {
    expect(AiReceiptReading.safeParse({ ...ok, reason: "あ".repeat(200) }).success).toBe(true);
    expect(AiReceiptReading.safeParse({ ...ok, reason: "あ".repeat(201) }).success).toBe(false);
    expect(AiReceiptReading.shape.reason.safeParse("あ".repeat(201)).success).toBe(false);
  });
});
