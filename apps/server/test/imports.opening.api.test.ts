import { readFileSync } from "node:fs";
import { type TempDataDir, useTempDataDir } from "@trebuchet/db/testing";
import type { OpeningProposal, TrialBalance } from "@trebuchet/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  EXPECTED_BOOK_ACCOUNTS,
  EXPECTED_OPENING_PROPOSAL,
} from "../../../packages/domain/test/fixtures/freee/expected.ts";
import { app } from "../src/app.ts";
import type { ErrorBody } from "./helpers.ts";

// T038: 期首残高の案の API（contracts/http-api.md の「期首残高（総勘定元帳）」）

type Proposal = OpeningProposal & {
  missingSubAccounts: { sourceName: string; accountId: string; subAccountName: string }[];
};

let tmp: TempDataDir;
let entityId: string;

const fixture = (name: string) =>
  readFileSync(new URL(`../../../packages/domain/test/fixtures/freee/${name}`, import.meta.url));

const LEDGER = fixture("ledger-2025.csv");
const LEDGER_UTF8 = fixture("ledger-2025.utf8.csv");
const JOURNAL = fixture("journal-2025.csv");
const CARD = "ABCカード";

beforeEach(async () => {
  tmp = useTempDataDir("server-imports-opening");
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

/** file が null なら、file のフィールドを送らない */
const propose = (file: Uint8Array<ArrayBuffer> | null = LEDGER, year = "2025") => {
  const form = new FormData();
  if (file !== null) form.append("file", new File([file], "ledger.csv", { type: "text/csv" }));
  return app.request(url(`/fiscal-periods/${year}/opening-balances/freee-proposal`), {
    method: "POST",
    body: form,
  });
};

const get = (path: string) => app.request(url(path));
const sendJson = (method: "POST" | "PUT", path: string, body: unknown) =>
  app.request(url(path), {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const errorOf = async (res: Response) => ((await res.json()) as ErrorBody).error;

async function json<T>(res: Response, status: number): Promise<T> {
  if (res.status !== status) {
    throw new Error(`expected ${status} but got ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as T;
}

async function proposalOf(res: Response): Promise<Proposal> {
  return (await json<{ proposal: Proposal }>(res, 200)).proposal;
}

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

async function accountIds(): Promise<Map<string, string>> {
  const { accounts } = await json<{ accounts: { id: string; code: string }[] }>(
    await get("/accounts"),
    200,
  );
  return new Map(accounts.map((a) => [a.code, a.id]));
}

async function createSubAccount(accountId: string, name: string): Promise<string> {
  const body = await json<{ subAccount: { id: string } }>(
    await sendJson("POST", `/accounts/${accountId}/sub-accounts`, { name }),
    201,
  );
  return body.subAccount.id;
}

/** EXPECTED_OPENING_PROPOSAL を、科目の ID と補助科目の ID の行にする */
function expectedRows(ids: Map<string, string>, subAccountId?: string) {
  return EXPECTED_OPENING_PROPOSAL.filter((r) => subAccountId !== undefined || !r.subAccountName)
    .map((r) => ({
      accountId: ids.get(r.code),
      subAccountId: r.subAccountName === undefined ? null : subAccountId,
      side: r.side,
      amount: r.amount,
    }))
    .sort((a, b) => String(a.accountId).localeCompare(String(b.accountId)));
}

const rowsOf = (p: Proposal) =>
  p.rows
    .map(({ accountId, subAccountId, side, amount }) => ({ accountId, subAccountId, side, amount }))
    .sort((a, b) => a.accountId.localeCompare(b.accountId));

describe("POST /fiscal-periods/:year/opening-balances/freee-proposal", () => {
  it("200 { proposal }。カードの補助科目がまだなければ missingSubAccounts と unmapped に入れ、帳簿は変えない", async () => {
    const ids = await accountIds();
    const before = await books();

    const proposal = await proposalOf(await propose());

    expect(proposal.fiscalYear).toBe(2025);
    expect(proposal.unmapped).toEqual([CARD]);
    expect(proposal.missingSubAccounts).toEqual([
      { sourceName: CARD, accountId: ids.get("2020"), subAccountName: CARD },
    ]);
    expect(rowsOf(proposal)).toEqual(expectedRows(ids));
    expect(proposal.rows.find((r) => r.accountId === ids.get("3020"))?.sourceNames).toEqual([
      "元入金",
    ]);
    expect(proposal.totals).toEqual({ debit: 1_070_000, credit: 1_055_000 });
    expect(proposal.warnings.map((w) => [w.code, w.details?.accountId])).toEqual([
      ["NEGATIVE_OPENING", ids.get("1030")],
    ]);
    // 登録済みの期首残高も前年度の会計期間もない
    expect(proposal.comparisons.every((c) => c.registered === null)).toBe(true);
    expect(proposal.comparisons.every((c) => c.carryForward === null)).toBe(true);
    expect(await books()).toEqual(before);
  });

  it("補助科目を作ると案に入り、案の行を PUT .../opening-balances にそのまま送ると保存でき、試算表の期首が元帳と一致する", async () => {
    const ids = await accountIds();
    const payable = ids.get("2020") ?? "";
    const card = await createSubAccount(payable, CARD);

    const proposal = await proposalOf(await propose());
    expect(proposal.unmapped).toEqual([]);
    expect(proposal.missingSubAccounts).toEqual([]);
    expect(rowsOf(proposal)).toEqual(expectedRows(ids, card));
    expect(proposal.rows.find((r) => r.subAccountId === card)?.sourceNames).toEqual([CARD]);
    expect(proposal.totals).toEqual({ debit: 1_070_000, credit: 1_070_000 });

    const saved = await json<{ openingBalances: unknown[] }>(
      await sendJson("PUT", "/fiscal-periods/2025/opening-balances", proposal.rows),
      200,
    );
    expect(saved.openingBalances).toHaveLength(EXPECTED_OPENING_PROPOSAL.length);

    const tb = await json<TrialBalance>(
      await get("/reports/trial-balance?from=2025-01-01&to=2025-12-31"),
      200,
    );
    const openings = Object.fromEntries(tb.rows.map((r) => [r.code, r.opening]));
    for (const [code, expected] of Object.entries(EXPECTED_BOOK_ACCOUNTS)) {
      expect([code, openings[code] ?? 0]).toEqual([code, expected.opening]);
    }

    // 保存の後は、登録済みとの差が 0 になる
    const again = await proposalOf(await propose());
    expect(again.comparisons.map((c) => c.registered)).toEqual(
      again.comparisons.map((c) => c.proposed),
    );
  });

  it("保存済みの対応表を使う（元帳の科目を別の帳簿の科目に対応づけると、案が変わる）", async () => {
    const ids = await accountIds();
    const payable = ids.get("2020") ?? "";
    const card = await createSubAccount(payable, CARD);
    // 工具器具備品（1060）を現金（1010）に寄せる（合算される）
    await json(
      await sendJson("PUT", "/import-mappings", {
        accounts: [{ sourceName: "工具器具備品", accountId: ids.get("1010") }],
      }),
      200,
    );

    const proposal = await proposalOf(await propose());
    expect(proposal.rows.find((r) => r.accountId === ids.get("1060"))).toBeUndefined();
    expect(proposal.rows.find((r) => r.accountId === ids.get("1010"))).toMatchObject({
      subAccountId: null,
      side: "debit",
      amount: 270_000,
      sourceNames: ["現金", "工具器具備品"],
    });
    expect(proposal.rows.find((r) => r.subAccountId === card)?.amount).toBe(15_000);
  });

  it("UTF-8 の元帳も読める", async () => {
    const proposal = await proposalOf(await propose(LEDGER_UTF8));
    expect(proposal.unmapped).toEqual([CARD]);
  });

  it("仕訳帳を送る → 422 IMPORT_WRONG_KIND", async () => {
    const res = await propose(JOURNAL);
    expect(res.status).toBe(422);
    expect(await errorOf(res)).toMatchObject({
      code: "IMPORT_WRONG_KIND",
      details: { expected: "ledger", actual: "journal" },
    });
  });

  it("freee の書き出しでない CSV → 422 IMPORT_UNKNOWN_FORMAT（details.expected = ledger）", async () => {
    const res = await propose(new TextEncoder().encode("a,b,c\n1,2,3\n"));
    expect(res.status).toBe(422);
    const error = await errorOf(res);
    expect(error.code).toBe("IMPORT_UNKNOWN_FORMAT");
    expect(error.details).toMatchObject({ expected: "ledger" });
  });

  it("元帳の金額が読めない → 400 VALIDATION（details に行・列・コード）", async () => {
    const text = new TextDecoder().decode(LEDGER_UTF8).replace('"30000"', '"3万"');
    const res = await propose(new TextEncoder().encode(text));
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toMatchObject({
      code: "VALIDATION",
      details: { row: 1, column: "残高", code: "INVALID_AMOUNT" },
    });
  });

  it("会計期間がない年度 → 422 OUT_OF_PERIOD", async () => {
    const res = await propose(LEDGER, "2030");
    expect(res.status).toBe(422);
    expect(await errorOf(res)).toMatchObject({
      code: "OUT_OF_PERIOD",
      details: { fiscalYear: 2030 },
    });
  });

  it("別の年度の元帳 → 422 OUT_OF_PERIOD", async () => {
    await json(await app.request(url("/fiscal-periods"), { method: "POST" }), 201);
    const res = await propose(LEDGER, "2026");
    expect(res.status).toBe(422);
    expect(await errorOf(res)).toMatchObject({
      code: "OUT_OF_PERIOD",
      details: { fiscalYear: 2026, ledgerDate: "2025-01-01" },
    });
  });

  it("年度が4桁の数字でない → 400 VALIDATION", async () => {
    const res = await propose(LEDGER, "abc");
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe("VALIDATION");
  });

  it("file がない → 400 VALIDATION、5 MB を超える → 413 FILE_TOO_LARGE", async () => {
    const missing = await propose(null);
    expect(missing.status).toBe(400);
    expect((await errorOf(missing)).code).toBe("VALIDATION");

    const big = await propose(new Uint8Array(5 * 1024 * 1024 + 1));
    expect(big.status).toBe(413);
    expect((await errorOf(big)).code).toBe("FILE_TOO_LARGE");
  });
});
