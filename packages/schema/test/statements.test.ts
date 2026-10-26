import { describe, expect, it } from "vitest";
import {
  AiSettings,
  AiSettingsInput,
  AiSuggestion,
  Candidate,
  ErrorCode,
  EvalRun,
  InferenceRuleView,
  JOURNAL_SOURCES,
  JournalSource,
  StatementAccount,
  StatementAccountInput,
  StatementImportCommitInput,
  StatementImportPreview,
  StatementSettingsInput,
  StatementView,
} from "../src/index.ts";

const ID = "0190f3a0-0000-7000-8000-000000000001";
const ID2 = "0190f3a0-0000-7000-8000-000000000002";
const SHA = "a".repeat(64);
const NOW = "2026-10-25T09:00:00.000Z";

describe("ErrorCode（006 のコード、contracts/http-api.md §1）", () => {
  const added = [
    "STATEMENT_NOT_FOUND",
    "STATEMENT_ACCOUNT_NOT_FOUND",
    "INFERENCE_RULE_NOT_FOUND",
    "JOB_NOT_FOUND",
    "STATEMENT_PASTE_UNREADABLE",
    "STATEMENT_ACCOUNT_UNMAPPED",
    "STATEMENT_PLAN_CHANGED",
    "STATEMENT_ALREADY_REGISTERED",
    "STATEMENT_EXCLUDED",
    "STATEMENT_AMOUNT_MISMATCH",
    "JOURNAL_LINE_ALREADY_LINKED",
    "JOB_RUNNING",
    "AI_NOT_CONFIGURED",
  ];
  it("追加の13種がすべて入っている", () => {
    expect(new Set(added).size).toBe(13);
    for (const code of added) expect(ErrorCode.safeParse(code).success).toBe(true);
  });
});

describe("JOURNAL_SOURCES", () => {
  it("statement を含む", () => {
    expect(JOURNAL_SOURCES).toContain("statement");
    expect(JournalSource.safeParse("statement").success).toBe(true);
    expect(JournalSource.safeParse("bogus").success).toBe(false);
  });
});

describe("StatementAccountInput（H:§2.2）", () => {
  it("business・mixed は accountId が必須", () => {
    for (const usage of ["business", "mixed"] as const) {
      expect(StatementAccountInput.safeParse({ usage, kind: "bank" }).success).toBe(false);
      expect(StatementAccountInput.safeParse({ usage, kind: "bank", accountId: ID }).success).toBe(
        true,
      );
    }
  });
  it("private は accountId を持たない", () => {
    expect(StatementAccountInput.safeParse({ usage: "private", kind: "card" }).success).toBe(true);
    expect(
      StatementAccountInput.safeParse({ usage: "private", kind: "card", accountId: ID }).success,
    ).toBe(false);
    expect(
      StatementAccountInput.safeParse({
        usage: "private",
        kind: "card",
        accountId: ID,
        subAccountId: ID2,
      }).success,
    ).toBe(false);
  });
  it("subAccountId は任意、kind と usage は列挙値", () => {
    expect(
      StatementAccountInput.safeParse({
        usage: "business",
        kind: "cash",
        accountId: ID,
        subAccountId: ID2,
      }).success,
    ).toBe(true);
    expect(
      StatementAccountInput.safeParse({ usage: "other", kind: "bank", accountId: ID }).success,
    ).toBe(false);
    expect(
      StatementAccountInput.safeParse({ usage: "business", kind: "wallet", accountId: ID }).success,
    ).toBe(false);
  });
});

