import { hc } from "hono/client";
import { unwrap } from "@/lib/api";

/** multipart/form-data で送る値。`file` はファイル、他のフィールドは文字列（JSON は呼び出し側で文字列にする） */
export type UploadForm = { file: File } & Record<string, string | File>;

type FormEndpoint = { $post(args: { form: UploadForm }): Promise<Response> };

/**
 * ファイルを hc の `form` で `POST` し、JSON の応答を返す。失敗なら `ApiError` を投げる（`unwrap` と同じ）。
 * path は `/api/...` の形の完全なパス（パラメーターは埋めた後）。
 * サーバーのルートの型に頼らないため、最後の区切りの手前を hc の基点にし、最後の区切りの `$post` を呼ぶ
 */
export async function uploadForm<T = unknown>(path: string, form: UploadForm): Promise<T> {
  const slash = path.lastIndexOf("/");
  const segment = path.slice(slash + 1);
  if (slash < 0 || segment === "") throw new Error(`送り先のパスが正しくありません: ${path}`);
  const client = hc(path.slice(0, slash)) as unknown as { [segment: string]: FormEndpoint };
  const endpoint = client[segment] as FormEndpoint;
  return unwrap(await endpoint.$post({ form }));
}
