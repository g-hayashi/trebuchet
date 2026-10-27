import type {
  StatementAccount,
  StatementAccountInput,
  StatementAccountSaved,
  StatementBatch,
  StatementChange,
  StatementColumnMapping,
  StatementImportCommitted,
  StatementImportPreview,
  StatementLinkKind,
  StatementListQuery,
  StatementOrigin,
  StatementSettings,
  StatementSettingsInput,
  StatementSource,
  StatementTableLayout,
  StatementView,
} from "@trebuchet/schema";
import { auditEntry } from "../audit.ts";
import type { Clock, IdGenerator, StatementStore, StatementUnitOfWork } from "../ports.ts";
import { inferStatementAccount } from "../statements/account-inference.ts";
import { normalizeContent } from "../statements/normalize.ts";
import {
  contentGroup,
  type ExistingStatement,
  planStatementImport,
  possibleDuplicatesOf,
  type StatementImportPlan,
} from "../statements/plan.ts";
import {
  applySourceToLayout,
  diffHeader,
  headerSignature,
  inheritColumns,
  matchStatementSources,
  sourceFitsLayout,
} from "../statements/sources.ts";
import {
  detectTableLayout,
  readStatementTable,
  type StatementLayoutOverride,
  type StatementRow,
  type UnreadableRow,
} from "../statements/table.ts";
import {
  domainError,
  err,
  ok,
  type Result,
  type StatementRecord,
  validationError,
} from "../types.ts";
import {
  buildCandidatesInTx,
  loadStatementStates,
  toCandidateView,
} from "./statement-candidates.ts";
import { checkStatementSourceName, sourceNameTaken, sourceNotFound } from "./statement-sources.ts";

// 明細の取込（006 US1。R4・R14・R18、FR-002〜007）と候補・設定（US2。R8、§1.4・§1.8）

type StatementDeps = { uow: StatementUnitOfWork; ids: IdGenerator; clock: Clock };

// ---- 取込元の口座（§1.1、FR-003） ----

/** 取込元の口座の一覧（名前順） */
export function listStatementAccounts(
  deps: Pick<StatementDeps, "uow">,
): Result<StatementAccount[]> {
  return deps.uow.run((tx) => ok(tx.statements.listStatementAccounts()));
}

const sameMapping = (a: StatementAccount, b: StatementAccount): boolean =>
  a.usage === b.usage &&
  a.kind === b.kind &&
  a.accountId === b.accountId &&
  a.subAccountId === b.subAccountId;

/**
 * 取込元の口座（明細の口座）の用途・種類・科目を名前で保存する（なければ追加、あれば更新）。
 * `private` は科目を持たず、ほかは科目が必須。変更は監査に残す（R18）。変更がなければ何も書かない。
 * 対応が変わったときは、その口座の未処理の明細の候補（と、振替の対の相手の候補）を作り直す（R8）。
 * 作り直した候補の数が `rebuilt`（まだ候補のない明細は作らない）
 */
export function saveStatementAccount(
  deps: StatementDeps,
  name: string,
  input: StatementAccountInput,
): Result<StatementAccountSaved> {
  const checked = checkStatementAccountInput(name, input);
  if (!checked.ok) return checked;
  return deps.uow.run((tx) => saveStatementAccountInTx(deps, tx, checked.value, input, true));
}

/** 口座の対応の入力の形の検査（名前は整えて返す。何も読まない・書かない） */
function checkStatementAccountInput(name: string, input: StatementAccountInput): Result<string> {
  const trimmed = name.trim();
  if (trimmed === "")
    return err(validationError("口座の名前を入力してください", { field: "name" }));
  const isPrivate = input.usage === "private";
  if (isPrivate && (input.accountId != null || input.subAccountId != null)) {
    return err(validationError("private の口座は科目を持ちません", { field: "accountId" }));
  }
  if (!isPrivate && input.accountId == null) {
    return err(validationError("科目を選んでください", { field: "accountId" }));
  }
  return ok(trimmed);
}

/**
 * 口座の対応を UnitOfWork の中（`tx`）で保存する（`saveStatementAccount` と取込の確定が共有する。
 * 入れ子の UnitOfWork にしない）。`name` は `checkStatementAccountInput` が返した整えた名前。
 * 科目が存在・有効か、補助科目がその科目のものかを検査する（`err` は呼び出し側の `run` が巻き戻す）。
 * `rebuild` が false なら候補を作り直さない（取込の確定は、その口座の明細がまだない）
 */
