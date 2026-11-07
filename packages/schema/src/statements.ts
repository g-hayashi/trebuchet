import { z } from "zod";
import { JournalInput } from "./journals.ts";
import { DateString, Id, TaxCategoryCode } from "./primitives.ts";

// 006-mfme-ai-journal（contracts/http-api.md §2〜§6、data-model §1）

const Timestamp = z.string().min(1);
const Count = z.number().int().nonnegative();
/** 確信度・しきい値（0〜100 の整数） */
const Percent = z.number().int().min(0).max(100);
/** 明細の金額（符号つき。入金が正、出金が負） */
const SignedYen = z.number().int();
const Sha256 = z.string().regex(/^[0-9a-f]{64}$/, "SHA-256 の形式が正しくありません");

// ---- 取込元の口座（§2） ----

export const STATEMENT_ACCOUNT_USAGES = ["business", "mixed", "private"] as const;
export const StatementAccountUsage = z.enum(STATEMENT_ACCOUNT_USAGES);
export type StatementAccountUsage = z.infer<typeof StatementAccountUsage>;

export const STATEMENT_ACCOUNT_KINDS = ["bank", "card", "cash", "other"] as const;
export const StatementAccountKind = z.enum(STATEMENT_ACCOUNT_KINDS);
export type StatementAccountKind = z.infer<typeof StatementAccountKind>;

/** `private` は科目を持たない（帳簿の外の口座）。ほかは科目が必須（data-model §1.1） */
const accountIdMatchesUsage = (v: { usage: StatementAccountUsage; accountId?: unknown }) =>
  v.usage === "private" ? v.accountId == null : v.accountId != null;
const accountIdMessage = {
  message: "private の口座は科目を持たず、それ以外は科目が必須です",
  path: ["accountId"],
};

/** PUT /statement-accounts/:name */
export const StatementAccountInput = z
  .object({
    usage: StatementAccountUsage,
    kind: StatementAccountKind,
    accountId: Id.optional(),
    subAccountId: Id.optional(),
  })
  .refine(accountIdMatchesUsage, accountIdMessage)
  .refine((v) => v.usage !== "private" || v.subAccountId == null, {
    message: "private の口座は補助科目を持ちません",
    path: ["subAccountId"],
  });
export type StatementAccountInput = z.infer<typeof StatementAccountInput>;

export const StatementAccount = z
  .object({
    id: Id,
    name: z.string().min(1),
    usage: StatementAccountUsage,
    kind: StatementAccountKind,
    accountId: Id.nullable(),
    subAccountId: Id.nullable(),
    createdAt: Timestamp,
    updatedAt: Timestamp,
  })
  .refine(accountIdMatchesUsage, accountIdMessage);
export type StatementAccount = z.infer<typeof StatementAccount>;

export const StatementAccountSaved = z.object({
  account: StatementAccount,
  /** 作り直した未処理の候補の件数 */
  rebuilt: Count,
});
export type StatementAccountSaved = z.infer<typeof StatementAccountSaved>;

// ---- 取込（§3） ----

export const STATEMENT_ORIGINS = ["paste", "file"] as const;
export const StatementOrigin = z.enum(STATEMENT_ORIGINS);
export type StatementOrigin = z.infer<typeof StatementOrigin>;

// ---- 列の対応と取込元（007 data-model §3） ----

export const STATEMENT_COLUMN_ROLES = [
  "date",
  "content",
  "amount",
  "outflow",
  "inflow",
  "accountName",
  "categoryMajor",
  "categoryMinor",
  "memo",
  "externalId",
  "transferFlag",
] as const;
export const StatementColumnRole = z.enum(STATEMENT_COLUMN_ROLES);
export type StatementColumnRole = z.infer<typeof StatementColumnRole>;

export const STATEMENT_DELIMITERS = ["\t", ",", ";"] as const;
export const StatementDelimiter = z.enum(STATEMENT_DELIMITERS);
export type StatementDelimiter = z.infer<typeof StatementDelimiter>;

export const STATEMENT_AMOUNT_SIGNS = ["inflow_positive", "outflow_positive"] as const;
export const StatementAmountSign = z.enum(STATEMENT_AMOUNT_SIGNS);
export type StatementAmountSign = z.infer<typeof StatementAmountSign>;

export const STATEMENT_ENCODINGS = ["utf-8", "shift_jis"] as const;
export const StatementEncoding = z.enum(STATEMENT_ENCODINGS);
export type StatementEncoding = z.infer<typeof StatementEncoding>;

