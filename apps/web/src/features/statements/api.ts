import { queryOptions } from "@tanstack/react-query";
import type {
  InferenceRuleUpdateInput,
  JournalInput,
  Purpose,
  RuleStatus,
  StatementColumnSuggestionOptions,
  StatementColumnSuggestionResponse,
  StatementCommitOptions,
  StatementImportCommitted,
  StatementImportPreview,
  StatementLayoutOptions,
  StatementPreviewOptions,
  StatementSettingsInput,
  StatementSource,
  StatementStatusFilter,
  StatementTableLayout,
} from "@trebuchet/schema";
import { uploadForm } from "@/features/imports/upload";
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
  sources: (entityId: string) => ["entities", entityId, "statement-sources"] as const,
  all: (entityId: string) => ["entities", entityId, "statements"] as const,
  list: (entityId: string, filter: StatementFilter) =>
    ["entities", entityId, "statements", "list", filter] as const,
  settings: (entityId: string) => ["entities", entityId, "statements", "settings"] as const,
  rules: (entityId: string, status?: RuleStatus) =>
    ["entities", entityId, "statements", "rules", status ?? "all"] as const,
  ruleHistory: (entityId: string, ruleId: string) =>
    ["entities", entityId, "statements", "rules", "history", ruleId] as const,
};

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

// 取込の 3 つの API は multipart（`file` と `options` の JSON。007 contracts §2）。
// hc の型つきの `form` に頼らず、002 と同じ `uploadForm` で送り、応答の型は schema の型で指定する

const importPath = (entityId: string, last: string) =>
  `/api/entities/${encodeURIComponent(entityId)}/statements/imports${last}`;

/** 表の判定（§2.1。何も保存しない）。区切り・見出しの行・文字コードの選び直しは `options` で渡す */
export const postImportLayout = async (
  entityId: string,
  file: File,
  options: StatementLayoutOptions,
): Promise<StatementTableLayout> =>
  uploadForm(importPath(entityId, "/layout"), { file, options: JSON.stringify(options) });

/**
 * 列の対応の案（007 §4.1。端末内の AI。何も保存しない）。辞書の案で必須がそろわない表だけで呼ぶ。
 * キーは `statements` の下に置かない（仕訳が変わる操作の後に AI を呼び直さない）
 */
export const columnSuggestionQuery = (
  entityId: string,
  file: File,
  options: StatementColumnSuggestionOptions,
) =>
  queryOptions({
    queryKey: [
      "entities",
      entityId,
      "statement-column-suggestion",
      `${file.name}:${file.size}:${file.lastModified}`,
      options,
    ] as const,
    queryFn: async (): Promise<StatementColumnSuggestionResponse> =>
      uploadForm(importPath(entityId, "/column-suggestion"), {
        file,
        options: JSON.stringify(options),
      }),
    // AI は遅く、同じ表への答えは変わらない。失敗しても繰り返さない
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });

/** プレビュー（§2.2。POST だが何も保存しない） */
export const postImportPreview = async (
  entityId: string,
  file: File,
  options: StatementPreviewOptions,
): Promise<StatementImportPreview> =>
  uploadForm(importPath(entityId, "/preview"), { file, options: JSON.stringify(options) });

/** 確定（§2.3）。プレビューと同じファイルと指定に、プレビューが返したハッシュと新規の件数を添える */
export const postImportCommit = async (
  entityId: string,
  file: File,
  options: StatementCommitOptions,
): Promise<StatementImportCommitted> =>
  uploadForm(importPath(entityId, ""), { file, options: JSON.stringify(options) });

/** 取込元（列の対応の保存）の一覧（007 §3。最後に使った日時の新しい順） */
export const statementSourcesQuery = (entityId: string) =>
  queryOptions({
    queryKey: statementKeys.sources(entityId),
    // hc の JSON 型は任意の列の番号が `number | undefined` になるので、schema の型に合わせる
    queryFn: async (): Promise<StatementSource[]> =>
      (await unwrap(await entityApi["statement-sources"].$get({ param: { entityId } })))
        .sources as StatementSource[],
  });

/** 取込元の名前を変える（007 §3）。重複は 409 `STATEMENT_SOURCE_NAME_TAKEN` */
export const patchStatementSource = async (entityId: string, id: string, name: string) =>
  unwrap(
    await entityApi["statement-sources"][":id"].$patch({ param: { entityId, id }, json: { name } }),
  );

/** 取込元を削除する（007 §3。明細・取込の回・仕訳は変わらない） */
export const deleteStatementSource = async (entityId: string, id: string) => {
  await unwrap(await entityApi["statement-sources"][":id"].$delete({ param: { entityId, id } }));
};

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
 * 承認の入力。`draft` か `match` のどちらか（省略で候補のまま）。承認のたびにルールを学ぶ（011 R9）。
 * `purpose`・`partnerId` は学ぶルールの判定・取引先（省略で仕訳のとおり）
 */
export type ApproveBody = {
  draft?: JournalInput | undefined;
  match?: { journalId: string; lineId: string } | undefined;
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

/** 選んだ行の承認（§4.5。007/R17）。各 item は候補のまま、または `draft`・`match` つき */
export const postApproveBulk = async (
  entityId: string,
  items: { statementId: string; draft?: JournalInput | undefined; match?: ApproveBody["match"] }[],
) =>
  unwrap(
    await entityApi.statements["approve-bulk"].$post({
      param: { entityId },
      json: { items },
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
