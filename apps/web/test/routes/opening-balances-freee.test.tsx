import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { OpeningProposal } from "@trebuchet/schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Account, FiscalPeriod, OpeningBalancesData } from "@/lib/queries";
import { Route } from "@/routes/e/$entityId/periods/$year/opening-balances";
import { type ApiCall, type ApiReply, apiError, formFields, mockApi, ok } from "../mock-api";
import { renderRoute } from "../render-route";

const ENTITY = "/api/entities/e1";
const PATH = `${ENTITY}/fiscal-periods/2026/opening-balances`;
const PROPOSAL = `${PATH}/freee-proposal`;
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
const receivable = account(1110, "売掛金", {
  category: "asset",
  normalSide: "debit",
  reportSection: "BS_ASSET",
});
const payable = account(2050, "未払金", {
  category: "liability",
  normalSide: "credit",
  reportSection: "BS_LIABILITY",
});
const capital = account(3020, "元入金", {
  category: "equity",
  normalSide: "credit",
  reportSection: "BS_EQUITY",
});
const accounts = [cash, receivable, payable, capital];
const card = { id: uuid(9001), accountId: payable.id, name: "Aカード", isActive: true };

const period = (status: FiscalPeriod["status"]): FiscalPeriod => ({
  id: "p2026",
  fiscalYear: 2026,
  startDate: "2026-01-01",
  endDate: "2026-12-31",
  status,
  closedAt: status === "closed" ? "2027-03-15T00:00:00.000Z" : null,
});

const balance = (
  n: number,
  accountId: string,
  side: "debit" | "credit",
  amount: number,
  subAccountId: string | null = null,
) => ({ id: `b${n}`, fiscalPeriodId: "p2026", accountId, subAccountId, side, amount });

/** 案: 売掛金がマイナス（貸方にした）、元入金が前年度の繰越と違う、未払金はカードの補助科目 */
const proposal = (rest: Partial<OpeningProposal> = {}): OpeningProposal => ({
  fiscalYear: 2026,
  rows: [
    {
      accountId: cash.id,
      subAccountId: null,
      side: "debit",
      amount: 50_000,
      sourceNames: ["現金"],
    },
    {
      accountId: receivable.id,
      subAccountId: null,
      side: "credit",
      amount: 15_000,
      sourceNames: ["売掛金"],
    },
    {
      accountId: payable.id,
      subAccountId: card.id,
      side: "credit",
      amount: 20_000,
      sourceNames: ["Ａカード"],
    },
    {
      accountId: capital.id,
      subAccountId: null,
      side: "credit",
      amount: 15_000,
      sourceNames: ["元入金"],
    },
  ],
  totals: { debit: 50_000, credit: 50_000 },
  comparisons: [
    {
      accountId: cash.id,
      subAccountId: null,
      proposed: 50_000,
      registered: null,
      carryForward: 50_000,
    },
    {
      accountId: receivable.id,
      subAccountId: null,
      proposed: -15_000,
      registered: null,
      carryForward: -15_000,
    },
    {
      accountId: payable.id,
      subAccountId: card.id,
      proposed: 20_000,
      registered: null,
      carryForward: 20_000,
    },
    {
      accountId: capital.id,
      subAccountId: null,
      proposed: 15_000,
      registered: null,
      carryForward: 12_000,
    },
  ],
  unmapped: [],
  warnings: [
    {
      code: "NEGATIVE_OPENING",
      message: "売掛金の期首残高がマイナスのため、貸方の残高にしました。",
    },
    {
      code: "OPENING_DIFFERS_FROM_CARRY_FORWARD",
      message: "元入金の案が前年度の帳簿の繰越と違います。",
    },
  ],
  ...rest,
});

const savedRows = (call: ApiCall) =>
  (
    call.body as {
      accountId: string;
      subAccountId?: string;
      side: "debit" | "credit";
      amount: number;
    }[]
  ).map((r, i) => balance(i, r.accountId, r.side, r.amount, r.subAccountId ?? null));

function mockPage(
  data: OpeningBalancesData,
  propose: (call: ApiCall) => ApiReply,
  put?: (call: ApiCall) => ApiReply,
) {
  return mockApi({
    [`GET ${PATH}`]: () => ok(data),
    [`GET ${ENTITY}/accounts`]: () => ok({ accounts }),
    ...Object.fromEntries(
      accounts.map((a) => [
        `GET ${ENTITY}/accounts/${a.id}/sub-accounts`,
        () => ok({ subAccounts: a.id === payable.id ? [card] : [] }),
      ]),
    ),
    [`POST ${PROPOSAL}`]: propose,
    ...(put && { [`PUT ${PATH}`]: put }),
  });
}

function renderOpeningBalances() {
  return renderRoute(Route, {
    path: "/e/$entityId/periods/$year/opening-balances",
    url: "/e/e1/periods/2026/opening-balances",
  });
}

const ledger = (name = "総勘定元帳_2026.csv") =>
  new File(["総勘定元帳\n"], name, { type: "text/csv" });