/** 列の番号の上限（0〜49。007/R12） */
export const MAX_STATEMENT_COLUMN_INDEX = 49;
const ColumnIndex = z.number().int().min(0).max(MAX_STATEMENT_COLUMN_INDEX);
/** 元のテキストの行の番号（0 起点）。null は見出しなし */
const HeaderRow = z.number().int().min(0).nullable();

/** 役割ごとの列の番号（辞書の案・保存した対応の写しなど） */
export const StatementColumnIndexes = z.partialRecord(StatementColumnRole, ColumnIndex);
export type StatementColumnIndexes = z.infer<typeof StatementColumnIndexes>;

export const StatementColumnMapping = z
  .object({
    delimiter: StatementDelimiter,
    headerRow: HeaderRow,
    columns: StatementColumnIndexes,
    amountSign: StatementAmountSign.optional(),
  })
  .superRefine((v, ctx) => {
    const c = v.columns;
    for (const role of ["date", "content"] as const) {
      if (c[role] === undefined) {
        ctx.addIssue({ code: "custom", path: ["columns", role], message: `${role} は必須です` });
      }
    }
    const hasAmount = c.amount !== undefined;
    const hasOutflow = c.outflow !== undefined;
    const hasInflow = c.inflow !== undefined;
    const single = hasAmount && !hasOutflow && !hasInflow;
    const split = !hasAmount && hasOutflow && hasInflow;
    if (!single && !split) {
      ctx.addIssue({
        code: "custom",
        path: ["columns"],
        message: "amount か、outflow と inflow の両方の、どちらか一方だけを指定してください",
      });
    }
    if (hasAmount && v.amountSign === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["amountSign"],
        message: "amount があるときは amountSign が必須です",
      });
    }
    const used = new Map<number, string>();
    for (const [role, index] of Object.entries(c)) {
      const other = used.get(index);
      if (other !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["columns", role],
          message: `列 ${index} を ${other} と ${role} の 2 つの役割に使えません`,
        });
      } else {
        used.set(index, role);
      }
    }
  });
export type StatementColumnMapping = z.infer<typeof StatementColumnMapping>;

/** 取込元（列の対応の保存）。007 data-model §3 */
export const StatementSource = z.object({
  id: Id,
  name: z.string().min(1).max(100),
  fixedAccountName: z.string().nullable(),
  mapping: StatementColumnMapping,
  header: z.array(z.string()).nullable(),
  lastUsedAt: Timestamp,
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type StatementSource = z.infer<typeof StatementSource>;

/** PATCH /statement-sources/:id（名前の変更。前後の空白は domain が除く） */
export const StatementSourceRenameInput = z.object({ name: z.string().min(1).max(100) });
export type StatementSourceRenameInput = z.infer<typeof StatementSourceRenameInput>;

/** POST /statements/imports/layout の応答 */
export const StatementTableLayout = z.object({
  encoding: StatementEncoding,
  delimiter: StatementDelimiter,
  headerRow: HeaderRow,
  header: z.array(z.string()).nullable(),
  columnCount: Count,
  rowCount: Count,
  sampleRows: z.array(z.array(z.string())).max(10),
  needsYear: z.boolean(),
  suggestedColumns: StatementColumnIndexes,
  /** 金額の列の見出しから決まる符号の案（カードの「ご利用額」など。決まらなければ省く。007/R16） */
  suggestedAmountSign: StatementAmountSign.optional(),
  match: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("none") }),
    z.object({ kind: z.literal("one"), source: StatementSource }),
    z.object({ kind: z.literal("many"), sources: z.array(StatementSource) }),
  ]),
  headerDiff: z.object({ added: z.array(z.string()), removed: z.array(z.string()) }).optional(),
});
export type StatementTableLayout = z.infer<typeof StatementTableLayout>;

/** 口座の推定（preview の未対応の口座に添える。007/R9） */
export const StatementAccountSuggestion = z.object({
  kind: StatementAccountKind,
  accountId: Id,
  subAccountId: Id.nullable(),
  usage: StatementAccountUsage.nullable(),
  cues: z.array(z.string()),
});
export type StatementAccountSuggestion = z.infer<typeof StatementAccountSuggestion>;

// ---- 取込の options（multipart の `options` の JSON。contracts §2.1〜§2.3・§4.1） ----

