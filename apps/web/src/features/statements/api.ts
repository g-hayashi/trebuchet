import { queryOptions } from "@tanstack/react-query";
import type {
  EvalStartInput,
  InferenceRuleUpdateInput,
  JournalInput,
  Purpose,
  RuleStatus,
  StatementAccountInput,
  StatementImportSource,
  StatementSettingsInput,
  StatementStatusFilter,
} from "@trebuchet/schema";
import { api, type QueryItem, unwrap } from "@/lib/api";

// 明細の取込・候補・承認の API（006 contracts/http-api.md §2〜§4・§6.3）

const entityApi = api.api.entities[":entityId"];

/**
 * クエリのキー。口座の対応を保存したあと・取込のあとは該当のキーを無効にする。
 * 明細の一覧・設定は `all` の下にあり、仕訳が変わる操作の後（`invalidateLedger`）にまとめて読み直す
 */
export const statementKeys = {
  accounts: (entityId: string) => ["entities", entityId, "statement-accounts"] as const,
  batches: (entityId: string) => ["entities", entityId, "statement-imports"] as const,
  all: (entityId: string) => ["entities", entityId, "statements"] as const,
  list: (entityId: string, filter: StatementFilter) =>
    ["entities", entityId, "statements", "list", filter] as const,
  settings: (entityId: string) => ["entities", entityId, "statements", "settings"] as const,
  evals: (entityId: string) => ["entities", entityId, "statements", "evals"] as const,
  rules: (entityId: string, status?: RuleStatus) =>
    ["entities", entityId, "statements", "rules", status ?? "all"] as const,
  ruleHistory: (entityId: string, ruleId: string) =>
    ["entities", entityId, "statements", "rules", "history", ruleId] as const,
};

/** 貼り付けの取込元 */
export type PasteSource = Extract<StatementImportSource, { kind: "paste" }>;
/** MF ME からの自動取得の取込元（ジョブの ID。取得した行は server のメモリにある） */
export type FetchSource = Extract<StatementImportSource, { kind: "mfme_fetch" }>;
/** プレビュー・確定に渡す取込元（貼り付けか自動取得） */
export type ImportSource = PasteSource | FetchSource;

/** 取得のジョブの状態を取り直す間隔（ミリ秒） */
export const JOB_POLL_MS = 1000;

/** 取込元の口座の一覧（§2.1） */
export const statementAccountsQuery = (entityId: string) =>
  queryOptions({
    queryKey: statementKeys.accounts(entityId),
    queryFn: async () =>
      (await unwrap(await entityApi["statement-accounts"].$get({ param: { entityId } }))).accounts,
  });

/** 取込の履歴（§3.3。新しい順） */
export const importBatchesQuery = (entityId: string) =>
  queryOptions({
    queryKey: statementKeys.batches(entityId),
    queryFn: async () =>
      (await unwrap(await entityApi.statements.imports.$get({ param: { entityId } }))).batches,
  });

/** 取込元の口座の対応を保存する（§2.2） */
export const putStatementAccount = async (
  entityId: string,
  name: string,
  json: StatementAccountInput,
) =>
  unwrap(await entityApi["statement-accounts"][":name"].$put({ param: { entityId, name }, json }));

/** プレビュー（§3.1。POST だが何も保存しない） */
export const postImportPreview = async (entityId: string, source: ImportSource) =>
  unwrap(
    await entityApi.statements.imports.preview.$post({ param: { entityId }, json: { source } }),
  );

/** 確定（§3.2）。プレビューが返したハッシュと新規の件数を添える */
export const postImportCommit = async (
  entityId: string,
  source: ImportSource,
  expected: { inputSha256: string; countNew: number },
) =>
  unwrap(
    await entityApi.statements.imports.$post({ param: { entityId }, json: { source, expected } }),
  );

/** MF ME からの取得を始める（§3.4）。server が見えるブラウザを開く。202 `{ jobId }` */
export const postMfmeFetch = async (entityId: string, json: { from: string; to: string }) =>
  unwrap(await entityApi.statements.mfme.fetch.$post({ param: { entityId }, json }));

/** 取得のジョブの状態（§3.5）。終わる（done・failed）まで取り直す */
export const jobQuery = (entityId: string, jobId: string) =>
  queryOptions({
    queryKey: ["entities", entityId, "jobs", jobId] as const,
    queryFn: async () =>
      unwrap(await entityApi.jobs[":jobId"].$get({ param: { entityId, jobId } })),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === "waiting_login" || status === "running" ? JOB_POLL_MS : false;
    },
    // 404（server の再起動で消えた）を再試行しない
    retry: false,
  });

// ---- 明細と候補（§4） ----

/** 一覧の絞り込み。`status` を省くと、すべての状態 */
export type StatementFilter = {
  status?: StatementStatusFilter | undefined;
  /** 取込元の口座の ID */
  accountId?: string | undefined;
};

/** 明細の一覧（§4.1）。日付の新しい順 */
export const statementsQuery = (entityId: string, filter: StatementFilter) =>
  queryOptions({
    queryKey: statementKeys.list(entityId, filter),
    queryFn: async () =>
      (
        await unwrap(
          await entityApi.statements.$get({
            param: { entityId },
            query: {
              ...(filter.status === undefined ? {} : { status: filter.status }),
              ...(filter.accountId === undefined ? {} : { accountId: filter.accountId }),
            },
          }),
        )
      ).statements,
  });

export type StatementView = QueryItem<typeof statementsQuery>;

/** 候補を作る（§4.2）。省略で未処理すべて */
export const postBuildCandidates = async (entityId: string) =>
  unwrap(await entityApi.statements.candidates.$post({ param: { entityId }, json: {} }));