function saveStatementAccountInTx(
  deps: StatementDeps,
  tx: StatementTx,
  trimmed: string,
  input: StatementAccountInput,
  rebuild: boolean,
): Result<StatementAccountSaved> {
  if (input.accountId != null) {
    const account = tx.masters.getAccount(input.accountId);
    if (account === undefined) {
      return err(
        domainError("ACCOUNT_NOT_FOUND", "勘定科目が見つかりません", {
          accountId: input.accountId,
        }),
      );
    }
    if (!account.isActive) {
      return err(
        domainError("ACCOUNT_INACTIVE", "使用停止の科目は選べません", {
          accountId: input.accountId,
        }),
      );
    }
    if (
      input.subAccountId != null &&
      !tx.masters.listSubAccounts(input.accountId).some((s) => s.id === input.subAccountId)
    ) {
      return err(
        validationError("補助科目がその科目のものではありません", {
          field: "subAccountId",
          subAccountId: input.subAccountId,
        }),
      );
    }
  }

  const now = deps.clock.now();
  const previous = tx.statements.listStatementAccounts().find((a) => a.name === trimmed);
  const account: StatementAccount = {
    id: previous?.id ?? deps.ids.next(),
    name: trimmed,
    usage: input.usage,
    kind: input.kind,
    accountId: input.accountId ?? null,
    subAccountId: input.subAccountId ?? null,
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
  };
  if (previous !== undefined && sameMapping(previous, account)) {
    return ok({ account: previous, rebuilt: 0 });
  }
  tx.statements.upsertStatementAccount(account);
  tx.statements.appendStatementAudit(
    auditEntry(deps, {
      targetType: "statement_account",
      targetId: account.id,
      action: previous === undefined ? "create" : "update",
      before: previous,
      after: account,
      at: now,
    }),
  );
  if (!rebuild) return ok({ account, rebuilt: 0 });

  // 候補のある未処理の明細のうち、この口座のもの（と、振替の対として作った候補）を作り直す
  const states = loadStatementStates(tx);
  const candidates = new Map(
    tx.statements.listStatementCandidates().map((c) => [c.statementId, c]),
  );
  const targetIds = new Set(
    states
      .filter(
        ({ record, status }) =>
          status === "unprocessed" &&
          candidates.has(record.id) &&
          (record.statementAccountId === account.id ||
            candidates.get(record.id)?.method === "transfer"),
      )
      .map(({ record }) => record.id),
  );
  const rebuilt = buildCandidatesInTx(deps, tx, states, targetIds, true);
  if (!rebuilt.ok) return rebuilt;
  return ok({ account, rebuilt: rebuilt.value.built });
}

// ---- 取込（§1.2・§1.3、R14） ----

/**
 * 取込の入力（読み取り済みの行）。`sha256` は入力全体のハッシュで、呼び出し側（server）が計算する
 * （domain に暗号の関数を持ち込まない。002 と同じ）
 */
export type StatementRowsInput = {
  origin: StatementOrigin;
  rows: StatementRow[];
  unreadable: UnreadableRow[];
  sha256: string;
};

/**
 * 表のテキストからの取込の入力（007 H:§2.2）。`mapping` は列の対応、`year` は年のない日付にだけ使う。
 * `fixedAccountName` は `mapping` が `accountName` の役割を持たないとき必須（INV-50）。
 * `origin` は取込の回の出所（貼り付け・ファイル）をそのまま書く
 */
export type StatementImportInput = {
  text: string;
  origin: StatementOrigin;
  year: number;
  mapping: StatementColumnMapping;
  fixedAccountName?: string | undefined;
  sha256: string;
};

export type StatementImportCommitInput = StatementImportInput & {
  /** 画面が見たプレビューのハッシュと新規の件数（FR-002） */
  expected: { inputSha256: string; countNew: number };
  /** 取込元を保存・更新する（`id` があれば更新）。null・省略は保存しない（R7）。取込と同じ UnitOfWork で書く */
  saveSource?: { id?: string | undefined; name: string } | null | undefined;
  /**
   * 未対応の口座の対応（R9）。未対応の口座ぶんだけを受ける（対応のある口座・行にない名前・同じ名前が 2 回は
   * `VALIDATION`）。取込と同じ UnitOfWork で、明細より先に保存する。省略は空
   */
  accounts?: readonly StatementAccountToSave[] | undefined;
};

