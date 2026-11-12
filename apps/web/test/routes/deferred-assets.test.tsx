import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AdjustmentProposal } from "@trebuchet/schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Route as DeferredAssetsRoute } from "@/routes/e/$entityId/deferred-assets/index";
import { type ApiCall, apiError, mockApi, ok } from "../mock-api";
import { renderRoute } from "../render-route";

// 開業費の画面（009 US3）。固定資産台帳から移した（011/T005）。見出し・主な操作の仕上げは T033

const ENTITY = "/api/entities/e1";
const DEFERRED = `${ENTITY}/deferred-assets`;
const ADJUSTMENTS = `${ENTITY}/blue-return/2025/adjustments`;

const account = (id: string, name: string, category: string, isActive = true) => ({
  id,
  code: id,
  name,
  category,
  normalSide: category === "asset" ? "debit" : "credit",
  reportSection: "BS",
  reportLine: null,
  sortOrder: 1,
  isSystem: false,
  isActive,
});
const ACCOUNTS = [
  account("a-tools", "工具器具備品", "asset"),
  account("a-old", "使わない資産", "asset", false),
  account("a-bank", "普通預金", "asset"),
  account("a-rent", "地代家賃", "expense"),
  account("a-sales", "売上高", "revenue"),
  account("a-dep", "減価償却費", "expense"),
  account("a-owner", "事業主貸", "equity"),
  account("a-open", "開業費", "asset"),
];

/** 年度の償却の見え方（API の `amortization`）。2025 年: 上限 300,000、目安 45,000（9 か月分） */
const deferredView = (over: Record<string, unknown> = {}) => ({
  fiscalYear: 2025,
  openingBalance: 300_000,
  target: 45_000,
  decision: null,
  registered: false,
  closingBalance: 300_000,
  ...over,
});

const deferred = (over: Record<string, unknown> = {}) => ({
  id: "d-1",
  name: "開業費",
  totalAmount: 300_000,
  openedOn: "2025-04-01",
  priorAccumulated: 0,
  priorThroughYear: null,
  accountId: "a-open",
  note: null,
  createdAt: "2025-04-01T00:00:00.000Z",
  updatedAt: "2025-04-01T00:00:00.000Z",
  amortization: deferredView(),
  ...over,
});

const DEFERRED_PROPOSAL: AdjustmentProposal = {
  kind: "deferred_amortization",
  sourceId: "d-1",
  journal: {
    date: "2025-12-31",
    memo: "開業費の償却",
    lines: [
      { side: "debit", accountId: "a-dep", amount: 45_000, taxCategory: "OUT_OF_SCOPE" },
      { side: "credit", accountId: "a-open", amount: 45_000, taxCategory: "OUT_OF_SCOPE" },
    ],
  },
  breakdown: {
    totalAmount: 300_000,
    openingBalance: 300_000,
    amount: 45_000,
    target: 45_000,
    closingBalance: 255_000,
  },
};

type Opts = {
  /** 開業費。`amortization` を付けた API の応答の形 */
  deferredAssets?: unknown[];
  proposals?: AdjustmentProposal[];
  /** 個別の応答（同じキーの既定の応答を置き換える） */
  overrides?: Parameters<typeof mockApi>[0];
};

