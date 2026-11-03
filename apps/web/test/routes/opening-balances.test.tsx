import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Account } from "@/features/accounts/api";
import type { FiscalPeriod, OpeningBalancesData } from "@/features/periods/api";
import { Route } from "@/routes/e/$entityId/periods/$year/opening-balances";
import { apiError, mockApi, ok } from "../mock-api";
import { renderRoute } from "../render-route";

const ENTITY = "/api/entities/e1";
const PATH = `${ENTITY}/fiscal-periods/2026/opening-balances`;
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const account = (
  n: number,
  name: string,
  rest: Pick<Account, "category" | "normalSide" | "reportSection"> & Partial<Account>,
): Account => ({
  id: uuid(n),
  code: String(n),
  name,
  reportLine: null,
  sortOrder: n,
  isSystem: false,
  isActive: true,
  ...rest,
});

const cash = account(1010, "現金", {
  category: "asset",
  normalSide: "debit",
  reportSection: "BS_ASSET",
});
const capital = account(3010, "元入金", {
  category: "equity",
  normalSide: "credit",
  reportSection: "BS_EQUITY",
});
const accounts = [capital, cash];

const period = (status: FiscalPeriod["status"]): FiscalPeriod => ({
  id: "p2026",
  fiscalYear: 2026,
  startDate: "2026-01-01",
  endDate: "2026-12-31",
  status,
  closedAt: status === "closed" ? "2027-03-15T00:00:00.000Z" : null,
});

const balance = (n: number, accountId: string, side: "debit" | "credit", amount: number) => ({
  id: `b${n}`,
  fiscalPeriodId: "p2026",
  accountId,
  subAccountId: null,
  side,
  amount,
});

function mockOpeningBalances(
  data: OpeningBalancesData,
  put?: Parameters<typeof mockApi>[0][string],
) {
  return mockApi({
    [`GET ${PATH}`]: () => ok(data),
    [`GET ${ENTITY}/accounts`]: () => ok({ accounts }),
    ...Object.fromEntries(
      accounts.map((a) => [
        `GET ${ENTITY}/accounts/${a.id}/sub-accounts`,
        () => ok({ subAccounts: [] }),
      ]),
    ),
    ...(put && { [`PUT ${PATH}`]: put }),
  });
}

function renderOpeningBalances() {
  return renderRoute(Route, {
    path: "/e/$entityId/periods/$year/opening-balances",
    url: "/e/e1/periods/2026/opening-balances",
  });
}

/** 合計欄の「借方合計」「貸方合計」「差額」の値 */
function total(name: "借方合計" | "貸方合計" | "差額") {
  return within(screen.getByLabelText("合計")).getByText(name).nextElementSibling?.textContent;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("期首残高の画面", () => {
  it("行がなくても借方合計・貸方合計・差額を表示する", async () => {
    mockOpeningBalances({ fiscalPeriod: period("open"), openingBalances: [] });
    renderOpeningBalances();

    expect(await screen.findByText(/行がありません/)).toBeInTheDocument();
    expect([total("借方合計"), total("貸方合計"), total("差額")]).toEqual(["0 円", "0 円", "0 円"]);
  });

  it("全角数字・カンマで入力でき、貸借が一致するまで保存できない", async () => {
    const calls = mockOpeningBalances(
      { fiscalPeriod: period("open"), openingBalances: [] },
      (call) => {
        const rows = call.body as { accountId: string; side: "debit" | "credit"; amount: number }[];
        return ok({
          fiscalPeriod: period("open"),
          openingBalances: rows.map((r, i) => balance(i, r.accountId, r.side, r.amount)),
        });
      },
    );
    const user = userEvent.setup();
    renderOpeningBalances();
    const save = await screen.findByRole("button", { name: "保存する" });

    await user.click(screen.getByRole("button", { name: "行を追加" }));
    await user.selectOptions(screen.getByLabelText("1行目の勘定科目"), "現金");
    expect(screen.getByLabelText("1行目の貸借")).toHaveValue("debit");
    await user.type(screen.getByLabelText("1行目の金額"), "１２０，０００");

    expect([total("借方合計"), total("貸方合計"), total("差額")]).toEqual([
      "120,000 円",
      "0 円",
      "120,000 円",
    ]);
    expect(save).toBeDisabled();
    expect(screen.getByText("差額が 0 円になると保存できます。")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "行を追加" }));
    await user.selectOptions(screen.getByLabelText("2行目の勘定科目"), "元入金");
    expect(screen.getByLabelText("2行目の貸借")).toHaveValue("credit");
    await user.type(screen.getByLabelText("2行目の金額"), "120,000");

    expect([total("借方合計"), total("貸方合計"), total("差額")]).toEqual([
      "120,000 円",
      "120,000 円",
      "0 円",
    ]);
    expect(save).toBeEnabled();
    await user.click(save);

    await vi.waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    expect(calls.find((c) => c.method === "PUT")?.body).toEqual([
      { accountId: cash.id, side: "debit", amount: 120_000 },
      { accountId: capital.id, side: "credit", amount: 120_000 },
    ]);
    expect(await screen.findByRole("status")).toHaveTextContent("保存しました。");

    // 保存の知らせは toast（5 秒で消える）。入力を変えても消さない
    await user.clear(screen.getByLabelText("1行目の金額"));
  });

  it("締め済みの期間は表示だけで、変更できない", async () => {
    mockOpeningBalances({
      fiscalPeriod: period("closed"),
      openingBalances: [
        balance(1, cash.id, "debit", 5_000),
        balance(2, capital.id, "credit", 5_000),
      ],
    });
    renderOpeningBalances();

    expect(await screen.findByText("（締め済み）")).toBeInTheDocument();
    expect(screen.getByLabelText("1行目の金額")).toHaveValue("5000");
    expect(screen.getByLabelText("1行目の金額")).toBeDisabled();
    expect(screen.getByLabelText("2行目の勘定科目")).toBeDisabled();
    expect(screen.getByRole("button", { name: "行を追加" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "保存する" })).toBeDisabled();
    expect([total("借方合計"), total("貸方合計"), total("差額")]).toEqual([
      "5,000 円",
      "5,000 円",
      "0 円",
    ]);
  });

  it("サーバーが貸借の不一致を返すと、合計と差額を添えてエラーを表示する", async () => {
    mockOpeningBalances(
      {
        fiscalPeriod: period("open"),
        openingBalances: [
          balance(1, cash.id, "debit", 5_000),
          balance(2, capital.id, "credit", 5_000),
        ],
      },
      () => apiError(422, "UNBALANCED", "unbalanced", { debit: 5_000, credit: 4_000, diff: 1_000 }),
    );
    const user = userEvent.setup();
    renderOpeningBalances();

    await user.click(await screen.findByRole("button", { name: "保存する" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("借方合計と貸方合計が一致しません。");
    expect(alert).toHaveTextContent("借方合計 5,000 円 ／ 貸方合計 4,000 円 ／ 差額 1,000 円");
  });
});
