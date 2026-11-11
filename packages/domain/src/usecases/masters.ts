import { MASTER_NAME_MAX, TAG_NAME_MAX } from "@trebuchet/schema";
import { type AuditInput, auditEntry } from "../audit.ts";
import { addDays, oneYearEnd, yearOfDate } from "../dates.ts";
import { type OpeningBalanceDraft, validateOpeningBalances } from "../opening.ts";
import type {
  Clock,
  ClosingStore,
  ClosingUnitOfWork,
  IdGenerator,
  MasterRepository,
} from "../ports.ts";
import { NORMAL_SIDE, SECTION_SORT_BASE } from "../seed/accounts.individual.ts";
import { type TaxSettingDraft, validateTaxSettings } from "../tax-settings.ts";
import {
  type Account,
  type AccountCategory,
  type AuditAction,
  type AuditTargetType,
  accountNotFoundError,
  type DomainError,
  domainError,
  entityNotFoundError,
  err,
  type FiscalPeriod,
  type Honorific,
  type OpeningBalance,
  ok,
  type Partner,
  periodNotFound,
  type ReportSection,
  type Result,
  type SubAccount,
  type Tag,
  type TaxSetting,
  validation,
} from "../types.ts";

/** マスタのユースケースの依存。repo は1つのテナントの DB */
export type MasterDeps = {
  repo: MasterRepository;
  ids: IdGenerator;
  clock: Clock;
};

function validName(
  raw: string,
  field: string,
  max = MASTER_NAME_MAX,
): { ok: true; value: string } | { ok: false; error: DomainError } {
  const name = raw.trim();
  if (name.length === 0 || name.length > max) {
    return validation(`名称は 1〜${max} 文字で入力してください`, { field });
  }
  return ok(name);
}

const accountNotFound = (accountId: string) => err(accountNotFoundError(accountId));

/** 最初からある科目（isSystem）の名前の変更・削除の拒否（FR-047、INV-70） */
const systemAccountProtected = (accountId: string, operation: string) =>
  err(
    domainError(
      "ACCOUNT_SYSTEM_PROTECTED",
      `最初からある科目は${operation}できません。使用停止にはできます`,
      { accountId },
    ),
  );

/** マスタの変更を audit_log に残す（理由なし、日時は今） */
function appendAudit(
  deps: MasterDeps,
  tx: MasterRepository,
  entry: AuditInput<AuditTargetType, AuditAction>,
): void {
  tx.appendAudit(auditEntry(deps, entry));
}

// ---- 勘定科目（FR-004, FR-005） ----

/** 区分ごとのコードの先頭の桁（初期セットと同じ） */
const CODE_PREFIX: Record<AccountCategory, number> = {
  asset: 1,
  liability: 2,
  equity: 3,
  revenue: 4,
  expense: 5,
};

/** 区分ごとに使える決算書の区分 */
const ALLOWED_SECTIONS: Record<AccountCategory, readonly ReportSection[]> = {
  asset: ["BS_ASSET"],
  liability: ["BS_LIABILITY"],
  equity: ["BS_EQUITY", "BS_ASSET"],
  revenue: ["PL_SALES", "PL_OTHER"],
  expense: ["PL_COGS", "PL_EXPENSE", "PL_OTHER"],
};

/**
 * 利用者が追加する科目のコード。区分の先頭の桁（4桁）のうち、使われている最大の番号の次。
 * 区分の番号を使い切ったら undefined。
 */
function nextAccountCode(
  category: AccountCategory,
  accounts: readonly Pick<Account, "code">[],
): string | undefined {
  const base = CODE_PREFIX[category] * 1000;
  let max = base;
  for (const a of accounts) {
    if (!/^\d{4}$/.test(a.code)) continue;
    const n = Number(a.code);
    if (n >= base && n < base + 1000 && n > max) max = n;
  }
  return max + 1 < base + 1000 ? String(max + 1) : undefined;
}

