/**
 * 認証なしで呼べる手続きの完全一致の名簿（data-model §3、INV-29）。11 組。
 * プレフィックスやワイルドカードにしない。前提（パスキー 0 件、ローカルの Host、一時セッション、
 * トークン）は server が検査する。
 */
export const PUBLIC_ROUTES: readonly (readonly [method: string, path: string])[] = [
  ["GET", "/api/health"],
  ["GET", "/api/auth/status"],
  ["POST", "/api/auth/register/options"],
  ["POST", "/api/auth/register/verify"],
  ["POST", "/api/auth/sign-in/options"],
  ["POST", "/api/auth/sign-in/verify"],
  ["POST", "/api/auth/recovery/verify"],
  ["POST", "/api/auth/recovery/register/options"],
  ["POST", "/api/auth/recovery/register/verify"],
  ["POST", "/api/auth/pairing/register/options"],
  ["POST", "/api/auth/pairing/register/verify"],
];

/** 公開の名簿に載らなければ true（要サインイン）。大文字小文字・末尾の `/`・クエリは区別して一致させない */
export function requiresAuth(method: string, path: string): boolean {
  return !PUBLIC_ROUTES.some(([m, p]) => m === method && p === path);
}
