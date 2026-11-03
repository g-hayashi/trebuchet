import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Route } from "@/routes/e/$entityId/receipts/index";
import { type ApiCall, mockApi, ok } from "../mock-api";
import { RECEIPT_ID, receiptSummary } from "../receipts-fixtures";
import { renderRoute } from "../render-route";

// T016: 証憑の一覧と検索（H: §2 の GET /receipts、FR-008。E1: 区分の表示名）

const ID2 = "00000000-0000-4000-8000-0000000000a2";
const ID3 = "00000000-0000-4000-8000-0000000000a3";
const LIST = "/api/entities/e1/receipts";

const renderList = (url = "/e/e1/receipts") =>
  renderRoute(Route, { path: "/e/$entityId/receipts/", url });

const listCalls = (calls: ApiCall[]) => calls.filter((c) => c.path === LIST && c.method === "GET");

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("証憑の一覧", () => {
  it("受け取った順に、取引年月日・金額・取引先・区分の表示名・経路を表示する", async () => {
    mockApi({
      [`GET ${LIST}`]: () =>
        ok({
          receipts: [
            receiptSummary(),
            receiptSummary({
              id: ID2,
              category: "paper_scan",
              channel: "remote",
              transactionDate: "2026-10-18",
              amount: 25_000,
              partnerName: "別の店",
              mediaType: "application/pdf",
            }),
          ],
          nextCursor: null,
        }),
    });
    renderList();

    const table = await screen.findByRole("table", { name: "証憑の一覧" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(2);
    expect(within(rows[0] as HTMLElement).getByText("2026-10-20")).toBeInTheDocument();
    expect(within(rows[0] as HTMLElement).getByText("1,100")).toBeInTheDocument();
    expect(within(rows[0] as HTMLElement).getByText("合成の店")).toBeInTheDocument();
    expect(within(rows[0] as HTMLElement).getByText("電子取引")).toBeInTheDocument();
    expect(within(rows[0] as HTMLElement).getByText("この Mac から")).toBeInTheDocument();
    expect(within(rows[1] as HTMLElement).getByText("紙を撮影（原本は保存）")).toBeInTheDocument();
    expect(within(rows[1] as HTMLElement).getByText("25,000")).toBeInTheDocument();
    expect(within(rows[1] as HTMLElement).getByText("外部から（スマホなど）")).toBeInTheDocument();
  });

  it("未入力の値は「未入力」と示し、入力する画面（詳細）へのリンクを出す", async () => {
    mockApi({
      [`GET ${LIST}`]: () =>
        ok({
          receipts: [
            receiptSummary({
              transactionDate: null,
              amount: null,
              partnerName: null,
              warnings: [{ code: "FIELDS_MISSING" }],
            }),
          ],
          nextCursor: null,
        }),
    });
    renderList();

    const row = (await screen.findAllByRole("row"))[1] as HTMLElement;
    expect(within(row).getAllByText("未入力")).toHaveLength(3);
    expect(within(row).getByText("未入力の項目があります")).toBeInTheDocument();
    expect(within(row).getByRole("link", { name: "入力する" })).toHaveAttribute(
      "href",
      `/e/e1/receipts/${RECEIPT_ID}`,
    );
  });

  it("警告は server の応答のとおり表示する（期限などの日付は計算しない）", async () => {
    mockApi({
      [`GET ${LIST}`]: () =>
        ok({
          receipts: [
            receiptSummary({
              category: "paper_scan",
              warnings: [
                { code: "INPUT_PERIOD_EXCEEDED", details: { deadline: "2026-06-30" } },
                {
                  code: "RESOLUTION_BELOW_GUIDE",
                  details: { width: 800, height: 600, minLong: 1280, minShort: 960 },
                },
                { code: "NOT_FULL_COLOR" },
              ],
            }),
          ],
          nextCursor: null,
        }),
    });
    renderList();

    const row = (await screen.findAllByRole("row"))[1] as HTMLElement;
    expect(within(row).getByText(/入力の期限（2026-06-30）を過ぎています/)).toBeInTheDocument();
    expect(within(row).getByText(/解像度が目安/)).toBeInTheDocument();
    expect(within(row).getByText(/800×600/)).toBeInTheDocument();
    expect(within(row).getByText(/フルカラーではありません/)).toBeInTheDocument();
  });

  it("結びつき・削除済みの状態を示す。結びついた仕訳へのリンクを出す", async () => {
    mockApi({
      [`GET ${LIST}`]: () =>
        ok({
          receipts: [
            receiptSummary({
              linkState: "linked",
              journal: { id: "j1", journalNo: 12, date: "2026-10-20", status: "active" },
            }),
            receiptSummary({
              id: ID2,
              linkState: "journal_voided",
              warnings: [{ code: "JOURNAL_VOIDED" }],
            }),
            receiptSummary({ id: ID3, deleted: true }),
          ],
          nextCursor: null,
        }),
    });
    renderList();

    const rows = (await screen.findAllByRole("row")).slice(1) as HTMLElement[];
    expect(within(rows[0] as HTMLElement).getByText("仕訳に結びつき")).toBeInTheDocument();
    expect(
      within(rows[0] as HTMLElement).getByRole("link", { name: "仕訳 No.12" }),
    ).toHaveAttribute("href", "/e/e1/journals/j1");
    expect(within(rows[1] as HTMLElement).getAllByText("仕訳が取消済み").length).toBeGreaterThan(0);
    expect(within(rows[2] as HTMLElement).getByText("削除済み")).toBeInTheDocument();
  });

  it("証憑がなければ案内を出す。条件があれば「条件に合う証憑がありません」", async () => {
    mockApi({ [`GET ${LIST}`]: () => ok({ receipts: [], nextCursor: null }) });
    const first = renderList();
    expect(await screen.findByText(/証憑がありません/)).toBeInTheDocument();
    first.unmount();

    renderList("/e/e1/receipts?partner=合成");
    expect(await screen.findByText("条件に合う証憑がありません。")).toBeInTheDocument();
  });

  it("次のページがあれば「さらに読み込む」で cursor を送る", async () => {
    const calls = mockApi({
      [`GET ${LIST}`]: ({ query }) =>
        query.cursor === undefined
          ? ok({ receipts: [receiptSummary()], nextCursor: "CUR1" })
          : ok({
              receipts: [receiptSummary({ id: ID2, partnerName: "二ページ目の店" })],
              nextCursor: null,
            }),
    });
    renderList();
    await userEvent.click(await screen.findByRole("button", { name: "さらに読み込む" }));
    expect(await screen.findByText("二ページ目の店")).toBeInTheDocument();
    expect(listCalls(calls).at(-1)?.query.cursor).toBe("CUR1");
    expect(screen.queryByRole("button", { name: "さらに読み込む" })).not.toBeInTheDocument();
  });
});

describe("証憑の検索", () => {
  it("条件を入れて検索すると、API に条件を渡し、URL にも入る", async () => {
    const calls = mockApi({ [`GET ${LIST}`]: () => ok({ receipts: [], nextCursor: null }) });
    const { router } = renderList();
    const form = await screen.findByRole("search", { name: "証憑の検索" });
    const user = userEvent.setup();

    await user.type(within(form).getByLabelText("取引年月日（から）"), "2026-10-01");
    await user.type(within(form).getByLabelText("取引年月日（まで）"), "2026-10-31");
    await user.type(within(form).getByLabelText("金額（以上）"), "1,000");
    await user.type(within(form).getByLabelText("金額（以下）"), "5000");
    await user.type(within(form).getByLabelText("取引先"), "合成");
    await user.selectOptions(within(form).getByLabelText("区分"), "紙を撮影（原本は保存）");
    await user.selectOptions(within(form).getByLabelText("結びつき"), "仕訳なし");
    await user.click(within(form).getByLabelText("未入力があるものだけ"));
    await user.click(within(form).getByLabelText("削除済みも表示"));
    await user.click(within(form).getByRole("button", { name: "検索" }));

    await waitFor(() =>
      expect(listCalls(calls).at(-1)?.query).toEqual({
        dateFrom: "2026-10-01",
        dateTo: "2026-10-31",
        amountMin: "1000",
        amountMax: "5000",
        partner: "合成",
        category: "paper_scan",
        link: "none",
        missing: "true",
        includeDeleted: "true",
      }),
    );
    expect(router.state.location.search).toMatchObject({ partner: "合成", amountMin: 1000 });
  });

  it("URL の条件が入力欄に入り、そのまま API に渡る", async () => {
    const calls = mockApi({ [`GET ${LIST}`]: () => ok({ receipts: [], nextCursor: null }) });
    renderList("/e/e1/receipts?partner=合成&missing=true&amountMin=1000&category=electronic");
    const form = await screen.findByRole("search", { name: "証憑の検索" });

    expect(within(form).getByLabelText("取引先")).toHaveValue("合成");
    expect(within(form).getByLabelText("金額（以上）")).toHaveValue("1000");
    expect(within(form).getByLabelText("区分")).toHaveValue("electronic");
    expect(within(form).getByLabelText("未入力があるものだけ")).toBeChecked();
    await waitFor(() => expect(listCalls(calls)).not.toHaveLength(0));
    expect(listCalls(calls)[0]?.query).toEqual({
      partner: "合成",
      missing: "true",
      amountMin: "1000",
      category: "electronic",
    });
  });

  it("金額が 0 以上の整数でなければ検索せず、欄にエラーを出す", async () => {
    const calls = mockApi({ [`GET ${LIST}`]: () => ok({ receipts: [], nextCursor: null }) });
    renderList();
    const form = await screen.findByRole("search", { name: "証憑の検索" });
    await waitFor(() => expect(listCalls(calls)).toHaveLength(1));

    await userEvent.type(within(form).getByLabelText("金額（以上）"), "あ");
    await userEvent.click(within(form).getByRole("button", { name: "検索" }));
    expect(await within(form).findByText("0 以上の整数で入力してください")).toBeInTheDocument();
    expect(listCalls(calls)).toHaveLength(1);
  });

  it("「条件をクリア」で条件を外す", async () => {
    const calls = mockApi({ [`GET ${LIST}`]: () => ok({ receipts: [], nextCursor: null }) });
    renderList("/e/e1/receipts?partner=合成");
    const form = await screen.findByRole("search", { name: "証憑の検索" });
    await userEvent.click(within(form).getByRole("button", { name: "条件をクリア" }));
    await waitFor(() => expect(listCalls(calls).at(-1)?.query).toEqual({}));
    expect(within(form).getByLabelText("取引先")).toHaveValue("");
  });
});
