import type { ImportPreview } from "@trebuchet/schema";
import {
  type ImportPlan,
  type PlanItem,
  type PlanOptions,
  planImport,
} from "../import/freee/plan.ts";
import {
  type FreeeFile,
  groupFreeeJournals,
  normalizeName,
  readFreeeFile,
} from "../import/freee/read.ts";
import type { AccountMapping, ImportBatch, ImportRef, TaxMapping } from "../import/types.ts";
import type {
  Clock,
  IdGenerator,
  ImportStore,
  ImportUnitOfWork,
  LedgerRepository,
  MasterRepository,
} from "../ports.ts";
import { FREEE_UNMAPPABLE_ACCOUNTS } from "../seed/freee-aliases.ts";
import {
  type DomainError,
  domainError,
  err,
  type Journal,
  type JournalLine,
  ok,
  type Result,
} from "../types.ts";

// 仕訳帳の取込（US1, contracts/domain-module.md のユースケース）

type ImportTx = { ledger: LedgerRepository; masters: MasterRepository; imports: ImportStore };

/** プレビュー（items は OUT_OF_PERIOD の案内の message を持つことがある） */
export type FreeeImportPreview = Omit<ImportPreview, "items"> & { items: PlanItem[] };

export type FreeeImportInput = {
  bytes: Uint8Array;
  fileName: string;
  /** ファイルの SHA-256（小文字16進64文字）。ハッシュは呼び出し側（サーバー）が計算する */
  sha256: string;
  options: PlanOptions;
};

export type FreeeCommitInput = FreeeImportInput & {
  /** 画面が見たプレビューのハッシュと件数（FR-012） */
  expected: { fileSha256: string; countNew: number };
};

export type FreeeImportResult = { batch: ImportBatch; preview: FreeeImportPreview };

function readJournalFile(bytes: Uint8Array): Result<FreeeFile> {
  const read = readFreeeFile(bytes);
  if (!read.ok) {
    return err(
      domainError("IMPORT_UNKNOWN_FORMAT", "freee の仕訳帳として読めないファイルです", {
        expected: "journal",
        missingColumns: read.error.missingColumns,
      }),
    );
  }
  if (read.value.kind !== "journal") {
    return err(
      domainError("IMPORT_WRONG_KIND", "総勘定元帳です。仕訳帳のファイルを選んでください", {
        expected: "journal",
        actual: read.value.kind,
      }),
    );
  }
  return ok(read.value);
}

function buildPlan(tx: ImportTx, file: FreeeFile, options: PlanOptions): ImportPlan {
  const grouped = groupFreeeJournals(file);
  const ids = [...grouped.journals, ...grouped.rejected].map((j) => j.freeeJournalId);
  const dates = grouped.journals.map((j) => j.date).sort();
  const from = dates[0];
  const to = dates[dates.length - 1];
  return planImport({
    journals: grouped.journals,
    rejected: grouped.rejected,
    savedMappings: {
      accounts: tx.imports.listAccountMappings(),
      taxes: tx.imports.listTaxMappings(),
    },
    accounts: tx.masters.listAccounts(),
    subAccounts: tx.masters.listSubAccounts(),
    partners: tx.masters.listPartners(),
    tags: tx.masters.listTags(),
    periods: tx.masters.listFiscalPeriods(),
    taxSettings: tx.masters.listTaxSettings(),
    taxRates: tx.masters.listTaxRates(),
    taxCategories: tx.masters.listTaxCategories(),
    activeRefs: tx.imports.activeRefsByFreeeIds(ids),
    manualSignatures:
      from === undefined || to === undefined ? [] : tx.imports.manualJournalSignatures(from, to),
    options,
  });
}

function withFile(plan: ImportPlan, file: FreeeFile, input: FreeeImportInput): FreeeImportPreview {
  return {
    file: {
      name: input.fileName,
      sha256: input.sha256,
      kind: "journal",
      encoding: file.encoding,
      rowCount: file.rows.length,
    },
    ...plan.preview,
  };
}

/** 取込のプレビュー。帳簿は変えない（読み取りだけ） */
export function previewFreeeImport(
  deps: { uow: ImportUnitOfWork },
  input: FreeeImportInput,
): Result<FreeeImportPreview> {
  const file = readJournalFile(input.bytes);
  if (!file.ok) return file;
  return ok(
    deps.uow.transaction((tx) =>
      withFile(buildPlan(tx, file.value, input.options), file.value, input),
    ),
  );
}

/** 採番の順（research R15）: 日付 → freee の仕訳番号（数字なら数値の順）→ 仕訳ID */
function compareFreeeNo(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  const numeric = /^\d+$/;
  if (numeric.test(a) && numeric.test(b)) {
    return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
  }
  return a < b ? -1 : 1;
}

