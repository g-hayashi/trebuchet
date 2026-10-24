import { describe, expect, it } from "vitest";
import { app } from "../src/app.ts";
import { TEST_HOST } from "./helpers.ts";

describe("GET /api/health", () => {
  it("returns ok（認証なし。許す Host だけ付ける）", async () => {
    const res = await app.request("/api/health", { headers: { Host: TEST_HOST } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
