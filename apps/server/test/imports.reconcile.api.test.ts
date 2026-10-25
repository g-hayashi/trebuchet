import { readFileSync } from "node:fs";
import { type TempDataDir, useTempDataDir } from "@trebuchet/db/testing";
import type { ReconciliationResult } from "@trebuchet/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { app, errorOf, json } from "./helpers.ts";

// T048: 元帳との照合の API（contracts/http-api.md の「照合」）

let tmp: TempDataDir;
let entityId: string;

const fixture = (name: string) =>
  readFileSync(new URL(`../../../packages/domain/test/fixtures/freee/${name}`, import.meta.url));

const LEDGER = fixture("ledger-2025.csv");
const LEDGER_UTF8 = fixture("ledger-2025.utf8.csv");
const JOURNAL = fixture("journal-2025.csv");

beforeEach(async () => {
  tmp = useTempDataDir("server-imports-reconcile");
  const res = await app.request("/api/entities", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "個人事業",
      kind: "individual",
      fiscalStartMonth: 1,
      firstFiscalYear: 2025,
    }),
  });
  if (res.status !== 201) throw new Error(`entity create failed: ${res.status}`);
  entityId = ((await res.json()) as { entity: { id: string } }).entity.id;
});
afterEach(() => tmp.cleanup());

const url = (path: string) => `/api/entities/${entityId}${path}`;

/** file が null なら、file のフィールドを送らない。journal があれば仕訳帳のフィールドも送る */
const reconcile = (
  file: Uint8Array<ArrayBuffer> | null = LEDGER,
  year = "2025",
  journal?: Uint8Array<ArrayBuffer>,
) => {
  const form = new FormData();
  if (file !== null) form.append("file", new File([file], "ledger.csv", { type: "text/csv" }));
  if (journal !== undefined) {
    form.append("journal", new File([journal], "journal.csv", { type: "text/csv" }));
  }
  return app.request(url(`/fiscal-periods/${year}/reconcile/freee`), {
    method: "POST",
    body: form,
  });
};

const get = (path: string) => app.request(url(path));

/** 帳簿の状態（仕訳・期首残高・補助科目・対応表・取込の回） */
async function books() {
  const paths = [
    "/journals",
    "/fiscal-periods/2025/opening-balances",
    "/import-mappings",
    "/imports",
    "/accounts",
  ];
  return Promise.all(paths.map(async (p) => (await get(p)).json()));
}

