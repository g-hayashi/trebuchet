import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AdjustmentProposal } from "@trebuchet/schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Route as FixedAssetsRoute } from "@/routes/e/$entityId/fixed-assets/index";
import { type ApiCall, apiError, mockApi, ok } from "../mock-api";
import { renderRoute } from "../render-route";

const ENTITY = "/api/entities/e1";
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
  breakdown: { acquisitionCost: 200_000, businessRatio: 5000, deductible: 100_000 },
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

type Opts = { assets?: unknown[]; proposals?: AdjustmentProposal[] };

function mockScreen(opts: Opts = {}) {
  const state = { assets: opts.assets ?? [], proposals: opts.proposals ?? [] };
  const calls = mockApi({
    [`GET ${ENTITY}/accounts`]: () =>
      ok({
        accounts: [
          ...ACCOUNTS,
          account("a-dep", "減価償却費", "expense"),
          account("a-owner", "事業主貸", "equity"),
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
    [`GET ${ADJUSTMENTS}`]: () => ok({ proposals: state.proposals }),
    [`POST ${ADJUSTMENTS}`]: () => {
      state.proposals = [];
      return ok(
        {
          journal: { id: "j-new" },
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

  it("資産の勘定は資産の科目（使用中のもの）だけ、償却の方法は少額の特例の1つだけ選べる", async () => {
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
    ).toEqual(["少額減価償却資産の特例（措置法28条の2）"]);
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
    await user.click(within(panel).getByRole("button", { name: "仕訳を登録" }));

    await waitFor(() => expect(callsOf(calls, "POST", ADJUSTMENTS)).toHaveLength(1));
    expect(callsOf(calls, "POST", ADJUSTMENTS)[0]?.body).toEqual({
      kind: "depreciation",
      sourceId: "as-1",
      expected: { amount: 300_000 },
    });
    expect(await screen.findByText("登録する仕訳の案はありません。")).toBeInTheDocument();
  });
});
