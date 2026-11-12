import { defineConfig } from "@playwright/test";
import { MANUAL_DESKTOP_VIEWPORT } from "./e2e/helpers/viewports.ts";
import base from "./playwright.config.ts";

const webServers = Array.isArray(base.webServer) ? base.webServer : [];

export default defineConfig({
  ...base,
  webServer: webServers.map((server) => ({
    ...server,
    env: {
      ...server.env,
      TREBUCHET_DEFAULT_BACKUP_DIR: `${process.env.TREBUCHET_E2E_DATA_DIR}/backups`,
    },
  })),
  testMatch: "manual.capture.ts",
  timeout: 240_000,
  use: { ...base.use, viewport: MANUAL_DESKTOP_VIEWPORT, trace: "off", actionTimeout: 8_000 },
});
