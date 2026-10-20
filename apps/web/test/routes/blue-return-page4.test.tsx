import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { BlueReturn } from "@trebuchet/schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Route as YearRoute } from "@/routes/e/$entityId/blue-return/$year/index";
import { apiError, mockApi, ok } from "../mock-api";
import { renderRoute } from "../render-route";

const ENTITY = "/api/entities/e1";
const YEAR_API = `${ENTITY}/blue-return/2025`;
const NOTES = `${YEAR_API}/notes/opening_difference`;

type Warning = BlueReturn["warnings"][number];
type Page4 = BlueReturn["page4"];

const PAGE4: Page4 = {
  opening: {
    assets: {
      rows: [
        { label: "現金", amount: 50_000 },
        { label: "売掛金", amount: 300_000 },
        { label: "事業主貸", amount: null },
      ],
      total: 350_000,
    },
    liabilityEquity: {
      rows: [
        { label: "元入金", amount: 350_000 },
        { label: "青色申告特別控除前の所得金額", amount: null },
      ],
      total: 350_000,
    },
  },
  closing: {
    assets: {
      rows: [
        { label: "現金", amount: 80_000 },
        { label: "売掛金", amount: 420_000 },
        { label: "事業主貸", amount: 10_000 },
      ],
      total: 510_000,
    },
    liabilityEquity: {
      rows: [
        { label: "元入金", amount: 350_000 },
        { label: "青色申告特別控除前の所得金額", amount: 160_000 },
      ],
      total: 510_000,
    },
  },
  carryForwardCheck: "no_prior_year",
  openingDifferenceNote: null,
};

const MISMATCH: Warning = {
  code: "OPENING_MISMATCH",
  message:
    "「売掛金」の期首残高（300000 円）が、前の年度の期末から求めた値（250000 円）と違います（差額 50000 円）",
  details: {
    accountId: "a-ar",
    subAccountId: null,
    accountName: "売掛金",
    expected: 250_000,
    actual: 300_000,
    diff: 50_000,
    note: null,
  },
};

