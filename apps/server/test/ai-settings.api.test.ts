import { openRegistry } from "@trebuchet/db";
import { type TempDataDir, useTempDataDir } from "@trebuchet/db/testing";
import type { SecretStore } from "@trebuchet/domain";
import { testClient } from "hono/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.ts";
import { AI_API_KEY_SECRET } from "../src/lib/ai-client.ts";
import type { FmServer } from "../src/lib/fm-server.ts";
import { createMemorySecretStore } from "../src/lib/keychain.ts";
import { createTestSession, errorOf, TEST_HOST, TEST_ORIGIN } from "./helpers.ts";

// 006 §7: GET・PUT /settings/ai。API キーはキーチェーン（SecretStore）にだけ入り、応答・ログ・DB に出ない。
// キーチェーン・fm は偽物（実物に触れない）

const NOW = "2026-10-31T03:00:00.000Z";
const KEY = "sk-live-super-secret-0123456789";

let tmp: TempDataDir;
beforeEach(() => {
  tmp = useTempDataDir("server-ai-settings-api");
});
afterEach(() => {
  vi.restoreAllMocks();
  tmp.cleanup();
});

const fakeFm = (available: boolean): FmServer => ({
  available: async () => available,
  ensureStarted: async () => undefined,
  stop: () => {},
});

async function setup(options: { fmAvailable?: boolean; secrets?: SecretStore } = {}) {
  const secrets = options.secrets ?? createMemorySecretStore();
  const session = await createTestSession({ now: NOW });
  const app = createApp({
    clock: { now: () => NOW },
    ai: { secrets, fm: fakeFm(options.fmAvailable ?? false) },
  });
  const client = testClient(app, undefined, undefined, {
    headers: { Host: TEST_HOST, Origin: TEST_ORIGIN, Cookie: session.cookie },
  });
  const ai = client.api.settings.ai;
  return {
    app,
    client,
    secrets,
    get: () => ai.$get(),
    put: (json: Record<string, unknown>) => ai.$put({ json: json as never }),
  };
}

const FULL = {
  localEnabled: true,
  externalEnabled: true,
  externalBaseUrl: "https://api.example.com",
  externalModel: "model-a",
  receiptImagesEnabled: false,
  apiKey: KEY,
};

/** registry の全表の全行を 1 つの文字列にする（API キーが DB のどこにもないことの確認用） */
function dumpRegistry(): string {
  const db = openRegistry().$client;
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as { name: string }[];
  return tables
    .map((t) => JSON.stringify(db.prepare(`SELECT * FROM "${t.name}"`).all()))
    .join("\n");
}

describe("GET /settings/ai", () => {
  it("既定: 端末内は有効、外部は無効、接続先・モデルは null、API キーなし。localAvailable は fm の判定", async () => {
    const off = await setup({ fmAvailable: false });
    const res = await off.get();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      localEnabled: true,
      localAvailable: false,
      externalEnabled: false,
      externalBaseUrl: null,
      externalModel: null,
      receiptImagesEnabled: false,
      apiKeySet: false,
    });
    const on = await setup({ fmAvailable: true });
    expect((await (await on.get()).json()).localAvailable).toBe(true);
  });
});

