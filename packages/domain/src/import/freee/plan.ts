import type {
  ImportDecision,
  ImportDraft,
  ImportDraftLine,
  ImportPlanItem,
  ImportPreview,
  ImportReasonCode,
  ImportWarning,
  ImportWarningCode,
  MappingRow,
} from "@trebuchet/schema";
import { yearOfDate } from "../../dates.ts";
import { checkPeriod, type JournalContext, validateJournal } from "../../journal.ts";
import { computeInclusiveTax, sumYen } from "../../money.ts";
import { resolveTaxRate } from "../../tax-rates.ts";
import { resolveTaxSetting, type TaxSettingDraft } from "../../tax-settings.ts";
import {
  type Account,
  type DomainError,
  type FiscalPeriod,
  findPeriodByDate,
  type Partner,
  type SubAccount,
  type Tag,
  type TaxCategory,
  type TaxCategoryCode,
  type TaxRate,
  type ValidJournal,
} from "../../types.ts";
import type { ImportRef, JournalSignature } from "../types.ts";
import { isPriorYearClosing } from "./closing.ts";
import { proposeMappings, resolveLineAccount, type SavedMappings } from "./mapping.ts";
import {
  type FreeeJournal,
  type FreeeJournalLine,
  normalizeName,
  type RejectedFreeeJournal,
} from "./read.ts";

/** プレビュー・確定の選択（schema の ImportOptions と同じ形） */
export type PlanOptions = {
  fiscalYears?: readonly number[] | undefined;
  include?: readonly string[] | undefined;
  exclude?: readonly string[] | undefined;
};

export type PlanImportInput = {
  journals: readonly FreeeJournal[];
  rejected: readonly RejectedFreeeJournal[];
  savedMappings: SavedMappings;
  accounts: readonly Account[];
  subAccounts: readonly SubAccount[];
  partners: readonly Partner[];
  tags: readonly Tag[];
  periods: readonly FiscalPeriod[];
  taxSettings: readonly TaxSettingDraft[];
  taxRates: readonly TaxRate[];
  taxCategories: readonly TaxCategory[];
  /** 取り消されていない参照（取り消し済みが混ざっていても数えない） */
  activeRefs: readonly ImportRef[];
  /** 手入力の有効な仕訳の要約（POSSIBLE_DUPLICATE, research R16） */
  manualSignatures: readonly JournalSignature[];
  options: PlanOptions;
  /**
   * ファイルの日付の範囲の参照（FREEE_DELETED の検出, research R9）。省略すると削除を検出しない。
   * 取り消し済みが混ざっていても使わない
   */
  rangeRefs?: readonly ImportRef[] | undefined;
  /** 帳簿の仕訳 ID → 仕訳番号（FREEE_CHANGED・FREEE_DELETED の details.journalNo）。ないものは null */
  journalNos?: ReadonlyMap<string, number> | undefined;
};

/** 仕訳ごとの判定。OUT_OF_PERIOD は案内の文（research R19）を message に入れる */
export type PlanItem = ImportPlanItem & { message?: string | undefined };

/** プレビュー（ファイルの情報は呼び出し側が付ける） */
export type PlanPreview = Omit<ImportPreview, "file" | "items"> & { items: PlanItem[] };

/** new と判定した仕訳。draft は仮の ID を含む */
export type PlannedJournal = {
  freee: FreeeJournal;
  draft: ImportDraft;
  valid: ValidJournal;
  /** canonicalSnapshot の値（参照の snapshot_json） */
  snapshot: string;
};

/** new の仕訳が使う、新しく作る補助科目・取引先・タグ（仮の ID つき、初出の順） */
export type PlanCreations = {
  subAccounts: { id: string; accountId: string; name: string }[];
  partners: { id: string; name: string }[];
  tags: { id: string; name: string }[];
};

export type ImportPlan = {
  preview: PlanPreview;
  planned: PlannedJournal[];
  creations: PlanCreations;
};

/** 仮の ID（確定のときに IdGenerator の ID に置き換える） */
export const provisionalId = {
  subAccount: (accountId: string, name: string) => `new:sub:${accountId}:${name}`,
  partner: (name: string) => `new:partner:${name}`,
  tag: (name: string) => `new:tag:${name}`,
};

