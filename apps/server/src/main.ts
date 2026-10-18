import { serve } from "@hono/node-server";
import { closeAll } from "@trebuchet/db";
import { app } from "./app.ts";

// R13: 認証を入れるまではループバックだけで待ち受ける
const hostname = "127.0.0.1";
const port = 8787;

const server = serve({ fetch: app.fetch, hostname, port }, (info) => {
  console.log(`server listening on http://${info.address}:${info.port}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => {
      closeAll();
      process.exit(0);
    });
  });
}
