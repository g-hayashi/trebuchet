import { defineConfig } from "@playwright/test";
import base from "./playwright.config.ts";

// 宣伝動画の録画（`pnpm promo:record`。言語は環境変数 PROMO_LANG=ja|en）。
// 画面は日本語のまま（locale は変えない）。録画の大きさは e2e/promo.capture.ts が context で決める
export default defineConfig({
  ...base,
  testMatch: "promo.capture.ts",
  timeout: 300_000,
  use: {
    ...base.use,
    viewport: { width: 1280, height: 720 },
    trace: "off",
    actionTimeout: 15_000,
  },
});
