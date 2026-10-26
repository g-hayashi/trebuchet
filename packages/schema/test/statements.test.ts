import { describe, expect, it } from "vitest";
import {
  AiColumnSuggestion,
  AiSettings,
  AiSettingsInput,
  AiSuggestion,
  Candidate,
  ErrorCode,
  EvalRun,
  InferenceRuleView,
  JOURNAL_SOURCES,
  JournalSource,
  STATEMENT_ORIGINS,
  StatementAccount,
  StatementAccountInput,
  StatementBatch,
  StatementColumnMapping,
  StatementColumnSuggestionOptions,
  StatementCommitOptions,
  StatementEncoding,
  StatementImportCommitInput,
  StatementImportPreview,
  StatementLayoutOptions,
  StatementPreviewOptions,
  StatementSettingsInput,
  StatementSource,
  StatementTableLayout,
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

// ---- 007-generic-statement-import（data-model §3、contracts/http-api.md §1〜§4） ----

describe("ErrorCode（007 のコード）", () => {
  it("新しい 5 種が入っている", () => {
    for (const code of [
      "STATEMENT_TABLE_UNREADABLE",
      "STATEMENT_TABLE_TOO_LARGE",
      "STATEMENT_MAPPING_INVALID",
      "STATEMENT_SOURCE_NOT_FOUND",
      "STATEMENT_SOURCE_NAME_TAKEN",
    ]) {
      expect(ErrorCode.safeParse(code).success, code).toBe(true);
    }
  });
});

describe("STATEMENT_ORIGINS・StatementBatch（007）", () => {
  it("paste と file だけ（mfme_fetch は取りやめ）", () => {
    expect([...STATEMENT_ORIGINS]).toEqual(["paste", "file"]);
  });
  it("StatementBatch は sourceName（文字列か null）を持つ", () => {
    const batch = {
      id: ID,
      origin: "file",
      sourceName: null,
      inputSha256: SHA,
      periodFrom: "2026-10-01",
      periodTo: "2026-10-31",
      countNew: 1,
      countExisting: 0,
      countUnreadable: 0,
      createdAt: NOW,
    };
    expect(StatementBatch.safeParse(batch).success).toBe(true);
    expect(StatementBatch.safeParse({ ...batch, sourceName: "A銀行" }).success).toBe(true);
    expect(StatementBatch.safeParse({ ...batch, origin: "mfme_fetch" }).success).toBe(false);
  });
});

describe("StatementColumnMapping（data-model §3）", () => {
  const base = {
    delimiter: ",",
    headerRow: 0,
    columns: { date: 0, content: 1, amount: 2 },
    amountSign: "inflow_positive",
  };
  const ok = (v: unknown) => StatementColumnMapping.safeParse(v).success;

  it("金額 1 列、出金・入金の 2 列のどちらも受ける。見出しなし（null）も受ける", () => {
    expect(ok(base)).toBe(true);
    expect(ok({ ...base, headerRow: null })).toBe(true);
    expect(
      ok({
        delimiter: "\t",
        headerRow: 2,
        columns: { date: 0, content: 1, outflow: 2, inflow: 3, accountName: 4, memo: 5 },
      }),
    ).toBe(true);
  });

  it("区切り文字は タブ・カンマ・セミコロンだけ", () => {
    expect(ok({ ...base, delimiter: ";" })).toBe(true);
    expect(ok({ ...base, delimiter: "|" })).toBe(false);
  });

  it("date・content が必須", () => {
    expect(ok({ ...base, columns: { content: 1, amount: 2 } })).toBe(false);
    expect(ok({ ...base, columns: { date: 0, amount: 2 } })).toBe(false);
  });

  it("amount か、outflow と inflow の両方の、どちらか一方だけ", () => {
    expect(ok({ ...base, columns: { date: 0, content: 1 } })).toBe(false);
    expect(ok({ ...base, columns: { date: 0, content: 1, outflow: 2 } })).toBe(false);
    expect(ok({ ...base, columns: { date: 0, content: 1, inflow: 2 } })).toBe(false);
    expect(
      ok({ ...base, columns: { date: 0, content: 1, amount: 2, outflow: 3, inflow: 4 } }),
    ).toBe(false);
    expect(ok({ ...base, columns: { date: 0, content: 1, amount: 2, outflow: 3 } })).toBe(false);
  });

  it("amount があれば amountSign が必須。出金・入金の 2 列なら不要", () => {
    const { amountSign: _omit, ...noSign } = base;
    expect(ok(noSign)).toBe(false);
    expect(ok({ ...base, amountSign: "outflow_positive" })).toBe(true);
    expect(ok({ ...base, amountSign: "bogus" })).toBe(false);
    expect(
      ok({ delimiter: ",", headerRow: 0, columns: { date: 0, content: 1, outflow: 2, inflow: 3 } }),
    ).toBe(true);
  });

  it("同じ列の番号を 2 つの役割に使わない", () => {
    expect(ok({ ...base, columns: { date: 0, content: 0, amount: 2 } })).toBe(false);
    expect(ok({ ...base, columns: { date: 0, content: 1, amount: 2, memo: 2 } })).toBe(false);
  });

  it("列の番号は 0〜49 の整数", () => {
    expect(ok({ ...base, columns: { date: 0, content: 1, amount: 49 } })).toBe(true);
    expect(ok({ ...base, columns: { date: 0, content: 1, amount: 50 } })).toBe(false);
    expect(ok({ ...base, columns: { date: -1, content: 1, amount: 2 } })).toBe(false);
    expect(ok({ ...base, columns: { date: 0.5, content: 1, amount: 2 } })).toBe(false);
  });

  it("headerRow は 0 以上の整数か null。知らない役割は受けない", () => {
    expect(ok({ ...base, headerRow: -1 })).toBe(false);
    expect(ok({ ...base, headerRow: 1.5 })).toBe(false);
    expect(ok({ ...base, columns: { ...base.columns, bogus: 5 } })).toBe(false);
  });
});

describe("StatementEncoding・StatementSource・StatementTableLayout", () => {
  const mapping = {
    delimiter: ",",
    headerRow: 0,
    columns: { date: 0, content: 1, amount: 2 },
    amountSign: "inflow_positive",
  };
  const source = {
    id: ID,
    name: "A銀行",
    fixedAccountName: "A銀行 普通",
    mapping,
    header: ["日付", "内容", "金額"],
    lastUsedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  };

  it("エンコーディングは utf-8 と shift_jis", () => {
    expect(StatementEncoding.safeParse("utf-8").success).toBe(true);
    expect(StatementEncoding.safeParse("shift_jis").success).toBe(true);
    expect(StatementEncoding.safeParse("euc-jp").success).toBe(false);
  });

  it("StatementSource: fixedAccountName・header は null も受ける", () => {
    expect(StatementSource.safeParse(source).success).toBe(true);
    expect(
      StatementSource.safeParse({ ...source, fixedAccountName: null, header: null }).success,
    ).toBe(true);
    expect(
      StatementSource.safeParse({ ...source, mapping: { ...mapping, columns: {} } }).success,
    ).toBe(false);
  });

  const layout = {
    encoding: "utf-8",
    delimiter: ",",
    headerRow: 0,
    header: ["日付", "内容", "金額"],
    columnCount: 3,
    rowCount: 12,
    sampleRows: [["2026/10/01", "ランチ", "-500"]],
    needsYear: false,
    suggestedColumns: { date: 0, content: 1, amount: 2 },
    match: { kind: "none" },
  };
  it("StatementTableLayout: match の 3 種と headerDiff", () => {
    expect(StatementTableLayout.safeParse(layout).success).toBe(true);
    expect(
      StatementTableLayout.safeParse({ ...layout, match: { kind: "one", source } }).success,
    ).toBe(true);
    expect(
      StatementTableLayout.safeParse({
        ...layout,
        match: { kind: "many", sources: [source, source] },
        headerDiff: { added: ["備考"], removed: [] },
      }).success,
    ).toBe(true);
    expect(StatementTableLayout.safeParse({ ...layout, match: { kind: "other" } }).success).toBe(
      false,
    );
    expect(
      StatementTableLayout.safeParse({ ...layout, headerRow: null, header: null }).success,
    ).toBe(true);
  });
  it("sampleRows は 10 行まで", () => {
    const rows = Array.from({ length: 11 }, () => ["a"]);
    expect(
      StatementTableLayout.safeParse({ ...layout, sampleRows: rows.slice(0, 10) }).success,
    ).toBe(true);
    expect(StatementTableLayout.safeParse({ ...layout, sampleRows: rows }).success).toBe(false);
  });
});

describe("取込の options（contracts §2.1〜§2.3・§4.1）", () => {
  const mapping = {
    delimiter: "\t",
    headerRow: 0,
    columns: { date: 0, content: 1, amount: 2 },
    amountSign: "inflow_positive",
  };

  it("layout: origin が必須。ほかは任意。encoding・delimiter・headerRow は選び直し", () => {
    expect(StatementLayoutOptions.safeParse({ origin: "paste" }).success).toBe(true);
    expect(
      StatementLayoutOptions.safeParse({
        origin: "file",
        sourceId: ID,
        encoding: "shift_jis",
        delimiter: ";",
        headerRow: null,
      }).success,
    ).toBe(true);
    expect(StatementLayoutOptions.safeParse({}).success).toBe(false);
    expect(StatementLayoutOptions.safeParse({ origin: "mfme_fetch" }).success).toBe(false);
    expect(StatementLayoutOptions.safeParse({ origin: "file", encoding: "euc-jp" }).success).toBe(
      false,
    );
  });

  it("column-suggestion: origin が必須。sourceId は持たない", () => {
    expect(
      StatementColumnSuggestionOptions.safeParse({
        origin: "file",
        encoding: "utf-8",
        delimiter: ",",
        headerRow: 1,
      }).success,
    ).toBe(true);
    expect(StatementColumnSuggestionOptions.safeParse({ delimiter: "," }).success).toBe(false);
  });

  const preview = { origin: "file", year: 2026, mapping };
  it("preview: year・mapping が必須。fixedAccountName・sourceId・encoding は任意", () => {
    expect(StatementPreviewOptions.safeParse(preview).success).toBe(true);
    expect(
      StatementPreviewOptions.safeParse({
        ...preview,
        fixedAccountName: "A銀行",
        sourceId: ID,
        encoding: "shift_jis",
      }).success,
    ).toBe(true);
    expect(StatementPreviewOptions.safeParse({ origin: "file", mapping }).success).toBe(false);
    expect(StatementPreviewOptions.safeParse({ ...preview, year: 1800 }).success).toBe(false);
    expect(
      StatementPreviewOptions.safeParse({ ...preview, mapping: { ...mapping, columns: {} } })
        .success,
    ).toBe(false);
  });

  const commit = {
    ...preview,
    expected: { inputSha256: SHA, countNew: 3 },
    accounts: [{ name: "A銀行", input: { usage: "business", kind: "bank", accountId: ID } }],
    saveSource: { name: "A銀行" },
  };
  it("commit: expected・accounts・saveSource が必須。saveSource は null で保存しない", () => {
    expect(StatementCommitOptions.safeParse(commit).success).toBe(true);
    expect(StatementCommitOptions.safeParse({ ...commit, saveSource: null }).success).toBe(true);
    expect(
      StatementCommitOptions.safeParse({ ...commit, saveSource: { id: ID, name: "B" } }).success,
    ).toBe(true);
    expect(StatementCommitOptions.safeParse({ ...commit, accounts: [] }).success).toBe(true);
    const { expected: _e, ...noExpected } = commit;
    expect(StatementCommitOptions.safeParse(noExpected).success).toBe(false);
    const { saveSource: _s, ...noSave } = commit;
    expect(StatementCommitOptions.safeParse(noSave).success).toBe(false);
    expect(StatementCommitOptions.safeParse({ ...commit, saveSource: { name: "" } }).success).toBe(
      false,
    );
    expect(
      StatementCommitOptions.safeParse({ ...commit, saveSource: { name: "あ".repeat(101) } })
        .success,
    ).toBe(false);
    expect(
      StatementCommitOptions.safeParse({
        ...commit,
        accounts: [{ name: "A銀行", input: { usage: "private", kind: "bank", accountId: ID } }],
      }).success,
    ).toBe(false);
  });
});

describe("StatementImportPreview.unmappedAccounts（007）", () => {
  const preview = {
    inputSha256: SHA,
    period: { from: "2026-10-01", to: "2026-10-31" },
    totals: { inflow: 0, outflow: 0 },
    rows: [],
    unreadable: [],
    countNew: 0,
  };
  it("{ name, suggestion } の配列。suggestion は null か口座の案", () => {
    const suggestion = {
      kind: "bank",
      accountId: ID,
      subAccountId: null,
      usage: "business",
      cues: ["見出しに「銀行」"],
    };
    expect(
      StatementImportPreview.safeParse({
        ...preview,
        unmappedAccounts: [
          { name: "A銀行", suggestion },
          { name: "B", suggestion: null },
          { name: "C", suggestion: { ...suggestion, usage: null, subAccountId: ID2 } },
        ],
      }).success,
    ).toBe(true);
    expect(
      StatementImportPreview.safeParse({ ...preview, unmappedAccounts: ["A銀行"] }).success,
    ).toBe(false);
    expect(
      StatementImportPreview.safeParse({
        ...preview,
        unmappedAccounts: [{ name: "A", suggestion: { ...suggestion, kind: "bogus" } }],
      }).success,
    ).toBe(false);
  });
});

describe("AiColumnSuggestion（007/R10）", () => {
  const ok = {
    columns: { date: 0, content: 1, amount: 2, memo: null },
    amountSign: "outflow_positive",
    confidence: 80,
    reason: "見出しから判断",
  };
  it("役割ごとの列の番号か null。amountSign は任意", () => {
    expect(AiColumnSuggestion.safeParse(ok).success).toBe(true);
    const { amountSign: _a, ...noSign } = ok;
    expect(AiColumnSuggestion.safeParse(noSign).success).toBe(true);
    expect(AiColumnSuggestion.safeParse({ ...ok, amountSign: null }).success).toBe(true);
    expect(AiColumnSuggestion.safeParse({ ...ok, columns: { date: "A" } }).success).toBe(false);
    expect(AiColumnSuggestion.safeParse({ ...ok, columns: { bogus: 1 } }).success).toBe(false);
    expect(AiColumnSuggestion.safeParse({ ...ok, amountSign: "bogus" }).success).toBe(false);
  });
  it("confidence は 0〜100 の整数、reason は 200 字以内", () => {
    for (const confidence of [-1, 101, 50.5]) {
      expect(AiColumnSuggestion.safeParse({ ...ok, confidence }).success).toBe(false);
    }
    expect(AiColumnSuggestion.safeParse({ ...ok, reason: "あ".repeat(200) }).success).toBe(true);
    expect(AiColumnSuggestion.safeParse({ ...ok, reason: "あ".repeat(201) }).success).toBe(false);
  });
});
