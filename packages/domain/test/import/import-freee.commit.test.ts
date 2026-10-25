import { describe, expect, it } from "vitest";
import { canonicalSnapshot } from "../../src/import/freee/plan.ts";
import { groupFreeeJournals, readFreeeFile } from "../../src/import/freee/read.ts";
import { TAX_CATEGORIES } from "../../src/seed/tax-categories.ts";
import { TAX_RATES } from "../../src/seed/tax-rates.ts";
import { createEntity } from "../../src/usecases/create-entity.ts";
import {
  commitFreeeImport,
  previewFreeeImport,
  saveImportMappings,
} from "../../src/usecases/import-freee.ts";
import {
  FixedClock,
  fakeImportUnitOfWork,
  InMemoryLedgerRepository,
  InMemoryMasterRepository,
  InMemoryRegistry,
  SequentialIds,
} from "../fakes.ts";
import { EXPECTED_JOURNAL, FIXTURE_FILES } from "../fixtures/freee/expected.ts";
import { readFixture } from "../fixtures/freee/load.ts";
import { accountIdOfCode } from "../ledger-setup.ts";
import { NOW, SHA } from "./import-usecase-setup.ts";

const OTHER_SHA = "b".repeat(64);
const FILE_NAME = "journal-2025.csv";

function setup() {
  const masters = new InMemoryMasterRepository();
  const ids = new SequentialIds();
  const created = createEntity(
    {
      registry: new InMemoryRegistry(),
      openTenant: () => masters,
      ids,
      clock: new FixedClock(NOW),
    },
    { name: "テスト", kind: "individual", fiscalStartMonth: 1, firstFiscalYear: 2025 },
  );
  if (!created.ok) throw new Error(JSON.stringify(created.error));
  masters.state.taxRates = [...TAX_RATES];
  masters.state.taxCategories = [...TAX_CATEGORIES];
  masters.replaceTaxSettings([
    {
      id: ids.next(),
      effectiveFrom: "2025-01-01",
      taxpayerStatus: "general",
      accountingMethod: "tax_included",
    },
  ]);
  const ledger = new InMemoryLedgerRepository();
  const uow = fakeImportUnitOfWork(ledger, masters);
  const code = (c: string) => accountIdOfCode(masters, c);
  return { uow, masters, ledger, ids, clock: new FixedClock(NOW), code };
}

const bytes = () => readFixture(FIXTURE_FILES.journal);
const input = (overrides = {}) => ({
  bytes: bytes(),
  fileName: FILE_NAME,
  sha256: SHA,
  options: {},
  expected: { fileSha256: SHA, countNew: EXPECTED_JOURNAL.journalCount - 1 },
  ...overrides,
});

const stateOf = (s: ReturnType<typeof setup>) =>
  structuredClone({
    ledger: s.ledger.state,
    masters: s.masters.state,
    imports: s.uow.imports.state,
  });

function freeeJournals() {
  const file = readFreeeFile(bytes());
  if (!file.ok) throw new Error("読めない");
  return groupFreeeJournals(file.value).journals;
}

describe("previewFreeeImport", () => {
  it("プレビューを返し、何も書かない", () => {
    const s = setup();
    const before = stateOf(s);
    const result = previewFreeeImport({ uow: s.uow }, input());
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    expect(result.value.file).toEqual({
      name: FILE_NAME,
      sha256: SHA,
      kind: "journal",
      encoding: "utf-8",
      rowCount: EXPECTED_JOURNAL.rowCount,
    });
    expect(result.value.counts).toMatchObject({ new: 14, excluded: 1 });
    expect(result.value.ready).toBe(true);
    expect(stateOf(s)).toEqual(before);
  });

  it("元帳 → IMPORT_WRONG_KIND、判別できないファイル → IMPORT_UNKNOWN_FORMAT", () => {
    const s = setup();
    const ledger = previewFreeeImport(
      { uow: s.uow },
      input({ bytes: readFixture(FIXTURE_FILES.ledger) }),
    );
    expect(ledger.ok ? undefined : ledger.error.code).toBe("IMPORT_WRONG_KIND");
    const unknown = previewFreeeImport(
      { uow: s.uow },
      input({ bytes: new TextEncoder().encode("a,b,c\n1,2,3\n") }),
    );
    expect(unknown.ok ? undefined : unknown.error).toMatchObject({
      code: "IMPORT_UNKNOWN_FORMAT",
      details: { expected: "journal" },
    });
  });
});