/** 取込の確定で保存する口座の対応（`PUT /statement-accounts/:name` と同じ検査をする） */
export type StatementAccountToSave = { name: string; input: StatementAccountInput };

/** 取込と同じ UnitOfWork で保存する取込元（`commitStatementImport` が入力から作る） */
export type StatementSourceToSave = {
  id?: string | undefined;
  name: string;
  /** 1 つの口座の取込元の口座名。まとめの取込元（対応が `accountName` を持つ）は null（INV-50） */
  fixedAccountName: string | null;
  mapping: StatementColumnMapping;
  /** 見出しの署名（`headerSignature`）。見出しなしは null */
  header: string[] | null;
};

export type StatementTx = Parameters<Parameters<StatementUnitOfWork["run"]>[0]>[0];

/** 計画を立てる（保存済みの明細と口座を読む）。`accounts` は口座の ID の引き当てにも使う */
function buildPlan(statements: StatementStore, rows: StatementRow[]) {
  const accounts = statements.listStatementAccounts();
  const nameOf = new Map(accounts.map((a) => [a.id, a.name]));
  const existing: ExistingStatement[] = statements.listStatements().map((s) => ({
    id: s.id,
    stableKey: s.stableKey,
    externalId: s.externalId,
    accountName: nameOf.get(s.statementAccountId) ?? "",
    date: s.date,
    amount: s.amount,
    content: s.content,
    categoryMajor: s.categoryMajor,
    categoryMinor: s.categoryMinor,
    memo: s.memo,
  }));
  return { plan: planStatementImport(rows, existing, accounts), accounts };
}

/**
 * 未対応の口座ごとの案（007 R9）。口座の名前と、その口座の行の大項目の一覧から決める。何も保存しない
 * （案は利用者が取込を確定するまで保存しない。FR-014）
 */
function suggestAccounts(
  tx: StatementTx,
  plan: StatementImportPlan,
  rows: readonly StatementRow[],
): StatementImportPreview["unmappedAccounts"] {
  if (plan.unmappedAccounts.length === 0) return [];
  const majorsOf = new Map<string, Set<string>>();
  for (const r of rows) {
    if (r.categoryMajor === undefined) continue;
    const set = majorsOf.get(r.accountName) ?? new Set<string>();
    set.add(r.categoryMajor);
    majorsOf.set(r.accountName, set);
  }
  const accounts = tx.masters.listAccounts();
  const subAccounts = tx.masters.listSubAccounts();
  return plan.unmappedAccounts.map((name) => ({
    name,
    suggestion: inferStatementAccount(name, [...(majorsOf.get(name) ?? [])], accounts, subAccounts),
  }));
}

function toPreview(
  plan: StatementImportPlan,
  input: StatementRowsInput,
  unmappedAccounts: StatementImportPreview["unmappedAccounts"],
): StatementImportPreview {
  return {
    inputSha256: input.sha256,
    period: plan.period ?? { from: "", to: "" },
    totals: plan.totals,
    rows: plan.rows.map((r) => ({
      key: r.key,
      date: r.row.date,
      amount: r.row.amount,
      content: r.row.content,
      accountName: r.row.accountName,
      status: r.status,
      ...(r.changed === undefined ? {} : { changed: r.changed }),
      warnings: r.warnings,
    })),
    unreadable: input.unreadable,
    unmappedAccounts,
    countNew: plan.countNew,
  };
}

/** 取込のプレビュー（読み取り済みの行から）。何も書かない。未対応の口座には推定の案を添える（R9） */
export function previewStatementRows(
  deps: Pick<StatementDeps, "uow">,
  input: StatementRowsInput,
): Result<StatementImportPreview> {
  return deps.uow.run((tx) => {
    const { plan } = buildPlan(tx.statements, input.rows);
    return ok(toPreview(plan, input, suggestAccounts(tx, plan, input.rows)));
  });
}

/**
 * 表のテキストと列の対応を読む（`readStatementTable`）。列の対応が表に合わなければ `STATEMENT_MAPPING_INVALID`
 * （列の番号が列数を超える、口座名の出どころがない）、1 行も読めなければ `STATEMENT_TABLE_UNREADABLE`
 */