describe("StatementAccount（出力）", () => {
  const base = {
    id: ID,
    name: "テスト銀行",
    kind: "bank",
    subAccountId: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
  it("private は accountId が null、ほかは必須", () => {
    expect(StatementAccount.safeParse({ ...base, usage: "private", accountId: null }).success).toBe(
      true,
    );
    expect(StatementAccount.safeParse({ ...base, usage: "private", accountId: ID }).success).toBe(
      false,
    );
    expect(StatementAccount.safeParse({ ...base, usage: "mixed", accountId: null }).success).toBe(
      false,
    );
    expect(StatementAccount.safeParse({ ...base, usage: "mixed", accountId: ID }).success).toBe(
      true,
    );
  });
});

describe("AiSuggestion（R10）", () => {
  const ok = {
    accountCode: "6200",
    taxCategory: "PURCHASE_10",
    purpose: "business",
    confidence: 80,
    reason: "交通費",
  };
  it("正しい形を受ける", () => {
    expect(AiSuggestion.safeParse(ok).success).toBe(true);
  });
  it("確信度は 0〜100 の整数", () => {
    for (const confidence of [-1, 101, 50.5]) {
      expect(AiSuggestion.safeParse({ ...ok, confidence }).success).toBe(false);
    }
    for (const confidence of [0, 100]) {
      expect(AiSuggestion.safeParse({ ...ok, confidence }).success).toBe(true);
    }
  });
  it("reason は 200 字まで、purpose と税区分は列挙値", () => {
    expect(AiSuggestion.safeParse({ ...ok, reason: "あ".repeat(200) }).success).toBe(true);
    expect(AiSuggestion.safeParse({ ...ok, reason: "あ".repeat(201) }).success).toBe(false);
    expect(AiSuggestion.safeParse({ ...ok, purpose: "other" }).success).toBe(false);
    expect(AiSuggestion.safeParse({ ...ok, taxCategory: "BOGUS" }).success).toBe(false);
    expect(AiSuggestion.safeParse({ ...ok, accountCode: "" }).success).toBe(false);
  });
});

describe("AiSettings・AiSettingsInput（H:§7）", () => {
  it("設定の出力は API キーそのものを持たない", () => {
    const parsed = AiSettings.parse({
      localEnabled: true,
      localAvailable: false,
      externalEnabled: false,
      externalBaseUrl: null,
      externalModel: null,
      apiKeySet: false,
      apiKey: "secret",
    });
    expect(parsed).not.toHaveProperty("apiKey");
  });
  it("URL は https か localhost だけ", () => {
    const input = { localEnabled: true, externalEnabled: true, externalModel: "m" };
    expect(
      AiSettingsInput.safeParse({ ...input, externalBaseUrl: "https://api.example.com/v1" })
        .success,
    ).toBe(true);
    expect(
      AiSettingsInput.safeParse({ ...input, externalBaseUrl: "http://localhost:11434/v1" }).success,
    ).toBe(true);
    expect(
      AiSettingsInput.safeParse({ ...input, externalBaseUrl: "http://127.0.0.1:8080/v1" }).success,
    ).toBe(true);
    expect(
      AiSettingsInput.safeParse({ ...input, externalBaseUrl: "http://example.com/v1" }).success,
    ).toBe(false);
    expect(AiSettingsInput.safeParse({ ...input, externalBaseUrl: "ftp://x/v1" }).success).toBe(
      false,
    );
  });
  it("apiKey は任意（空文字は削除の意味で受ける）", () => {
    const input = { localEnabled: false, externalEnabled: false };
    expect(AiSettingsInput.safeParse(input).success).toBe(true);
    expect(AiSettingsInput.safeParse({ ...input, apiKey: "" }).success).toBe(true);
  });
});

describe("StatementSettingsInput（H:§6.3）", () => {
  it("しきい値は 0〜100 の整数", () => {
    expect(
      StatementSettingsInput.safeParse({ bulkThreshold: 80, externalThreshold: 60 }).success,
    ).toBe(true);
    expect(
      StatementSettingsInput.safeParse({ bulkThreshold: 101, externalThreshold: 60 }).success,
    ).toBe(false);
    expect(
      StatementSettingsInput.safeParse({ bulkThreshold: 80, externalThreshold: -1 }).success,
    ).toBe(false);
    expect(
      StatementSettingsInput.safeParse({ bulkThreshold: 80.5, externalThreshold: 60 }).success,
    ).toBe(false);
  });
});

describe("取込の入出力（H:§3）", () => {
  it("確定の入力は expected（sha256・countNew）が必須", () => {
    const source = { kind: "paste", text: "x", year: 2026 };
    expect(
      StatementImportCommitInput.safeParse({
        source,
        expected: { inputSha256: SHA, countNew: 3 },
      }).success,
    ).toBe(true);
    expect(StatementImportCommitInput.safeParse({ source }).success).toBe(false);
    // MF ME からの取得（取りやめ）の取込元は受け付けない
    expect(
      StatementImportCommitInput.safeParse({
        source: { kind: "mfme_fetch", jobId: ID },
        expected: { inputSha256: SHA, countNew: 0 },
      }).success,
    ).toBe(false);
  });

  it("プレビューの出力の形", () => {
    const preview = {
      inputSha256: SHA,
      period: { from: "2026-10-01", to: "2026-10-31" },
      totals: { inflow: 1000, outflow: 500 },
      rows: [
        {
          key: "銀行|2026-10-01|-500|ランチ|0",
          date: "2026-10-01",
          amount: -500,
          content: "ランチ",
          accountName: "銀行",
          status: "changed",
          changed: { before: { content: "a" }, after: { content: "b" } },
          warnings: ["POSSIBLE_DUPLICATE"],
        },
      ],
      unreadable: [{ line: 3, reason: "日付が読めません" }],
      unmappedAccounts: [],
      countNew: 0,
    };
    expect(StatementImportPreview.safeParse(preview).success).toBe(true);
    expect(
      StatementImportPreview.safeParse({
        ...preview,
        rows: [{ ...preview.rows[0], status: "bogus" }],
      }).success,
    ).toBe(false);
  });
});

describe("Candidate・StatementView・InferenceRuleView・EvalRun", () => {
  const candidate = {
    method: "rule",
    purpose: "business",
    confidence: 70,
    reason: "過去の同じ内容の明細 3 件と一致",
    draft: {
      date: "2026-10-01",
      lines: [
        { side: "debit", accountId: ID, amount: 500 },
        { side: "credit", accountId: ID2, amount: 500 },
      ],
    },
  };
  it("Candidate: none は purpose・confidence が null、draft が null", () => {
    expect(Candidate.safeParse(candidate).success).toBe(true);
    expect(
      Candidate.safeParse({
        method: "none",
        purpose: null,
        confidence: null,
        reason: "",
        draft: null,
      }).success,
    ).toBe(true);
    expect(Candidate.safeParse({ ...candidate, method: "magic" }).success).toBe(false);
    expect(Candidate.safeParse({ ...candidate, confidence: 101 }).success).toBe(false);
  });
  it("Candidate: match は journalId・lineId を持てる", () => {
    expect(
      Candidate.safeParse({
        method: "match",
        purpose: "business",
        confidence: 90,
        reason: "既存の仕訳",
        draft: null,
        match: { journalId: ID, lineId: ID2 },
      }).success,
    ).toBe(true);
  });
  it("StatementView の形", () => {
    const view = {
      id: ID,
      date: "2026-10-01",
      amount: -500,
      content: "ランチ",
      accountName: "銀行",
      usage: "business",
      status: "unprocessed",
      changed: null,
      candidate: candidate,
      links: [{ journalId: ID2, kind: "created" }],
    };
    expect(StatementView.safeParse(view).success).toBe(true);
    expect(StatementView.safeParse({ ...view, status: "changed" }).success).toBe(false);
    expect(StatementView.safeParse({ ...view, candidate: null, duplicateOf: [ID2] }).success).toBe(
      true,
    );
  });
  it("InferenceRuleView の形", () => {
    const rule = {
      id: ID,
      normalizedContent: "ランチ",
      statementAccountId: null,
      counterAccountId: ID2,
      counterSubAccountId: null,
      partnerId: null,
      taxCategory: "PURCHASE_10",
      purpose: "business",
      descriptionTemplate: null,
      hits: 3,
      overrides: 0,
      confidence: 80,
      status: "active",
      origin: "approval",
      createdAt: NOW,
      updatedAt: NOW,
    };
    expect(InferenceRuleView.safeParse(rule).success).toBe(true);
    expect(InferenceRuleView.safeParse({ ...rule, status: "gone" }).success).toBe(false);
  });
  it("EvalRun の形（率は千分率の整数）", () => {
    const run = {
      id: ID,
      splitDate: "2026-01-01",
      includeAi: false,
      sampleCount: 10,
      result: {
        fields: { counterAccount: 800, taxCategory: 900, partner: 700, purpose: 950 },
        methods: [{ method: "rule", count: 6, matchRate: 833 }],
      },
      models: [],
      createdAt: NOW,
    };
    expect(EvalRun.safeParse(run).success).toBe(true);
    expect(
      EvalRun.safeParse({
        ...run,
        result: { ...run.result, fields: { ...run.result.fields, purpose: 0.9 } },
      }).success,
    ).toBe(false);
  });
});