/**
 * freee の仕訳の内容の正準 JSON（research R9）。キーの順・行の順（freee の仕訳行番号 → 借方・貸方）を固定し、
 * タグは並べ替える。値のないものは null
 */
export function canonicalSnapshot(journal: Pick<FreeeJournal, "date" | "memo" | "lines">): string {
  return JSON.stringify({
    date: journal.date,
    memo: journal.memo ?? null,
    lines: journal.lines.map((l) => ({
      side: l.side,
      account: l.accountName,
      subAccount: l.subAccountName ?? null,
      amount: l.amount,
      tax: l.taxName,
      taxAmount: l.taxAmount,
      partner: l.partnerName ?? null,
      tags: [...l.tagNames].sort(),
      description: l.description,
    })),
  });
}

const lineKeys = (lines: readonly { side: string; accountId: string; amount: number }[]) =>
  lines
    .map((l) => `${l.side}:${l.accountId}:${l.amount}`)
    .sort()
    .join("|");

/** 期間に入る日付はその年度。入らない日付は最初の会計期間の開始の月日から推定する（期間がなければ暦年） */
function fiscalYearOf(date: string, periods: readonly FiscalPeriod[]): number | undefined {
  if (!/^\d{4}/.test(date)) return undefined;
  const period = findPeriodByDate(periods, date);
  if (period !== undefined) return period.fiscalYear;
  const year = yearOfDate(date);
  const first = [...periods].sort((a, b) => a.startDate.localeCompare(b.startDate))[0];
  if (first === undefined) return year;
  return date.slice(5) < first.startDate.slice(5) ? year - 1 : year;
}

function outOfPeriodMessage(date: string, periods: readonly FiscalPeriod[]): string {
  const firstStart = periods.reduce<string | undefined>(
    (min, p) => (min === undefined || p.startDate < min ? p.startDate : min),
    undefined,
  );
  return firstStart !== undefined && date < firstStart
    ? "事業体の開始年度より前の日付です。この仕訳は取り込めません"
    : "会計期間がありません。翌年度を作成してから取り込んでください";
}

/** validateJournal の違反を取込不可の理由にする（複数あれば先のもの） */
const REASON_PRIORITY: readonly ImportReasonCode[] = [
  "INVALID_AMOUNT",
  "UNBALANCED",
  "UNMAPPED",
  "ACCOUNT_INACTIVE",
  "OUT_OF_PERIOD",
  "PERIOD_CLOSED",
  "MISSING_FIELD",
];

function reasonOf(error: DomainError): ImportReasonCode {
  const field = error.details?.field;
  switch (error.code) {
    case "UNBALANCED":
      return "UNBALANCED";
    case "ACCOUNT_NOT_FOUND":
      return "UNMAPPED";
    case "ACCOUNT_INACTIVE":
      return "ACCOUNT_INACTIVE";
    case "OUT_OF_PERIOD":
      return "OUT_OF_PERIOD";
    case "PERIOD_CLOSED":
      return "PERIOD_CLOSED";
    case "VALIDATION":
      if (field === "lines") return "UNBALANCED";
      if (field === "amount") return "INVALID_AMOUNT";
      if (field === "subAccountId") return "ACCOUNT_INACTIVE";
      return "MISSING_FIELD";
    default:
      // TAX_SETTING_GAP・TAX_METHOD_UNSUPPORTED・税率のない税区分など
      return "MISSING_FIELD";
  }
}

function firstReason(errors: readonly DomainError[]): ImportReasonCode {
  const reasons = new Set(errors.map(reasonOf));
  return REASON_PRIORITY.find((r) => reasons.has(r)) ?? "MISSING_FIELD";
}

type Pending = { journal: FreeeJournal; index: number };

type Outcome =
  | { decision: Exclude<ImportDecision, "new">; reason: ImportReasonCode; message?: string }
  | { decision: "new"; planned: PlannedJournal; warnings: ImportWarning[] };

