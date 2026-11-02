import { type TempDataDir, useTempDataDir } from "@trebuchet/db/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { app } from "../src/app.ts";
import { TEST_HOST } from "./helpers.ts";

// Host の検査がリモートの設定を auth.sqlite から読むので、一時のデータ場所を使う（実データに触れない）
let tmp: TempDataDir;
beforeEach(() => {
  tmp = useTempDataDir("server");
});
afterEach(() => tmp.cleanup());

describe("GET /api/health", () => {
  it("returns ok（認証なし。許す Host だけ付ける）", async () => {
    const res = await app.request("/api/health", { headers: { Host: TEST_HOST } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
