import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ImportBatch, ReconciliationResult, ReconciliationRow } from "@trebuchet/schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FiscalPeriod } from "@/features/periods/api";
import { Route as ImportsRoute } from "@/routes/e/$entityId/imports/index";
import { Route } from "@/routes/e/$entityId/imports/reconcile";
import { ENTITY } from "../fixtures";
import { type ApiCall, apiError, formFields, mockApi, ok } from "../mock-api";
import { renderRoute } from "../render-route";

const reconcilePath = (year: number) => `${ENTITY}/fiscal-periods/${year}/reconcile/freee`;

const period = (fiscalYear: number): FiscalPeriod => ({
  id: `p${fiscalYear}`,
  fiscalYear,
  startDate: `${fiscalYear}-01-01`,
  endDate: `${fiscalYear}-12-31`,
  status: "open",
  closedAt: null,
});

const zero = { opening: 0, debit: 0, credit: 0, closing: 0 };

const cashRow: ReconciliationRow = {
  accountId: "cash",
  accountCode: "1010",
  accountName: "現金",
  sourceNames: ["現金"],
  book: { opening: 50000, debit: 12000, credit: 7000, closing: 55000 },
  freee: { opening: 50000, debit: 12000, credit: 7000, closing: 55000 },
  matched: true,
  difference: zero,
  candidates: [],
};

/** freee の2つの科目を帳簿の1つの科目にまとめた行 */
const suppliesRow = (matched: boolean): ReconciliationRow => ({
  accountId: "supplies",
  accountCode: "5170",
  accountName: "消耗品費",
  sourceNames: ["消耗品費", "事務用品費"],
  book: { opening: 0, debit: 8000, credit: 0, closing: 8000 },
  freee: matched
    ? { opening: 0, debit: 8000, credit: 0, closing: 8000 }
    : { opening: 0, debit: 11300, credit: 0, closing: 11300 },
  matched,
  difference: matched ? zero : { opening: 0, debit: -3300, credit: 0, closing: -3300 },
  candidates: matched
    ? []
    : [
        {
          date: "2025-03-10",
          freeeJournalNo: "No.3",
          debit: 3300,
          credit: 0,
          cause: "REJECTED",
          reason: "UNMAPPED",
        },
        {
          date: "2025-01-01",
          freeeJournalNo: null,
          debit: 0,
          credit: 0,
          cause: "VOIDED_IMPORT",
        },
      ],
});

const result = (rows: ReconciliationRow[], unmapped: string[] = []): ReconciliationResult => ({
  rows,
  allMatched: rows.every((r) => r.matched) && unmapped.length === 0,
  unmapped,
});

const ledger = (name = "総勘定元帳_2025.csv") =>
  new File(['"勘定科目","取引日"\n'], name, { type: "text/csv" });

function mockReconcile(reply: (call: ApiCall) => ReturnType<typeof ok>) {
  return mockApi({
    [`GET ${ENTITY}/fiscal-periods`]: () => ok({ fiscalPeriods: [period(2025), period(2026)] }),
    [`POST ${reconcilePath(2025)}`]: reply,
    [`POST ${reconcilePath(2026)}`]: reply,
  });
}

function renderReconcile() {
  return renderRoute(Route, {
    path: "/e/$entityId/imports/reconcile",
    url: "/e/e1/imports/reconcile",
  });
}

/** 年度を選び、元帳のファイルを選ぶ */
async function chooseYearAndFile(user: ReturnType<typeof userEvent.setup>, year = "2025") {
  const select = await screen.findByRole("combobox", { name: "年度" });
  await waitFor(() => expect(within(select).getAllByRole("option")).toHaveLength(3));
  await user.selectOptions(select, year);
  await user.upload(screen.getByLabelText("総勘定元帳のファイル"), ledger());
}

const reconcileTable = () => screen.findByRole("table", { name: "照合の結果" });

