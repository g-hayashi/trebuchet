import { queryOptions } from "@tanstack/react-query";
import type {
  ImportBatch,
  ImportBatchJournal,
  ImportExpected,
  ImportMappings,
  ImportMappingsPut,
  ImportOptions,
  ImportPreview,
  OpeningProposal,
  ReconciliationResult,
  VoidImportInput,
} from "@trebuchet/schema";
import { entityKeys } from "@/features/entities/api";
import { unwrap } from "@/lib/api";
import { untypedEndpoint, uploadForm } from "./upload";

// 取込の API（contracts/http-api.md の 002）。サーバーのルートの型に頼らず、応答の型は schema の型で指定する

/** クエリのキー。プレビューは帳簿を変えないが、ファイルと指定ごとに作り直す */
export const importKeys = {
  all: (entityId: string) => ["entities", entityId, "imports"] as const,
  batch: (entityId: string, batchId: string) => ["entities", entityId, "imports", batchId] as const,
  preview: (entityId: string, fileKey: number, options: object) =>
    ["entities", entityId, "import-preview", fileKey, options] as const,
  mappings: (entityId: string) => ["entities", entityId, "import-mappings"] as const,
};

type GetEndpoint = { $get(): Promise<Response> };
type PutEndpoint = { $put(args: { json: unknown }): Promise<Response> };
type PostEndpoint = { $post(args: { json: unknown }): Promise<Response> };

const entityPath = (entityId: string) => `/api/entities/${encodeURIComponent(entityId)}`;

export const importsQuery = (entityId: string) =>
  queryOptions({
    queryKey: importKeys.all(entityId),
    queryFn: async (): Promise<ImportBatch[]> => {
      const body: { batches: ImportBatch[] } = await unwrap(
        await untypedEndpoint<GetEndpoint>(`${entityPath(entityId)}/imports`).$get(),
      );
      return body.batches;
    },
  });

export type ImportBatchDetail = { batch: ImportBatch; journals: ImportBatchJournal[] };

export const importBatchQuery = (entityId: string, batchId: string) =>
  queryOptions({
    queryKey: importKeys.batch(entityId, batchId),
    queryFn: async (): Promise<ImportBatchDetail> =>
      unwrap(
        await untypedEndpoint<GetEndpoint>(
          `${entityPath(entityId)}/imports/${encodeURIComponent(batchId)}`,
        ).$get(),
      ),
  });

/** プレビュー（POST だが帳簿は変えない）。fileKey はファイルを選び直すたびに変える番号 */
export const importPreviewQuery = (
  entityId: string,
  file: File | undefined,
  fileKey: number,
  options: ImportOptions,
) =>
  queryOptions({
    queryKey: importKeys.preview(entityId, fileKey, options),
    queryFn: async (): Promise<ImportPreview> => {
      if (!file) throw new Error("ファイルが選ばれていません");
      const body: { preview: ImportPreview } = await uploadForm(
        `${entityPath(entityId)}/imports/freee/preview`,
        { file, options: JSON.stringify(options) },
      );
      return body.preview;
    },
    enabled: file !== undefined,
  });

export async function commitImport(
  entityId: string,
  file: File,
  options: ImportOptions,
  expected: ImportExpected,
): Promise<{ batch: ImportBatch; preview: ImportPreview }> {
  return uploadForm(`${entityPath(entityId)}/imports/freee/commit`, {
    file,
    options: JSON.stringify(options),
    expected: JSON.stringify(expected),
  });
}

/** 対応表の保存（指定した行だけを追加・更新） */
export async function saveImportMappings(
  entityId: string,
  json: ImportMappingsPut,
): Promise<ImportMappings> {
  return unwrap(
    await untypedEndpoint<PutEndpoint>(`${entityPath(entityId)}/import-mappings`).$put({ json }),
  );
}

/** 期首残高の案（POST だが帳簿は変えない）。保存は 001 の PUT .../opening-balances に案の行を渡す */
export async function proposeFreeeOpening(
  entityId: string,
  year: string,
  file: File,
): Promise<OpeningProposal> {
  const body: { proposal: OpeningProposal } = await uploadForm(
    `${entityPath(entityId)}/fiscal-periods/${encodeURIComponent(year)}/opening-balances/freee-proposal`,
    { file },
  );
  return body.proposal;
}

/** 取込の取消（FR-024〜027）。訂正済みの仕訳があれば 409 CORRECTED_JOURNALS */
export async function voidImportBatch(
  entityId: string,
  batchId: string,
  json: VoidImportInput,
): Promise<{ batch: ImportBatch; voidedCount: number }> {
  return unwrap(
    await untypedEndpoint<PostEndpoint>(
      `${entityPath(entityId)}/imports/${encodeURIComponent(batchId)}/void`,
    ).$post({ json }),
  );
}

/** 元帳との照合（POST だが帳簿は変えない）。journal は任意の仕訳帳。fileKey はファイルを選び直すたびに変える番号 */
export const reconcileFreeeQuery = (
  entityId: string,
  year: string | undefined,
  file: File | undefined,
  fileKey: number,
  journal?: File | undefined,
) =>
  queryOptions({
    queryKey: [...entityKeys.entity(entityId), "reconcile-freee", year, fileKey] as const,
    queryFn: async (): Promise<ReconciliationResult> => {
      if (!file || !year) throw new Error("年度とファイルが選ばれていません");
      return uploadForm(
        `${entityPath(entityId)}/fiscal-periods/${encodeURIComponent(year)}/reconcile/freee`,
        journal ? { file, journal } : { file },
      );
    },
    enabled: file !== undefined && year !== undefined,
  });
