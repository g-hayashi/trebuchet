/**
 * Result の取り出しの共有版（正本）。各テストで `unwrap`・`must`・`ok`・`codeOf` を書き直さない。
 * db のテストは `@trebuchet/db/testing` の再エクスポートから使う。
 */

type Ok<T> = { ok: true; value: T };
type Err<E> = { ok: false; error: E };

/** 成功の値を取り出す。失敗なら、エラーを JSON にして例外を投げる */
export function unwrap<T>(r: Ok<T> | Err<unknown>): T {
  if (!r.ok) throw new Error(`expected ok: ${JSON.stringify(r.error)}`);
  return r.value;
}

/** `unwrap` と同じ（定期仕訳などの既存の呼び出しの名前） */
export const must = unwrap;

/** 失敗のエラーを取り出す。成功なら例外を投げる */
export function errorOf<E>(r: Ok<unknown> | Err<E>): E {
  if (r.ok) throw new Error("expected err");
  return r.error;
}

/** 失敗のエラーコード。成功なら "ok" */
export function codeOf(r: Ok<unknown> | Err<{ code: string }>): string {
  return r.ok ? "ok" : r.error.code;
}
