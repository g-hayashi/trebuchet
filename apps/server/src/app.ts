import type { AuthStore, BackupStore, Clock, SecretStore } from "@trebuchet/domain";
import { Hono } from "hono";
import {
  aiSettingsStore,
  authStore,
  backupRunner,
  backupStore,
  clock as defaultClock,
  vault as defaultVault,
  fmServer,
  type RouteOptions,
  type SuggestionProviders,
  secretStore,
} from "./deps.ts";
import { onError } from "./errors.ts";
import { type AiRuntime, type AiSettingsStore, createAiRuntime } from "./lib/ai-runtime.ts";
import type { BackupRunner } from "./lib/backup-run.ts";
import { ChallengeStore } from "./lib/challenges.ts";
import type { FmServer } from "./lib/fm-server.ts";
import { createJobStore, type JobStore } from "./lib/jobs.ts";
import { type GetRemoteSettings, getRemoteSettingsDisabled } from "./lib/origin.ts";
import type { Vault } from "./lib/vault.ts";
import type { WebAuthnVerifier } from "./lib/webauthn.ts";
import { simpleWebAuthnVerifier } from "./lib/webauthn-simplewebauthn.ts";
import { authCheck } from "./middleware/auth.ts";
import { csrfCheck } from "./middleware/csrf.ts";
import { type GuardEnv, hostCheck } from "./middleware/host.ts";
import { aiSettingsRoutes } from "./routes/ai-settings.ts";
import { authRoutes } from "./routes/auth.ts";
import { backupRoutes } from "./routes/backup.ts";
import { blueReturnRoutes } from "./routes/blue-return.ts";
import { deferredAssetRoutes } from "./routes/deferred-assets.ts";
import { entitiesRoutes, entityRoutes } from "./routes/entities.ts";
import { fixedAssetRoutes } from "./routes/fixed-assets.ts";
import { importRoutes } from "./routes/imports.ts";
import { invoicingRoutes } from "./routes/invoicing.ts";
import { journalRoutes } from "./routes/journals.ts";
import { masterRoutes } from "./routes/masters.ts";
import { periodRoutes } from "./routes/periods.ts";
import { recurringRoutes } from "./routes/recurring.ts";
import { reportRoutes } from "./routes/reports.ts";
import { statementRoutes } from "./routes/statements.ts";
import { taxReturnRoutes } from "./routes/tax-return.ts";
import { type TenantEnv, tenant } from "./tenant.ts";

/**
 * 事業体の下のルート。時刻（更新日時・「今日」）を使うルートは clock を受け取るので、
 * `createApp` の中で組み立てる（005 R22）。全ルートに同じ clock が渡る
 */
function tenantRoutes(
  options: RouteOptions & {
    suggestion?: SuggestionProviders;
    jobs: JobStore;
    ai: AiRuntime;
  },
) {
  return new Hono<TenantEnv>()
    .use(tenant)
    .route("/", entityRoutes)
    .route("/", masterRoutes(options))
    .route("/", periodRoutes(options))
    .route("/", journalRoutes(options))
    .route("/", reportRoutes)
    .route("/", importRoutes(options))
    .route("/", blueReturnRoutes(options))
    .route("/", fixedAssetRoutes(options))
    .route("/", deferredAssetRoutes(options))
    .route("/", taxReturnRoutes(options))
    .route("/", invoicingRoutes(options))
    .route("/", recurringRoutes(options))
    .route("/", statementRoutes(options));
}

export type AppOptions = {
  /** リモート（ts.net）の設定の読み込み。既定は無効。T016 が app_settings からの読み込みを渡す */
  getRemoteSettings?: GetRemoteSettings;
  store?: () => AuthStore;
  clock?: Clock;
  /** AI の推定の差し替え（006）。省略すると `ai` の設定から作った端末内・外部の実物を使う */
  suggestion?: SuggestionProviders;
  /** AI の依存（006 R10・R12）。既定は deps.ts の実物（fetch、キーチェーン、registry の ai_settings、`fm serve`） */
  ai?: {
    fetch?: typeof fetch;
    secrets?: SecretStore;
    settings?: () => AiSettingsStore;
    fm?: FmServer;
  };
  /** 評価のジョブの置き場（006 R17）。既定はこのアプリ専用の置き場 */
  jobs?: JobStore;
  /** WebAuthn の検証。既定は @simplewebauthn/server。ルートのテストは偽物を渡す */
  webauthn?: WebAuthnVerifier;
  /** 解錠中の DK（008 の D3）。既定は deps.ts の vault（背景の処理が解錠・施錠を受け取る） */
  vault?: Vault;
  /** 回復キーの失敗ごとの遅延（008 の D5）。既定は 1 秒待つ。テストは待たない関数を渡す */
  recoveryDelay?: (ms: number) => Promise<void>;
  /** バックアップの依存（既定は deps.ts の実物）。テストは偽の実行を渡す */
  backup?: {
    runner?: BackupRunner;
    store?: () => BackupStore;
    /** 検査のファイルの上限（テストが小さくする） */
    inspectMaxBytes?: number;
  };
};

/**
 * `/api` の全ルートに、research R6 の順（Host → CSRF → 認証）で検査を掛けたアプリ。
 * テストは `createApp()` で新しいアプリを作ってダミーのルートを足せる
 */
export function createApp(options: AppOptions = {}) {
  const getRemoteSettings = options.getRemoteSettings ?? getRemoteSettingsDisabled;
  const store = options.store ?? authStore;
  const clock = options.clock ?? defaultClock;
  const vault = options.vault ?? defaultVault;
  const jobs = options.jobs ?? createJobStore();
  const ai = createAiRuntime({
    fetch: options.ai?.fetch ?? ((...args) => globalThis.fetch(...args)),
    secrets: options.ai?.secrets ?? secretStore,
    settings: options.ai?.settings ?? aiSettingsStore,
    fm: options.ai?.fm ?? fmServer,
  });
  const app = new Hono<GuardEnv>()
    .basePath("/api")
    .use(hostCheck(getRemoteSettings))
    .use(csrfCheck)
    .use(authCheck(store, clock, vault))
    .get("/health", (c) => c.json({ ok: true }))
    .route(
      "/auth",
      authRoutes({
        store,
        clock,
        webauthn: options.webauthn ?? simpleWebAuthnVerifier,
        challenges: new ChallengeStore(clock),
        vault,
        ...(options.recoveryDelay === undefined ? {} : { delay: options.recoveryDelay }),
      }),
    )
    .route(
      "/backup",
      backupRoutes({
        auth: store,
        backups: options.backup?.store ?? backupStore,
        runner: options.backup?.runner ?? backupRunner,
        clock,
        ...(options.backup?.inspectMaxBytes === undefined
          ? {}
          : { inspectMaxBytes: options.backup.inspectMaxBytes }),
      }),
    )
    .route("/settings", aiSettingsRoutes({ clock, ai }))
    .route("/entities", entitiesRoutes({ clock }))
    .route(
      "/entities/:entityId",
      tenantRoutes({
        clock,
        jobs,
        ai,
        ...(options.suggestion === undefined ? {} : { suggestion: options.suggestion }),
      }),
    );

  app.onError(onError);
  return app;
}

export const app = createApp();

export type AppType = typeof app;