/**
 * 取込の計画（FR-003〜006, FR-013, FR-015, FR-016, INV-13）。純関数で、入力を変えない。
 * 判定の順: 取込済み → 年度の未選択 → 個別の除外 → まとめる段階の取込不可 → 前年分の決算振替 →
 * 会計期間 → 対応表 → 001 の validateJournal。new の仕訳だけに警告を付ける
 */
export function planImport(input: PlanImportInput): ImportPlan {
  const { periods, options } = input;
  const active = new Set(
    input.activeRefs.filter((r) => r.revokedAt === null).map((r) => r.freeeJournalId),
  );
  const selectedYears =
    options.fiscalYears === undefined ? undefined : new Set(options.fiscalYears);
  const include = new Set(options.include ?? []);
  const exclude = new Set(options.exclude ?? []);

  type Entry = {
    freeeJournalId: string;
    freeeJournalNo: string | null;
    date: string;
    fiscalYear: number | undefined;
    outcome?: Outcome;
  };

  const entries: Entry[] = [];
  const pending: Pending[] = [];

  const common = (id: string, date: string) => {
    const fiscalYear = fiscalYearOf(date, periods);
    if (active.has(id)) {
      return { decision: "already", reason: "ALREADY_IMPORTED" } as const;
    }
    if (selectedYears !== undefined && fiscalYear !== undefined && !selectedYears.has(fiscalYear)) {
      return { decision: "excluded", reason: "YEAR_NOT_SELECTED" } as const;
    }
    if (exclude.has(id)) return { decision: "excluded", reason: "USER_EXCLUDED" } as const;
    return undefined;
  };

  for (const r of input.rejected) {
    entries.push({
      freeeJournalId: r.freeeJournalId,
      freeeJournalNo: r.freeeJournalNo,
      date: r.date,
      fiscalYear: fiscalYearOf(r.date, periods),
      outcome: common(r.freeeJournalId, r.date) ?? { decision: "rejected", reason: r.code },
    });
  }

  for (const journal of input.journals) {
    const entry: Entry = {
      freeeJournalId: journal.freeeJournalId,
      freeeJournalNo: journal.freeeJournalNo,
      date: journal.date,
      fiscalYear: fiscalYearOf(journal.date, periods),
    };
    entries.push(entry);
    const early = common(journal.freeeJournalId, journal.date);
    if (early !== undefined) {
      entry.outcome = early;
      continue;
    }
    if (isPriorYearClosing(journal, periods) && !include.has(journal.freeeJournalId)) {
      entry.outcome = { decision: "excluded", reason: "PRIOR_YEAR_CLOSING" };
      continue;
    }
    const period = checkPeriod(journal.date, periods);
    if (!period.ok) {
      entry.outcome =
        period.error.code === "PERIOD_CLOSED"
          ? { decision: "rejected", reason: "PERIOD_CLOSED", message: period.error.message }
          : {
              decision: "rejected",
              reason: "OUT_OF_PERIOD",
              message: outOfPeriodMessage(journal.date, periods),
            };
      continue;
    }
    pending.push({ journal, index: entries.length - 1 });
  }

  // 対応表は判定まで進んだ仕訳の名前だけから作る（既定で対象外の決算振替の「損益」は出さない）
  const mappings = proposeMappings(
    {
      accounts: pending.flatMap((p) => p.journal.lines.map((l) => l.accountName)),
      taxes: pending.flatMap((p) => p.journal.lines.map((l) => l.taxName)),
    },
    input.savedMappings,
    input.accounts,
    input.subAccounts,
    input.taxCategories,
  );
  const accountRows = new Map(mappings.accounts.map((r) => [r.sourceName, r]));
  const taxRows = new Map(mappings.taxes.map((r) => [r.sourceName, r]));

  const builder = new DraftBuilder(input);
  for (const p of pending) {
    const entry = entries[p.index];
    if (entry !== undefined) entry.outcome = judge(p.journal, accountRows, taxRows, builder, input);
  }

  // 日付の順（同じ日付はファイルの順）に並べる
  const ordered = entries
    .map((e, i) => ({ e, i }))
    .sort((a, b) => a.e.date.localeCompare(b.e.date) || a.i - b.i)
    .map(({ e }) => e);

  const items: PlanItem[] = [];
  const planned: PlannedJournal[] = [];
  const otherWarnings: ImportWarning[] = [];
  const exemptWarnings: ImportWarning[] = [];
  for (const e of ordered) {
    const outcome = e.outcome ?? { decision: "rejected", reason: "MISSING_FIELD" };
    const base = {
      freeeJournalId: e.freeeJournalId,
      freeeJournalNo: e.freeeJournalNo,
      date: e.date,
    };
    if (outcome.decision === "new") {
      items.push({
        ...base,
        decision: "new",
        draft: outcome.planned.draft,
        warnings: outcome.warnings.map((w) => w.code),
      });
      planned.push(outcome.planned);
      for (const w of outcome.warnings) {
        (w.code === "TAX_CATEGORY_SUSPICIOUS_EXEMPT" ? exemptWarnings : otherWarnings).push(w);
      }
    } else {
      items.push({
        ...base,
        decision: outcome.decision,
        reason: outcome.reason,
        warnings: [],
        ...(outcome.message === undefined ? {} : { message: outcome.message }),
      });
    }
  }

  const warnings = [...otherWarnings, ...groupExemptWarnings(exemptWarnings)];
  warnings.push(...changesFromRefs(input, ordered, items));

  const counts = { new: 0, already: 0, excluded: 0, rejected: 0 };
  const byYear = new Map<number, typeof counts>();
  ordered.forEach((e, i) => {
    const decision = items[i]?.decision ?? "rejected";
    counts[decision] += 1;
    if (e.fiscalYear === undefined) return;
    const y = byYear.get(e.fiscalYear) ?? { new: 0, already: 0, excluded: 0, rejected: 0 };
    y[decision] += 1;
    byYear.set(e.fiscalYear, y);
  });
  const years = [...byYear.entries()]
    .sort(([a], [b]) => a - b)
    .map(([fiscalYear, c]) => {
      const period = periods.find((p) => p.fiscalYear === fiscalYear);
      return {
        fiscalYear,
        hasPeriod: period !== undefined,
        closed: period?.status === "closed",
        counts: c,
      };
    });

  const newLines = planned.flatMap((p) => p.draft.lines);
  const sideTotal = (side: string) =>
    sumYen(newLines.filter((l) => l.side === side).map((l) => l.amount));
  const creations = builder.creationsFor(planned);
  const hasUnmapped = [...mappings.accounts, ...mappings.taxes].some(
    (r) => r.status === "unmapped",
  );

  return {
    preview: {
      years,
      counts: { ...counts, warnings: warnings.length },
      totals: { debit: sideTotal("debit"), credit: sideTotal("credit") },
      items,
      mappings,
      toCreate: {
        subAccounts: creations.subAccounts.map(({ accountId, name }) => ({ accountId, name })),
        partners: creations.partners.map((p) => p.name),
        tags: creations.tags.map((t) => t.name),
      },
      warnings,
      ready: !hasUnmapped && counts.new > 0,
    },
    planned,
    creations,
  };
}

