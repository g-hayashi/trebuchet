import { resolve } from "node:path";

/**
 * E2E の接続先と一時ファイルの場所（playwright の設定・テスト・撮影が共有する）。
 * web は server の実行時のコードを import しない（型だけ）ので、`apps/server/src/lib/origin.ts` の
 * `DEV_WEB_ORIGIN`・`SERVER_PORT`・`LOOPBACK_HOST` と同じ値をここに持つ。変えるときは両方を直す。
 */

/** 開発の画面（Vite。`/api` は server へ proxy する）のオリジン。CSRF の検査（Origin）にも使う */
export const WEB_ORIGIN = "http://localhost:5173";

/** server の起動の確認（Host は `127.0.0.1:8787`。ヘルスチェックだけに使う） */
export const SERVER_HEALTH_URL = "http://127.0.0.1:8787/api/health";

/** リポジトリの `.tmp/`（一時ファイルの置き場所。`/tmp` は使わない） */
export const TMP_ROOT = resolve(import.meta.dirname, "../../../.tmp");
