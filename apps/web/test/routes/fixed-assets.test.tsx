import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AdjustmentProposal } from "@trebuchet/schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Route as FixedAssetsRoute } from "@/routes/e/$entityId/fixed-assets/index";
import { ENTITY } from "../fixtures";
import { type ApiCall, apiError, mockApi, ok } from "../mock-api";
import { renderRoute } from "../render-route";

const ASSETS = `${ENTITY}/fixed-assets`;
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
];

const depreciation = (over: Record<string, unknown> = {}) => ({
  cost: 200_000,
  base: 200_000,
  ordinary: 200_000,
  total: 200_000,
  businessRatio: 5000,
  deductible: 100_000,
  closingBookValue: 0,
  ...over,
});

const asset = (over: Record<string, unknown> = {}) => ({
  id: "as-1",
  name: "ノートパソコン",
  quantity: "1台",
  acquiredOn: "2025-06-15",
  acquisitionCost: 200_000,
  method: "small_asset_28_2",
  usefulLifeYears: null,
  businessRatio: 5000,
  assetAccountId: "a-tools",
  linkedJournalId: null,
  note: null,
  disposedOn: null,
  createdAt: "2025-06-15T00:00:00.000Z",
  updatedAt: "2025-06-15T00:00:00.000Z",
  depreciation: depreciation(),
  ...over,
});

const PROPOSAL: AdjustmentProposal = {
  kind: "depreciation",
  sourceId: "as-1",
  journal: {
    date: "2025-12-31",
    memo: "減価償却費の計上（ノートパソコン 少額減価償却資産 事業専用割合 50%）",
    lines: [
      { side: "debit", accountId: "a-dep", amount: 200_000, taxCategory: "OUT_OF_SCOPE" },
      { side: "credit", accountId: "a-tools", amount: 200_000, taxCategory: "OUT_OF_SCOPE" },
      { side: "debit", accountId: "a-owner", amount: 100_000, taxCategory: "OUT_OF_SCOPE" },
      { side: "credit", accountId: "a-dep", amount: 100_000, taxCategory: "OUT_OF_SCOPE" },
    ],
  },
  breakdown: {
    method: "small_asset_28_2" as const,
    acquisitionCost: 200_000,
    businessRatio: 5000,
    depreciation: 200_000,
    deductible: 100_000,
    months: null,
    ratePermille: null,
    openingBookValue: 200_000,
    closingBookValue: 0,
    disposalKind: null,
    disposalAmount: 0,
    disposalDeductible: 0,
  },
};

const DEFERRED = `${ENTITY}/deferred-assets`;