/** 決算書の応答。page4 と警告だけを差し替える（ほかの欄は空） */
function blueReturn(page4: Partial<Page4> = {}, warnings: Warning[] = []): BlueReturn {
  return {
    fiscalYear: 2025,
    formYear: 2025,
    status: "open",
    page1: { lines: [] },
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
    page4: { ...PAGE4, ...page4 },
    transfer: { businessIncome: null, blueDeduction: null },
    warnings,
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

const rowOf = (table: HTMLElement, label: string) => {
  const row = within(table)
    .getAllByRole("row")
    .find((r) => within(r).queryAllByRole("cell")[0]?.textContent === label);
  if (!row) throw new Error(`${label} の行がありません`);
  return within(row)
    .getAllByRole("cell")
    .map((c) => c.textContent);
};

describe("決算書の4ページ（US4）", () => {
  it("資産と負債・資本の表に期首・期末の金額と合計を出す。金額が null の行は空欄", async () => {
    mockApi({ [`GET ${YEAR_API}`]: () => ok({ blueReturn: blueReturn() }) });
    renderYear();

    const assets = await screen.findByRole("table", { name: "決算書 4ページ 資産" });
    expect(rowOf(assets, "現金")).toEqual(["現金", "50,000", "80,000"]);
    expect(rowOf(assets, "事業主貸")).toEqual(["事業主貸", "", "10,000"]);
    expect(rowOf(assets, "資産合計")).toEqual(["資産合計", "350,000", "510,000"]);

    const equity = screen.getByRole("table", { name: "決算書 4ページ 負債・資本" });
    expect(rowOf(equity, "青色申告特別控除前の所得金額")).toEqual([
      "青色申告特別控除前の所得金額",
      "",
      "160,000",
    ]);
    expect(rowOf(equity, "負債・資本合計")).toEqual(["負債・資本合計", "350,000", "510,000"]);
  });

  it("繰越の検査の状態を示す。前の年度なしでは食い違いの表も説明の入力も出さない", async () => {
    mockApi({ [`GET ${YEAR_API}`]: () => ok({ blueReturn: blueReturn() }) });
    renderYear();

    const status = await screen.findByLabelText("元入金の繰越の検査");
    expect(status).toHaveTextContent("前の年度なし");
    expect(screen.queryByRole("table", { name: "繰越の食い違い" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("期首と前期末の差の説明")).not.toBeInTheDocument();
  });

  it("一致のときは「一致」と示し、食い違いの表は出さない", async () => {
    mockApi({
      [`GET ${YEAR_API}`]: () => ok({ blueReturn: blueReturn({ carryForwardCheck: "matched" }) }),
    });
    renderYear();

    expect(await screen.findByLabelText("元入金の繰越の検査")).toHaveTextContent("一致");
    expect(screen.queryByRole("table", { name: "繰越の食い違い" })).not.toBeInTheDocument();
  });

  it("食い違いのとき、科目ごとの期待値・実際・差額を示し、警告にも出す", async () => {
    mockApi({
      [`GET ${YEAR_API}`]: () =>
        ok({
          blueReturn: blueReturn({ carryForwardCheck: "mismatched" }, [MISMATCH]),
        }),
    });
    renderYear();

    expect(await screen.findByLabelText("元入金の繰越の検査")).toHaveTextContent("食い違い");
    const table = screen.getByRole("table", { name: "繰越の食い違い" });
    expect(rowOf(table, "売掛金")).toEqual(["売掛金", "250,000", "300,000", "50,000"]);
    // 警告の一覧にも同じ警告が出る
    const warnings = screen.getByRole("region", { name: "警告" });
    expect(within(warnings).getByText(MISMATCH.message)).toBeInTheDocument();
  });

  it("負の差額は ▲ を付けて示す", async () => {
    mockApi({
      [`GET ${YEAR_API}`]: () =>
        ok({
          blueReturn: blueReturn({ carryForwardCheck: "mismatched" }, [
            {
              ...MISMATCH,
              message: "元入金の食い違い",
              details: {
                ...MISMATCH.details,
                accountName: "元入金",
                expected: 400_000,
                actual: 350_000,
                diff: -50_000,
              },
            },
          ]),
        }),
    });
    renderYear();

    const table = await screen.findByRole("table", { name: "繰越の食い違い" });
    expect(rowOf(table, "元入金")).toEqual(["元入金", "400,000", "350,000", "▲50,000"]);
  });

  it("期首を求められないとき（details に金額がない）は、警告の文だけを示す", async () => {
    mockApi({
      [`GET ${YEAR_API}`]: () =>
        ok({
          blueReturn: blueReturn({ carryForwardCheck: "mismatched" }, [
            {
              code: "OPENING_MISMATCH",
              message: "前の年度の期末から期首を求められません: 元入金の科目がありません",
              details: { errorCode: "VALIDATION", note: null },
            },
          ]),
        }),
    });
    renderYear();

    expect(await screen.findByLabelText("元入金の繰越の検査")).toHaveTextContent("食い違い");
    expect(screen.queryByRole("table", { name: "繰越の食い違い" })).not.toBeInTheDocument();
    expect(
      screen.getAllByText("前の年度の期末から期首を求められません: 元入金の科目がありません")
        .length,
    ).toBeGreaterThan(0);
  });

  it("差の説明を入力して保存し、保存した説明を食い違いの横に表示する。差額は変わらない", async () => {
    let note: string | null = null;
    const calls = mockApi({
      [`GET ${YEAR_API}`]: () =>
        ok({
          blueReturn: blueReturn({ carryForwardCheck: "mismatched", openingDifferenceNote: note }, [
            MISMATCH,
          ]),
        }),
      [`PUT ${NOTES}`]: (call) => {
        note = (call.body as { body: string }).body;
        return ok({
          note: {
            fiscalYear: 2025,
            kind: "opening_difference",
            body: note,
            updatedAt: "2026-02-01T00:00:00.000Z",
          },
        });
      },
    });
    const user = userEvent.setup();
    renderYear();

    await user.type(
      await screen.findByLabelText("期首と前期末の差の説明"),
      "前の年度は12月の売上を未収に計上していなかった",
    );
    await user.click(screen.getByRole("button", { name: "説明を保存" }));

    await waitFor(() =>
      expect(calls.find((c) => c.method === "PUT")?.body).toEqual({
        body: "前の年度は12月の売上を未収に計上していなかった",
      }),
    );
    const saved = await screen.findByLabelText("保存した差の説明");
    expect(saved).toHaveTextContent("前の年度は12月の売上を未収に計上していなかった");
    // 差額は計算し直さない（API の値のまま）
    const table = screen.getByRole("table", { name: "繰越の食い違い" });
    expect(rowOf(table, "売掛金")).toEqual(["売掛金", "250,000", "300,000", "50,000"]);
  });

  it("保存済みの説明を入力欄に入れて開く。保存に失敗したらエラーを示す", async () => {
    mockApi({
      [`GET ${YEAR_API}`]: () =>
        ok({
          blueReturn: blueReturn(
            { carryForwardCheck: "mismatched", openingDifferenceNote: "期首の修正のため" },
            [MISMATCH],
          ),
        }),
      [`PUT ${NOTES}`]: () => apiError(400, "VALIDATION", "メモは5000文字以内で入力してください"),
    });
    const user = userEvent.setup();
    renderYear();

    const input = await screen.findByLabelText("期首と前期末の差の説明");
    expect(input).toHaveValue("期首の修正のため");
    await user.type(input, "追記");
    await user.click(screen.getByRole("button", { name: "説明を保存" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "メモは5000文字以内で入力してください",
    );
  });

  it("登録済みの差の説明を、警告の横にも出す", async () => {
    mockApi({
      [`GET ${YEAR_API}`]: () =>
        ok({
          blueReturn: blueReturn(
            { carryForwardCheck: "mismatched", openingDifferenceNote: "期首の修正のため" },
            [{ ...MISMATCH, details: { ...MISMATCH.details, note: "期首の修正のため" } }],
          ),
        }),
    });
    renderYear();

    const warnings = await screen.findByRole("region", { name: "警告" });
    expect(within(warnings).getByText("説明: 期首の修正のため")).toBeInTheDocument();
  });

  it("4ページの OPTIONAL_LINES_OVERFLOW は載らなかった科目名と金額を出す", async () => {
    mockApi({
      [`GET ${YEAR_API}`]: () =>
        ok({
          blueReturn: blueReturn({}, [
            {
              code: "OPTIONAL_LINES_OVERFLOW",
              message: "4ページの資産の空欄の行（3 行）に科目が載りきりません。",
              details: {
                page: 4,
                side: "asset",
                count: 5,
                capacity: 3,
                omitted: [{ accountId: "a-x", name: "仮払金", amount: 12_000 }],
              },
            },
          ]),
        }),
    });
    renderYear();

    const list = await screen.findByRole("list", { name: "欄に載らなかった科目" });
    expect(within(list).getByText("仮払金 12,000 円")).toBeInTheDocument();
  });
});
