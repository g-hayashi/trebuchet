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
  vault,
} from "./deps.ts";
import { startBackgroundServices } from "./lib/startup.ts";

// 008 の D7: 起動時は auth.sqlite だけを開き、セッションを全部消す（再起動で DK が消えたので、
// 残ったセッションは使えない）。registry と事業体の DB は解錠まで開かない
await authStore().deleteAllSessions();

// R13: 認証を入れるまではループバックだけで待ち受ける
const hostname = "127.0.0.1";
const port = 8787;

const server = serve({ fetch: app.fetch, hostname, port }, (info) => {
  console.log(`server listening on http://${info.address}:${info.port}`);
});

// 古い平文の写しの掃除（004 R9）。自動のバックアップ（004 R10）と定期仕訳の自動登録（005 R18）は
// 解錠で始め、施錠で止める（008 の D7）。セッションがなくなったら施錠する（008 の D3）
const background = startBackgroundServices({
  runner: backupRunner,
  auth: authStore,
  backups: backupStore,
  clock,
  tmpRoot: TMP_ROOT,
  recurring: { entities: entityIds, openUnitOfWork: openRecurringUnitOfWork, ids },
  fm: fmServer,
  vault,
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    background.stop();
    server.close(() => {
      void vault.lock().finally(() => {
        closeAll();
        process.exit(0);
      });
    });
  });
}
