import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Route as BalanceSheetRoute } from "@/routes/e/$entityId/reports/balance-sheet";
import { Route as GeneralLedgerRoute } from "@/routes/e/$entityId/reports/general-ledger";
import { Route as JournalBookRoute } from "@/routes/e/$entityId/reports/journal-book";
import { Route as ProfitAndLossRoute } from "@/routes/e/$entityId/reports/profit-and-loss";
import { Route as TrialBalanceRoute } from "@/routes/e/$entityId/reports/trial-balance";
import { type ApiCall, type ApiReply, apiError, mockApi, ok } from "../mock-api";
import { renderRoute } from "../render-route";

const ENTITY = "/api/entities/e1";
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const period = (fiscalYear: number) => ({
  id: uuid(fiscalYear),
  fiscalYear,
  startDate: `${fiscalYear}-01-01`,
  endDate: `${fiscalYear}-12-31`,
  status: "open",
  closedAt: null,
});
const PERIODS = [period(2025), period(2026)];

const negativeWarning = {
  code: "NEGATIVE_BALANCE",
  message: "売掛金の残高がマイナス（▲15,000）です",
  details: { accountId: uuid(1100), accountName: "売掛金", balance: -15_000 },
};

const tbRow = (
  n: number,
  name: string,
  category: string,
  normalSide: "debit" | "credit",
  amounts: [opening: number, debit: number, credit: number, closing: number],
) => ({
  accountId: uuid(n),
  code: String(n),
  name,
  category,
  normalSide,
  opening: amounts[0],
  debit: amounts[1],
  credit: amounts[2],
  closing: amounts[3],
});

const trialBalance = (from: string, to: string, warnings: unknown[] = [negativeWarning]) => ({
  kind: "trial-balance",
  from,
  to,
  rows: [
    tbRow(1020, "普通預金", "asset", "debit", [1_000_000, 345_000, 80_000, 1_265_000]),
    tbRow(1100, "売掛金", "asset", "debit", [0, 330_000, 345_000, -15_000]),
    tbRow(3010, "元入金", "equity", "credit", [1_000_000, 0, 0, 1_000_000]),
    tbRow(4010, "売上高", "revenue", "credit", [0, 0, 330_000, 330_000]),
    tbRow(8230, "地代家賃", "expense", "debit", [0, 80_000, 0, 80_000]),
  ],
  totals: { debit: 755_000, credit: 755_000, closingDebit: 1_330_000, closingCredit: 1_330_000 },
  balanced: true,
  warnings,
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const reportCalls = (calls: ApiCall[], kind: string) =>
  calls.filter((c) => c.path === `${ENTITY}/reports/${kind}`);

function mockReports(routes: Record<string, (call: ApiCall) => ApiReply>) {
  return mockApi({
    [`GET ${ENTITY}/fiscal-periods`]: () => ok({ fiscalPeriods: PERIODS }),
    ...routes,
  });
}

describe("試算表（US4, FR-028）", () => {
  const render = (url: string) =>
    renderRoute(TrialBalanceRoute, { path: "/e/$entityId/reports/trial-balance", url });

  it("URL の期間で取得し、科目ごとの期首・借方・貸方・期末と合計を表示する。マイナスは ▲", async () => {
    const calls = mockReports({
      [`GET ${ENTITY}/reports/trial-balance`]: (c) =>
        ok(trialBalance(c.query.from ?? "", c.query.to ?? "")),
    });
    render("/e/e1/reports/trial-balance?from=2026-01-01&to=2026-12-31");

    const row = await screen.findByRole("row", { name: /売掛金/ });
    expect(
      within(row)
        .getAllByRole("cell")
        .map((c) => c.textContent),
    ).toEqual(["1100", "売掛金", "0", "330,000", "345,000", "▲15,000"]);
    const total = screen.getByRole("row", { name: /合計/ });
    expect(
      within(total)
        .getAllByRole("cell")
        .map((c) => c.textContent),
    ).toContain("755,000");
    expect(screen.getByText("貸借一致")).toBeInTheDocument();
    expect(reportCalls(calls, "trial-balance")[0]?.query).toEqual({
      from: "2026-01-01",
      to: "2026-12-31",
    });
  });

  it("FR-033: 警告をバナーに表示する", async () => {
    mockReports({
      [`GET ${ENTITY}/reports/trial-balance`]: () => ok(trialBalance("2026-01-01", "2026-12-31")),
    });
    render("/e/e1/reports/trial-balance?from=2026-01-01&to=2026-12-31");
    const banner = await screen.findByRole("region", { name: "警告" });
    expect(banner).toHaveTextContent("売掛金の残高がマイナス（▲15,000）です");
  });

  it("FR-032: 同じ条件の CSV をダウンロードできる", async () => {
    mockReports({
      [`GET ${ENTITY}/reports/trial-balance`]: () => ok(trialBalance("2026-01-01", "2026-06-30")),
    });
    render("/e/e1/reports/trial-balance?from=2026-01-01&to=2026-06-30");
    const link = await screen.findByRole("link", { name: "CSV をダウンロード" });
    expect(link).toHaveAttribute(
      "href",
      `${ENTITY}/reports/trial-balance?from=2026-01-01&to=2026-06-30&format=csv`,
    );
    expect(link).toHaveAttribute("download");
  });

  it("期間の指定がなければ、今日を含む会計期間を表示する。会計期間を選ぶと取り直す", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-15T00:00:00+09:00"));
    const calls = mockReports({
      [`GET ${ENTITY}/reports/trial-balance`]: (c) =>
        ok(trialBalance(c.query.from ?? "", c.query.to ?? "", [])),
    });
    const user = userEvent.setup();
    render("/e/e1/reports/trial-balance");

    await waitFor(() =>
      expect(reportCalls(calls, "trial-balance").map((c) => c.query)).toEqual([
        { from: "2026-01-01", to: "2026-12-31" },
      ]),
    );
    expect(screen.getByLabelText("開始日")).toHaveValue("2026-01-01");
    expect(screen.queryByRole("region", { name: "警告" })).not.toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText("会計期間"), "2025");
    await waitFor(() =>
      expect(reportCalls(calls, "trial-balance").at(-1)?.query).toEqual({
        from: "2025-01-01",
        to: "2025-12-31",
      }),
    );
    expect(screen.getByLabelText("終了日")).toHaveValue("2025-12-31");
  });

  it("開始日・終了日を変えて表示すると、その期間で取り直す", async () => {
    const calls = mockReports({
      [`GET ${ENTITY}/reports/trial-balance`]: (c) =>
        ok(trialBalance(c.query.from ?? "", c.query.to ?? "")),
    });
    const user = userEvent.setup();
    render("/e/e1/reports/trial-balance?from=2026-01-01&to=2026-12-31");
    await screen.findByRole("row", { name: /売掛金/ });

    fireEvent.change(screen.getByLabelText("開始日"), { target: { value: "2026-04-01" } });
    fireEvent.change(screen.getByLabelText("終了日"), { target: { value: "2026-06-30" } });
    await user.click(screen.getByRole("button", { name: "表示" }));
    await waitFor(() =>
      expect(reportCalls(calls, "trial-balance").at(-1)?.query).toEqual({
        from: "2026-04-01",
        to: "2026-06-30",
      }),
    );
  });

  it("API のエラー（会計期間の外）を表示する", async () => {
    mockReports({
      [`GET ${ENTITY}/reports/trial-balance`]: () =>
        apiError(422, "OUT_OF_PERIOD", "会計期間が登録されていない日付です"),
    });
    render("/e/e1/reports/trial-balance?from=2024-01-01&to=2024-12-31");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "会計期間が登録されていない日付です",
    );
  });
});