describe("PUT /settings/ai", () => {
  it("保存でき、API キーはキーチェーン（trebuchet-ai-api-key）にだけ入る。応答は apiKeySet だけで、キーそのものを含まない", async () => {
    const t = await setup();
    const res = await t.put(FULL);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({
      localEnabled: true,
      localAvailable: false,
      externalEnabled: true,
      externalBaseUrl: "https://api.example.com",
      externalModel: "model-a",
      receiptImagesEnabled: false,
      apiKeySet: true,
    });
    expect(text).not.toContain(KEY);
    expect(await t.secrets.get(AI_API_KEY_SECRET)).toBe(KEY);

    // GET にも出ない
    const again = await (await t.get()).text();
    expect(again).not.toContain(KEY);
    expect(JSON.parse(again).apiKeySet).toBe(true);
    // DB のどの表・どの列にもない
    expect(dumpRegistry()).not.toContain(KEY);
    expect(dumpRegistry()).toContain("https://api.example.com");
  });

  it("API キーをログ（console）に出さない", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    );
    const t = await setup();
    await t.put(FULL);
    await t.get();
    await t.put({ ...FULL, externalBaseUrl: "http://example.com" }); // 失敗（VALIDATION）
    await t.put({
      localEnabled: true,
      externalEnabled: true,
      receiptImagesEnabled: false,
      apiKey: KEY,
    }); // 失敗（AI_NOT_CONFIGURED）
    for (const spy of spies) {
      expect(JSON.stringify(spy.mock.calls)).not.toContain(KEY);
    }
  });

  it("外部を有効にして接続先・モデル・API キーが欠ければ 422 AI_NOT_CONFIGURED（details.fields）。何も保存しない", async () => {
    const t = await setup();
    const res = await t.put({
      localEnabled: false,
      externalEnabled: true,
      receiptImagesEnabled: false,
    });
    expect(res.status).toBe(422);
    const error = await errorOf(res);
    expect(error.code).toBe("AI_NOT_CONFIGURED");
    expect(error.details).toEqual({ fields: ["externalBaseUrl", "externalModel", "apiKey"] });

    // API キーだけが欠ける
    const noKey = await t.put({
      localEnabled: true,
      externalEnabled: true,
      externalBaseUrl: "https://api.example.com",
      externalModel: "model-a",
      receiptImagesEnabled: false,
    });
    expect(noKey.status).toBe(422);
    expect((await errorOf(noKey)).details).toEqual({ fields: ["apiKey"] });

    // 欠けた入力で、設定もキーも変わらない
    const after = await (await t.get()).json();
    expect(after.localEnabled).toBe(true);
    expect(after.externalEnabled).toBe(false);
    expect(await t.secrets.get(AI_API_KEY_SECRET)).toBeUndefined();
  });

  it("receiptImagesEnabled（010 R15）は保存され、GET・PUT の応答に出る。省略は 400 VALIDATION", async () => {
    const t = await setup();
    const res = await t.put({ ...FULL, receiptImagesEnabled: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ externalEnabled: true, receiptImagesEnabled: true });
    expect((await (await t.get()).json()).receiptImagesEnabled).toBe(true);
    expect(dumpRegistry()).toContain('"receipt_images_enabled":1');

    const { receiptImagesEnabled: _omit, ...withoutField } = FULL;
    const missing = await t.put(withoutField);
    expect(missing.status).toBe(400);
    expect((await errorOf(missing)).code).toBe("VALIDATION");
    expect((await (await t.get()).json()).receiptImagesEnabled).toBe(true);
  });

  it("保存済みの API キーがあれば、apiKey を省略して外部を有効にできる（キーは変わらない）", async () => {
    const t = await setup();
    await t.put({ ...FULL, externalEnabled: false });
    const res = await t.put({
      localEnabled: true,
      externalEnabled: true,
      externalBaseUrl: "https://api.example.com",
      externalModel: "model-b",
      receiptImagesEnabled: false,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ externalModel: "model-b" });
    expect(await t.secrets.get(AI_API_KEY_SECRET)).toBe(KEY);
  });

  it("apiKey が空文字ならキーを削除する。その後に外部を有効にしようとすると AI_NOT_CONFIGURED", async () => {
    const t = await setup();
    await t.put(FULL);
    const res = await t.put({ ...FULL, externalEnabled: false, apiKey: "" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ apiKeySet: false });
    expect(await t.secrets.get(AI_API_KEY_SECRET)).toBeUndefined();

    const enable = await t.put({ ...FULL, apiKey: undefined });
    expect(enable.status).toBe(422);
    expect((await errorOf(enable)).details).toEqual({ fields: ["apiKey"] });
  });

  it("外部が無効なら、接続先・モデルが欠けていてもよい（端末内だけの利用）", async () => {
    const t = await setup();
    const res = await t.put({
      localEnabled: false,
      externalEnabled: false,
      receiptImagesEnabled: false,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      localEnabled: false,
      externalEnabled: false,
      externalBaseUrl: null,
      externalModel: null,
    });
  });

  it("接続先の URL は https:// か localhost だけ。それ以外は 400 VALIDATION", async () => {
    const t = await setup();
    for (const url of ["http://api.example.com", "ftp://localhost", "not a url"]) {
      const res = await t.put({ ...FULL, externalBaseUrl: url });
      expect(res.status).toBe(400);
      expect((await errorOf(res)).code).toBe("VALIDATION");
    }
    for (const url of ["http://localhost:11434", "http://127.0.0.1:8080"]) {
      expect((await t.put({ ...FULL, externalBaseUrl: url })).status).toBe(200);
    }
  });

  it("キーチェーンへの保存が失敗したら 500 で、設定も変えず、キーを応答に出さない", async () => {
    const failing: SecretStore = {
      get: async () => undefined,
      set: async () => {
        throw new Error("keychain: 保存に失敗");
      },
      delete: async () => {},
    };
    const t = await setup({ secrets: failing });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await t.put(FULL);
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain(KEY);
    expect((await (await t.get()).json()).externalEnabled).toBe(false);
  });
});

describe("認証", () => {
  it("サインインしていなければ 401（GET・PUT とも）", async () => {
    const app = createApp({
      clock: { now: () => NOW },
      ai: { secrets: createMemorySecretStore() },
    });
    const headers = { Host: TEST_HOST, Origin: TEST_ORIGIN };
    const get = await app.request("/api/settings/ai", { headers });
    expect(get.status).toBe(401);
    const put = await app.request("/api/settings/ai", {
      method: "PUT",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(FULL),
    });
    expect(put.status).toBe(401);
  });
});