/**
 * 追加する科目の sort_order。同じ決算書の区分で、欄番号が同じか前の科目の直後に置く
 * （欄番号なしは区分の末尾）。同じ値の科目はコードの順に並ぶ。
 */
function sortOrderFor(
  reportSection: ReportSection,
  reportLine: number | null,
  accounts: readonly Account[],
): number {
  const line = reportLine ?? Number.POSITIVE_INFINITY;
  let order = SECTION_SORT_BASE[reportSection];
  for (const a of accounts) {
    if (a.reportSection !== reportSection) continue;
    if ((a.reportLine ?? Number.POSITIVE_INFINITY) > line) continue;
    order = Math.max(order, a.sortOrder);
  }
  return order + 1;
}

export type AccountDraft = {
  name: string;
  category: AccountCategory;
  reportSection: ReportSection;
  reportLine?: number | null | undefined;
};

export function addAccount(deps: MasterDeps, draft: AccountDraft): Result<Account> {
  const name = validName(draft.name, "name");
  if (!name.ok) return name;
  if (!ALLOWED_SECTIONS[draft.category].includes(draft.reportSection)) {
    return validation("科目の区分と決算書の区分が合いません", {
      category: draft.category,
      reportSection: draft.reportSection,
    });
  }
  const reportLine = draft.reportLine ?? null;
  if (reportLine !== null && (!Number.isInteger(reportLine) || reportLine < 1 || reportLine > 45)) {
    return validation("決算書の欄番号は 1〜45 で入力してください", { reportLine });
  }

  return deps.repo.transaction((tx) => {
    const accounts = tx.listAccounts();
    if (accounts.some((a) => a.name === name.value)) {
      return validation("同じ名前の科目があります", { name: name.value });
    }
    const code = nextAccountCode(draft.category, accounts);
    if (code === undefined) {
      return validation("この区分に追加できる科目の数の上限に達しました", {
        category: draft.category,
      });
    }
    const account: Account = {
      id: deps.ids.next(),
      code,
      name: name.value,
      category: draft.category,
      normalSide: NORMAL_SIDE[draft.category],
      reportSection: draft.reportSection,
      reportLine,
      sortOrder: sortOrderFor(draft.reportSection, reportLine, accounts),
      isSystem: false,
      isActive: true,
    };
    tx.insertAccount(account);
    return ok(account);
  });
}

/** 科目名を変更し、audit_log に rename（変更前・後の名前）を残す */
export function renameAccount(
  deps: MasterDeps,
  accountId: string,
  newName: string,
): Result<Account> {
  const name = validName(newName, "name");
  if (!name.ok) return name;
  return deps.repo.transaction((tx) => {
    const account = tx.getAccount(accountId);
    if (account === undefined) return accountNotFound(accountId);
    if (account.name === name.value) return ok(account);
    if (account.isSystem) return systemAccountProtected(accountId, "名前を変更");
    if (tx.listAccounts().some((a) => a.id !== accountId && a.name === name.value)) {
      return validation("同じ名前の科目があります", { name: name.value });
    }
    const updated = { ...account, name: name.value };
    tx.updateAccount(updated);
    appendAudit(deps, tx, {
      targetType: "account",
      targetId: accountId,
      action: "rename",
      before: { name: account.name },
      after: { name: updated.name },
    });
    return ok(updated);
  });
}

/**
 * 科目の使用停止・再開（使用中の科目も停止できる）。
 * 停止は audit_log に deactivate を残す。再開に対応する action はないため記録しない。
 */
export function setAccountActive(
  deps: MasterDeps,
  accountId: string,
  isActive: boolean,
): Result<Account> {
  return deps.repo.transaction((tx) => {
    const account = tx.getAccount(accountId);
    if (account === undefined) return accountNotFound(accountId);
    if (account.isActive === isActive) return ok(account);
    const updated = { ...account, isActive };
    tx.updateAccount(updated);
    if (!isActive) {
      appendAudit(deps, tx, {
        targetType: "account",
        targetId: accountId,
        action: "deactivate",
        before: { isActive: true },
        after: { isActive: false },
      });
    }
    return ok(updated);
  });
}

