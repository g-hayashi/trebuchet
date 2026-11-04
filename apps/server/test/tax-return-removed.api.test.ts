import { type TempDataDir, useTempDataDir } from "@trebuchet/db/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { app, createTestEntity } from "./helpers.ts";

/** 申告の控えと提出書類の記録の API は 011（FR-042、research R14）で消した。決算書の API は残る */
let tmp: TempDataDir;
let entityId: string;

beforeEach(async () => {
  tmp = useTempDataDir("server-tax-return-removed");
  entityId = await createTestEntity();
});
afterEach(() => tmp.cleanup());

const base = () => `/api/entities/${entityId}/tax-return/2026`;
const jsonInit = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

describe("消した /tax-return/:year/... は 404（FR-042）", () => {
  it.each([
    ["GET", "/memos", undefined],
    ["POST", "/memos", { kind: "salary" }],
    ["PUT", "/memos/m1", { kind: "salary" }],
    ["DELETE", "/memos/m1", undefined],
    ["GET", "/documents", undefined],
    ["POST", "/documents", { kind: "other", filePath: "/a" }],
    ["PUT", "/documents/d1", { kind: "other", filePath: "/a" }],
    ["DELETE", "/documents/d1", undefined],
  ] as const)("%s %s", async (method, path, body) => {
    const res = await app.request(
      `${base()}${path}`,
      body === undefined ? { method } : jsonInit(method, body),
    );
    expect(res.status).toBe(404);
  });

  it("決算書の API は残っている", async () => {
    const res = await app.request(`/api/entities/${entityId}/blue-return/2026`);
    expect(res.status).toBe(200);
  });
});
