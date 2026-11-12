import { err, notFoundError, ok, type Result } from "./types.ts";

/**
 * 科目コードで科目を引く。なければ `ACCOUNT_NOT_FOUND`（`details.code`）。
 * 文言は「勘定科目（コード <code>）が見つかりません」の 1 つ。コードで科目を探す処理はこれを使う
 */
export function accountByCode<T extends { code: string }>(
  accounts: readonly T[],
  code: string,
): Result<T> {
  const found = accounts.find((a) => a.code === code);
  if (found === undefined) {
    return err(notFoundError("ACCOUNT_NOT_FOUND", `勘定科目（コード ${code}）`, { code }));
  }
  return ok(found);
}
