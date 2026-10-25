import type { CryptoOptions } from "@trebuchet/db";
import type { AuthStore, BackupStore, Clock, SecretStore } from "@trebuchet/domain";
import { Hono } from "hono";
import {
  authStore,
  backupRunner,
  backupStore,
  clock as defaultClock,
  type RouteOptions,
  type SuggestionProviders,
  secretStore,
} from "./deps.ts";
import { onError } from "./errors.ts";
import type { BackupRunner } from "./lib/backup-run.ts";
import { ChallengeStore } from "./lib/challenges.ts";
import { createJobStore, type JobStore, type MfmeFetcher } from "./lib/jobs.ts";
import { playwrightFetcher } from "./lib/mfme/fetcher.ts";
import { type GetRemoteSettings, getRemoteSettingsDisabled } from "./lib/origin.ts";
import type { WebAuthnVerifier } from "./lib/webauthn.ts";
import { simpleWebAuthnVerifier } from "./lib/webauthn-simplewebauthn.ts";
import { authCheck } from "./middleware/auth.ts";
import { csrfCheck } from "./middleware/csrf.ts";
import { type GuardEnv, hostCheck } from "./middleware/host.ts";
import { aiSettingsRoutes } from "./routes/ai-settings.ts";
import { authRoutes } from "./routes/auth.ts";
import { backupRoutes } from "./routes/backup.ts";
import { blueReturnRoutes } from "./routes/blue-return.ts";
import { entitiesRoutes, entityRoutes } from "./routes/entities.ts";
import { fixedAssetRoutes } from "./routes/fixed-assets.ts";
import { importRoutes } from "./routes/imports.ts";
import { invoicingRoutes } from "./routes/invoicing.ts";
import { journalRoutes } from "./routes/journals.ts";
import { masterRoutes } from "./routes/masters.ts";
import { periodRoutes } from "./routes/periods.ts";
import { recurringRoutes } from "./routes/recurring.ts";
import { reportRoutes } from "./routes/reports.ts";
import { type MfmeOptions, statementRoutes } from "./routes/statements.ts";
import { taxReturnRoutes } from "./routes/tax-return.ts";
import { type TenantEnv, tenant } from "./tenant.ts";

/**
 * 事業体の下のルート。時刻（更新日時・「今日」）を使うルートは clock を受け取るので、
 * `createApp` の中で組み立てる（005 R22）。全ルートに同じ clock が渡る
 */
function tenantRoutes(
  options: RouteOptions & { suggestion?: SuggestionProviders; mfme: MfmeOptions },
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
  /** AI の推定（006）。既定は「使えない」。実物は T025 で main が渡す */
  suggestion?: SuggestionProviders;
  /** MF ME の取得（006 US4）。既定は Playwright の取得器と、このアプリ専用のジョブの置き場 */
  mfme?: { fetcher?: MfmeFetcher; jobs?: JobStore };
  /** WebAuthn の検証。既定は @simplewebauthn/server。ルートのテストは偽物を渡す */
  webauthn?: WebAuthnVerifier;
  /** バックアップの依存（既定は deps.ts の実物）。テストは偽の SecretStore・実行を渡す */
  backup?: {
    runner?: BackupRunner;
    secrets?: SecretStore;
    store?: () => BackupStore;
    /** 検査のファイルの上限（テストが小さくする） */
    inspectMaxBytes?: number;
    /** テストが鍵導出を軽くするための差し替え */
    crypto?: CryptoOptions;
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
  const mfme: MfmeOptions = {
    fetcher: options.mfme?.fetcher ?? playwrightFetcher,
    jobs: options.mfme?.jobs ?? createJobStore(),
  };
  const app = new Hono<GuardEnv>()
    .basePath("/api")
    .use(hostCheck(getRemoteSettings))
    .use(csrfCheck)
    .use(authCheck(store, clock))
    .get("/health", (c) => c.json({ ok: true }))
    .route(
      "/auth",
      authRoutes({
        store,
        clock,
        webauthn: options.webauthn ?? simpleWebAuthnVerifier,
        challenges: new ChallengeStore(clock),
      }),
    )
    .route(
      "/backup",
      backupRoutes({
        auth: store,
        backups: options.backup?.store ?? backupStore,
        secrets: options.backup?.secrets ?? secretStore,
        runner: options.backup?.runner ?? backupRunner,
        clock,
        ...(options.backup?.inspectMaxBytes === undefined
          ? {}
          : { inspectMaxBytes: options.backup.inspectMaxBytes }),
        ...(options.backup?.crypto === undefined ? {} : { crypto: options.backup.crypto }),
      }),
    )
    .route("/settings", aiSettingsRoutes({ clock }))
    .route("/entities", entitiesRoutes({ clock }))
    .route(
      "/entities/:entityId",
      tenantRoutes({
        clock,
        mfme,
        ...(options.suggestion === undefined ? {} : { suggestion: options.suggestion }),
      }),
    );

  app.onError(onError);
  return app;
}

export const app = createApp();

export type AppType = typeof app;