function readInput(input: StatementImportInput): Result<StatementRowsInput> {
  const table = readStatementTable(input.text, input.mapping, {
    year: input.year,
    fixedAccountName: input.fixedAccountName,
  });
  if (!table.ok) return table;
  return ok({ origin: input.origin, sha256: input.sha256, ...table.value });
}

/**
 * 表の区切り文字・見出しの行・見本・列の案を判定する（007 H:§2.1）。何も書かない。
 * 失敗は `STATEMENT_TABLE_UNREADABLE`・`STATEMENT_TABLE_TOO_LARGE`。文字コードは呼び出し側（server）が先に決める。
 *
 * 取込元の照合（R8）。`match` は、見出しの署名が今回の見出し（今回の判定の行）と一致する取込元（`none`・`one`・`many`）。
 * `one`・`many` の取込元の対応は、見出しの行を今回の判定の行にした形（そのまま preview に送れる）。
 * `sourceId` を指定したときは、その取込元（なければ `STATEMENT_SOURCE_NOT_FOUND`）だけを見る:
 * 当てはまれば `one`、見出しが違えば `none` にして `headerDiff`（足された列・なくなった列）と、
 * 見出しの名前が同じ列の役割を引き継いだ `suggestedColumns` を返す。見出しのない取込元は、今回の表にも見出しがなく、
 * 対応の列が収まるときだけ当てはめる。読むだけで書かない
 */
export function detectStatementLayout(
  deps: Pick<StatementDeps, "uow">,
  text: string,
  override?: StatementLayoutRequest,
): Result<StatementLayoutDetected> {
  const detected = detectTableLayout(text, override);
  if (!detected.ok) return detected;
  const layout = detected.value;
  const sources = deps.uow.run((tx) => ok(tx.statements.listStatementSources()));
  if (!sources.ok) return sources;

  if (override?.sourceId === undefined) {
    return ok({ ...layout, match: matchStatementSources(layout, sources.value) });
  }
  const source = sources.value.find((s) => s.id === override.sourceId);
  if (source === undefined) return sourceNotFound(override.sourceId);
  if (sourceFitsLayout(source, layout)) {
    return ok({ ...layout, match: { kind: "one", source: applySourceToLayout(source, layout) } });
  }
  // 見出しのない取込元は、見出しとの比べようがない（違いも役割の引き継ぎも出さない）
  if (source.header === null) return ok({ ...layout, match: { kind: "none" } });
  const { added, removed } = diffHeader(source.header, layout.header);
  return ok({
    ...layout,
    suggestedColumns: inheritColumns(source, layout.header, layout.suggestedColumns),
    match: { kind: "none" },
    headerDiff: { added, removed },
  });
}

/** 利用者の選び直し（区切り文字・見出しの行）と、手で選んだ取込元 */
export type StatementLayoutRequest = StatementLayoutOverride & {
  sourceId?: string | undefined;
};

/** `detectStatementLayout` の戻り。`StatementTableLayout` のうち、文字コード（server が先に決める）を除いた部分 */
export type StatementLayoutDetected = Omit<StatementTableLayout, "encoding">;

/** 取込のプレビュー（表のテキストから）。何も書かない。読めなければ `readInput` のエラー */
export function previewStatementImport(
  deps: Pick<StatementDeps, "uow">,
  input: StatementImportInput,
): Result<StatementImportPreview> {
  const rows = readInput(input);
  if (!rows.ok) return rows;
  return previewStatementRows(deps, rows.value);
}

const planChanged = (details: Record<string, unknown>) =>
  err(
    domainError(
      "STATEMENT_PLAN_CHANGED",
      "プレビューのときと内容が違います。もう一度プレビューを確認してください",
      details,
    ),
  );

/**
 * 取込の確定（FR-007、R14）。1 つの UnitOfWork の中で計画を作り直し、入力のハッシュと新規の件数が
 * プレビューと違えば `STATEMENT_PLAN_CHANGED`、未対応の口座があれば `STATEMENT_ACCOUNT_UNMAPPED`。
 * 取込の回・明細・`changed` の更新・監査は全部か無か（INV-47）。`changed` の行は新しい内容を `changed_json` に書き、
 * `changed_ack_at` を NULL に戻す（FR-005）。新規 0 件でも回は記録する
 */
