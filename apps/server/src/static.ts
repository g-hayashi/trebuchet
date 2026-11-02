import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import type { createApp } from "./app.ts";
import { onError } from "./errors.ts";
import type { GetRemoteSettings } from "./lib/origin.ts";
import { type GuardEnv, hostCheck } from "./middleware/host.ts";

/**
 * web のビルド成果物の配信（004 R3、FR-003・011）。`/api` の外に足し、Host の検査を掛ける（認証は不要）。
 * `/api/...` の未知のパスは 404 JSON、それ以外の未知は index.html（画面のルーティングは web が行う）
 */

const DEFAULT_DIST = resolve(import.meta.dirname, "../../web/dist");

/**
 * 配信するディレクトリ。`TREBUCHET_WEB_DIST`（既定は `apps/web/dist`）に index.html があればその絶対パス、
 * なければ undefined（配信しない）
 */
export function resolveWebDist(
  env: { TREBUCHET_WEB_DIST?: string | undefined } = process.env,
): string | undefined {
  const dir = resolve(env.TREBUCHET_WEB_DIST || DEFAULT_DIST);
  const index = join(dir, "index.html");
  return existsSync(index) && statSync(index).isFile() ? dir : undefined;
}

const isApiPath = (path: string) => path === "/api" || path.startsWith("/api/");

const notFound = () => ({
  error: { code: "NOT_FOUND", message: "見つかりません" },
});

export type WebDistOptions = {
  /** `resolveWebDist` が返した、index.html のあるディレクトリ */
  dist: string;
  /** Host の検査が使うリモートの設定（API と同じもの） */
  getRemoteSettings: GetRemoteSettings;
};

/** `createApp()` の `/api` を含む、静的配信つきのアプリ。API の検査（Host → CSRF → 認証）は変えない */
export function withWebDist(
  api: ReturnType<typeof createApp>,
  { dist, getRemoteSettings }: WebDistOptions,
) {
  const root = resolve(dist);
  const index = join(root, "index.html");
  return new Hono<GuardEnv>()
    .route("/", api)
    .get(
      "*",
      // /api の下は API のルートが先に答える。ここに来たものは未知のパス
      async (c, next) => (isApiPath(c.req.path) ? c.json(notFound(), 404) : next()),
      hostCheck(getRemoteSettings),
      serveStatic({ root }),
      async (c) => c.html(await readFile(index, "utf8")),
    )
    .notFound((c) => c.json(notFound(), 404))
    .onError(onError);
}
