import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { BlueReturn } from "@trebuchet/schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Route as YearRoute } from "@/routes/e/$entityId/blue-return/$year/index";
import { Route as ListRoute } from "@/routes/e/$entityId/blue-return/index";
import { mockApi, ok } from "../mock-api";
import { renderRoute } from "../render-route";

const ENTITY = "/api/entities/e1";
const YEAR_API = `${ENTITY}/blue-return/2025`;

const NAMES: Record<number, string> = {
  1: "売上（収入）金額（雑収入を含む）",
  8: "租税公課",
  17: "消耗品費",
  23: "地代家賃",
  31: "雑費",
  32: "計",
  33: "差引金額",
  43: "青色申告特別控除前の所得金額",
  44: "青色申告特別控除額",
  45: "所得金額",
};
const AMOUNTS: Record<number, number> = {
  1: 1_000_000,
  17: 100_000,
  32: 100_000,
  33: 900_000,
  43: 900_000,
};

/** API の応答の kind。使わない欄（2〜7、34〜42）は "unused" */
const isUnused = (no: number) => (no >= 2 && no <= 7) || (no >= 34 && no <= 42);

/** 欄1〜45 のすべて。使わない欄は 0 */
function blueReturn(
  over: Partial<BlueReturn> = {},
  transfer: BlueReturn["transfer"] = { businessIncome: 250_000, blueDeduction: 650_000 },
): BlueReturn {
  const lines = Array.from({ length: 45 }, (_, i) => {
    const no = i + 1;
    const amount =
      no === 44 ? transfer.blueDeduction : no === 45 ? transfer.businessIncome : (AMOUNTS[no] ?? 0);
    const kind = isUnused(no) ? ("unused" as const) : ("account" as const);
    return { no, label: NAMES[no] ?? `欄${no}の名称`, amount, kind };
  });
  return {
    fiscalYear: 2025,
    formYear: 2025,
    status: "open",
    page1: { lines },
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
    transfer,
    warnings: [],
    ...over,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const renderYear = () =>
  renderRoute(YearRoute, {
    path: "/e/$entityId/blue-return/$year/",
    url: "/e/e1/blue-return/2025",
  });

const lineRow = (no: number) => {
  const table = screen.getByRole("table", { name: "決算書 1ページ" });
  const row = within(table)
    .getAllByRole("row")
    .find((r) => within(r).queryAllByRole("cell")[0]?.textContent === String(no));
  if (!row) throw new Error(`欄${no}の行がありません`);
  return row;
};

const period = (fiscalYear: number, status: "open" | "closed" = "open") => ({
  id: `p${fiscalYear}`,
  fiscalYear,
  startDate: `${fiscalYear}-01-01`,
  endDate: `${fiscalYear}-12-31`,
  status,
  closedAt: status === "closed" ? `${fiscalYear + 1}-01-10T00:00:00.000Z` : null,
});

describe("決算書の年度の入口（FR-043）", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 5, 15, 12, 0, 0));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const renderList = () =>
    renderRoute(ListRoute, { path: "/e/$entityId/blue-return/", url: "/e/e1/blue-return" });

  it("今日を含む会計期間の年の決算書へ転送する", async () => {
    mockApi({
      [`GET ${ENTITY}/fiscal-periods`]: () =>
        ok({ fiscalPeriods: [period(2025, "closed"), period(2026), period(2027)] }),
    });
    const { router } = renderList();

    await waitFor(() => expect(router.state.location.pathname).toBe("/e/e1/blue-return/2026"));
  });

  it("今日を含む会計期間がなければ最新の年へ転送する", async () => {
    mockApi({
      [`GET ${ENTITY}/fiscal-periods`]: () =>
        ok({ fiscalPeriods: [period(2024, "closed"), period(2025, "closed")] }),
    });
    const { router } = renderList();

    await waitFor(() => expect(router.state.location.pathname).toBe("/e/e1/blue-return/2025"));
  });

  it("会計期間がなければ転送せず、その旨を示す", async () => {
    mockApi({ [`GET ${ENTITY}/fiscal-periods`]: () => ok({ fiscalPeriods: [] }) });
    const { router } = renderList();

    expect(await screen.findByText("会計期間がありません。")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/e/e1/blue-return");
  });
});