const rowOf = (table: HTMLElement, accountName: string) => {
  const row = within(table)
    .getByRole("rowheader", { name: new RegExp(accountName) })
    .closest("tr");
  if (!row) throw new Error(`${accountName} の行がありません`);
  return row;
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("元帳との照合（T049）", () => {
  it("年度とファイルを選ぶと照合の表が出て、すべて一致なら一致と表示する", async () => {
    const calls = mockReconcile(() => ok(result([cashRow, suppliesRow(true)])));
    const user = userEvent.setup();
    renderReconcile();

    expect(
      await screen.findByRole("heading", { level: 1, name: "元帳と照合" }),
    ).toBeInTheDocument();
    await chooseYearAndFile(user);
    const table = await reconcileTable();

    const posted = calls.filter((c) => c.method === "POST");
    expect(posted).toHaveLength(1);
    expect(posted[0]?.path).toBe(reconcilePath(2025));
    expect(formFields(posted[0]?.form)).toEqual({
      file: { name: "総勘定元帳_2025.csv", type: "text/csv", size: ledger().size },
    });

    const cash = rowOf(table, "現金");
    expect(cash).toHaveTextContent("1010");
    expect(cash).toHaveTextContent("50,000");
    expect(cash).toHaveTextContent("12,000");
    expect(cash).toHaveTextContent("55,000");
    expect(cash).toHaveTextContent("一致");
    // まとめた freee の科目名を表示する
    expect(rowOf(table, "消耗品費")).toHaveTextContent("事務用品費");
    expect(screen.getByRole("status")).toHaveTextContent("すべての科目が一致しました");
    expect(screen.queryByRole("button", { name: /詳細/ })).not.toBeInTheDocument();
  });

  it("不一致の行が目立ち、開くと差額と原因の候補（仕訳番号・日付・金額）が出る", async () => {
    mockReconcile(() => ok(result([cashRow, suppliesRow(false)])));
    const user = userEvent.setup();
    renderReconcile();
    await chooseYearAndFile(user);
    const table = await reconcileTable();

    expect(screen.getByRole("status")).toHaveTextContent("一致しない科目が1件あります");
    const supplies = rowOf(table, "消耗品費");
    expect(supplies).toHaveTextContent("不一致");
    expect(supplies).toHaveAttribute("data-matched", "false");
    expect(rowOf(table, "現金")).toHaveAttribute("data-matched", "true");

    const toggle = within(supplies).getByRole("button", { name: "消耗品費の詳細を開く" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("table", { name: "消耗品費の差の原因の候補" })).toBeNull();
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");

    const differences = screen.getByRole("list", { name: "消耗品費の差額" });
    expect(differences).toHaveTextContent("借方合計▲3,300");
    expect(differences).toHaveTextContent("期末残高▲3,300");
    const candidates = screen.getByRole("table", { name: "消耗品費の差の原因の候補" });
    const [first, second] = within(candidates).getAllByRole("row").slice(1);
    expect(first).toHaveTextContent("No.3");
    expect(first).toHaveTextContent("2025-03-10");
    expect(first).toHaveTextContent("3,300");
    expect(first).toHaveTextContent("取込不可");
    expect(first).toHaveTextContent("対応表で対応が決まっていない名前がある");
    expect(second).toHaveTextContent("取り消した取込");

    await user.click(toggle);
    expect(screen.queryByRole("table", { name: "消耗品費の差の原因の候補" })).toBeNull();
  });

  it("仕訳帳のファイル（任意）を選ぶと、元帳と一緒に送って照合し直し、取込対象外・取込不可の原因を出す", async () => {
    const excludedRow: ReconciliationRow = {
      ...suppliesRow(false),
      candidates: [
        {
          date: "2025-09-01",
          freeeJournalNo: "5090101",
          debit: 50000,
          credit: 0,
          cause: "EXCLUDED",
          reason: "USER_EXCLUDED",
        },
        {
          date: "2025-04-15",
          freeeJournalNo: "5041501",
          debit: 4400,
          credit: 0,
          cause: "REJECTED",
          reason: "UNMAPPED",
        },
      ],
    };
    const calls = mockReconcile((call) =>
      ok(
        result(
          formFields(call.form)?.journal === undefined
            ? [cashRow, suppliesRow(false)]
            : [cashRow, excludedRow],
        ),
      ),
    );
    const user = userEvent.setup();
    renderReconcile();
    await chooseYearAndFile(user);
    await reconcileTable();

    const picker = screen.getByLabelText("仕訳帳のファイル（任意）");
    const journal = new File(['"No"\n'], "仕訳帳_2025.csv", { type: "text/csv" });
    await user.upload(picker, journal);

    await waitFor(() => expect(calls.filter((c) => c.method === "POST")).toHaveLength(2));
    const second = calls.filter((c) => c.method === "POST")[1];
    expect(second?.path).toBe(reconcilePath(2025));
    expect(formFields(second?.form)).toEqual({
      file: { name: "総勘定元帳_2025.csv", type: "text/csv", size: ledger().size },
      journal: { name: "仕訳帳_2025.csv", type: "text/csv", size: journal.size },
    });

    await user.click(
      await screen.findByRole("button", { name: "消耗品費の詳細を開く" }, { timeout: 2000 }),
    );
    const candidates = screen.getByRole("table", { name: "消耗品費の差の原因の候補" });
    const [first, second2] = within(candidates).getAllByRole("row").slice(1);
    expect(first).toHaveTextContent("5090101");
    expect(first).toHaveTextContent("取込対象外");
    expect(first).toHaveTextContent("個別に外した");
    expect(second2).toHaveTextContent("取込不可");
  });

  it("仕訳帳だけでは照合せず、元帳がなければ仕訳帳を送らない", async () => {
    const calls = mockReconcile(() => ok(result([cashRow])));
    const user = userEvent.setup();
    renderReconcile();
    const select = await screen.findByRole("combobox", { name: "年度" });
    await waitFor(() => expect(within(select).getAllByRole("option")).toHaveLength(3));
    await user.selectOptions(select, "2025");
    await user.upload(
      screen.getByLabelText("仕訳帳のファイル（任意）"),
      new File(["x"], "仕訳帳.csv", { type: "text/csv" }),
    );
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("対応が未定の freee の科目を表示し、年度を変えると照合し直す", async () => {
    const calls = mockReconcile(() => ok(result([cashRow], ["交際費"])));
    const user = userEvent.setup();
    renderReconcile();
    await chooseYearAndFile(user);
    await reconcileTable();

    expect(screen.getByRole("status")).toHaveTextContent("対応が決まっていない freee の科目");
    expect(screen.getByRole("status")).toHaveTextContent("交際費");
    expect(screen.getByRole("status")).not.toHaveTextContent("すべての科目が一致しました");

    await user.selectOptions(screen.getByRole("combobox", { name: "年度" }), "2026");
    await waitFor(() =>
      expect(calls.filter((c) => c.method === "POST").map((c) => c.path)).toEqual([
        reconcilePath(2025),
        reconcilePath(2026),
      ]),
    );
  });

  it("元帳の取引日が年度の外なら、エラーを表示する", async () => {
    mockReconcile(() => apiError(422, "VALIDATION", "元帳の取引日が会計期間の外です: 2024-12-31"));
    const user = userEvent.setup();
    renderReconcile();
    await chooseYearAndFile(user);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "元帳の取引日が会計期間の外です: 2024-12-31",
    );
    expect(screen.queryByRole("table", { name: "照合の結果" })).toBeNull();
  });

  it("取込の履歴の画面から照合の画面へ移れる", async () => {
    const batch: ImportBatch = {
      id: "b1",
      source: "freee_journal",
      fileName: "仕訳帳_2025.csv",
      fileSha256: "ab".repeat(32),
      importedAt: "2026-10-19T02:00:00.000Z",
      periodFrom: "2025-01-01",
      periodTo: "2025-12-31",
      fiscalYears: [2025],
      countNew: 1,
      countAlready: 0,
      countExcluded: 0,
      countRejected: 0,
      countWarnings: 0,
      status: "active",
      voidedAt: null,
      voidReason: null,
    };
    mockApi({ [`GET ${ENTITY}/imports`]: () => ok({ batches: [batch] }) });
    renderRoute(ImportsRoute, { path: "/e/$entityId/imports/", url: "/e/e1/imports" });

    expect(await screen.findByRole("link", { name: "元帳と照合" })).toHaveAttribute(
      "href",
      "/e/e1/imports/reconcile",
    );
  });
});