/**
 * 承認の入力。`draft` か `match` のどちらか（省略で候補のまま）。
 * `learn: false` はルールを学ばない。`purpose`・`partnerId` は学ぶルールの判定・取引先（省略で仕訳のとおり）
 */
export type ApproveBody = {
  draft?: JournalInput | undefined;
  match?: { journalId: string; lineId: string } | undefined;
  learn?: false | undefined;
  purpose?: Purpose | undefined;
  partnerId?: string | undefined;
};

/** 承認する（§4.4）。仕訳が変わるので、呼び出し側が `invalidateLedger` を呼ぶ */
export const postApprove = async (entityId: string, statementId: string, json: ApproveBody) =>
  unwrap(
    await entityApi.statements[":statementId"].approve.$post({
      param: { entityId, statementId },
      json,
    }),
  );

/**
 * AI で推定する（§4.3。10 件まで）。候補だけが変わり、仕訳は変わらない。
 * 10 件を超える分は、呼び出し側が繰り返して呼ぶ
 */
export const postInfer = async (entityId: string, statementIds: string[]) =>
  unwrap(await entityApi.statements.infer.$post({ param: { entityId }, json: { statementIds } }));

/** まとめて承認（§4.5）。`statementIds` を省くと、設定のしきい値以上の未処理すべて */
export const postApproveBulk = async (entityId: string, statementIds: string[]) =>
  unwrap(
    await entityApi.statements["approve-bulk"].$post({
      param: { entityId },
      json: { statementIds },
    }),
  );

/** 除外する（§4.6。理由は任意） */
export const postExclude = async (entityId: string, statementId: string) =>
  unwrap(
    await entityApi.statements[":statementId"].exclude.$post({
      param: { entityId, statementId },
      json: {},
    }),
  );

/** 除外を取り消す（§4.7。理由は必須） */
export const postUnexclude = async (entityId: string, statementId: string, reason: string) =>
  unwrap(
    await entityApi.statements[":statementId"].unexclude.$post({
      param: { entityId, statementId },
      json: { reason },
    }),
  );

/** 「変更あり」を確認した印を付ける（§4.8） */
export const postAcknowledgeChange = async (entityId: string, statementId: string) =>
  unwrap(
    await entityApi.statements[":statementId"]["acknowledge-change"].$post({
      param: { entityId, statementId },
    }),
  );

/** 既存の仕訳への結びつきを外す（§4.9。理由は必須） */
export const postUnlink = async (entityId: string, statementId: string, reason: string) =>
  unwrap(
    await entityApi.statements[":statementId"].unlink.$post({
      param: { entityId, statementId },
      json: { reason },
    }),
  );

// ---- ルール（§5） ----

/** ルールの一覧（§5.1）。`status` を省くと、有効と停止中の両方 */
export const rulesQuery = (entityId: string, status?: RuleStatus) =>
  queryOptions({
    queryKey: statementKeys.rules(entityId, status),
    queryFn: async () =>
      (
        await unwrap(
          await entityApi["inference-rules"].$get({
            param: { entityId },
            query: status === undefined ? {} : { status },
          }),
        )
      ).rules,
  });

export type RuleView = QueryItem<typeof rulesQuery>;

/** ルールの履歴（§5.5。追記の順） */
export const ruleHistoryQuery = (entityId: string, ruleId: string) =>
  queryOptions({
    queryKey: statementKeys.ruleHistory(entityId, ruleId),
    queryFn: async () =>
      (
        await unwrap(
          await entityApi["inference-rules"][":ruleId"].history.$get({
            param: { entityId, ruleId },
          }),
        )
      ).history,
  });

export type RuleHistoryEntry = QueryItem<typeof ruleHistoryQuery>;

/** ルールの初期作成（§5.2）。`dryRun` は何も作らず案だけを返す */
export const postSeedRules = async (entityId: string, dryRun: boolean) =>
  unwrap(
    await entityApi["inference-rules"].seed.$post({
      param: { entityId },
      json: dryRun ? { dryRun: true } : {},
    }),
  );

/** ルールを直す（§5.3） */
export const patchRule = async (entityId: string, ruleId: string, json: InferenceRuleUpdateInput) =>
  (
    await unwrap(
      await entityApi["inference-rules"][":ruleId"].$patch({ param: { entityId, ruleId }, json }),
    )
  ).rule;

/** ルールを止める・再開する（§5.4） */
export const postRuleStatus = async (
  entityId: string,
  ruleId: string,
  action: "pause" | "resume",
) =>
  (
    await unwrap(
      await entityApi["inference-rules"][":ruleId"][action].$post({
        param: { entityId, ruleId },
      }),
    )
  ).rule;

// ---- 設定（§6.3） ----

export const statementSettingsQuery = (entityId: string) =>
  queryOptions({
    queryKey: statementKeys.settings(entityId),
    queryFn: async () =>
      (await unwrap(await entityApi["statement-settings"].$get({ param: { entityId } }))).settings,
  });

export const putStatementSettings = async (entityId: string, json: StatementSettingsInput) =>
  (await unwrap(await entityApi["statement-settings"].$put({ param: { entityId }, json })))
    .settings;

// ---- 評価（§6.1・§6.2） ----

/** 評価の履歴（§6.2。新しい順） */
export const evalRunsQuery = (entityId: string) =>
  queryOptions({
    queryKey: statementKeys.evals(entityId),
    queryFn: async () =>
      (await unwrap(await entityApi.statements.evals.$get({ param: { entityId } }))).runs,
  });

export type EvalRunView = QueryItem<typeof evalRunsQuery>;

/** 評価を始める（§6.1）。202 `{ jobId }`。状態は `jobQuery` で取り直す */
export const postEvalStart = async (entityId: string, json: EvalStartInput) =>
  unwrap(await entityApi.statements.evals.$post({ param: { entityId }, json }));
