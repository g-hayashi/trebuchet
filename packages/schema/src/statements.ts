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

export const STATEMENT_ORIGINS = ["paste", "mfme_fetch"] as const;
export const StatementOrigin = z.enum(STATEMENT_ORIGINS);
export type StatementOrigin = z.infer<typeof StatementOrigin>;

export const StatementImportSource = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("paste"),
    text: z.string().min(1),
    year: z.number().int().min(1900).max(9999),
  }),
]);
export type StatementImportSource = z.infer<typeof StatementImportSource>;

/** POST /statements/imports/preview */
export const StatementImportPreviewInput = z.object({ source: StatementImportSource });
export type StatementImportPreviewInput = z.infer<typeof StatementImportPreviewInput>;

/** POST /statements/imports */
export const StatementImportCommitInput = z.object({
  source: StatementImportSource,
  expected: z.object({ inputSha256: Sha256, countNew: Count }),
});
export type StatementImportCommitInput = z.infer<typeof StatementImportCommitInput>;

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
  unmappedAccounts: z.array(z.string()),
  countNew: Count,
});
export type StatementImportPreview = z.infer<typeof StatementImportPreview>;

export const StatementBatch = z.object({
  id: Id,
  origin: StatementOrigin,
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
});
export type StatementImportCommitted = z.infer<typeof StatementImportCommitted>;

export const JOB_STATUSES = ["running", "done", "failed"] as const;
export const JobStatus = z.enum(JOB_STATUSES);
export type JobStatus = z.infer<typeof JobStatus>;

/** GET /jobs/:jobId（評価のジョブ） */
export const JobView = z.object({
  status: JobStatus,
  error: z.object({ code: z.string(), message: z.string() }).optional(),
});
export type JobView = z.infer<typeof JobView>;

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

/** POST /statements/:statementId/approve（省略で候補のまま） */
export const ApproveInput = z.object({
  draft: JournalInput.optional(),
  purpose: Purpose.optional(),
  match: z.object({ journalId: Id, lineId: Id }).optional(),
  partnerId: Id.optional(),
  learn: z.boolean().default(true),
});
export type ApproveInput = z.infer<typeof ApproveInput>;

/** POST /statements/approve-bulk */
export const ApproveBulkInput = z.object({
  statementIds: z.array(Id).optional(),
  threshold: Percent.optional(),
});
export type ApproveBulkInput = z.infer<typeof ApproveBulkInput>;

/** POST /statements/:statementId/exclude（理由は任意） */
export const ExcludeInput = z.object({ reason: z.string().max(500).optional() });
export type ExcludeInput = z.infer<typeof ExcludeInput>;

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

// ---- 評価（§6.1・§6.2）と設定（§6.3） ----

/** POST /statements/evals */
export const EvalStartInput = z.object({
  splitDate: DateString.optional(),
  includeAi: z.boolean().optional(),
});
export type EvalStartInput = z.infer<typeof EvalStartInput>;

/** 率は千分率の整数（0〜1000） */
const PerMille = z.number().int().min(0).max(1000);

export const EvalRun = z.object({
  id: Id,
  splitDate: DateString,
  includeAi: z.boolean(),
  sampleCount: Count,
  result: z.object({
    fields: z.object({
      counterAccount: PerMille,
      taxCategory: PerMille,
      partner: PerMille,
      purpose: PerMille,
    }),
    methods: z.array(z.object({ method: CandidateMethod, count: Count, matchRate: PerMille })),
  }),
  models: z.array(z.string()),
  createdAt: Timestamp,
});
export type EvalRun = z.infer<typeof EvalRun>;

/** PUT /statement-settings */
export const StatementSettingsInput = z.object({
  bulkThreshold: Percent,
  externalThreshold: Percent,
});
export type StatementSettingsInput = z.infer<typeof StatementSettingsInput>;

export const StatementSettings = StatementSettingsInput.extend({ updatedAt: Timestamp });
export type StatementSettings = z.infer<typeof StatementSettings>;
