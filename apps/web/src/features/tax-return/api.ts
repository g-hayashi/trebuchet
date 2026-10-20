import { queryOptions } from "@tanstack/react-query";
import { api, unwrap } from "@/lib/api";

// 申告の控え・提出書類の API（003 contracts/http-api.md「控除の回答・メモ・控え・書類」）

const taxReturnApi = api.api.entities[":entityId"]["tax-return"][":year"];

/** 年分ごとのキー。控えと書類をまとめて読み直せる */
export const taxReturnKeys = {
  all: (entityId: string, year: string) => ["entities", entityId, "tax-return", year] as const,
  memos: (entityId: string, year: string) =>
    ["entities", entityId, "tax-return", year, "memos"] as const,
  documents: (entityId: string, year: string) =>
    ["entities", entityId, "tax-return", year, "documents"] as const,
};

const listMemos = async (entityId: string, year: string) =>
  (await unwrap(await taxReturnApi.memos.$get({ param: { entityId, year } }))).memos;

/** 控えの1行（API の応答。fileExists はサーバーが確かめた結果） */
export type MemoRow = Awaited<ReturnType<typeof listMemos>>[number];

export const memosQuery = (entityId: string, year: string) =>
  queryOptions({
    queryKey: taxReturnKeys.memos(entityId, year),
    queryFn: () => listMemos(entityId, year),
  });

export type MemoJson = Parameters<typeof taxReturnApi.memos.$post>[0]["json"];

export const postMemo = async (entityId: string, year: string, json: MemoJson) =>
  unwrap(await taxReturnApi.memos.$post({ param: { entityId, year }, json }));

export const putMemo = async (entityId: string, year: string, memoId: string, json: MemoJson) =>
  unwrap(await taxReturnApi.memos[":memoId"].$put({ param: { entityId, year, memoId }, json }));

export const deleteMemo = async (entityId: string, year: string, memoId: string) =>
  unwrap(await taxReturnApi.memos[":memoId"].$delete({ param: { entityId, year, memoId } }));

const listDocuments = async (entityId: string, year: string) =>
  (await unwrap(await taxReturnApi.documents.$get({ param: { entityId, year } }))).documents;

/** 書類の1行（API の応答） */
export type DocumentRow = Awaited<ReturnType<typeof listDocuments>>[number];

export const documentsQuery = (entityId: string, year: string) =>
  queryOptions({
    queryKey: taxReturnKeys.documents(entityId, year),
    queryFn: () => listDocuments(entityId, year),
  });

export type DocumentJson = Parameters<typeof taxReturnApi.documents.$post>[0]["json"];

export const postDocument = async (entityId: string, year: string, json: DocumentJson) =>
  unwrap(await taxReturnApi.documents.$post({ param: { entityId, year }, json }));

export const putDocument = async (
  entityId: string,
  year: string,
  documentId: string,
  json: DocumentJson,
) =>
  unwrap(
    await taxReturnApi.documents[":documentId"].$put({
      param: { entityId, year, documentId },
      json,
    }),
  );

export const deleteDocument = async (entityId: string, year: string, documentId: string) =>
  unwrap(
    await taxReturnApi.documents[":documentId"].$delete({
      param: { entityId, year, documentId },
    }),
  );
