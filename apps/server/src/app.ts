import type { AuthStore, BackupStore, Clock, SecretStore } from "@trebuchet/domain";
import { Hono } from "hono";
import {
  authStore,
  backupRunner,
  backupStore,
  clock as defaultClock,
  secretStore,
} from "./deps.ts";
import { onError } from "./errors.ts";
import type { BackupRunner } from "./lib/backup-run.ts";
import { ChallengeStore } from "./lib/challenges.ts";
import { type GetRemoteSettings, getRemoteSettingsDisabled } from "./lib/origin.ts";
import type { WebAuthnVerifier } from "./lib/webauthn.ts";
import { simpleWebAuthnVerifier } from "./lib/webauthn-simplewebauthn.ts";
import { authCheck } from "./middleware/auth.ts";
import { csrfCheck } from "./middleware/csrf.ts";
import { type GuardEnv, hostCheck } from "./middleware/host.ts";
import { authRoutes } from "./routes/auth.ts";
import { backupRoutes } from "./routes/backup.ts";
import { blueReturnRoutes } from "./routes/blue-return.ts";
import { entitiesRoutes, entityRoutes } from "./routes/entities.ts";
import { fixedAssetRoutes } from "./routes/fixed-assets.ts";
import { importRoutes } from "./routes/imports.ts";
import { journalRoutes } from "./routes/journals.ts";
import { masterRoutes } from "./routes/masters.ts";
import { periodRoutes } from "./routes/periods.ts";
import { reportRoutes } from "./routes/reports.ts";
import { taxReturnRoutes } from "./routes/tax-return.ts";
import { type TenantEnv, tenant } from "./tenant.ts";

const tenantRoutes = new Hono<TenantEnv>()
  .use(tenant)
  .route("/", entityRoutes)
  .route("/", masterRoutes)
  .route("/", periodRoutes)
  .route("/", journalRoutes)
  .route("/", reportRoutes)
  .route("/", importRoutes)
  .route("/", blueReturnRoutes)
  .route("/", fixedAssetRoutes)
  .route("/", taxReturnRoutes);

export type AppOptions = {
  /** リモート（ts.net）の設定の読み込み。既定は無効。T016 が app_settings からの読み込みを渡す */
  getRemoteSettings?: GetRemoteSettings;
  store?: () => AuthStore;
  clock?: Clock;
  /** WebAuthn の検証。既定は @simplewebauthn/server。ルートのテストは偽物を渡す */
  webauthn?: WebAuthnVerifier;
  /** バックアップの依存（既定は deps.ts の実物）。テストは偽の SecretStore・実行を渡す */
  backup?: {
    runner?: BackupRunner;
    secrets?: SecretStore;
    store?: () => BackupStore;
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
      }),
    )
    .route("/entities", entitiesRoutes)
    .route("/entities/:entityId", tenantRoutes);

  app.onError(onError);
  return app;
}

export const app = createApp();

export type AppType = typeof app;