/**
 * 取込の確定（FR-012〜015, FR-018, INV-11）。1つのトランザクションの中でプレビューを作り直し、
 * expected と比べてから、補助科目・取引先・タグの作成 → 仕訳の登録（採番）→ 監査ログ → 取込の回 → 参照の順に書く。
 * 参照は取込の回を外部キーで指すため、取込の回を参照より先に書く
 */
export function commitFreeeImport(
  deps: { uow: ImportUnitOfWork; ids: IdGenerator; clock: Clock },
  input: FreeeCommitInput,
): Result<FreeeImportResult> {
  if (input.sha256 !== input.expected.fileSha256) {
    return err(
      domainError(
        "IMPORT_FILE_CHANGED",
        "プレビューのときとファイルが違います。もう一度ファイルを選んでください",
        { expected: input.expected.fileSha256, actual: input.sha256 },
      ),
    );
  }
  const file = readJournalFile(input.bytes);
  if (!file.ok) return file;

  return deps.uow.transaction((tx): Result<FreeeImportResult> => {
    const plan = buildPlan(tx, file.value, input.options);
    const preview = withFile(plan, file.value, input);
    if (preview.counts.new !== input.expected.countNew) {
      return err(
        domainError(
          "IMPORT_PLAN_CHANGED",
          "プレビューの後に帳簿が変わりました。新しいプレビューを確認してください",
          { preview },
        ),
      );
    }
    if (!preview.ready) {
      const unmapped = [...preview.mappings.accounts, ...preview.mappings.taxes]
        .filter((r) => r.status === "unmapped")
        .map((r) => r.sourceName);
      return err(
        domainError("IMPORT_NOT_READY", "対応が決まっていない名前があります", { unmapped }),
      );
    }

    const now = deps.clock.now();
    const realIds = new Map<string, string>();
    for (const s of plan.creations.subAccounts) {
      const id = deps.ids.next();
      tx.masters.insertSubAccount({ id, accountId: s.accountId, name: s.name, isActive: true });
      realIds.set(s.id, id);
    }
    for (const p of plan.creations.partners) {
      const id = deps.ids.next();
      tx.masters.insertPartner({ id, name: p.name, honorific: null, memo: null, isActive: true });
      realIds.set(p.id, id);
    }
    for (const t of plan.creations.tags) {
      const id = deps.ids.next();
      tx.masters.insertTag({ id, name: t.name });
      realIds.set(t.id, id);
    }
    const real = (id: string) => realIds.get(id) ?? id;

    const batchId = deps.ids.next();
    const ordered = [...plan.planned].sort(
      (a, b) =>
        a.freee.date.localeCompare(b.freee.date) ||
        compareFreeeNo(a.freee.freeeJournalNo, b.freee.freeeJournalNo) ||
        (a.freee.freeeJournalId < b.freee.freeeJournalId ? -1 : 1),
    );
    const refs: ImportRef[] = [];
    const journals: Journal[] = [];
    for (const p of ordered) {
      const lines: JournalLine[] = p.valid.lines.map((l) => ({
        ...l,
        id: deps.ids.next(),
        subAccountId: l.subAccountId === null ? null : real(l.subAccountId),
        partnerId: l.partnerId === null ? null : real(l.partnerId),
        tagIds: l.tagIds.map(real),
      }));
      const journal = tx.ledger.insertJournal({
        ...p.valid,
        id: deps.ids.next(),
        journalNo: tx.ledger.nextJournalNo(),
        createdAt: now,
        source: "import_freee",
        lines,
      });
      tx.ledger.appendAudit({
        id: deps.ids.next(),
        occurredAt: now,
        targetType: "journal",
        targetId: journal.id,
        action: "create",
        reason: null,
        beforeJson: null,
        afterJson: JSON.stringify({
          ...journal,
          importBatchId: batchId,
          freeeJournalId: p.freee.freeeJournalId,
        }),
      });
      journals.push(journal);
      refs.push({
        journalId: journal.id,
        batchId,
        freeeJournalId: p.freee.freeeJournalId,
        freeeJournalNo: p.freee.freeeJournalNo,
        freeeDate: p.freee.date,
        snapshotJson: p.snapshot,
        revokedAt: null,
      });
    }

    const periods = new Map(tx.masters.listFiscalPeriods().map((p) => [p.id, p.fiscalYear]));
    const dates = journals.map((j) => j.date).sort();
    const fiscalYears = [
      ...new Set(journals.flatMap((j) => periods.get(j.fiscalPeriodId) ?? [])),
    ].sort((a, b) => a - b);
    const batch: ImportBatch = {
      id: batchId,
      source: "freee_journal",
      fileName: input.fileName,
      fileSha256: input.sha256,
      importedAt: now,
      periodFrom: dates[0] ?? "",
      periodTo: dates[dates.length - 1] ?? "",
      fiscalYears,
      countNew: preview.counts.new,
      countAlready: preview.counts.already,
      countExcluded: preview.counts.excluded,
      countRejected: preview.counts.rejected,
      countWarnings: preview.counts.warnings,
      status: "active",
      voidedAt: null,
      voidReason: null,
    };
    tx.imports.insertBatch(batch);
    tx.imports.insertRefs(refs);
    return ok({ batch, preview });
  });
}

