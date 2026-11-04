import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DrizzleMasterRepository, openTenant, receiptsDir, tenantFile } from "@trebuchet/db";
import { type TempDataDir, useTempDataDir } from "@trebuchet/db/testing";
import { Hono } from "hono";
import { afterEach, beforeEach, expect, it } from "vitest";
import { tenant } from "../src/tenant.ts";
import { app, createTestEntity, json, testHeaders } from "./helpers.ts";

let tmp: TempDataDir;
beforeEach(() => {
  tmp = useTempDataDir("entity-lifecycle");
});
afterEach(() => tmp.cleanup());

it("進行中の操作が終わるまで完全削除を拒否する", async () => {
  const id = await createTestEntity("合成処理中");
  const started = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const busyApp = new Hono()
    .use("/entities/:entityId/*", tenant)
    .get("/entities/:entityId/busy", async (c) => {
      started.resolve();
      await finish.promise;
      return c.json({ ok: true });
    });
  const pending = busyApp.request(`/entities/${id}/busy`);
  await started.promise;
  try {
    await request(`/${id}/archive`, "POST");
    expect((await request(`/${id}/purge`, "DELETE", { name: "合成処理中" })).status).toBe(400);
    expect(existsSync(tenantFile(id))).toBe(true);
  } finally {
    finish.resolve();
    await pending;
  }
  expect((await request(`/${id}/purge`, "DELETE", { name: "合成処理中" })).status).toBe(200);
});

async function request(path: string, method = "GET", body?: object) {
  return app.request(`/api/entities${path}`, {
    method,
    headers: { ...(await testHeaders()), "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

it("非表示でデータを保持し、直接アクセスを拒否し、復元できる。他の事業体は変えない", async () => {
  const a = await createTestEntity("削除対象");
  const b = await createTestEntity("保持対象");
  expect((await request(`/${a}/archive`, "POST")).status).toBe(200);
  expect(
    (await json<{ entities: { id: string }[] }>(await request(""), 200)).entities.map((e) => e.id),
  ).toEqual([b]);
  expect((await request(`/${a}/accounts`)).status).toBe(404);
  expect(existsSync(tenantFile(a))).toBe(true);
  expect(
    (await json<{ entities: unknown[] }>(await request("/archived"), 200)).entities,
  ).toMatchObject([{ id: a, status: "archived" }]);
  expect((await request(`/${a}/restore`, "POST")).status).toBe(200);
  expect((await request(`/${a}/accounts`)).status).toBe(200);
  expect(new DrizzleMasterRepository(openTenant(b)).getProfile()?.name).toBe("保持対象");
});

it("完全削除は非表示済み・名称一致のみ。対象のDB・副ファイル・証憑だけを消す", async () => {
  const a = await createTestEntity("削除対象");
  const b = await createTestEntity("保持対象");
  for (const id of [a, b]) {
    mkdirSync(receiptsDir(id), { recursive: true });
    writeFileSync(join(receiptsDir(id), "synthetic.trc"), "synthetic");
  }
  const bProfile = new DrizzleMasterRepository(openTenant(b)).getProfile();
  expect((await request(`/${a}/purge`, "DELETE", { name: "削除対象" })).status).toBe(400);
  await request(`/${a}/archive`, "POST");
  expect((await request(`/${a}/purge`, "DELETE", { name: "別の名称" })).status).toBe(400);
  expect(existsSync(tenantFile(a))).toBe(true);
  expect((await request(`/${a}/purge`, "DELETE", { name: "削除対象" })).status).toBe(200);
  for (const suffix of ["", "-wal", "-shm", "-journal"])
    expect(existsSync(`${tenantFile(a)}${suffix}`)).toBe(false);
  expect(existsSync(receiptsDir(a))).toBe(false);
  expect(existsSync(join(receiptsDir(b), "synthetic.trc"))).toBe(true);
  expect(new DrizzleMasterRepository(openTenant(b)).getProfile()).toEqual(bProfile);
  expect((await json<{ entities: unknown[] }>(await request("/archived"), 200)).entities).toEqual(
    [],
  );
  expect((await request(`/${a}/restore`, "POST")).status).toBe(404);
});
