import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AdjustmentProposal, BlueReturn } from "@trebuchet/schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatRatioAsPercent, parsePercentToRatio } from "@/features/blue-return/ratio";
import { Route as HomeUseRoute } from "@/routes/e/$entityId/blue-return/$year/home-use";
import { Route as YearRoute } from "@/routes/e/$entityId/blue-return/$year/index";
import { type ApiCall, apiError, mockApi, ok } from "../mock-api";
import { renderRoute } from "../render-route";

const ENTITY = "/api/entities/e1";
const YEAR_API = `${ENTITY}/blue-return/2025`;
const HOME_USE = `${YEAR_API}/home-use`;
const RENT_DETAILS = `${YEAR_API}/rent-details`;
const ADJUSTMENTS = `${YEAR_API}/adjustments`;

const account = (id: string, name: string, category: string, isActive = true) => ({
  id,
  code: id,
  name,
  category,
  normalSide: category === "expense" ? "debit" : "credit",
  reportSection: category === "expense" ? "PL_EXPENSE" : "PL_SALES",
  reportLine: null,
  sortOrder: 1,
  isSystem: false,
  isActive,
});
const ACCOUNTS = [
  account("a-rent", "地代家賃", "expense"),
  account("a-comm", "通信費", "expense"),
  account("a-old", "使わない費用", "expense", false),
  account("a-bank", "普通預金", "asset"),
  account("a-sales", "売上高", "revenue"),
  account("a-owner", "事業主貸", "equity"),
];

const allocationRow = (over: Record<string, unknown> = {}) => ({
  id: "alloc-1",
  fiscalYear: 2025,
  accountId: "a-rent",
  subAccountId: null,
  businessRatio: 3000,
  basis: "床面積",
  changeReason: null,
  createdAt: "2026-01-10T00:00:00.000Z",
  updatedAt: "2026-01-10T00:00:00.000Z",
  ...over,
});

const PROPOSAL: AdjustmentProposal = {
  kind: "home_use",
  sourceId: "alloc-1",
  journal: {
    date: "2025-12-31",
    memo: "家事按分の振替（地代家賃 事業専用割合 30%）",
    lines: [
      { side: "debit", accountId: "a-owner", amount: 840_000, taxCategory: "OUT_OF_SCOPE" },
      { side: "credit", accountId: "a-rent", amount: 840_000, taxCategory: "OUT_OF_SCOPE" },
    ],
  },
  breakdown: { bookAmount: 1_200_000, ratio: 3000, business: 360_000, home: 840_000 },
};

type Opts = {
  allocations?: unknown[];
  previousYear?: unknown[];
  rows?: unknown[];
  proposals?: AdjustmentProposal[];
  assets?: unknown[];
};

