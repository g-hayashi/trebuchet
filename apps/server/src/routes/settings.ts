import { type AuthStore, type Clock, domainError } from "@trebuchet/domain";
import { RemoteSettings, RemoteSettingsInput } from "@trebuchet/schema";
import { Hono } from "hono";
import { ids } from "../deps.ts";
import { fail } from "../errors.ts";
import { rpIdFor } from "../lib/origin.ts";
import type { GuardEnv } from "../middleware/host.ts";
import { validate } from "../validator.ts";

/**
 * `/api/settings` の下のリモート（Tailscale）の設定（contracts/http-api.md、FR-010・011）。
 * 全権のセッションと解錠中の操作（認証の middleware が掛かる）。設定は auth.sqlite に置き、
 * 変更は `auth_events` の `remote_settings_changed` に残す。Host の検査は要求ごとに設定を読み直す
 */
export function remoteSettingsRoutes({ store, clock }: { store: () => AuthStore; clock: Clock }) {
  return new Hono<GuardEnv>()
    .get("/remote", async (c) => c.json(await store().getRemoteSettings(), 200))
    .put("/remote", validate("json", RemoteSettingsInput), async (c) => {
      const parsed = RemoteSettings.safeParse(c.req.valid("json"));
      if (!parsed.success) {
        return fail(
          c,
          domainError(
            "REMOTE_HOST_INVALID",
            parsed.error.issues[0]?.message ?? "*.ts.net の形で入力してください",
          ),
        );
      }
      const settings = parsed.data;
      const now = clock.now();
      const auth = store();
      await auth.setRemoteSettings(settings, now);
      await auth.appendEvent({
        id: ids.next(),
        occurredAt: now,
        kind: "remote_settings_changed",
        rpId: rpIdFor(c.var.host, c.var.remote) ?? null,
        sessionId: c.var.session?.id ?? null,
        userAgent: c.req.header("user-agent") ?? null,
        detail: { enabled: settings.enabled, host: settings.host },
      });
      return c.json(settings, 200);
    });
}
