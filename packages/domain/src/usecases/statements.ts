import type {
  StatementAccount,
  StatementAccountInput,
  StatementAccountSaved,
  StatementBatch,
  StatementChange,
  StatementImportCommitted,
  StatementImportPreview,
  StatementImportSource,
  StatementListQuery,
  StatementOrigin,
  StatementSettings,
  StatementSettingsInput,
  StatementView,
} from "@trebuchet/schema";
import { auditEntry } from "../audit.ts";
import type { Clock, IdGenerator, StatementStore, StatementUnitOfWork } from "../ports.ts";
import { normalizeContent } from "../statements/normalize.ts";
import { type PastedRow, parseMfmePaste, type UnreadableRow } from "../statements/paste.ts";
import {
  type ExistingStatement,
  planStatementImport,
  type StatementImportPlan,
} from "../statements/plan.ts";
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
 * 取込元の口座（MF ME の保有金融機関）の用途・種類・科目を名前で保存する（なければ追加、あれば更新）。
 * `private` は科目を持たず、ほかは科目が必須。変更は監査に残す（R18）。変更がなければ何も書かない。
 * 対応が変わったときは、その口座の未処理の明細の候補（と、振替の対の相手の候補）を作り直す（R8）。
 * 作り直した候補の数が `rebuilt`（まだ候補のない明細は作らない）
 */
export function saveStatementAccount(
  deps: StatementDeps,
  name: string,
  input: StatementAccountInput,
): Result<StatementAccountSaved> {
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

  return deps.uow.run((tx) => {
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
  });
}

// ---- 取込（§1.2・§1.3、R14） ----

/**
 * 取込の入力（読み取り済みの行）。`sha256` は入力全体のハッシュで、呼び出し側（server）が計算する
 * （domain に暗号の関数を持ち込まない。002 と同じ）
 */
export type StatementRowsInput = {
  origin: StatementOrigin;
  rows: PastedRow[];
  unreadable: UnreadableRow[];
  sha256: string;
};

export type StatementImportInput = {
  source: Extract<StatementImportSource, { kind: "paste" }>;
  sha256: string;
};

export type StatementImportCommitInput = StatementImportInput & {
  /** 画面が見たプレビューのハッシュと新規の件数（FR-002） */
  expected: { inputSha256: string; countNew: number };
};

type StatementTx = Parameters<Parameters<StatementUnitOfWork["run"]>[0]>[0];

/** 計画を立てる（保存済みの明細と口座を読む）。`accounts` は口座の ID の引き当てにも使う */
function buildPlan(statements: StatementStore, rows: PastedRow[]) {
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

function toPreview(plan: StatementImportPlan, input: StatementRowsInput): StatementImportPreview {
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
    unmappedAccounts: plan.unmappedAccounts,
    countNew: plan.countNew,
  };
}

/** 取込のプレビュー（読み取り済みの行から）。何も書かない */
export function previewStatementRows(
  deps: Pick<StatementDeps, "uow">,
  input: StatementRowsInput,
): Result<StatementImportPreview> {
  return deps.uow.run((tx) => ok(toPreview(buildPlan(tx.statements, input.rows).plan, input)));
}

/** 取込のプレビュー（貼り付けのテキストから）。読めなければ `STATEMENT_PASTE_UNREADABLE` */
export function previewStatementImport(
  deps: Pick<StatementDeps, "uow">,
  input: StatementImportInput,
): Result<StatementImportPreview> {
  const parsed = parseMfmePaste(input.source.text, input.source.year);
  if (!parsed.ok) return parsed;
  return previewStatementRows(deps, { origin: "paste", sha256: input.sha256, ...parsed.value });
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
  input: StatementRowsInput & { expected: { inputSha256: string; countNew: number } },
): Result<StatementImportCommitted> {
  if (input.sha256 !== input.expected.inputSha256) {
    return planChanged({ expected: input.expected.inputSha256, actual: input.sha256 });
  }
  return deps.uow.run((tx) => commitInTx(deps, tx, input));
}

function commitInTx(
  deps: StatementDeps,
  tx: StatementTx,
  input: StatementRowsInput & { expected: { countNew: number } },
): Result<StatementImportCommitted> {
  const { plan, accounts } = buildPlan(tx.statements, input.rows);
  if (plan.unmappedAccounts.length > 0) {
    return err(
      domainError("STATEMENT_ACCOUNT_UNMAPPED", "対応づいていない保有金融機関があります", {
        names: plan.unmappedAccounts,
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
  const accountIdOf = new Map(accounts.map((a) => [a.name, a.id]));
  const batch: StatementBatch = {
    id: deps.ids.next(),
    origin: input.origin,
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

  return ok({ batch, added: records.length, changed: plan.countChanged });
}

/** 取込の確定（貼り付けのテキストから）。読めなければ `STATEMENT_PASTE_UNREADABLE` */
export function commitStatementImport(
  deps: StatementDeps,
  input: StatementImportCommitInput,
): Result<StatementImportCommitted> {
  const parsed = parseMfmePaste(input.source.text, input.source.year);
  if (!parsed.ok) return parsed;
  return commitStatementRows(deps, {
    origin: "paste",
    sha256: input.sha256,
    expected: input.expected,
    ...parsed.value,
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
  return deps.uow.run((tx) => {
    const accounts = new Map(tx.statements.listStatementAccounts().map((a) => [a.id, a]));
    const candidates = new Map(
      tx.statements.listStatementCandidates().map((c) => [c.statementId, c]),
    );
    const views: StatementView[] = [];
    for (const { record, status, activeLinks } of loadStatementStates(tx)) {
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
      });
    }
    // 取り込んだ順の新しい方を先にして、日付で安定に並べる
    return ok(views.reverse().sort((a, b) => b.date.localeCompare(a.date)));
  });
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