describe("commitFreeeImport", () => {
  it("ハッシュの不一致 → IMPORT_FILE_CHANGED（何も書かない）", () => {
    const s = setup();
    const before = stateOf(s);
    const result = commitFreeeImport(
      s,
      input({ expected: { fileSha256: OTHER_SHA, countNew: 14 } }),
    );
    expect(result.ok ? undefined : result.error.code).toBe("IMPORT_FILE_CHANGED");
    expect(stateOf(s)).toEqual(before);
  });

  it("作り直した countNew の不一致 → IMPORT_PLAN_CHANGED（details.preview つき）", () => {
    const s = setup();
    const before = stateOf(s);
    const result = commitFreeeImport(s, input({ expected: { fileSha256: SHA, countNew: 13 } }));
    if (result.ok) throw new Error("成功してはいけない");
    expect(result.error.code).toBe("IMPORT_PLAN_CHANGED");
    expect(result.error.details?.preview).toMatchObject({ counts: { new: 14 } });
    expect(stateOf(s)).toEqual(before);
  });

  it("ready = false → IMPORT_NOT_READY（details.unmapped に未定の名前）", () => {
    const s = setup();
    const before = stateOf(s);
    const result = commitFreeeImport(
      s,
      input({
        options: { include: ["900000011"] },
        expected: { fileSha256: SHA, countNew: 14 },
      }),
    );
    if (result.ok) throw new Error("成功してはいけない");
    expect(result.error.code).toBe("IMPORT_NOT_READY");
    expect(result.error.details?.unmapped).toEqual(["損益"]);
    expect(stateOf(s)).toEqual(before);
  });

  it("成功: マスタを作ってから仕訳を登録し、採番・監査ログ・参照・取込の回を書く", () => {
    const s = setup();
    // 既存の手入力の仕訳（No.1）。取込の仕訳はその次から採番する
    s.ledger.insertJournal({
      id: "manual-1",
      journalNo: s.ledger.nextJournalNo(),
      date: "2025-12-31",
      fiscalPeriodId: s.masters.state.periods[0]?.id ?? "",
      memo: null,
      correctsJournalId: null,
      createdAt: NOW,
      lines: [
        {
          id: "m-1",
          lineNo: 1,
          side: "debit",
          accountId: s.code("1010"),
          subAccountId: null,
          amount: 1,
          taxCategory: "OUT_OF_SCOPE",
          taxAmount: 0,
          partnerId: null,
          description: null,
          tagIds: [],
        },
        {
          id: "m-2",
          lineNo: 2,
          side: "credit",
          accountId: s.code("3010"),
          subAccountId: null,
          amount: 1,
          taxCategory: "OUT_OF_SCOPE",
          taxAmount: 0,
          partnerId: null,
          description: null,
          tagIds: [],
        },
      ],
    });

    const result = commitFreeeImport(s, input());
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    const { batch, preview } = result.value;

    // マスタ
    const card = s.masters.state.subAccounts.find((x) => x.name === "ABCカード");
    expect(card).toMatchObject({ accountId: s.code("2020"), isActive: true });
    expect(s.masters.state.partners.map((p) => p.name)).toEqual([
      "株式会社サンプル",
      "(株)テスト飯店",
    ]);
    expect(s.masters.state.tags.map((t) => t.name)).toEqual(["案件A"]);

    // 仕訳
    const imported = s.ledger.journals.filter((j) => j.source === "import_freee");
    expect(imported).toHaveLength(14);
    expect(imported.map((j) => j.journalNo)).toEqual(Array.from({ length: 14 }, (_, i) => i + 2));
    const dates = imported.map((j) => j.date);
    expect(dates).toEqual([...dates].sort());
    const masterIds = [
      card?.id,
      ...s.masters.state.partners.map((p) => p.id),
      ...s.masters.state.tags.map((t) => t.id),
    ].map(String);
    for (const j of imported) {
      for (const id of masterIds) expect(id < j.id, "マスタを先に作る").toBe(true);
      for (const l of j.lines) {
        expect(JSON.stringify(l)).not.toContain("new:");
      }
    }
    const sale = imported.find((j) => j.date === "2025-01-10");
    expect(sale?.lines[1]).toMatchObject({
      accountId: s.code("4010"),
      taxCategory: "SALES_10",
      taxAmount: 30_000,
      partnerId: s.masters.state.partners[0]?.id,
      tagIds: [s.masters.state.tags[0]?.id],
      description: "１月分　業務委託料",
    });

    // 監査ログ
    const audits = s.ledger.audits.filter(
      (a) => a.action === "create" && a.targetType === "journal",
    );
    expect(audits).toHaveLength(14);
    const freee = freeeJournals();
    for (const a of audits) {
      const after = JSON.parse(a.afterJson ?? "{}");
      expect(after).toMatchObject({ source: "import_freee", importBatchId: batch.id });
      expect(freee.map((j) => j.freeeJournalId)).toContain(after.freeeJournalId);
      expect(a.occurredAt).toBe(NOW);
    }

    // 参照
    const refs = s.uow.imports.refs;
    expect(refs).toHaveLength(14);
    for (const r of refs) {
      const fj = freee.find((j) => j.freeeJournalId === r.freeeJournalId);
      if (fj === undefined) throw new Error("freee の仕訳がない");
      const journal = s.ledger.journals.find((j) => j.id === r.journalId);
      expect(r).toMatchObject({
        batchId: batch.id,
        freeeJournalNo: fj.freeeJournalNo,
        freeeDate: fj.date,
        snapshotJson: canonicalSnapshot(fj),
        revokedAt: null,
      });
      expect(journal?.date).toBe(fj.date);
    }

    // 取込の回
    expect(batch).toEqual({
      id: batch.id,
      source: "freee_journal",
      fileName: FILE_NAME,
      fileSha256: SHA,
      importedAt: NOW,
      periodFrom: "2025-01-10",
      periodTo: "2025-12-31",
      fiscalYears: [2025],
      countNew: 14,
      countAlready: 0,
      countExcluded: 1,
      countRejected: 0,
      countWarnings: preview.counts.warnings,
      status: "active",
      voidedAt: null,
      voidReason: null,
    });
    expect(s.uow.imports.batches).toEqual([batch]);
    expect(preview.file.sha256).toBe(SHA);
  });

  it("仕訳番号は 日付 → freee の仕訳番号 → 仕訳ID の順（research R15）", () => {
    const s = setup();
    const result = commitFreeeImport(s, input());
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    const refs = new Map(s.uow.imports.refs.map((r) => [r.journalId, r]));
    const order = [...s.ledger.journals]
      .sort((a, b) => a.journalNo - b.journalNo)
      .map((j) => refs.get(j.id)?.freeeJournalId);
    const expected = freeeJournals()
      .filter((j) => j.freeeJournalId !== "900000011")
      .sort(
        (a, b) =>
          a.date.localeCompare(b.date) ||
          Number(a.freeeJournalNo) - Number(b.freeeJournalNo) ||
          a.freeeJournalId.localeCompare(b.freeeJournalId),
      )
      .map((j) => j.freeeJournalId);
    expect(order).toEqual(expected);
  });

  it("同じファイルの2回目は new = 0 で、expected.countNew = 0 でも IMPORT_NOT_READY（何も登録しない）", () => {
    const s = setup();
    const first = commitFreeeImport(s, input());
    expect(first.ok).toBe(true);
    const before = stateOf(s);
    const second = commitFreeeImport(s, input({ expected: { fileSha256: SHA, countNew: 0 } }));
    if (second.ok) throw new Error("成功してはいけない");
    expect(second.error.code).toBe("IMPORT_NOT_READY");
    expect(second.error.details?.unmapped).toEqual([]);
    expect(stateOf(s)).toEqual(before);
  });

  it("作り直した結果が new = 0 なら、expected が古くても IMPORT_NOT_READY が先", () => {
    const s = setup();
    expect(commitFreeeImport(s, input()).ok).toBe(true);
    const second = commitFreeeImport(s, input());
    if (second.ok) throw new Error("成功してはいけない");
    expect(second.error.code).toBe("IMPORT_NOT_READY");
  });

  it("書き込みの途中で例外が起きると、何も残さない", () => {
    const s = setup();
    const before = stateOf(s);
    s.uow.imports.failOnInsertBatch = true;
    expect(() => commitFreeeImport(s, input())).toThrow("insertBatch failed");
    s.uow.imports.failOnInsertBatch = false;
    expect(stateOf(s)).toEqual(before);
  });
});

