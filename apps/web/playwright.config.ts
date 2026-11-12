import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { defineConfig, devices } from "@playwright/test";
import { SERVER_HEALTH_URL, TMP_ROOT, WEB_ORIGIN } from "./e2e/env.ts";

const repoRoot = resolve(import.meta.dirname, "../..");

// ワーカーでも設定が読み込まれるので、データの置き場所は環境変数で引き継いで1回の実行で1つにする
process.env.TREBUCHET_E2E_DATA_DIR ??= join(TMP_ROOT, `e2e-${randomUUID()}`);
const dataDir = process.env.TREBUCHET_E2E_DATA_DIR;

const baseURL = WEB_ORIGIN;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  reporter: "list",
  globalTeardown: "./e2e/global-teardown.ts",
  use: {
    baseURL,
    locale: "ja-JP",
    timezoneId: "Asia/Tokyo",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      name: "server",
      command: "node apps/server/src/main.ts",
      cwd: repoRoot,
      env: { TREBUCHET_DATA_DIR: dataDir },
      url: SERVER_HEALTH_URL,
      reuseExistingServer: false,
      gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
    },
    {
      name: "web",
      command: "pnpm exec vite --strictPort",
      url: baseURL,
      reuseExistingServer: false,
    },
  ],
});
