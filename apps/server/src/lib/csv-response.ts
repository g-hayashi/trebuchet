import type { Context } from "hono";

/**
 * CSV（BOM 付き UTF-8。本文は domain の `encodeCsv` などが作る）をダウンロードさせる応答。
 * `c.text` にするのは、クライアントの型（hc）で JSON の応答と区別するため（Content-Type は上書きする）。
 * `noStore` は、キャッシュさせない CSV（認証の記録・バックアップの記録）に付ける
 */
export function csvResponse(
  c: Context,
  text: string,
  filename: string,
  options: { noStore?: boolean } = {},
) {
  return c.text(text, 200, {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="${filename}"`,
    ...(options.noStore ? { "Cache-Control": "no-store" } : {}),
  });
}