async function chooseLedger(user: ReturnType<typeof userEvent.setup>) {
  await user.upload(await screen.findByLabelText("総勘定元帳のファイル"), ledger());
  return screen.findByRole("region", { name: "freee の元帳から作った案" });
}

/** 比較の表で、科目の行（行見出し）の各列の値 */
function comparisonRow(panel: HTMLElement, name: string) {
  const row = within(within(panel).getByRole("table", { name: "科目ごとの比較" }))
    .getByRole("rowheader", { name })
    .closest("tr");
  if (!row) throw new Error(`${name} の行がありません`);
  return [...row.querySelectorAll("td")].map((c) => c.textContent);
}

/** 合計欄の「借方合計」「貸方合計」「差額」の値 */
function total(name: "借方合計" | "貸方合計" | "差額") {
  return within(screen.getByLabelText("合計")).getByText(name).nextElementSibling?.textContent;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("期首残高の画面: freee の元帳から読み込む", () => {
  it("ファイルを選ぶと案が行に入り、警告と前年度の繰越との差を表示し、保存で PUT を呼ぶ", async () => {
    const calls = mockPage(
      { fiscalPeriod: period("open"), openingBalances: [] },
      () => ok({ proposal: proposal() }),
      (call) => ok({ fiscalPeriod: period("open"), openingBalances: savedRows(call) }),
    );
    const user = userEvent.setup();
    renderOpeningBalances();
    const panel = await chooseLedger(user);

    const post = calls.find((c) => c.method === "POST");
    expect(post?.path).toBe(PROPOSAL);
    expect(formFields(post?.form)).toEqual({
      file: { name: "総勘定元帳_2026.csv", type: "text/csv", size: ledger().size },
    });

    // 案が入力欄に入る（マイナスの売掛金は貸方、カードは未払金の補助科目）
    expect(screen.getByLabelText("1行目の勘定科目")).toHaveValue(cash.id);
    expect(screen.getByLabelText("1行目の金額")).toHaveValue("50000");
    expect(screen.getByLabelText("2行目の勘定科目")).toHaveValue(receivable.id);
    expect(screen.getByLabelText("2行目の貸借")).toHaveValue("credit");
    expect(screen.getByLabelText("3行目の勘定科目")).toHaveValue(payable.id);
    await vi.waitFor(() => expect(screen.getByLabelText("3行目の補助科目")).toHaveValue(card.id));
    expect(screen.getByLabelText("4行目の金額")).toHaveValue("15000");
    expect([total("借方合計"), total("貸方合計"), total("差額")]).toEqual([
      "50,000 円",
      "50,000 円",
      "0 円",
    ]);

    // 警告（マイナス、前年度の繰越との差）
    const warnings = within(panel).getByRole("list", { name: "案の警告" });
    expect(within(warnings).getByText("期首残高がマイナス")).toBeInTheDocument();
    expect(warnings).toHaveTextContent("売掛金の期首残高がマイナスのため、貸方の残高にしました。");
    expect(within(warnings).getByText("前年度の繰越と違う")).toBeInTheDocument();

    // 科目ごとの比較: 案・前年度の繰越・差。登録がないので登録済みの列は出さない
    const headers = within(within(panel).getByRole("table", { name: "科目ごとの比較" }))
      .getAllByRole("columnheader")
      .map((h) => h.textContent);
    expect(headers).toEqual(["勘定科目", "freee の科目", "案", "前年度の繰越", "繰越との差"]);
    expect(comparisonRow(panel, "売掛金")).toEqual(["売掛金", "▲15,000", "▲15,000", "0"]);
    expect(comparisonRow(panel, "未払金 ／ Aカード")).toEqual([
      "Ａカード",
      "20,000",
      "20,000",
      "0",
    ]);
    expect(comparisonRow(panel, "元入金")).toEqual(["元入金", "15,000", "12,000", "3,000"]);

    await user.click(screen.getByRole("button", { name: "保存する" }));

    await vi.waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    expect(calls.find((c) => c.method === "PUT")?.body).toEqual([
      { accountId: cash.id, side: "debit", amount: 50_000 },
      { accountId: receivable.id, side: "credit", amount: 15_000 },
      { accountId: payable.id, subAccountId: card.id, side: "credit", amount: 20_000 },
      { accountId: capital.id, side: "credit", amount: 15_000 },
    ]);
    expect(await screen.findByRole("status")).toHaveTextContent("保存しました。");
    expect(screen.queryByRole("region", { name: "freee の元帳から作った案" })).toBeNull();
  });

  it("登録済みの期首残高があると、科目ごとの差を表示してから置き換える", async () => {
    const registered = proposal().comparisons.map((c) =>
      c.accountId === cash.id ? { ...c, registered: 45_000 } : { ...c, registered: c.proposed },
    );
    const calls = mockPage(
      {
        fiscalPeriod: period("open"),
        openingBalances: [
          balance(1, cash.id, "debit", 45_000),
          balance(2, capital.id, "credit", 45_000),
        ],
      },
      () => ok({ proposal: proposal({ comparisons: registered }) }),
      (call) => ok({ fiscalPeriod: period("open"), openingBalances: savedRows(call) }),
    );
    const user = userEvent.setup();
    renderOpeningBalances();
    expect(await screen.findByLabelText("1行目の金額")).toHaveValue("45000");

    const panel = await chooseLedger(user);

    const headers = within(within(panel).getByRole("table", { name: "科目ごとの比較" }))
      .getAllByRole("columnheader")
      .map((h) => h.textContent);
    expect(headers).toEqual([
      "勘定科目",
      "freee の科目",
      "案",
      "登録済み",
      "登録済みとの差",
      "前年度の繰越",
      "繰越との差",
    ]);
    expect(comparisonRow(panel, "現金")).toEqual([
      "現金",
      "50,000",
      "45,000",
      "5,000",
      "50,000",
      "0",
    ]);
    expect(within(panel).getByText(/登録済みと違う科目が 1 件あります/)).toBeInTheDocument();
    expect(screen.getByText(/保存すると、登録済みの期首残高を置き換えます/)).toBeInTheDocument();
    expect(screen.getByLabelText("4行目の勘定科目")).toHaveValue(capital.id);

    await user.click(screen.getByRole("button", { name: "保存する" }));
    await vi.waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(1);
  });

  it("対応が未定の科目があると保存できず、読み込みをやめると登録済みの値に戻る", async () => {
    const calls = mockPage(
      {
        fiscalPeriod: period("open"),
        openingBalances: [
          balance(1, cash.id, "debit", 45_000),
          balance(2, capital.id, "credit", 45_000),
        ],
      },
      () =>
        ok({
          proposal: proposal({
            rows: proposal().rows.filter((r) => r.accountId !== receivable.id),
            totals: { debit: 50_000, credit: 35_000 },
            unmapped: ["開業費"],
            warnings: [],
          }),
        }),
    );
    const user = userEvent.setup();
    renderOpeningBalances();
    const panel = await chooseLedger(user);

    expect(
      within(panel).getByRole("list", { name: "対応が未定の freee の科目" }),
    ).toHaveTextContent("開業費");
    const save = screen.getByRole("button", { name: "保存する" });
    expect(save).toBeDisabled();
    expect(
      screen.getByText(/対応が決まっていない freee の科目があるため、保存できません/),
    ).toBeInTheDocument();

    // 行を足して貸借を合わせても、案を使っている間は保存できない
    await user.click(screen.getByRole("button", { name: "行を追加" }));
    await user.selectOptions(screen.getByLabelText("4行目の勘定科目"), "元入金");
    await user.type(screen.getByLabelText("4行目の金額"), "15000");
    expect(total("差額")).toBe("0 円");
    expect(save).toBeDisabled();

    await user.click(within(panel).getByRole("button", { name: "読み込みをやめる" }));
    expect(screen.queryByRole("region", { name: "freee の元帳から作った案" })).toBeNull();
    expect(screen.getByLabelText("1行目の金額")).toHaveValue("45000");
    expect(screen.queryByLabelText("3行目の金額")).toBeNull();
    expect(save).toBeEnabled();
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("入力欄を変えた後でも、案を入力欄に反映し直せる", async () => {
    mockPage({ fiscalPeriod: period("open"), openingBalances: [] }, () =>
      ok({ proposal: proposal() }),
    );
    const user = userEvent.setup();
    renderOpeningBalances();
    const panel = await chooseLedger(user);

    await user.click(screen.getByRole("button", { name: "削除（1行目）" }));
    expect(screen.getByLabelText("1行目の勘定科目")).toHaveValue(receivable.id);

    await user.click(within(panel).getByRole("button", { name: "案を入力欄に反映する" }));
    expect(screen.getByLabelText("1行目の勘定科目")).toHaveValue(cash.id);
    expect(screen.getByLabelText("4行目の勘定科目")).toHaveValue(capital.id);
  });

  it("元帳でないファイルはエラーを表示し、入力欄は変えない", async () => {
    mockPage(
      {
        fiscalPeriod: period("open"),
        openingBalances: [
          balance(1, cash.id, "debit", 45_000),
          balance(2, capital.id, "credit", 45_000),
        ],
      },
      () => apiError(422, "IMPORT_WRONG_KIND", "wrong kind"),
    );
    const user = userEvent.setup();
    renderOpeningBalances();
    await user.upload(await screen.findByLabelText("総勘定元帳のファイル"), ledger("仕訳帳.csv"));

    expect(await screen.findByRole("alert")).toHaveTextContent("ファイルの種類が違います。");
    expect(screen.queryByRole("region", { name: "freee の元帳から作った案" })).toBeNull();
    expect(screen.getByLabelText("1行目の金額")).toHaveValue("45000");
    expect(screen.getByRole("button", { name: "保存する" })).toBeEnabled();
  });

  it("締め済みの期間では元帳を読み込めない", async () => {
    mockPage({ fiscalPeriod: period("closed"), openingBalances: [] }, () =>
      ok({ proposal: proposal() }),
    );
    renderOpeningBalances();

    expect(await screen.findByLabelText("総勘定元帳のファイル")).toBeDisabled();
  });
});