describe("POST /fiscal-periods/:year/reconcile/freee", () => {
  it("200 { rows, allMatched, unmapped }。帳簿が空なら不一致で、帳簿は変えない", async () => {
    const before = await books();

    const result = await json<ReconciliationResult>(await reconcile(), 200);

    expect(Object.keys(result).sort()).toEqual(["allMatched", "rows", "unmapped"]);
    expect(result.allMatched).toBe(false);
    expect(result.unmapped).toEqual([]);
    expect(result.rows.length).toBeGreaterThan(0);
    expect(result.rows.some((r) => !r.matched)).toBe(true);
    for (const row of result.rows) {
      expect(Object.keys(row).sort()).toEqual(
        [
          "accountCode",
          "accountId",
          "accountName",
          "book",
          "candidates",
          "difference",
          "freee",
          "matched",
          "sourceNames",
        ].sort(),
      );
    }
    expect(await books()).toEqual(before);
  });

  it("仕訳帳（journal）も送ると、取込不可の仕訳が原因の候補 REJECTED（理由つき）になる。送らなければ NOT_IMPORTED", async () => {
    // 通信費を、対応のない名前にした仕訳帳（5041501 が UNMAPPED で取込不可になる）
    const unmapped = new TextEncoder().encode(
      new TextDecoder().decode(JOURNAL).replaceAll("通信費", "未登録の科目"),
    );
    const before = await books();

    const withJournal = await json<ReconciliationResult>(
      await reconcile(LEDGER, "2025", unmapped),
      200,
    );
    const causesOf = (r: ReconciliationResult) =>
      r.rows.flatMap((row) => row.candidates.filter((c) => c.freeeJournalNo === "5041501"));
    expect(causesOf(withJournal).length).toBeGreaterThan(0);
    for (const c of causesOf(withJournal)) {
      expect(c).toMatchObject({ cause: "REJECTED", reason: "UNMAPPED" });
    }

    const withoutJournal = await json<ReconciliationResult>(await reconcile(), 200);
    expect(causesOf(withoutJournal).length).toBeGreaterThan(0);
    for (const c of causesOf(withoutJournal)) expect(c.cause).toBe("NOT_IMPORTED");
    expect(await books()).toEqual(before);
  });

  it("journal に元帳を送る → 422 IMPORT_WRONG_KIND、5 MB を超える → 413 FILE_TOO_LARGE", async () => {
    const wrong = await reconcile(LEDGER, "2025", LEDGER);
    expect(wrong.status).toBe(422);
    expect(await errorOf(wrong)).toMatchObject({
      code: "IMPORT_WRONG_KIND",
      details: { expected: "journal", actual: "ledger" },
    });

    const big = await reconcile(LEDGER, "2025", new Uint8Array(5 * 1024 * 1024 + 1));
    expect(big.status).toBe(413);
    expect((await errorOf(big)).code).toBe("FILE_TOO_LARGE");
  });

  it("UTF-8 の元帳も読める", async () => {
    const result = await json<ReconciliationResult>(await reconcile(LEDGER_UTF8), 200);
    expect(result.unmapped).toEqual([]);
  });

  it("元帳の取引日が会計期間の外 → 422 VALIDATION（details に年度・期間・元帳の日付）", async () => {
    await json(await app.request(url("/fiscal-periods"), { method: "POST" }), 201);
    const res = await reconcile(LEDGER, "2026");
    expect(res.status).toBe(422);
    expect(await errorOf(res)).toMatchObject({
      code: "VALIDATION",
      details: { fiscalYear: 2026, ledgerDate: "2025-01-01" },
    });
  });

  it("会計期間がない年度 → 422 OUT_OF_PERIOD", async () => {
    const res = await reconcile(LEDGER, "2030");
    expect(res.status).toBe(422);
    expect(await errorOf(res)).toMatchObject({
      code: "OUT_OF_PERIOD",
      details: { fiscalYear: 2030 },
    });
  });

  it("元帳の金額が読めない → 400 VALIDATION（入力の誤りは 422 にしない）", async () => {
    const text = new TextDecoder().decode(LEDGER_UTF8).replace('"30000"', '"3万"');
    const res = await reconcile(new TextEncoder().encode(text));
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toMatchObject({
      code: "VALIDATION",
      details: { column: "残高", code: "INVALID_AMOUNT" },
    });
  });

  it("仕訳帳を送る → 422 IMPORT_WRONG_KIND", async () => {
    const res = await reconcile(JOURNAL);
    expect(res.status).toBe(422);
    expect(await errorOf(res)).toMatchObject({
      code: "IMPORT_WRONG_KIND",
      details: { expected: "ledger", actual: "journal" },
    });
  });

  it("freee の書き出しでない CSV → 422 IMPORT_UNKNOWN_FORMAT", async () => {
    const res = await reconcile(new TextEncoder().encode("a,b,c\n1,2,3\n"));
    expect(res.status).toBe(422);
    expect((await errorOf(res)).code).toBe("IMPORT_UNKNOWN_FORMAT");
  });

  it("年度が4桁の数字でない → 400 VALIDATION", async () => {
    const res = await reconcile(LEDGER, "abc");
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe("VALIDATION");
  });

  it("file がない → 400 VALIDATION、5 MB を超える → 413 FILE_TOO_LARGE", async () => {
    const missing = await reconcile(null);
    expect(missing.status).toBe(400);
    expect((await errorOf(missing)).code).toBe("VALIDATION");

    const big = await reconcile(new Uint8Array(5 * 1024 * 1024 + 1));
    expect(big.status).toBe(413);
    expect((await errorOf(big)).code).toBe("FILE_TOO_LARGE");
  });
});