const plRow = (n: number, name: string, amount: number, rest: object = {}) => ({
  accountId: uuid(n),
  code: String(n),
  name,
  reportLine: null,
  amount,
  ...rest,
});

const profitAndLoss = (compare: boolean) => {
  const fig = (amount: number, previous: number) =>
    compare ? { amount, previous, change: amount - previous } : { amount };
  const row = (n: number, name: string, amount: number, previous: number) =>
    plRow(n, name, amount, compare ? { previous, change: amount - previous } : {});
  return {
    kind: "profit-and-loss",
    from: "2026-01-01",
    to: "2026-12-31",
    previous: compare ? { from: "2025-01-01", to: "2025-12-31" } : null,
    sections: [
      {
        section: "PL_SALES",
        rows: [row(4010, "売上高", 330_000, 300_000)],
        total: fig(330_000, 300_000),
      },
      {
        section: "PL_EXPENSE",
        rows: [row(8230, "地代家賃", 80_000, 120_000)],
        total: fig(80_000, 120_000),
      },
    ],
    grossProfit: fig(330_000, 300_000),
    netIncome: fig(250_000, 180_000),
    warnings: [],
  };
};

describe("損益計算書（US4, FR-029, FR-030）", () => {
  it("区分ごとの科目と計、差引金額を表示し、前年比較に切り替えると前年・増減の列を出す", async () => {
    const calls = mockReports({
      [`GET ${ENTITY}/reports/profit-and-loss`]: (c) =>
        ok(profitAndLoss(c.query.compare === "previous-year")),
    });
    const user = userEvent.setup();
    renderRoute(ProfitAndLossRoute, {
      path: "/e/$entityId/reports/profit-and-loss",
      url: "/e/e1/reports/profit-and-loss?from=2026-01-01&to=2026-12-31",
    });

    const rent = await screen.findByRole("row", { name: /地代家賃/ });
    expect(
      within(rent)
        .getAllByRole("cell")
        .map((c) => c.textContent),
    ).toEqual(["地代家賃", "80,000"]);
    expect(screen.getByRole("row", { name: /差引金額/ })).toHaveTextContent("250,000");
    expect(screen.queryByRole("columnheader", { name: "前年" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("checkbox", { name: "前年と比較" }));
    await waitFor(() =>
      expect(reportCalls(calls, "profit-and-loss").at(-1)?.query).toEqual({
        from: "2026-01-01",
        to: "2026-12-31",
        compare: "previous-year",
      }),
    );
    expect(await screen.findByRole("columnheader", { name: "前年" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "増減" })).toBeInTheDocument();
    const compared = screen.getByRole("row", { name: /地代家賃/ });
    expect(
      within(compared)
        .getAllByRole("cell")
        .map((c) => c.textContent),
    ).toEqual(["地代家賃", "80,000", "120,000", "▲40,000"]);
    expect(screen.getByRole("link", { name: "CSV をダウンロード" })).toHaveAttribute(
      "href",
      `${ENTITY}/reports/profit-and-loss?from=2026-01-01&to=2026-12-31&compare=previous-year&format=csv`,
    );
  });
});

const bsRow = (n: number, name: string, amount: number) => plRow(n, name, amount);

describe("貸借対照表（US4, FR-029）", () => {
  it("基準日の資産・負債・純資産と当期利益、合計を表示する", async () => {
    const calls = mockReports({
      [`GET ${ENTITY}/reports/balance-sheet`]: () =>
        ok({
          kind: "balance-sheet",
          asOf: "2026-12-31",
          previousAsOf: null,
          sections: [
            {
              section: "BS_ASSET",
              rows: [bsRow(1020, "普通預金", 1_265_000), bsRow(1100, "売掛金", -15_000)],
              total: { amount: 1_250_000 },
            },
            { section: "BS_LIABILITY", rows: [], total: { amount: 0 } },
            {
              section: "BS_EQUITY",
              rows: [bsRow(3010, "元入金", 1_000_000)],
              total: { amount: 1_000_000 },
            },
          ],
          netIncome: { amount: 250_000 },
          totalAssets: { amount: 1_250_000 },
          totalLiabilitiesAndEquity: { amount: 1_250_000 },
          balanced: true,
          warnings: [negativeWarning],
        }),
    });
    renderRoute(BalanceSheetRoute, {
      path: "/e/$entityId/reports/balance-sheet",
      url: "/e/e1/reports/balance-sheet?asOf=2026-12-31",
    });

    expect(await screen.findByRole("row", { name: /売掛金/ })).toHaveTextContent("▲15,000");
    expect(screen.getByRole("row", { name: /当期利益/ })).toHaveTextContent("250,000");
    expect(screen.getByRole("row", { name: /^資産合計/ })).toHaveTextContent("1,250,000");
    expect(screen.getByRole("row", { name: /負債・純資産合計/ })).toHaveTextContent("1,250,000");
    expect(screen.getByText("貸借一致")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "警告" })).toHaveTextContent("▲15,000");
    expect(screen.getByLabelText("基準日")).toHaveValue("2026-12-31");
    expect(reportCalls(calls, "balance-sheet")[0]?.query).toEqual({ asOf: "2026-12-31" });
  });
});

