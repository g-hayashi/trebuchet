import { hc } from "hono/client";
import { unwrap } from "@/lib/api";

/** multipart/form-data で送る値。`file` はファイル、他のフィールドは文字列（JSON は呼び出し側で文字列にする） */
export type UploadForm = { file: File } & Record<string, string | File>;

type FormEndpoint = { $post(args: { form: UploadForm }): Promise<Response> };

/**
 * サーバーのルートの型（hc<AppType>）に頼らずに、hc のエンドポイントを得る。
 * path は `/api/...` の形の完全なパス（パラメーターは埋めた後）。
 * 最後の区切りの手前を hc の基点にし、最後の区切りをエンドポイントにする（`$get`・`$put`・`$post` を呼ぶ）
 */
export function untypedEndpoint<E>(path: string): E {
  const slash = path.lastIndexOf("/");
  const segment = path.slice(slash + 1);
  if (slash < 0 || segment === "") throw new Error(`送り先のパスが正しくありません: ${path}`);
  const client = hc(path.slice(0, slash)) as unknown as { [segment: string]: E };
  return client[segment] as E;
}

/**
 * ファイルを hc の `form` で `POST` し、JSON の応答を返す。失敗なら `ApiError` を投げる（`unwrap` と同じ）。
 * path は `/api/...` の形の完全なパス（パラメーターは埋めた後）
 */
export async function uploadForm<T = unknown>(path: string, form: UploadForm): Promise<T> {
  return unwrap(await untypedEndpoint<FormEndpoint>(path).$post({ form }));
}