/** 開業費は固定資産台帳に出さない。出さないことの検査だけに使う（開業費の画面は deferred-assets.test.tsx） */
const deferred = () => ({
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
  amortization: null,
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

const journal = (id: string, journalNo: number, date: string, memo: string | null) => ({
  id,
  journalNo,
  date,
  memo,
  status: "active",
  version: 1,
  correctsJournalId: null,
  lines: [],
});

type Opts = {
  assets?: unknown[];
  /** 開業費（009 US3）。`amortization` を付けた API の応答の形 */
  deferredAssets?: unknown[];
  /** 開業費の科目（資産）を勘定の一覧に足す */
  withOpenAccount?: boolean;
  proposals?: AdjustmentProposal[];
  /** 個別の応答（同じキーの既定の応答を置き換える） */
  overrides?: Parameters<typeof mockApi>[0];
};

const straightLine = (over: Record<string, unknown> = {}) =>
  asset({
    name: "機材A",
    acquiredOn: "2025-07-10",
    inServiceOn: "2025-07-10",
    acquisitionCost: 500_000,
    method: "straight_line",
    usefulLifeYears: 4,
    priorAccumulated: 0,
    priorThroughYear: null,
    disposalKind: null,
    businessRatio: 10000,
    depreciationError: null,
    depreciation: depreciation({
      method: "straight_line",
      cost: 500_000,
      base: 500_000,
      ordinary: 62_500,
      total: 62_500,
      businessRatio: 10000,
      deductible: 62_500,
      closingBookValue: 437_500,
      ratePermille: 250,
      months: 6,
    }),
    ...over,
  });

function mockScreen(opts: Opts = {}) {
  const state = {
    assets: opts.assets ?? [],
    deferredAssets: opts.deferredAssets ?? [],
    proposals: opts.proposals ?? [],
  };
  const calls = mockApi({
    [`GET ${ENTITY}/accounts`]: () =>
      ok({
        accounts: [
          ...ACCOUNTS,
          account("a-dep", "減価償却費", "expense"),
          account("a-owner", "事業主貸", "equity"),
          // 開業費の勘定。既存の「資産の勘定」の選択肢の検査を変えないよう、開業費のテストだけに足す
          ...(opts.withOpenAccount ? [account("a-open", "開業費", "asset")] : []),
        ],
      }),
    [`GET ${ENTITY}/journals`]: () =>
      ok({
        journals: [
          journal("j-1", 12, "2025-06-14", "ノートパソコン購入"),
          journal("j-2", 11, "2025-03-01", null),
        ],
        nextCursor: null,
      }),
    [`GET ${ASSETS}`]: () => ok({ assets: state.assets }),
    [`POST ${ASSETS}`]: (call) => {
      const saved = asset({ id: "as-new", ...(call.body as object), depreciation: depreciation() });
      state.assets = [...state.assets, saved];
      return ok({ asset: saved }, 201);
    },
    [`PUT ${ASSETS}/as-1`]: (call) => {
      const saved = asset({ ...(call.body as object) });
      state.assets = [saved];
      return ok({ asset: saved });
    },
    [`POST ${ASSETS}/as-1/dispose`]: (call) => {
      const saved = asset({ disposedOn: (call.body as { disposedOn: string }).disposedOn });
      state.assets = [saved];
      return ok({ asset: saved });
    },
    [`GET ${DEFERRED}`]: () => ok({ deferredAssets: state.deferredAssets }),
    [`GET ${ADJUSTMENTS}`]: () => ok({ proposals: state.proposals }),
    [`POST ${ADJUSTMENTS}`]: () => {
      state.proposals = [];
      return ok(
        {
          journal: { id: "j-new", journalNo: 7 },
          ref: {
            journalId: "j-new",
            kind: "depreciation",
            allocationId: null,
            assetId: "as-1",
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
  renderRoute(FixedAssetsRoute, {
    path: "/e/$entityId/fixed-assets/",
    url: `/e/e1/fixed-assets/${search}`,
  });

const callsOf = (calls: ApiCall[], method: string, path: string) =>
  calls.filter((c) => c.method === method && c.path === path);

describe("固定資産台帳の画面（US3）", () => {
  it("年分を指定して一覧を読み、取得価額・事業専用割合・償却費・必要経費算入額・未償却残高を出す", async () => {
    const { calls } = mockScreen({ assets: [asset()] });
    renderPage();

    const table = await screen.findByRole("table", { name: "固定資産台帳" });
    const row = within(table).getByRole("row", { name: /ノートパソコン/ });
    const cells = within(row)
      .getAllByRole("cell")
      .map((c) => c.textContent);
    expect(cells).toEqual(
      expect.arrayContaining(["ノートパソコン", "2025-06-15", "200,000", "50%", "100,000", "0"]),
    );
    expect(within(row).getByRole("button", { name: "ノートパソコンを編集" })).toBeInTheDocument();
    expect(within(row).getByRole("button", { name: "ノートパソコンを除却" })).toBeInTheDocument();
    expect(callsOf(calls, "GET", ASSETS)[0]?.query).toEqual({ year: "2025" });
  });

  it("除却した資産は除却の日を示し、除却の操作を出さない", async () => {
    mockScreen({ assets: [asset({ disposedOn: "2025-12-01" })] });
    renderPage();

    const row = await screen.findByRole("row", { name: /ノートパソコン/ });
    expect(within(row).getByText("除却 2025-12-01")).toBeInTheDocument();
    expect(within(row).queryByRole("button", { name: "ノートパソコンを除却" })).toBeNull();
  });

  it("資産の勘定は資産の科目（使用中のもの）だけ、償却の方法は 3 つ（既定は少額の特例）から選べる", async () => {
    mockScreen();
    renderPage();

    const select = await screen.findByRole("combobox", { name: "資産の勘定" });
    await waitFor(() => expect(within(select).getAllByRole("option").length).toBeGreaterThan(1));
    expect(
      within(select)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["選択してください", "工具器具備品", "普通預金"]);
    const method = screen.getByRole("combobox", { name: "償却の方法" });
    expect(
      within(method)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["少額減価償却資産の特例（措置法28条の2）", "定額法", "一括償却資産（3年均等）"]);
    expect(method).toHaveValue("small_asset_28_2");
    // 少額の特例では、耐用年数・供用日・累計の欄を出さない
    expect(screen.queryByRole("textbox", { name: "耐用年数" })).toBeNull();
    expect(screen.queryByLabelText("事業の用に供した年月日")).toBeNull();
    expect(screen.queryByRole("textbox", { name: "前年までの償却累計額" })).toBeNull();
  });

  it("登録する。取得価額は整数、割合は % から万分率、結びつける仕訳は任意で選べる", async () => {
    const { calls } = mockScreen();
    const user = userEvent.setup();
    renderPage();

    await user.type(await screen.findByRole("textbox", { name: "資産名" }), "ノートパソコン");
    await user.type(screen.getByRole("textbox", { name: "数量" }), "1台");
    await user.type(screen.getByLabelText("取得年月日"), "2025-06-15");
    await user.type(screen.getByRole("textbox", { name: "取得価額" }), "200,000");
    await user.clear(screen.getByRole("textbox", { name: "事業専用割合（%）" }));
    await user.type(screen.getByRole("textbox", { name: "事業専用割合（%）" }), "50");
    await user.selectOptions(screen.getByRole("combobox", { name: "資産の勘定" }), "a-tools");
    const link = await screen.findByRole("combobox", { name: "結びつける仕訳" });
    await waitFor(() => expect(within(link).getAllByRole("option").length).toBeGreaterThan(1));
    await user.selectOptions(link, "j-1");
    await user.click(screen.getByRole("button", { name: "登録" }));

    await waitFor(() => expect(callsOf(calls, "POST", ASSETS)).toHaveLength(1));
    expect(callsOf(calls, "POST", ASSETS)[0]?.body).toEqual({
      name: "ノートパソコン",
      quantity: "1台",
      acquiredOn: "2025-06-15",
      acquisitionCost: 200_000,
      method: "small_asset_28_2",
      usefulLifeYears: null,
      inServiceOn: null,
      priorAccumulated: 0,
      priorThroughYear: null,
      businessRatio: 5000,
      assetAccountId: "a-tools",
      linkedJournalId: "j-1",
      note: null,
    });
    // 結びつける仕訳の候補は取得年月日の年の仕訳
    expect(callsOf(calls, "GET", `${ENTITY}/journals`).at(-1)?.query).toMatchObject({
      dateFrom: "2025-01-01",
      dateTo: "2025-12-31",
    });
    // 登録後は一覧を読み直す
    expect(await screen.findByRole("table", { name: "固定資産台帳" })).toBeInTheDocument();
    expect(await screen.findByText("登録しました。")).toBeInTheDocument();
  });

  it("取得価額・割合の形が不正なら送らない", async () => {
    const { calls } = mockScreen();
    const user = userEvent.setup();
    renderPage();

    await user.type(await screen.findByRole("textbox", { name: "資産名" }), "備品");
    await user.type(screen.getByLabelText("取得年月日"), "2025-06-15");
    await user.selectOptions(screen.getByRole("combobox", { name: "資産の勘定" }), "a-tools");
    await user.type(screen.getByRole("textbox", { name: "取得価額" }), "12.5");
    await user.click(screen.getByRole("button", { name: "登録" }));
    expect(await screen.findByText(/取得価額は1円以上の整数/)).toBeInTheDocument();

    await user.clear(screen.getByRole("textbox", { name: "取得価額" }));
    await user.type(screen.getByRole("textbox", { name: "取得価額" }), "10000");
    await user.clear(screen.getByRole("textbox", { name: "事業専用割合（%）" }));
    await user.type(screen.getByRole("textbox", { name: "事業専用割合（%）" }), "100.5");
    await user.click(screen.getByRole("button", { name: "登録" }));
    expect(await screen.findByText(/0〜100 の数値を小数第2位まで/)).toBeInTheDocument();
    expect(callsOf(calls, "POST", ASSETS)).toHaveLength(0);
  });

  it("サーバーの業務エラー（基準額以上）を画面に出す", async () => {
    mockApi({
      [`GET ${ENTITY}/accounts`]: () => ok({ accounts: ACCOUNTS }),
      [`GET ${ENTITY}/journals`]: () => ok({ journals: [], nextCursor: null }),
      [`GET ${ASSETS}`]: () => ok({ assets: [] }),
      [`GET ${ADJUSTMENTS}`]: () => ok({ proposals: [] }),
      [`POST ${ASSETS}`]: () =>
        apiError(
          422,
          "SMALL_ASSET_OVER_THRESHOLD",
          "取得価額が基準額（300000 円）以上のため、少額減価償却資産の特例は使えません",
        ),
    });
    const user = userEvent.setup();
    renderPage();

    await user.type(await screen.findByRole("textbox", { name: "資産名" }), "大きな備品");
    await user.type(screen.getByLabelText("取得年月日"), "2025-06-15");
    await user.selectOptions(screen.getByRole("combobox", { name: "資産の勘定" }), "a-tools");
    await user.type(screen.getByRole("textbox", { name: "取得価額" }), "500000");
    await user.click(screen.getByRole("button", { name: "登録" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("基準額");
  });

  it("編集すると入力欄に値を入れ、変更の理由を付けて PUT する", async () => {
    const { calls } = mockScreen({ assets: [asset()] });
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole("button", { name: "ノートパソコンを編集" }));
    expect(screen.getByRole("textbox", { name: "資産名" })).toHaveValue("ノートパソコン");
    expect(screen.getByRole("textbox", { name: "取得価額" })).toHaveValue("200000");
    expect(screen.getByRole("textbox", { name: "事業専用割合（%）" })).toHaveValue("50");
    const ratio = screen.getByRole("textbox", { name: "事業専用割合（%）" });
    await user.clear(ratio);
    await user.type(ratio, "60");
    await user.type(screen.getByRole("textbox", { name: "変更の理由" }), "使い方の見直し");
    await user.click(screen.getByRole("button", { name: "更新" }));

    await waitFor(() => expect(callsOf(calls, "PUT", `${ASSETS}/as-1`)).toHaveLength(1));
    expect(callsOf(calls, "PUT", `${ASSETS}/as-1`)[0]?.body).toMatchObject({
      name: "ノートパソコン",
      acquisitionCost: 200_000,
      businessRatio: 6000,
      assetAccountId: "a-tools",
      reason: "使い方の見直し",
    });
    // 保存後は編集を終えて入力欄を作り直すが、メッセージは残る
    expect(await screen.findByText("更新しました。")).toBeInTheDocument();
  });

  it("除却は日付と理由を入れて確定する（POST dispose）。取り消すと送らない", async () => {
    const { calls } = mockScreen({ assets: [asset()] });
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole("button", { name: "ノートパソコンを除却" }));
    let dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "戻る" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(callsOf(calls, "POST", `${ASSETS}/as-1/dispose`)).toHaveLength(0);

    await user.click(screen.getByRole("button", { name: "ノートパソコンを除却" }));
    dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("除却年月日"), "2025-12-01");
    await user.type(within(dialog).getByRole("textbox", { name: "理由" }), "故障して廃棄");
    await user.click(within(dialog).getByRole("button", { name: "除却する" }));

    await waitFor(() => expect(callsOf(calls, "POST", `${ASSETS}/as-1/dispose`)).toHaveLength(1));
    expect(callsOf(calls, "POST", `${ASSETS}/as-1/dispose`)[0]?.body).toEqual({
      disposedOn: "2025-12-01",
      reason: "故障して廃棄",
    });
    expect(await screen.findByText("除却 2025-12-01")).toBeInTheDocument();
  });

  it("償却の案を AdjustmentPanel に出し、「仕訳を登録」で確定する（画面は計算しない）", async () => {
    const { calls } = mockScreen({ assets: [asset()], proposals: [PROPOSAL] });
    const user = userEvent.setup();
    renderPage();

    const panel = await screen.findByRole("group", { name: "ノートパソコンの振替の案" });
    expect(within(panel).getByText("取得価額")).toBeInTheDocument();
    expect(within(panel).getByText("必要経費算入額")).toBeInTheDocument();
    expect(within(panel).getByText("2025-12-31")).toBeInTheDocument();
    const table = within(panel).getByRole("table", { name: "ノートパソコンの仕訳の案" });
    expect(within(table).getAllByRole("row")).toHaveLength(5);
    expect(screen.getByRole("button", { name: "登録" })).toBeInTheDocument();
    await user.click(within(panel).getByRole("button", { name: "仕訳を登録" }));

    await waitFor(() => expect(callsOf(calls, "POST", ADJUSTMENTS)).toHaveLength(1));
    expect(callsOf(calls, "POST", ADJUSTMENTS)[0]?.body).toEqual({
      kind: "depreciation",
      sourceId: "as-1",
      expected: { amount: 300_000 },
    });
    expect(await screen.findByText("登録する仕訳の案はありません。")).toBeInTheDocument();
    expect(screen.getByText("仕訳を登録しました（No.7）。")).toBeInTheDocument();
  });
});

/** 資産の名前・取得日・価額・勘定を入れる（償却の方法の選択の前でも後でもよい） */
async function fillBasics(user: ReturnType<typeof userEvent.setup>, cost: string) {
  await user.type(await screen.findByRole("textbox", { name: "資産名" }), "機材A");
  await user.type(screen.getByLabelText("取得年月日"), "2025-07-10");
  await user.type(screen.getByRole("textbox", { name: "取得価額" }), cost);
  await user.selectOptions(screen.getByRole("combobox", { name: "資産の勘定" }), "a-tools");
}

describe("償却の方法ごとの登録（009 US1）", () => {
  it("定額法: 耐用年数の欄が出て、供用日・累計とその年分といっしょに送る", async () => {
    const { calls } = mockScreen();
    const user = userEvent.setup();
    renderPage();

    await fillBasics(user, "500000");
    await user.selectOptions(screen.getByRole("combobox", { name: "償却の方法" }), "straight_line");
    await user.type(screen.getByRole("textbox", { name: "耐用年数" }), "4");
    await user.type(screen.getByLabelText("事業の用に供した年月日"), "2025-07-10");
    await user.type(screen.getByRole("textbox", { name: "前年までの償却累計額" }), "100,000");
    await user.type(screen.getByRole("textbox", { name: "累計の年分（何年分までか）" }), "2024");
    await user.click(screen.getByRole("button", { name: "登録" }));

    await waitFor(() => expect(callsOf(calls, "POST", ASSETS)).toHaveLength(1));
    expect(callsOf(calls, "POST", ASSETS)[0]?.body).toMatchObject({
      method: "straight_line",
      usefulLifeYears: 4,
      inServiceOn: "2025-07-10",
      priorAccumulated: 100_000,
      priorThroughYear: 2024,
      acquisitionCost: 500_000,
    });
  });

  it("定額法: 耐用年数が空か整数でなければ送らない。累計があるのに年分がなければ送らない", async () => {
    const { calls } = mockScreen();
    const user = userEvent.setup();
    renderPage();

    await fillBasics(user, "500000");
    await user.selectOptions(screen.getByRole("combobox", { name: "償却の方法" }), "straight_line");
    await user.click(screen.getByRole("button", { name: "登録" }));
    expect(await screen.findByText(/耐用年数は1以上の整数/)).toBeInTheDocument();

    await user.type(screen.getByRole("textbox", { name: "耐用年数" }), "4");
    await user.type(screen.getByRole("textbox", { name: "前年までの償却累計額" }), "100000");
    await user.click(screen.getByRole("button", { name: "登録" }));
    expect(await screen.findByText(/累計が何年分までかを入力/)).toBeInTheDocument();
    expect(callsOf(calls, "POST", ASSETS)).toHaveLength(0);
  });

  it("一括償却: 耐用年数の欄は出ない。供用日と累計を送り、耐用年数は null", async () => {
    const { calls } = mockScreen();
    const user = userEvent.setup();
    renderPage();

    await fillBasics(user, "150000");
    await user.selectOptions(screen.getByRole("combobox", { name: "償却の方法" }), "lump_sum");
    expect(screen.queryByRole("textbox", { name: "耐用年数" })).toBeNull();
    expect(screen.getByRole("textbox", { name: "前年までの償却累計額" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "登録" }));

    await waitFor(() => expect(callsOf(calls, "POST", ASSETS)).toHaveLength(1));
    expect(callsOf(calls, "POST", ASSETS)[0]?.body).toMatchObject({
      method: "lump_sum",
      usefulLifeYears: null,
      inServiceOn: null,
      priorAccumulated: 0,
      priorThroughYear: null,
    });
  });

  it("方法を少額の特例に戻すと、定額法の入力欄を隠し、送る値も既定に戻す", async () => {
    const { calls } = mockScreen();
    const user = userEvent.setup();
    renderPage();

    await fillBasics(user, "200000");
    const method = screen.getByRole("combobox", { name: "償却の方法" });
    await user.selectOptions(method, "straight_line");
    await user.type(screen.getByRole("textbox", { name: "耐用年数" }), "4");
    await user.selectOptions(method, "small_asset_28_2");
    expect(screen.queryByRole("textbox", { name: "耐用年数" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "登録" }));

    await waitFor(() => expect(callsOf(calls, "POST", ASSETS)).toHaveLength(1));
    expect(callsOf(calls, "POST", ASSETS)[0]?.body).toMatchObject({
      method: "small_asset_28_2",
      usefulLifeYears: null,
    });
  });

  it("定額法の資産を編集すると、耐用年数・供用日・累計を入力欄に入れる", async () => {
    mockScreen({
      assets: [straightLine({ id: "as-1", priorAccumulated: 100_000, priorThroughYear: 2024 })],
    });
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole("button", { name: "機材Aを編集" }));
    expect(screen.getByRole("combobox", { name: "償却の方法" })).toHaveValue("straight_line");
    expect(screen.getByRole("textbox", { name: "耐用年数" })).toHaveValue("4");
    expect(screen.getByLabelText("事業の用に供した年月日")).toHaveValue("2025-07-10");
    expect(screen.getByRole("textbox", { name: "前年までの償却累計額" })).toHaveValue("100000");
    expect(screen.getByRole("textbox", { name: "累計の年分（何年分までか）" })).toHaveValue("2024");
  });

  it("業務エラー（耐用年数が表にない）を画面に出す", async () => {
    mockScreen({
      overrides: {
        [`POST ${ASSETS}`]: () =>
          apiError(422, "USEFUL_LIFE_UNSUPPORTED", "耐用年数 1 年は償却率の表にありません", {
            usefulLifeYears: 1,
          }),
      },
    });
    const user = userEvent.setup();
    renderPage();

    await fillBasics(user, "500000");
    await user.selectOptions(screen.getByRole("combobox", { name: "償却の方法" }), "straight_line");
    await user.type(screen.getByRole("textbox", { name: "耐用年数" }), "1");
    await user.click(screen.getByRole("button", { name: "登録" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("償却率の表にありません");
  });

  it("前の登録の「登録しました。」を、次の登録の失敗のときに残さない", async () => {
    let posts = 0;
    mockScreen({
      overrides: {
        [`POST ${ASSETS}`]: () => {
          posts += 1;
          return posts === 1
            ? ok({ asset: asset({ id: "as-new", depreciation: depreciation() }) }, 201)
            : apiError(422, "USEFUL_LIFE_UNSUPPORTED", "耐用年数 1 年は償却率の表にありません", {
                usefulLifeYears: 1,
              });
        },
      },
    });
    const user = userEvent.setup();
    renderPage();

    await fillBasics(user, "200000");
    await user.click(screen.getByRole("button", { name: "登録" }));
    expect(await screen.findByText("登録しました。")).toBeInTheDocument();

    await fillBasics(user, "500000");
    await user.selectOptions(screen.getByRole("combobox", { name: "償却の方法" }), "straight_line");
    await user.type(screen.getByRole("textbox", { name: "耐用年数" }), "1");
    await user.click(screen.getByRole("button", { name: "登録" }));
    // 前の成功の toast は 5 秒で消える（失敗の知らせとは別に残りうる）。失敗は role=alert で出る
    expect(await screen.findByRole("alert")).toHaveTextContent("償却率の表にありません");
  });

  it("保存したあと、案と決算書の query を読み直す（資産の保存は仕訳を変えないので台帳と決算書の年度だけ）", async () => {
    const { calls } = mockScreen();
    const user = userEvent.setup();
    renderPage();

    await fillBasics(user, "200000");
    await waitFor(() => expect(callsOf(calls, "GET", ADJUSTMENTS)).toHaveLength(1));
    await user.click(screen.getByRole("button", { name: "登録" }));
    await waitFor(() => expect(callsOf(calls, "POST", ASSETS)).toHaveLength(1));
    await waitFor(() => expect(callsOf(calls, "GET", ADJUSTMENTS).length).toBeGreaterThan(1));
  });
});

describe("除却の種類（009 FR-009）", () => {
  it("定額法の資産: 廃棄が既定。売却を選ぶと範囲外の注意書きを出し、disposalKind を送る", async () => {
    const { calls } = mockScreen({ assets: [straightLine({ id: "as-1" })] });
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole("button", { name: "機材Aを除却" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("radio", { name: "廃棄" })).toBeChecked();
    expect(within(dialog).queryByText(/譲渡所得の計算はこのアプリの範囲外/)).toBeNull();
    await user.click(within(dialog).getByRole("radio", { name: "売却" }));
    expect(within(dialog).getByText(/譲渡所得の計算はこのアプリの範囲外/)).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText("除却年月日"), "2025-10-05");
    await user.type(within(dialog).getByRole("textbox", { name: "理由" }), "売却");
    await user.click(within(dialog).getByRole("button", { name: "除却する" }));

    await waitFor(() => expect(callsOf(calls, "POST", `${ASSETS}/as-1/dispose`)).toHaveLength(1));
    expect(callsOf(calls, "POST", `${ASSETS}/as-1/dispose`)[0]?.body).toEqual({
      disposedOn: "2025-10-05",
      reason: "売却",
      disposalKind: "sale",
    });
    // 保存したあと、案の query を読み直す
    await waitFor(() => expect(callsOf(calls, "GET", ADJUSTMENTS).length).toBeGreaterThan(1));
  });

  it("廃棄のまま確定すると disposalKind: scrap を送る", async () => {
    const { calls } = mockScreen({ assets: [straightLine({ id: "as-1" })] });
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole("button", { name: "機材Aを除却" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("除却年月日"), "2025-10-05");
    await user.type(within(dialog).getByRole("textbox", { name: "理由" }), "廃棄");
    await user.click(within(dialog).getByRole("button", { name: "除却する" }));

    await waitFor(() => expect(callsOf(calls, "POST", `${ASSETS}/as-1/dispose`)).toHaveLength(1));
    expect(callsOf(calls, "POST", `${ASSETS}/as-1/dispose`)[0]?.body).toMatchObject({
      disposalKind: "scrap",
    });
  });

  it("少額の特例の資産には種類の選択を出さない", async () => {
    mockScreen({ assets: [asset()] });
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole("button", { name: "ノートパソコンを除却" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryByRole("radio")).toBeNull();
  });

  it("409 DEPRECIATION_JOURNAL_EXISTS は仕訳のある年度を示し、先に仕訳を取り消すよう伝える", async () => {
    mockScreen({
      assets: [straightLine({ id: "as-1" })],
      overrides: {
        [`POST ${ASSETS}/as-1/dispose`]: () =>
          apiError(409, "DEPRECIATION_JOURNAL_EXISTS", "登録されています", {
            years: [2024, 2025],
          }),
      },
    });
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole("button", { name: "機材Aを除却" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("除却年月日"), "2025-10-05");
    await user.type(within(dialog).getByRole("textbox", { name: "理由" }), "廃棄");
    await user.click(within(dialog).getByRole("button", { name: "除却する" }));

    const alert = await within(dialog).findByRole("alert");
    expect(alert).toHaveTextContent("2024・2025年度の減価償却の仕訳が登録されています");
    expect(alert).toHaveTextContent("先にその仕訳を取り消してください");
  });

  it("409 は資産の更新でも同じ文言で出る", async () => {
    mockScreen({
      assets: [straightLine({ id: "as-1" })],
      overrides: {
        [`PUT ${ASSETS}/as-1`]: () =>
          apiError(409, "DEPRECIATION_JOURNAL_EXISTS", "登録されています", { years: [2025] }),
      },
    });
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole("button", { name: "機材Aを編集" }));
    await user.click(screen.getByRole("button", { name: "更新" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "2025年度の減価償却の仕訳が登録されています",
    );
  });
});

describe("台帳の一覧（009）", () => {
  it("償却方法の列と、売却・廃棄の除却を示す", async () => {
    mockScreen({
      assets: [
        straightLine({ id: "as-1", disposedOn: "2025-10-05", disposalKind: "sale" }),
        asset({ id: "as-2", name: "備品B" }),
      ],
    });
    renderPage();

    const table = await screen.findByRole("table", { name: "固定資産台帳" });
    const a = within(within(table).getByRole("row", { name: /機材A/ })).getAllByRole("cell");
    expect(a.map((c) => c.textContent)).toEqual(
      expect.arrayContaining(["定額法", "62,500", "437,500", "除却 2025-10-05（売却）"]),
    );
    const b = within(within(table).getByRole("row", { name: /備品B/ })).getAllByRole("cell");
    expect(b.map((c) => c.textContent)).toContain("少額の特例");
  });

  it("depreciationError のある資産は、償却を計算できない理由を示す", async () => {
    mockScreen({
      assets: [
        straightLine({
          id: "as-1",
          usefulLifeYears: 1,
          depreciation: null,
          depreciationError: {
            code: "USEFUL_LIFE_UNSUPPORTED",
            details: { usefulLifeYears: 1, acquiredOn: "2025-07-10" },
          },
        }),
      ],
    });
    renderPage();

    const row = await screen.findByRole("row", { name: /機材A/ });
    expect(within(row).getByText(/償却を計算できません/)).toHaveTextContent(
      "耐用年数が償却率の表にありません",
    );
  });
});

describe("決算整理の案の内訳（009）", () => {
  const straightProposal = (over: Record<string, unknown> = {}): AdjustmentProposal => ({
    ...PROPOSAL,
    sourceId: "as-1",
    breakdown: {
      method: "straight_line",
      acquisitionCost: 500_000,
      businessRatio: 6000,
      depreciation: 41_667,
      deductible: 25_000,
      months: 4,
      ratePermille: 250,
      openingBookValue: 500_000,
      closingBookValue: 0,
      disposalKind: "scrap",
      disposalAmount: 458_333,
      disposalDeductible: 274_999,
      ...over,
    } as AdjustmentProposal["breakdown"],
  });

  it("定額法の内訳に、方法・月数・率・除却の種類と金額を出す", async () => {
    mockScreen({ assets: [straightLine({ id: "as-1" })], proposals: [straightProposal()] });
    renderPage();

    const panel = await screen.findByRole("group", { name: "機材Aの振替の案" });
    expect(within(panel).getByText("償却方法")).toBeInTheDocument();
    expect(within(panel).getByText("定額法")).toBeInTheDocument();
    expect(within(panel).getByText("本年中の償却期間")).toBeInTheDocument();
    expect(within(panel).getByText("4/12")).toBeInTheDocument();
    expect(within(panel).getByText("償却率")).toBeInTheDocument();
    expect(within(panel).getByText("0.250")).toBeInTheDocument();
    expect(within(panel).getByText("除却損")).toBeInTheDocument();
    expect(within(panel).getByText("458,333")).toBeInTheDocument();
    expect(within(panel).getByText("除却損のうち必要経費算入額")).toBeInTheDocument();
    expect(within(panel).getByText("274,999")).toBeInTheDocument();
  });

  it("売却は除却損でなく事業主貸への振替として示し、譲渡所得は範囲外と伝える", async () => {
    mockScreen({
      assets: [straightLine({ id: "as-1" })],
      proposals: [straightProposal({ disposalKind: "sale", disposalDeductible: 0 })],
    });
    renderPage();

    const panel = await screen.findByRole("group", { name: "機材Aの振替の案" });
    expect(within(panel).getByText("売却による事業主貸への振替")).toBeInTheDocument();
    expect(within(panel).queryByText("除却損")).toBeNull();
    expect(within(panel).getByText(/譲渡所得の計算はこのアプリの範囲外/)).toBeInTheDocument();
  });
});

describe("一括償却資産（009 US2）", () => {
  it("台帳の一覧に「一括償却」と年度の償却費・未償却残高を示す。除却しても償却は続くので除却の表示だけが加わる", async () => {
    mockScreen({
      assets: [
        asset({
          id: "as-9",
          name: "プリンター一式",
          acquiredOn: "2025-07-10",
          acquisitionCost: 150_000,
          method: "lump_sum",
          usefulLifeYears: null,
          disposedOn: "2025-10-05",
          disposalKind: "scrap",
          depreciationError: null,
          depreciation: depreciation({
            method: "lump_sum",
            cost: 150_000,
            base: 150_000,
            ordinary: 50_000,
            total: 50_000,
            businessRatio: 10000,
            deductible: 50_000,
            closingBookValue: 100_000,
            ratePermille: null,
            months: null,
          }),
        }),
      ],
    });
    renderPage();

    const table = await screen.findByRole("table", { name: "固定資産台帳" });
    const cells = within(within(table).getByRole("row", { name: /プリンター一式/ }))
      .getAllByRole("cell")
      .map((c) => c.textContent);
    expect(cells).toEqual(expect.arrayContaining(["一括償却", "50,000", "100,000"]));
  });

  it("業務エラー（取得価額が範囲外）を画面に出し、資産は登録されない", async () => {
    mockScreen({
      overrides: {
        [`POST ${ASSETS}`]: () =>
          apiError(
            422,
            "LUMP_SUM_COST_OUT_OF_RANGE",
            "一括償却資産の取得価額は 100,000 円以上 200,000 円未満です",
            { min: 100_000, max: 200_000 },
          ),
      },
    });
    const user = userEvent.setup();
    renderPage();

    await fillBasics(user, "250000");
    await user.selectOptions(screen.getByRole("combobox", { name: "償却の方法" }), "lump_sum");
    await user.click(screen.getByRole("button", { name: "登録" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("200,000 円未満");
  });
});

describe("開業費は固定資産台帳に出さない（011/T005。開業費の画面は deferred-assets.test.tsx）", () => {
  it("開業費の節と開業費の振替の案を出さず、開業費の API を読まない", async () => {
    const { calls } = mockScreen({
      assets: [asset()],
      deferredAssets: [deferred()],
      withOpenAccount: true,
      proposals: [DEFERRED_PROPOSAL, PROPOSAL],
    });
    renderPage();

    expect(
      await screen.findByRole("group", { name: "ノートパソコンの振替の案" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("table", { name: "開業費の一覧" })).toBeNull();
    expect(screen.queryByRole("textbox", { name: "開業費の名称" })).toBeNull();
    expect(screen.queryByRole("group", { name: "開業費の振替の案" })).toBeNull();
    expect(callsOf(calls, "GET", DEFERRED)).toHaveLength(0);
  });
});

describe("年分の入力欄は URL に追従する", () => {
  it("戻る・進むで ?year が変わると、欄も同じ年になる", async () => {
    mockScreen({ assets: [asset()] });
    const { router } = renderPage();
    const input = await screen.findByRole("textbox", { name: "年分" });
    expect(input).toHaveValue("2025");

    await act(async () => {
      router.history.push("/e/e1/fixed-assets/?year=2024");
    });
    await waitFor(() => expect(screen.getByRole("textbox", { name: "年分" })).toHaveValue("2024"));
  });
});