/** POST /statements/imports/layout */
export const StatementLayoutOptions = z.object({
  origin: StatementOrigin,
  sourceId: Id.optional(),
  encoding: StatementEncoding.optional(),
  delimiter: StatementDelimiter.optional(),
  headerRow: HeaderRow.optional(),
});
export type StatementLayoutOptions = z.infer<typeof StatementLayoutOptions>;

/** POST /statements/imports/column-suggestion */
export const StatementColumnSuggestionOptions = z.object({
  origin: StatementOrigin,
  encoding: StatementEncoding.optional(),
  delimiter: StatementDelimiter.optional(),
  headerRow: HeaderRow.optional(),
});
export type StatementColumnSuggestionOptions = z.infer<typeof StatementColumnSuggestionOptions>;

export const STATEMENT_COLUMN_UNAVAILABLE = [
  "disabled",
  "unavailable",
  "timeout",
  "invalid",
] as const;

/** POST /statements/imports/column-suggestion の応答（contracts §4.1）。`unavailable` は AI の案がないときだけ付く。案と一緒に付くときは、AI を使えず列の中身から推定しただけの案（confidence は 0。007/R16） */
export const StatementColumnSuggestionResponse = z.object({
  suggestion: z
    .object({
      columns: StatementColumnIndexes,
      amountSign: StatementAmountSign.nullable(),
      confidence: z.number().int().min(0).max(100),
    })
    .nullable(),
  unavailable: z.enum(STATEMENT_COLUMN_UNAVAILABLE).optional(),
});
export type StatementColumnSuggestionResponse = z.infer<typeof StatementColumnSuggestionResponse>;

/** POST /statements/imports/preview。`fixedAccountName` は mapping が accountName を持たないとき必須（INV-50。domain で検査） */
export const StatementPreviewOptions = z.object({
  origin: StatementOrigin,
  /** 年のない日付にだけ使う */
  year: z.number().int().min(1900).max(9999),
  mapping: StatementColumnMapping,
  fixedAccountName: z.string().min(1).optional(),
  sourceId: Id.optional(),
  encoding: StatementEncoding.optional(),
});
export type StatementPreviewOptions = z.infer<typeof StatementPreviewOptions>;

/** POST /statements/imports */
export const StatementCommitOptions = StatementPreviewOptions.extend({
  expected: z.object({ inputSha256: Sha256, countNew: Count }),
  /** 未対応の口座の対応（既に対応のある口座は入れない） */
  accounts: z.array(z.object({ name: z.string().min(1), input: StatementAccountInput })),
  /** 取込元を保存・更新する。null は保存しない */
  saveSource: z.object({ id: Id.optional(), name: z.string().min(1).max(100) }).nullable(),
});
export type StatementCommitOptions = z.infer<typeof StatementCommitOptions>;

export const STATEMENT_ROW_STATUSES = ["new", "existing", "changed"] as const;
export const StatementRowStatus = z.enum(STATEMENT_ROW_STATUSES);
export type StatementRowStatus = z.infer<typeof StatementRowStatus>;

/** 変更あり（`external_id` が同じで内容が違う）の変更前後。内容の項目をそのまま持つ */
export const StatementChange = z.object({
  before: z.record(z.string(), z.unknown()),
  after: z.record(z.string(), z.unknown()),
});
export type StatementChange = z.infer<typeof StatementChange>;

export const StatementImportRow = z.object({
  key: z.string().min(1),
  date: DateString,
  amount: SignedYen,
  content: z.string(),
  accountName: z.string().min(1),
  status: StatementRowStatus,
  changed: StatementChange.optional(),
  warnings: z.array(z.literal("POSSIBLE_DUPLICATE")),
});
export type StatementImportRow = z.infer<typeof StatementImportRow>;

export const StatementUnreadableRow = z.object({
  line: z.number().int().min(1),
  reason: z.string(),
});
export type StatementUnreadableRow = z.infer<typeof StatementUnreadableRow>;

export const StatementImportPreview = z.object({
  inputSha256: Sha256,
  period: z.object({ from: DateString, to: DateString }),
  totals: z.object({ inflow: Count, outflow: Count }),
  rows: z.array(StatementImportRow),
  unreadable: z.array(StatementUnreadableRow),
  unmappedAccounts: z.array(
    z.object({ name: z.string().min(1), suggestion: StatementAccountSuggestion.nullable() }),
  ),
  countNew: Count,
});
export type StatementImportPreview = z.infer<typeof StatementImportPreview>;