/** 画面の API の応答。保存・登録で状態が変わる（読み直しに反映する） */
function mockScreen(opts: Opts = {}) {
  const state = {
    allocations: opts.allocations ?? [],
    previousYear: opts.previousYear ?? [],
    rows: opts.rows ?? [],
    proposals: opts.proposals ?? [],
  };
  const calls = mockApi({
    [`GET ${ENTITY}/accounts`]: () => ok({ accounts: ACCOUNTS }),
    [`GET ${ENTITY}/accounts/a-rent/sub-accounts`]: () => ok({ subAccounts: [] }),
    [`GET ${ENTITY}/accounts/a-comm/sub-accounts`]: () =>
      ok({
        subAccounts: [{ id: "s-elec", accountId: "a-comm", name: "電話", isActive: true }],
      }),
    [`GET ${HOME_USE}`]: () =>
      ok({ allocations: state.allocations, previousYear: state.previousYear }),
    [`PUT ${HOME_USE}`]: (call) => {
      const body = call.body as Record<string, unknown>;
      const saved = allocationRow({ ...body, id: "alloc-new" });
      state.allocations = [saved];
      return ok({ allocation: saved });
    },
    [`GET ${RENT_DETAILS}`]: () => ok({ rows: state.rows }),
    [`PUT ${RENT_DETAILS}`]: (call) => {
      const rows = (call.body as { rows: Record<string, unknown>[] }).rows.map((r, i) => ({
        id: `rd-${i}`,
        fiscalYear: 2025,
        sortOrder: i,
        ...r,
      }));
      state.rows = rows;
      return ok({ rows });
    },
    [`GET ${ENTITY}/fixed-assets`]: () => ok({ assets: opts.assets ?? [] }),
    [`GET ${ADJUSTMENTS}`]: () => ok({ proposals: state.proposals }),
    [`POST ${ADJUSTMENTS}`]: () => {
      state.proposals = [];
      return ok(
        {
          journal: { id: "j-new", journalNo: 7 },
          ref: {
            journalId: "j-new",
            kind: "home_use",
            allocationId: "alloc-1",
            assetId: null,
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

const renderHomeUse = () =>
  renderRoute(HomeUseRoute, {
    path: "/e/$entityId/blue-return/$year/home-use",
    url: "/e/e1/blue-return/2025/home-use",
  });

const callsOf = (calls: ApiCall[], method: string, path: string) =>
  calls.filter((c) => c.method === method && c.path === path);

describe("割合の % ↔ 万分率（入力の整形）", () => {
  it("小数第2位までの文字列を整数の万分率にする。浮動小数点の誤差を避ける", () => {
    expect(parsePercentToRatio("30")).toBe(3000);
    expect(parsePercentToRatio("28.5")).toBe(2850);
    expect(parsePercentToRatio("28.55")).toBe(2855);
    expect(parsePercentToRatio("0.07")).toBe(7); // 0.07 * 100 は浮動小数点で 7.000000000000001
    expect(parsePercentToRatio("1.15")).toBe(115); // 1.15 * 100 = 114.99999999999999
    expect(parsePercentToRatio("100")).toBe(10000);
    expect(parsePercentToRatio("０")).toBe(0);
    expect(parsePercentToRatio(" 12.5 ")).toBe(1250);
    expect(parsePercentToRatio("12.")).toBe(1200);
  });

  it("範囲外・小数第3位以降・数字でないものは undefined", () => {
    for (const bad of ["", "abc", "-1", "100.01", "101", "12.345", "1e2", "1,5", "."]) {
      expect(parsePercentToRatio(bad), bad).toBeUndefined();
    }
  });

  it("万分率を % の文字列にする（末尾の 0 は落とす）", () => {
    expect(formatRatioAsPercent(3000)).toBe("30");
    expect(formatRatioAsPercent(2850)).toBe("28.5");
    expect(formatRatioAsPercent(2805)).toBe("28.05");
    expect(formatRatioAsPercent(7)).toBe("0.07");
    expect(formatRatioAsPercent(0)).toBe("0");
    expect(formatRatioAsPercent(10000)).toBe("100");
  });
});

describe("家事按分・地代家賃の内訳の画面（US2）", () => {
  it("科目の選択肢は費用の科目だけ（使用停止も除く）。決算書へ戻るリンクがある", async () => {
    mockScreen();
    renderHomeUse();

    const select = await screen.findByRole("combobox", { name: "科目" });
    await waitFor(() => expect(within(select).getAllByRole("option").length).toBeGreaterThan(1));
    const names = within(select)
      .getAllByRole("option")
      .map((o) => o.textContent)
      .filter((t) => t !== "選択してください");
    expect(names).toEqual(["地代家賃", "通信費"]);
    expect(screen.getByRole("link", { name: "決算書に戻る" })).toHaveAttribute(
      "href",
      "/e/e1/blue-return/2025",
    );
  });

  it("割合を「%」で入力すると万分率に変換して保存する（28.55 → 2855）。根拠は前後の空白をそのまま送る", async () => {
    const { calls } = mockScreen();
    const user = userEvent.setup();
    renderHomeUse();

    await user.selectOptions(await screen.findByRole("combobox", { name: "科目" }), "a-rent");
    await user.type(screen.getByRole("textbox", { name: "事業専用割合（%）" }), "28.55");
    await user.type(screen.getByRole("textbox", { name: "根拠" }), "床面積 15㎡／50㎡");
    await user.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(callsOf(calls, "PUT", HOME_USE)).toHaveLength(1));
    expect(callsOf(calls, "PUT", HOME_USE)[0]?.body).toEqual({
      accountId: "a-rent",
      subAccountId: null,
      businessRatio: 2855,
      basis: "床面積 15㎡／50㎡",
      changeReason: null,
    });
    // 保存した登録が一覧に出る
    const list = await screen.findByRole("table", { name: "按分の登録" });
    expect(within(list).getByText("地代家賃")).toBeInTheDocument();
    expect(within(list).getByText("28.55%")).toBeInTheDocument();
    expect(await screen.findByText("保存しました。")).toBeInTheDocument();
  });

  it("割合が不正なら保存しない（小数第3位、100 超）", async () => {
    const { calls } = mockScreen();
    const user = userEvent.setup();
    renderHomeUse();

    await user.selectOptions(await screen.findByRole("combobox", { name: "科目" }), "a-rent");
    await user.type(screen.getByRole("textbox", { name: "根拠" }), "根拠");
    const ratio = screen.getByRole("textbox", { name: "事業専用割合（%）" });
    await user.type(ratio, "12.345");
    await user.click(screen.getByRole("button", { name: "保存" }));
    expect(await screen.findByText(/0〜100 の数値を小数第2位まで/)).toBeInTheDocument();
    await user.clear(ratio);
    await user.type(ratio, "100.01");
    await user.click(screen.getByRole("button", { name: "保存" }));
    expect(callsOf(calls, "PUT", HOME_USE)).toHaveLength(0);
  });

  it("割合 0% は保存の前に確認する。戻れば保存しない、確定すれば 0 で保存する", async () => {
    const { calls } = mockScreen();
    const user = userEvent.setup();
    renderHomeUse();

    await user.selectOptions(await screen.findByRole("combobox", { name: "科目" }), "a-comm");
    await user.type(screen.getByRole("textbox", { name: "事業専用割合（%）" }), "0");
    await user.type(screen.getByRole("textbox", { name: "根拠" }), "私用のみ");
    await user.click(screen.getByRole("button", { name: "保存" }));

    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText(/全額が家事分になり、この科目は経費になりません/),
    ).toBeInTheDocument();
    expect(callsOf(calls, "PUT", HOME_USE)).toHaveLength(0);

    await user.click(within(dialog).getByRole("button", { name: "戻る" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(callsOf(calls, "PUT", HOME_USE)).toHaveLength(0);

    await user.click(screen.getByRole("button", { name: "保存" }));
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "保存する" }),
    );
    await waitFor(() => expect(callsOf(calls, "PUT", HOME_USE)).toHaveLength(1));
    expect(callsOf(calls, "PUT", HOME_USE)[0]?.body).toMatchObject({
      accountId: "a-comm",
      businessRatio: 0,
    });
  });

  it("前の年度の割合を示し、変更の理由を送る。補助科目は選べる", async () => {
    const { calls } = mockScreen({
      previousYear: [allocationRow({ id: "alloc-prev", fiscalYear: 2024, businessRatio: 2500 })],
    });
    const user = userEvent.setup();
    renderHomeUse();

    const prev = await screen.findByRole("table", { name: "前の年度の按分" });
    expect(within(prev).getByText("25%")).toBeInTheDocument();

    await user.selectOptions(screen.getByRole("combobox", { name: "科目" }), "a-comm");
    await user.selectOptions(await screen.findByRole("combobox", { name: "補助科目" }), "s-elec");
    await user.type(screen.getByRole("textbox", { name: "事業専用割合（%）" }), "40");
    await user.type(screen.getByRole("textbox", { name: "根拠" }), "通話の割合");
    await user.type(screen.getByRole("textbox", { name: "変更の理由" }), "在宅が増えた");
    await user.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(callsOf(calls, "PUT", HOME_USE)).toHaveLength(1));
    expect(callsOf(calls, "PUT", HOME_USE)[0]?.body).toEqual({
      accountId: "a-comm",
      subAccountId: "s-elec",
      businessRatio: 4000,
      basis: "通話の割合",
      changeReason: "在宅が増えた",
    });
  });

  it("サーバーの業務エラー（変更の理由が必要）を画面に出す", async () => {
    mockApi({
      [`GET ${ENTITY}/accounts`]: () => ok({ accounts: ACCOUNTS }),
      [`GET ${ENTITY}/accounts/a-rent/sub-accounts`]: () => ok({ subAccounts: [] }),
      [`GET ${HOME_USE}`]: () => ok({ allocations: [], previousYear: [] }),
      [`GET ${RENT_DETAILS}`]: () => ok({ rows: [] }),
      [`GET ${ADJUSTMENTS}`]: () => ok({ proposals: [] }),
      [`PUT ${HOME_USE}`]: () =>
        apiError(422, "HOME_USE_CHANGE_REASON_REQUIRED", "前の年度と事業専用割合が違います。"),
    });
    const user = userEvent.setup();
    renderHomeUse();
    await user.selectOptions(await screen.findByRole("combobox", { name: "科目" }), "a-rent");
    await user.type(screen.getByRole("textbox", { name: "事業専用割合（%）" }), "40");
    await user.type(screen.getByRole("textbox", { name: "根拠" }), "根拠");
    await user.click(screen.getByRole("button", { name: "保存" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "前の年度と事業専用割合が違います。",
    );
  });

  it("地代家賃の内訳を行ごとに入力して全件を保存する（金額は整数に変換）", async () => {
    const { calls } = mockScreen();
    const user = userEvent.setup();
    renderHomeUse();

    await user.click(await screen.findByRole("button", { name: "行を追加" }));
    await user.type(screen.getByRole("textbox", { name: "支払先（1行目）" }), "東京都 山田");
    await user.type(screen.getByRole("textbox", { name: "賃借物件（1行目）" }), "事務所");
    await user.type(screen.getByRole("textbox", { name: "賃借料（1行目）" }), "1,200,000");
    await user.type(screen.getByRole("textbox", { name: "必要経費算入額（1行目）" }), "360000");
    await user.click(screen.getByRole("button", { name: "行を追加" }));
    await user.type(screen.getByRole("textbox", { name: "支払先（2行目）" }), "大家B");
    await user.type(screen.getByRole("textbox", { name: "賃借物件（2行目）" }), "駐車場");
    await user.type(screen.getByRole("textbox", { name: "賃借料（2行目）" }), "240000");
    await user.type(screen.getByRole("textbox", { name: "必要経費算入額（2行目）" }), "240000");
    expect(screen.getByRole("button", { name: "保存" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "内訳を保存" }));

    await waitFor(() => expect(callsOf(calls, "PUT", RENT_DETAILS)).toHaveLength(1));
    expect(callsOf(calls, "PUT", RENT_DETAILS)[0]?.body).toEqual({
      rows: [
        {
          payee: "東京都 山田",
          property: "事務所",
          annualRent: 1_200_000,
          deductibleAmount: 360_000,
        },
        { payee: "大家B", property: "駐車場", annualRent: 240_000, deductibleAmount: 240_000 },
      ],
    });
    expect(await screen.findByText("保存しました。")).toBeInTheDocument();
  });

  it("保存済みの内訳を表示し、行を削除して保存できる", async () => {
    const { calls } = mockScreen({
      rows: [
        {
          id: "rd-0",
          fiscalYear: 2025,
          payee: "大家A",
          property: "事務所",
          annualRent: 600_000,
          deductibleAmount: 300_000,
          sortOrder: 0,
        },
      ],
    });
    const user = userEvent.setup();
    renderHomeUse();

    expect(await screen.findByRole("textbox", { name: "支払先（1行目）" })).toHaveValue("大家A");
    expect(screen.getByRole("textbox", { name: "賃借料（1行目）" })).toHaveValue("600,000");
    await user.click(screen.getByRole("button", { name: "1行目を削除" }));
    await user.click(screen.getByRole("button", { name: "内訳を保存" }));
    await waitFor(() => expect(callsOf(calls, "PUT", RENT_DETAILS)).toHaveLength(1));
    expect(callsOf(calls, "PUT", RENT_DETAILS)[0]?.body).toEqual({ rows: [] });
  });

  it("仕訳の案に帳簿の金額・割合・事業分・家事分と仕訳を見せ、「仕訳を登録」で案の金額を確定する", async () => {
    const { calls } = mockScreen({
      allocations: [allocationRow()],
      proposals: [PROPOSAL],
    });
    const user = userEvent.setup();
    renderHomeUse();

    const panel = await screen.findByRole("region", { name: "決算整理の仕訳の案" });
    const card = within(panel).getByRole("group", { name: /地代家賃/ });
    expect(within(card).getByText("1,200,000")).toBeInTheDocument();
    expect(within(card).getByText("30%")).toBeInTheDocument();
    expect(within(card).getByText("360,000")).toBeInTheDocument();
    // 家事分と仕訳の金額（借方・貸方）
    expect(within(card).getAllByText("840,000").length).toBeGreaterThanOrEqual(3);
    expect(within(card).getByText("2025-12-31")).toBeInTheDocument();
    expect(within(card).getByText("事業主貸")).toBeInTheDocument();

    await user.click(within(card).getByRole("button", { name: "仕訳を登録" }));

    await waitFor(() => expect(callsOf(calls, "POST", ADJUSTMENTS)).toHaveLength(1));
    expect(callsOf(calls, "POST", ADJUSTMENTS)[0]?.body).toEqual({
      kind: "home_use",
      sourceId: "alloc-1",
      expected: { amount: 840_000 },
    });
    expect(await within(panel).findByText("登録する仕訳の案はありません。")).toBeInTheDocument();
    expect(screen.getByText("仕訳を登録しました（No.7）。")).toBeInTheDocument();
  });

  it("減価償却の案は資産名、取得価額・事業専用割合・必要経費算入額と仕訳を見せ、kind depreciation で確定する", async () => {
    const depreciationProposal: AdjustmentProposal = {
      kind: "depreciation",
      sourceId: "as-1",
      journal: {
        date: "2025-12-31",
        memo: "減価償却費の計上（ノートパソコン）",
        lines: [
          { side: "debit", accountId: "a-bank", amount: 200_000, taxCategory: "OUT_OF_SCOPE" },
          { side: "credit", accountId: "a-rent", amount: 200_000, taxCategory: "OUT_OF_SCOPE" },
          { side: "debit", accountId: "a-owner", amount: 100_000, taxCategory: "OUT_OF_SCOPE" },
          { side: "credit", accountId: "a-bank", amount: 100_000, taxCategory: "OUT_OF_SCOPE" },
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
    const { calls } = mockScreen({
      proposals: [depreciationProposal],
      assets: [{ id: "as-1", name: "ノートパソコン" }],
    });
    const user = userEvent.setup();
    renderHomeUse();

    const card = await screen.findByRole("group", { name: "ノートパソコンの振替の案" });
    const facts = within(card)
      .getAllByRole("definition")
      .map((d) => d.textContent);
    expect(facts).toEqual(["少額の特例", "200,000", "50%", "100,000"]);
    expect(within(card).getByText("取得価額")).toBeInTheDocument();
    expect(within(card).getByText("必要経費算入額")).toBeInTheDocument();
    await user.click(within(card).getByRole("button", { name: "仕訳を登録" }));
    await waitFor(() => expect(callsOf(calls, "POST", ADJUSTMENTS)).toHaveLength(1));
    expect(callsOf(calls, "POST", ADJUSTMENTS)[0]?.body).toEqual({
      kind: "depreciation",
      sourceId: "as-1",
      expected: { amount: 300_000 },
    });
  });

  it("確定が 409（案の金額が変わった）なら理由を画面に出す", async () => {
    mockApi({
      [`GET ${ENTITY}/accounts`]: () => ok({ accounts: ACCOUNTS }),
      [`GET ${ENTITY}/accounts/a-rent/sub-accounts`]: () => ok({ subAccounts: [] }),
      [`GET ${HOME_USE}`]: () => ok({ allocations: [allocationRow()], previousYear: [] }),
      [`GET ${RENT_DETAILS}`]: () => ok({ rows: [] }),
      [`GET ${ADJUSTMENTS}`]: () => ok({ proposals: [PROPOSAL] }),
      [`POST ${ADJUSTMENTS}`]: () =>
        apiError(409, "ADJUSTMENT_CHANGED", "帳簿が変わったため、仕訳の案の金額が変わりました。", {
          proposal: PROPOSAL,
        }),
    });
    const user = userEvent.setup();
    renderHomeUse();

    await user.click(await screen.findByRole("button", { name: "仕訳を登録" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("帳簿が変わったため");
  });
});

describe("決算書の画面からのリンク", () => {
  const blue = (warnings: BlueReturn["warnings"]): BlueReturn => ({
    fiscalYear: 2025,
    formYear: 2025,
    status: "open",
    page1: { lines: [{ no: 1, label: "売上", amount: 0, kind: "account" }] },
    page2: {
      monthly: { months: [], total: { sales: 0, otherIncome: 0, total: 0 } },
      rentDetails: [],
      deduction: null,
    },
    page3: {
      salesPartners: { rows: [], others: 0, total: 0, withoutPartner: null },
      depreciation: [],
      specialCircumstances: null,
    },
    page4: {
      opening: { assets: { rows: [], total: 0 }, liabilityEquity: { rows: [], total: 0 } },
      closing: { assets: { rows: [], total: 0 }, liabilityEquity: { rows: [], total: 0 } },
      carryForwardCheck: "no_prior_year",
      openingDifferenceNote: null,
    },
    transfer: { businessIncome: 0, blueDeduction: 0 },
    warnings,
  });

  it("決算書から按分の画面へのリンク、古い振替の警告から案へのリンクを出す", async () => {
    mockApi({
      [`GET ${YEAR_API}`]: () =>
        ok({
          blueReturn: blue([
            {
              code: "HOME_USE_ADJUSTMENT_STALE",
              message: "家事按分の振替（地代家賃）が帳簿と合っていません。",
              details: { allocationId: "alloc-1", difference: 840_000 },
            },
            { code: "RENT_DETAILS_MISMATCH", message: "地代家賃の内訳が欄23と一致しません" },
          ]),
        }),
    });
    renderRoute(YearRoute, {
      path: "/e/$entityId/blue-return/$year/",
      url: "/e/e1/blue-return/2025",
    });

    const links = await screen.findAllByRole("link", { name: "家事按分・地代家賃の内訳" });
    expect(links[0]).toHaveAttribute("href", "/e/e1/blue-return/2025/home-use");
    const warnings = screen.getByRole("region", { name: "警告" });
    for (const toggle of within(warnings).getAllByText("説明と対応を見る"))
      await userEvent.setup().click(toggle);
    const stale = within(warnings).getByRole("link", { name: "仕訳の案を見る" });
    expect(stale).toHaveAttribute("href", "/e/e1/blue-return/2025/home-use");
    // 内訳の警告は内訳の入力へ
    expect(within(warnings).getByRole("link", { name: "地代家賃の内訳を直す" })).toHaveAttribute(
      "href",
      "/e/e1/blue-return/2025/home-use",
    );
  });
});