/** 免税の期間の仕訳ごとの警告を、件数と freee の仕訳 ID の一覧を持つ1件にまとめる。0 件なら出さない */
function groupExemptWarnings(exempt: readonly ImportWarning[]): ImportWarning[] {
  if (exempt.length === 0) return [];
  const freeeJournalIds = exempt.flatMap((w) =>
    w.freeeJournalId === undefined ? [] : [w.freeeJournalId],
  );
  const count = freeeJournalIds.length;
  return [
    {
      code: "TAX_CATEGORY_SUSPICIOUS_EXEMPT",
      message: `免税の期間のため税区分の警告を ${count} 件まとめました`,
      details: { count, freeeJournalIds },
    },
  ];
}

/**
 * 取込済みの仕訳の変更（FREEE_CHANGED）と、ファイルから消えた仕訳（FREEE_DELETED）を検出する（FR-028〜030, research R9）。
 * 変更は already の仕訳の正準 JSON と参照の snapshot_json の違い。削除は、選んだ年度の仕訳の日付の最小〜最大にある
 * 取り消されていない参照のうち、ファイル（取込不可を含む）にないもの。帳簿は変えず、警告だけを返す。
 * FREEE_CHANGED は items の warnings にも付ける
 */
function changesFromRefs(
  input: PlanImportInput,
  ordered: readonly { freeeJournalId: string; fiscalYear: number | undefined }[],
  items: PlanItem[],
): ImportWarning[] {
  const selectedYears =
    input.options.fiscalYears === undefined ? undefined : new Set(input.options.fiscalYears);
  const selected = (fiscalYear: number | undefined) =>
    selectedYears === undefined || fiscalYear === undefined || selectedYears.has(fiscalYear);
  const journalNoOf = (journalId: string) => input.journalNos?.get(journalId) ?? null;
  const label = (no: string | null) => (no === null ? "" : `（仕訳番号 ${no}）`);
  const bookLabel = (journalId: string) => {
    const no = journalNoOf(journalId);
    return no === null ? "帳簿の仕訳" : `帳簿の仕訳 No.${no}`;
  };

  const activeRefs = new Map(
    input.activeRefs.filter((r) => r.revokedAt === null).map((r) => [r.freeeJournalId, r]),
  );
  const journals = new Map(input.journals.map((j) => [j.freeeJournalId, j]));
  const warnings: ImportWarning[] = [];
  ordered.forEach((e, i) => {
    const item = items[i];
    const ref = activeRefs.get(e.freeeJournalId);
    const journal = journals.get(e.freeeJournalId);
    if (item?.decision !== "already" || ref === undefined || journal === undefined) return;
    if (!selected(e.fiscalYear)) return;
    const after = canonicalSnapshot(journal);
    if (after === ref.snapshotJson) return;
    item.warnings = [...item.warnings, "FREEE_CHANGED"];
    warnings.push({
      code: "FREEE_CHANGED",
      message: `freee の仕訳${label(journal.freeeJournalNo)}は、取り込んだ後に freee で変更されています。${bookLabel(ref.journalId)}を確認してください`,
      freeeJournalId: e.freeeJournalId,
      details: {
        journalId: ref.journalId,
        journalNo: journalNoOf(ref.journalId),
        before: ref.snapshotJson,
        after,
      },
    });
  });

  if (input.rangeRefs === undefined) return warnings;
  const dates = input.journals
    .filter((j) => selected(fiscalYearOf(j.date, input.periods)))
    .map((j) => j.date)
    .sort();
  const from = dates[0];
  const to = dates[dates.length - 1];
  if (from === undefined || to === undefined) return warnings;
  const inFile = new Set(
    [...input.journals, ...input.rejected].map((j) => j.freeeJournalId as string),
  );
  const deleted = input.rangeRefs
    .filter(
      (r) =>
        r.revokedAt === null &&
        r.freeeDate >= from &&
        r.freeeDate <= to &&
        selected(fiscalYearOf(r.freeeDate, input.periods)) &&
        !inFile.has(r.freeeJournalId),
    )
    .sort(
      (a, b) =>
        a.freeeDate.localeCompare(b.freeeDate) || a.freeeJournalId.localeCompare(b.freeeJournalId),
    );
  for (const r of deleted) {
    warnings.push({
      code: "FREEE_DELETED",
      message: `取り込んだ freee の仕訳${label(r.freeeJournalNo)}が、ファイルにありません。freee で削除した場合は、${bookLabel(r.journalId)}を確認してください`,
      freeeJournalId: r.freeeJournalId,
      details: {
        journalId: r.journalId,
        journalNo: journalNoOf(r.journalId),
        freeeJournalNo: r.freeeJournalNo,
        before: r.snapshotJson,
      },
    });
  }
  return warnings;
}

