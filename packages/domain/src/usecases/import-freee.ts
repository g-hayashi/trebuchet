import type { ImportPreview, ReconciliationResult } from "@trebuchet/schema";
import { auditEntry } from "../audit.ts";
import { type FreeeOpeningProposal, proposeOpeningBalances } from "../import/freee/opening.ts";
import {
  type ImportPlan,
  type PlanItem,
  type PlanOptions,
  planImport,
} from "../import/freee/plan.ts";
import {
  type FreeeFile,
  type FreeeLedgerAccount,
  groupFreeeJournals,
  normalizeName,
  parseFreeeLedger,
  readFreeeFile,
} from "../import/freee/read.ts";
import { type ReconcileDecision, reconcile } from "../import/freee/reconcile.ts";
import type { AccountMapping, ImportBatch, ImportRef, TaxMapping } from "../import/types.ts";
import type {
  Clock,
  IdGenerator,
  ImportStore,
  ImportUnitOfWork,
  LedgerRepository,
  MasterRepository,
  ReportRepository,
} from "../ports.ts";
import { computeBalances } from "../reports/balances.ts";
import { FREEE_UNMAPPABLE_ACCOUNTS } from "../seed/freee-aliases.ts";
import {
  domainError,
  err,
  type Journal,
  type JournalLine,
  ok,
  type Result,
  validationError,
} from "../types.ts";
import { checkReason } from "./journal-edit.ts";

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
  const activeRefs = tx.imports.activeRefsByFreeeIds(ids);
  const rangeRefs =
    from === undefined || to === undefined ? [] : tx.imports.activeRefsInRange(from, to);
  // 変更・削除の警告に帳簿の仕訳番号を付ける（research R9）
  const journalNos = new Map<string, number>();
  for (const r of [...activeRefs, ...rangeRefs]) {
    if (journalNos.has(r.journalId)) continue;
    const journal = tx.ledger.getJournal(r.journalId);
    if (journal !== undefined) journalNos.set(r.journalId, journal.journalNo);
  }
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
    activeRefs,
    manualSignatures:
      from === undefined || to === undefined ? [] : tx.imports.manualJournalSignatures(from, to),
    options,
    rangeRefs,
    journalNos,
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
  return deps.uow.run((tx) =>
    ok(withFile(buildPlan(tx, file.value, input.options), file.value, input)),
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

  return deps.uow.run((tx): Result<FreeeImportResult> => {
    const plan = buildPlan(tx, file.value, input.options);
    const preview = withFile(plan, file.value, input);
    if (!preview.ready) {
      const unmapped = [...preview.mappings.accounts, ...preview.mappings.taxes]
        .filter((r) => r.status === "unmapped")
        .map((r) => r.sourceName);
      return err(
        domainError(
          "IMPORT_NOT_READY",
          unmapped.length > 0
            ? "対応が決まっていない名前があります"
            : "新しく取り込む仕訳がありません",
          { unmapped },
        ),
      );
    }
    if (preview.counts.new !== input.expected.countNew) {
      return err(
        domainError(
          "IMPORT_PLAN_CHANGED",
          "プレビューの後に帳簿が変わりました。新しいプレビューを確認してください",
          { preview },
        ),
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
      tx.ledger.appendAudit(
        auditEntry(deps, {
          targetType: "journal",
          targetId: journal.id,
          action: "create",
          after: { ...journal, importBatchId: batchId, freeeJournalId: p.freee.freeeJournalId },
          at: now,
        }),
      );
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
      return err(validationError("名前を入力してください", { ...at, field: "sourceName" }));
    if (FREEE_UNMAPPABLE_ACCOUNTS.includes(sourceName)) {
      return err(
        validationError(`「${sourceName}」は対応づけられません`, { ...at, field: "sourceName" }),
      );
    }
    if (seen.has(sourceName)) {
      return err(validationError("同じ名前が重複しています", { ...at, field: "sourceName" }));
    }
    seen.add(sourceName);
    const account = accounts.get(row.accountId);
    if (account === undefined) {
      return err(validationError("勘定科目が見つかりません", { ...at, field: "accountId" }));
    }
    if (!account.isActive) {
      return err(
        validationError(`勘定科目「${account.name}」は使用停止です`, { ...at, field: "accountId" }),
      );
    }
    if (row.subAccountId !== undefined && row.subAccountName !== undefined) {
      return err(
        validationError("補助科目は、既存の補助科目か新しく作る名前のどちらかを指定してください", {
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
          validationError("補助科目がこの勘定科目のものではありません", {
            ...at,
            field: "subAccountId",
          }),
        );
      }
      if (!sub.isActive) {
        return err(
          validationError(`補助科目「${sub.name}」は使用停止です`, {
            ...at,
            field: "subAccountId",
          }),
        );
      }
      mapping.subAccountId = row.subAccountId;
    }
    if (row.subAccountName !== undefined) {
      const name = normalizeName(row.subAccountName);
      if (name === "") {
        return err(
          validationError("補助科目の名前を入力してください", { ...at, field: "subAccountName" }),
        );
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
      return err(validationError("名前を入力してください", { ...at, field: "sourceName" }));
    if (seen.has(sourceName)) {
      return err(validationError("同じ名前が重複しています", { ...at, field: "sourceName" }));
    }
    seen.add(sourceName);
    if (!codes.has(row.taxCategory)) {
      return err(validationError("税区分が見つかりません", { ...at, field: "taxCategory" }));
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
  return deps.uow.run((tx): Result<SavedImportMappings> => {
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

// 期首残高の移行（US2, contracts/domain-module.md のユースケース）

export type FreeeOpeningInput = { bytes: Uint8Array; fiscalYear: number };

function readLedgerFile(bytes: Uint8Array): Result<FreeeLedgerAccount[]> {
  const read = readFreeeFile(bytes);
  if (!read.ok) {
    return err(
      domainError("IMPORT_UNKNOWN_FORMAT", "freee の総勘定元帳として読めないファイルです", {
        expected: "ledger",
        missingColumns: read.error.missingColumns,
      }),
    );
  }
  if (read.value.kind !== "ledger") {
    return err(
      domainError("IMPORT_WRONG_KIND", "仕訳帳です。総勘定元帳のファイルを選んでください", {
        expected: "ledger",
        actual: read.value.kind,
      }),
    );
  }
  const ledger = parseFreeeLedger(read.value);
  if (!ledger.ok) {
    const { row, column, code } = ledger.error;
    return err(
      domainError("VALIDATION", `総勘定元帳の ${row} 行目の「${column}」を読めません`, {
        row,
        column,
        code,
      }),
    );
  }
  return ledger;
}

/**
 * freee の総勘定元帳から、年度の期首残高の案を作る（FR-018〜020a）。帳簿は変えない（読むだけ）。
 * 登録済みの期首残高と、前年度の仕訳があれば前年度の期末からの繰越（carryForward）を比べる。
 * 保存は 001 の期首残高の保存（replaceOpeningBalances）で行う
 */
export function proposeFreeeOpening(
  deps: { uow: ImportUnitOfWork; reports: ReportRepository },
  input: FreeeOpeningInput,
): Result<FreeeOpeningProposal> {
  const ledger = readLedgerFile(input.bytes);
  if (!ledger.ok) return ledger;

  return deps.uow.run((tx) => {
    const periods = tx.masters.listFiscalPeriods();
    const period = periods.find((p) => p.fiscalYear === input.fiscalYear);
    if (period === undefined) {
      return err(
        domainError("OUT_OF_PERIOD", "会計期間が登録されていない年度です", {
          fiscalYear: input.fiscalYear,
        }),
      );
    }
    const prior = periods.find((p) => p.fiscalYear === input.fiscalYear - 1);
    const priorLines =
      prior === undefined ? [] : deps.reports.linesInRange(prior.startDate, prior.endDate);
    const priorBalances =
      prior === undefined || priorLines.length === 0
        ? undefined
        : computeBalances({
            opening: deps.reports.openingBalances(prior.fiscalYear),
            lines: priorLines,
            periodStart: prior.startDate,
            to: prior.endDate,
          });
    return proposeOpeningBalances({
      fiscalYear: input.fiscalYear,
      ledger: ledger.value,
      savedMappings: tx.imports.listAccountMappings(),
      accounts: tx.masters.listAccounts(),
      subAccounts: tx.masters.listSubAccounts(),
      periods,
      registered: tx.masters.listOpeningBalances(period.id),
      priorBalances,
    });
  });
}

// 元帳との照合（US3, contracts/domain-module.md のユースケース）

export type FreeeReconcileInput = {
  /** その年度の総勘定元帳 */
  bytes: Uint8Array;
  fiscalYear: number;
  /** 同じ年度の仕訳帳（任意）。渡すと、取込対象外・取込不可の仕訳を原因の候補で分けられる */
  journal?: { bytes: Uint8Array; options?: PlanOptions | undefined } | undefined;
};

/** 取消済みの取込の回の参照のうち、取引日が from〜to のもの（VOIDED_IMPORT の判定に使う） */
function revokedRefsInRange(tx: ImportTx, from: string, to: string): ImportRef[] {
  return tx.imports
    .listBatches()
    .filter((b) => b.status === "voided")
    .flatMap((b) => tx.imports.journalsOfBatch(b.id).map((x) => x.ref))
    .filter((r) => r.revokedAt !== null && r.freeeDate >= from && r.freeeDate <= to);
}

/**
 * freee の総勘定元帳と帳簿を科目ごとに照合する（FR-021〜023, research R7）。帳簿は変えない（読むだけ）。
 * 帳簿の残高は 001 の computeBalances（その年度の期首残高と仕訳）で求める
 */
export function reconcileFreee(
  deps: { uow: ImportUnitOfWork; reports: ReportRepository },
  input: FreeeReconcileInput,
): Result<ReconciliationResult> {
  const ledger = readLedgerFile(input.bytes);
  if (!ledger.ok) return ledger;
  let journalFile: FreeeFile | undefined;
  if (input.journal !== undefined) {
    const file = readJournalFile(input.journal.bytes);
    if (!file.ok) return file;
    journalFile = file.value;
  }

  return deps.uow.run((tx) => {
    const periods = tx.masters.listFiscalPeriods();
    const period = periods.find((p) => p.fiscalYear === input.fiscalYear);
    if (period === undefined) {
      return err(
        domainError("OUT_OF_PERIOD", "会計期間が登録されていない年度です", {
          fiscalYear: input.fiscalYear,
        }),
      );
    }
    const { startDate, endDate } = period;
    const balances = computeBalances({
      opening: deps.reports.openingBalances(period.fiscalYear),
      lines: deps.reports.linesInRange(startDate, endDate),
      periodStart: startDate,
      to: endDate,
    });
    const decisions: ReconcileDecision[] =
      journalFile === undefined
        ? []
        : buildPlan(tx, journalFile, input.journal?.options ?? {}).preview.items.flatMap((i) =>
            i.freeeJournalNo !== null && (i.decision === "excluded" || i.decision === "rejected")
              ? [{ freeeJournalNo: i.freeeJournalNo, decision: i.decision, reason: i.reason }]
              : [],
          );
    return reconcile({
      fiscalYear: input.fiscalYear,
      ledger: ledger.value,
      savedMappings: tx.imports.listAccountMappings(),
      accounts: tx.masters.listAccounts(),
      subAccounts: tx.masters.listSubAccounts(),
      periods,
      balances,
      refs: [
        ...tx.imports.activeRefsInRange(startDate, endDate),
        ...revokedRefsInRange(tx, startDate, endDate),
      ],
      decisions,
    });
  });
}

// 取込の取消（US4, contracts/domain-module.md のユースケース）

export type VoidImportBatchInput = {
  batchId: string;
  reason: string;
  /** 取込の後に訂正された仕訳があっても取り消す（FR-026） */
  confirmCorrected?: boolean | undefined;
};

export type VoidImportBatchResult = { batch: ImportBatch; voidedCount: number };

/**
 * 1回分の取込を理由つきで取り消す（FR-024〜027, research R12, INV-15）。
 * 締め済みの確認 → 訂正済みの確認 → 有効な仕訳の取消（001 の取消と同じ監査ログ）→ 参照の revoked_at → 取込の回の voided。
 * 利用者が個別に取り消した仕訳はそのまま。作った補助科目・取引先・タグと対応表は残す。
 * エラー: REASON_REQUIRED、IMPORT_BATCH_NOT_FOUND、IMPORT_BATCH_VOIDED、PERIOD_CLOSED、CORRECTED_JOURNALS
 */
export function voidImportBatch(
  deps: { uow: ImportUnitOfWork; ids: IdGenerator; clock: Clock },
  input: VoidImportBatchInput,
): Result<VoidImportBatchResult> {
  const reason = checkReason(input.reason);
  if (!reason.ok) return reason;

  return deps.uow.run((tx): Result<VoidImportBatchResult> => {
    const batch = tx.imports.getBatch(input.batchId);
    if (batch === undefined) {
      return err(
        domainError("IMPORT_BATCH_NOT_FOUND", "取込の回が見つかりません", {
          batchId: input.batchId,
        }),
      );
    }
    if (batch.status === "voided") {
      return err(
        domainError("IMPORT_BATCH_VOIDED", "この取込はすでに取り消されています", {
          batchId: batch.id,
          voidedAt: batch.voidedAt,
        }),
      );
    }

    const journals = tx.imports
      .journalsOfBatch(batch.id)
      .map((x) => x.journal)
      .filter((j) => j.status === "active");

    const periods = tx.masters.listFiscalPeriods();
    const closedYears = new Set<number>();
    for (const j of journals) {
      const period = periods.find((p) => p.startDate <= j.date && j.date <= p.endDate);
      if (period?.status === "closed") closedYears.add(period.fiscalYear);
    }
    if (closedYears.size > 0) {
      const fiscalYears = [...closedYears].sort((a, b) => a - b);
      return err(
        domainError(
          "PERIOD_CLOSED",
          `${fiscalYears.join("・")}年度は締め済みです。取込を取り消すには、先に締めを解除してください`,
          { fiscalYears },
        ),
      );
    }

    const corrected = journals.filter((j) => j.version > 1);
    if (corrected.length > 0 && input.confirmCorrected !== true) {
      return err(
        domainError(
          "CORRECTED_JOURNALS",
          `取り込んだ後に訂正された仕訳が ${corrected.length} 件あります。訂正も含めて取り消しますか`,
          { count: corrected.length, journalIds: corrected.map((j) => j.id) },
        ),
      );
    }

    const now = deps.clock.now();
    for (const before of journals) {
      const after = tx.ledger.voidJournal(before.id, before.version, now);
      tx.ledger.appendAudit(
        auditEntry(deps, {
          targetType: "journal",
          targetId: before.id,
          action: "void",
          reason: reason.value,
          before,
          after,
          at: now,
        }),
      );
    }
    tx.imports.voidBatch(batch.id, reason.value, now);
    const voided = tx.imports.getBatch(batch.id);
    if (voided === undefined) throw new Error(`import batch not found: ${batch.id}`);
    return ok({ batch: voided, voidedCount: journals.length });
  });
}