export function commitStatementRows(
  deps: StatementDeps,
  input: StatementRowsInput & {
    expected: { inputSha256: string; countNew: number };
    /** 同じ UnitOfWork で保存・更新する取込元（R7）。省略は保存しない */
    source?: StatementSourceToSave | undefined;
    /** 同じ UnitOfWork で保存する未対応の口座の対応（R9）。省略は空 */
    accounts?: readonly StatementAccountToSave[] | undefined;
  },
): Result<StatementImportCommitted> {
  if (input.sha256 !== input.expected.inputSha256) {
    return planChanged({ expected: input.expected.inputSha256, actual: input.sha256 });
  }
  return deps.uow.run((tx) => commitInTx(deps, tx, input));
}

/**
 * 取込元の保存の前の検査と、書く内容の組み立て（何も書かない）。名前は整えて 1〜100 字、`id` の取込元がなければ
 * `STATEMENT_SOURCE_NOT_FOUND`、別の取込元と同じ名前なら `STATEMENT_SOURCE_NAME_TAKEN`。
 * `lastUsedAt`・`updatedAt` は今、`id`・`createdAt` は既存の取込元のものを引き継ぐ
 */
function planSourceSave(
  deps: StatementDeps,
  tx: StatementTx,
  toSave: StatementSourceToSave,
  now: string,
): Result<{ previous: StatementSource | undefined; next: StatementSource }> {
  const name = checkStatementSourceName(toSave.name);
  if (!name.ok) return name;
  const sources = tx.statements.listStatementSources();
  const previous = toSave.id === undefined ? undefined : sources.find((s) => s.id === toSave.id);
  if (toSave.id !== undefined && previous === undefined) return sourceNotFound(toSave.id);
  if (sources.some((s) => s.id !== previous?.id && s.name === name.value)) {
    return sourceNameTaken(name.value);
  }
  return ok({
    previous,
    next: {
      id: previous?.id ?? deps.ids.next(),
      name: name.value,
      fixedAccountName: toSave.fixedAccountName,
      mapping: toSave.mapping,
      header: toSave.header,
      lastUsedAt: now,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    },
  });
}

/**
 * 取込の確定の `accounts` の検査（何も書かない）。各入力の形（`saveStatementAccount` と同じ）、同じ名前が 2 回、
 * 未対応でない名前（対応のある口座・行にない名前）はすべて `VALIDATION`。予期しない上書きを黙って無視せず断る。
 * 名前は整えて返す
 */
function checkAccountsToSave(
  unmapped: readonly string[],
  accounts: readonly StatementAccountToSave[],
): Result<StatementAccountToSave[]> {
  const checked: StatementAccountToSave[] = [];
  for (const a of accounts) {
    const name = checkStatementAccountInput(a.name, a.input);
    if (!name.ok) return name;
    checked.push({ name: name.value, input: a.input });
  }
  const seen = new Set<string>();
  const duplicated = checked.map((a) => a.name).filter((n) => (seen.has(n) ? true : !seen.add(n)));
  if (duplicated.length > 0) {
    return err(
      validationError("同じ口座の対応が重複しています", {
        field: "accounts",
        names: [...new Set(duplicated)],
      }),
    );
  }
  const extra = checked.map((a) => a.name).filter((n) => !unmapped.includes(n));
  if (extra.length > 0) {
    return err(
      validationError("対応づいていない口座だけを指定してください", {
        field: "accounts",
        names: extra,
      }),
    );
  }
  return ok(checked);
}