/** 帳簿の ID（既存）または仮の ID（新規）を引き、新規のものを覚えておく */
class DraftBuilder {
  private readonly input: PlanImportInput;
  private readonly newSubAccounts = new Map<
    string,
    { id: string; accountId: string; name: string }
  >();
  private readonly newPartners = new Map<string, { id: string; name: string }>();
  private readonly newTags = new Map<string, { id: string; name: string }>();

  constructor(input: PlanImportInput) {
    this.input = input;
  }

  subAccount(accountId: string, name: string): string {
    const id = provisionalId.subAccount(accountId, name);
    if (!this.newSubAccounts.has(id)) this.newSubAccounts.set(id, { id, accountId, name });
    return id;
  }

  partner(name: string): string {
    const existing = this.input.partners.find((p) => normalizeName(p.name) === name);
    if (existing !== undefined) return existing.id;
    const id = provisionalId.partner(name);
    if (!this.newPartners.has(id)) this.newPartners.set(id, { id, name });
    return id;
  }

  tag(name: string): string {
    const existing = this.input.tags.find((t) => normalizeName(t.name) === name);
    if (existing !== undefined) return existing.id;
    const id = provisionalId.tag(name);
    if (!this.newTags.has(id)) this.newTags.set(id, { id, name });
    return id;
  }

