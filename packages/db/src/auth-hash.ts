import { sha256Hex } from "./util.ts";

/**
 * セッション・回復コード・ペアリングのトークンのハッシュ（SHA-256 の hex）。
 * リポジトリはハッシュ済みの値だけを保存する。server もこの関数を使う（別の SHA-256 を書かない）
 */
export function hashToken(token: string): string {
  return sha256Hex(token);
}
