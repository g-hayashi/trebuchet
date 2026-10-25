import { queryOptions } from "@tanstack/react-query";
import type { StatementAccountInput, StatementImportSource } from "@trebuchet/schema";
import { api, unwrap } from "@/lib/api";

// 明細の取込の API（006 contracts/http-api.md §2・§3）

const entityApi = api.api.entities[":entityId"];

/** クエリのキー。口座の対応を保存したあと・取込のあとは該当のキーを無効にする */
export const statementKeys = {
  accounts: (entityId: string) => ["entities", entityId, "statement-accounts"] as const,
  batches: (entityId: string) => ["entities", entityId, "statement-imports"] as const,
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