const accounts = [
  {
    id: uuid(1020),
    code: "1020",
    name: "普通預金",
    category: "asset",
    normalSide: "debit",
    reportSection: "BS_ASSET",
    reportLine: null,
    sortOrder: 1020,
    isSystem: true,
    isActive: true,
  },
  {
    id: uuid(4010),
    code: "4010",
    name: "売上高",
    category: "revenue",
    normalSide: "credit",
    reportSection: "PL_SALES",
    reportLine: 1,
    sortOrder: 4010,
    isSystem: true,
    isActive: true,
  },
];

describe("総勘定元帳（US4, FR-027）", () => {
  const ledger = (subAccount: { id: string; name: string } | null) => ({
    kind: "general-ledger",
    from: "2026-01-01",
    to: "2026-12-31",
    account: {
      accountId: uuid(1020),
      code: "1020",
      name: "普通預金",
      category: "asset",
      normalSide: "debit",
    },
    subAccount,
    broughtForward: 1_000_000,
    entries: [
      {
        journalId: uuid(9003),
        journalNo: 3,
        date: "2026-01-25",
        lineNo: 2,
        counterpart: "地代家賃",
        description: "1月分",
        debit: 0,
        credit: 80_000,
        balance: 920_000,
      },
      {
        journalId: uuid(9002),
        journalNo: 2,
        date: "2026-02-27",
        lineNo: 1,
        counterpart: "諸口",
        description: null,
        debit: 329_560,
        credit: 0,
        balance: 1_249_560,
      },
    ],
    totals: { debit: 329_560, credit: 80_000 },
    closing: 1_249_560,
    warnings: [],
  });

  it("科目を選ぶまでは取得せず、選ぶと前期繰越から残高の推移を表示し、行から仕訳の詳細に移れる", async () => {
    const calls = mockReports({
      [`GET ${ENTITY}/accounts`]: () => ok({ accounts }),
      [`GET ${ENTITY}/accounts/${uuid(1020)}/sub-accounts`]: () =>
        ok({
          subAccounts: [{ id: uuid(5001), accountId: uuid(1020), name: "A銀行", isActive: true }],
        }),
      [`GET ${ENTITY}/reports/general-ledger`]: (c) =>
        ok(ledger(c.query.subAccountId ? { id: uuid(5001), name: "A銀行" } : null)),
    });
    const user = userEvent.setup();
    renderRoute(GeneralLedgerRoute, {
      path: "/e/$entityId/reports/general-ledger",
      url: "/e/e1/reports/general-ledger?from=2026-01-01&to=2026-12-31",
    });

    expect(await screen.findByText("勘定科目を選んでください")).toBeInTheDocument();
    await user.selectOptions(await screen.findByLabelText("勘定科目"), uuid(1020));

    const forward = await screen.findByRole("row", { name: /前期繰越/ });
    expect(forward).toHaveTextContent("1,000,000");
    const first = screen.getByRole("row", { name: /2026-01-25/ });
    expect(
      within(first)
        .getAllByRole("cell")
        .map((c) => c.textContent),
    ).toEqual(["2026-01-25", "3", "地代家賃", "1月分", "", "80,000", "920,000"]);
    expect(within(first).getByRole("link", { name: "3" })).toHaveAttribute(
      "href",
      `/e/e1/journals/${uuid(9003)}`,
    );
    expect(screen.getByRole("row", { name: /諸口/ })).toHaveTextContent("1,249,560");
    expect(reportCalls(calls, "general-ledger")).toHaveLength(1);
    expect(reportCalls(calls, "general-ledger")[0]?.query).toEqual({
      from: "2026-01-01",
      to: "2026-12-31",
      accountId: uuid(1020),
    });

    await user.selectOptions(await screen.findByLabelText("補助科目"), uuid(5001));
    await waitFor(() =>
      expect(reportCalls(calls, "general-ledger").at(-1)?.query).toEqual({
        from: "2026-01-01",
        to: "2026-12-31",
        accountId: uuid(1020),
        subAccountId: uuid(5001),
      }),
    );
  });
});