describe("saveImportMappings", () => {
  it("保存すると、プレビューの対応表が saved になる", () => {
    const s = setup();
    const result = saveImportMappings(s, {
      accounts: [{ sourceName: "交際費", accountId: s.code("5260") }],
      taxes: [{ sourceName: "課対仕入８％（軽）", taxCategory: "PURCHASE_8R" }],
    });
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    expect(result.value.accounts).toEqual([{ sourceName: "交際費", accountId: s.code("5260") }]);
    expect(result.value.taxes).toEqual([
      { sourceName: "課対仕入8%(軽)", taxCategory: "PURCHASE_8R" },
    ]);
    const preview = previewFreeeImport({ uow: s.uow }, input());
    if (!preview.ok) throw new Error("プレビューに失敗");
    expect(preview.value.mappings.accounts).toContainEqual({
      sourceName: "交際費",
      status: "saved",
      accountId: s.code("5260"),
    });
  });

  it("使用停止の科目・他の科目の補助科目・損益・存在しない科目 → VALIDATION（何も保存しない）", () => {
    const s = setup();
    const inactive = s.masters.state.accounts.find((a) => a.code === "5310");
    if (inactive === undefined) throw new Error("科目がない");
    s.masters.updateAccount({ ...inactive, isActive: false });
    s.masters.insertSubAccount({
      id: "sub-bank",
      accountId: s.code("1020"),
      name: "A銀行",
      isActive: true,
    });

    const cases = [
      { accounts: [{ sourceName: "雑費", accountId: inactive.id }] },
      { accounts: [{ sourceName: "カード", accountId: s.code("2020"), subAccountId: "sub-bank" }] },
      { accounts: [{ sourceName: "損益", accountId: s.code("3020") }] },
      { accounts: [{ sourceName: "なし", accountId: "no-such-account" }] },
      { taxes: [{ sourceName: "謎", taxCategory: "NO_SUCH" as never }] },
    ];
    for (const c of cases) {
      const result = saveImportMappings(s, c);
      expect(result.ok ? undefined : result.error.code, JSON.stringify(c)).toBe("VALIDATION");
    }
    expect(s.uow.imports.state.accountMappings).toEqual([]);
    expect(s.uow.imports.state.taxMappings).toEqual([]);
  });
});