function commitInTx(
  deps: StatementDeps,
  tx: StatementTx,
  input: StatementRowsInput & {
    expected: { countNew: number };
    source?: StatementSourceToSave | undefined;
    accounts?: readonly StatementAccountToSave[] | undefined;
  },
): Result<StatementImportCommitted> {
  const { plan } = buildPlan(tx.statements, input.rows);
  const toSave = checkAccountsToSave(plan.unmappedAccounts, input.accounts ?? []);
  if (!toSave.ok) return toSave;
  const stillUnmapped = plan.unmappedAccounts.filter(
    (name) => !toSave.value.some((a) => a.name === name),
  );
  if (stillUnmapped.length > 0) {
    return err(
      domainError("STATEMENT_ACCOUNT_UNMAPPED", "対応づいていない口座があります", {
        names: stillUnmapped,
      }),
    );
  }
  if (plan.countNew !== input.expected.countNew) {
    return planChanged({ expected: input.expected.countNew, actual: plan.countNew });
  }
  if (plan.period === null) {
    return err(validationError("取り込む行がありません"));
  }

  const now = deps.clock.now();
  const sourcePlan =
    input.source === undefined ? undefined : planSourceSave(deps, tx, input.source, now);
  if (sourcePlan !== undefined && !sourcePlan.ok) return sourcePlan;
  // 未対応の口座の対応は明細より先に、同じ UnitOfWork で保存する。1 つでも落ちれば `err` で全部巻き戻る
  for (const { name, input: accountInput } of toSave.value) {
    const saved = saveStatementAccountInTx(deps, tx, name, accountInput, false);
    if (!saved.ok) return saved;
  }
  const accountIdOf = new Map(tx.statements.listStatementAccounts().map((a) => [a.name, a.id]));
  const batch: StatementBatch = {
    id: deps.ids.next(),
    origin: input.origin,
    sourceName: sourcePlan?.value.next.name ?? null,
    inputSha256: input.sha256,
    periodFrom: plan.period.from,
    periodTo: plan.period.to,
    countNew: plan.countNew,
    countExisting: plan.countExisting,
    countUnreadable: input.unreadable.length,
    createdAt: now,
  };
  tx.statements.insertStatementBatch(batch);
  tx.statements.appendStatementAudit(
    auditEntry(deps, {
      targetType: "statement_batch",
      targetId: batch.id,
      action: "create",
      after: batch,
      at: now,
    }),
  );
  if (sourcePlan !== undefined) {
    const { previous, next } = sourcePlan.value;
    tx.statements.upsertStatementSource(next);
    tx.statements.appendStatementAudit(
      auditEntry(deps, {
        targetType: "statement_source",
        targetId: next.id,
        action: previous === undefined ? "create" : "update",
        before: previous,
        after: next,
        at: now,
      }),
    );
  }

  const records: StatementRecord[] = plan.rows
    .filter((r) => r.status === "new")
    .map(({ key, row }) => ({
      id: deps.ids.next(),
      batchId: batch.id,
      statementAccountId: accountIdOf.get(row.accountName) as string,
      stableKey: key,
      externalId: row.externalId ?? null,
      date: row.date,
      amount: row.amount,
      content: row.content,
      normalizedContent: normalizeContent(row.content),
      categoryMajor: row.categoryMajor ?? null,
      categoryMinor: row.categoryMinor ?? null,
      memo: row.memo ?? null,
      transferFlag: row.transferFlag,
      changedJson: null,
      changedAckAt: null,
      excludedAt: null,
      excludedReason: null,
      createdAt: now,
    }));
  tx.statements.insertStatements(records);

  for (const r of plan.rows) {
    if (r.status !== "changed" || r.changed === undefined || r.existingId === undefined) continue;
    tx.statements.markStatementChanged(r.existingId, JSON.stringify(r.changed.after));
    tx.statements.appendStatementAudit(
      auditEntry(deps, {
        targetType: "statement",
        targetId: r.existingId,
        action: "update",
        before: r.changed.before,
        after: r.changed.after,
        at: now,
      }),
    );
  }

  return ok({
    batch,
    added: records.length,
    changed: plan.countChanged,
    source: sourcePlan?.value.next ?? null,
  });
}

/**
 * 取込の確定（表のテキストから）。読めなければ `readInput` のエラー。何も書かない。
 * `saveSource` があれば、取込元を同じ UnitOfWork で保存・更新する（R7、INV-47）: 対応は入力の `mapping`、
 * 見出しの署名は入力のテキストの見出しの行（`mapping.headerRow`）から、口座名は `mapping` が `accountName` の列を
 * 持たないときだけ入力の `fixedAccountName`（INV-50）。取込の回の `sourceName` に名前を残す
 */
