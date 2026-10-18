import { testClient } from "hono/testing";
import { app } from "../src/app.ts";

export const client = testClient(app);

export type ErrorBody = { error: { code: string; message: string; details?: unknown } };

/** テスト用の事業体を作成し、その ID を返す */
export async function createTestEntity(name = "個人事業"): Promise<string> {
  const res = await client.api.entities.$post({
    json: { name, kind: "individual", fiscalStartMonth: 1, firstFiscalYear: 2026 },
  });
  if (res.status !== 201) throw new Error(`entity create failed: ${res.status}`);
  const body = await res.json();
  return body.entity.id;
}

export async function errorOf(res: { json(): Promise<unknown> }): Promise<ErrorBody["error"]> {
  return ((await res.json()) as ErrorBody).error;
}