export const StatementBatch = z.object({
  id: Id,
  origin: StatementOrigin,
  /** 取込のときに使った取込元の名前（保存しなかったときは null） */
  sourceName: z.string().nullable(),
  inputSha256: Sha256,
  periodFrom: DateString,
  periodTo: DateString,
  countNew: Count,
  countExisting: Count,
  countUnreadable: Count,
  createdAt: Timestamp,
});
export type StatementBatch = z.infer<typeof StatementBatch>;

export const StatementImportCommitted = z.object({
  batch: StatementBatch,
  added: Count,
  changed: Count,
  /** 保存・更新した取込元。保存しなかった取込は null（007 contracts §2.3） */
  source: StatementSource.nullable(),
});
export type StatementImportCommitted = z.infer<typeof StatementImportCommitted>;

// ---- 明細と候補（§4） ----

export const STATEMENT_STATUSES = ["unprocessed", "registered", "excluded"] as const;
export const StatementStatus = z.enum(STATEMENT_STATUSES);
export type StatementStatus = z.infer<typeof StatementStatus>;

/** GET /statements の status の絞り込み（`changed` は並ぶ印の絞り込み） */
export const StatementStatusFilter = z.enum([...STATEMENT_STATUSES, "changed"]);
export type StatementStatusFilter = z.infer<typeof StatementStatusFilter>;

export const CANDIDATE_METHODS = [
  "match",
  "transfer",
  "rule",
  "local_ai",
  "external_ai",
  "none",
] as const;
export const CandidateMethod = z.enum(CANDIDATE_METHODS);
export type CandidateMethod = z.infer<typeof CandidateMethod>;

export const PURPOSES = ["business", "private"] as const;
export const Purpose = z.enum(PURPOSES);
export type Purpose = z.infer<typeof Purpose>;

export const Candidate = z.object({
  method: CandidateMethod,
  /** `none` のとき null */
  purpose: Purpose.nullable(),
  /** `none` のとき null */
  confidence: Percent.nullable(),
  reason: z.string(),
  /** 仕訳の案（`match`・`none` は null） */
  draft: JournalInput.nullable(),
  match: z.object({ journalId: Id, lineId: Id }).optional(),
  model: z.string().optional(),
});
export type Candidate = z.infer<typeof Candidate>;

export const STATEMENT_LINK_KINDS = ["created", "matched"] as const;
export const StatementLinkKind = z.enum(STATEMENT_LINK_KINDS);
export type StatementLinkKind = z.infer<typeof StatementLinkKind>;

export const StatementView = z.object({
  id: Id,
  date: DateString,
  amount: SignedYen,
  content: z.string(),
  accountName: z.string(),
  usage: StatementAccountUsage,
  status: StatementStatus,
  changed: StatementChange.nullable(),
  candidate: Candidate.nullable(),
  links: z.array(z.object({ journalId: Id, kind: StatementLinkKind })),
  duplicateOf: z.array(Id).optional(),
});
export type StatementView = z.infer<typeof StatementView>;

/** GET /statements のクエリ */
export const StatementListQuery = z.object({
  status: StatementStatusFilter.optional(),
  accountId: Id.optional(),
  from: DateString.optional(),
  to: DateString.optional(),
});
export type StatementListQuery = z.infer<typeof StatementListQuery>;

/** POST /statements/candidates */
export const BuildCandidatesInput = z.object({ statementIds: z.array(Id).optional() });
export type BuildCandidatesInput = z.infer<typeof BuildCandidatesInput>;

export const MAX_INFER_BATCH = 10;

/** POST /statements/infer（10 件まで） */
export const InferInput = z.object({
  statementIds: z.array(Id).min(1).max(MAX_INFER_BATCH),
});
export type InferInput = z.infer<typeof InferInput>;

/** POST /statements/:statementId/approve（省略で候補のまま。承認のたびにルールを学ぶ） */
export const ApproveInput = z.object({
  draft: JournalInput.optional(),
  purpose: Purpose.optional(),
  match: z.object({ journalId: Id, lineId: Id }).optional(),
  partnerId: Id.optional(),
});
export type ApproveInput = z.infer<typeof ApproveInput>;

/** 一覧で選んだ行を一度に承認・除外する件数の上限（007/R17） */
export const MAX_BULK_SELECTION = 500;

/**
 * POST /statements/approve-bulk（007/R17）。利用者が一覧で選んだ行だけを承認する（しきい値で拒まない）。
 * 各 item は `ApproveInput` と同じ規則: `draft` があればその案、`match` があれば既存の仕訳に結びつけ、
 * どちらもなければ候補のまま
 */
