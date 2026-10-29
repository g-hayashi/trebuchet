import type { StatementSource } from "@trebuchet/schema";
import { auditEntry } from "../audit.ts";
import type { Clock, IdGenerator, StatementUnitOfWork } from "../ports.ts";
import { domainError, err, ok, type Result, validationError } from "../types.ts";

// 取込元（列の対応の保存）の一覧・名前の変更・削除（007/R7、FR-012）。保存と更新は取込の確定（`commitStatementImport`）

type SourceDeps = { uow: StatementUnitOfWork; ids: IdGenerator; clock: Clock };

export const MAX_STATEMENT_SOURCE_NAME_LENGTH = 100;

/** 名前を整える（前後の空白を除く）。1〜100 字でなければ `VALIDATION` */
export function checkStatementSourceName(name: string): Result<string> {
  const trimmed = name.trim();
  if (trimmed === "" || [...trimmed].length > MAX_STATEMENT_SOURCE_NAME_LENGTH) {
    return err(
      validationError(`取込元の名前は 1〜${MAX_STATEMENT_SOURCE_NAME_LENGTH} 字にしてください`, {
        field: "name",
      }),
    );
  }
  return ok(trimmed);
}

export const sourceNotFound = (id: string) =>
  err(domainError("STATEMENT_SOURCE_NOT_FOUND", "取込元が見つかりません", { id }));

export const sourceNameTaken = (name: string) =>
  err(
    domainError("STATEMENT_SOURCE_NAME_TAKEN", "同じ名前の取込元があります", {
      name,
    }),
  );

/** 取込元の一覧（`last_used_at` の新しい順。同じなら名前順） */
export function listStatementSources(deps: Pick<SourceDeps, "uow">): Result<StatementSource[]> {
  return deps.uow.run((tx) =>
    ok(
      tx.statements
        .listStatementSources()
        .sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt) || a.name.localeCompare(b.name)),
    ),
  );
}

/**
 * 名前を変える（前後の空白を除く。1〜100 字）。別の取込元と同じなら `STATEMENT_SOURCE_NAME_TAKEN`、
 * ない id は `STATEMENT_SOURCE_NOT_FOUND`。同じ名前への変更は何も書かない。変更は監査に残す
 */
export function renameStatementSource(
  deps: SourceDeps,
  id: string,
  name: string,
): Result<StatementSource> {
  const checked = checkStatementSourceName(name);
  if (!checked.ok) return checked;
  const newName = checked.value;
  return deps.uow.run((tx) => {
    const sources = tx.statements.listStatementSources();
    const previous = sources.find((s) => s.id === id);
    if (previous === undefined) return sourceNotFound(id);
    if (previous.name === newName) return ok(previous);
    if (sources.some((s) => s.id !== id && s.name === newName)) return sourceNameTaken(newName);
    const now = deps.clock.now();
    const updated: StatementSource = { ...previous, name: newName, updatedAt: now };
    tx.statements.upsertStatementSource(updated);
    tx.statements.appendStatementAudit(
      auditEntry(deps, {
        targetType: "statement_source",
        targetId: id,
        action: "update",
        before: previous,
        after: updated,
        at: now,
      }),
    );
    return ok(updated);
  });
}

/** 取込元を消す（物理削除。取込の回・明細・仕訳は変えない）。ない id は `STATEMENT_SOURCE_NOT_FOUND`。監査に残す */
export function deleteStatementSource(deps: SourceDeps, id: string): Result<void> {
  return deps.uow.run((tx) => {
    const previous = tx.statements.listStatementSources().find((s) => s.id === id);
    if (previous === undefined) return sourceNotFound(id);
    tx.statements.deleteStatementSource(id);
    tx.statements.appendStatementAudit(
      auditEntry(deps, {
        targetType: "statement_source",
        targetId: id,
        action: "delete",
        before: previous,
      }),
    );
    return ok(undefined);
  });
}