function mockScreen(opts: Opts = {}) {
  const state = {
    deferredAssets: opts.deferredAssets ?? [],
    proposals: opts.proposals ?? [],
  };
  const calls = mockApi({
    [`GET ${ENTITY}/accounts`]: () => ok({ accounts: ACCOUNTS }),
    [`GET ${DEFERRED}`]: () => ok({ deferredAssets: state.deferredAssets }),
    [`POST ${DEFERRED}`]: (call) => {
      const saved = deferred({ id: "d-new", ...(call.body as object), amortization: null });
      state.deferredAssets = [...state.deferredAssets, saved];
      return ok({ deferredAsset: saved }, 201);
    },
    [`PUT ${DEFERRED}/d-1`]: (call) => {
      const saved = deferred({ ...(call.body as object) });
      state.deferredAssets = [saved];
      return ok({ deferredAsset: saved });
    },
    [`PUT ${DEFERRED}/d-1/amortizations/2025`]: (call) => {
      const { amount } = call.body as { amount: number };
      const amortization = deferredView({
        decision: {
          deferredAssetId: "d-1",
          fiscalYear: 2025,
          amount,
          decidedAt: "2025-12-01T00:00:00.000Z",
          updatedAt: "2025-12-01T00:00:00.000Z",
        },
        closingBalance: 300_000 - amount,
      });
      state.deferredAssets = [deferred({ amortization })];
      return ok({ amortization, proposal: amount === 0 ? null : DEFERRED_PROPOSAL });
    },
    [`GET ${ADJUSTMENTS}`]: () => ok({ proposals: state.proposals }),
    [`POST ${ADJUSTMENTS}`]: () => {
      state.proposals = [];
      return ok(
        {
          journal: { id: "j-new", journalNo: 7 },
          ref: {
            journalId: "j-new",
            kind: "deferred_amortization",
            allocationId: null,
            assetId: null,
            fiscalYear: 2025,
          },
        },
        201,
      );
    },
    ...opts.overrides,
  });
  return { calls, state };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const renderPage = (search = "?year=2025") =>
  renderRoute(DeferredAssetsRoute, {
    path: "/e/$entityId/deferred-assets/",
    url: `/e/e1/deferred-assets/${search}`,
  });

const callsOf = (calls: ApiCall[], method: string, path: string) =>
  calls.filter((c) => c.method === method && c.path === path);

describe("開業費（009 US3）", () => {
  const decisionBox = () => screen.findByRole("textbox", { name: "開業費の償却額（2025年分）" });

  it("画面の見出しは「開業費」。固定資産の台帳は出さない", async () => {
    mockScreen();
    renderPage();
    expect(await screen.findByRole("heading", { level: 1, name: "開業費" })).toBeInTheDocument();
    expect(screen.queryByRole("table", { name: "固定資産台帳" })).toBeNull();
  });

  it("年分を指定して一覧を読み、総額・本年の上限・目安・決定の状態を出す", async () => {
    const { calls } = mockScreen({ deferredAssets: [deferred()] });
    renderPage();

    const table = await screen.findByRole("table", { name: "開業費の一覧" });
    const cells = within(within(table).getByRole("row", { name: /開業費/ }))
      .getAllByRole("cell")
      .map((c) => c.textContent);
    expect(cells).toEqual(
      expect.arrayContaining(["開業費", "2025-04-01", "300,000", "45,000", "未決定"]),
    );
    expect(callsOf(calls, "GET", DEFERRED)[0]?.query).toEqual({ year: "2025" });
  });

  it("開業費がなければ、その旨を出す", async () => {
    mockScreen();
    renderPage();
    expect(await screen.findByText("開業費はまだ登録されていません。")).toBeInTheDocument();
  });

  it("登録する。総額は整数、勘定は資産の科目から選ぶ。累計は空なら 0・年分は null", async () => {
    const { calls } = mockScreen();
    const user = userEvent.setup();
    renderPage();

    await user.type(await screen.findByRole("textbox", { name: "開業費の名称" }), "開業費");
    await user.type(screen.getByRole("textbox", { name: "開業費の総額" }), "300,000");
    await user.type(screen.getByLabelText("開業日"), "2025-04-01");
    const account = screen.getByRole("combobox", { name: "開業費の勘定" });
    await waitFor(() => expect(within(account).getAllByRole("option").length).toBeGreaterThan(1));
    expect(
      within(account)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["選択してください", "工具器具備品", "普通預金", "開業費"]);
    await user.selectOptions(account, "a-open");
    await user.click(screen.getByRole("button", { name: "開業費を登録" }));

    await waitFor(() => expect(callsOf(calls, "POST", DEFERRED)).toHaveLength(1));
    expect(callsOf(calls, "POST", DEFERRED)[0]?.body).toEqual({
      name: "開業費",
      totalAmount: 300_000,
      openedOn: "2025-04-01",
      priorAccumulated: 0,
      priorThroughYear: null,
      accountId: "a-open",
      note: null,
    });
    expect(await screen.findByText("開業費を登録しました。")).toBeInTheDocument();

    // 次の登録が入力の不備で送られないとき、2 回目の知らせを出さない（前の toast は 5 秒で消える）
    await user.click(screen.getByRole("button", { name: "開業費を登録" }));
    expect(callsOf(calls, "POST", DEFERRED)).toHaveLength(1);
    expect(screen.getAllByText("開業費を登録しました。")).toHaveLength(1);
  });

  it("前年までの累計とその年分を送る。累計があるのに年分がなければ、総額が整数でなければ送らない", async () => {
    const { calls } = mockScreen();
    const user = userEvent.setup();
    renderPage();

    await user.type(await screen.findByRole("textbox", { name: "開業費の名称" }), "開業費");
    await user.type(screen.getByRole("textbox", { name: "開業費の総額" }), "12.5");
    await user.type(screen.getByLabelText("開業日"), "2025-04-01");
    await user.type(screen.getByRole("textbox", { name: "開業費の前年までの償却累計額" }), "45000");
    await user.click(screen.getByRole("button", { name: "開業費を登録" }));
    expect(await screen.findByText(/開業費の総額は1円以上の整数/)).toBeInTheDocument();
    expect(screen.getByText(/累計が何年分までかを入力してください/)).toBeInTheDocument();
    expect(callsOf(calls, "POST", DEFERRED)).toHaveLength(0);

    await user.clear(screen.getByRole("textbox", { name: "開業費の総額" }));
    await user.type(screen.getByRole("textbox", { name: "開業費の総額" }), "300000");
    await user.type(screen.getByRole("textbox", { name: "開業費の累計の年分" }), "2025");
    await waitFor(() =>
      expect(
        within(screen.getByRole("combobox", { name: "開業費の勘定" })).getAllByRole("option"),
      ).toHaveLength(4),
    );
    await user.selectOptions(screen.getByRole("combobox", { name: "開業費の勘定" }), "a-open");
    await user.click(screen.getByRole("button", { name: "開業費を登録" }));
    await waitFor(() => expect(callsOf(calls, "POST", DEFERRED)).toHaveLength(1));
    expect(callsOf(calls, "POST", DEFERRED)[0]?.body).toMatchObject({
      priorAccumulated: 45_000,
      priorThroughYear: 2025,
    });
  });

  it("編集すると入力欄に値を入れ、変更の理由を付けて PUT する。409 は仕訳のある年度を示す", async () => {
    const { calls } = mockScreen({
      deferredAssets: [deferred({ priorAccumulated: 45_000, priorThroughYear: 2024 })],
      overrides: {
        [`PUT ${DEFERRED}/d-1`]: () =>
          apiError(409, "DEPRECIATION_JOURNAL_EXISTS", "登録されています", { years: [2025] }),
      },
    });
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole("button", { name: "開業費を編集" }));
    expect(screen.getByRole("textbox", { name: "開業費の総額" })).toHaveValue("300000");
    expect(screen.getByRole("textbox", { name: "開業費の前年までの償却累計額" })).toHaveValue(
      "45000",
    );
    expect(screen.getByRole("textbox", { name: "開業費の累計の年分" })).toHaveValue("2024");
    await user.type(screen.getByRole("textbox", { name: "開業費の変更の理由" }), "総額の訂正");
    await user.click(screen.getByRole("button", { name: "開業費を更新" }));

    await waitFor(() => expect(callsOf(calls, "PUT", `${DEFERRED}/d-1`)).toHaveLength(1));
    expect(callsOf(calls, "PUT", `${DEFERRED}/d-1`)[0]?.body).toMatchObject({
      totalAmount: 300_000,
      accountId: "a-open",
      priorAccumulated: 45_000,
      priorThroughYear: 2024,
      reason: "総額の訂正",
    });
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("2025年度の減価償却の仕訳が登録されています");
    expect(alert).toHaveTextContent("先にその仕訳を取り消してください");
  });

  it("保存したあと、案・決算書・開業費の query を読み直す", async () => {
    const { calls } = mockScreen();
    const user = userEvent.setup();
    renderPage();

    await user.type(await screen.findByRole("textbox", { name: "開業費の名称" }), "開業費");
    await user.type(screen.getByRole("textbox", { name: "開業費の総額" }), "300000");
    await user.type(screen.getByLabelText("開業日"), "2025-04-01");
    await waitFor(() =>
      expect(
        within(screen.getByRole("combobox", { name: "開業費の勘定" })).getAllByRole("option"),
      ).toHaveLength(4),
    );
    await user.selectOptions(screen.getByRole("combobox", { name: "開業費の勘定" }), "a-open");
    await waitFor(() => expect(callsOf(calls, "GET", ADJUSTMENTS)).toHaveLength(1));
    const listReads = callsOf(calls, "GET", DEFERRED).length;
    await user.click(screen.getByRole("button", { name: "開業費を登録" }));
    await waitFor(() => expect(callsOf(calls, "POST", DEFERRED)).toHaveLength(1));
    await waitFor(() => expect(callsOf(calls, "GET", ADJUSTMENTS).length).toBeGreaterThan(1));
    await waitFor(() => expect(callsOf(calls, "GET", DEFERRED).length).toBeGreaterThan(listReads));
  });

  it("償却額の決定は上限と目安を見せ、整数を PUT する。決定のあと案・決算書・開業費を読み直す", async () => {
    const { calls } = mockScreen({ deferredAssets: [deferred()] });
    const user = userEvent.setup();
    renderPage();

    const group = await screen.findByRole("group", { name: "開業費の償却額の決定" });
    expect(within(group).getByText("上限（期首の未償却残高）")).toBeInTheDocument();
    expect(within(group).getByText("300,000")).toBeInTheDocument();
    expect(within(group).getByText("目安")).toBeInTheDocument();
    expect(within(group).getByText("45,000")).toBeInTheDocument();
    await waitFor(() => expect(callsOf(calls, "GET", ADJUSTMENTS)).toHaveLength(1));
    const listReads = callsOf(calls, "GET", DEFERRED).length;

    await user.type(await decisionBox(), "45,000");
    await user.click(within(group).getByRole("button", { name: "開業費の償却額を決定" }));

    await waitFor(() =>
      expect(callsOf(calls, "PUT", `${DEFERRED}/d-1/amortizations/2025`)).toHaveLength(1),
    );
    expect(callsOf(calls, "PUT", `${DEFERRED}/d-1/amortizations/2025`)[0]?.body).toEqual({
      amount: 45_000,
    });
    await waitFor(() => expect(callsOf(calls, "GET", ADJUSTMENTS).length).toBeGreaterThan(1));
    await waitFor(() => expect(callsOf(calls, "GET", DEFERRED).length).toBeGreaterThan(listReads));
    expect(await screen.findByText("2025年分の償却額を決定しました。")).toBeInTheDocument();
    const row = screen.getByRole("row", { name: /開業費 2025-04-01/ });
    expect(
      within(row)
        .getAllByRole("cell")
        .map((c) => c.textContent),
    ).toContain("45,000");
  });

  it("0 円は「償却しない」と表示する", async () => {
    mockScreen({ deferredAssets: [deferred()] });
    const user = userEvent.setup();
    renderPage();

    await user.type(await decisionBox(), "0");
    await user.click(screen.getByRole("button", { name: "開業費の償却額を決定" }));

    expect(await screen.findByText("2025年分は償却しないと決定しました。")).toBeInTheDocument();
    const row = screen.getByRole("row", { name: /開業費 2025-04-01/ });
    await waitFor(() =>
      expect(
        within(row)
          .getAllByRole("cell")
          .map((c) => c.textContent),
      ).toContain("償却しない"),
    );
  });

  it("償却額が 0 以上の整数でなければ送らない", async () => {
    const { calls } = mockScreen({ deferredAssets: [deferred()] });
    const user = userEvent.setup();
    renderPage();

    await user.type(await decisionBox(), "-1");
    await user.click(screen.getByRole("button", { name: "開業費の償却額を決定" }));
    expect(await screen.findByText(/償却額は0以上の整数で入力してください/)).toBeInTheDocument();
    expect(callsOf(calls, "PUT", `${DEFERRED}/d-1/amortizations/2025`)).toHaveLength(0);
  });

  it("上限を超える決定は 422 のメッセージを画面に出す", async () => {
    mockScreen({
      deferredAssets: [deferred()],
      overrides: {
        [`PUT ${DEFERRED}/d-1/amortizations/2025`]: () =>
          apiError(
            422,
            "DEFERRED_AMORTIZATION_OVER_LIMIT",
            "償却額は上限 300,000 円以下にしてください",
            { limit: 300_000 },
          ),
      },
    });
    const user = userEvent.setup();
    renderPage();

    await user.type(await decisionBox(), "300001");
    await user.click(screen.getByRole("button", { name: "開業費の償却額を決定" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("上限 300,000 円以下");
  });

  it("仕訳を登録した年度は、決定を変えられない", async () => {
    mockScreen({
      deferredAssets: [
        deferred({
          amortization: deferredView({
            registered: true,
            decision: {
              deferredAssetId: "d-1",
              fiscalYear: 2025,
              amount: 45_000,
              decidedAt: "2025-12-01T00:00:00.000Z",
              updatedAt: "2025-12-01T00:00:00.000Z",
            },
          }),
        }),
      ],
    });
    renderPage();

    const group = await screen.findByRole("group", { name: "開業費の償却額の決定" });
    expect(within(group).getByText(/仕訳を登録済み/)).toBeInTheDocument();
    expect(within(group).getByRole("button", { name: "開業費の償却額を決定" })).toBeDisabled();
  });

  it("開業費の案の内訳（総額・期首残高・償却額・目安・期末残高）を出し、「仕訳を登録」で確定したあと開業費を読み直す", async () => {
    const { calls } = mockScreen({
      deferredAssets: [deferred({ amortization: deferredView({ decision: null }) })],
      proposals: [DEFERRED_PROPOSAL],
    });
    const user = userEvent.setup();
    renderPage();

    const panel = await screen.findByRole("group", { name: "開業費の振替の案" });
    for (const label of ["総額", "期首の未償却残高", "償却額", "目安", "期末の未償却残高"]) {
      expect(within(panel).getByText(label)).toBeInTheDocument();
    }
    expect(within(panel).getByText("255,000")).toBeInTheDocument();
    expect(within(panel).getByText("2025-12-31")).toBeInTheDocument();
    const listReads = callsOf(calls, "GET", DEFERRED).length;
    // 主な操作は「開業費を登録」。仕訳の案の「仕訳を登録」は名前で一意に見つかる
    expect(screen.getByRole("button", { name: "開業費を登録" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "仕訳を登録" })).toHaveLength(1);
    await user.click(within(panel).getByRole("button", { name: "仕訳を登録" }));

    await waitFor(() => expect(callsOf(calls, "POST", ADJUSTMENTS)).toHaveLength(1));
    expect(callsOf(calls, "POST", ADJUSTMENTS)[0]?.body).toEqual({
      kind: "deferred_amortization",
      sourceId: "d-1",
      expected: { amount: 45_000 },
    });
    await waitFor(() => expect(callsOf(calls, "GET", DEFERRED).length).toBeGreaterThan(listReads));
    expect(await screen.findByText("登録する仕訳の案はありません。")).toBeInTheDocument();
  });
});

describe("年分の入力欄は URL に追従する", () => {
  it("戻る・進むで ?year が変わると、欄も同じ年になる", async () => {
    mockScreen();
    const { router } = renderPage();
    const input = await screen.findByRole("textbox", { name: "年分" });
    expect(input).toHaveValue("2025");

    await act(async () => {
      router.history.push("/e/e1/deferred-assets/?year=2024");
    });
    await waitFor(() => expect(screen.getByRole("textbox", { name: "年分" })).toHaveValue("2024"));
  });
});