/** 決算書（一般用）の費用の欄の範囲。8〜24 は名前のある欄、25〜30 は任意欄、31 は雑費（欄32 は計） */
const EXPENSE_LINE_MIN = 8;
const EXPENSE_LINE_MAX = 31;

/**
 * 科目の決算書の欄番号を変更する（003 R12a、FR-006）。
 * 費用の科目で、欄が 8〜31 か null（解除）のときだけ許し、それ以外は REPORT_LINE_INVALID。
 * 変更は ClosingStore の closing_audit_log に account_report_line・update（変更前・後の欄番号）で残す。
 * 同じ値なら何もしない。ClosingStore は repo と同じトランザクションの中のものを渡すこと。
 */
export function setAccountReportLine(
  deps: MasterDeps & { closing: ClosingStore },
  accountId: string,
  reportLine: number | null,
): Result<Account> {
  if (
    reportLine !== null &&
    (!Number.isInteger(reportLine) ||
      reportLine < EXPENSE_LINE_MIN ||
      reportLine > EXPENSE_LINE_MAX)
  ) {
    return err(
      domainError(
        "REPORT_LINE_INVALID",
        `決算書の欄番号は ${EXPENSE_LINE_MIN}〜${EXPENSE_LINE_MAX} の費用の欄で指定してください`,
        { accountId, reportLine },
      ),
    );
  }
  return deps.repo.transaction((tx) => {
    const account = tx.getAccount(accountId);
    if (account === undefined) return accountNotFound(accountId);
    if (account.category !== "expense") {
      return err(
        domainError("REPORT_LINE_INVALID", "決算書の欄を変えられるのは費用の科目だけです", {
          accountId,
          category: account.category,
        }),
      );
    }
    if (account.reportLine === reportLine) return ok(account);
    const updated = { ...account, reportLine };
    tx.updateAccount(updated);
    deps.closing.appendClosingAudit(
      auditEntry(deps, {
        targetType: "account_report_line",
        targetId: accountId,
        action: "update",
        before: { reportLine: account.reportLine },
        after: { reportLine },
      }),
    );
    return ok(updated);
  });
}

/** 科目の変更（PATCH /accounts/:accountId）。指定した項目だけを変える */
export type AccountUpdate = {
  name?: string | undefined;
  isActive?: boolean | undefined;
  reportLine?: number | null | undefined;
};

/**
 * 科目の名称・使用停止・決算書の欄を、指定された順（名称 → 使用停止 → 欄）に変える。
 * どれかが失敗すれば、全部を取り消してその err を返す。欄の変更の履歴は ClosingStore に残すので、
 * マスタと決算の記録を同じトランザクションで扱う決算の UnitOfWork を使う
 */
export function updateAccount(
  deps: { uow: ClosingUnitOfWork; ids: IdGenerator; clock: Clock },
  accountId: string,
  patch: AccountUpdate,
): Result<Account> {
  return deps.uow.run(({ masters, closing }) => {
    const txDeps = { repo: masters, closing, ids: deps.ids, clock: deps.clock };
    const account = masters.getAccount(accountId);
    if (account === undefined) return accountNotFound(accountId);
    let current: Result<Account> = ok(account);
    if (patch.name !== undefined) current = renameAccount(txDeps, accountId, patch.name);
    if (current.ok && patch.isActive !== undefined) {
      current = setAccountActive(txDeps, accountId, patch.isActive);
    }
    if (current.ok && patch.reportLine !== undefined) {
      current = setAccountReportLine(txDeps, accountId, patch.reportLine);
    }
    return current;
  });
}

