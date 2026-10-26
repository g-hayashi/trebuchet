import { serve } from "@hono/node-server";
import { closeAll, TMP_ROOT } from "@trebuchet/db";
import { app } from "./app.ts";
import {
  authStore,
  backupRunner,
  backupStore,
  clock,
  entityIds,
  fmServer,
  ids,
  openRecurringUnitOfWork,
  secretStore,
} from "./deps.ts";
import { startBackgroundServices } from "./lib/startup.ts";

// R13: 認証を入れるまではループバックだけで待ち受ける
const hostname = "127.0.0.1";
const port = 8787;

const server = serve({ fetch: app.fetch, hostname, port }, (info) => {
  console.log(`server listening on http://${info.address}:${info.port}`);
});

// 古い平文の写しの掃除と、自動のバックアップ（004 R9・R10）、定期仕訳の自動登録（005 R18）
const background = startBackgroundServices({
  runner: backupRunner,
  auth: authStore,
  backups: backupStore,
  secrets: secretStore,
  clock,
  tmpRoot: TMP_ROOT,
  recurring: { entities: entityIds, openUnitOfWork: openRecurringUnitOfWork, ids },
  fm: fmServer,
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    background.stop();
    server.close(() => {
      closeAll();
      process.exit(0);
    });
  });
}
