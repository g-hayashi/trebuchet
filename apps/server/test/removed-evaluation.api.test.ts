import { type TempDataDir, useTempDataDir } from "@trebuchet/db/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { createTestEntity, createTestSession, TEST_HOST, TEST_ORIGIN } from "./helpers.ts";

let tmp: TempDataDir;
beforeEach(() => {
  tmp = useTempDataDir("removed-evaluation-api");
});
afterEach(() => tmp.cleanup());

describe("011 T019 削除した評価 API", () => {
  it.each([
    ["GET", "statements/evals"],
    ["POST", "statements/evals"],
    ["GET", "jobs/0191f5a0-0000-7000-8000-000000000000"],
  ])("解錠・認証済みでも %s %s は 404", async (method, path) => {
    const entityId = await createTestEntity();
    const session = await createTestSession();
    const app = createApp();
    expect(app.routes.some((route) => route.path.includes("/jobs/"))).toBe(false);
    const response = await app.request(`/api/entities/${entityId}/${path}`, {
      method,
      headers: {
        Host: TEST_HOST,
        Origin: TEST_ORIGIN,
        Cookie: session.cookie,
        "Content-Type": "application/json",
      },
      ...(method === "POST" ? { body: "{}" } : {}),
    });
    expect(response.status).toBe(404);
  });
});