/** 使われていない科目を削除する（補助科目もあわせて消える）。使用中なら ACCOUNT_IN_USE */
export function deleteAccount(deps: MasterDeps, accountId: string): Result<void> {
  return deps.repo.transaction((tx) => {
    const account = tx.getAccount(accountId);
    if (account === undefined) return accountNotFound(accountId);
    if (account.isSystem) return systemAccountProtected(accountId, "削除");
    if (tx.isAccountUsed(accountId)) {
      return err(
        domainError(
          "ACCOUNT_IN_USE",
          "仕訳または期首残高で使われている科目は削除できません。使用停止にしてください",
          { accountId },
        ),
      );
    }
    tx.deleteAccount(accountId);
    return ok(undefined);
  });
}

// ---- 補助科目（FR-006） ----

export function addSubAccount(
  deps: MasterDeps,
  accountId: string,
  rawName: string,
): Result<SubAccount> {
  const name = validName(rawName, "name");
  if (!name.ok) return name;
  return deps.repo.transaction((tx) => {
    if (tx.getAccount(accountId) === undefined) return accountNotFound(accountId);
    if (tx.listSubAccounts(accountId).some((s) => s.name === name.value)) {
      return validation("この科目に同じ名前の補助科目があります", {
        accountId,
        name: name.value,
      });
    }
    const sub: SubAccount = { id: deps.ids.next(), accountId, name: name.value, isActive: true };
    tx.insertSubAccount(sub);
    return ok(sub);
  });
}

// ---- 取引先・メモタグ（FR-007, FR-008） ----

export type PartnerDraft = {
  name: string;
  honorific: Honorific | null;
  memo?: string | null | undefined;
  isActive?: boolean | undefined;
};

/**
 * 取引先を追加・更新する（`MasterRepository` の `transaction` の中、または UnitOfWork の `masters` で呼ぶ）。
 * partnerId を渡すと更新、渡さなければ追加。名前は事業体内で重複しない
 */
export function writePartner(
  tx: MasterRepository,
  ids: IdGenerator,
  draft: PartnerDraft,
  partnerId?: string,
): Result<Partner> {
  const name = validName(draft.name, "name");
  if (!name.ok) return name;
  const memo = draft.memo?.trim() || null;
  const partners = tx.listPartners();
  const current = partnerId === undefined ? undefined : partners.find((p) => p.id === partnerId);
  if (partnerId !== undefined && current === undefined) {
    return validation("取引先が見つかりません", { partnerId });
  }
  if (partners.some((p) => p.id !== partnerId && p.name === name.value)) {
    return validation("同じ名前の取引先があります", { name: name.value });
  }
  const partner: Partner = {
    id: current?.id ?? ids.next(),
    name: name.value,
    honorific: draft.honorific,
    memo,
    isActive: draft.isActive ?? current?.isActive ?? true,
  };
  if (current === undefined) tx.insertPartner(partner);
  else tx.updatePartner(partner);
  return ok(partner);
}

/** partnerId を渡すと更新、渡さなければ追加。名前は事業体内で重複しない */
export function upsertPartner(
  deps: MasterDeps,
  draft: PartnerDraft,
  partnerId?: string,
): Result<Partner> {
  return deps.repo.transaction((tx) => writePartner(tx, deps.ids, draft, partnerId));
}

export function addTag(deps: MasterDeps, rawName: string): Result<Tag> {
  const name = validName(rawName, "name", TAG_NAME_MAX);
  if (!name.ok) return name;
  return deps.repo.transaction((tx) => {
    if (tx.listTags().some((t) => t.name === name.value)) {
      return validation("同じ名前のタグがあります", { name: name.value });
    }
    const tag: Tag = { id: deps.ids.next(), name: name.value };
    tx.insertTag(tag);
    return ok(tag);
  });
}

// ---- 消費税の設定（FR-009） ----