  /** 検証のための文脈（既存のマスタ＋これまでに出てきた仮の ID） */
  context(): JournalContext {
    const i = this.input;
    return {
      accounts: i.accounts,
      subAccounts: [
        ...i.subAccounts,
        ...[...this.newSubAccounts.values()].map((s) => ({ ...s, isActive: true })),
      ],
      partners: [...i.partners, ...this.newPartners.values()],
      tags: [...i.tags, ...this.newTags.values()],
      periods: i.periods,
      taxSettings: i.taxSettings,
      taxRates: i.taxRates,
    };
  }

  /** new の仕訳が使う仮の ID だけを、初出の順に返す */
  creationsFor(planned: readonly PlannedJournal[]): PlanCreations {
    const out: PlanCreations = { subAccounts: [], partners: [], tags: [] };
    const seen = new Set<string>();
    const take = <T>(id: string | undefined, from: ReadonlyMap<string, T>, to: T[]) => {
      if (id === undefined || seen.has(id)) return;
      const value = from.get(id);
      if (value === undefined) return;
      seen.add(id);
      to.push(value);
    };
    for (const p of planned) {
      for (const l of p.draft.lines) {
        take(l.subAccountId, this.newSubAccounts, out.subAccounts);
        take(l.partnerId, this.newPartners, out.partners);
        for (const t of l.tagIds ?? []) take(t, this.newTags, out.tags);
      }
    }
    return out;
  }
}

function judge(
  journal: FreeeJournal,
  accountRows: ReadonlyMap<string, MappingRow>,
  taxRows: ReadonlyMap<string, MappingRow>,
  builder: DraftBuilder,
  input: PlanImportInput,
): Outcome {
  type Resolved = {
    line: FreeeJournalLine;
    accountId: string;
    subAccountId?: string | undefined;
    subAccountName?: string | undefined;
    taxCategory: TaxCategoryCode;
  };
  const resolved: Resolved[] = [];
  for (const line of journal.lines) {
    const row = accountRows.get(line.accountName);
    const target =
      row === undefined
        ? undefined
        : resolveLineAccount(row, line.accountName, line.subAccountName, input.subAccounts);
    const taxCategory = taxRows.get(line.taxName)?.taxCategory;
    if (target === undefined || taxCategory === undefined) {
      return { decision: "rejected", reason: "UNMAPPED" };
    }
    resolved.push({ line, ...target, taxCategory });
  }

  const accounts = new Map(input.accounts.map((a) => [a.id, a]));
  const subAccounts = new Map(input.subAccounts.map((s) => [s.id, s]));
  const inactive = resolved.some(
    (r) =>
      accounts.get(r.accountId)?.isActive === false ||
      (r.subAccountId !== undefined && subAccounts.get(r.subAccountId)?.isActive === false),
  );
  if (inactive) return { decision: "rejected", reason: "ACCOUNT_INACTIVE" };

  const lines: ImportDraftLine[] = resolved.map((r) => {
    const subAccountId =
      r.subAccountId ??
      (r.subAccountName === undefined
        ? undefined
        : builder.subAccount(r.accountId, r.subAccountName));
    const partnerId =
      r.line.partnerName === undefined ? undefined : builder.partner(r.line.partnerName);
    const tagIds = r.line.tagNames.map((t) => builder.tag(t));
    return {
      side: r.line.side,
      accountId: r.accountId,
      ...(subAccountId === undefined ? {} : { subAccountId }),
      amount: r.line.amount,
      taxCategory: r.taxCategory,
      ...(partnerId === undefined ? {} : { partnerId }),
      ...(r.line.description.trim() === "" ? {} : { description: r.line.description }),
      ...(tagIds.length === 0 ? {} : { tagIds }),
    };
  });
  const memo = journal.memo;
  const draftBase = { date: journal.date, ...(memo === undefined ? {} : { memo }), lines };

  const validated = validateJournal(draftBase, builder.context());
  if (!validated.ok) return { decision: "rejected", reason: firstReason(validated.error) };
  const valid = validated.value;

  const draft: ImportDraft = {
    ...draftBase,
    lines: lines.map((l, i) => ({ ...l, taxAmount: valid.lines[i]?.taxAmount ?? 0 })),
  };
  return {
    decision: "new",
    planned: { freee: journal, draft, valid, snapshot: canonicalSnapshot(journal) },
    warnings: warningsOf(journal, resolved, valid, input),
  };
}

