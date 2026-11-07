import type { JournalInput, StatementAccount, TaxCategoryCode } from "@trebuchet/schema";

/** 候補の案の行（`JournalInput` の 1 行） */
type DraftLine = JournalInput["lines"][number];

/** 明細の口座の対応（科目・補助科目）。科目なし（私用の口座）は `accountId` が null */
type StatementAccountRef = Pick<StatementAccount, "accountId" | "subAccountId">;

/** 一覧でその場で選び直せる、相手の行の科目・税区分（空の税区分は「未指定」） */
export type CounterEdit = { accountId?: string; taxCategory?: string };

const isStatementLine = (line: DraftLine, account: StatementAccountRef) =>
  line.accountId === account.accountId && (line.subAccountId ?? null) === account.subAccountId;

/**
 * 明細の口座の行でない行（相手の行）の位置。**ちょうど 1 行のときだけ**返す（それ以外は「詳細で編集」）。
 * 明細の口座が分からない・科目なし（私用）のときは、どの行が明細の口座の行か決められないので返さない
 */
export function counterLineIndex(
  draft: JournalInput,
  account: StatementAccountRef | undefined,
): number | undefined {
  if (account === undefined || account.accountId === null) return undefined;
  const counters = draft.lines.flatMap((line, index) =>
    isStatementLine(line, account) ? [] : [index],
  );
  return counters.length === 1 ? counters[0] : undefined;
}

/** 相手の行（`index`）の科目・税区分を選び直した案。科目を変えたら補助科目は外す。ほかの行・項目は変えない */
export function applyCounterEdit(
  draft: JournalInput,
  index: number,
  edit: CounterEdit,
): JournalInput {
  const lines = draft.lines.map((line, i): DraftLine => {
    if (i !== index) return line;
    let next = line;
    if (edit.accountId !== undefined && edit.accountId !== line.accountId) {
      const { subAccountId: _dropped, ...rest } = next;
      next = { ...rest, accountId: edit.accountId };
    }
    if (edit.taxCategory !== undefined) {
      const { taxCategory: _dropped, ...rest } = next;
      next =
        edit.taxCategory === ""
          ? rest
          : { ...rest, taxCategory: edit.taxCategory as TaxCategoryCode };
    }
    return next;
  });
  return { ...draft, lines };
}
