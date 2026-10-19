import { describe, expect, it } from "vitest";
import {
  AccountMapping,
  ErrorCode,
  ImportBatch,
  ImportExpected,
  ImportOptions,
  ImportPlanItem,
  ImportPreview,
  ImportReasonCode,
  ImportWarningCode,
  MappingRow,
  TaxMapping,
  VoidImportInput,
} from "../src/index.ts";

const ID = "0190f3a0-0000-7000-8000-000000000001";
const ID2 = "0190f3a0-0000-7000-8000-000000000002";
const SHA = "a".repeat(64);

const batch = {
  id: ID,
  source: "freee_journal",
  fileName: "journal.csv",
  fileSha256: SHA,
  importedAt: "2026-10-19T00:00:00.000Z",
  periodFrom: "2025-01-01",
  periodTo: "2025-12-31",
  fiscalYears: [2025],
  countNew: 3,
  countAlready: 0,
  countExcluded: 1,
  countRejected: 0,
  countWarnings: 0,
  status: "active",
  voidedAt: null,
  voidReason: null,
};

describe("ImportOptions・ImportExpected", () => {
  it("ImportOptions はすべて省略できる", () => {
    expect(ImportOptions.parse({})).toEqual({});
    expect(
      ImportOptions.safeParse({ fiscalYears: [2025, 2026], include: ["1"], exclude: ["2"] })
        .success,
    ).toBe(true);
  });
  it.each([{ fiscalYears: [2025.5] }, { include: [""] }, { exclude: [1] }])(
    "不正な ImportOptions を拒否する %#",
    (input) => {
      expect(ImportOptions.safeParse(input).success).toBe(false);
    },
  );
  it("ImportExpected のハッシュは小文字16進64文字、countNew は正の整数", () => {
    expect(ImportExpected.safeParse({ fileSha256: SHA, countNew: 1 }).success).toBe(true);
    expect(ImportExpected.safeParse({ fileSha256: "A".repeat(64), countNew: 1 }).success).toBe(
      false,
    );
    expect(ImportExpected.safeParse({ fileSha256: "a".repeat(63), countNew: 1 }).success).toBe(
      false,
    );
    expect(ImportExpected.safeParse({ fileSha256: SHA, countNew: 0 }).success).toBe(false);
  });
});

describe("対応表", () => {
  it("AccountMapping は補助科目の ID と名前の両方を拒否する", () => {
    expect(AccountMapping.safeParse({ sourceName: "JALカード", accountId: ID }).success).toBe(true);
    expect(
      AccountMapping.safeParse({ sourceName: "JALカード", accountId: ID, subAccountId: ID2 })
        .success,
    ).toBe(true);
    expect(
      AccountMapping.safeParse({
        sourceName: "JALカード",
        accountId: ID,
        subAccountName: "JALカード",
      }).success,
    ).toBe(true);
    expect(
      AccountMapping.safeParse({
        sourceName: "JALカード",
        accountId: ID,
        subAccountId: ID2,
        subAccountName: "JALカード",
      }).success,
    ).toBe(false);
  });
  it("AccountMapping・TaxMapping は空の名前を拒否する", () => {
    expect(AccountMapping.safeParse({ sourceName: " ", accountId: ID }).success).toBe(false);
    expect(TaxMapping.safeParse({ sourceName: "", taxCategory: "SALES_10" }).success).toBe(false);
    expect(
      TaxMapping.safeParse({ sourceName: "課税売上10%", taxCategory: "SALES_10" }).success,
    ).toBe(true);
  });
  it("MappingRow: unmapped は対応先を持たず、saved・proposed は対応先を1つ持つ", () => {
    expect(MappingRow.safeParse({ sourceName: "損益", status: "unmapped" }).success).toBe(true);
    expect(
      MappingRow.safeParse({ sourceName: "損益", status: "unmapped", accountId: ID }).success,
    ).toBe(false);
    expect(MappingRow.safeParse({ sourceName: "交際費", status: "proposed" }).success).toBe(false);
    expect(
      MappingRow.safeParse({ sourceName: "交際費", status: "proposed", accountId: ID }).success,
    ).toBe(true);
    expect(
      MappingRow.safeParse({ sourceName: "対象外", status: "saved", taxCategory: "OUT_OF_SCOPE" })
        .success,
    ).toBe(true);
    expect(
      MappingRow.safeParse({
        sourceName: "x",
        status: "saved",
        accountId: ID,
        taxCategory: "OUT_OF_SCOPE",
      }).success,
    ).toBe(false);
    expect(
      MappingRow.safeParse({
        sourceName: "x",
        status: "saved",
        accountId: ID,
        subAccountId: ID2,
        subAccountName: "x",
      }).success,
    ).toBe(false);
  });
});

