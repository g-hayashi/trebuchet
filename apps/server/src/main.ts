import { serve } from "@hono/node-server";
import { closeAll, TMP_ROOT } from "@trebuchet/db";
import { app } from "./app.ts";
import {
  authStore,
  backupRunner,
  backupStore,
  cleanupDemoLeftovers,
  clock,
  entityIds,
  fmServer,
  openRecurringUnitOfWork,
  vault,
} from "./deps.ts";
import { ids } from "./lib/ids.ts";
import { LOOPBACK_HOST, SERVER_PORT } from "./lib/origin.ts";
import { startBackgroundServices } from "./lib/startup.ts";
import { resolveWebDist, withWebDist } from "./static.ts";

// 008 の D7: 起動時は auth.sqlite だけを開き、セッションを全部消す（再起動で DK が消えたので、
// 残ったセッションは使えない）。registry と事業体の DB は解錠まで開かない
await authStore().deleteAllSessions();

// R13: 認証を入れるまではループバックだけで待ち受ける
const hostname = LOOPBACK_HOST;
const port = SERVER_PORT;

// ビルド済みの web があれば /api の外に配信する（004 R3。TREBUCHET_WEB_DIST、既定 apps/web/dist）。
// Host の検査のリモートの設定は、API と同じく要求ごとに auth.sqlite から読む
const webDist = resolveWebDist();
const handler = webDist
  ? withWebDist(app, { dist: webDist, getRemoteSettings: () => authStore().getRemoteSettings() })
  : app;

const server = serve({ fetch: handler.fetch, hostname, port }, (info) => {
  console.log(`server listening on http://${info.address}:${info.port}`);
  console.log(webDist ? `serving web from ${webDist}` : "web dist not found: API only");
  // パスキーの RP ID は localhost だけなので、127.0.0.1 ではなく localhost で開くよう案内する
  if (webDist)
    console.log(`open http://localhost:${info.port} (passkeys do not work on 127.0.0.1)`);
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
  // 投入中のまま落ちたデモ事業（014 R2）。registry を開けるのは解錠の後
  onUnlock: () => {
    const { failed } = cleanupDemoLeftovers();
    if (failed > 0) console.error(`デモ事業の作りかけを ${failed} 件消せませんでした`);
  },
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