export function commitStatementImport(
  deps: StatementDeps,
  input: StatementImportCommitInput,
): Result<StatementImportCommitted> {
  const rows = readInput(input);
  if (!rows.ok) return rows;
  let source: StatementSourceToSave | undefined;
  if (input.saveSource != null) {
    const detected = detectTableLayout(input.text, {
      delimiter: input.mapping.delimiter,
      headerRow: input.mapping.headerRow,
    });
    if (!detected.ok) return detected;
    source = {
      id: input.saveSource.id,
      name: input.saveSource.name,
      fixedAccountName:
        input.mapping.columns.accountName === undefined
          ? (input.fixedAccountName?.trim() ?? null)
          : null,
      mapping: input.mapping,
      header: headerSignature(detected.value.header),
    };
  }
  return commitStatementRows(deps, {
    ...rows.value,
    expected: input.expected,
    source,
    accounts: input.accounts,
  });
}

/** 取込の回の一覧（新しい順） */
export function listStatementBatches(deps: Pick<StatementDeps, "uow">): Result<StatementBatch[]> {
  return deps.uow.run((tx) => ok(tx.statements.listStatementBatches()));
}

// ---- 候補（US2。§1.4、R8） ----

export type CandidatesBuilt = { built: number; needsAi: string[] };

/**
 * 候補を作る（R8、FR-013）。`statementIds` を省略すると未処理すべて。未処理でない明細は対象にならない
 * （知らない ID は `STATEMENT_NOT_FOUND`。何も書かない）。順序は 既存の仕訳 → 振替の対 → none（ルールの段は US3）。
 * 0 円は候補を作らない。`built` は書いた候補の数（none を含む）、`needsAi` は AI に回す明細の ID。
 * AI の候補は、前の段で作れないとき残す。`options.rebuild` なら作り直す
 */
export function buildCandidates(
  deps: StatementDeps,
  statementIds?: readonly string[],
  options: { rebuild?: boolean } = {},
): Result<CandidatesBuilt> {
  return deps.uow.run((tx) => {
    const states = loadStatementStates(tx);
    let targetIds: Set<string>;
    if (statementIds === undefined) {
      targetIds = new Set(states.map((s) => s.record.id));
    } else {
      const known = new Set(states.map((s) => s.record.id));
      const unknown = statementIds.find((id) => !known.has(id));
      if (unknown !== undefined) {
        return err(
          domainError("STATEMENT_NOT_FOUND", "明細が見つかりません", { statementId: unknown }),
        );
      }
      targetIds = new Set(statementIds);
    }
    return buildCandidatesInTx(deps, tx, states, targetIds, options.rebuild === true);
  });
}

const contentOf = (record: StatementRecord, accountName: string): StatementChange["before"] => ({
  accountName,
  date: record.date,
  amount: record.amount,
  content: record.content,
  categoryMajor: record.categoryMajor,
  categoryMinor: record.categoryMinor,
  memo: record.memo,
});

/**
 * 明細の一覧（`StatementView`。FR-012）。日付の新しい順（同じ日付は新しい取込が先）。
 * 状態は結びつき・除外・仕訳から導く（`statementStatus`）。`changed` は `changed_json` があり未確認のときだけ。
 * `links` は有効な結びつき。絞り込みは `status`（`changed` は変更ありの印）・`accountId`（取込元の口座）・`from`・`to`
 */
export function listStatements(
  deps: Pick<StatementDeps, "uow">,
  query: StatementListQuery = {},
): Result<StatementView[]> {
  return deps.uow.run((tx) => ok(statementViewsInTx(tx, query)));
}

