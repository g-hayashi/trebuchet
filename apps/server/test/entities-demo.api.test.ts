import { clearDataKey, DrizzleRegistryRepository, openRegistry } from "@trebuchet/db";
import { type TempDataDir, useTempDataDir } from "@trebuchet/db/testing";
import { type DemoAssets, ok, type ReceiptImageTool } from "@trebuchet/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp, app as realApp } from "../src/app.ts";
import {
  app,
  createTestEntity,
  createTestSession,
  errorOf,
  makeClock,
  TEST_HOST,
  TEST_ORIGIN,
  testHeaders,
} from "./helpers.ts";

// 014 T005: POST /api/entities/demo（contracts/http-api.md、R4・R6）。AI は呼ばない。画像は server に同梱した合成のもの

let tmp: TempDataDir;
beforeEach(() => {
  tmp = useTempDataDir("server-entities-demo");
});
afterEach(() => tmp.cleanup());

const clock = makeClock("2026-11-08T03:00:00.000Z");

const post = () => app.request("/api/entities/demo", { method: "POST" });
const get = async (path: string) => {
  const res = await app.request(path);
  expect(res.status, path).toBe(200);
  return (await res.json()) as Record<string, unknown>;
};

describe("POST /api/entities/demo", () => {
  it("空のデータ場所で 201。demo: true の事業体ができ、各画面の API で件数が 0 より多く、試算表の貸借が一致する", async () => {
    const res = await post();
    expect(res.status).toBe(201);
    const { entity } = (await res.json()) as { entity: { id: string; demo: boolean } };
    expect(entity.demo).toBe(true);

    const base = `/api/entities/${entity.id}`;
    const nonEmpty = async (path: string, key: string) => {
      const body = await get(`${base}${path}`);
      const list = body[key];
      expect(Array.isArray(list), `${path}.${key}`).toBe(true);
      expect((list as unknown[]).length, `${path}.${key}`).toBeGreaterThan(0);
    };
    await nonEmpty("/journals", "journals");
    await nonEmpty("/partners", "partners");
    await nonEmpty("/invoices", "invoices");
    await nonEmpty("/recurring-journals", "recurring");
    await nonEmpty("/fixed-assets", "assets");
    await nonEmpty("/deferred-assets", "deferredAssets");
    await nonEmpty("/receipts", "receipts");
    await nonEmpty("/statements", "statements");

    const periods = (await get(`${base}/fiscal-periods`)) as {
      fiscalPeriods: { startDate: string; endDate: string }[];
    };
    const period = periods.fiscalPeriods[0];
    if (period === undefined) throw new Error("会計期間がない");
    const trial = (await get(
      `${base}/reports/trial-balance?from=${period.startDate}&to=${period.endDate}`,
    )) as { balanced: boolean; totals: { debit: number; credit: number } };
    expect(trial.balanced).toBe(true);
    expect(trial.totals.debit).toBe(trial.totals.credit);
    expect(trial.totals.debit).toBeGreaterThan(0);

    const list = (await get("/api/entities")) as { entities: { id: string; demo: boolean }[] };
    expect(list.entities).toEqual([expect.objectContaining({ id: entity.id, demo: true })]);
  });

  it("事業体があると 409 DEMO_NOT_AVAILABLE で、何も作らない", async () => {
    await createTestEntity();
    const res = await post();
    expect(res.status).toBe(409);
    expect((await errorOf(res)).code).toBe("DEMO_NOT_AVAILABLE");
    const list = (await get("/api/entities")) as { entities: unknown[] };
    expect(list.entities).toHaveLength(1);
  });

  it("同時の 2 回目は 409 DEMO_NOT_AVAILABLE（事業体は 1 つだけ）", async () => {
    const [a, b] = await Promise.all([post(), post()]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    const loser = a.status === 409 ? a : b;
    expect((await errorOf(loser)).code).toBe("DEMO_NOT_AVAILABLE");
    const list = (await get("/api/entities")) as { entities: unknown[] };
    expect(list.entities).toHaveLength(1);
  });

  it("作成日（clock）から会計年度が決まる", async () => {
    const dated = createApp({ clock });
    const res = await dated.request("/api/entities/demo", {
      method: "POST",
      headers: await testHeaders(),
    });
    expect(res.status).toBe(201);
    const { entity } = (await res.json()) as { entity: { id: string } };
    const periods = await get(`/api/entities/${entity.id}/fiscal-periods`);
    expect(periods.fiscalPeriods).toEqual([expect.objectContaining({ fiscalYear: 2026 })]);
  });

  it("証憑の画像の寸法を imageTool.probe で調べて、証憑のファイルに保存する。調べられなくても作れる", async () => {
    const seen: string[] = [];
    let calls = 0;
    const imageTool: ReceiptImageTool = {
      probe: async (_bytes, mediaType) => {
        seen.push(mediaType);
        calls += 1;
        if (calls === 2) throw new Error("sips failed"); // 失敗は null で続ける
        return ok({ width: 1000 + calls, height: 700, fullColor: true });
      },
      toDisplay: async (bytes, mediaType) => ok({ bytes, mediaType }),
      toAiJpeg: async () => ok(new Uint8Array([1])),
    };
    const dated = createApp({ clock, receipts: { imageTool } });
    const res = await dated.request("/api/entities/demo", {
      method: "POST",
      headers: await testHeaders(),
    });
    expect(res.status).toBe(201);
    const { entity } = (await res.json()) as { entity: { id: string } };
    expect(seen).toHaveLength(3);

    const list = (await get(`/api/entities/${entity.id}/receipts`)) as {
      receipts: { id: string }[];
    };
    const sizes: (number | null)[] = [];
    for (const r of list.receipts) {
      const detail = (await get(`/api/entities/${entity.id}/receipts/${r.id}`)) as {
        receipt: { currentFile: { width: number | null; height: number | null } };
      };
      sizes.push(detail.receipt.currentFile.width);
    }
    expect(sizes.filter((w) => w === null)).toHaveLength(1);
    expect(sizes.filter((w) => w !== null && w > 1000)).toHaveLength(2);
  });

  it.each([
    ["2027-01-20T03:00:00.000Z", 2026, "2027-01-20"],
    ["2027-03-01T03:00:00.000Z", 2027, "2027-03-01"],
  ])(
    "作成日 %s: 会計年度 %i。仕訳・請求書・証憑・明細の日付は作成日以前",
    async (now, year, today) => {
      // セッションも作成日の時刻で作る（アプリの時計が進んでも期限切れにならないように）
      const session = await createTestSession({ now });
      const headers = { Host: TEST_HOST, Origin: TEST_ORIGIN, Cookie: session.cookie };
      const dated = createApp({ clock: makeClock(now) });
      const res = await dated.request("/api/entities/demo", { method: "POST", headers });
      expect(res.status).toBe(201);
      const { entity } = (await res.json()) as { entity: { id: string } };
      const base = `/api/entities/${entity.id}`;
      const get = async (path: string) => {
        const r = await dated.request(path, { headers });
        expect(r.status, path).toBe(200);
        return (await r.json()) as Record<string, unknown>;
      };

      const periods = await get(`${base}/fiscal-periods`);
      expect(periods.fiscalPeriods).toEqual([expect.objectContaining({ fiscalYear: year })]);

      const dates = (body: Record<string, unknown>, key: string, field: string): string[] => {
        const rows = body[key] as Record<string, unknown>[];
        expect(rows.length, key).toBeGreaterThan(0);
        return rows.map((r) => String(r[field]));
      };
      const journals = dates(await get(`${base}/journals`), "journals", "date");
      const invoices = dates(await get(`${base}/invoices`), "invoices", "issueDate");
      const receipts = (await get(`${base}/receipts`)).receipts as { transactionDate: string }[];
      const statements = dates(await get(`${base}/statements`), "statements", "date");
      const all = [
        ...journals,
        ...invoices,
        ...receipts.map((r) => r.transactionDate),
        ...statements,
      ];
      for (const d of all) expect(d <= today, `${d} <= ${today}`).toBe(true);
      expect(journals.every((d) => d.startsWith(`${year}-`))).toBe(true);
    },
  );

  it("投入の途中の失敗で 500 DEMO_FAILED。事業体も作りかけのデータも残らず、そのあと作り直せる", async () => {
    const broken: DemoAssets = {
      receiptImage: () => {
        throw new Error("boom");
      },
      receiptProbe: () => null,
    };
    const failing = createApp({ demo: { assets: broken } });
    const res = await failing.request("/api/entities/demo", {
      method: "POST",
      headers: await testHeaders(),
    });
    expect(res.status).toBe(500);
    expect((await errorOf(res)).code).toBe("DEMO_FAILED");

    const registry = new DrizzleRegistryRepository(openRegistry());
    expect(registry.listEntities()).toEqual([]);
    expect(registry.listPreparingEntities()).toEqual([]);
    expect(registry.listArchivedEntities()).toEqual([]);

    expect((await post()).status).toBe(201);
  });

  it("施錠中は 401 LOCKED", async () => {
    const session = await createTestSession();
    clearDataKey();
    const res = await realApp.request("/api/entities/demo", {
      method: "POST",
      headers: { Host: TEST_HOST, Origin: TEST_ORIGIN, Cookie: session.cookie },
    });
    expect(res.status).toBe(401);
    expect((await errorOf(res)).code).toBe("LOCKED");
  });
});
