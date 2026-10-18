import { serve } from "@hono/node-server";
import { app } from "./app.ts";

const hostname = "127.0.0.1";
const port = 8787;

serve({ fetch: app.fetch, hostname, port }, (info) => {
  console.log(`server listening on http://${info.address}:${info.port}`);
});
