import { type AuthStore, type Clock, domainError } from "@trebuchet/domain";
import { RemoteSettings, RemoteSettingsInput, TailscaleServeInput } from "@trebuchet/schema";
import { Hono } from "hono";
import { DomainException, fail } from "../errors.ts";
import { ids } from "../lib/ids.ts";
import { isLocalHost, rpIdFor } from "../lib/origin.ts";
import { type TailscaleCli, TailscaleError } from "../lib/tailscale.ts";
import type { GuardEnv } from "../middleware/host.ts";
import { validate } from "../validator.ts";

/** tailscale の CLI の失敗（型つき）をドメインのエラーに写す（503 / 502）。stderr は含めない */
async function viaTailscale<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    if (e instanceof TailscaleError) {
      throw new DomainException(domainError(e.code, e.message));
    }
    throw e;
  }
}

/**
 * `/api/settings` の下のリモート（Tailscale）の設定（contracts/http-api.md、FR-010・011）。
 * 全権のセッションと解錠中の操作（認証の middleware が掛かる）。設定は auth.sqlite に置き、
 * 変更は `auth_events` の `remote_settings_changed` に残す。Host の検査は要求ごとに設定を読み直す。
 * `remote/tailscale*` は tailscale の CLI で serve の状態を見て開始・停止する（localhost の Host だけ）
 */
export function remoteSettingsRoutes({
  store,
  clock,
  tailscale,
}: {
  store: () => AuthStore;
  clock: Clock;
  tailscale: TailscaleCli;
}) {
  const requireLocal = (host: string | undefined) => {
    if (!isLocalHost(host)) {
      throw new DomainException(
        domainError(
          "HOST_NOT_ALLOWED",
          "Tailscale の操作は、この Mac の localhost からだけできます",
        ),
      );
    }
  };

  return new Hono<GuardEnv>()
    .get("/remote", async (c) => c.json(await store().getRemoteSettings(), 200))
    .get("/remote/tailscale", async (c) => {
      requireLocal(c.var.host);
      return c.json(await viaTailscale(() => tailscale.status()), 200);
    })
    .put("/remote/tailscale/serve", validate("json", TailscaleServeInput), async (c) => {
      requireLocal(c.var.host);
      const { enabled } = c.req.valid("json");
      const status = await viaTailscale(async () => {
        if (enabled) await tailscale.startServe();
        else await tailscale.stopServe();
        return tailscale.status();
      });
      return c.json(status, 200);
    })
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