describe("仕訳帳（US4, FR-026）", () => {
  it("仕訳ごとに行を表示し、仕訳番号から詳細に移れる。合計を表示する", async () => {
    const line = (lineNo: number, side: string, accountName: string, amount: number) => ({
      lineNo,
      side,
      accountId: uuid(lineNo),
      accountName,
      subAccountId: null,
      subAccountName: null,
      partnerId: null,
      partnerName: lineNo === 2 ? "取引先A" : null,
      amount,
      taxCategory: "OUT_OF_SCOPE",
      taxAmount: 0,
      description: null,
    });
    mockReports({
      [`GET ${ENTITY}/reports/journal-book`]: () =>
        ok({
          kind: "journal-book",
          from: "2026-01-01",
          to: "2026-01-31",
          entries: [
            {
              journalId: uuid(9001),
              journalNo: 1,
              date: "2026-01-31",
              memo: "1月分",
              lines: [line(1, "debit", "売掛金", 330_000), line(2, "credit", "売上高", 330_000)],
            },
          ],
          totals: { debit: 330_000, credit: 330_000 },
          warnings: [],
        }),
    });
    renderRoute(JournalBookRoute, {
      path: "/e/$entityId/reports/journal-book",
      url: "/e/e1/reports/journal-book?from=2026-01-01&to=2026-01-31",
    });

    const debit = await screen.findByRole("row", { name: /売掛金/ });
    expect(within(debit).getByRole("link", { name: "1" })).toHaveAttribute(
      "href",
      `/e/e1/journals/${uuid(9001)}`,
    );
    expect(debit).toHaveTextContent("1月分");
    const credit = screen.getByRole("row", { name: /売上高/ });
    expect(credit).toHaveTextContent("取引先A");
    expect(screen.getByRole("row", { name: /合計/ })).toHaveTextContent("330,000");
  });
});