/**
 * 消費税の設定を検証して一括置換し、audit_log に replace（変更前・後の全件）を残す。
 * 監査の target_id は事業体の ID（設定は事業体ごとの1つの集合のため）。
 */
export function replaceTaxSettings(
  deps: MasterDeps,
  drafts: readonly TaxSettingDraft[],
): Result<TaxSetting[]> {
  return deps.repo.transaction((tx) => {
    const profile = tx.getProfile();
    if (profile === undefined) {
      return err(entityNotFoundError());
    }
    const firstPeriod = tx.listFiscalPeriods()[0];
    if (firstPeriod === undefined) {
      return validation("会計期間がありません");
    }
    const validated = validateTaxSettings(drafts, firstPeriod.startDate);
    if (!validated.ok) return validated;
    const settings: TaxSetting[] = validated.value.map((s) => ({
      id: deps.ids.next(),
      effectiveFrom: s.effectiveFrom,
      taxpayerStatus: s.taxpayerStatus,
      accountingMethod: s.accountingMethod,
    }));
    const before = tx.listTaxSettings();
    tx.replaceTaxSettings(settings);
    appendAudit(deps, tx, {
      targetType: "tax_setting",
      targetId: profile.id,
      action: "replace",
      before,
      after: settings,
    });
    return ok(settings);
  });
}

// ---- 会計期間（FR-012） ----

/** 最後の会計期間の翌日から1年の期間（open）を作る */
export function createNextFiscalPeriod(deps: MasterDeps): Result<FiscalPeriod> {
  return deps.repo.transaction((tx) => {
    const last = tx.listFiscalPeriods().at(-1);
    if (last === undefined) {
      return validation("最初の会計期間がありません");
    }
    const startDate = addDays(last.endDate, 1);
    const period: FiscalPeriod = {
      id: deps.ids.next(),
      fiscalYear: yearOfDate(startDate),
      startDate,
      endDate: oneYearEnd(startDate),
      status: "open",
      closedAt: null,
    };
    tx.insertFiscalPeriod(period);
    return ok(period);
  });
}

// ---- 期首残高（FR-011） ----

/**
 * 会計期間の期首残高を検証して一括置換し、audit_log に replace（変更前・後の全件）を残す。
 * 締め済みの期間は PERIOD_CLOSED。
 */
export function replaceOpeningBalances(
  deps: MasterDeps,
  fiscalYear: number,
  rows: readonly OpeningBalanceDraft[],
): Result<OpeningBalance[]> {
  const validated = validateOpeningBalances(rows);
  return deps.repo.transaction((tx) => {
    const period = tx.getFiscalPeriodByYear(fiscalYear);
    if (period === undefined) {
      return err(periodNotFound(fiscalYear));
    }
    if (period.status === "closed") {
      return err(
        domainError("PERIOD_CLOSED", "締め済みの会計期間の期首残高は変更できません", {
          fiscalYear,
        }),
      );
    }
    if (!validated.ok) return validated;

    const subAccounts = tx.listSubAccounts();
    for (const row of validated.value) {
      if (tx.getAccount(row.accountId) === undefined) return accountNotFound(row.accountId);
      if (
        row.subAccountId !== null &&
        !subAccounts.some((s) => s.id === row.subAccountId && s.accountId === row.accountId)
      ) {
        return validation("補助科目がその科目に属していません", {
          accountId: row.accountId,
          subAccountId: row.subAccountId,
        });
      }
    }

    const balances: OpeningBalance[] = validated.value.map((row) => ({
      id: deps.ids.next(),
      fiscalPeriodId: period.id,
      ...row,
    }));
    const before = tx.listOpeningBalances(period.id);
    tx.replaceOpeningBalances(period.id, balances);
    appendAudit(deps, tx, {
      targetType: "opening_balance",
      targetId: period.id,
      action: "replace",
      before,
      after: balances,
    });
    return ok(balances);
  });
}