export const ApproveBulkInput = z.object({
  items: z
    .array(
      z.object({
        statementId: Id,
        draft: JournalInput.optional(),
        match: z.object({ journalId: Id, lineId: Id }).optional(),
      }),
    )
    .max(MAX_BULK_SELECTION),
});
export type ApproveBulkInput = z.infer<typeof ApproveBulkInput>;

/** POST /statements/:statementId/exclude（理由は任意） */
export const ExcludeInput = z.object({ reason: z.string().max(500).optional() });
export type ExcludeInput = z.infer<typeof ExcludeInput>;

/** POST /statements/exclude-bulk（007/R17。理由は任意で、選んだ全部に同じものを残す） */
export const ExcludeBulkInput = z.object({
  statementIds: z.array(Id).max(MAX_BULK_SELECTION),
  reason: z.string().max(500).optional(),
});
export type ExcludeBulkInput = z.infer<typeof ExcludeBulkInput>;

/** unexclude・unlink の理由。空・空白のみの判定はドメインで行う（`REASON_REQUIRED`） */
export const StatementReasonInput = z.object({ reason: z.string() });
export type StatementReasonInput = z.infer<typeof StatementReasonInput>;

// ---- ルール（§5） ----

export const RULE_STATUSES = ["active", "paused"] as const;
export const RuleStatus = z.enum(RULE_STATUSES);
export type RuleStatus = z.infer<typeof RuleStatus>;

export const RULE_ORIGINS = ["approval", "seed"] as const;
export const RuleOrigin = z.enum(RULE_ORIGINS);
export type RuleOrigin = z.infer<typeof RuleOrigin>;

/** ルールの管理の主体。`user` は利用者が直した・止めたルール。承認・初期作成の自動の作成・更新は変えない（011 R9・INV-71） */
export const RULE_MANAGED_BY = ["auto", "user"] as const;
export const RuleManagedBy = z.enum(RULE_MANAGED_BY);
export type RuleManagedBy = z.infer<typeof RuleManagedBy>;

export const InferenceRuleView = z.object({
  id: Id,
  normalizedContent: z.string(),
  statementAccountId: Id.nullable(),
  counterAccountId: Id,
  counterSubAccountId: Id.nullable(),
  partnerId: Id.nullable(),
  taxCategory: TaxCategoryCode,
  purpose: Purpose,
  descriptionTemplate: z.string().nullable(),
  hits: Count,
  overrides: Count,
  confidence: Percent,
  status: RuleStatus,
  origin: RuleOrigin,
  managedBy: RuleManagedBy,
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type InferenceRuleView = z.infer<typeof InferenceRuleView>;

export const InferenceRuleListQuery = z.object({ status: RuleStatus.optional() });
export type InferenceRuleListQuery = z.infer<typeof InferenceRuleListQuery>;

/** POST /inference-rules/seed */
export const SeedRulesInput = z.object({ dryRun: z.boolean().optional() });
export type SeedRulesInput = z.infer<typeof SeedRulesInput>;

/** PATCH /inference-rules/:ruleId */
export const InferenceRuleUpdateInput = z.object({
  counterAccountId: Id.optional(),
  counterSubAccountId: Id.nullable().optional(),
  taxCategory: TaxCategoryCode.optional(),
  partnerId: Id.nullable().optional(),
  purpose: Purpose.optional(),
  descriptionTemplate: z.string().max(500).nullable().optional(),
});
export type InferenceRuleUpdateInput = z.infer<typeof InferenceRuleUpdateInput>;

export const RULE_HISTORY_ACTIONS = ["create", "update", "pause", "resume", "edit"] as const;
export const RuleHistoryAction = z.enum(RULE_HISTORY_ACTIONS);
export type RuleHistoryAction = z.infer<typeof RuleHistoryAction>;

export const InferenceRuleHistoryEntry = z.object({
  id: Id,
  ruleId: Id,
  action: RuleHistoryAction,
  before: z.unknown().nullable(),
  after: z.unknown().nullable(),
  statementId: Id.nullable(),
  at: Timestamp,
});
export type InferenceRuleHistoryEntry = z.infer<typeof InferenceRuleHistoryEntry>;

/** PUT /statement-settings */
export const StatementSettingsInput = z.object({
  bulkThreshold: Percent,
  externalThreshold: Percent,
});
export type StatementSettingsInput = z.infer<typeof StatementSettingsInput>;

export const StatementSettings = StatementSettingsInput.extend({ updatedAt: Timestamp });
export type StatementSettings = z.infer<typeof StatementSettings>;
