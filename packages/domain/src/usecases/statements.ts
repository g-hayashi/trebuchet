import type {
  StatementAccount,
  StatementAccountInput,
  StatementAccountSaved,
  StatementBatch,
  StatementImportCommitted,
  StatementImportPreview,
  StatementImportSource,
  StatementOrigin,
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

// 明細の取込（006 US1。R4・R14・R18、FR-002〜007）

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
 * 未処理の候補の作り直し（`rebuilt`）は US2（T014）で足す。今は 0
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
    return ok({ account, rebuilt: 0 });
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