/** `listStatements` の中身。UnitOfWork の中（`tx`）で呼ぶ（承認・除外などが更新後の 1 件を返すのに使う） */
export function statementViewsInTx(
  tx: StatementTx,
  query: StatementListQuery = {},
): StatementView[] {
  const accounts = new Map(tx.statements.listStatementAccounts().map((a) => [a.id, a]));
  const candidates = new Map(
    tx.statements.listStatementCandidates().map((c) => [c.statementId, c]),
  );
  const states = loadStatementStates(tx);
  // 重複の疑い（R3）の相手の候補: 口座と正規化した内容が同じ明細（取込の計画と同じ判定）
  const sameContent = new Map<string, StatementRecord[]>();
  for (const { record } of states) {
    const key = contentGroup(accounts.get(record.statementAccountId)?.name ?? "", record.content);
    sameContent.set(key, [...(sameContent.get(key) ?? []), record]);
  }
  const views: StatementView[] = [];
  for (const { record, status, activeLinks } of states) {
    if (query.accountId !== undefined && record.statementAccountId !== query.accountId) continue;
    if (query.from !== undefined && record.date < query.from) continue;
    if (query.to !== undefined && record.date > query.to) continue;
    const account = accounts.get(record.statementAccountId) as StatementAccount;
    const changed =
      record.changedJson !== null && record.changedAckAt === null
        ? {
            before: contentOf(record, account.name),
            after: JSON.parse(record.changedJson) as StatementChange["after"],
          }
        : null;
    if (
      query.status === "changed"
        ? changed === null
        : query.status !== undefined && query.status !== status
    ) {
      continue;
    }
    const candidate = candidates.get(record.id);
    // 未処理の明細だけに出す（登録・除外した明細に出しても、利用者の判断に使えない）
    const duplicateOf =
      status === "unprocessed"
        ? possibleDuplicatesOf(
            record,
            (sameContent.get(contentGroup(account.name, record.content)) ?? []).filter(
              (r) => r.id !== record.id,
            ),
          ).map((r) => r.id)
        : [];
    views.push({
      id: record.id,
      date: record.date,
      amount: record.amount,
      content: record.content,
      accountName: account.name,
      usage: account.usage,
      status,
      changed,
      candidate: candidate === undefined ? null : toCandidateView(candidate),
      links: activeLinks.map((l) => ({ journalId: l.journalId, kind: l.kind })),
      ...(duplicateOf.length === 0 ? {} : { duplicateOf }),
    });
  }
  // 取り込んだ順の新しい方を先にして、日付で安定に並べる
  return views.reverse().sort((a, b) => b.date.localeCompare(a.date));
}

/**
 * 仕訳に結びついている明細（FR-020。001 の `GET /journals/:journalId` の `statements`）。
 * 失効していない結びつきだけ。作成の順
 */
export function listJournalStatements(
  deps: Pick<StatementDeps, "uow">,
  journalId: string,
): Result<{ statementId: string; kind: StatementLinkKind }[]> {
  return deps.uow.run((tx) =>
    ok(
      tx.statements
        .listStatementLinks()
        .filter((l) => l.journalId === journalId && l.revokedAt === null)
        .map((l) => ({ statementId: l.statementId, kind: l.kind })),
    ),
  );
}

// ---- 設定（§1.8、R12、FR-018・027） ----

/** しきい値の既定（まとめて承認 80、外部へ送る 60） */
export const DEFAULT_STATEMENT_SETTINGS = { bulkThreshold: 80, externalThreshold: 60 } as const;

const isPercent = (n: number) => Number.isInteger(n) && n >= 0 && n <= 100;

/** しきい値の設定。保存がなければ既定（`updatedAt` は今の時刻）。読むだけで書かない */
export function getStatementSettings(
  deps: Pick<StatementDeps, "uow" | "clock">,
): Result<StatementSettings> {
  return deps.uow.run((tx) =>
    ok(
      tx.statements.getStatementSettings() ?? {
        ...DEFAULT_STATEMENT_SETTINGS,
        updatedAt: deps.clock.now(),
      },
    ),
  );
}

/**
 * しきい値を保存する。どちらも 0〜100 の整数（範囲外は `VALIDATION`）。変更を監査に残す（最初は create、
 * 次から update）。変更がなければ書かない
 */
export function saveStatementSettings(
  deps: StatementDeps,
  input: StatementSettingsInput,
): Result<StatementSettings> {
  for (const field of ["bulkThreshold", "externalThreshold"] as const) {
    if (!isPercent(input[field])) {
      return err(validationError("しきい値は 0〜100 の整数にしてください", { field }));
    }
  }
  return deps.uow.run((tx) => {
    const previous = tx.statements.getStatementSettings();
    if (
      previous !== undefined &&
      previous.bulkThreshold === input.bulkThreshold &&
      previous.externalThreshold === input.externalThreshold
    ) {
      return ok(previous);
    }
    const now = deps.clock.now();
    const settings: StatementSettings = {
      bulkThreshold: input.bulkThreshold,
      externalThreshold: input.externalThreshold,
      updatedAt: now,
    };
    tx.statements.saveStatementSettings(settings);
    tx.statements.appendStatementAudit(
      auditEntry(deps, {
        targetType: "statement_settings",
        targetId: "statement_settings",
        action: previous === undefined ? "create" : "update",
        before: previous,
        after: settings,
        at: now,
      }),
    );
    return ok(settings);
  });
}
