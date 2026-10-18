import { randomUUIDv7 } from "node:crypto";
import { type TempDataDir, useTempDataDir } from "@trebuchet/db/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { app } from "../src/app.ts";

let tmp: TempDataDir;
beforeEach(() => {
  tmp = useTempDataDir("server");
});
afterEach(() => tmp.cleanup());

describe("テナントのミドルウェア", () => {
  it("存在しない entityId は 404 ENTITY_NOT_FOUND", async () => {
    const res = await app.request(`/api/entities/${randomUUIDv7()}/accounts`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ENTITY_NOT_FOUND");
  });

  it.each(["not-a-uuid", "..%2Fx", "x%00"])("不正な形式の entityId %s も 404", async (id) => {
    const res = await app.request(`/api/entities/${id}/accounts`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ENTITY_NOT_FOUND");
  });

  it("パスの正規化で上の階層に出る指定（%2E%2E）はテナントに届かず 404", async () => {
    const res = await app.request("/api/entities/%2E%2E/accounts");
    expect(res.status).toBe(404);
  });

  it("存在しない事業体のために DB ファイルを作らない", async () => {
    const { existsSync } = await import("node:fs");
    const { tenantFile } = await import("@trebuchet/db");
    const id = randomUUIDv7();
    await app.request(`/api/entities/${id}/accounts`);
    expect(existsSync(tenantFile(id))).toBe(false);
  });
});