describe("判定と警告のコード（data-model §3）", () => {
  it("判定の理由のコード", () => {
    expect(ImportReasonCode.options).toEqual([
      "PRIOR_YEAR_CLOSING",
      "YEAR_NOT_SELECTED",
      "USER_EXCLUDED",
      "UNBALANCED",
      "INVALID_AMOUNT",
      "MISSING_FIELD",
      "LINE_COUNT_MISMATCH",
      "OUT_OF_PERIOD",
      "PERIOD_CLOSED",
      "UNMAPPED",
      "ACCOUNT_INACTIVE",
      "ALREADY_IMPORTED",
    ]);
  });
  it("警告のコード", () => {
    expect(ImportWarningCode.options).toEqual([
      "TAX_AMOUNT_MISMATCH",
      "TAX_CATEGORY_SUSPICIOUS",
      "POSSIBLE_DUPLICATE",
      "FREEE_CHANGED",
      "FREEE_DELETED",
      "NEGATIVE_OPENING",
      "OPENING_DIFFERS_FROM_CARRY_FORWARD",
    ]);
  });
  it("エラーコードに取込のコードがある（contracts/http-api.md）", () => {
    for (const code of [
      "IMPORT_UNKNOWN_FORMAT",
      "IMPORT_WRONG_KIND",
      "IMPORT_FILE_CHANGED",
      "IMPORT_PLAN_CHANGED",
      "IMPORT_NOT_READY",
      "IMPORT_BATCH_VOIDED",
      "CORRECTED_JOURNALS",
      "IMPORT_BATCH_NOT_FOUND",
      "FILE_TOO_LARGE",
    ]) {
      expect(ErrorCode.safeParse(code).success).toBe(true);
    }
  });
});

const newItem = {
  freeeJournalId: "1001",
  freeeJournalNo: "1",
  date: "2025-03-01",
  decision: "new",
  draft: {
    date: "2025-03-01",
    lines: [
      { side: "debit", accountId: ID, amount: 1000, taxCategory: "OUT_OF_SCOPE" },
      { side: "credit", accountId: ID2, amount: 1000, taxCategory: "OUT_OF_SCOPE" },
    ],
  },
  warnings: [],
};

describe("ImportPlanItem", () => {
  it("new は理由を持たず、仕訳の下書きを持つ", () => {
    expect(ImportPlanItem.safeParse(newItem).success).toBe(true);
    expect(ImportPlanItem.safeParse({ ...newItem, draft: undefined }).success).toBe(false);
    expect(ImportPlanItem.safeParse({ ...newItem, reason: "UNMAPPED" }).success).toBe(false);
  });
  it("判定と理由の組み合わせを検証する", () => {
    const item = (decision: string, reason: string) => ({
      freeeJournalId: "1",
      freeeJournalNo: null,
      date: "2025-01-01",
      decision,
      reason,
      warnings: [],
    });
    expect(ImportPlanItem.safeParse(item("excluded", "PRIOR_YEAR_CLOSING")).success).toBe(true);
    expect(ImportPlanItem.safeParse(item("rejected", "UNMAPPED")).success).toBe(true);
    expect(ImportPlanItem.safeParse(item("already", "ALREADY_IMPORTED")).success).toBe(true);
    expect(ImportPlanItem.safeParse(item("excluded", "UNMAPPED")).success).toBe(false);
    expect(ImportPlanItem.safeParse(item("rejected", "ALREADY_IMPORTED")).success).toBe(false);
    expect(ImportPlanItem.safeParse(item("already", "USER_EXCLUDED")).success).toBe(false);
  });
});

describe("ImportPreview", () => {
  it("contracts/http-api.md の要約の形を受け付ける", () => {
    const preview = {
      file: {
        name: "journal.csv",
        sha256: SHA,
        kind: "journal",
        encoding: "utf-8",
        rowCount: 2,
      },
      years: [
        {
          fiscalYear: 2025,
          hasPeriod: true,
          closed: false,
          counts: { new: 1, already: 0, excluded: 0, rejected: 0 },
        },
      ],
      counts: { new: 1, already: 0, excluded: 0, rejected: 0, warnings: 1 },
      totals: { debit: 1000, credit: 1000 },
      items: [newItem],
      mappings: {
        accounts: [{ sourceName: "現金", status: "proposed", accountId: ID }],
        taxes: [{ sourceName: "対象外", status: "saved", taxCategory: "OUT_OF_SCOPE" }],
      },
      toCreate: { subAccounts: [{ accountId: ID, name: "JALカード" }], partners: [], tags: [] },
      warnings: [
        {
          code: "FREEE_CHANGED",
          message: "freee 側で変更されています",
          freeeJournalId: "1001",
          details: { before: "{}", after: "{}" },
        },
      ],
      ready: true,
    };
    expect(ImportPreview.safeParse(preview).success).toBe(true);
    expect(
      ImportPreview.safeParse({ ...preview, file: { ...preview.file, kind: "ledger" } }).success,
    ).toBe(false);
  });
});

describe("ImportBatch・VoidImportInput", () => {
  it("有効な取込の回を受け付ける", () => {
    expect(ImportBatch.safeParse(batch).success).toBe(true);
  });
  it("voided は取消の日時と理由が必要", () => {
    expect(
      ImportBatch.safeParse({
        ...batch,
        status: "voided",
        voidedAt: "2026-10-20T00:00:00.000Z",
        voidReason: "誤り",
      }).success,
    ).toBe(true);
    expect(
      ImportBatch.safeParse({ ...batch, status: "voided", voidedAt: "2026-10-20T00:00:00.000Z" })
        .success,
    ).toBe(false);
  });
  it("countNew は1以上", () => {
    expect(ImportBatch.safeParse({ ...batch, countNew: 0 }).success).toBe(false);
  });
  it("VoidImportInput の confirmCorrected は省略できる", () => {
    expect(VoidImportInput.safeParse({ reason: "誤り" }).success).toBe(true);
    expect(VoidImportInput.safeParse({ reason: "誤り", confirmCorrected: true }).success).toBe(
      true,
    );
    expect(VoidImportInput.safeParse({ confirmCorrected: true }).success).toBe(false);
  });
});
