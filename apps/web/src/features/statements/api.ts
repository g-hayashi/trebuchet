import { queryOptions } from "@tanstack/react-query";
import type {
  JournalInput,
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
};

/** 貼り付けの取込元（自動取得は US4 で足す） */
export type PasteSource = Extract<StatementImportSource, { kind: "paste" }>;

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
export const postImportPreview = async (entityId: string, source: PasteSource) =>
  unwrap(
    await entityApi.statements.imports.preview.$post({ param: { entityId }, json: { source } }),
  );

/** 確定（§3.2）。プレビューが返したハッシュと新規の件数を添える */
export const postImportCommit = async (
  entityId: string,
  source: PasteSource,
  expected: { inputSha256: string; countNew: number },
) =>
  unwrap(
    await entityApi.statements.imports.$post({ param: { entityId }, json: { source, expected } }),
  );

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

/** 承認の入力。`draft` か `match` のどちらか（省略で候補のまま） */
export type ApproveBody = {
  draft?: JournalInput | undefined;
  match?: { journalId: string; lineId: string } | undefined;
};

/** 承認する（§4.4）。仕訳が変わるので、呼び出し側が `invalidateLedger` を呼ぶ */
export const postApprove = async (entityId: string, statementId: string, json: ApproveBody) =>
  unwrap(
    await entityApi.statements[":statementId"].approve.$post({
      param: { entityId, statementId },
      json,
    }),
  );

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