function warningsOf(
  journal: FreeeJournal,
  resolved: readonly { line: FreeeJournalLine; accountId: string; taxCategory: TaxCategoryCode }[],
  valid: ValidJournal,
  input: PlanImportInput,
): ImportWarning[] {
  const id = journal.freeeJournalId;
  const warnings: ImportWarning[] = [];
  const add = (code: ImportWarningCode, message: string, details?: Record<string, unknown>) =>
    warnings.push({
      code,
      message,
      freeeJournalId: id,
      ...(details === undefined ? {} : { details }),
    });

  // 免税の期間でも、freee の税金額は税率どおりかを比べる（保存する税額は validateJournal の値）
  const mismatch = resolved.find((r) => {
    const rate = resolveTaxRate(r.taxCategory, journal.date, input.taxRates);
    const expected = rate === undefined ? 0 : computeInclusiveTax(r.line.amount, rate);
    return expected !== r.line.taxAmount;
  });
  if (mismatch !== undefined) {
    add("TAX_AMOUNT_MISMATCH", "freee の税金額が、帳簿の規則で計算した税額と違います", {
      account: mismatch.line.accountName,
      freeeTaxAmount: mismatch.line.taxAmount,
    });
  }

  const kinds = new Map(input.taxCategories.map((c) => [c.code, c.kind]));
  const accounts = new Map(input.accounts.map((a) => [a.id, a]));
  const suspicious = resolved.find((r) => {
    const category = accounts.get(r.accountId)?.category;
    const kind = kinds.get(r.taxCategory);
    return (
      (category === "expense" && kind === "sales") ||
      (category === "revenue" && kind === "purchase")
    );
  });
  if (suspicious !== undefined) {
    // 免税の期間は税区分が帳簿の金額に影響しないので、planImport が1件にまとめる（003 R11, FR-037）
    const exempt = resolveTaxSetting(journal.date, input.taxSettings)?.taxpayerStatus === "exempt";
    add(
      exempt ? "TAX_CATEGORY_SUSPICIOUS_EXEMPT" : "TAX_CATEGORY_SUSPICIOUS",
      "科目の区分と税区分の組み合わせを確認してください",
      { account: suspicious.line.accountName, tax: suspicious.line.taxName },
    );
  }

  const keys = lineKeys(valid.lines);
  const duplicate = input.manualSignatures.find(
    (s) => s.date === valid.date && lineKeys(s.lines) === keys,
  );
  if (duplicate !== undefined) {
    add(
      "POSSIBLE_DUPLICATE",
      `手入力の仕訳（No.${duplicate.journalNo}）と日付・科目・金額が同じです。二重登録でないか確認してください`,
      { journalId: duplicate.journalId, journalNo: duplicate.journalNo },
    );
  }
  return warnings;
}
