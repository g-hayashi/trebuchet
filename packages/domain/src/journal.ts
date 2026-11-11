import { defaultTaxCategory } from "@trebuchet/schema";
import { isValidDate } from "./dates.ts";
import { computeInclusiveTax, isYen, sumYen } from "./money.ts";
import { isTaxableCategory, resolveTaxRate } from "./tax-rates.ts";
import { resolveTaxSetting, type TaxSettingDraft } from "./tax-settings.ts";
import { blankToNull } from "./text.ts";
import {
  type Account,
  type DomainError,
  domainError,
  err,
  type FiscalPeriod,
  findPeriodByDate,
  type JournalDraft,
  type LineDraft,
  ok,
  type Partner,
  type Result,
  type SubAccount,
  type Tag,
  type TaxRate,
  type ValidJournal,
  type ValidLine,
  validationError,
} from "./types.ts";

/** 仕訳の検証に使うマスタ（1つの事業体の分） */
export type JournalContext = {
  accounts: readonly Account[];
  subAccounts: readonly SubAccount[];
  partners: readonly Pick<Partner, "id">[];
  tags: readonly Pick<Tag, "id">[];
  periods: readonly FiscalPeriod[];
  taxSettings: readonly TaxSettingDraft[];
  taxRates: readonly TaxRate[];
};

/** 日付を含む会計期間。期間の外なら OUT_OF_PERIOD、締め済みなら PERIOD_CLOSED（訂正仕訳を案内する） */
export function checkPeriod(date: string, periods: readonly FiscalPeriod[]): Result<FiscalPeriod> {
  const period = findPeriodByDate(periods, date);
  if (period === undefined) {
    const lastEnd = periods.reduce<string | undefined>(
      (max, p) => (max === undefined || p.endDate > max ? p.endDate : max),
      undefined,
    );
    const after = lastEnd === undefined || date > lastEnd;
    return err(
      domainError(
        "OUT_OF_PERIOD",
        after ? "日付が会計期間の外です。先に会計期間を作成してください" : "日付が会計期間の外です",
        after ? { date, suggest: "create_fiscal_period" } : { date },
      ),
    );
  }
  if (period.status === "closed") {
    return err(
      domainError(
        "PERIOD_CLOSED",
        `${period.fiscalYear}年度は締め済みです。訂正は訂正仕訳で行ってください`,
        { fiscalYear: period.fiscalYear, suggest: "correcting_entry" },
      ),
    );
  }
  return ok(period);
}

/**
 * 仕訳の下書きを検証し、税区分の既定値と内税額を補った仕訳にする（INV-1〜3, INV-10, FR-015〜017）。
 * 違反はすべて集めて返す。行に関する違反の details には lineIndex（0 始まり）と field を入れる
 */
