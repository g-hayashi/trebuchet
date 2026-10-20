import type { Session } from "@trebuchet/domain";
import { createMiddleware } from "hono/factory";
import { DomainException } from "../errors.ts";
import {
  type GetRemoteSettings,
  isAllowedHost,
  type RemoteSettings,
  requestHost,
} from "../lib/origin.ts";

/** 全ルートの検査（Host → CSRF → 認証）が共有する変数 */
export type GuardEnv = {
  Variables: {
    /** 検査を通った接続先の名前（`requestHost`） */
    host: string;
    remote: RemoteSettings;
    /** 認証を通った（または回復用の手続きで必要な）セッション */
    session?: Session;
  };
};

/** 検査 1: 許す Host か（DNS rebinding の対策、FR-011）。許さなければ 421 HOST_NOT_ALLOWED */
export const hostCheck = (getRemoteSettings: GetRemoteSettings) =>
  createMiddleware<GuardEnv>(async (c, next) => {
    const remote = await getRemoteSettings();
    const host = requestHost(c.req);
    if (host === undefined || !isAllowedHost(host, remote)) {
      throw new DomainException({
        code: "HOST_NOT_ALLOWED",
        message: "この接続先からは使えません",
      });
    }
    c.set("host", host);
    c.set("remote", remote);
    await next();
  });
