import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type BlueReturn, BlueReturnWarningCode } from "@trebuchet/schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Route as YearRoute } from "@/routes/e/$entityId/blue-return/$year/index";
import { apiError, mockApi, ok } from "../mock-api";
import { renderRoute } from "../render-route";

const ENTITY = "/api/entities/e1";
const YEAR_API = `${ENTITY}/blue-return/2025`;
const NOTES = `${YEAR_API}/notes/special_circumstances`;

type Page2 = BlueReturn["page2"];
type Page3 = BlueReturn["page3"];
type Warning = BlueReturn["warnings"][number];

const month = (m: number, sales: number, otherIncome: number) => ({
  month: m,
  sales,
  otherIncome,
  total: sales + otherIncome,
});

const MONTHS = Array.from({ length: 12 }, (_, i) =>
  i === 0 ? month(1, 120_000, 2_000) : i === 2 ? month(3, 50_000, 0) : month(i + 1, 0, 0),
);

const PAGE2: Page2 = {
  monthly: { months: MONTHS, total: { sales: 170_000, otherIncome: 2_000, total: 172_000 } },
  rentDetails: [
    { payee: "山田不動産", property: "事務所", annualRent: 1_200_000, deductibleAmount: 600_000 },
  ],
  deduction: {
    cap: 650_000,
    tier: "standard",
    unmet: ["e-Tax による申告", "優良な電子帳簿の保存"],
    amount: 550_000,
  },
};

const PAGE3: Page3 = {
  salesPartners: {
    rows: [
      { partnerId: "p1", name: "A社", amount: 100_000 },
      { partnerId: "p2", name: "B社", amount: 50_000 },
    ],
    others: 22_000,
    total: 172_000,
    withoutPartner: { count: 2, amount: 20_000 },
  },
  depreciation: [],
  specialCircumstances: null,
};