export function validateJournal(
  draft: JournalDraft,
  ctx: JournalContext,
): Result<ValidJournal, DomainError[]> {
  const errors: DomainError[] = [];
  const dateOk = isValidDate(draft.date);
  let period: FiscalPeriod | undefined;
  let computeTax = false;

  if (!dateOk) {
    errors.push(validationError("存在しない日付です", { field: "date" }));
  } else {
    const p = checkPeriod(draft.date, ctx.periods);
    if (p.ok) {
      period = p.value;
      const setting = resolveTaxSetting(draft.date, ctx.taxSettings);
      if (setting === undefined) {
        errors.push(
          domainError("TAX_SETTING_GAP", "この日付に適用される消費税の設定がありません", {
            date: draft.date,
          }),
        );
      } else if (setting.accountingMethod !== "tax_included") {
        errors.push(
          domainError("TAX_METHOD_UNSUPPORTED", "税抜経理の期間の仕訳はまだ登録できません", {
            date: draft.date,
          }),
        );
      } else {
        computeTax = setting.taxpayerStatus !== "exempt";
      }
    } else {
      errors.push(p.error);
    }
  }

  const accounts = new Map(ctx.accounts.map((a) => [a.id, a]));
  const subAccounts = new Map(ctx.subAccounts.map((s) => [s.id, s]));
  const partnerIds = new Set(ctx.partners.map((p) => p.id));
  const tagIds = new Set(ctx.tags.map((t) => t.id));

  const lineError = (lineIndex: number, field: string, message: string, extra = {}) =>
    errors.push(validationError(message, { lineIndex, field, ...extra }));

  const lines = draft.lines.map((line: LineDraft, lineIndex): ValidLine => {
    if (!isYen(line.amount)) {
      lineError(lineIndex, "amount", "金額は1円以上1兆円未満の整数で入力してください");
    }

    const account = accounts.get(line.accountId);
    if (account === undefined) {
      errors.push(
        domainError("ACCOUNT_NOT_FOUND", "勘定科目が見つかりません", {
          lineIndex,
          field: "accountId",
          accountId: line.accountId,
        }),
      );
    } else if (!account.isActive) {
      errors.push(
        domainError("ACCOUNT_INACTIVE", `勘定科目「${account.name}」は使用停止です`, {
          lineIndex,
          field: "accountId",
          accountId: line.accountId,
        }),
      );
    }

    if (line.subAccountId !== undefined) {
      const sub = subAccounts.get(line.subAccountId);
      if (sub === undefined || sub.accountId !== line.accountId) {
        lineError(lineIndex, "subAccountId", "補助科目がこの勘定科目のものではありません");
      } else if (!sub.isActive) {
        lineError(lineIndex, "subAccountId", `補助科目「${sub.name}」は使用停止です`);
      }
    }

    if (line.partnerId !== undefined && !partnerIds.has(line.partnerId)) {
      lineError(lineIndex, "partnerId", "取引先が見つかりません");
    }

    const lineTags = line.tagIds ?? [];
    if (new Set(lineTags).size !== lineTags.length) {
      lineError(lineIndex, "tagIds", "同じタグが重複しています");
    } else if (lineTags.some((id) => !tagIds.has(id))) {
      lineError(lineIndex, "tagIds", "タグが見つかりません");
    }

    const taxCategory =
      line.taxCategory ??
      (account === undefined || !dateOk
        ? "OUT_OF_SCOPE"
        : defaultTaxCategory(draft.date, account, ctx.taxSettings));
    let taxAmount = 0;
    if (computeTax && isTaxableCategory(taxCategory)) {
      const rate = resolveTaxRate(taxCategory, draft.date, ctx.taxRates);
      if (rate === undefined) {
        lineError(lineIndex, "taxCategory", "この日付に適用される税率がない税区分です", {
          taxCategory,
        });
      } else if (isYen(line.amount)) {
        taxAmount = computeInclusiveTax(line.amount, rate);
      }
    }

    return {
      lineNo: lineIndex + 1,
      side: line.side,
      accountId: line.accountId,
      subAccountId: line.subAccountId ?? null,
      amount: line.amount,
      taxCategory,
      taxAmount,
      partnerId: line.partnerId ?? null,
      description: blankToNull(line.description),
      tagIds: [...lineTags],
    };
  });

  const hasBothSides =
    lines.some((l) => l.side === "debit") && lines.some((l) => l.side === "credit");
  if (lines.length < 2 || !hasBothSides) {
    errors.push(validationError("借方と貸方をそれぞれ1行以上入力してください", { field: "lines" }));
  } else if (lines.every((l) => isYen(l.amount))) {
    const debit = sumYen(lines.filter((l) => l.side === "debit").map((l) => l.amount));
    const credit = sumYen(lines.filter((l) => l.side === "credit").map((l) => l.amount));
    if (debit !== credit) {
      errors.push(
        domainError("UNBALANCED", "借方合計と貸方合計が一致しません", {
          debit,
          credit,
          diff: debit - credit,
        }),
      );
    }
  }

  if (errors.length > 0 || period === undefined) return err(errors);
  return ok({
    date: draft.date,
    fiscalPeriodId: period.id,
    memo: blankToNull(draft.memo),
    correctsJournalId: draft.correctsJournalId ?? null,
    lines,
  });
}

/** 複数の違反を1つのエラーにまとめる。主なエラーは最初のもので、details.errors にすべての違反を入れる */
export function combineErrors(errors: readonly DomainError[]): DomainError {
  const [first] = errors;
  if (first === undefined) return validationError("入力が正しくありません");
  return { ...first, details: { ...first.details, errors: [...errors] } };
}