describe("決算書の画面（US1）", () => {
  it("第一表に転記する値（欄45・欄44）を 1ページの表より上に、使った様式の年分と締め前を示す", async () => {
    mockApi({ [`GET ${YEAR_API}`]: () => ok({ blueReturn: blueReturn() }) });
    renderYear();

    const region = await screen.findByRole("region", { name: "第一表に転記する値" });
    expect(within(region).getByText("所得金額（欄45）")).toBeInTheDocument();
    expect(within(region).getByText("250,000")).toBeInTheDocument();
    expect(within(region).getByText("青色申告特別控除額（欄44）")).toBeInTheDocument();
    expect(within(region).getByText("650,000")).toBeInTheDocument();

    const table = screen.getByRole("table", { name: "決算書 1ページ" });
    expect(region.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    expect(screen.getByText("2025年分の様式")).toBeInTheDocument();
    expect(screen.getByText("締め前（暫定）")).toBeInTheDocument();
    expect(screen.queryByText("締め済み")).not.toBeInTheDocument();
  });

  it("締め済みの年度は「締め済み」と示す", async () => {
    mockApi({
      [`GET ${YEAR_API}`]: () => ok({ blueReturn: blueReturn({ status: "closed" }) }),
    });
    renderYear();

    expect(await screen.findByText("締め済み")).toBeInTheDocument();
    expect(screen.queryByText("締め前（暫定）")).not.toBeInTheDocument();
  });

  it("1ページの欄を欄番号・欄名・金額で表示する", async () => {
    mockApi({ [`GET ${YEAR_API}`]: () => ok({ blueReturn: blueReturn() }) });
    renderYear();
    await screen.findByRole("table", { name: "決算書 1ページ" });

    const cells = within(lineRow(17)).getAllByRole("cell");
    expect(cells.map((c) => c.textContent)).toEqual(["17", "消耗品費", "100,000"]);
    expect(within(lineRow(33)).getAllByRole("cell")[2]).toHaveTextContent("900,000");
    // 使わない欄は常に空欄（FR-045）
    expect(within(lineRow(2)).getAllByRole("cell")[2]?.textContent).toBe("");
  });

  it("要件の回答がないとき、欄45・44 に「要件の回答が必要」と、回答すると控除額が出る旨と「要件を直す」を出す", async () => {
    mockApi({
      [`GET ${YEAR_API}`]: () =>
        ok({
          blueReturn: blueReturn(
            {
              warnings: [
                {
                  code: "DEDUCTION_ANSWERS_MISSING",
                  message: "要件の回答が未登録です",
                },
              ],
            },
            { businessIncome: null, blueDeduction: null },
          ),
        }),
    });
    renderYear();

    const region = await screen.findByRole("region", { name: "第一表に転記する値" });
    expect(within(region).getAllByText("要件の回答が必要")).toHaveLength(2);
    expect(within(region).getByText("要件に回答すると控除額が出ます")).toBeInTheDocument();
    expect(within(region).getByRole("button", { name: "要件を直す" })).toBeInTheDocument();
    // 画面は別の画面へのリンクを持たない（回答はこの画面の中で直す）
    expect(within(region).queryByRole("link", { name: "要件を回答する" })).not.toBeInTheDocument();
    // 0 と見間違えない
    expect(within(region).queryByText("0")).not.toBeInTheDocument();
    expect(within(lineRow(45)).getAllByRole("cell")[2]).not.toHaveTextContent("0");
  });

  it("回答があるときも「要件を直す」を欄44の近くに常に置く（回答の案内は出さない）", async () => {
    mockApi({ [`GET ${YEAR_API}`]: () => ok({ blueReturn: blueReturn() }) });
    renderYear();

    const region = await screen.findByRole("region", { name: "第一表に転記する値" });
    expect(within(region).getByRole("button", { name: "要件を直す" })).toBeInTheDocument();
    expect(within(region).queryByText("要件に回答すると控除額が出ます")).not.toBeInTheDocument();
  });

  it("使わない欄は常に空欄で表示し（切り替えはない）、CSV のリンクには常に blankUnused=true を付ける", async () => {
    mockApi({ [`GET ${YEAR_API}`]: () => ok({ blueReturn: blueReturn() }) });
    renderYear();
    await screen.findByRole("table", { name: "決算書 1ページ" });

    expect(screen.queryByRole("checkbox", { name: "使わない欄を空欄で表示" })).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.getByRole("link", { name: "CSV をダウンロード" })).toHaveAttribute(
      "href",
      `${YEAR_API}/csv?blankUnused=true`,
    );
    const unusedNos = [2, 3, 4, 5, 6, 7, 34, 35, 36, 37, 38, 39, 40, 41, 42];
    for (const no of unusedNos) {
      expect(within(lineRow(no)).getAllByRole("cell")[2]).toHaveTextContent(/^$/);
    }
    // 使う欄は 0 でも空欄にしない
    expect(within(lineRow(8)).getAllByRole("cell")[2]).toHaveTextContent("0");
    expect(within(lineRow(17)).getAllByRole("cell")[2]).toHaveTextContent("100,000");
  });

  it("画面の上の年度の select で別の年度の決算書へ切り替える（FR-043）", async () => {
    mockApi({
      [`GET ${ENTITY}/fiscal-periods`]: () =>
        ok({ fiscalPeriods: [period(2024, "closed"), period(2025), period(2026)] }),
      [`GET ${YEAR_API}`]: () => ok({ blueReturn: blueReturn() }),
    });
    const user = userEvent.setup();
    const { router } = renderYear();

    const select = await screen.findByRole("combobox", { name: "年度" });
    await waitFor(() =>
      expect(
        within(select)
          .getAllByRole("option")
          .map((o) => o.textContent),
      ).toEqual(["2026年分", "2025年分", "2024年分"]),
    );
    expect(select).toHaveValue("2025");
    await user.selectOptions(select, "2026");

    await waitFor(() => expect(router.state.location.pathname).toBe("/e/e1/blue-return/2026"));
  });

  it("OPTIONAL_LINES_OVERFLOW は載らなかった科目名と金額を出し、科目の画面へのリンクを付ける", async () => {
    mockApi({
      [`GET ${YEAR_API}`]: () =>
        ok({
          blueReturn: blueReturn({
            warnings: [
              {
                code: "OPTIONAL_LINES_OVERFLOW",
                message: "任意科目が 8 個あり、様式の任意欄（6 欄）に載りません",
                details: {
                  count: 8,
                  capacity: 6,
                  omitted: [
                    { accountId: "a7", name: "会議費", amount: 12_000 },
                    { accountId: "a8", name: "新聞図書費", amount: 3_400 },
                  ],
                },
              },
              { code: "PL_MISMATCH", message: "経費計が損益計算書と一致しません" },
            ],
          }),
        }),
    });
    renderYear();

    const list = await screen.findByRole("region", { name: "警告" });
    expect(within(list).getByText(/任意科目が 8 個あり/)).toBeInTheDocument();
    expect(within(list).getByText("経費計が損益計算書と一致しません")).toBeInTheDocument();
    const omitted = within(list).getByRole("list", { name: "欄に載らなかった科目" });
    expect(
      within(omitted)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual(["会議費 12,000 円", "新聞図書費 3,400 円"]);
    expect(
      within(list).getByRole("link", { name: "科目の画面で決算書の欄を変更する" }),
    ).toHaveAttribute("href", "/e/e1/accounts");
  });

  it("「印刷」でブラウザの印刷を開く", async () => {
    mockApi({ [`GET ${YEAR_API}`]: () => ok({ blueReturn: blueReturn() }) });
    const print = vi.spyOn(window, "print").mockImplementation(() => {});
    renderYear();
    await screen.findByRole("table", { name: "決算書 1ページ" });

    fireEvent.click(screen.getByRole("button", { name: "印刷" }));
    expect(print).toHaveBeenCalledOnce();
  });
});

describe("控除の要件の回答のダイアログ（FR-044）", () => {
  const ANSWERS = `${YEAR_API}/deduction-answers`;
  const SAVED = {
    answers: {
      doubleEntry: true,
      statementsAttached: true,
      filedOnTime: true,
      eTax: false,
      electronicBooks: false,
    },
    cap: {
      cap: 550_000,
      tier: "standard",
      unmet: ["e-Tax での送信または優良な電子帳簿の保存"],
    },
  };

  const openDialog = async (user: ReturnType<typeof userEvent.setup>) => {
    const region = await screen.findByRole("region", { name: "第一表に転記する値" });
    await user.click(within(region).getByRole("button", { name: "要件を直す" }));
    return screen.findByRole("dialog", { name: /青色申告特別控除の要件/ });
  };

  it("5つの質問に答えて保存し、決算書を読み直して欄44・45 を更新する。上限額と満たさない要件も出す", async () => {
    let saved = false;
    const calls = mockApi({
      [`GET ${YEAR_API}`]: () =>
        ok({
          blueReturn: saved
            ? blueReturn({}, { businessIncome: 350_000, blueDeduction: 550_000 })
            : blueReturn({}, { businessIncome: null, blueDeduction: null }),
        }),
      [`GET ${ANSWERS}`]: () => ok(saved ? SAVED : { answers: null, cap: null }),
      [`PUT ${ANSWERS}`]: () => {
        saved = true;
        return ok(SAVED);
      },
    });
    const user = userEvent.setup();
    renderYear();
    const dialog = await openDialog(user);

    expect(await within(dialog).findByText("まだ回答がありません。")).toBeInTheDocument();
    const boxes = within(dialog).getAllByRole("checkbox");
    expect(boxes).toHaveLength(5);
    for (const box of boxes) expect(box).not.toBeChecked();

    await user.click(within(dialog).getByRole("checkbox", { name: /正規の簿記の原則/ }));
    await user.click(within(dialog).getByRole("checkbox", { name: /貸借対照表と損益計算書を/ }));
    await user.click(within(dialog).getByRole("checkbox", { name: /期限内に申告/ }));
    await user.click(within(dialog).getByRole("button", { name: "保存" }));

    expect(await within(dialog).findByText("上限額: 550,000 円")).toBeInTheDocument();
    // 保存後に入力欄を作り直しても、成功のメッセージは残る
    expect(await screen.findByText("保存しました。")).toBeInTheDocument();
    expect(calls.find((c) => c.method === "PUT")?.body).toEqual(SAVED.answers);
    expect(
      within(dialog).getByText("e-Tax での送信または優良な電子帳簿の保存"),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(within(dialog).getByRole("checkbox", { name: /期限内に申告/ })).toBeChecked(),
    );

    // 決算書を読み直し、欄44・45 に値が出る（回答がないときの案内は消える）
    expect(calls.filter((c) => c.method === "GET" && c.path === YEAR_API)).toHaveLength(2);
    await user.click(within(dialog).getByRole("button", { name: "閉じる" }));
    const region = screen.getByRole("region", { name: "第一表に転記する値" });
    await waitFor(() => expect(within(region).getByText("550,000")).toBeInTheDocument());
    expect(within(region).getByText("350,000")).toBeInTheDocument();
    expect(within(region).queryByText("要件に回答すると控除額が出ます")).not.toBeInTheDocument();
  });

  it("保存済みの回答を表示する。満たさない要件がなければその一覧は出さない", async () => {
    mockApi({
      [`GET ${YEAR_API}`]: () => ok({ blueReturn: blueReturn() }),
      [`GET ${ANSWERS}`]: () =>
        ok({
          answers: {
            doubleEntry: true,
            statementsAttached: true,
            filedOnTime: true,
            eTax: true,
            electronicBooks: false,
          },
          cap: { cap: 650_000, tier: "max", unmet: [] },
        }),
    });
    const user = userEvent.setup();
    renderYear();
    const dialog = await openDialog(user);

    expect(await within(dialog).findByText("上限額: 650,000 円")).toBeInTheDocument();
    expect(within(dialog).getByRole("checkbox", { name: /e-Tax で/ })).toBeChecked();
    expect(within(dialog).getByRole("checkbox", { name: /優良な電子帳簿/ })).not.toBeChecked();
    expect(within(dialog).queryByText("満たしていない要件")).not.toBeInTheDocument();
  });
});

describe("決算書の3ページ（減価償却費の計算）", () => {
  const row = (over: Record<string, unknown> = {}) => ({
    assetId: "as-1",
    name: "ノートパソコン",
    quantity: "1台",
    acquiredOn: "2025-06-15",
    cost: 200_000,
    source: "fixed_asset" as const,
    method: "small_asset_28_2" as const,
    usefulLifeYears: null,
    ratePermille: null,
    months: null,
    disposedOn: null,
    base: 200_000,
    ordinary: 200_000,
    total: 200_000,
    businessRatio: 5000,
    deductible: 100_000,
    closingBookValue: 0,
    note: "業務用",
    ...over,
  });

  it("資産ごとに名称・数量・取得年月・取得価額・償却の基礎・償却費・割合・必要経費算入額・未償却残高・摘要を表示する", async () => {
    mockApi({
      [`GET ${YEAR_API}`]: () =>
        ok({
          blueReturn: blueReturn({
            page3: {
              salesPartners: { rows: [], others: 0, total: 0, withoutPartner: null },
              depreciation: [row()],
              specialCircumstances: null,
            },
          }),
        }),
    });
    renderYear();

    const table = await screen.findByRole("table", { name: "決算書 3ページ 減価償却費の計算" });
    const dataRow = within(table).getByRole("row", { name: /ノートパソコン/ });
    expect(
      within(dataRow)
        .getAllByRole("cell")
        .map((c) => c.textContent),
    ).toEqual([
      "ノートパソコン",
      "1台",
      "2025-06",
      "200,000",
      "200,000",
      "少額減価償却資産の特例（措置法28条の2）",
      "", // 耐用年数
      "", // 償却率（定額法だけ）
      "", // 本年中の償却期間（定額法だけ）
      "200,000",
      "200,000",
      "50%",
      "100,000",
      "0",
      "業務用",
    ]);
  });

  it("資産がなければ表を出さず、その旨を示す", async () => {
    mockApi({ [`GET ${YEAR_API}`]: () => ok({ blueReturn: blueReturn() }) });
    renderYear();
    await screen.findByRole("table", { name: "決算書 1ページ" });
    expect(screen.queryByRole("table", { name: "決算書 3ページ 減価償却費の計算" })).toBeNull();
    expect(screen.getByText("減価償却資産はありません。")).toBeInTheDocument();
  });

  it("DEPRECIATION_MISMATCH の警告から固定資産台帳へのリンクを出す。台帳へのリンクもある", async () => {
    mockApi({
      [`GET ${YEAR_API}`]: () =>
        ok({
          blueReturn: blueReturn({
            warnings: [
              {
                code: "DEPRECIATION_MISMATCH",
                message: "減価償却費が3ページの合計と一致しません",
              },
            ],
          }),
        }),
    });
    renderYear();

    const list = await screen.findByRole("region", { name: "警告" });
    expect(within(list).getByRole("link", { name: "固定資産台帳を開く" })).toHaveAttribute(
      "href",
      "/e/e1/fixed-assets?year=2025",
    );
    expect(screen.getAllByRole("link", { name: "固定資産台帳" })[0]).toHaveAttribute(
      "href",
      "/e/e1/fixed-assets?year=2025",
    );
  });
});
