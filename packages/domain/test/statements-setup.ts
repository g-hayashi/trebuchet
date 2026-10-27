import type { Purpose } from "@trebuchet/schema";
import type { StatementUnitOfWork } from "../src/ports.ts";
import { journalShape } from "../src/statements/journal-shape.ts";
import type { StatementRow } from "../src/statements/table.ts";
import type { JournalDraft, Result } from "../src/types.ts";
import {
  commitStatementImport,
  previewStatementImport,
  saveStatementAccount,
} from "../src/usecases/statements.ts";
import { type FakeStatementUnitOfWork, fakeStatementUnitOfWork } from "./fakes.ts";
import { setupBase } from "./ledger-setup.ts";
import { statementTableOf } from "./statements-arbitraries.ts";

/** Result を取り出す（失敗なら例外） */
export const unwrap = <T>(r: Result<T>): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};

/** 失敗のエラーコード（成功なら例外） */
export const codeOf = <T>(r: Result<T>): string => {
  if (r.ok) throw new Error("成功しました（失敗を期待）");
  return r.error.code;
};

/**
 * 006 の承認・除外などのテストが共有する準備: 3 つの取込元の口座（銀行 = business・普通預金、
 * カード = mixed・未払金、現金 = private）を対応づけ、行を取り込み、案を作る補助を返す。
 * `uow` は `FakeUnitOfWork`（巻き戻しもする）。名前はすべて合成
 */
export function setupStatements(
  options: {
    /** UnitOfWork を差し替える（障害の注入）。`inner` の状態を `base` と共有する */
    wrap?: (inner: FakeStatementUnitOfWork) => StatementUnitOfWork;
  } = {},
) {
  const base = setupBase();
  const inner = fakeStatementUnitOfWork(base.ledger, base.masters);
  const uow = inner;
  const runner: StatementUnitOfWork = options.wrap?.(inner) ?? inner;
  const deps = { uow: runner, ids: base.ids, clock: base.clock };
  const ledgerDeps = {
    ledger: base.ledger,
    masters: base.masters,
    ids: base.ids,
    clock: base.clock,
  };
  const a = {
    bank: base.accountId("普通預金"),
    payable: base.accountId("未払金"),
    cash: base.accountId("現金"),
    rent: base.accountId("地代家賃"),
    supplies: base.accountId("消耗品費"),
    drawing: base.accountId("事業主貸"),
    contribution: base.accountId("事業主借"),
  };

  const mapAccount = (name: string, over: Record<string, unknown> = {}) =>
    unwrap(
      saveStatementAccount(deps, name, {
        usage: "business",
        kind: "bank",
        accountId: a.bank,
        ...over,
      } as never),
    );
  const mapBank = () => mapAccount("サンプル銀行");
  const mapCard = () =>
    mapAccount("テストカードA", { kind: "card", usage: "mixed", accountId: a.payable });
  const mapPrivate = () =>
    mapAccount("テスト現金", { kind: "cash", usage: "private", accountId: undefined });
  const mapAll = () => {
    mapBank();
    mapCard();
    mapPrivate();
  };

  let shaSeq = 0;
  const importRows = (rows: StatementRow[], year = 2026) => {
    shaSeq += 1;
    const sha256 = shaSeq.toString(16).padStart(64, "0");
    const input = { ...statementTableOf(rows), year, origin: "paste" as const, sha256 };
    const preview = unwrap(previewStatementImport(deps, input));
    unwrap(
      commitStatementImport(deps, {
        ...input,
        expected: { inputSha256: sha256, countNew: preview.countNew },
      }),
    );
  };
  const row = (over: Partial<StatementRow> = {}): StatementRow => ({
    accountName: "サンプル銀行",
    date: "2026-05-10",
    content: "ショップ001",
    amount: -1200,
    transferFlag: false,
    ...over,
  });

  const statements = () => uow.statements.state.statements;
  const idOf = (content: string) => {
    const s = statements().find((x) => x.content === content);
    if (s === undefined) throw new Error(`明細がない: ${content}`);
    return s.id;
  };
  const links = () => uow.statements.state.links;
  const activeLinks = (statementId?: string) =>
    links().filter((l) => l.revokedAt === null && (statementId ?? l.statementId) === l.statementId);

  /** 明細の口座の用途と判定から、R5 の形の仕訳の案を作る（相手の科目は既定で地代家賃） */
  const shapeDraft = (statementId: string, purpose: Purpose, counterId = a.rent): JournalDraft => {
    const record = statements().find((s) => s.id === statementId);
    if (record === undefined) throw new Error("明細がない");
    const account = uow.statements.state.accounts.find((x) => x.id === record.statementAccountId);
    if (account === undefined) throw new Error("口座がない");
    const shaped = unwrap(
      journalShape({
        statement: record,
        account,
        purpose,
        counter: { accountId: counterId },
        accounts: base.masters.listAccounts(),
      }),
    );
    if (shaped === null) throw new Error("仕訳にならない");
    return shaped.draft;
  };

  return {
    ...base,
    uow,
    deps,
    ledgerDeps,
    a,
    mapAccount,
    mapBank,
    mapCard,
    mapPrivate,
    mapAll,
    importRows,
    row,
    statements,
    idOf,
    links,
    activeLinks,
    shapeDraft,
  };
}
export type StatementsCtx = ReturnType<typeof setupStatements>;