function blueReturn(
  over: { page2?: Partial<Page2>; page3?: Partial<Page3>; warnings?: Warning[] } = {},
): BlueReturn {
  return {
    fiscalYear: 2025,
    formYear: 2025,
    status: "open",
    page1: { lines: [] },
    page2: { ...PAGE2, ...over.page2 },
    page3: { ...PAGE3, ...over.page3 },
    page4: {
      opening: { assets: { rows: [], total: 0 }, liabilityEquity: { rows: [], total: 0 } },
      closing: { assets: { rows: [], total: 0 }, liabilityEquity: { rows: [], total: 0 } },
      carryForwardCheck: "no_prior_year",
      openingDifferenceNote: null,
    },
    transfer: { businessIncome: null, blueDeduction: null },
    warnings: over.warnings ?? [],
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

const rowOf = (table: HTMLElement, first: string) => {
  const row = within(table)
    .getAllByRole("row")
    .find((r) => within(r).queryAllByRole("cell")[0]?.textContent === first);
  if (!row) throw new Error(`${first} の行がありません`);
  return within(row)
    .getAllByRole("cell")
    .map((c) => c.textContent);
};

describe("警告の説明と対応", () => {
  it.each(BlueReturnWarningCode.options)(
    "%s の説明と対応は開いたときだけ表示する",
    async (code) => {
      mockApi({
        [`GET ${YEAR_API}`]: () =>
          ok({ blueReturn: blueReturn({ warnings: [{ code, message: `${code}の警告` }] }) }),
      });
      renderYear();
      const warning = within(await screen.findByRole("region", { name: "警告" }));
      expect(warning.getByText(`${code}の警告`)).toBeInTheDocument();
      const toggle = warning.getByText("説明と対応を見る");
      const details = toggle.closest("details");
      expect(details).not.toHaveAttribute("open");
      await userEvent.setup().click(toggle);
      expect(details).toHaveAttribute("open");
      expect(warning.getByText(/^意味：.+/)).toBeVisible();
      expect(warning.getByText(/^対応：.+/)).toBeVisible();
      await userEvent.setup().click(toggle);
      expect(details).not.toHaveAttribute("open");
    },
  );

  it("取引先なし・家賃・開業費に判断に必要な説明と対応先を示す", async () => {
    mockApi({
      [`GET ${YEAR_API}`]: () =>
        ok({
          blueReturn: blueReturn({
            warnings: [
              { code: "SALES_WITHOUT_PARTNER", message: "取引先なし" },
              { code: "RENT_DETAILS_MISMATCH", message: "家賃の不一致" },
              { code: "DEFERRED_ASSET_NOT_AMORTIZED", message: "開業費の未決定" },
            ],
          }),
        }),
    });
    renderYear();
    const warning = within(await screen.findByRole("region", { name: "警告" }));
    for (const toggle of warning.getAllByText("説明と対応を見る"))
      await userEvent.setup().click(toggle);
    expect(warning.getByText(/売上の合計には含まれています/)).toBeInTheDocument();
    expect(warning.getByText(/摘要に名前を書くだけでは/)).toBeInTheDocument();
    expect(warning.getByText(/家賃総額と、家事按分後の必要経費算入額/)).toBeInTheDocument();
    expect(warning.getByText(/0円で「償却しない」と決定/)).toBeInTheDocument();
    expect(warning.getByRole("link", { name: "仕訳帳で取引先を確認する" })).toHaveAttribute(
      "href",
      "/e/e1/journals",
    );
    expect(warning.getByRole("link", { name: "地代家賃の内訳を直す" })).toHaveAttribute(
      "href",
      "/e/e1/blue-return/2025/home-use",
    );
    expect(warning.getByRole("link", { name: "開業費の償却額を決める" })).toHaveAttribute(
      "href",
      "/e/e1/deferred-assets?year=2025",
    );
  });
});

describe("決算書の2ページ（US5）", () => {
  it("月別の売上・雑収入・計を1〜12月と合計で表示する", async () => {
    mockApi({ [`GET ${YEAR_API}`]: () => ok({ blueReturn: blueReturn() }) });
    renderYear();

    const table = await screen.findByRole("table", { name: "決算書 2ページ 月別売上" });
    expect(rowOf(table, "1月")).toEqual(["1月", "120,000", "2,000", "122,000"]);
    expect(rowOf(table, "2月")).toEqual(["2月", "0", "0", "0"]);
    expect(rowOf(table, "3月")).toEqual(["3月", "50,000", "0", "50,000"]);
    expect(rowOf(table, "12月")).toEqual(["12月", "0", "0", "0"]);
    expect(rowOf(table, "合計")).toEqual(["合計", "170,000", "2,000", "172,000"]);
  });

  it("地代家賃の内訳を表示する。ないときは「内訳はありません」", async () => {
    mockApi({ [`GET ${YEAR_API}`]: () => ok({ blueReturn: blueReturn() }) });
    const { unmount } = renderYear();

    const table = await screen.findByRole("table", { name: "決算書 2ページ 地代家賃の内訳" });
    expect(rowOf(table, "山田不動産")).toEqual(["山田不動産", "事務所", "1,200,000", "600,000"]);
    unmount();

    mockApi({
      [`GET ${YEAR_API}`]: () => ok({ blueReturn: blueReturn({ page2: { rentDetails: [] } }) }),
    });
    renderYear();
    expect(await screen.findByText("地代家賃の内訳はありません。")).toBeInTheDocument();
  });

  it("青色申告特別控除の計算（上限額、区分、満たさない要件、控除額）を表示する", async () => {
    mockApi({ [`GET ${YEAR_API}`]: () => ok({ blueReturn: blueReturn() }) });
    renderYear();

    const region = await screen.findByRole("region", { name: "青色申告特別控除の計算" });
    expect(within(region).getByText("標準")).toBeInTheDocument();
    expect(within(region).getByText("650,000")).toBeInTheDocument();
    expect(within(region).getByText("550,000")).toBeInTheDocument();
    const unmet = within(region).getByRole("list", { name: "満たさない要件" });
    expect(
      within(unmet)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual(["e-Tax による申告", "優良な電子帳簿の保存"]);
  });

  it("要件の回答がないときは「要件の回答が必要」と示し、金額を出さない", async () => {
    mockApi({
      [`GET ${YEAR_API}`]: () => ok({ blueReturn: blueReturn({ page2: { deduction: null } }) }),
    });
    renderYear();

    const region = await screen.findByRole("region", { name: "青色申告特別控除の計算" });
    expect(region).toHaveTextContent("要件の回答が必要");
    expect(within(region).queryByText("650,000")).not.toBeInTheDocument();
  });
});

describe("決算書の3ページの売上先（US5）", () => {
  it("個別の行、上記以外の売上先の計、合計を表示し、取引先なしの件数と金額を知らせる", async () => {
    mockApi({ [`GET ${YEAR_API}`]: () => ok({ blueReturn: blueReturn() }) });
    renderYear();

    const table = await screen.findByRole("table", { name: "決算書 3ページ 売上先" });
    expect(rowOf(table, "A社")).toEqual(["A社", "100,000"]);
    expect(rowOf(table, "B社")).toEqual(["B社", "50,000"]);
    expect(rowOf(table, "上記以外の売上先の計")).toEqual(["上記以外の売上先の計", "22,000"]);
    expect(rowOf(table, "合計")).toEqual(["合計", "172,000"]);
    expect(screen.getByText("取引先が付いていない売上: 2 件、20,000 円")).toBeInTheDocument();
  });

  it("取引先なしの売上がなければ、その知らせを出さない。借方の売上で負の計は ▲ を付ける", async () => {
    mockApi({
      [`GET ${YEAR_API}`]: () =>
        ok({
          blueReturn: blueReturn({
            page3: {
              salesPartners: {
                rows: [{ partnerId: "p1", name: "A社", amount: 100 }],
                others: -30,
                total: 70,
                withoutPartner: null,
              },
            },
          }),
        }),
    });
    renderYear();

    const table = await screen.findByRole("table", { name: "決算書 3ページ 売上先" });
    expect(rowOf(table, "上記以外の売上先の計")).toEqual(["上記以外の売上先の計", "▲30"]);
    expect(rowOf(table, "合計")).toEqual(["合計", "70"]);
    expect(screen.queryByText(/取引先が付いていない売上/)).not.toBeInTheDocument();
  });

  it("売上先の警告（差額、取引先なし、同名）を警告の一覧に出す", async () => {
    const warnings: Warning[] = [
      {
        code: "SALES_TOTAL_MISMATCH",
        message: "売上先の明細の合計（700 円）が欄1（1000 円）と一致しません（差額 -300 円）",
      },
      { code: "SALES_WITHOUT_PARTNER", message: "取引先が付いていない売上の行が 2 件あります" },
      {
        code: "DUPLICATE_PARTNER_NAME",
        message: "同じ名前（山田商店）の別の取引先が 2 件あります",
      },
    ];
    mockApi({ [`GET ${YEAR_API}`]: () => ok({ blueReturn: blueReturn({ warnings }) }) });
    renderYear();

    const list = await screen.findByRole("region", { name: "警告" });
    for (const w of warnings) expect(within(list).getByText(w.message)).toBeInTheDocument();
  });
});

describe("特殊事情のメモ（FR-027）", () => {
  it("入力して保存すると PUT .../notes/special_circumstances に送り、保存した内容を再取得して表示する", async () => {
    let saved: string | null = null;
    const calls = mockApi({
      [`GET ${YEAR_API}`]: () =>
        ok({ blueReturn: blueReturn({ page3: { specialCircumstances: saved } }) }),
      [`PUT ${NOTES}`]: (call) => {
        saved = (call.body as { body: string }).body;
        return ok({
          note: {
            fiscalYear: 2025,
            kind: "special_circumstances",
            body: saved,
            updatedAt: "2026-02-01T00:00:00.000Z",
          },
        });
      },
    });
    const user = userEvent.setup();
    renderYear();

    await user.type(
      await screen.findByLabelText("本年中における特殊事情"),
      "10月に事務所を移転した",
    );
    await user.click(screen.getByRole("button", { name: "特殊事情を保存" }));

    await waitFor(() =>
      expect(calls.find((c) => c.method === "PUT")?.body).toEqual({
        body: "10月に事務所を移転した",
      }),
    );
    // 出力（印刷）にも含める。画面では入力欄に入っている
    const printed = await screen.findByLabelText("保存した特殊事情");
    expect(printed).toHaveTextContent("10月に事務所を移転した");
    expect(await screen.findByText("保存しました。")).toBeInTheDocument();
  });

  it("保存済みのメモを入力欄に入れて開く。保存に失敗したらエラーを示す", async () => {
    mockApi({
      [`GET ${YEAR_API}`]: () =>
        ok({ blueReturn: blueReturn({ page3: { specialCircumstances: "台風で休業" } }) }),
      [`PUT ${NOTES}`]: () => apiError(400, "VALIDATION", "メモは5000文字以内で入力してください"),
    });
    const user = userEvent.setup();
    renderYear();

    const input = await screen.findByLabelText("本年中における特殊事情");
    expect(input).toHaveValue("台風で休業");
    await user.type(input, "（追記）");
    await user.click(screen.getByRole("button", { name: "特殊事情を保存" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "メモは5000文字以内で入力してください",
    );
  });
});

type DepreciationRow = Page3["depreciation"][number];

const depreciationRow = (over: Partial<DepreciationRow> = {}): DepreciationRow => ({
  assetId: "as-1",
  name: "機材A",
  quantity: null,
  acquiredOn: "2025-07-10",
  cost: 500_000,
  source: "fixed_asset",
  method: "straight_line",
  usefulLifeYears: 4,
  ratePermille: 250,
  months: 6,
  disposedOn: null,
  base: 500_000,
  ordinary: 62_500,
  total: 62_500,
  businessRatio: 10000,
  deductible: 62_500,
  closingBookValue: 437_500,
  note: null,
  ...over,
});

describe("決算書の3ページの減価償却（009 US1）", () => {
  it("定額法の行に、償却率（0.250）と本年中の償却期間（6/12）を出す。少額の特例の行は空欄", async () => {
    mockApi({
      [`GET ${YEAR_API}`]: () =>
        ok({
          blueReturn: blueReturn({
            page3: {
              depreciation: [
                depreciationRow(),
                depreciationRow({
                  assetId: "as-2",
                  name: "備品B",
                  method: "small_asset_28_2",
                  usefulLifeYears: null,
                  ratePermille: null,
                  months: null,
                }),
                depreciationRow({
                  assetId: "as-3",
                  name: "一括の資産",
                  method: "lump_sum",
                  usefulLifeYears: null,
                  ratePermille: null,
                  months: null,
                }),
              ],
            },
          }),
        }),
    });
    renderYear();

    const table = await screen.findByRole("table", { name: "決算書 3ページ 減価償却費の計算" });
    const headers = within(table)
      .getAllByRole("columnheader")
      .map((h) => h.textContent);
    expect(headers).toEqual(expect.arrayContaining(["償却率", "本年中の償却期間"]));
    const rateAt = headers.indexOf("償却率");
    const monthsAt = headers.indexOf("本年中の償却期間");
    const cellsOf = (name: string) =>
      within(within(table).getByRole("row", { name: new RegExp(name) }))
        .getAllByRole("cell")
        .map((c) => c.textContent);
    expect(cellsOf("機材A")[rateAt]).toBe("0.250");
    expect(cellsOf("機材A")[monthsAt]).toBe("6/12");
    expect(cellsOf("機材A")).toContain("定額法");
    expect(cellsOf("備品B")[rateAt]).toBe("");
    expect(cellsOf("備品B")[monthsAt]).toBe("");
    expect(cellsOf("一括の資産")).toContain("一括償却");
  });

  it("除却した資産は、摘要に除却の日を出す", async () => {
    mockApi({
      [`GET ${YEAR_API}`]: () =>
        ok({
          blueReturn: blueReturn({
            page3: {
              depreciation: [depreciationRow({ disposedOn: "2025-10-05", note: "廃棄" })],
            },
          }),
        }),
    });
    renderYear();

    const table = await screen.findByRole("table", { name: "決算書 3ページ 減価償却費の計算" });
    expect(within(table).getByText("廃棄 ／ 除却 2025-10-05")).toBeInTheDocument();
  });

  it("新しい警告（台帳と帳簿の期首の不一致、償却率の欠落）を出し、固定資産台帳へのリンクを付ける", async () => {
    const warnings: Warning[] = [
      {
        code: "ASSET_REGISTER_MISMATCH",
        message:
          "工具器具備品の期首残高（100 円）が、減価償却の台帳の期首の未償却残高（80 円）と一致しません（差 20 円）",
        details: {
          accountId: "a",
          accountName: "工具器具備品",
          bookOpening: 100,
          registerOpening: 80,
          difference: 20,
        },
      },
      {
        code: "DEPRECIATION_PARAMETER_MISSING",
        message: "機材Aの減価償却費を計算できません（償却率がありません）",
        details: {
          source: "fixed_asset",
          sourceId: "as-1",
          key: "STRAIGHT_LINE_RATE",
          date: "2025-07-10",
        },
      },
    ];
    mockApi({ [`GET ${YEAR_API}`]: () => ok({ blueReturn: blueReturn({ warnings }) }) });
    renderYear();

    const list = await screen.findByRole("region", { name: "警告" });
    for (const w of warnings)
      expect(within(list).getByText(new RegExp(w.message.slice(0, 12)))).toBeInTheDocument();
    for (const toggle of within(list).getAllByText("説明と対応を見る"))
      await userEvent.setup().click(toggle);
    const links = within(list).getAllByRole("link", { name: "固定資産台帳を開く" });
    expect(links).toHaveLength(2);
    expect(links[0]).toHaveAttribute("href", "/e/e1/fixed-assets?year=2025");
  });
});