export type ImportMappingsInput = {
  accounts?: readonly AccountMapping[] | undefined;
  taxes?: readonly TaxMapping[] | undefined;
};

export type SavedImportMappings = { accounts: AccountMapping[]; taxes: TaxMapping[] };

const invalid = (message: string, details: Record<string, unknown>): DomainError =>
  domainError("VALIDATION", message, details);

function validateAccountRows(
  rows: readonly AccountMapping[],
  masters: MasterRepository,
): Result<AccountMapping[]> {
  const accounts = new Map(masters.listAccounts().map((a) => [a.id, a]));
  const subAccounts = new Map(masters.listSubAccounts().map((s) => [s.id, s]));
  const seen = new Set<string>();
  const out: AccountMapping[] = [];
  for (const [index, row] of rows.entries()) {
    const sourceName = normalizeName(row.sourceName);
    const at = { index, sourceName };
    if (sourceName === "")
      return err(invalid("名前を入力してください", { ...at, field: "sourceName" }));
    if (FREEE_UNMAPPABLE_ACCOUNTS.includes(sourceName)) {
      return err(invalid(`「${sourceName}」は対応づけられません`, { ...at, field: "sourceName" }));
    }
    if (seen.has(sourceName)) {
      return err(invalid("同じ名前が重複しています", { ...at, field: "sourceName" }));
    }
    seen.add(sourceName);
    const account = accounts.get(row.accountId);
    if (account === undefined) {
      return err(invalid("勘定科目が見つかりません", { ...at, field: "accountId" }));
    }
    if (!account.isActive) {
      return err(
        invalid(`勘定科目「${account.name}」は使用停止です`, { ...at, field: "accountId" }),
      );
    }
    if (row.subAccountId !== undefined && row.subAccountName !== undefined) {
      return err(
        invalid("補助科目は、既存の補助科目か新しく作る名前のどちらかを指定してください", {
          ...at,
          field: "subAccountName",
        }),
      );
    }
    const mapping: AccountMapping = { sourceName, accountId: row.accountId };
    if (row.subAccountId !== undefined) {
      const sub = subAccounts.get(row.subAccountId);
      if (sub === undefined || sub.accountId !== row.accountId) {
        return err(
          invalid("補助科目がこの勘定科目のものではありません", { ...at, field: "subAccountId" }),
        );
      }
      if (!sub.isActive) {
        return err(
          invalid(`補助科目「${sub.name}」は使用停止です`, { ...at, field: "subAccountId" }),
        );
      }
      mapping.subAccountId = row.subAccountId;
    }
    if (row.subAccountName !== undefined) {
      const name = normalizeName(row.subAccountName);
      if (name === "") {
        return err(invalid("補助科目の名前を入力してください", { ...at, field: "subAccountName" }));
      }
      mapping.subAccountName = name;
    }
    out.push(mapping);
  }
  return ok(out);
}

function validateTaxRows(
  rows: readonly TaxMapping[],
  masters: MasterRepository,
): Result<TaxMapping[]> {
  const codes = new Set(masters.listTaxCategories().map((c) => c.code));
  const seen = new Set<string>();
  const out: TaxMapping[] = [];
  for (const [index, row] of rows.entries()) {
    const sourceName = normalizeName(row.sourceName);
    const at = { index, sourceName };
    if (sourceName === "")
      return err(invalid("名前を入力してください", { ...at, field: "sourceName" }));
    if (seen.has(sourceName)) {
      return err(invalid("同じ名前が重複しています", { ...at, field: "sourceName" }));
    }
    seen.add(sourceName);
    if (!codes.has(row.taxCategory)) {
      return err(invalid("税区分が見つかりません", { ...at, field: "taxCategory" }));
    }
    out.push({ sourceName, taxCategory: row.taxCategory });
  }
  return ok(out);
}

/** 対応表の保存（FR-011）。指定した行だけを追加・更新し、保存済みの対応表を返す */
export function saveImportMappings(
  deps: { uow: ImportUnitOfWork; clock: Clock },
  input: ImportMappingsInput,
): Result<SavedImportMappings> {
  return deps.uow.transaction((tx): Result<SavedImportMappings> => {
    const accounts = validateAccountRows(input.accounts ?? [], tx.masters);
    if (!accounts.ok) return accounts;
    const taxes = validateTaxRows(input.taxes ?? [], tx.masters);
    if (!taxes.ok) return taxes;
    const now = deps.clock.now();
    if (accounts.value.length > 0) tx.imports.upsertAccountMappings(accounts.value, now);
    if (taxes.value.length > 0) tx.imports.upsertTaxMappings(taxes.value, now);
    return ok({ accounts: tx.imports.listAccountMappings(), taxes: tx.imports.listTaxMappings() });
  });
}
